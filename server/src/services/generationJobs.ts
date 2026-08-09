import { createHash, randomUUID } from 'node:crypto';
import {
  GenerationKind,
  GenerationPhase,
  GenerationSettlementStatus,
  GenerationStatus,
  Prisma,
  type GenerationJob,
  type Session,
} from '@prisma/client';
import type {
  Deliverable,
  GenerationSummary,
  GenerationView,
  MessageRef,
} from '../../../shared/contracts';
import type { ChatReply, Usage } from '../llm/schema.js';
import { prisma } from '../db.js';
import { now } from './clock.js';
import {
  prepareDurableQuota,
  reserveDurableQuotaInTransaction,
  settleDurableQuotaInTransaction,
  type GraceKind,
} from './tokenQuota.js';
import { chargeCreditsOnce, refundCreditsOnce } from './credits.js';
import { recordAudit } from './audit.js';
import { noteChatGenerationFinalized } from './metrics.js';

const TERMINAL: ReadonlySet<GenerationStatus> = new Set([
  GenerationStatus.completed,
  GenerationStatus.truncated,
  GenerationStatus.failed,
  GenerationStatus.cancelled,
]);

const DEFAULT_LEASE_MS = 15_000;
const MAX_EFFECT_ERROR = 2_000;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(obj).sort().map((key) => [key, canonical(obj[key])]));
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function legacyClientRequestId(): string {
  return `legacy-${randomUUID()}`;
}

export class GenerationJobError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
    readonly generationId?: string,
  ) {
    super(message);
  }
}

export class GenerationInProgressError extends GenerationJobError {
  constructor(generationId: string) {
    super('上一条回复仍在生成中', 'GENERATION_IN_PROGRESS', 409, generationId);
  }
}

export class GenerationIdempotencyMismatchError extends GenerationJobError {
  constructor(generationId: string) {
    super('同一请求标识不能用于不同内容', 'GENERATION_IDEMPOTENCY_MISMATCH', 409, generationId);
  }
}

export class GenerationNotFoundError extends GenerationJobError {
  constructor() { super('生成任务不存在', 'GENERATION_NOT_FOUND', 404); }
}

export class GenerationLeaseLostError extends Error {
  constructor() { super('generation lease lost'); }
}

export interface CreateGenerationJobInput {
  tenantId: string;
  userId: string;
  agentKey: string;
  text: string;
  clientRequestId: string;
  sessionId?: string | null;
  parentGenerationId?: string | null;
  projectId?: string | null;
  refs?: MessageRef[];
  kind: 'chat' | 'report';
  billingRatio: number;
  quotaReserveTokens?: number;
  grace?: GraceKind;
  creditCost?: number;
  requestMeta?: Record<string, unknown>;
}

export interface CreatedGenerationJob {
  job: GenerationJob;
  session: Session;
  createdSession: boolean;
  attached: boolean;
}

function requestSnapshot(input: CreateGenerationJobInput): Record<string, unknown> {
  return {
    text: input.text,
    agentKey: input.agentKey,
    sessionId: input.sessionId ?? null,
    parentGenerationId: input.parentGenerationId ?? null,
    projectId: input.projectId ?? null,
    refs: input.refs ?? [],
    kind: input.kind,
    billingRatio: input.billingRatio,
    creditCost: input.creditCost ?? 0,
    ...(input.requestMeta ?? {}),
  };
}

async function existingByClientKey(userId: string, clientRequestId: string): Promise<GenerationJob | null> {
  return prisma.generationJob.findUnique({
    where: { userId_clientRequestId: { userId, clientRequestId } },
  });
}

/**
 * 幂等建单。provider 外呼必须发生在本函数成功提交之后。
 * 钱包预留、user message、job 与 Session.activeGenerationId 在同一事务内落地。
 */
