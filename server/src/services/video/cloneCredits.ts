// 克隆类动作（训声音 / 训数字人）的钻石预扣与退回。
//
// ★ 为什么必须预扣而不是「成功才扣」：训练是异步长任务，先跑后扣意味着余额不足的人也能把
//   供应商算力跑完 —— 钱没收到，成本已经付出去了。出片链路（credits.ts）早就是预扣，这里保持同一形状。
//
// ★ 内测免费怎么做：把运营后台对应档位的单价配成 0。credits=0 时 chargeCreditsOnce 直接返回、
//   不落流水，但 hold 行照常创建（留审计）。**不要为「免费」加任何代码分支** —— 那会让
//   「线上到底收不收钱」取决于发版而不是运营配置。
import type { Prisma, VideoCloneHold } from '@prisma/client';
import { prisma } from '../../db.js';
import { chargeCreditsOnce, ensureCredits, refundCreditsOnce } from '../credits.js';
import { CLONE_ACTION_LABELS, type CloneAction, type ClonePricing } from './pricing.js';

type Tx = Prisma.TransactionClient;

export type CloneTargetKind = 'avatar' | 'voice';

/** 一次提交里的一个计费档。一次上传可能同时产生两档（见 cloneChargeItems）。 */
export type CloneChargeItem = { action: CloneAction; targetKind: CloneTargetKind; credits: number };

export class CloneCreditConflictError extends Error {
  statusCode = 409;
  code = 'CLIP_CLONE_REQUEST_CONFLICT';
}

/**
 * 本次上传要扣哪几档 —— **服务端自己判定，不采信端上报的动作**。
 *
 * 端上传的是「用户做了什么选择」（kind / voiceId / voiceSource），能不能据此收钱由服务端决定；
 * 否则改一个表单字段就能把 200 的档位说成 60。
 *
 * 四种组合，与 model.js `cloneCostRows` 展示的明细一一对应（端上显示什么，这里就收什么）：
 * - kind=voice + voiceId  → 重训那一条已有声音（供应商 4 次免费，但我方仍有运营成本，收 voiceRetrain）
 * - kind=voice 无 voiceId → 新建一条专属声音（voiceCreate）
 * - kind=avatar           → 训数字人（avatarVideo）；若用户选的是「视频原声」而不是复用已有声音，
 *                           上游会再新训一条声音，那是**另一档实打实的开销**，一并计入 voiceCreate。
 * - kind=avatarImage      → 用照片训数字人（avatarImage）。**只收这一档**：照片里没有声音，
 *                           它必须关联一条已经训好的声音，那条声音训练时已经单独收过费了。
 */
export function cloneChargeItems(
  input: { kind: string; voiceId?: string; voiceSource?: string },
  pricing: ClonePricing,
): CloneChargeItem[] {
  const voiceId = String(input.voiceId ?? '').trim();
  if (input.kind === 'voice') {
    const action: CloneAction = voiceId ? 'voiceRetrain' : 'voiceCreate';
    return [{ action, targetKind: 'voice', credits: pricing[action] }];
  }
  if (input.kind === 'avatarImage') {
    // 照片没有声音，必须关联一条已训好的（在别处已付费）。这里绝不再收一次声音的钱。
    return [{ action: 'avatarImage', targetKind: 'avatar', credits: pricing.avatarImage }];
  }
  const items: CloneChargeItem[] = [{ action: 'avatarVideo', targetKind: 'avatar', credits: pricing.avatarVideo }];
  // 复用已有声音不额外扣费；只有「视频原声」= 新训一条时才加这一档。
  const reusesVoice = !!voiceId && input.voiceSource !== 'video';
  if (!reusesVoice) items.push({ action: 'voiceCreate', targetKind: 'voice', credits: pricing.voiceCreate });
  return items;
}

export const cloneChargeTotal = (items: CloneChargeItem[]) => items.reduce((sum, item) => sum + item.credits, 0);

