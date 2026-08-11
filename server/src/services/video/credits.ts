import type { Prisma } from '@prisma/client';
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

export async function settleVideoJob(upstreamJobId: string, status: string) {
  const hold = await prisma.videoCreditHold.findUnique({ where: { upstreamJobId } });
  if (!hold) return null;
  if (status === 'failed' || status === 'cancelled') return refundVideoHold(hold.id, status);
  if (status === 'succeeded' && hold.status !== 'settled') {
    return prisma.videoCreditHold.update({ where: { id: hold.id }, data: { status: 'settled', lastJobStatus: status } });
  }
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
      '快出片 · 失败退回',
      `video:refund:${hold.id}`,
      tx,
    );
    return tx.videoCreditHold.update({
      where: { id: hold.id },
      data: { status: 'refunded', refundedAt: new Date(), lastJobStatus },
    });
  });
}

/** 进程在扣费后、上游建单前崩溃时自动退回；不碰已拿到 jobId 的正常长任务。 */
export async function refundStaleUnsubmittedVideoHolds(maxAgeMs = 10 * 60_000): Promise<number> {
  const rows = await prisma.videoCreditHold.findMany({
    where: { status: { in: ['submitting', 'charged'] }, upstreamJobId: null, updatedAt: { lt: new Date(Date.now() - maxAgeMs) } },
    select: { id: true },
    take: 100,
  });
  let refunded = 0;
  for (const row of rows) {
    const result = await refundVideoHold(row.id, 'submit_timeout').catch(() => null);
    if (result?.status === 'refunded') refunded += 1;
  }
  return refunded;
}
