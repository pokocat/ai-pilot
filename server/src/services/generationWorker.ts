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
  GenerationLeaseLostError,
  heartbeatGenerationLease,
  persistGenerationResult,
  registerGenerationController,
  runGenerationEffect,
  startGenerationAttempt,
  writeGenerationSnapshot,
} from './generationJobs.js';
import {
  deliverableRecentLimit,
  loadConversationHistory,
  loadTurnDigest,
  wantsDeliverableRequest,
} from '../routes/sessions.js';

const WORKER_POLL_MS = 300;
const HEARTBEAT_MS = 5_000;
const SNAPSHOT_MS = 400;
const SNAPSHOT_CHARS = 192;
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
};

type FrozenContext = {
  ctx: GenContext;
  memoryConfig: unknown;
  knowledgeUsed: string[];
  refNotices: string[];
};

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
const workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;

function requestOf(job: GenerationJob): RequestData {
  return job.requestJson && typeof job.requestJson === 'object'
    ? job.requestJson as unknown as RequestData
    : { text: '' };
}

function withoutRuntimeSecrets(ctx: GenContext): GenContext {
  if (!ctx.runtime) return ctx;
  const { apiKey: _apiKey, difyApiKey: _difyApiKey, ...runtime } = ctx.runtime;
  return { ...ctx, runtime };
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
  const isDeliverable = !!effective.deliverableKey;
  const onDemand = isDeliverable
    && (effective.skillsConfig as { deliverableMode?: string } | null)?.deliverableMode === 'on-demand';
  const willDeliver = onDemand ? wantsDeliverableRequest(request.text) : isDeliverable;
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
  });
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
    const deliverable = job.replyJson as unknown as Deliverable;
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
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void (async () => {
      await heartbeatGenerationLease(job.id, workerId, leaseVersion);
      const state = await prisma.generationJob.findUnique({ where: { id: job.id }, select: { cancelRequestedAt: true } });
      if (state?.cancelRequestedAt) controller.abort(new Error('user_cancelled'));
    })().catch(() => controller.abort(new GenerationLeaseLostError())).finally(() => { heartbeatBusy = false; });
  }, HEARTBEAT_MS);

  let attemptNo: number | null = null;
  let accumulated = job.partialText || '';
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
    const frozen = await loadOrBuildContext(latest);
    frozenContext = frozen;
    if (await resumePersistedFinalize(latest, frozen, leaseVersion)) return;
    if (controller.signal.aborted) {
      await finalizeGeneration({ jobId: job.id, workerId, leaseVersion, status: 'cancelled', terminationReason: 'user_cancelled_before_provider' });
      return;
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
      accumulated = reportText(metered.result);
      const measured = conservativeUsage(providerUsage, frozen.ctx, accumulated, providerInvoked);
      await finishGenerationAttempt({ jobId: job.id, attemptNo, leaseVersion, status: controller.signal.aborted ? 'cancelled' : 'completed', usage: measured.usage, usageSource: measured.source });
      await persistGenerationResult({ jobId: job.id, workerId, leaseVersion, role: 'report', content: metered.result, partialText: accumulated, kind: 'report' });
      const cancelled = (await prisma.generationJob.findUnique({ where: { id: job.id }, select: { cancelRequestedAt: true } }))?.cancelRequestedAt;
      await finalizeGeneration({
        jobId: job.id,
        workerId,
        leaseVersion,
        status: cancelled ? 'cancelled' : hardTimedOut ? 'truncated' : 'completed',
        terminationReason: cancelled ? 'user_cancelled' : hardTimedOut ? 'job_budget_exceeded' : null,
        effectKeys: cancelled ? [] : postEffectKeys(job),
      });
      if (!cancelled) void runPostEffects(job, frozen, metered.result);
      return;
    }

    let reply: ChatReply | null = null;
    let lastSnapshotAt = Date.now();
    let charsSinceSnapshot = 0;
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
          await writeGenerationSnapshot({ jobId: job.id, workerId, leaseVersion, text: accumulated });
          lastSnapshotAt = Date.now();
          charsSinceSnapshot = 0;
        }
      } else {
        reply = event.result;
        providerUsage = event.usage;
        providerInvoked = event.providerInvoked;
      }
    }
    if (!reply && !accumulated) throw Object.assign(new Error('AI 流式响应为空'), { code: 'AI_EMPTY_RESPONSE' });
    let finalReply: ChatReply = reply ?? { text: accumulated, truncated: true };
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
    await persistGenerationResult({ jobId: job.id, workerId, leaseVersion, role: 'assistant', content: finalReply, partialText: accumulated, kind: 'chat' });
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
      await writeGenerationSnapshot({ jobId: job.id, workerId, leaseVersion, text: accumulated }).catch(() => {});
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

export async function tickGenerationWorker(): Promise<boolean> {
  if (ticking) return false;
  ticking = true;
  try {
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
  timer = setInterval(() => { void tickGenerationWorker().catch((error) => console.error('[generation-worker] tick failed', error)); }, WORKER_POLL_MS);
  timer.unref?.();
  void tickGenerationWorker().catch((error) => console.error('[generation-worker] initial tick failed', error));
}

export function stopGenerationWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
