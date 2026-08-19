// D-1 开通来源归因：解锁 agent / 购买 SKU 成功时落一条 ActivationEvent（source 由前端请求体带入）。
// 与 UserAgent.source（gift|purchase|admin_grant，语义=如何获得）正交——此表记「从哪个位子来的」，供多来源漏斗报表。
import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';

// 归因来源枚举：prescription=处方位（军令语境开方）| catalog=货架/商城 | market=生态市场
// | invite=邀请带来的开通（服务 D-1 漏斗里「邀请贡献了多少开通」这一问，与发奖无关）。缺省 catalog。
//
// ★ 前三个与 invite **不是同一个维度**，别把它们当成一组互斥枚举去相加（详见 recordInviteActivation
// 的注释）：前三个回答「从哪个位子成交的」，来自下单请求；invite 回答「这个人是被谁带来的」，
// 由服务端按 Referral 判定。因此 `parseAttribution` 刻意**不接受**前端传 'invite'（见下），
// 而 invite 行由服务端在付费入账后另外补一条。
export const ACTIVATION_SOURCES = ['prescription', 'catalog', 'market', 'invite'] as const;
export type ActivationSource = (typeof ACTIVATION_SOURCES)[number];

/**
 * 前端**可以**声明的位子来源。`invite` 不在其中：它是服务端按 Referral 账本判定的事实，
 * 端上说了不算——否则任何客户端只要在下单请求里写 `source:'invite'`，
 * 就能凭空给邀请漏斗刷出开通数（而且会被下面的「一人一条」去重逻辑当成真的，把真实那条挤掉）。
 */
const CLIENT_ACTIVATION_SOURCES: readonly string[] = ['prescription', 'catalog', 'market'];

/** 解析 source + refId（refId 仅在 source=prescription 时有意义，其余丢弃）。表外与 'invite' 一律回落 catalog。 */
export function parseAttribution(rawSource: unknown, rawRefId: unknown): { source: ActivationSource; refId: string | null } {
  const source = typeof rawSource === 'string' && CLIENT_ACTIVATION_SOURCES.includes(rawSource)
    ? (rawSource as ActivationSource)
    : 'catalog';
  const refId = source === 'prescription' && typeof rawRefId === 'string' && rawRefId.trim()
    ? rawRefId.trim().slice(0, 64)
    : null;
  return { source, refId };
}