/** 一次提交里每一档各自的幂等键。重试同一次上传不会重复扣，两档之间又互不干扰。 */
const itemRequestId = (clientRequestId: string, action: CloneAction) => `${clientRequestId}:${action}`;

/**
 * 预扣。**整批同一个事务** —— 否则「形象扣掉了、声音扣失败」会留下一半的账。
 *
 * 余额不足由 chargeCreditsOnce 抛 402（InsufficientCreditsError），发生在调上游之前，
 * 所以不会出现「钱不够但活已经干完了」。
 */
export async function reserveCloneCredits(input: {
  tenantId: string; userId: string; clientRequestId: string; items: CloneChargeItem[];
}): Promise<{ holds: VideoCloneHold[]; reused: boolean }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`video-clone:${input.userId}:${input.clientRequestId}`}))`;
    const holds: VideoCloneHold[] = [];
    let reused = false;
    for (const item of input.items) {
      const clientRequestId = itemRequestId(input.clientRequestId, item.action);
      const credits = Math.max(0, Math.round(item.credits));
      const existing = await tx.videoCloneHold.findUnique({
        where: { userId_clientRequestId: { userId: input.userId, clientRequestId } },
      });
      if (existing) {
        if (existing.credits !== credits) throw new CloneCreditConflictError('同一请求标识对应的报价已变化');
        reused = true;
        holds.push(existing);
        continue;
      }
      await chargeCreditsOnce(
        input.tenantId, input.userId, credits,
        `快出片 · ${CLONE_ACTION_LABELS[item.action]}预扣`,
        `video-clone:charge:${input.userId}:${clientRequestId}`,
        tx,
      );
      holds.push(await tx.videoCloneHold.create({
        data: {
          tenantId: input.tenantId, userId: input.userId, action: item.action,
          clientRequestId, credits, targetKind: item.targetKind, status: 'submitting',
        },
      }));
    }
    return { holds, reused };
  });
}

/** 提交前的快速余额闸：把「审了半天大文件才告诉你钱不够」提前到上传刚落地时。真正的扣费仍以预扣为准。 */
export async function assertCloneAffordable(userId: string, total: number): Promise<void> {
  await ensureCredits(userId, total);
}

/**
 * 上游建单成功后回填锚点。
 *
 * 拿不到对应 id 的那一档**立即退回** —— 典型场景：用户选了「视频原声」，但上游从视频里没能
 * 提取出可用音色（那是 best-effort 增强，失败不影响形象主任务）。声音没产出就不能收声音的钱。
 */
export async function attachCloneTargets(
  holds: VideoCloneHold[],
  targets: { avatarId?: string | null; voiceId?: string | null },
): Promise<VideoCloneHold[]> {
  const out: VideoCloneHold[] = [];
  for (const hold of holds) {
    if (hold.status !== 'submitting') { out.push(hold); continue; }
    const targetId = String((hold.targetKind === 'avatar' ? targets.avatarId : targets.voiceId) ?? '').trim();
    if (!targetId) {
      const refunded = await refundCloneHold(hold.id, 'not_created');
      if (refunded) out.push(refunded);
      continue;
    }
    out.push(await prisma.videoCloneHold.update({
      where: { id: hold.id },
      data: { targetId, status: 'submitted', lastTrainStatus: 'training' },
    }));
  }
  return out;
}

export async function refundCloneHold(holdId: string, lastTrainStatus = 'failed'): Promise<VideoCloneHold | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`video-clone-hold:${holdId}`}))`;
    const hold = await tx.videoCloneHold.findUnique({ where: { id: holdId } });
    if (!hold) return null;
    // 已结算的不许再退：训练成功过就是成功过，后续再训是另一次动作、另一笔 hold。
    if (hold.status === 'refunded' || hold.status === 'settled') return hold;
    await refundCreditsOnce(
      hold.tenantId, hold.userId, hold.credits,
      `快出片 · ${CLONE_ACTION_LABELS[hold.action as CloneAction] ?? '克隆'}失败退回`,
      `video-clone:refund:${hold.id}`,
      tx,
    );
    return tx.videoCloneHold.update({
      where: { id: hold.id },
      data: { status: 'refunded', refundedAt: new Date(), lastTrainStatus },
    });
  });
}

