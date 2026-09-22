import type { Prisma, VideoCreditHold } from '@prisma/client';
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
      `video:charge:${input.userId}:${input.clientRequestId}`,
      tx,
    );
    const hold = await tx.videoCreditHold.create({ data: { ...input, credits, status: 'submitting' } });
    return { hold, reused: false };
  });
}

export async function attachVideoJob(holdId: string, upstreamJobId: string) {
  return prisma.videoCreditHold.update({ where: { id: holdId }, data: { upstreamJobId, status: 'submitted', lastJobStatus: 'queued' } });
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
  if (status === 'failed' || status === 'cancelled') return refundVideoHold(hold.id, status);
  if (status === 'succeeded') {
    // 迁到 settled 必须用 DB 现值做条件写，不能信任上面那条无锁快照读 hold.status。
    // 「取消/删除刚退完款(refunded)」若与并发的一次 succeeded 结算撞上：旧代码按快照里的
    // 'submitted' 判定、再无条件 update 成 settled，会把已提交的 refunded 反写掉——
    // 账面成了已结算而退款流水已经发生（用户既留住退款又拿到成片）。带 status 守卫的
    // updateMany 命中 0 行，就说明这行已是 refunded/settled，退回去只补 lastJobStatus、不改 status。
    const res = await prisma.videoCreditHold.updateMany({
      where: { id: hold.id, status: { notIn: ['refunded', 'settled'] } },
      data: { status: 'settled', lastJobStatus: status },
    });
    if (res.count === 0) {
      return prisma.videoCreditHold.update({ where: { id: hold.id }, data: { lastJobStatus: status } });
    }
    return prisma.videoCreditHold.findUnique({ where: { id: hold.id } });
  }
  // 其余状态（queued / running / 快照是 refunded 等）：只反映 lastJobStatus，不迁 status。
  // refunded / settled 是终点，这里即便快照不是它，也只写 lastJobStatus、不会把终态改走。
  return prisma.videoCreditHold.update({ where: { id: hold.id }, data: { lastJobStatus: status } });
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
      await attachVideoJob(hold.id, result.jobId);
      if (result.status && result.status !== 'queued') await settleVideoJob(result.jobId, result.status);
      attached += 1;
    } else if (result.outcome === 'rejected') {
      const row = await refundVideoHold(hold.id, result.reason ?? 'submit_rejected').catch(() => null);
      if (row?.status === 'refunded') refunded += 1;
    } else {
      await markVideoSubmissionUnknown(hold.id);
    }
  }
  return { scanned: rows.length, attached, refunded };
}