export async function createGenerationJob(input: CreateGenerationJobInput): Promise<CreatedGenerationJob> {
  const snapshot = requestSnapshot(input);
  const requestFingerprint = fingerprint(snapshot);
  const quotaPreparation = input.quotaReserveTokens != null
    ? await prepareDurableQuota(input.userId, input.grace)
    : null;
  let graceGranted = false;

  const run = async (): Promise<CreatedGenerationJob> => prisma.$transaction(async (tx) => {
    const existing = await tx.generationJob.findUnique({
      where: { userId_clientRequestId: { userId: input.userId, clientRequestId: input.clientRequestId } },
    });
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new GenerationIdempotencyMismatchError(existing.id);
      }
      const session = await tx.session.findFirst({
        where: { id: existing.sessionId, userId: input.userId, tenantId: input.tenantId },
      });
      if (!session) throw new GenerationNotFoundError();
      return { job: existing, session, createdSession: false, attached: true };
    }

    let createdSession = false;
    let session = input.sessionId
      ? await tx.session.findFirst({
        where: { id: input.sessionId, userId: input.userId, tenantId: input.tenantId },
      })
      : null;
    if (input.sessionId && !session) throw new GenerationNotFoundError();
    if (!session) {
      session = await tx.session.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          agentKey: input.agentKey,
          projectId: input.projectId ?? null,
          title: input.text.slice(0, 18) || '新对话',
        },
      });
      createdSession = true;
    }
    if (session.agentKey !== input.agentKey) {
      throw new GenerationJobError('会话与军师不匹配', 'GENERATION_SESSION_MISMATCH', 409);
    }

    if (session.activeGenerationId) {
      const active = await tx.generationJob.findUnique({ where: { id: session.activeGenerationId } });
      // 用户已经点过「停止」的任务不得再挡住下一条消息。running 态的取消是**软取消**
      // （requestGenerationCancel 只写 cancelRequestedAt + abort 控制器，落终态要等 worker 那一拍），
      // 若这段窗口里照旧抛 GENERATION_IN_PROGRESS，用户的表现就是「停完再发，石沉大海」——
      // 他已经明确表达不要那条回复了，服务端还拿它挡路是最难自证的一类卡死。
      // 让位是安全的：老任务自己的 finalize 用 `activeGenerationId: job.id` 做条件更新，
      // 抢不回已经指向新任务的会话，退款/结算路径也不受影响。
      const superseded = Boolean(active?.cancelRequestedAt);
      if (active && !TERMINAL.has(active.status) && !superseded) throw new GenerationInProgressError(active.id);
      await tx.session.updateMany({
        where: { id: session.id, activeGenerationId: session.activeGenerationId },
        data: { activeGenerationId: null },
      });
      session = { ...session, activeGenerationId: null };
    }

    if (input.parentGenerationId) {
      const parent = await tx.generationJob.findFirst({
        where: { id: input.parentGenerationId, userId: input.userId, tenantId: input.tenantId },
      });
      if (!parent || !TERMINAL.has(parent.status) || parent.sessionId !== session.id) {
        throw new GenerationJobError('续写来源无效', 'GENERATION_PARENT_INVALID', 409);
      }
    }

    const userMessage = await tx.message.create({
      data: {
        sessionId: session.id,
        role: 'user',
        contentJson: { text: input.text },
        refsJson: input.refs?.length ? input.refs as unknown as Prisma.InputJsonValue : undefined,
      },
    });
    let job = await tx.generationJob.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        sessionId: session.id,
        agentKey: input.agentKey,
        clientRequestId: input.clientRequestId,
        requestFingerprint,
        parentGenerationId: input.parentGenerationId ?? null,
        kind: input.kind === 'report' ? GenerationKind.report : GenerationKind.chat,
        userMessageId: userMessage.id,
        requestJson: snapshot as Prisma.InputJsonValue,
      },
    });

    const occupied = await tx.session.updateMany({
      where: { id: session.id, activeGenerationId: null },
      data: { activeGenerationId: job.id },
    });
    if (occupied.count !== 1) {
      const active = await tx.session.findUnique({ where: { id: session.id }, select: { activeGenerationId: true } });
      throw new GenerationInProgressError(active?.activeGenerationId ?? job.id);
    }

    if (quotaPreparation && input.quotaReserveTokens != null) {
      const reservation = await reserveDurableQuotaInTransaction(
        tx,
        input.userId,
        input.billingRatio,
        input.quotaReserveTokens,
        quotaPreparation,
      );
      graceGranted = reservation.graceGranted;
      job = await tx.generationJob.update({
        where: { id: job.id },
        data: {
          quotaPeriodKey: reservation.periodKey,
          quotaReserved: reservation.reserved,
          settlementStatus: GenerationSettlementStatus.reserved,
        },
      });
    }

    const creditCost = Math.max(0, Math.trunc(input.creditCost ?? 0));
    if (creditCost > 0) {
      await chargeCreditsOnce(
        input.tenantId,
        input.userId,
        creditCost,
        `产出预扣 · ${input.agentKey}`,
        `generation:${job.id}:credit:reserve`,
        tx,
      );
      job = await tx.generationJob.update({
        where: { id: job.id },
        data: { creditReserved: creditCost, creditSettlementStatus: GenerationSettlementStatus.reserved },
      });
    }

    return { job, session: { ...session, activeGenerationId: job.id }, createdSession, attached: false };
  }, { maxWait: 10_000, timeout: 20_000 });

  try {
    const result = await run();
    if (graceGranted) {
      void recordAudit({
        tenantId: input.tenantId,
        userId: input.userId,
        action: 'system.quota.grace',
        payload: { kind: input.grace, generationId: result.job.id, reserved: result.job.quotaReserved },
      }).catch(() => {});
    }
    return result;
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      const existing = await existingByClientKey(input.userId, input.clientRequestId);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new GenerationIdempotencyMismatchError(existing.id);
        }
        const session = await prisma.session.findFirst({
          where: { id: existing.sessionId, userId: input.userId, tenantId: input.tenantId },
        });
        if (!session) throw new GenerationNotFoundError();
        return { job: existing, session, createdSession: false, attached: true };
      }
    }
    throw error;
  }
}