export async function settleCloneHold(holdId: string, lastTrainStatus = 'ready'): Promise<VideoCloneHold | null> {
  const hold = await prisma.videoCloneHold.findUnique({ where: { id: holdId } });
  if (!hold || hold.status === 'refunded' || hold.status === 'settled') return hold;
  return prisma.videoCloneHold.update({ where: { id: holdId }, data: { status: 'settled', lastTrainStatus } });
}

/** 训练状态 → 该笔 hold 的归宿。training / 未知一律「继续等」，不猜。 */
export type CloneSettlement = { holdId: string; outcome: 'settled' | 'refunded' | 'superseded' };

/**
 * 按上游最新状态决定每笔在途 hold 的归宿。**纯函数**，便于把下面这条并发规则钉在单测里。
 *
 * ★ 同一个 targetId 上可能压着多笔在途 hold（重训复用同一条 voiceId）。这时只有**最新那笔**
 *   认领上游状态；更早的判为 superseded 并**结算**而不是退回 —— 一次被后续重训覆盖掉的旧训练
 *   并不能证明它当初失败了，凭「现在这条是 failed」去退旧账等于凭空送钱。
 */
export function resolveCloneSettlements(
  holds: Array<Pick<VideoCloneHold, 'id' | 'targetKind' | 'targetId' | 'createdAt'>>,
  statusOf: (targetKind: CloneTargetKind, targetId: string) => string | null,
): CloneSettlement[] {
  const newestByTarget = new Map<string, string>();
  for (const hold of holds) {
    if (!hold.targetId) continue;
    const key = `${hold.targetKind}:${hold.targetId}`;
    const current = holds.find((item) => item.id === newestByTarget.get(key));
    if (!current || hold.createdAt >= current.createdAt) newestByTarget.set(key, hold.id);
  }
  const out: CloneSettlement[] = [];
  for (const hold of holds) {
    if (!hold.targetId) continue;
    const key = `${hold.targetKind}:${hold.targetId}`;
    if (newestByTarget.get(key) !== hold.id) { out.push({ holdId: hold.id, outcome: 'superseded' }); continue; }
    const status = statusOf(hold.targetKind as CloneTargetKind, hold.targetId);
    if (status === 'ready') out.push({ holdId: hold.id, outcome: 'settled' });
    else if (status === 'failed') out.push({ holdId: hold.id, outcome: 'refunded' });
    // training / none / null：还没结果，留到下一轮。
  }
  return out;
}

export async function applyCloneSettlements(settlements: CloneSettlement[]): Promise<void> {
  for (const item of settlements) {
    if (item.outcome === 'refunded') await refundCloneHold(item.holdId, 'failed').catch(() => {});
    else await settleCloneHold(item.holdId, item.outcome === 'superseded' ? 'superseded' : 'ready').catch(() => {});
  }
}

