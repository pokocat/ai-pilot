import { GenerationKind, type User } from '@prisma/client';
import type { ComplexityAssessment, DeliveryMode, DeliveryStage, RequestedOutput } from '../../../shared/contracts';
import type { MessageRef } from '../llm/schema.js';
import { KEY2AGENT } from '../data/agents.js';
import { prisma } from '../db.js';
import { resolveEffectiveAgent } from './agentVersions.js';
import { assertAgentAccess } from './entitlements.js';
import {
  assertPlanActive,
  generationQuotaReserveTokens,
  type GraceKind,
} from './tokenQuota.js';
import { createGenerationJob, type CreatedGenerationJob } from './generationJobs.js';
import { resolveRequestedOutput } from './outputIntent.js';
import {
  classifyGenerationJob,
  complexityDecisionForDirect,
  deliveryPlanIdFor,
  prefilterDeliveryComplexity,
} from './deliveryComplexity.js';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGES_PER_BATCH,
  MAX_IMAGES_PER_MESSAGE,
  validateImageReferenceBudget,
} from './chatImage.js';

export interface DurableGenerationBody {
  agentKey?: string;
  sessionId?: string;
  text: string;
  projectId?: string;
  refs?: MessageRef[];
  clientRequestId: string;
  parentGenerationId?: string;
}

export interface DurableGenerationCreated extends CreatedGenerationJob {
  agentKey: string;
  kind: 'chat' | 'report';
  refNotices: string[];
}

interface ForcedDeliveryStage {
  requestedOutput: RequestedOutput;
  deliveryMode: DeliveryMode;
  assessment: ComplexityAssessment | null;
  deliveryPlanId: string;
  stage: DeliveryStage;
  stageAttempt: number;
  stages: DeliveryStage[];
  parentGenerationId: string;
}

/** 调度优先级上限，与 GenerationJob.priority 的老化封顶保持一致（见 claimNextGenerationJob）。 */
const MAX_SCHEDULING_PRIORITY = 9;

/**
 * 套餐档位 → 调度优先级。映射数据归运营后台（Plan.tierRank，随时可改），
 * 代码里不写死档位表、也不 seed —— 这里只做「读到什么就折算什么」。
 * 无套餐 / tierRank 为空一律 0（与免费档同权），并非报错场景：过期套餐已被上游 assertPlanActive 挡掉。
 */
async function resolveSchedulingPriority(userId: string): Promise<number> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: { select: { tierRank: true } } },
  });
  const rank = row?.plan?.tierRank;
  if (typeof rank !== 'number' || !Number.isFinite(rank)) return 0;
  return Math.max(0, Math.min(MAX_SCHEDULING_PRIORITY, Math.trunc(rank)));
}

async function resolveProjectId(tenantId: string, bodyProjectId?: string, sessionProjectId?: string | null): Promise<string | null> {
  if (sessionProjectId) return sessionProjectId;
  if (!bodyProjectId) return null;
  const project = await prisma.project.findFirst({ where: { id: bodyProjectId, tenantId }, select: { id: true } });
  return project?.id ?? null;
}

/**
 * 新生成链路的唯一建单入口：所有业务校验发生在 provider 外呼前，随后由一个数据库事务
 * 原子落 user message、GenerationJob、会话占位以及 Token/钻石预留。
 */