function usageObject(raw: unknown): GenerationView['usage'] {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const num = (key: string) => Math.max(0, Number(u[key]) || 0);
  return {
    inputTokens: num('inputTokens'),
    outputTokens: num('outputTokens'),
    cachedInput: num('cachedInput'),
    billableTokens: num('billableTokens'),
  };
}

export function generationSummary(job: GenerationJob): GenerationSummary {
  return {
    id: job.id,
    sessionId: job.sessionId,
    status: job.status,
    phase: job.phase,
    kind: job.kind,
    snapshotVersion: job.snapshotVersion,
    cancelRequested: !!job.cancelRequestedAt,
    resultMessageId: job.resultMessageId,
  };
}

export function generationView(job: GenerationJob): GenerationView {
  const reply = job.replyJson && typeof job.replyJson === 'object' ? job.replyJson as unknown : null;
  return {
    ...generationSummary(job),
    partialText: job.partialText,
    ...(job.kind === GenerationKind.chat && reply ? { reply: reply as ChatReply } : {}),
    ...(job.kind === GenerationKind.report && reply ? { deliverable: reply as Deliverable } : {}),
    usage: usageObject(job.usageJson),
    usageSource: job.usageSource as GenerationView['usageSource'],
    terminationReason: job.terminationReason,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

export async function getGenerationForUser(
  generationId: string,
  user: { id: string; tenantId: string },
): Promise<GenerationJob> {
  const job = await prisma.generationJob.findFirst({
    where: { id: generationId, userId: user.id, tenantId: user.tenantId },
  });
  if (!job) throw new GenerationNotFoundError();
  return job;
}

export async function activeGenerationForSession(
  sessionId: string,
  userId: string,
): Promise<GenerationJob | null> {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId },
    select: { activeGenerationId: true },
  });
  if (!session?.activeGenerationId) return null;
  const job = await prisma.generationJob.findUnique({ where: { id: session.activeGenerationId } });
  return job && !TERMINAL.has(job.status) ? job : null;
}

type ControllerEntry = { leaseVersion: number; controller: AbortController };
const controllers = new Map<string, ControllerEntry>();