/** 某个用户在途的克隆 hold。用于状态接口顺手结算（同 GET /video/jobs/:id 顺手 settle 出片）。 */
export async function pendingCloneHolds(userId: string): Promise<VideoCloneHold[]> {
  return prisma.videoCloneHold.findMany({
    where: { userId, status: 'submitted', targetId: { not: null } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
}

/** 直传受理号恢复时按同一个基础 clientRequestId 找回整批档位 hold。 */
export async function cloneHoldsForRequest(userId: string, clientRequestId: string): Promise<VideoCloneHold[]> {
  return prisma.videoCloneHold.findMany({
    where: { userId, clientRequestId: { startsWith: `${clientRequestId}:` } },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });
}

/** 扣费后、上游建单前进程崩溃 → 自动退回。只碰还没拿到 targetId 的行，不动正常在训的长任务。 */
export async function refundStaleUnsubmittedCloneHolds(maxAgeMs = 10 * 60_000): Promise<number> {
  const rows = await prisma.videoCloneHold.findMany({
    where: { status: 'submitting', targetId: null, updatedAt: { lt: new Date(Date.now() - maxAgeMs) } },
    select: { id: true },
    take: 100,
  });
  let refunded = 0;
  for (const row of rows) {
    const result = await refundCloneHold(row.id, 'submit_timeout').catch(() => null);
    if (result?.status === 'refunded') refunded += 1;
  }
  return refunded;
}

/**
 * 问上游「这个目标现在到底什么状态」。返回 null 表示**问不出来**（超时 / 报错 / 没这条），
 * 与「上游明确说还在训」是两件事，调用方必须分开处理。
 */
export type CloneStatusProbe = (
  hold: Pick<VideoCloneHold, 'tenantId' | 'userId' | 'targetKind' | 'targetId'>,
) => Promise<string | null>;

/**
 * 训练卡死兜底。
 *
 * 上游任务可能永远不给终态（供应商侧丢单）。没有这道闸，用户的钻石会被一笔永不结算的 hold
 * 无限期占住 —— 对用户而言这和「扣了钱没给东西」没区别。
 *
 * ★ 2026-08-15：这里原本是「超过 6 小时一律退回」。那条规则在**独立声音**上翻了车 —— 上游
 *   早已 ready，只是状态没刷回来（AIStar 侧独立声音不走刷新路径），兜底照退，造成
 *   「货已经出了、钱却退了」这种最难对账的不一致。宁可错退不可长占的前提，是我们**真的
 *   不知道**结果；能问出来就不该猜。
 *
 * 所以 maxAgeMs 的语义从「到点就退」改成「到点开始逐轮核实」，退与不退按上游口径走：
 * - ready   → 结算，不退（货确实出了）
 * - failed  → 退回（确实没出货）
 * - training / 问不出来 → **这一轮不动**，留给 5 分钟后的下一次 sweep 再问
 * - 一直问不出结果 → 熬到 hardMaxAgeMs 硬止损退回，钻石不会被无限期占住
 *
 * 不传 probe 时退回旧的「到点就退」行为，保证这个函数裸调也是安全的。
 */
export async function refundStalledCloneHolds(
  maxAgeMs = 6 * 3600_000,
  probe?: CloneStatusProbe,
  hardMaxAgeMs = 24 * 3600_000,
): Promise<{ settled: number; refunded: number }> {
  const now = Date.now();
  const rows = await prisma.videoCloneHold.findMany({
    where: { status: 'submitted', updatedAt: { lt: new Date(now - maxAgeMs) } },
    select: { id: true, tenantId: true, userId: true, targetKind: true, targetId: true, updatedAt: true },
    take: 100,
  });
  let settled = 0;
  let refunded = 0;
  for (const row of rows) {
    const expired = row.updatedAt.getTime() < now - Math.max(maxAgeMs, hardMaxAgeMs);
    const status = probe ? await probe(row).catch(() => null) : null;
    if (status === 'ready') {
      const result = await settleCloneHold(row.id, 'ready').catch(() => null);
      if (result?.status === 'settled') settled += 1;
      continue;
    }
    // probe 缺席时 status 恒为 null，走的就是旧的到点即退；有 probe 时只有明确 failed 或熬到硬止损才退。
    if (status === 'failed' || !probe || expired) {
      const result = await refundCloneHold(row.id, status === 'failed' ? 'failed' : 'train_timeout').catch(() => null);
      if (result?.status === 'refunded') refunded += 1;
    }
  }
  return { settled, refunded };
}