export async function enqueueDurableGeneration(
  user: Pick<User, 'id' | 'tenantId'>,
  body: DurableGenerationBody,
  forcedStage?: ForcedDeliveryStage,
): Promise<DurableGenerationCreated> {
  const text = (body.text || '').trim();
  if (!text) throw Object.assign(new Error('empty text'), { statusCode: 400, code: 'EMPTY_TEXT' });
  if (!body.clientRequestId?.trim()) {
    throw Object.assign(new Error('clientRequestId required'), { statusCode: 400, code: 'CLIENT_REQUEST_ID_REQUIRED' });
  }
  const refs = Array.isArray(body.refs) ? body.refs : [];
  const imageCount = refs.filter((ref) => ref?.kind === 'image').length;
  if (refs.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw Object.assign(new Error(`一条消息最多带 ${MAX_ATTACHMENTS_PER_MESSAGE} 份附件，请分两次发送`), { statusCode: 400, code: 'TOO_MANY_ATTACHMENTS' });
  }
  if (imageCount > MAX_IMAGES_PER_MESSAGE) {
    throw Object.assign(new Error(`一条消息最多带 ${MAX_IMAGES_PER_MESSAGE} 张图片，请分两次发送`), { statusCode: 400, code: 'TOO_MANY_IMAGES' });
  }
  await validateImageReferenceBudget(user.tenantId, refs);
  const session = body.sessionId
    ? await prisma.session.findFirst({ where: { id: body.sessionId, userId: user.id } })
    : null;
  if (body.sessionId && !session) throw Object.assign(new Error('session not found'), { statusCode: 404, code: 'SESSION_NOT_FOUND' });
  const agentKey = session?.agentKey ?? body.agentKey ?? KEY2AGENT[text] ?? 'general';
  const projectId = await resolveProjectId(user.tenantId, body.projectId, session?.projectId);
  const effective = await resolveEffectiveAgent(agentKey);
  if (!effective) throw Object.assign(new Error('agent not found'), { statusCode: 404, code: 'AGENT_NOT_FOUND' });

  await assertPlanActive(user.id);
  await assertAgentAccess(user.id, { key: effective.key, billing: effective.billing });
  // 对话轴恒走 token（2026-08-13 计费改造，见 routes/sessions.ts 里那段完整说明）：
  // meterUnit 不再参与计费判定，钻石只在产出物那条链路上按「技能×规格」结算。
  const ratio = effective.billingRatio || 1;
  const creditCost = 0;
  const reviewIntent = /^帮我做 \d{4}-\d{2}-\d{2} 的执行复盘/.test(text);
  const grace: GraceKind | undefined = reviewIntent ? 'review' : undefined;
  const reserveTokens = await generationQuotaReserveTokens({
    forceLive: effective.providerMode === 'openai',
    model: effective.providerMode === 'openai' ? effective.apiModel : null,
  });
  const isDeliverable = !!effective.deliverableKey;
  const onDemand = isDeliverable
    && (effective.skillsConfig as { deliverableMode?: string } | null)?.deliverableMode === 'on-demand';
  const requestedOutput = forcedStage?.requestedOutput ?? resolveRequestedOutput(text);
  const kind: 'chat' | 'report' = forcedStage
    ? 'report'
    : isDeliverable && (!onDemand || requestedOutput === 'report') ? 'report' : 'chat';
  const prefilter = forcedStage || requestedOutput === 'chat'
    ? { kind: 'none' as const }
    : prefilterDeliveryComplexity(text);
  const direct = prefilter.kind === 'direct' ? complexityDecisionForDirect(prefilter) : null;
  const classificationRequired = !forcedStage && prefilter.kind === 'candidate';
  const deliveryMode = forcedStage?.deliveryMode ?? direct?.deliveryMode ?? 'single';
  const deliveryPlanId = forcedStage?.deliveryPlanId ?? (direct || classificationRequired
    ? deliveryPlanIdFor(user.id, body.clientRequestId.trim())
    : null);
  const stages = forcedStage?.stages ?? direct?.stages ?? [];
  const stage = forcedStage?.stage ?? stages[0] ?? null;
  const assessment = forcedStage?.assessment ?? direct?.assessment ?? null;
  const priority = await resolveSchedulingPriority(user.id);

  let created = await createGenerationJob({
    tenantId: user.tenantId,
    userId: user.id,
    agentKey,
    text,
    clientRequestId: body.clientRequestId.trim(),
    sessionId: session?.id ?? null,
    parentGenerationId: forcedStage?.parentGenerationId ?? body.parentGenerationId ?? null,
    projectId,
    refs: body.refs,
    imageCount,
    imageBatchCount: imageCount ? Math.ceil(imageCount / MAX_IMAGES_PER_BATCH) : 0,
    kind,
    billingRatio: ratio,
    quotaReserveTokens: reserveTokens,
    grace,
    creditCost,
    requestedOutput,
    deliveryMode,
    classificationRequired,
    complexity: assessment,
    deliveryPlanId,
    stageKey: stage?.key ?? null,
    stageNumber: stage?.number ?? 1,
    stageAttempt: forcedStage?.stageAttempt ?? 1,
    deliveryStages: stages,
    priority,
    requestMeta: {
      effectiveVersionId: effective.versionId,
      effectiveVersionNumber: effective.versionNumber,
    },
  });
  if (classificationRequired && created.job.classificationStatus === 'pending') {
    const classified = await classifyGenerationJob(created.job.id);
    if (classified) created = { ...created, job: classified };
  }
  return { ...created, agentKey, kind: created.job.kind, refNotices: [] };
}