export function registerGenerationController(jobId: string, leaseVersion: number, controller: AbortController): () => void {
  controllers.set(jobId, { leaseVersion, controller });
  return () => {
    const current = controllers.get(jobId);
    if (current?.controller === controller) controllers.delete(jobId);
  };
}

export async function requestGenerationCancel(
  generationId: string,
  user: { id: string; tenantId: string },
): Promise<GenerationJob> {
  const current = await getGenerationForUser(generationId, user);
  if (TERMINAL.has(current.status)) return current;

  if (current.status === GenerationStatus.queued) {
    const cancelled = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM generation_job WHERE id = ${generationId} FOR UPDATE`;
      const job = await tx.generationJob.findUniqueOrThrow({ where: { id: generationId } });
      if (TERMINAL.has(job.status)) return job;
      if (job.status !== GenerationStatus.queued) {
        return tx.generationJob.update({
          where: { id: job.id },
          data: { cancelRequestedAt: job.cancelRequestedAt ?? now() },
        });
      }
      if (job.settlementStatus === GenerationSettlementStatus.reserved) {
        await settleDurableQuotaInTransaction(tx, {
          userId: job.userId,
          periodKey: job.quotaPeriodKey,
          reserved: job.quotaReserved,
          charged: 0,
        });
      }
      if (job.creditSettlementStatus === GenerationSettlementStatus.reserved && job.creditReserved > 0) {
        await refundCreditsOnce(
          job.tenantId,
          job.userId,
          job.creditReserved,
          '生成取消 · 退回钻石',
          `generation:${job.id}:credit:refund`,
          tx,
        );
      }
      await tx.session.updateMany({
        where: { id: job.sessionId, activeGenerationId: job.id },
        data: { activeGenerationId: null },
      });
      return tx.generationJob.update({
        where: { id: job.id },
        data: {
          status: GenerationStatus.cancelled,
          phase: GenerationPhase.finalize,
          cancelRequestedAt: job.cancelRequestedAt ?? now(),
          terminationReason: 'user_cancelled_before_provider',
          quotaCharged: 0,
          settlementStatus: job.settlementStatus === GenerationSettlementStatus.reserved
            ? GenerationSettlementStatus.refunded
            : job.settlementStatus,
          settledAt: now(),
          creditSettlementStatus: job.creditSettlementStatus === GenerationSettlementStatus.reserved
            ? GenerationSettlementStatus.refunded
            : job.creditSettlementStatus,
          completedAt: now(),
        },
      });
    });
    if (cancelled.kind === GenerationKind.chat) {
      const seconds = Math.max(0, cancelled.completedAt!.getTime() - cancelled.createdAt.getTime()) / 1000;
      noteChatGenerationFinalized({
        result: 'cancelled',
        queueSeconds: seconds,
        providerSeconds: 0,
        finalizeSeconds: 0,
        jobSeconds: seconds,
        recovered: false,
      });
    }
    return cancelled;
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM generation_job WHERE id = ${current.id} FOR UPDATE`;
    const job = await tx.generationJob.findUniqueOrThrow({ where: { id: current.id } });
    if (TERMINAL.has(job.status)) return job;

    // running 取消是软取消，worker 仍需在拿到 provider 实际 usage 后落最终账。这里先把尚未
    // 结算的预留全额放回钱包，让用户点停后可以立即开始下一轮；quotaReserved 归零但保留
    // settlementStatus=reserved，finalize 时会以 reserved=0 扣除旧任务已经真实产生的消耗。
    // job 行锁与钱包锁把「释放预留」和 worker 的最终结算串行化，避免重复退款或漏记消耗。
    let quotaReserved = job.quotaReserved;
    if (job.settlementStatus === GenerationSettlementStatus.reserved && quotaReserved > 0) {
      await settleDurableQuotaInTransaction(tx, {
        userId: job.userId,
        periodKey: job.quotaPeriodKey,
        reserved: quotaReserved,
        charged: 0,
      });
      quotaReserved = 0;
    }
    return tx.generationJob.update({
      where: { id: job.id },
      data: {
        cancelRequestedAt: job.cancelRequestedAt ?? now(),
        quotaReserved,
      },
    });
  });
  controllers.get(current.id)?.controller.abort(new Error('user_cancelled'));
  return updated;
}

