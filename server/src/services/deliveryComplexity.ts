import { createHash } from 'node:crypto';
import { GenerationClassificationStatus, GenerationStatus, Prisma, type GenerationJob } from '@prisma/client';
import { z } from 'zod';
import type {
  ComplexityAssessment,
  ComplexityDimensionKey,
  DeliveryMode,
  DeliveryStage,
} from '../../../shared/contracts';
import { structuredMetered, providerInfo } from '../llm/gateway.js';
import { prisma } from '../db.js';

const CLASSIFICATION_TIMEOUT_MS = 3_500;
const CLASSIFICATION_LEASE_MS = 8_000;
const DIMENSION_KEYS = ['scope', 'deliverables', 'timeline', 'objects', 'dependencies'] as const;
const DOMAIN_WORDS = ['品牌', '获客', '增长', '招商', '渠道', '组织', '人才', '财务', '融资', '供应链', '产品', '运营', '交付', '区域'];
const COMPLEX_SIGNAL = /(全案|全国|年度|明年|三年|跨季度|多阶段|体系化|战略规划|扩张|从0到1|从零到一|落地路线图)/;
const PLAN_ACTION = /(方案|计划|规划|打法|报告|全案|路线图|体系)/;

const DimensionZ = z.object({
  key: z.enum(DIMENSION_KEYS),
  score: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  reason: z.string().trim().min(1).max(160),
});
const ComplexityZ = z.object({
  dimensions: z.array(DimensionZ).length(5),
  suggestedStages: z.array(z.object({
    title: z.string().trim().min(2).max(40),
    objective: z.string().trim().min(2).max(120),
  })).min(2).max(4),
}).superRefine((value, ctx) => {
  const keys = new Set(value.dimensions.map((item) => item.key));
  if (keys.size !== DIMENSION_KEYS.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dimensions'], message: '五个维度 key 必须各出现一次' });
  }
});

type ClassifierData = z.output<typeof ComplexityZ>;
export type ComplexityPrefilter =
  | { kind: 'none' }
  | { kind: 'candidate' }
  | { kind: 'direct'; assessment: ComplexityAssessment; stages: DeliveryStage[] };

function distinctDomains(text: string): string[] {
  return DOMAIN_WORDS.filter((word) => text.includes(word));
}

function explicitListSize(text: string): number {
  const after = text.match(/(?:包括|包含|需要|交付|输出)[：:]?([^。；\n]+)/)?.[1] ?? '';
  if (!after) return 0;
  return after.split(/[、，,；;]/).map((part) => part.trim()).filter((part) => part.length >= 2).length;
}

function directAssessment(text: string, domains: string[], listSize: number): ComplexityAssessment {
  const annual = /(年度|明年|全年|一年|跨季度|三年)/.test(text);
  const multiObject = /(全国|多地|多店|各区域|多个|三家|四家|五家)/.test(text);
  const dimensions: ComplexityAssessment['dimensions'] = [
    { key: 'scope', score: 2, reason: `涉及 ${domains.slice(0, 6).join('、') || '三个以上业务领域'}` },
    { key: 'deliverables', score: 2, reason: `明确列出 ${Math.max(3, listSize)} 个相对独立的成果模块` },
    { key: 'timeline', score: annual ? 2 : 1, reason: annual ? '周期跨季度或年度' : '需要分阶段推进' },
    { key: 'objects', score: multiObject ? 2 : 1, reason: multiObject ? '覆盖多个地区或经营对象' : '包含多个业务对象' },
    { key: 'dependencies', score: 1, reason: '多个模块之间存在顺序与资源依赖' },
  ];
  const score = dimensions.reduce((sum, item) => sum + item.score, 0);
  return { score, dimensions, reasons: dimensions.filter((item) => item.score > 0).map((item) => item.reason), source: 'rule' };
}

