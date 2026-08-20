import { randomUUID } from 'node:crypto';
import { GenerationKind, Prisma, type GenerationJob } from '@prisma/client';
import type { ChatReply, Deliverable, GenContext, Usage } from '../llm/schema.js';
import { chatCompleteStream, generateDeliverable, hasLiveProvider, recoverChatAsks, shouldRecoverChatAsks } from '../llm/gateway.js';
import { prisma } from '../db.js';
import { isAiTestMode } from '../env.js';
import { resolveEffectiveAgent } from './agentVersions.js';
import { buildGenContext, isBriefInterviewRequest, resolveAgentRuntime } from './context.js';
import { resolveMode } from './intent.js';
import { bumpDiagRound } from './strategicProfile.js';
import { recordReview } from './reviewLog.js';
import { learnFromConversation } from './memory.js';
import { extractAndRecordProphecies } from './prophecyLog.js';
import { notifyReportReady } from './wechatSubscribe.js';
import { updateSessionDigest } from './sessionDigest.js';
import { maybeGenerateTitle } from './sessionTitle.js';
import { cardSection } from './deliverableSection.js';
import {
  claimNextGenerationJob,
  enqueueGenerationEffects,
  finalizeGeneration,
  finishGenerationAttempt,
  freezeGenerationContext,
  generationSummary,
  GenerationLeaseLostError,
  heartbeatGenerationLease,
  persistGenerationResult,
  registerGenerationController,
  runGenerationEffect,
  startGenerationAttempt,
  writeGenerationSnapshot,
} from './generationJobs.js';
import { classifyNextPendingGeneration, stageInstruction } from './deliveryComplexity.js';
import { captureAssistantFactCandidates, captureDirectUserFacts, pendingDocumentFactCard } from './userFacts.js';
import { applyPreparedImages, prepareImageObservations } from './imageObservation.js';
import {
  deliverableRecentLimit,
  loadConversationHistory,
  loadTurnDigest,
} from '../routes/sessions.js';

const WORKER_POLL_MS = 300;
// 单进程同时在跑的生成任务上限（GENERATION_WORKER_CONCURRENCY 留空时生效）。
// 选 4 的依据：llmGate 主车道 8 槽，而**同一个 job 内还会二次外呼**（多图观察分批、推荐项补生成、
// 分阶段续写），只算主生成就把 8 槽占满，那些二次外呼就得去闸门里排队等自己的兄弟让位。
const DEFAULT_WORKER_CONCURRENCY = 4;
const HEARTBEAT_MS = 5_000;
/** 连续多少次心跳失败才判定租约丢失。见 processJob 里的说明。 */
const HEARTBEAT_FAIL_TOLERANCE = 3;
const SNAPSHOT_MS = 400;
const SNAPSHOT_CHARS = 192;
const THOUGHT_SNAPSHOT_MS = 200;
const THOUGHT_SNAPSHOT_CHARS = 48;
const CHAT_JOB_MAX_RUNTIME_MS = 300_000;
const ASK_RECOVERY_BUDGET_MS = 3_000;
const EFFECT_STALE_MS = 5 * 60_000;
const EFFECT_RETRY_MS = 30_000;
const EFFECT_MAX_ATTEMPTS = 5;

type RequestData = {
  text: string;
  projectId?: string | null;
  refs?: unknown[];
  billingRatio?: number;
  effectiveVersionId?: string | null;
  newChapter?: boolean;
  chapterGapHours?: number | null;
};

type FrozenContext = {
  ctx: GenContext;
  memoryConfig: unknown;
  knowledgeUsed: string[];
  refNotices: string[];
};

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
/** 生产 pump 路径当前在途的任务数。串行的 tickGenerationWorker 不计入（见 pump 上方注释）。 */
let inFlight = 0;
/** pump 重入保护：同一时刻只允许一轮 pump 在领单。 */
let pumping = false;
/** pump 期间又被唤醒（有槽位归还/新单入队）：本轮结束后立刻再跑一轮，别把唤醒丢掉。 */
let pumpAgain = false;
/**
 * stopGenerationWorker 之后必须为 true。只清 interval 不够：每单收尾的 .finally 还会再 pump，
 * 在途单一收口就继续领新单——「停止领新单」的承诺恰好在停机时失效。
 */
let stopped = false;
const workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;

function requestOf(job: GenerationJob): RequestData {
  return job.requestJson && typeof job.requestJson === 'object'
    ? job.requestJson as unknown as RequestData
    : { text: '' };
}

function withoutRuntimeSecrets(ctx: GenContext): GenContext {
  const { images: _images, ...withoutImages } = ctx;
  if (!ctx.runtime) return withoutImages;
  const { apiKey: _apiKey, difyApiKey: _difyApiKey, ...runtime } = ctx.runtime;
  return { ...withoutImages, runtime };
}