export async function claimNextGenerationJob(
  workerId: string,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<GenerationJob | null> {
  return prisma.$transaction(async (tx) => {
    const at = now();
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM generation_job
      WHERE status = 'queued'
         OR (status = 'running' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${at}))
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`;
    const id = rows[0]?.id;
    if (!id) return null;
    const current = await tx.generationJob.findUniqueOrThrow({ where: { id } });
    if (current.status === GenerationStatus.running) {
      // 旧 worker 租约已经过期：把它留下的 running attempt 先封账，再提升 leaseVersion。
      // provider 不支持全局幂等，接管后可能再外呼一次；旧 attempt 也是真实成本，不能因为进程崩溃记 0。
      const contextChars = JSON.stringify(current.contextJson ?? current.requestJson).length;
      const inputTokens = Math.max(1, Math.ceil(contextChars / 2));
      const outputTokens = Math.max(0, Math.ceil(current.partialText.length / 2));
      const estimate: Usage = {
        inputTokens,
        outputTokens,
        cachedInput: 0,
        billableTokens: inputTokens + outputTokens,
      };
      await tx.generationAttempt.updateMany({
        where: { jobId: current.id, status: 'running' },
        data: {
          status: 'failed',
          usageJson: estimate as unknown as Prisma.InputJsonValue,
          usageSource: 'estimated',
          terminationReason: 'process_recovered',
          completedAt: at,
        },
      });
    }
    return tx.generationJob.update({
      where: { id },
      data: {
        status: GenerationStatus.running,
        phase: current.status === GenerationStatus.queued ? GenerationPhase.context : current.phase,
        leaseOwner: workerId,
        leaseVersion: { increment: 1 },
        leaseExpiresAt: new Date(at.getTime() + leaseMs),
        heartbeatAt: at,
        startedAt: current.startedAt ?? at,
      },
    });
  });
}

export async function heartbeatGenerationLease(
  jobId: string,
  workerId: string,
  leaseVersion: number,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<void> {
  const at = now();
  const changed = await prisma.generationJob.updateMany({
    where: { id: jobId, status: GenerationStatus.running, leaseOwner: workerId, leaseVersion },
    data: { heartbeatAt: at, leaseExpiresAt: new Date(at.getTime() + leaseMs) },
  });
  if (changed.count !== 1) throw new GenerationLeaseLostError();
}

export async function freezeGenerationContext(args: {
  jobId: string;
  workerId: string;
  leaseVersion: number;
  context: Prisma.InputJsonValue;
}): Promise<void> {
  const changed = await prisma.generationJob.updateMany({
    where: {
      id: args.jobId,
      status: GenerationStatus.running,
      leaseOwner: args.workerId,
      leaseVersion: args.leaseVersion,
      contextFrozenAt: null,
    },
    data: { contextJson: args.context, contextFrozenAt: now() },
  });
  if (changed.count !== 1) {
    const current = await prisma.generationJob.findUnique({
      where: { id: args.jobId },
      select: { leaseOwner: true, leaseVersion: true, contextFrozenAt: true },
    });
    if (!current || current.leaseOwner !== args.workerId || current.leaseVersion !== args.leaseVersion) {
      throw new GenerationLeaseLostError();
    }
    // 已冻结代表重入/恢复，不覆盖第一次快照。
  }
}

export async function startGenerationAttempt(
  jobId: string,
  workerId: string,
  leaseVersion: number,
  kind: 'main' | 'continue' | 'fallback' | 'ask_recovery',
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM generation_job WHERE id = ${jobId} FOR UPDATE`;
    const job = await tx.generationJob.findUniqueOrThrow({ where: { id: jobId } });
    if (job.status !== GenerationStatus.running || job.leaseOwner !== workerId || job.leaseVersion !== leaseVersion) {
      throw new GenerationLeaseLostError();
    }
    const max = await tx.generationAttempt.aggregate({ where: { jobId }, _max: { attemptNo: true } });
    const attemptNo = (max._max.attemptNo ?? 0) + 1;
    await tx.generationAttempt.create({
      data: {
        jobId,
        attemptNo,
        kind,
        status: 'running',
        leaseVersion,
        startedAt: now(),
      },
    });
    await tx.generationJob.update({ where: { id: jobId }, data: { phase: GenerationPhase.provider } });
    return attemptNo;
  });
}