function genericStages(score: number): DeliveryStage[] {
  const stages = [
    { key: 'overview', number: 1, title: '总纲版', objective: '先交一份可独立使用的判断、路径、优先级与关键假设' },
    { key: 'growth_path', number: 2, title: '增长与关键路径', objective: '深化获客、转化、渠道或招商的核心打法' },
    { key: 'organization_model', number: 3, title: '组织与经营模型', objective: '深化组织分工、资源配置、财务与关键依赖' },
    { key: 'execution_90d', number: 4, title: '90 天执行图', objective: '把方案拆成负责人、节奏、指标、风险和复盘机制' },
  ];
  return stages.slice(0, score >= 7 ? 4 : 3);
}

/**
 * 普通闲聊走快路径；明确 3+ 交付物可由代码直接判复杂；其余疑似复杂请求才调用短分类。
 */
export function prefilterDeliveryComplexity(text: string): ComplexityPrefilter {
  const value = text.trim();
  if (!value || !PLAN_ACTION.test(value)) return { kind: 'none' };
  const domains = distinctDomains(value);
  const listSize = explicitListSize(value);
  if (domains.length >= 3 && listSize >= 3) {
    const assessment = directAssessment(value, domains, listSize);
    return { kind: 'direct', assessment, stages: genericStages(assessment.score) };
  }
  if (COMPLEX_SIGNAL.test(value) || domains.length >= 2 || listSize >= 2) return { kind: 'candidate' };
  return { kind: 'none' };
}

export function deliveryPlanIdFor(userId: string, clientRequestId: string): string {
  return `dp_${createHash('sha256').update(`${userId}\0${clientRequestId}`).digest('hex').slice(0, 24)}`;
}

function safeStageKey(title: string, index: number): string {
  const ascii = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 28);
  return ascii || `focus_${index}`;
}

function stagesFromModel(data: ClassifierData, score: number): DeliveryStage[] {
  const wanted = score >= 7 ? 4 : 3;
  const out: DeliveryStage[] = [{
    key: 'overview', number: 1, title: '总纲版',
    objective: '先交一份可独立使用的判断、路径、优先级与关键假设',
  }];
  const seen = new Set(['overview']);
  for (const item of data.suggestedStages) {
    if (out.length >= wanted) break;
    let key = safeStageKey(item.title, out.length);
    if (seen.has(key)) key = `${key}_${out.length}`;
    seen.add(key);
    out.push({ key, number: out.length + 1, title: item.title, objective: item.objective });
  }
  while (out.length < wanted) {
    const fallback = genericStages(score)[out.length];
    out.push({ ...fallback, number: out.length + 1 });
  }
  return out;
}

function assessmentFromModel(data: ClassifierData): ComplexityAssessment {
  const byKey = new Map(data.dimensions.map((item) => [item.key, item]));
  const dimensions = DIMENSION_KEYS.map((key) => byKey.get(key) ?? ({ key, score: 0, reason: '未识别到额外复杂度' } as const));
  const score = dimensions.reduce((sum, item) => sum + item.score, 0);
  return {
    score,
    dimensions,
    reasons: dimensions.filter((item) => item.score > 0).map((item) => item.reason),
    source: 'model',
  };
}

const CLASSIFIER_SYSTEM = `你是商业任务复杂度评分器，只做逐维打分，不决定路由。
严格输出 JSON：{"dimensions":[{"key":"scope|deliverables|timeline|objects|dependencies","score":0|1|2,"reason":"可核对理由"}],"suggestedStages":[{"title":"深化模块名","objective":"本阶段独立目标"}]}。
dimensions 必须恰好五项且每个 key 各一次。评分：业务范围、独立交付物、时间阶段、对象数量、依赖关系各 0-2 分。
资料不足不等于复杂；图片多不等于复杂。suggestedStages 只列总纲之后可继续深化的 2-4 个模块，不要写“总纲版”。`;