async function loadOrBuildContext(job: GenerationJob): Promise<FrozenContext> {
  const frozen = job.contextJson && typeof job.contextJson === 'object'
    ? job.contextJson as unknown as FrozenContext
    : null;
  const request = requestOf(job);
  const effective = await resolveEffectiveAgent(
    job.agentKey,
    request.effectiveVersionId ? { versionId: request.effectiveVersionId } : undefined,
  );
  if (!effective) throw Object.assign(new Error(`未知智能体：${job.agentKey}`), { code: 'AGENT_NOT_FOUND' });

  if (frozen?.ctx) {
    return {
      ...frozen,
      ctx: {
        ...frozen.ctx,
        runtime: resolveAgentRuntime(effective, {
          userId: job.userId,
          sessionId: job.sessionId,
          difyConversationId: (await prisma.session.findUnique({ where: { id: job.sessionId }, select: { difyConversationId: true } }))?.difyConversationId,
        }),
      },
    };
  }

  const session = await prisma.session.findUniqueOrThrow({ where: { id: job.sessionId } });
  // 用户亲口陈述在进入模型前即落 asserted；同 key 更正走替代链，“这条别记”也在这里处理。
  // 幂等重试只会强化同一条，不会重复造事实。
  await captureDirectUserFacts({
    tenantId: job.tenantId,
    userId: job.userId,
    sessionId: job.sessionId,
    userMessageId: job.userMessageId,
    text: request.text,
  });
  const { intent, persist } = resolveMode(request.text, session.mode);
  if (persist !== undefined) await prisma.session.update({ where: { id: session.id }, data: { mode: persist } });
  if (intent.mode === 'review' && intent.reviewLayer) {
    await recordReview({ tenantId: job.tenantId, userId: job.userId, layer: intent.reviewLayer });
  }
  if (job.agentKey === 'general' && intent.mode === 'strategy' && !isBriefInterviewRequest(request.text)) {
    await bumpDiagRound({ tenantId: job.tenantId, userId: job.userId, sessionId: job.sessionId });
  }

  const previousMessages = await prisma.message.count({
    where: { sessionId: job.sessionId, id: { not: job.userMessageId } },
  });
  // 路由在建单时已冻结；Worker 不再用另一套规则重算，避免排队前后 chat/report 漂移。
  const willDeliver = job.kind === GenerationKind.report;
  const digest = await loadTurnDigest({
    tenantId: job.tenantId,
    userId: job.userId,
    sessionId: job.sessionId,
    isNewSession: previousMessages === 0,
    willDeliver,
  });
  const conversation = await loadConversationHistory(
    job.sessionId,
    job.userMessageId,
    request.text,
    deliverableRecentLimit(willDeliver, digest),
  );
  const built = await buildGenContext({
    userId: job.userId,
    tenantId: job.tenantId,
    agentKey: job.agentKey,
    userMessage: request.text,
    projectId: request.projectId ?? null,
    refs: request.refs as Parameters<typeof buildGenContext>[0]['refs'],
    sessionId: job.sessionId,
    difyConversationId: session.difyConversationId,
    effective,
    history: conversation.history,
    historyTrace: conversation.trace,
    sessionMode: persist !== undefined ? persist : session.mode,
    digestItems: digest?.items ?? null,
    digestTrace: digest ?? null,
    deferImages: true,
  });
  const routing = generationSummary(job);
  const currentStage = routing.delivery?.stages.find((stage) => stage.key === routing.delivery?.currentStageKey);
  if (routing.delivery && currentStage) built.ctx.deliveryLine = stageInstruction(currentStage, routing.delivery.stages);
  built.ctx.contextTrace = {
    ...(built.ctx.contextTrace ?? { recallIntent: false, history: { recentMessages: 0, carryoverMessages: 0, totalChars: 0 }, memories: [] }),
    continuity: {
      sessionId: session.id,
      lineageId: session.lineageId,
      continuationOf: session.continuationOf,
      sourceSessionId: session.continuationOf,
      newChapter: request.newChapter === true,
      chapterGapHours: typeof request.chapterGapHours === 'number' ? request.chapterGapHours : null,
      inheritedChars: (built.ctx.factsLine?.length ?? 0) + (built.ctx.handoffLine?.length ?? 0),
    },
    routing: {
      requestedOutput: routing.requestedOutput,
      deliveryMode: routing.deliveryMode,
      complexityScore: routing.complexity?.score ?? null,
      complexityReasons: routing.complexity?.reasons ?? [],
      deliveryPlanId: routing.delivery?.deliveryPlanId ?? null,
      stageKey: routing.delivery?.currentStageKey ?? null,
      stageNumber: routing.delivery?.currentStageNumber ?? 1,
    },
  };
  const snapshot: FrozenContext = {
    ctx: withoutRuntimeSecrets(built.ctx),
    memoryConfig: built.memoryConfig,
    knowledgeUsed: built.knowledgeUsed,
    refNotices: built.refNotices,
  };
  await freezeGenerationContext({
    jobId: job.id,
    workerId,
    leaseVersion: job.leaseVersion,
    context: snapshot as unknown as Prisma.InputJsonValue,
  });
  return { ...snapshot, ctx: built.ctx };
}

function localEstimate(ctx: GenContext, text: string): Usage {
  const safe = withoutRuntimeSecrets({ ...ctx, images: undefined });
  const inputChars = JSON.stringify(safe).length;
  const inputTokens = Math.max(1, Math.ceil(inputChars / 2));
  const outputTokens = Math.max(0, Math.ceil(text.length / 2));
  return { inputTokens, outputTokens, cachedInput: 0, billableTokens: inputTokens + outputTokens };
}