export async function finishGenerationAttempt(args: {
  jobId: string;
  attemptNo: number;
  leaseVersion: number;
  status: 'completed' | 'failed' | 'cancelled';
  usage: Usage;
  usageSource: 'provider' | 'estimated' | 'mixed';
  terminationReason?: string | null;
  provider?: string | null;
  model?: string | null;
  endpointId?: string | null;
  providerRequestId?: string | null;
}): Promise<void> {
  const changed = await prisma.generationAttempt.updateMany({
    where: {
      jobId: args.jobId,
      attemptNo: args.attemptNo,
      leaseVersion: args.leaseVersion,
      status: 'running',
    },
    data: {
      status: args.status,
      usageJson: args.usage as unknown as Prisma.InputJsonValue,
      usageSource: args.usageSource,
      terminationReason: args.terminationReason ?? null,
      provider: args.provider ?? null,
      model: args.model ?? null,
      endpointId: args.endpointId ?? null,
      providerRequestId: args.providerRequestId ?? null,
      completedAt: now(),
    },
  });
  if (changed.count !== 1) throw new GenerationLeaseLostError();
}

export async function writeGenerationSnapshot(args: {
  jobId: string;
  workerId: string;
  leaseVersion: number;
  text: string;
  leaseMs?: number;
}): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const at = now();
    const changed = await tx.generationJob.updateMany({
      where: {
        id: args.jobId,
        status: GenerationStatus.running,
        leaseOwner: args.workerId,
        leaseVersion: args.leaseVersion,
      },
      data: {
        partialText: args.text,
        snapshotVersion: { increment: 1 },
        heartbeatAt: at,
        leaseExpiresAt: new Date(at.getTime() + (args.leaseMs ?? DEFAULT_LEASE_MS)),
      },
    });
    if (changed.count !== 1) throw new GenerationLeaseLostError();
    const row = await tx.generationJob.findUniqueOrThrow({ where: { id: args.jobId }, select: { snapshotVersion: true } });
    return row.snapshotVersion;
  });
}