/** D-1 漏斗开通侧：ActivationEvent 按 source 分组计数（窗口 = createdAt 近 N 天）。 */
export async function activationSourceCounts(days: number): Promise<{ source: string; count: number }[]> {
  const cutoff = new Date(Date.now() - Math.max(1, days) * 86400_000);
  const grouped = await prisma.activationEvent.groupBy({
    by: ['source'],
    where: { createdAt: { gte: cutoff } },
    _count: { _all: true },
  });
  return grouped
    .map((g) => ({ source: g.source, count: g._count._all }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 落一条开通事件。可传事务客户端与购买同事务。
 *
 * ⚠️ **它不是 fire-safe 的**（旧注释这么写，与实现不符，2026-08-18 订正）：写失败会**抛出**，
 * 靠每个调用方自己 `.catch(() => {})`。更要紧的是——**在事务内 catch 并不安全**：
 * Postgres 里任一语句失败会把整个事务置为 aborted，`.catch` 只吞掉 JS 异常，
 * 事务本身已经废了，后续语句连带失败，最终**整笔购买回滚**。
 * `services/wechatPay.ts` 那两处正是「传 tx + catch」的形状，风险已记入 AGENTS §13。
 * 新写的调用请参考 `recordInviteActivation`：**跑在事务提交之后**、自带小事务、内部吞掉全部异常。
 */
export async function recordActivation(
  args: { tenantId: string; userId: string; itemType: 'agent' | 'sku' | 'plan'; itemKey: string; source: ActivationSource; refId?: string | null },
  db?: Prisma.TransactionClient,
): Promise<void> {
  const client = db ?? prisma;
  await client.activationEvent.create({
    data: {
      tenantId: args.tenantId, userId: args.userId,
      itemType: args.itemType, itemKey: args.itemKey,
      source: args.source, refId: args.refId ?? null,
    },
  });
}

/** 一次付费入账里，用于补 invite 归因所需的最小信息（由 markPaidAndApply 在事务内攒出，事务外使用）。 */
export interface InviteActivationTarget {
  tenantId: string; userId: string; itemType: 'sku' | 'plan'; itemKey: string;
}

/** 与权益发放同事务写入；因此支付一旦提交成功，补记意图就不会因进程退出而丢失。 */
export async function enqueueInviteActivation(
  db: Prisma.TransactionClient,
  outTradeNo: string,
  target: InviteActivationTarget,
): Promise<void> {
  await db.inviteActivationOutbox.upsert({
    where: { outTradeNo },
    create: { outTradeNo, ...target },
    // 重复通知可补建历史订单的 outbox；已完成行保留 completedAt，不会重新制造事件。
    update: { ...target },
  });
}

export type InviteActivationResult = 'recorded' | 'no_referrer' | 'already_recorded' | 'failed';

/**
 * 邀请漏斗第四段：**付费开通成功**且该用户有推荐人时，补记一条 `source='invite'` 的 ActivationEvent。
 * 这是 `ActivationEvent.source='invite'` 的唯一写入方（该取值 2026-08-18 就加进枚举了，但一直没人写）。
 *
 * ## 为什么是「补一条」而不是把既有 source 改成 invite
 *
 * `ActivationEvent.source` 的 prescription / catalog / market 回答的是**「从哪个位子成交的」**，
 * 值在下单时随 `PaymentOrder.attrSource` 存下来；而「这个人是被谁带来的」是**另一个维度**——
 * 被邀请来的人照样可能从处方位下单。两者正交，所以：
 *   · **不能覆盖**：覆盖等于把「处方位成交」这条事实抹掉，运营后台「开通来源」那格（admin FunnelView
 *     读 activationSourceCounts，按 source 分组计数）里处方位的数字会凭空变少，处方效果就再也说不清；
 *   · 于是选择**再落一行** invite。代价必须明说：`activationSourceCounts` 的各桶从此**不互斥、不能相加**
 *     （invite 桶与另外三桶重叠），读数侧 `admin/src/views/revenue.tsx` 已就地写了这条口径。
 *
 * 推荐人 id 刻意**不冗余进 refId**：`Referral` 是不可变更的账本（userId 主键 = 单推荐人），
 * 按 userId join 一步就得，冗余一份只会漂移。refId 保持它原本唯一的语义（prescriptionId）。
 *
 * ## 为什么只记「首次」，幂等从哪来
 *
 * 漏斗那一段问的是「被邀请来的人里有多少**转化成了付费用户**」——是**人**的口径，不是订单口径：
 * 同一个人续费、加购、再买一个 SKU 都不该再进一次分子。所以按 userId 去重，已有 invite 行就直接返回。
 * 这一条同时兜住三种重复：① 同一订单重复回调或 outbox 重试（`markPaidAndApply` 的
 * already_applied 分支也会幂等补建历史 outbox），这道去重就是它的安全网；
 * ② 同一用户先后两笔订单；③ 同一用户两笔订单**并发**到账——ActivationEvent 上没有唯一约束，
 * check-then-insert 必须自己串行化，故进来先取 `activation:invite:{userId}` 事务级 advisory lock
 * （与 credits.ts / tokenQuota.ts 的按用户加锁同一套路，命名空间独立，不与支付侧的锁互相牵连）。
 *
 * ## 为什么跑在支付事务之外、不被 await，而且从不抛错
 *
 * 这段查询绝不能给支付回调增加失败面。Postgres 里事务内任一语句失败即整体 aborted，
 * 塞进 `markPaidAndApply` 的事务里，「查 Referral 时抖一下」就会连带回滚已经算成功的入账，
 * 而且 `.catch(() => {})` 也救不回来——后续语句同样会失败（这个坑 referral.ts 的 P2002 分支踩过一次）。
 * 所以它在入账事务**提交之后**才跑，自带一个只包「判推荐人 + 落一行」的小事务，
 * 任何异常在函数内部就地吞掉并记 warn，返回 'failed'，由持久化 outbox 退避重试。
 * 查不到 Referral 就当没有推荐人（'no_referrer'），不重试、不报警。
 *
 * 「事务外」还不够，调用方**也不许 await 它**（2026-08-18 订正）：这个小事务不是「两条查询」——
 * BEGIN + advisory lock + 查 Referral 就已经 2 条 SQL（无推荐人到此结束），有推荐人再加查重（3 条）、
 * 首次写入再加 insert（4 条），外加 COMMIT。真钱早已入账，可连接池拥塞或 advisory lock 排队时
 * 这几条照样能把支付回调的响应拖过微信的超时，换来一次重复回调。故 `markPaidAndApply` 只在主事务
 * 内落 outbox，提交后派发出去就走；scheduler 扫描未完成行，本函数幂等，重复调用只会返回
 * 'already_recorded'。
 */
export async function recordInviteActivation(target: InviteActivationTarget): Promise<InviteActivationResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`activation:invite:${target.userId}`}))`;
      const referral = await tx.referral.findUnique({ where: { userId: target.userId }, select: { referrerId: true } });
      if (!referral) return 'no_referrer';
      const existing = await tx.activationEvent.findFirst({
        where: { userId: target.userId, source: 'invite' },
        select: { id: true },
      });
      if (existing) return 'already_recorded';
      await recordActivation({ ...target, source: 'invite' }, tx);
      return 'recorded';
    });
  } catch (err) {
    // 入账已经成功了，这里只是漏一条统计：记下来供排查，绝不往上抛。
    console.warn(`[activation] invite 归因补记失败 userId=${target.userId} item=${target.itemType}:${target.itemKey}: ${(err as Error).message}`);
    return 'failed';
  }
}

/**
 * 抢占并处理一条持久化补记。抢占租约 60 秒：并发 scheduler/回调只有一方执行；进程中途退出后会自动重试。
 */
export async function processInviteActivationOutbox(outTradeNo: string): Promise<InviteActivationResult | 'not_due'> {
  const at = new Date();
  const claimed = await prisma.inviteActivationOutbox.updateMany({
    where: { outTradeNo, completedAt: null, nextAttemptAt: { lte: at } },
    data: { attempts: { increment: 1 }, nextAttemptAt: new Date(at.getTime() + 60_000) },
  });
  if (claimed.count !== 1) return 'not_due';
  const row = await prisma.inviteActivationOutbox.findUnique({ where: { outTradeNo } });
  if (!row || row.completedAt) return 'not_due';
  const target: InviteActivationTarget = {
    tenantId: row.tenantId,
    userId: row.userId,
    itemType: row.itemType === 'sku' ? 'sku' : 'plan',
    itemKey: row.itemKey,
  };
  const result = await recordInviteActivation(target);
  if (result !== 'failed') {
    // 账号注销/测试清理可能与事务外 worker 同时发生。行已被清掉时视为无需再写，
    // 不要让一个已完成的 best-effort 统计任务制造未处理异常。
    await prisma.inviteActivationOutbox.updateMany({
      where: { outTradeNo, completedAt: null },
      data: { completedAt: new Date(), lastError: null },
    });
  } else {
    const delay = Math.min(6 * 3600_000, 30_000 * 2 ** Math.min(row.attempts, 8));
    await prisma.inviteActivationOutbox.updateMany({
      where: { outTradeNo, completedAt: null },
      data: { lastError: 'record_invite_activation_failed', nextAttemptAt: new Date(Date.now() + delay) },
    });
  }
  return result;
}

/** scheduler 扫描入口；单轮有界，失败行由 nextAttemptAt 退避。 */
export async function scanInviteActivationOutbox(limit = 100): Promise<{ scanned: number; completed: number }> {
  const rows = await prisma.inviteActivationOutbox.findMany({
    where: { completedAt: null, nextAttemptAt: { lte: new Date() } },
    select: { outTradeNo: true },
    orderBy: { nextAttemptAt: 'asc' },
    take: Math.max(1, Math.min(500, limit)),
  });
  let completed = 0;
  for (const row of rows) {
    const result = await processInviteActivationOutbox(row.outTradeNo);
    if (result !== 'failed' && result !== 'not_due') completed += 1;
  }
  return { scanned: rows.length, completed };
}