function conservativeUsage(
  provider: Usage | null,
  ctx: GenContext,
  text: string,
  providerInvoked: boolean,
): { usage: Usage; source: 'provider' | 'estimated' | 'mixed' } {
  // 纯 mock/本地模板没有上游成本，不因“生成了文字”虚扣额度。
  // 真实 provider 一旦发起，即使失败/取消/未回 usage，也按保守估算结算。
  if (!providerInvoked) {
    return {
      usage: { inputTokens: 0, outputTokens: 0, cachedInput: 0, billableTokens: 0 },
      source: 'provider',
    };
  }
  const estimated = localEstimate(ctx, text);
  if (!provider) return { usage: estimated, source: 'estimated' };
  const usage: Usage = {
    inputTokens: Math.max(provider.inputTokens, estimated.inputTokens),
    outputTokens: Math.max(provider.outputTokens, estimated.outputTokens),
    cachedInput: Math.max(0, provider.cachedInput ?? 0),
    cacheWrite: Math.max(0, provider.cacheWrite ?? 0),
    billableTokens: Math.max(provider.billableTokens ?? provider.inputTokens + provider.outputTokens, estimated.billableTokens ?? 0),
  };
  const exact = usage.inputTokens === provider.inputTokens
    && usage.outputTokens === provider.outputTokens
    && usage.billableTokens === (provider.billableTokens ?? provider.inputTokens + provider.outputTokens);
  return { usage, source: exact ? 'provider' : 'mixed' };
}

function askRecoveryEstimate(reply: ChatReply, recovered: ChatReply): Usage {
  const inputTokens = Math.max(1, Math.ceil(reply.text.slice(-1200).length / 2) + 220);
  const output = JSON.stringify(recovered.asks ?? []);
  const outputTokens = Math.max(1, Math.ceil(output.length / 2));
  return { inputTokens, outputTokens, cachedInput: 0, billableTokens: inputTokens + outputTokens };
}

async function recoverRecommendedOptions(
  job: GenerationJob,
  leaseVersion: number,
  reply: ChatReply,
  ctx: GenContext,
): Promise<ChatReply> {
  if (!shouldRecoverChatAsks(reply)) return reply;
  const live = await hasLiveProvider();
  const attemptNo = await startGenerationAttempt(job.id, workerId, leaseVersion, 'ask_recovery');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('ask_recovery_timeout')), ASK_RECOVERY_BUDGET_MS);
  let recovered = reply;
  try {
    recovered = await recoverChatAsks(reply, ctrl.signal, {
      ctx,
      meta: { tenantId: job.tenantId, userId: job.userId, sessionId: job.sessionId, agentKey: job.agentKey },
    });
    const timedOut = ctrl.signal.aborted;
    await finishGenerationAttempt({
      jobId: job.id,
      attemptNo,
      leaseVersion,
      status: timedOut ? 'failed' : 'completed',
      usage: live ? askRecoveryEstimate(reply, recovered) : { inputTokens: 0, outputTokens: 0, cachedInput: 0, billableTokens: 0 },
      usageSource: live ? 'estimated' : 'provider',
      terminationReason: timedOut ? 'ask_recovery_timeout' : recovered.asks?.length ? 'ask_recovered' : 'ask_missing',
    });
    return recovered;
  } catch (error) {
    await finishGenerationAttempt({
      jobId: job.id,
      attemptNo,
      leaseVersion,
      status: 'failed',
      usage: live ? askRecoveryEstimate(reply, recovered) : { inputTokens: 0, outputTokens: 0, cachedInput: 0, billableTokens: 0 },
      usageSource: live ? 'estimated' : 'provider',
      terminationReason: ctrl.signal.aborted ? 'ask_recovery_timeout' : 'ask_recovery_failed',
    }).catch(() => {});
    return reply;
  } finally {
    clearTimeout(timer);
  }
}

function reportText(deliverable: Deliverable): string {
  return `${deliverable.title}\n${deliverable.sections.map(cardSection).map((s) => `${s.h}\n${s.b ?? ''}\n${(s.list ?? []).join('\n')}`).join('\n')}`;
}

async function attachFactConfirmation<T extends ChatReply | Deliverable>(
  job: GenerationJob,
  content: T,
  assistantMessageId: string,
): Promise<T> {
  const [documentCard, assistantCard] = await Promise.all([
    pendingDocumentFactCard(job.userId).catch(() => null),
    captureAssistantFactCandidates({
      tenantId: job.tenantId,
      userId: job.userId,
      sessionId: job.sessionId,
      userMessageId: job.userMessageId,
      assistantMessageId,
      assistantText: job.kind === GenerationKind.report ? reportText(content as Deliverable) : (content as ChatReply).text,
    }).catch(() => null),
  ]);
  const items = [...(assistantCard?.items ?? []), ...(documentCard?.items ?? [])]
    .filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index)
    .slice(0, 3);
  if (!items.length) return { ...content, factConfirmation: undefined };
  const title = assistantCard && documentCard
    ? '这几条来自我的推断或资料识别，请你核一下'
    : assistantCard?.title ?? documentCard!.title;
  return { ...content, factConfirmation: { title, items } };
}