function estimateUsage(text: string, data: ClassifierData | null, attempts: number) {
  const inputTokens = attempts ? Math.max(1, Math.ceil((CLASSIFIER_SYSTEM.length + text.length) / 2)) * attempts : 0;
  const outputTokens = data ? Math.ceil(JSON.stringify(data).length / 2) : 0;
  return { inputTokens, outputTokens, cachedInput: 0, billableTokens: inputTokens + outputTokens };
}

async function startAttempt(jobId: string): Promise<{ job: GenerationJob; attemptNo: number } | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM generation_job WHERE id = ${jobId} FOR UPDATE`;
    const job = await tx.generationJob.findUnique({ where: { id: jobId } });
    if (!job || job.status !== GenerationStatus.queued) return null;
    const expired = job.classificationStatus === GenerationClassificationStatus.running
      && (!job.classificationLeaseExpiresAt || job.classificationLeaseExpiresAt < new Date());
    if (job.classificationStatus !== GenerationClassificationStatus.pending && !expired) return null;
    if (expired) {
      await tx.generationAttempt.updateMany({
        where: { jobId, kind: 'classification', status: 'running' },
        data: { status: 'failed', terminationReason: 'process_recovered', completedAt: new Date() },
      });
    }
    const max = await tx.generationAttempt.aggregate({ where: { jobId }, _max: { attemptNo: true } });
    const attemptNo = (max._max.attemptNo ?? 0) + 1;
    await tx.generationAttempt.create({
      data: { jobId, attemptNo, kind: 'classification', status: 'running', leaseVersion: 0, startedAt: new Date() },
    });
    const updated = await tx.generationJob.update({
      where: { id: jobId },
      data: {
        classificationStatus: GenerationClassificationStatus.running,
        classificationLeaseExpiresAt: new Date(Date.now() + CLASSIFICATION_LEASE_MS),
      },
    });
    return { job: updated, attemptNo };
  });
}

/** 分类完成前 job 仍是 queued，但 worker 的 claim 查询会跳过 pending/running，避免先生成后改路由。 */
export async function classifyGenerationJob(jobId: string): Promise<GenerationJob | null> {
  const started = await startAttempt(jobId);
  if (!started) return prisma.generationJob.findUnique({ where: { id: jobId } });
  const request = started.job.requestJson && typeof started.job.requestJson === 'object'
    ? started.job.requestJson as Record<string, unknown>
    : {};
  const text = String(request.text ?? '').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('classification_timeout'), CLASSIFICATION_TIMEOUT_MS);
  let outcome: Awaited<ReturnType<typeof structuredMetered<typeof ComplexityZ>>> | null = null;
  let classificationError: Error | null = null;
  try {
    outcome = await structuredMetered(ComplexityZ, {
      system: CLASSIFIER_SYSTEM,
      user: text,
      maxChars: 3000,
      maxTokens: 700,
      temperature: 0,
      signal: controller.signal,
      usageMeta: {
        tenantId: started.job.tenantId,
        userId: started.job.userId,
        sessionId: started.job.sessionId,
        agentKey: started.job.agentKey,
      },
    });
  } catch (error) {
    // 分类是辅助判断，任何 provider/解析/超时异常都必须降级为 single，不能让用户主请求失败。
    classificationError = error as Error;
  } finally {
    clearTimeout(timer);
  }
  const data = outcome?.data ?? null;
  const assessment = data ? assessmentFromModel(data) : null;
  const deliveryMode: DeliveryMode = assessment && assessment.score >= 4 ? 'staged' : 'single';
  const stages = deliveryMode === 'staged' && data ? stagesFromModel(data, assessment!.score) : [];
  const info = await providerInfo().catch(() => ({ provider: 'unknown', model: 'unknown' }));
  const usage = estimateUsage(text, data, outcome?.attempts ?? (classificationError ? 1 : 0));
  const failure = data
    ? null
    : controller.signal.aborted
      ? 'classification_timeout'
      : (classificationError as Error & { code?: string } | null)?.code ?? 'classification_failed';
  const requestJson = {
    ...request,
    deliveryMode,
    complexity: assessment ?? {
      score: 0, dimensions: [], reasons: [failure ?? '分类不可用，已按单次交付继续'], source: 'fallback',
    },
    deliveryPlanId: deliveryMode === 'staged' ? started.job.deliveryPlanId : null,
    stageKey: deliveryMode === 'staged' ? 'overview' : null,
    stageNumber: 1,
    deliveryStages: stages,
  };
  return prisma.$transaction(async (tx) => {
    const attempt = await tx.generationAttempt.updateMany({
      where: { jobId, attemptNo: started.attemptNo, status: 'running' },
      data: {
        status: data ? 'completed' : 'failed',
        usageJson: usage as Prisma.InputJsonValue,
        usageSource: 'estimated',
        terminationReason: failure,
        provider: String(info.provider ?? 'unknown'),
        model: String(info.model ?? 'unknown'),
        completedAt: new Date(),
      },
    });
    if (attempt.count !== 1) return tx.generationJob.findUnique({ where: { id: jobId } });
    return tx.generationJob.update({
      where: { id: jobId },
      data: {
        classificationStatus: data ? GenerationClassificationStatus.completed : GenerationClassificationStatus.failed,
        classificationLeaseExpiresAt: null,
        deliveryMode,
        complexityJson: requestJson.complexity as unknown as Prisma.InputJsonValue,
        deliveryPlanId: deliveryMode === 'staged' ? started.job.deliveryPlanId : null,
        stageKey: deliveryMode === 'staged' ? 'overview' : null,
        stageNumber: 1,
        deliveryStagesJson: deliveryMode === 'staged' ? stages as unknown as Prisma.InputJsonValue : Prisma.DbNull,
        requestJson: requestJson as unknown as Prisma.InputJsonValue,
      },
    });
  }, { maxWait: 5_000, timeout: 10_000 });
}

/** Worker 重启恢复：每拍最多接管一条 pending/租约已过期的分类，不让建单卡死。 */
export async function classifyNextPendingGeneration(): Promise<GenerationJob | null> {
  const at = new Date();
  const row = await prisma.generationJob.findFirst({
    where: {
      status: GenerationStatus.queued,
      OR: [
        { classificationStatus: GenerationClassificationStatus.pending },
        { classificationStatus: GenerationClassificationStatus.running, classificationLeaseExpiresAt: { lt: at } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return row ? classifyGenerationJob(row.id) : null;
}

export function complexityDecisionForDirect(prefilter: Extract<ComplexityPrefilter, { kind: 'direct' }>): {
  deliveryMode: 'staged'; assessment: ComplexityAssessment; stages: DeliveryStage[];
} {
  return { deliveryMode: 'staged', assessment: prefilter.assessment, stages: prefilter.stages };
}

export function stageInstruction(stage: DeliveryStage, stages: DeliveryStage[]): string {
  if (stage.number === 1) {
    return `【复杂方案分阶段交付】本轮是第 1/${stages.length} 阶段「${stage.title}」。必须立即交付一份可独立使用的总纲版：给出明确判断、优先级、关键路径、暂定假设与 90 天起步动作，不能只交目录，也不能用追问代替初版。后续深化模块由用户手动继续，本轮不要擅自连跑。`;
  }
  return `【复杂方案分阶段交付】本轮是第 ${stage.number}/${stages.length} 阶段「${stage.title}」：${stage.objective}。承接总纲与已交阶段，产出本模块可直接使用的深化稿；不要重复总纲，不要承诺自动生成下一阶段。`;
}

export function dimensionKeyLabel(key: ComplexityDimensionKey): string {
  return ({ scope: '业务范围', deliverables: '独立交付物', timeline: '时间与阶段', objects: '对象数量', dependencies: '依赖关系' })[key];
}
