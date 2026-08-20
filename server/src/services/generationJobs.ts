import { createHash, randomUUID } from 'node:crypto';
import { envNum } from '../env.js';
import { noteLeaseThrashing } from './metrics.js';
import {
  GenerationKind,
  GenerationClassificationStatus,
  GenerationPhase,
  GenerationSettlementStatus,
  GenerationStatus,
  Prisma,
  type GenerationJob,
  type Session,
} from '@prisma/client';
import type {
  Deliverable,
  ComplexityAssessment,
  DeliveryMode,
  DeliveryStage,
  ImageObservationView,
  RequestedOutput,
  StagedDeliveryView,
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
import { createSessionHandoffInTransaction } from './sessionHandoff.js';

const TERMINAL: ReadonlySet<GenerationStatus> = new Set([
  GenerationStatus.completed,
  GenerationStatus.truncated,
  GenerationStatus.failed,
  GenerationStatus.cancelled,
]);

const DEFAULT_LEASE_MS = 15_000;

/**
 * 一个 job 最多被「租约过期接管」多少次。超过即判定为**接管抖动**（lease thrashing）直接判失败。
 *
 * 为什么必须有这个上限：2026-08-19 生产事故里，单个 chat job 的 `leaseVersion` 冲到 **644,208**
 * ——16 小时里被重新领取 64 万次（11 次/秒），打出 23,239 条 attempt（其中 23,238 条
 * `terminationReason='process_recovered'`，只有 1 条成功），把 28k token 的提示词往上游推了 1.7 万次，
 * 并独占并发闸 12 小时。它不会自愈，最后是靠一次无关的部署重启才停下。
 *
 * 单次 processJob 有 `CHAT_JOB_MAX_RUNTIME_MS` 五分钟封顶，但**对「一个 job 被接管多少次」原本
 * 没有任何上限**——这就是那 16 小时的由来。50 次相对正常值有极大余量（同期正常 job 的
 * leaseVersion 是 2），够覆盖真实的进程重启/部署接管，又能在抖动的头几秒就刹住。
 */
const MAX_LEASE_TAKEOVERS = Math.max(3, envNum('GENERATION_MAX_LEASE_TAKEOVERS', 50));

/** 同一用户同时在途（queued+running）的生成任务上限。见 createGenerationJob 里的说明。 */
const MAX_INFLIGHT_PER_USER = Math.max(2, envNum('GENERATION_MAX_INFLIGHT_PER_USER', 8));

/**
 * 接管退避：第 n 次接管额外多给 `min(n, 10) × 2s` 的租约。
 *
 * 光有上限还不够——上限是「撞墙才停」，这一条是「越抖越慢」，让抖动在撞上限之前就自然衰减。
 * 没有它时接管是热循环（观测到 11 次/秒）：租约一过期立刻被下一个领取者抢走，
 * 而每一次抢走都会 abort 掉一个**已经把提示词发给上游、已经花了钱**的在途调用。
 */
function takeoverBackoffMs(leaseVersion: number): number {
  return Math.min(leaseVersion, 10) * 2_000;
}

/**
 * 熔断告警（节流：10 分钟最多一条）。08-19 事故 16 小时无人知晓——单靠 Prometheus 指标
 * 还要等有人配告警规则，这里直接推飞书，发不出去只打日志、绝不影响熔断本身。
 */
let lastThrashAlertAt = 0;
function fireThrashingAlert(jobId: string, agentKey: string, takeovers: number): void {
  const nowMs = Date.now();
  if (nowMs - lastThrashAlertAt < 10 * 60_000) return;
  lastThrashAlertAt = nowMs;
  void import('./alertConfig.js')
    .then(({ sendFeishuText }) => sendFeishuText(
      `⛔ 生成任务接管抖动熔断\njob=${jobId} agent=${agentKey}\n`
      + `被接管 ${takeovers} 次已判失败（参照 2026-08-19 事故：单 job 曾被接管 64 万次跑了 16 小时）。\n`
      + `排查：generation_attempt 按 jobId 看 process_recovered；上限用 GENERATION_MAX_LEASE_TAKEOVERS 调。`,
    ))
    .then((r) => { if (!r.sent) console.error('[generation] 熔断告警未送达:', r.reason); })
    .catch((err) => console.error('[generation] 熔断告警失败:', (err as Error).message));
}
const MAX_EFFECT_ERROR = 2_000;
const MAX_PRIORITY = 9;
const DEFAULT_PRIORITY_AGING_SECONDS = 30;

/**
 * 每读一次 env（不在模块加载期定住）：调度参数要能在测试/线上逃生时当场改。
 * Number('') === 0 不是 NaN，空串/未设置必须先判掉，否则会被当成「显式配了 0」= 关掉老化，
 * 免费用户在高峰期就再也排不到前面（这正是老化要杜绝的饥饿）。
 */
function priorityAgingSeconds(): number {
  const raw = process.env.GENERATION_PRIORITY_AGING_SECONDS;
  if (raw == null || raw.trim() === '') return DEFAULT_PRIORITY_AGING_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PRIORITY_AGING_SECONDS;
  if (n === 0) return 0;
  // 0<n<1 的小数若被 trunc 成 0，等于把「调小老化窗口」误读成「关掉老化恢复饥饿」——语义相反的两件事
  // 绝不能只差一个小数点。非零正数至少算 1 秒。
  return Math.max(1, Math.trunc(n));
}

/**
 * 调度键（升序，越小越先领）：**虚拟到达时间** `createdAt - priority × agingSec`。
 * 每一级优先级等价于「提前 agingSec 秒到达」，priority 封顶 9 → 高档最多比同刻到达的免费单
 * 提前 9×30s=4.5 分钟，之后先来后到照旧 —— 防饥饿由此保证。
 * 不用「等待时长 FLOOR 折算虚涨等级」的写法：FLOOR 的阶梯让两单的相对次序随时钟边界来回翻转
 * （队列没有任何变化，排位数字却自己跳），虚拟到达时间是每行的静态值，次序稳定、可缓存可索引。
 * agingSec=0 = 严格优先级：key 退化为 (-priority)，高档绝对优先，牺牲低档最坏等待。
 * claim 与 countQueuedAhead **必须**共用本函数，改一处必须改另一处 ——
 * 否则用户看到的「前面还有 N 位」和 worker 的实际取单顺序会互相打脸。
 * alias 是本文件写死的字面量，不接受外部输入，Prisma.raw 在此不构成注入面。
 */
function schedulingKeySql(alias: 'j' | 'q' | 'me', agingSec: number): Prisma.Sql {
  const t = Prisma.raw(`"${alias}"`);
  if (agingSec <= 0) return Prisma.sql`(-${t}.priority)`;
  return Prisma.sql`(${t}."createdAt" - ${t}.priority * ${agingSec} * interval '1 second')`;
}

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

/** 用户在途任务过多。429 语义：不是请求本身有问题，是攒得太多，等前面跑完再来。 */
export class GenerationInflightLimitError extends Error {
  readonly statusCode = 429;
  readonly code = 'GENERATION_INFLIGHT_LIMIT';
  constructor(readonly inflight: number, readonly limit: number) {
    super(`你还有 ${inflight} 个产出正在进行，等前面跑完再发新的吧`);
  }
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
  requestedOutput?: RequestedOutput;
  deliveryMode?: DeliveryMode;
  classificationRequired?: boolean;
  complexity?: ComplexityAssessment | null;
  deliveryPlanId?: string | null;
  stageKey?: string | null;
  stageNumber?: number;
  stageAttempt?: number;
  deliveryStages?: DeliveryStage[];
  imageCount?: number;
  imageBatchCount?: number;
  /** 调度优先级快照（0-9），由调用方从套餐 tierRank 折算；不入幂等指纹。 */
  priority?: number;
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
    requestedOutput: input.requestedOutput ?? 'unspecified',
    deliveryMode: input.deliveryMode ?? 'single',
    classificationRequired: input.classificationRequired ?? false,
    complexity: input.complexity ?? null,
    deliveryPlanId: input.deliveryPlanId ?? null,
    stageKey: input.stageKey ?? null,
    stageNumber: Math.max(1, input.stageNumber ?? 1),
    stageAttempt: Math.max(1, input.stageAttempt ?? 1),
    deliveryStages: input.deliveryStages ?? [],
    imageCount: Math.max(0, input.imageCount ?? 0),
    imageBatchCount: Math.max(0, input.imageBatchCount ?? 0),
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

    // 同一用户在途（queued + running）任务数上限。限流管「多快」，这条管「堆多少」——
    // 幂等命中的重复点击走上面 existing 分支不到这里，所以触发它的一定是**真的在攒新单**。
    // 交付流水线的多阶段是串行推进的（同一 planId 一次只有一个 stage 在跑），8 个余量足够。
    const inflight = await tx.generationJob.count({
      where: { userId: input.userId, status: { in: [GenerationStatus.queued, GenerationStatus.running] } },
    });
    if (inflight >= MAX_INFLIGHT_PER_USER) {
      throw new GenerationInflightLimitError(inflight, MAX_INFLIGHT_PER_USER);
    }

    let createdSession = false;
    let session = input.sessionId
      ? await tx.session.findFirst({
        where: { id: input.sessionId, userId: input.userId, tenantId: input.tenantId },
      })
      : null;
    if (input.sessionId && !session) throw new GenerationNotFoundError();
    // 兼容上线前的存量 Session：第一次继续对话时惰性补主线 id，避免 trace/后续新会谈血缘为空。
    if (session && !session.lineageId) {
      session = await tx.session.update({ where: { id: session.id }, data: { lineageId: `lineage-${randomUUID()}` } });
    }
    if (!session) {
      // sessionId 为空代表用户明确开启一场新会谈（或首次对话）。沿用主线血缘并从现成检查点写交接包，
      // 不复制旧消息、不临时全量总结；首次对话没有 predecessor，自然不建交接包。
      const previous = await tx.session.findFirst({
        where: {
          tenantId: input.tenantId,
          userId: input.userId,
          agentKey: input.agentKey,
          projectId: input.projectId ?? null,
        },
        orderBy: { updatedAt: 'desc' },
      });
      const lineageId = previous?.lineageId ?? `lineage-${randomUUID()}`;
      if (previous && !previous.lineageId) {
        await tx.session.update({ where: { id: previous.id }, data: { lineageId } });
      }
      session = await tx.session.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          agentKey: input.agentKey,
          projectId: input.projectId ?? null,
          title: input.text.slice(0, 18) || '新对话',
          lineageId,
          ...(previous ? { continuationOf: previous.id } : {}),
        },
      });
      if (previous) {
        await createSessionHandoffInTransaction({
          tx,
          tenantId: input.tenantId,
          userId: input.userId,
          sourceSessionId: previous.id,
          targetSessionId: session.id,
        });
      }
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

    // 章节是服务端根据真实消息时间冻结的可观测事实，不能信客户端传值。它不驱动 Session
    // 切换，也不创建假消息；前端仍按消息时间自行渲染，二者可在 trace 中互相核对。
    const previousMessage = await tx.message.findFirst({
      where: { sessionId: session.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true },
    });
    const messageCreatedAt = now();
    const chapterGapHours = previousMessage
      ? Math.max(0, (messageCreatedAt.getTime() - previousMessage.createdAt.getTime()) / 3_600_000)
      : null;
    const frozenSnapshot = {
      ...snapshot,
      newChapter: chapterGapHours != null && chapterGapHours > 24,
      chapterGapHours,
    };
    const userMessage = await tx.message.create({
      data: {
        sessionId: session.id,
        role: 'user',
        contentJson: { text: input.text },
        refsJson: input.refs?.length ? input.refs as unknown as Prisma.InputJsonValue : undefined,
        createdAt: messageCreatedAt,
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
        requestedOutput: input.requestedOutput ?? 'unspecified',
        deliveryMode: input.deliveryMode ?? 'single',
        classificationStatus: input.classificationRequired
          ? GenerationClassificationStatus.pending
          : GenerationClassificationStatus.not_required,
        complexityJson: input.complexity ? input.complexity as unknown as Prisma.InputJsonValue : undefined,
        deliveryPlanId: input.deliveryPlanId ?? null,
        stageKey: input.stageKey ?? null,
        stageNumber: Math.max(1, input.stageNumber ?? 1),
        stageAttempt: Math.max(1, input.stageAttempt ?? 1),
        deliveryStagesJson: input.deliveryStages?.length
          ? input.deliveryStages as unknown as Prisma.InputJsonValue
          : undefined,
        imageCount: Math.max(0, input.imageCount ?? 0),
        imageBatchCount: Math.max(0, input.imageBatchCount ?? 0),
        // 只落列、**不进 requestSnapshot/requestFingerprint**：priority 是服务端从套餐派生的调度参数，
        // 不属于用户请求内容。若进了指纹，用户在网络重试之间恰好升/降档就会撞
        // GENERATION_IDEMPOTENCY_MISMATCH——把一次运营侧的权益变更变成一条发不出去的消息。
        priority: Number.isFinite(input.priority) ? Math.max(0, Math.min(MAX_PRIORITY, Math.trunc(input.priority!))) : 0,
        userMessageId: userMessage.id,
        requestJson: frozenSnapshot as Prisma.InputJsonValue,
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
  const complexity = job.complexityJson && typeof job.complexityJson === 'object'
    ? job.complexityJson as unknown as ComplexityAssessment
    : null;
  const stages = Array.isArray(job.deliveryStagesJson)
    ? job.deliveryStagesJson as unknown as DeliveryStage[]
    : [];
  const currentIndex = stages.findIndex((stage) => stage.key === job.stageKey);
  const delivery: StagedDeliveryView | null = job.deliveryMode === 'staged' && job.deliveryPlanId && job.stageKey && stages.length
    ? {
      generationId: job.id,
      deliveryPlanId: job.deliveryPlanId,
      currentStageKey: job.stageKey,
      currentStageNumber: job.stageNumber,
      totalStages: stages.length,
      stages,
      nextStage: currentIndex >= 0 ? stages[currentIndex + 1] ?? null : null,
      usageNotice: '继续深化会新建一轮交付，并继续消耗本方案用量。',
    }
    : null;
  return {
    id: job.id,
    sessionId: job.sessionId,
    status: job.status,
    phase: job.phase,
    kind: job.kind,
    requestedOutput: (['chat', 'report', 'unspecified'].includes(job.requestedOutput)
      ? job.requestedOutput
      : 'unspecified') as RequestedOutput,
    deliveryMode: job.deliveryMode as DeliveryMode,
    complexity,
    delivery,
    snapshotVersion: job.snapshotVersion,
    cancelRequested: !!job.cancelRequestedAt,
    resultMessageId: job.resultMessageId,
    imageProgress: job.imageCount > 0 ? {
      totalImages: job.imageCount,
      totalBatches: job.imageBatchCount,
      completedBatches: job.imageCompletedBatches,
      skippedImageIndexes: Array.isArray(job.imageSkippedIndexesJson)
        ? job.imageSkippedIndexesJson.filter((value): value is number => Number.isInteger(value))
        : [],
      phase: TERMINAL.has(job.status)
        ? 'done'
        : job.imageCompletedBatches < job.imageBatchCount ? 'reading' : 'synthesizing',
    } : null,
  };
}

export function generationView(job: GenerationJob): GenerationView {
  const reply = job.replyJson && typeof job.replyJson === 'object' ? job.replyJson as unknown : null;
  const frozen = job.contextJson && typeof job.contextJson === 'object'
    ? job.contextJson as { knowledgeUsed?: unknown; refNotices?: unknown }
    : null;
  const skipped = Array.isArray(job.imageSkippedIndexesJson)
    ? job.imageSkippedIndexesJson.filter((value): value is number => Number.isInteger(value))
    : [];
  const refNotices = [
    ...(Array.isArray(frozen?.refNotices) ? frozen.refNotices.filter((value): value is string => typeof value === 'string') : []),
    ...(skipped.length ? [`${skipped.map((index) => `图 ${index}`).join('、')}未成功读取，其余图片已继续分析。`] : []),
  ];
  return {
    ...generationSummary(job),
    partialText: job.partialText,
    ...(job.thoughtSummary ? { thoughtSummary: job.thoughtSummary } : {}),
    ...(job.kind === GenerationKind.chat && reply ? { reply: reply as ChatReply } : {}),
    ...(job.kind === GenerationKind.report && reply ? { deliverable: reply as Deliverable } : {}),
    usage: usageObject(job.usageJson),
    usageSource: job.usageSource as GenerationView['usageSource'],
    terminationReason: job.terminationReason,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    ...(refNotices.length ? { refNotices: Array.from(new Set(refNotices)) } : {}),
    ...(Array.isArray(frozen?.knowledgeUsed) ? { knowledgeUsed: frozen.knowledgeUsed.filter((value): value is string => typeof value === 'string') } : {}),
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

/**
 * 领单：**带老化的优先级**调度（虚拟到达时间，见 schedulingKeySql），不是纯 FIFO。
 * - priority 是入队时按套餐 tierRank 拍下的快照（0-9），付费档天然排在免费档前面；
 *   档位映射归运营后台（Plan.tierRank），代码里不写死任何档位表。
 * - 防饥饿：每级优先级只等于提前 GENERATION_PRIORITY_AGING_SECONDS（默认 30s）到达，
 *   封顶 9 级 → 一单最多被后到的高优先级单插队 4.5 分钟，之后先来后到照旧。
 *   设 0 = 严格优先级（无老化），只在需要临时让高档位绝对优先时用，会牺牲低档位的最坏等待。
 * - 租约过期的恢复单不需要特殊照顾：它们 createdAt 早，虚拟到达时间自然靠前。
 */
export async function claimNextGenerationJob(
  workerId: string,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<GenerationJob | null> {
  return prisma.$transaction(async (tx) => {
    const at = now();
    // 租约过期判断必须用**库端 UTC**（now() AT TIME ZONE 'UTC'），不能传 JS Date 参数：
    // Prisma 类型化写入把 leaseExpiresAt 存成 UTC naive，而 raw SQL 的 Date 参数会被按
    // **会话时区**落成本地 naive——生产库时区是 Asia/Shanghai，参数比列值快整整 8 小时，
    // 于是任何 8 小时内到期的租约在这个比较里**永远算已过期**、任何在跑的 job 永远可被接管。
    // 2026-08-19 单个 job 被接管 644,208 次的事故，土壤就是这行原来的 `< ${'${at}'}`（生产实测
    // 偏移 +480 分钟）。库端 now() AT TIME ZONE 'UTC' 与列同为 UTC naive，在任何时区的库上都对。
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "j".id FROM generation_job "j"
      WHERE (status = 'queued' AND "classificationStatus" IN ('not_required', 'completed', 'failed'))
         OR (status = 'running' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < (now() AT TIME ZONE 'UTC')))
      ORDER BY ${schedulingKeySql('j', priorityAgingSeconds())} ASC, "j"."createdAt" ASC, "j".id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`);
    const id = rows[0]?.id;
    if (!id) return null;
    const current = await tx.generationJob.findUniqueOrThrow({ where: { id } });

    // 接管抖动熔断：接管次数超上限的 job 直接判失败，不再接管。
    // 放在 findUniqueOrThrow 之后、接管之前——必须在**提升 leaseVersion 之前**拦住，
    // 否则每熔断一次自己又加一次，永远追不上上限。
    if (current.status === GenerationStatus.running && current.leaseVersion >= MAX_LEASE_TAKEOVERS) {
      await tx.generationAttempt.updateMany({
        where: { jobId: current.id, status: 'running' },
        data: { status: 'failed', terminationReason: 'lease_thrashing', completedAt: at },
      });
      await tx.generationJob.update({
        where: { id },
        data: {
          status: GenerationStatus.failed,
          phase: GenerationPhase.finalize,
          leaseOwner: null,
          leaseExpiresAt: null,
          terminationReason: 'lease_thrashing',
          completedAt: at,
        },
      });
      noteLeaseThrashing(current.agentKey);
      fireThrashingAlert(current.id, current.agentKey, current.leaseVersion);
      console.error(`[generation] job ${current.id} 接管 ${current.leaseVersion} 次触发熔断，已判失败`);
      return null; // 本拍不取单；下一拍会去拿别的
    }

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
        // 接管过的单额外加退避，越抖越慢（普通首次领取 leaseVersion=0，退避为 0，行为不变）。
        leaseExpiresAt: new Date(at.getTime() + leaseMs + takeoverBackoffMs(current.leaseVersion)),
        heartbeatAt: at,
        startedAt: current.startedAt ?? at,
      },
    });
  });
}

/**
 * 本单前面还有几单在排队（用户可见的「前面还有 N 位」）。
 * 排序表达式与 claimNextGenerationJob 的 ORDER BY 共用 schedulingKeySql —— **改一处必须改另一处**，
 * 否则透出的位次和 worker 的真实取单顺序会背离。key 在 SQL 里现算（不在 JS 里复算），
 * 避免两边取整/时钟差异造成 off-by-one。
 * 口径刻意比 claim 的候选集宽/窄各一点，是「位次」不是「取单资格」：
 * - 分类未完成的 queued 单仍计入——它下一拍就可领，对用户而言确实排在前面；
 * - running 单（含租约过期待接管的）不计入——已经在跑/马上恢复跑，不占用户前方的等待位。
 *   代价是 ahead=0 不严格等于「下一个就是你」，文案用「前面还有 N 位」而不是「即将开始」。
 */
export async function countQueuedAhead(job: GenerationJob): Promise<number> {
  const agingSec = priorityAgingSeconds();
  const rows = await prisma.$queryRaw<{ ahead: number }[]>(Prisma.sql`
    WITH "me" AS (
      SELECT ${schedulingKeySql('me', agingSec)} AS "key", "me"."createdAt" AS "createdAt", "me".id AS id
      FROM generation_job "me" WHERE "me".id = ${job.id}
    )
    SELECT COUNT(*)::int AS ahead
    FROM generation_job "q", "me"
    WHERE "q".status = 'queued'
      AND (${schedulingKeySql('q', agingSec)}, "q"."createdAt", "q".id)
        < ("me"."key", "me"."createdAt", "me".id)`);
  return Math.max(0, rows[0]?.ahead ?? 0);
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
  kind: 'main' | 'continue' | 'fallback' | 'ask_recovery' | `image_observation:${number}`,
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
  result?: unknown;
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
      resultJson: args.result == null ? undefined : args.result as Prisma.InputJsonValue,
      completedAt: now(),
    },
  });
  if (changed.count !== 1) throw new GenerationLeaseLostError();
}

export async function saveImageObservationProgress(args: {
  jobId: string;
  workerId: string;
  leaseVersion: number;
  observations: ImageObservationView[];
  skippedImageIndexes: number[];
  imageBatchCount: number;
  imageTotalBytes: number;
}): Promise<void> {
  const changed = await prisma.generationJob.updateMany({
    where: {
      id: args.jobId,
      status: GenerationStatus.running,
      leaseOwner: args.workerId,
      leaseVersion: args.leaseVersion,
    },
    data: {
      imageObservationsJson: args.observations as unknown as Prisma.InputJsonValue,
      imageSkippedIndexesJson: args.skippedImageIndexes as unknown as Prisma.InputJsonValue,
      imageBatchCount: args.imageBatchCount,
      imageCompletedBatches: args.observations.length,
      imageTotalBytes: args.imageTotalBytes,
      snapshotVersion: { increment: 1 },
      heartbeatAt: now(),
    },
  });
  if (changed.count !== 1) throw new GenerationLeaseLostError();
}

export async function writeGenerationSnapshot(args: {
  jobId: string;
  workerId: string;
  leaseVersion: number;
  text: string;
  thoughtSummary?: string;
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
        ...(args.thoughtSummary !== undefined ? { thoughtSummary: args.thoughtSummary } : {}),
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
        thoughtSummary: args.kind === 'chat' ? ((args.content as ChatReply).thoughtSummary ?? '') : '',
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
      const reply: ChatReply = {
        text: job.partialText,
        ...(job.thoughtSummary ? { thoughtSummary: job.thoughtSummary } : {}),
        truncated: status !== GenerationStatus.completed,
      };
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