async function runPostEffects(job: GenerationJob, frozen: FrozenContext, content: ChatReply | Deliverable): Promise<void> {
  const request = requestOf(job);
  const isReport = job.kind === GenerationKind.report;
  const effectKeys = ['title', 'memory', 'digest', ...(job.agentKey === 'general' ? ['prophecy'] : []), ...(isReport ? ['notification'] : [])];
  await enqueueGenerationEffects(job.id, effectKeys);
  const effects: Record<string, () => Promise<void>> = {
    // 标题只在首轮生效，且要读到已落库的首条回复——所以挂在 post-effect（结果已终态落库）而不是建单处。
    title: async () => { await maybeGenerateTitle(job.sessionId); },
    memory: async () => {
      await learnFromConversation({
        tenantId: job.tenantId,
        userId: job.userId,
        agentKey: job.agentKey,
        cfg: frozen.memoryConfig as Parameters<typeof learnFromConversation>[0]['cfg'],
        userText: request.text,
        projectId: request.projectId ?? null,
        assistantText: isReport ? reportText(content as Deliverable) : (content as ChatReply).text,
      });
    },
    digest: async () => {
      await updateSessionDigest({ tenantId: job.tenantId, userId: job.userId, sessionId: job.sessionId, maxBatches: 5 });
    },
    prophecy: async () => {
      const text = isReport ? reportText(content as Deliverable) : (content as ChatReply).text;
      if (!isReport && (content as ChatReply).truncated) return;
      await extractAndRecordProphecies({ tenantId: job.tenantId, userId: job.userId, text });
    },
    notification: async () => {
      const result = await notifyReportReady({ tenantId: job.tenantId, userId: job.userId, title: (content as Deliverable).title || '报告已生成' });
      // 未配置模板/未授权不是可重试故障；微信或网络明确失败时让 outbox 稍后补偿。
      if (!result.sent && result.retryable) {
        throw new Error(result.reason || 'report notification failed');
      }
    },
  };
  await Promise.allSettled(effectKeys.map((key) => runGenerationEffect(job.id, key, effects[key])));
}

function postEffectKeys(job: GenerationJob): string[] {
  return ['title', 'memory', 'digest', ...(job.agentKey === 'general' ? ['prophecy'] : []), ...(job.kind === GenerationKind.report ? ['notification'] : [])];
}

/**
 * 主结果已经落库后若进程在推荐项补生成/终态事务前退出，接管者只恢复 finalize。
 * 绝不能重新跑主 provider：正文已经是权威结果，重跑既会重复花费，也可能把用户已经看到的答案改掉。
 */
async function resumePersistedFinalize(
  job: GenerationJob,
  frozen: FrozenContext,
  leaseVersion: number,
): Promise<boolean> {
  if (job.phase !== 'finalize' || !job.resultMessageId || !job.replyJson || typeof job.replyJson !== 'object') {
    return false;
  }
  if (job.kind === GenerationKind.report) {
    let deliverable = job.replyJson as unknown as Deliverable;
    const withFact = await attachFactConfirmation(job, deliverable, job.resultMessageId);
    if (withFact !== deliverable) {
      deliverable = withFact;
      await persistGenerationResult({
        jobId: job.id, workerId, leaseVersion, role: 'report', content: deliverable,
        partialText: reportText(deliverable), kind: 'report',
      });
    }
    await finalizeGeneration({
      jobId: job.id,
      workerId,
      leaseVersion,
      status: 'completed',
      terminationReason: job.terminationReason,
      effectKeys: postEffectKeys(job),
    });
    void runPostEffects(job, frozen, deliverable);
    return true;
  }

  let reply = job.replyJson as unknown as ChatReply;
  const withFact = await attachFactConfirmation(job, reply, job.resultMessageId);
  if (withFact !== reply) {
    reply = withFact;
    await persistGenerationResult({
      jobId: job.id, workerId, leaseVersion, role: 'assistant', content: reply,
      partialText: reply.text, kind: 'chat',
    });
  }
  // finalize 后的 cancel 不撤销已交付正文；只是不再启动可选的推荐项补生成。
  if (!job.cancelRequestedAt && !reply.truncated) {
    const recovered = await recoverRecommendedOptions(job, leaseVersion, reply, frozen.ctx);
    if (recovered !== reply) {
      reply = recovered;
      await persistGenerationResult({
        jobId: job.id,
        workerId,
        leaseVersion,
        role: 'assistant',
        content: reply,
        partialText: reply.text,
        kind: 'chat',
      });
    }
  }
  await finalizeGeneration({
    jobId: job.id,
    workerId,
    leaseVersion,
    status: reply.truncated ? 'truncated' : 'completed',
    terminationReason: job.terminationReason ?? (reply.truncated ? 'provider_truncated' : null),
    effectKeys: postEffectKeys(job),
  });
  void runPostEffects(job, frozen, reply);
  return true;
}

/**
 * outbox 补偿：终态 job 的 pending/failed effect 会被后续 tick 继续消费；进程在 effect 执行中退出时，
 * running 超过 5 分钟会回到 failed。投递语义是 at-least-once，目标函数必须按 jobId/effectKey 幂等。
 */
async function tickGenerationEffects(): Promise<boolean> {
  const at = new Date();
  await prisma.generationEffect.updateMany({
    where: { status: 'running', updatedAt: { lt: new Date(at.getTime() - EFFECT_STALE_MS) } },
    data: { status: 'failed', lastError: 'stale effect lease recovered' },
  });
  const effect = await prisma.generationEffect.findFirst({
    where: {
      attempt: { lt: EFFECT_MAX_ATTEMPTS },
      job: { status: { in: ['completed', 'truncated'] } },
      OR: [
        { status: 'pending' },
        { status: 'failed', updatedAt: { lt: new Date(at.getTime() - EFFECT_RETRY_MS) } },
      ],
    },
    orderBy: { updatedAt: 'asc' },
    include: { job: true },
  });
  if (!effect) return false;
  const job = effect.job;
  const frozen = job.contextJson && typeof job.contextJson === 'object'
    ? job.contextJson as unknown as FrozenContext
    : null;
  const content = job.replyJson && typeof job.replyJson === 'object'
    ? job.replyJson as unknown as ChatReply | Deliverable
    : null;
  if (!frozen?.ctx || !content) {
    await runGenerationEffect(job.id, effect.effectKey, async () => {
      throw new Error('generation effect missing frozen context or result');
    }).catch(() => {});
    return true;
  }
  await runPostEffects(job, frozen, content);
  return true;
}

