import type { Prisma, VideoCreditHold } from '@prisma/client';
import { PRODUCT } from '../products.js';
import { prisma } from '../../db.js';
import { chargeCreditsOnce, refundCreditsOnce } from '../credits.js';

type Tx = Prisma.TransactionClient;

export class VideoCreditConflictError extends Error {
  statusCode = 409;
  code = 'CLIP_RENDER_REQUEST_CONFLICT';
}

async function lock(tx: Tx, userId: string, clientRequestId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`video:${userId}:${clientRequestId}`}))`;
}

export async function reserveVideoCredits(input: {
  tenantId: string; userId: string; projectId: string; clientRequestId: string; credits: number;
}) {
  const credits = Math.max(0, Math.round(input.credits));
  return prisma.$transaction(async (tx) => {
    await lock(tx, input.userId, input.clientRequestId);
    const existing = await tx.videoCreditHold.findUnique({
      where: { userId_clientRequestId: { userId: input.userId, clientRequestId: input.clientRequestId } },
    });
    if (existing) {
      if (existing.projectId !== input.projectId || existing.credits !== credits) throw new VideoCreditConflictError('同一请求标识对应的项目或报价已变化');
      return { hold: existing, reused: true };
    }
    await chargeCreditsOnce(
      input.tenantId,
      input.userId,
      credits,
      '快出片 · 出片预扣',
      PRODUCT.quickreel,
      `video:charge:${input.userId}:${input.clientRequestId}`,
      tx,
    );
    const hold = await tx.videoCreditHold.create({ data: { ...input, credits, productCode: PRODUCT.quickreel, status: 'submitting' } });
    return { hold, reused: false };
  });
}

/**
 * 回填上游任务号。
 *
 * **条件更新，不是无条件 update。** 原来这里是 `update({ where: { id } })`，没有任何状态判断 ——
 * 谁调到就写，包括把 `refunded` 写回 `submitted`。真实撞法（2026-09-11 codex 审出）：
 * 手工对单 / 补交扫描向上游查单（慢），期间用户取消 → refundVideoHold 退钱并写 refunded；
 * 查单返回 accepted → attachVideoJob 无条件把它改回 submitted，refundedAt 还留着。
 * 这单看起来又活了，出片完成扫描随后把它结算掉 —— 用户既拿了退款又拿到了片子。
 *
 * 隔壁 markVideoSubmissionUnknown 一直是带 where 守卫的 updateMany，这里漏了，是不对称造成的。
 * 判定与写入放进同一条 SQL 由数据库保证原子，比加锁简单也更不容易用错
 * （refundVideoHold 自带 advisory lock，外面再套一层锁会跨连接自锁）。
 *
 * @returns 是否真的回填了。false = 这单已经不在「等回填」的状态了，调用方不该再宣称回填成功。
 */
export async function attachVideoJob(holdId: string, upstreamJobId: string): Promise<boolean> {
  const r = await prisma.videoCreditHold.updateMany({
    where: { id: holdId, upstreamJobId: null, status: { in: ['submitting', 'unknown'] } },
    data: { upstreamJobId, status: 'submitted', lastJobStatus: 'queued' },
  });
  return r.count > 0;
}

export async function markVideoSubmissionUnknown(holdId: string, message?: string) {
  return prisma.videoCreditHold.updateMany({
    where: { id: holdId, status: { in: ['submitting', 'unknown'] }, upstreamJobId: null },
    data: { status: 'unknown', lastJobStatus: message ? `submission_unknown:${message.slice(0, 120)}` : 'submission_unknown' },
  });
}

export async function settleVideoJob(upstreamJobId: string, status: string) {
  const hold = await prisma.videoCreditHold.findUnique({ where: { upstreamJobId } });
  if (!hold) return null;
  // refunded 是终点：钱已经退回用户账上了。以前这里只挡了 settled，于是
  // 「取消/删除刚退完款」撞上「并发的一次 succeeded 查询」会把它反写成 settled ——
  // 账面成了已结算，可退款流水已经发生。任何状态都不许从 refunded 迁出去。
  if (hold.status === 'refunded') {
    return prisma.videoCreditHold.update({ where: { id: hold.id }, data: { lastJobStatus: status } });
  }
  if (status === 'failed' || status === 'cancelled') return refundVideoHold(hold.id, status);
  if (status === 'succeeded') {
    // **条件更新**，不是「先读状态再写」。上面那次 findUnique 是几行之前读的，
    // 中间足够并发的取消路径完成一次退款：读到的是 submitted，写下去就把 refunded 盖成 settled，
    // 退款流水和 refundedAt 都还在，账面却显示已结算（2026-09-11 codex 审出的 TOCTOU）。
    // 把终态判断挪进 where，由数据库在同一条 SQL 里裁决。
    //
    // 不加 advisory lock 是刻意的：refundVideoHold 自己在事务里持 `video-hold:<id>`，
    // 这里再套一层就会是「外层事务持锁、内层事务等同一把锁」的跨连接自锁。
    const done = await prisma.videoCreditHold.updateMany({
      where: { id: hold.id, status: { notIn: ['refunded', 'settled'] } },
      data: { status: 'settled', lastJobStatus: status },
    });
    if (done.count > 0) return prisma.videoCreditHold.findUnique({ where: { id: hold.id } });
    // 已经是终态：上游最后一次状态照记，但一个字都不动 status。
  }
  await prisma.videoCreditHold.updateMany({ where: { id: hold.id }, data: { lastJobStatus: status } });
  return prisma.videoCreditHold.findUnique({ where: { id: hold.id } });
}

export async function refundVideoHold(holdId: string, lastJobStatus = 'failed') {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`video-hold:${holdId}`}))`;
    const hold = await tx.videoCreditHold.findUnique({ where: { id: holdId } });
    if (!hold || hold.status === 'refunded') return hold;
    if (hold.status === 'settled') return hold;
    await refundCreditsOnce(
      hold.tenantId,
      hold.userId,
      hold.credits,
      ['cancelled', 'work_deleted'].includes(lastJobStatus) ? '快出片 · 取消退回' : '快出片 · 失败退回',
      PRODUCT.quickreel,
      `video:refund:${hold.id}`,
      tx,
    );
    return tx.videoCreditHold.update({
      where: { id: hold.id },
      data: { status: 'refunded', refundedAt: new Date(), lastJobStatus },
    });
  });
}