const TERMINAL = new Set(['completed', 'truncated', 'failed', 'cancelled']);

/**
 * 用户显式继续复杂方案：服务端从冻结阶段链选择下一项，客户端不能伪造 plan/stage。
 * 同一 plan+stage 的 clientRequestId 与数据库唯一键均稳定，重复点击只复用同一任务。
 */
export async function enqueueNextDeliveryStage(
  user: Pick<User, 'id' | 'tenantId'>,
  fromGenerationId: string,
): Promise<DurableGenerationCreated> {
  const source = await prisma.generationJob.findFirst({
    where: { id: fromGenerationId, userId: user.id, tenantId: user.tenantId },
  });
  if (!source) throw Object.assign(new Error('阶段任务不存在'), { statusCode: 404, code: 'DELIVERY_STAGE_NOT_FOUND' });
  if (source.deliveryMode !== 'staged' || !source.deliveryPlanId || !Array.isArray(source.deliveryStagesJson)) {
    throw Object.assign(new Error('这不是分阶段交付'), { statusCode: 409, code: 'DELIVERY_NOT_STAGED' });
  }
  const stages = (source.deliveryStagesJson as unknown as DeliveryStage[])
    .filter((stage) => stage && typeof stage.key === 'string' && Number.isInteger(stage.number))
    .sort((a, b) => a.number - b.number);
  const planJobs = await prisma.generationJob.findMany({
    where: { userId: user.id, deliveryPlanId: source.deliveryPlanId },
    orderBy: [{ stageNumber: 'asc' }, { createdAt: 'asc' }],
  });
  const delivered = new Set(planJobs.filter((job) => job.stageKey && job.status === 'completed').map((job) => job.stageKey!));
  const existingInFlight = planJobs.find((job) => !TERMINAL.has(job.status));
  if (existingInFlight) {
    return {
      job: existingInFlight,
      session: await prisma.session.findUniqueOrThrow({ where: { id: existingInFlight.sessionId } }),
      createdSession: false,
      attached: true,
      agentKey: existingInFlight.agentKey,
      kind: existingInFlight.kind,
      refNotices: [],
    };
  }
  const next = stages.find((stage) => !delivered.has(stage.key));
  if (!next) throw Object.assign(new Error('全部阶段已经交付完成'), { statusCode: 409, code: 'DELIVERY_PLAN_COMPLETED' });
  const previous = [...planJobs]
    .filter((job) => job.status === 'completed' && job.stageNumber < next.number)
    .sort((a, b) => b.stageNumber - a.stageNumber)[0];
  if (!previous) {
    throw Object.assign(new Error('上一阶段尚未完成，请先重试上一阶段'), { statusCode: 409, code: 'DELIVERY_PREVIOUS_INCOMPLETE' });
  }
  const sourceRequest = source.requestJson && typeof source.requestJson === 'object'
    ? source.requestJson as Record<string, unknown>
    : {};
  const assessment = source.complexityJson && typeof source.complexityJson === 'object'
    ? source.complexityJson as unknown as ComplexityAssessment
    : null;
  const stageAttempt = Math.max(0, ...planJobs.filter((job) => job.stageKey === next.key).map((job) => job.stageAttempt)) + 1;
  return enqueueDurableGeneration(user, {
    agentKey: source.agentKey,
    sessionId: source.sessionId,
    text: `继续深化第 ${next.number} 阶段「${next.title}」：${next.objective}`,
    projectId: typeof sourceRequest.projectId === 'string' ? sourceRequest.projectId : undefined,
    clientRequestId: `delivery:${source.deliveryPlanId}:${next.key}:${stageAttempt}`,
    parentGenerationId: previous.id,
  }, {
    requestedOutput: 'report',
    deliveryMode: 'staged',
    assessment,
    deliveryPlanId: source.deliveryPlanId,
    stage: next,
    stageAttempt,
    stages,
    parentGenerationId: previous.id,
  });
}