async function processJob(job: GenerationJob): Promise<void> {
  const leaseVersion = job.leaseVersion;
  const controller = new AbortController();
  const unregister = registerGenerationController(job.id, leaseVersion, controller);
  const hardMs = Math.max(30_000, Number(process.env.CHAT_JOB_MAX_RUNTIME_MS ?? CHAT_JOB_MAX_RUNTIME_MS) || CHAT_JOB_MAX_RUNTIME_MS);
  let hardTimedOut = false;
  const hardTimer = setTimeout(() => {
    hardTimedOut = true;
    controller.abort(new Error('job_budget_exceeded'));
  }, hardMs);
  let heartbeatBusy = false;
  // 心跳失败要连续 HEARTBEAT_FAIL_TOLERANCE 次才 abort，不是第一次就砍。
  //
  // 为什么容错：abort 掉的是一个**已经把整份提示词发给上游、已经产生成本**的在途调用，
  // 而心跳失败最常见的原因是数据库一瞬间的抖动（heartbeatBusy 跳一拍就够让 15s 租约到期）。
  // 为了一次抖动扔掉一次真实付费调用是亏的；而且 2026-08-19 的接管抖动正是这样自我强化的——
  // 负载高 → 心跳慢 → 误判租约丢失 → abort 重来 → 负载更高。
  // 租约 15s、心跳 5s，容忍 2 次连续失败后在第 3 次（约 15s）才 abort，与租约到期时刻基本对齐。
  let heartbeatFails = 0;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void (async () => {
      await heartbeatGenerationLease(job.id, workerId, leaseVersion);
      heartbeatFails = 0;
      const state = await prisma.generationJob.findUnique({ where: { id: job.id }, select: { cancelRequestedAt: true } });
      if (state?.cancelRequestedAt) controller.abort(new Error('user_cancelled'));
    })().catch((err) => {
      // 租约确实被别人抢走（版本不匹配）是确定性事实，不适用容错，立刻收手让新 owner 独占。
      if (err instanceof GenerationLeaseLostError) { controller.abort(err); return; }
      heartbeatFails += 1;
      if (heartbeatFails >= HEARTBEAT_FAIL_TOLERANCE) controller.abort(new GenerationLeaseLostError());
    }).finally(() => { heartbeatBusy = false; });
  }, HEARTBEAT_MS);

  let attemptNo: number | null = null;
  let accumulated = job.partialText || '';
  let thoughtSummary = job.thoughtSummary || '';
  let providerUsage: Usage | null = null;
  let providerInvoked = false;
  let frozenContext: FrozenContext | null = null;
  try {
    const latest = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } });
    // 已请求取消且主结果尚未落库：直接按已有 attempt/残文收口，不再为一条已取消任务重建上下文。
    // finalize 例外由下方 resumePersistedFinalize 处理——主正文已经交付，不能撤销或改写。
    if (latest.cancelRequestedAt && latest.phase !== 'finalize') {
      controller.abort(new Error('user_cancelled'));
      await finalizeGeneration({
        jobId: job.id,
        workerId,
        leaseVersion,
        status: 'cancelled',
        terminationReason: 'user_cancelled',
      });
      return;
    }
    if (latest.cancelRequestedAt) controller.abort(new Error('user_cancelled'));
    let frozen = await loadOrBuildContext(latest);
    frozenContext = frozen;
    if (await resumePersistedFinalize(latest, frozen, leaseVersion)) return;
    if (controller.signal.aborted) {
      await finalizeGeneration({ jobId: job.id, workerId, leaseVersion, status: 'cancelled', terminationReason: 'user_cancelled_before_provider' });
      return;
    }

    const request = requestOf(latest);
    if ((request.refs ?? []).some((ref) => ref && typeof ref === 'object' && (ref as { kind?: string }).kind === 'image')) {
      const prepared = await prepareImageObservations({
        job: latest,
        workerId,
        leaseVersion,
        refs: request.refs as Parameters<typeof prepareImageObservations>[0]['refs'],
        userQuestion: request.text,
        signal: controller.signal,
      });
      frozen = {
        ...frozen,
        ctx: applyPreparedImages(frozen.ctx, prepared),
        refNotices: Array.from(new Set([...(frozen.refNotices ?? []), ...prepared.notices])),
      };
      frozenContext = frozen;
    }

    attemptNo = await startGenerationAttempt(job.id, workerId, leaseVersion, 'main');
    if (job.kind === GenerationKind.report) {
      const metered = await generateDeliverable(frozen.ctx, {
        tenantId: job.tenantId,
        userId: job.userId,
        sessionId: job.sessionId,
        agentKey: job.agentKey,
        ratio: Number(requestOf(job).billingRatio) || 1,
        signal: controller.signal,
      });
      providerUsage = metered.usage;
      providerInvoked = metered.providerInvoked;
      const delivery = generationSummary(latest).delivery;
      let result: Deliverable = delivery ? { ...metered.result, delivery } : metered.result;
      accumulated = reportText(result);
      const measured = conservativeUsage(providerUsage, frozen.ctx, accumulated, providerInvoked);
      await finishGenerationAttempt({ jobId: job.id, attemptNo, leaseVersion, status: controller.signal.aborted ? 'cancelled' : 'completed', usage: measured.usage, usageSource: measured.source });
      const resultMessageId = await persistGenerationResult({ jobId: job.id, workerId, leaseVersion, role: 'report', content: result, partialText: accumulated, kind: 'report' });
      const withFact = await attachFactConfirmation(job, result, resultMessageId);
      if (withFact !== result) {
        result = withFact;
        await persistGenerationResult({ jobId: job.id, workerId, leaseVersion, role: 'report', content: result, partialText: accumulated, kind: 'report' });
      }
      const cancelled = (await prisma.generationJob.findUnique({ where: { id: job.id }, select: { cancelRequestedAt: true } }))?.cancelRequestedAt;
      await finalizeGeneration({
        jobId: job.id,
        workerId,
        leaseVersion,
        status: cancelled ? 'cancelled' : hardTimedOut ? 'truncated' : 'completed',
        terminationReason: cancelled ? 'user_cancelled' : hardTimedOut ? 'job_budget_exceeded' : null,
        effectKeys: cancelled ? [] : postEffectKeys(job),
      });
      if (!cancelled) void runPostEffects(job, frozen, result);
      return;
    }

    let reply: ChatReply | null = null;
    let lastSnapshotAt = Date.now();
    let charsSinceSnapshot = 0;
    let lastThoughtSnapshotAt = 0;
    let thoughtCharsSinceSnapshot = 0;
    for await (const event of chatCompleteStream(frozen.ctx, {
      tenantId: job.tenantId,
      userId: job.userId,
      sessionId: job.sessionId,
      agentKey: job.agentKey,
      ratio: Number(requestOf(job).billingRatio) || 1,
      signal: controller.signal,
      skipAskRecovery: true,
      firstTokenStartedAtMs: job.createdAt.getTime(),
    })) {
      if (event.type === 'delta') {
        accumulated += event.text;
        charsSinceSnapshot += event.text.length;
        if (charsSinceSnapshot >= SNAPSHOT_CHARS || Date.now() - lastSnapshotAt >= SNAPSHOT_MS) {
          await writeGenerationSnapshot({ jobId: job.id, workerId, leaseVersion, text: accumulated, thoughtSummary });
          lastSnapshotAt = Date.now();
          charsSinceSnapshot = 0;
        }
      } else if (event.type === 'thought_delta') {
        thoughtSummary += event.text;
        thoughtCharsSinceSnapshot += event.text.length;
        const at = Date.now();
        if (!lastThoughtSnapshotAt || thoughtCharsSinceSnapshot >= THOUGHT_SNAPSHOT_CHARS || at - lastThoughtSnapshotAt >= THOUGHT_SNAPSHOT_MS) {
          await writeGenerationSnapshot({ jobId: job.id, workerId, leaseVersion, text: accumulated, thoughtSummary });
          lastThoughtSnapshotAt = at;
          lastSnapshotAt = at;
          thoughtCharsSinceSnapshot = 0;
        }
      } else if (event.type === 'done') {
        reply = event.result;
        providerUsage = event.usage;
        providerInvoked = event.providerInvoked;
      }
    }
    if (!reply && !accumulated) throw Object.assign(new Error('AI 流式响应为空'), { code: 'AI_EMPTY_RESPONSE' });
    let finalReply: ChatReply = reply ?? {
      text: accumulated,
      ...(thoughtSummary ? { thoughtSummary } : {}),
      truncated: true,
    };
    // provider done 的 text 是去重、清理推荐块后的权威正文；快照最终以它替换，不拼接。
    accumulated = finalReply.text || accumulated;
    const measured = conservativeUsage(providerUsage, frozen.ctx, accumulated, providerInvoked);
    const cancelled = (await prisma.generationJob.findUnique({ where: { id: job.id }, select: { cancelRequestedAt: true } }))?.cancelRequestedAt;
    await finishGenerationAttempt({
      jobId: job.id,
      attemptNo,
      leaseVersion,
      status: cancelled ? 'cancelled' : 'completed',
      usage: measured.usage,
      usageSource: measured.source,
      terminationReason: cancelled ? 'user_cancelled' : hardTimedOut ? 'job_budget_exceeded' : null,
    });
    const resultMessageId = await persistGenerationResult({ jobId: job.id, workerId, leaseVersion, role: 'assistant', content: finalReply, partialText: accumulated, kind: 'chat' });
    finalReply = await attachFactConfirmation(job, finalReply, resultMessageId);
    if (finalReply.factConfirmation?.items?.length) {
      await persistGenerationResult({ jobId: job.id, workerId, leaseVersion, role: 'assistant', content: finalReply, partialText: accumulated, kind: 'chat' });
    }
    // 主正文先落库，再给推荐选项最多 3s 的独立 attempt。失败/超时只少选项，不回滚正文。
    if (!cancelled && !hardTimedOut && !finalReply.truncated) {
      const recovered = await recoverRecommendedOptions(job, leaseVersion, finalReply, frozen.ctx);
      if (recovered !== finalReply) {
        finalReply = recovered;
        await persistGenerationResult({ jobId: job.id, workerId, leaseVersion, role: 'assistant', content: finalReply, partialText: accumulated, kind: 'chat' });
      }
    }
    const status = cancelled ? 'cancelled' : (hardTimedOut || finalReply.truncated) ? 'truncated' : 'completed';
    await finalizeGeneration({
      jobId: job.id,
      workerId,
      leaseVersion,
      status,
      terminationReason: cancelled ? 'user_cancelled' : hardTimedOut ? 'job_budget_exceeded' : finalReply.truncated ? 'provider_truncated' : null,
      effectKeys: cancelled ? [] : postEffectKeys(job),
    });
    if (!cancelled) void runPostEffects(job, frozen, finalReply);
  } catch (error) {
    if (error instanceof GenerationLeaseLostError) return;
    const frozen = frozenContext ?? (job.contextJson && typeof job.contextJson === 'object'
      ? job.contextJson as unknown as FrozenContext
      : null);
    const details = error as Error & { code?: string; providerInvoked?: boolean; generationUsage?: Usage };
    const code = details.code;
    const cancelled = (await prisma.generationJob.findUnique({ where: { id: job.id }, select: { cancelRequestedAt: true } }))?.cancelRequestedAt;
    if (attemptNo != null) {
      // 输入审核在 provider 前拦截，没有消耗；输出审核在 provider 后，
      // gateway 附带 providerInvoked + usage，仍必须结算。其余 provider 失败/取消也保守估算。
      const shouldCharge = code === 'MODERATION_BLOCK'
        ? !!details.providerInvoked
        : !!details.providerInvoked || providerInvoked;
      if (details.generationUsage) providerUsage = details.generationUsage;
      const usage = shouldCharge && frozen?.ctx
        ? conservativeUsage(providerUsage, frozen.ctx, accumulated, true)
        : { usage: { inputTokens: 0, outputTokens: 0, cachedInput: 0, billableTokens: 0 }, source: 'provider' as const };
      await finishGenerationAttempt({
        jobId: job.id,
        attemptNo,
        leaseVersion,
        status: cancelled ? 'cancelled' : 'failed',
        usage: usage.usage,
        usageSource: usage.source,
        terminationReason: cancelled ? 'user_cancelled' : hardTimedOut ? 'job_budget_exceeded' : code ?? 'provider_error',
      }).catch(() => {});
    }
    if (accumulated) {
      await writeGenerationSnapshot({ jobId: job.id, workerId, leaseVersion, text: accumulated, thoughtSummary }).catch(() => {});
    }
    await finalizeGeneration({
      jobId: job.id,
      workerId,
      leaseVersion,
      status: cancelled ? 'cancelled' : accumulated ? 'truncated' : 'failed',
      terminationReason: cancelled ? 'user_cancelled' : hardTimedOut ? 'job_budget_exceeded' : code ?? 'provider_error',
    }).catch((finalizeError) => {
      if (!(finalizeError instanceof GenerationLeaseLostError)) console.error('[generation-worker] finalize failed', finalizeError);
    });
    console.error('[generation-worker] job failed', { generationId: job.id, code, error: (error as Error).message });
  } finally {
    clearInterval(heartbeat);
    clearTimeout(hardTimer);
    unregister();
  }
}