export async function persistGenerationResult(args: {
  jobId: string;
  workerId: string;
  leaseVersion: number;
  role: 'assistant' | 'report';
  content: ChatReply | Deliverable;
  partialText: string;
  kind: 'chat' | 'report';
}): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM generation_job WHERE id = ${args.jobId} FOR UPDATE`;
    const job = await tx.generationJob.findUniqueOrThrow({ where: { id: args.jobId } });
    if (job.status !== GenerationStatus.running || job.leaseOwner !== args.workerId || job.leaseVersion !== args.leaseVersion) {
      throw new GenerationLeaseLostError();
    }
    let messageId = job.resultMessageId;
    if (messageId) {
      await tx.message.update({
        where: { id: messageId },
        data: { contentJson: args.content as unknown as Prisma.InputJsonValue },
      });
    } else {
      const message = await tx.message.create({
        data: {
          sessionId: job.sessionId,
          role: args.role,
          contentJson: args.content as unknown as Prisma.InputJsonValue,
        },
      });
      messageId = message.id;
    }
    await tx.generationJob.update({
      where: { id: job.id },
      data: {
        resultMessageId: messageId,
        kind: args.kind === 'report' ? GenerationKind.report : GenerationKind.chat,
        phase: GenerationPhase.finalize,
        partialText: args.partialText,
        replyJson: args.content as unknown as Prisma.InputJsonValue,
        snapshotVersion: { increment: 1 },
      },
    });
    return messageId;
  });
}

function mergeAttemptUsage(attempts: { usageJson: Prisma.JsonValue | null; usageSource: string | null }[]): {
  usage: Usage;
  source: 'provider' | 'estimated' | 'mixed';
} {
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInput: 0, billableTokens: 0 };
  // context 阶段取消/失败时没有 attempt，也没有任何上游消耗；沿用 provider 代表“无需估算的确定 0”，
  // 避免把 0 消耗误报成 chat_usage_estimated。
  if (!attempts.length) return { usage, source: 'provider' };
  const sources = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.usageSource) sources.add(attempt.usageSource);
    const raw = attempt.usageJson && typeof attempt.usageJson === 'object'
      ? attempt.usageJson as Record<string, unknown>
      : {};
    usage.inputTokens += Math.max(0, Number(raw.inputTokens) || 0);
    usage.outputTokens += Math.max(0, Number(raw.outputTokens) || 0);
    usage.cachedInput = (usage.cachedInput ?? 0) + Math.max(0, Number(raw.cachedInput) || 0);
    usage.billableTokens = (usage.billableTokens ?? 0) + Math.max(0, Number(raw.billableTokens) || 0);
  }
  const source = sources.size === 1 && sources.has('provider')
    ? 'provider'
    : sources.size === 1 && sources.has('estimated')
      ? 'estimated'
      : 'mixed';
  return { usage, source };
}

export async function finalizeGeneration(args: {
  jobId: string;
  workerId: string;
  leaseVersion: number;
  status: 'completed' | 'truncated' | 'failed' | 'cancelled';
  terminationReason?: string | null;
  effectKeys?: string[];
}): Promise<GenerationJob> {
  const finalized = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM generation_job WHERE id = ${args.jobId} FOR UPDATE`;
    const job = await tx.generationJob.findUniqueOrThrow({ where: { id: args.jobId } });
    if (TERMINAL.has(job.status)) return { job, metric: null };
    if (job.status !== GenerationStatus.running || job.leaseOwner !== args.workerId || job.leaseVersion !== args.leaseVersion) {
      throw new GenerationLeaseLostError();
    }
    const status = GenerationStatus[args.status];
    if (status !== GenerationStatus.failed && !job.resultMessageId && job.partialText) {
      const reply: ChatReply = { text: job.partialText, truncated: status !== GenerationStatus.completed };
      const message = await tx.message.create({
        data: { sessionId: job.sessionId, role: 'assistant', contentJson: reply as unknown as Prisma.InputJsonValue },
      });
      await tx.generationJob.update({
        where: { id: job.id },
        data: { resultMessageId: message.id, replyJson: reply as unknown as Prisma.InputJsonValue },
      });
    }

    const attempts = await tx.generationAttempt.findMany({
      where: { jobId: job.id },
      select: { usageJson: true, usageSource: true, startedAt: true, completedAt: true, provider: true },
    });
    const aggregate = mergeAttemptUsage(attempts);
    const request = job.requestJson && typeof job.requestJson === 'object'
      ? job.requestJson as Record<string, unknown>
      : {};
    const ratio = Number(request.billingRatio) > 0 ? Number(request.billingRatio) : 1;
    const charged = Math.ceil(Math.max(0, aggregate.usage.billableTokens ?? 0) * ratio);

    let settlementStatus = job.settlementStatus;
    if (job.settlementStatus === GenerationSettlementStatus.reserved) {
      await settleDurableQuotaInTransaction(tx, {
        userId: job.userId,
        periodKey: job.quotaPeriodKey,
        reserved: job.quotaReserved,
        charged,
      });
      settlementStatus = charged > 0 ? GenerationSettlementStatus.settled : GenerationSettlementStatus.refunded;
    }

    let creditSettlementStatus = job.creditSettlementStatus;
    if (job.creditSettlementStatus === GenerationSettlementStatus.reserved) {
      if ((status === GenerationStatus.failed || status === GenerationStatus.cancelled) && job.creditReserved > 0) {
        await refundCreditsOnce(
          job.tenantId,
          job.userId,
          job.creditReserved,
          '生成未交付 · 退回钻石',
          `generation:${job.id}:credit:refund`,
          tx,
        );
        creditSettlementStatus = GenerationSettlementStatus.refunded;
      } else {
        creditSettlementStatus = GenerationSettlementStatus.settled;
      }
    }

    await tx.session.updateMany({
      where: { id: job.sessionId, activeGenerationId: job.id },
      data: { activeGenerationId: null, updatedAt: now() },
    });
    const completedAt = now();
    const updated = await tx.generationJob.update({
      where: { id: job.id },
      data: {
        status,
        phase: GenerationPhase.finalize,
        usageJson: aggregate.usage as unknown as Prisma.InputJsonValue,
        usageSource: aggregate.source,
        quotaCharged: charged,
        settlementStatus,
        creditSettlementStatus,
        terminationReason: args.terminationReason ?? null,
        settledAt: now(),
        completedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: now(),
      },
    });
    // 结果终态与 outbox 同事务提交：进程即使在 finalize 返回后立刻退出，副作用任务也不会凭空丢失。
    // 消费端是 at-least-once；各目标服务仍须以 jobId/effectKey 做业务幂等。
    if (args.effectKeys?.length) {
      await tx.generationEffect.createMany({
        data: args.effectKeys.map((effectKey) => ({ jobId: job.id, effectKey })),
        skipDuplicates: true,
      });
    }
    if (job.kind !== GenerationKind.chat) return { job: updated, metric: null };
    const queueSeconds = Math.max(0, (job.startedAt ?? completedAt).getTime() - job.createdAt.getTime()) / 1000;
    const providerSeconds = attempts.reduce((sum, attempt) => {
      if (!attempt.startedAt) return sum;
      return sum + Math.max(0, (attempt.completedAt ?? completedAt).getTime() - attempt.startedAt.getTime()) / 1000;
    }, 0);
    const lastAttemptEnd = attempts.reduce<Date | null>((latest, attempt) => {
      const end = attempt.completedAt ?? null;
      return end && (!latest || end > latest) ? end : latest;
    }, null);
    return {
      job: updated,
      metric: {
        result: args.status,
        queueSeconds,
        providerSeconds,
        finalizeSeconds: Math.max(0, completedAt.getTime() - (lastAttemptEnd ?? completedAt).getTime()) / 1000,
        jobSeconds: Math.max(0, completedAt.getTime() - job.createdAt.getTime()) / 1000,
        recovered: job.leaseVersion > 1,
        usageSource: aggregate.source,
        provider: attempts.find((attempt) => attempt.provider)?.provider ?? null,
      },
    };
  }, { maxWait: 10_000, timeout: 20_000 });
  if (finalized.metric) noteChatGenerationFinalized(finalized.metric);
  return finalized.job;
}

export async function enqueueGenerationEffects(jobId: string, effectKeys: string[]): Promise<void> {
  if (!effectKeys.length) return;
  await prisma.generationEffect.createMany({
    data: effectKeys.map((effectKey) => ({ jobId, effectKey })),
    skipDuplicates: true,
  });
}

export async function runGenerationEffect(
  jobId: string,
  effectKey: string,
  run: () => Promise<void>,
): Promise<void> {
  const claimed = await prisma.generationEffect.updateMany({
    where: { jobId, effectKey, status: { in: ['pending', 'failed'] } },
    data: { status: 'running', attempt: { increment: 1 }, lastError: null },
  });
  if (claimed.count !== 1) return;
  try {
    await run();
    await prisma.generationEffect.update({
      where: { jobId_effectKey: { jobId, effectKey } },
      data: { status: 'completed', completedAt: now(), lastError: null },
    });
  } catch (error) {
    await prisma.generationEffect.update({
      where: { jobId_effectKey: { jobId, effectKey } },
      data: { status: 'failed', lastError: String((error as Error).message ?? error).slice(0, MAX_EFFECT_ERROR) },
    });
    throw error;
  }
}