export type VideoSubmissionProbeResult =
  | { outcome: 'accepted'; jobId: string; status?: string }
  | { outcome: 'rejected'; reason?: string }
  | { outcome: 'unknown' };
export type VideoSubmissionProbe = (hold: VideoCreditHold) => Promise<VideoSubmissionProbeResult>;

/**
 * 扣费后未拿到 jobId 只能向上游按 clientRequestId 对账/幂等补交，绝不能按超时直接退款。
 * accepted 回填锚点；明确 rejected 才退款；网络不确定继续保留 unknown 等下一轮。
 */
export async function reconcileStaleUnsubmittedVideoHolds(
  probe: VideoSubmissionProbe,
  maxAgeMs = 30_000,
): Promise<{ scanned: number; attached: number; refunded: number }> {
  const rows = await prisma.videoCreditHold.findMany({
    where: { status: { in: ['submitting', 'unknown'] }, upstreamJobId: null, updatedAt: { lt: new Date(Date.now() - maxAgeMs) } },
    take: 100,
  });
  let attached = 0; let refunded = 0;
  for (const hold of rows) {
    const result = await probe(hold).catch(() => ({ outcome: 'unknown' as const }));
    if (result.outcome === 'accepted') {
      // 条件更新：这单在查上游那几秒里可能已被取消退款。没落上就不计数，
      // 否则扫描日志报「补交了 N 单」而实际一单没动，是在给自己编绩效。
      const ok = await attachVideoJob(hold.id, result.jobId);
      if (ok && result.status && result.status !== 'queued') await settleVideoJob(result.jobId, result.status);
      if (ok) attached += 1;
    } else if (result.outcome === 'rejected') {
      const row = await refundVideoHold(hold.id, result.reason ?? 'submit_rejected').catch(() => null);
      if (row?.status === 'refunded') refunded += 1;
    } else {
      await markVideoSubmissionUnknown(hold.id);
    }
  }
  return { scanned: rows.length, attached, refunded };
}