/* ─────────── 生产路径：有界滚动并发（rolling pump） ───────────
 *
 * 为什么要改：旧实现每拍 `await processJob(job)`，一个进程同时只有 1 个生成在跑，而
 * services/llmGate 主车道有 8 个并发槽 —— 上游预算长期吃不满，单机对话吞吐 ≈ 1/单次生成耗时
 * （实测 8000 token 的一轮 130–145s），队列里的人只能干等。
 *
 * 为什么是「滚动」而不是 Promise.all 批处理：一单最长能跑 CHAT_JOB_MAX_RUNTIME_MS(300s)，
 * 批处理必须等整批 settle 才领下一批 —— 先完成的槽位会陪着最慢那一单干等（队头阻塞），
 * 有效并发被摊薄到「批内最慢者」的节奏。滚动 pump 是「谁腾出槽位谁立刻补一单」：
 * `.finally` 里减计数并**立即**再 pump 一次，不等下一个 300ms interval。
 *
 * 为什么 tickGenerationWorker 保留串行语义：它是全仓约 10 个测试文件的精确驱动器
 * （「领一单 → await 跑完 → 返回」）。一旦改成 fire-and-forget，那些用例就只能靠 sleep 猜时序。
 * 它刻意不参与 inFlight 计数 —— 两条路径都只经 claimNextGenerationJob 拿单，而那是**数据库原子
 * 操作**（FOR UPDATE SKIP LOCKED + 租约 + leaseVersion 递增），同一单不可能被领两次；并发安全
 * 由数据库保证，不靠进程内计数器。多进程/多机部署同理，进程内的 inFlight 只用来限制本进程的负载。
 *
 * 并发上限每轮 pump 现读环境变量（不在模块加载期缓存死），与 llmGate 的 cfg() 同惯例。
 */

/** 本进程的生成并发上限；留空/非法值回落默认，最小 1（=旧串行行为）。 */
function workerConcurrency(): number {
  // 注意 Number('') === 0（不是 NaN）：未设置 / 空串必须先判掉，否则会被当成「显式配了 0」，
  // 经 Math.max(1, 0) 变成 1 —— 等于悄悄退回串行。llmGate 的 num() 曾栽在这个坑上。
  const raw = process.env.GENERATION_WORKER_CONCURRENCY;
  if (raw == null || raw.trim() === '') return DEFAULT_WORKER_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_WORKER_CONCURRENCY;
  return Math.max(1, Math.floor(n));
}

/** 一轮领单：填满槽位就停，领不到单就停。不 await 任务本体。 */
async function pumpOnce(): Promise<void> {
  const limit = workerConcurrency();
  // 分类是轻量前置步骤（与旧 tick 同序：先分类，再领单），但它在极端竞态下可能连续返回
  // 「有活干」而实际没有推进（classifyGenerationJob 抢不到分类租约时也返回 job）。
  // 给一轮 pump 一个分类预算，用尽后本轮只领单，避免死循环卡在前置步骤上。
  let classifyBudget = limit + 2;
  let claimedAny = false;
  while (!stopped && inFlight < limit) {
    if (classifyBudget > 0 && await classifyNextPendingGeneration()) {
      classifyBudget--;
      continue;
    }
    // stop 可能落在上面那个 await 里，claim 前必须再看一眼；claim 自身 await 期间的 stop 收不住
    // ——那一单已经领到手（租约在我们身上），弃单只会让它干等 15s 租约过期，照常跑完是最小伤害。
    if (stopped) break;
    const job = await claimNextGenerationJob(workerId);
    if (!job) break;
    claimedAny = true;
    inFlight++;
    void processJob(job)
      .catch((error) => console.error('[generation-worker] job crashed', { generationId: job.id, error: (error as Error).message }))
      .finally(() => {
        inFlight--;
        // 每单跑完消费一次 outbox（与旧 tick 的 `await processJob` 后紧跟 effects tick 等价）。
        void tickGenerationEffects().catch((error) => console.error('[generation-worker] effects tick failed', error));
        if (!stopped) void pumpGenerationWorker();
      });
  }
  // 空闲拍才消费 outbox：与旧实现「claim 不到单就 tickGenerationEffects」一致。
  // 有单在途时不在这里跑，避免和上面每单跑完那次抢同一条 effect（runGenerationEffect 幂等，
  // 但白抢一次是纯浪费）。
  if (!claimedAny && inFlight === 0) {
    await tickGenerationEffects().catch((error) => console.error('[generation-worker] idle effects tick failed', error));
  }
}

/**
 * 生产调度入口：由 startGenerationWorker 的 interval 与每单收尾时触发。永不 reject。
 * 测试直接调用它来观察滚动并发（tickGenerationWorker 那条路径是串行的，观察不到）。
 */
export async function pumpGenerationWorker(): Promise<void> {
  if (pumping) { pumpAgain = true; return; }
  pumping = true;
  try {
    do {
      pumpAgain = false;
      // catch 放在循环体内：pumpOnce 抛错的瞬间若恰有任务收尾设了 pumpAgain，
      // 循环外的 catch 会把这次唤醒直接吞掉——生产靠 300ms interval 自愈，测试/手动 pump 会停住。
      try {
        await pumpOnce();
      } catch (error) {
        console.error('[generation-worker] pump failed', error);
      }
    } while (pumpAgain);
  } finally {
    pumping = false;
  }
}

/** 仅供测试：读当前在途任务数（pump 路径）。 */
export function __generationWorkerInFlight(): number {
  return inFlight;
}

/**
 * 串行拍：领一单、await 跑完、返回。**测试专用驱动器，语义不许变**（约 10 个测试文件依赖
 * 「返回即已跑完」来做断言，见上方 pump 注释）。生产调度走 pumpGenerationWorker。
 */
export async function tickGenerationWorker(): Promise<boolean> {
  if (ticking) return false;
  ticking = true;
  try {
    if (await classifyNextPendingGeneration()) return true;
    const job = await claimNextGenerationJob(workerId);
    if (!job) return tickGenerationEffects();
    await processJob(job);
    await tickGenerationEffects();
    return true;
  } finally {
    ticking = false;
  }
}

export function startGenerationWorker(): void {
  if (isAiTestMode() || timer) return;
  stopped = false;
  timer = setInterval(() => { void pumpGenerationWorker().catch((error) => console.error('[generation-worker] tick failed', error)); }, WORKER_POLL_MS);
  timer.unref?.();
  void pumpGenerationWorker().catch((error) => console.error('[generation-worker] initial tick failed', error));
}

/**
 * 只停调度，**不等在途任务收口**：进程退出本来也不等（旧串行实现同样如此），
 * 未收口的单靠 claimNextGenerationJob 的租约过期被接管（接管时旧 attempt 会被保守封账、
 * leaseVersion 递增把旧 worker 隔离在外）。所以这里要保证的只有一件事：停止领新单——
 * stopped 标志挡住 interval、pump 循环和每单收尾的 .finally 再触发这三个入口。
 * 保证的强度是「至多再领一单」：stop 恰好落在一次进行中的 claim await 里时，那一单已经带着
 * 我们的租约回来了，照常跑完（弃单只会让它干等 15s 租约过期，谁都不受益）。
 */
export function stopGenerationWorker(): void {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

/** 仅供测试：撤销 stop（stopGenerationWorker 是模块级标志，测试之间要能复位）。 */
export function __resumeGenerationWorker(): void {
  stopped = false;
}
