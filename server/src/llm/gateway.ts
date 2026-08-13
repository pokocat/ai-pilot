// LLM Gateway（《投产开发指导》§5.1）：统一封装模型调用——
// 路由（mock/claude/openai 兼容，含 Agnes/DeepSeek/Qwen…）、输入审核、Token 计量、结果缓存、故障兜底/降级。
//
// provider 与 baseUrl/model/key 由「运营后台可切换的 DB 配置」决定（services/aiConfig），
// env 仅作兜底；未配置真实 key 时一律降级 mock，保证可用。

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { jsonrepair } from 'jsonrepair';
import { env, isRealKey, isAiTestMode } from '../env.js';
import { prisma } from '../db.js';
import { getAiConfig, effectiveProvider, resolveAuxConfigAsync, resolveModelRate, type ResolvedAiConfig } from '../services/aiConfig.js';
// mockUpstream：仅当配了 AI_MOCK_LATENCY_MS 时，让 mock 占一个真实闸门槽位并模拟上游耗时，
// 好让压测能压到 llmGate/端点池（见 providers/mock.ts 顶部注释）。默认 0 = 同步直出，行为不变。
// **只用在「mock 就是配置的 provider」的分支**；真 provider 失败后的降级兜底一律不套——
// 故障路径本就该尽快返回，再叠一层模拟延迟只会把故障放大。
import { mockChat, mockDeliverable, mockAdaptive, mockUpstream } from './providers/mock.js';
import { ZERO_USAGE, extractAsks, looksLikeAsking, normalizeAsks, type Deliverable, type ChatReply, type GenContext, type AiTestResult, type Usage } from './schema.js';
import { recordTokenUsage, recordAuxUsage, type UsageMeta } from '../services/usage.js';
import { billableTokenEquivalents } from '../data/modelPrices.js';
import { recordTrace } from '../services/trace.js';
import { classifyLlmError } from './errorClassify.js';
import { noteChatNonStream, noteGenDegraded, noteAsksRecovered } from '../services/metrics.js';
import { moderate } from '../services/moderation.js';
import { auditBannedWords } from '../services/bannedWords.js';
import { cacheGet, cacheSet } from '../services/cache.js';
import {
  createEndpointCapture,
  runWithEndpointCapture,
  type EndpointCapture,
} from '../services/llmPool.js';
import { chatMaxTokens } from './thinking.js';

// 当前生效 provider（已就绪才返回 claude/openai，否则 null → mock 兜底）。
function liveProvider(cfg: ResolvedAiConfig): 'claude' | 'openai' | null {
  if (isAiTestMode()) return null; // 测试一律 mock，不触达真实 provider
  const eff = effectiveProvider(cfg);
  return eff === 'mock' ? null : eff;
}

/**
 * 供 rawJson 系调用方（extractGraphTriples/summarizePoints 等不回传真实 token 用量）判断：
 * 本次是否会真正触达真实模型。未就绪（mock/测试）时这些函数直接短路返回空，不产生真实成本，
 * 调用方应据此把预留的额度全额退回，而非按估算定额扣费（避免 mock/demo 环境误扣真实用户额度）。
 */
export async function hasLiveProvider(): Promise<boolean> {
  const cfg = await getAiConfig();
  return liveProvider(cfg) !== null;
}

export interface ImageBatchInput { index: number; mediaType: string; base64: string }
export interface ImageBatchObservation {
  result: string;
  usage: Usage;
  provider: 'openai' | 'claude' | 'mock';
  model: string;
  providerInvoked: boolean;
}

const IMAGE_OBSERVATION_SYSTEM = `你是图片观察器，只负责忠实读图，不做最终商业方案。
逐张输出，必须用输入指定的序号开头，如“[图3]”。描述可见文字、数字、主体、布局、异常和不确定处；看不清就明确写看不清，禁止猜测。
最后补一行“本批共读取 N 张”。只输出观察记录，控制在 700 字以内。`;

/** 多图编排的轻量观察调用：无完整军师 system prompt、无历史、无客户档案，每批由调用方限制 ≤4 张。 */
export async function observeImageBatch(args: {
  images: ImageBatchInput[];
  userQuestion: string;
  signal?: AbortSignal;
  usageMeta?: UsageMeta;
}): Promise<ImageBatchObservation> {
  const cfg = await getAiConfig();
  const live = liveProvider(cfg);
  const indexes = args.images.map((image) => image.index);
  const user = `图片序号：${indexes.map((index) => `图${index}`).join('、')}\n用户想解决的问题：${args.userQuestion.slice(0, 1_200)}\n请只观察本批图片。`;
  if (!live) {
    return {
      result: `${indexes.map((index) => `[图${index}] 已读取；测试环境不生成视觉细节。`).join('\n')}\n本批共读取 ${indexes.length} 张`,
      usage: { ...ZERO_USAGE }, provider: 'mock', model: 'template', providerInvoked: false,
    };
  }
  const images = args.images.map(({ mediaType, base64 }) => ({ mediaType, base64 }));
  if (live === 'openai') {
    const { openaiRawMetered } = await import('./providers/openai.js');
    const out = await openaiRawMetered(cfg, IMAGE_OBSERVATION_SYSTEM, user, {
      allowThinking: false, maxTokens: 900, signal: args.signal, images,
      affinityKey: `image-observation:${indexes.join('-')}`,
    });
    await recordTokenUsage({
      ...args.usageMeta,
      kind: 'image_observation',
      provider: live,
      model: cfg.model,
      usage: out.usage,
    });
    return { ...out, provider: live, model: cfg.model, providerInvoked: true };
  }
  const { claudeRawMetered } = await import('./providers/claude.js');
  const out = await claudeRawMetered(cfg, IMAGE_OBSERVATION_SYSTEM, user, {
    allowThinking: false, maxTokens: 900, signal: args.signal, images,
    affinityKey: `image-observation:${indexes.join('-')}`,
  });
  await recordTokenUsage({
    ...args.usageMeta,
    kind: 'image_observation',
    provider: live,
    model: cfg.model,
    usage: out.usage,
  });
  return { ...out, provider: live, model: cfg.model, providerInvoked: true };
}

// 真实 provider 调用失败：生产（AI_FALLBACK_MOCK=false）不静默兜底 mock，抛错让前端提示重试，避免答非所问。
function aiUnavailable(err: unknown): Error {
  const e = err as Error & { code?: string };
  if (e.code === 'AI_OUTPUT_TRUNCATED') return e;
  // AI_BUSY 来自全局并发闸（services/llmGate）：这是**我方主动降级**，不是上游故障。
  // 原样透出，让前端能提示「排队较多，稍后重试」，而不是笼统的「AI 服务暂时不可用」。
  if (e.code === 'AI_BUSY') return e;
  const aborted = e.code === 'AI_TIMEOUT' || e.name === 'AbortError' || /abort|超时|timeout/i.test(e.message || '');
  return Object.assign(
    new Error(aborted ? 'AI 响应超时，请稍后重试' : 'AI 服务暂时不可用，请稍后重试'),
    { code: 'AI_UNAVAILABLE', statusCode: 503 },
  );
}

// 滚动迁移期的历史密钥解密失败（APP_ENCRYPTION_KEY 轮换错/未配但库内密文）是**配置故障**，不是「未配置」。
// 生产（AI_FALLBACK_MOCK=false）下必须抛 AI_UNAVAILABLE，而不是让下游 isRealKey('')=false 静默降级 mock
// ——否则全站悄悄返回 mock 模板、零报错、trace 无记录，且 AI_FALLBACK_MOCK=false 也挡不住（走的是
// 「无 live provider」正常分支不经 catch）。迁移完成后 AI 凭证明文存库，该保护自然不再触发。
// 测试/显式允许 mock 的环境不拦。
async function assertKeyHealthy(): Promise<void> {
  if (env.aiFallbackMock || isAiTestMode()) return;
  const cfg = await getAiConfig();
  if (cfg.keyDecryptFailed) {
    throw aiUnavailable(Object.assign(new Error('模型密钥解密失败'), { code: 'AI_KEY_DECRYPT_FAILED' }));
  }
}

// 把「产出 + 真实 token + 来源」打包，便于在输出审核/缓存前统一记账。
// toolCalls/iterations：启用技能的工具调用循环才有，供可观测 trace 记录。
type Sourced<T> = {
  result: T;
  usage: Usage;
  provider: string;
  model: string;
  endpointId?: string | null;
  endpointLabel?: string | null;
  toolCalls?: number;
  iterations?: number;
};

function withActualEndpoint<T>(s: Sourced<T>, capture: EndpointCapture): Sourced<T> {
  const hit = capture.hit;
  if (!hit) return s;
  return {
    ...s,
    provider: hit.provider || s.provider,
    model: hit.model || s.model,
    endpointId: hit.endpointId,
    endpointLabel: hit.endpointLabel,
  };
}

function deliverableText(d: Deliverable): string {
  return d.sections.map((s) => `${s.h} ${s.b ?? ''} ${(s.list ?? []).join(' ')}`).join('\n');
}

// 军师反问选项：把模型回复尾部的 ```ask 块解析成结构化 asks 并从正文剥离。
// 未命中原样透传；mock 等已直接带 asks 的结果不受影响。所有 ChatReply 出口统一过这一层。
function withAsks(reply: ChatReply): ChatReply {
  const { text, asks } = extractAsks(reply.text);
  return asks ? { ...reply, text, asks } : { ...reply, text };
}

/**
 * 兜底抽取：正文在问用户、但模型没给 ```ask 块时，补一次轻量抽取把选项救回来。
 *
 * 为什么需要这层：ask 块是「文本尾部约定」，模型的遵从性天生不稳，且**回复越长越容易丢**
 * （线上实测 2845 字的长回复整块丢掉，727 字的正常带上）。而 thinking 开着时 temperature 被
 * Anthropic 强制为 1（见 thinking.ts），格式约定的稳定性只会更差。提示词层能提高命中率，
 * 但治不到 100%——这一层是保下限的：不管模型守不守协议，问用户就该有选项可点。
 *
 * 成本与风险控制：
 * - 只在「正文尾部像在提问 + asks 为空」时触发，绝大多数回复不进这条路；
 * - 走 completeJson（辅助路径、已关思考、几百 token 预算），不碰主链路的预算与流式；
 * - 抽不出/超时/上游不可用 → 静默返回原 reply。兜底失败绝不能让整轮对话失败；
 * - 抽取模型自己判断是否真在等答案，修辞性问句返回空数组。
 */
export function shouldRecoverChatAsks(reply: ChatReply): boolean {
  return !reply.asks?.length && !!reply.text && looksLikeAsking(reply.text);
}

type AskRecoverySafety = { ctx: GenContext; meta?: UsageMeta };

export async function recoverChatAsks(
  reply: ChatReply,
  signal?: AbortSignal,
  safety?: AskRecoverySafety,
): Promise<ChatReply> {
  if (!shouldRecoverChatAsks(reply)) return reply;
  try {
    const out = await completeJson(ASK_RECOVERY_SYSTEM, reply.text.slice(-1200), { signal, usageMeta: safety?.meta });
    const asks = normalizeAsks(out?.asks);
    if (!asks) { noteAsksRecovered('miss'); return reply; }
    const visibleText = JSON.stringify(asks);
    if (safety) {
      // 推荐选项是一次新的、直接面向用户的模型产出：与主正文一样纳入输出审核和禁用词审计。
      // 审核未通过只丢弃增强项，已经持久化的主回复仍正常完成。
      void auditBannedWords({
        tenantId: safety.meta?.tenantId ?? safety.ctx.tenantId ?? null,
        userId: safety.meta?.userId ?? safety.ctx.userId ?? null,
        sessionId: safety.meta?.sessionId ?? null,
        agentKey: safety.ctx.agentKey,
        kind: 'chat.ask_recovery',
        text: visibleText,
      });
      if (!(await moderate('output', visibleText, modOpts(safety.ctx, safety.meta)))) {
        noteAsksRecovered('miss');
        return reply;
      }
    }
    noteAsksRecovered('recovered');
    return { ...reply, asks };
  } catch (err) {
    console.warn('[gateway] ask 兜底抽取失败，按无选项交回：', (err as Error).message);
    return reply;
  }
}

const ASK_RECOVERY_SYSTEM = [
  '你在给一个商业顾问对话产品补「问题的推荐答案选项」。下面给你的是顾问回复的结尾部分。',
  '任务：找出结尾处**真正在等用户回答**的问题（最多 4 个），给每个问题配 2-4 个推荐答案。',
  '只输出 JSON，格式：{"asks":[{"q":"问题原文","options":["选项1","选项2","选项3"]}]}',
  '规则：q 用回复里的问题原文（不要改写、不超过 120 字）；options 每项不超过 10 个字、具体可选、覆盖最可能的答案；不要写「其他」。',
  '如果结尾只是修辞性反问、自问自答、或并没有在等用户回答，返回 {"asks":[]}。宁可少给也不要硬凑。',
].join('\n');

/** chat 出口统一入口：先按协议剥离，缺了再兜底抽一次。 */
async function withAsksRecovered(reply: ChatReply, ctx: GenContext, meta?: UsageMeta): Promise<ChatReply> {
  return recoverChatAsks(withAsks(reply), undefined, { ctx, meta });
}

// 只匹配「模型把自己当代码助手、自述找不到项目/工作区上下文」的串味输出。
// 注意：不得含 README/package.json/IDE/workspace/repository/代码库 等宽泛技术名词——
// 面向 SaaS / 开发者工具类客户的正当战略报告会自然出现这些词，早期版本因此把真报告误判串味、
// 静默换成 mock 废模板（见售卖前体检 P1）。这里只保留模型自述缺失项目上下文的明确短语 + Codex 自称。
const ENGINEERING_CONTEXT_LEAK =
  /(当前工作区|工作区中未发现|缺少[^。；\n]*(项目文档|业务数据|战略输入材料)|未发现[^。；\n]*(项目文档|业务文档|业务数据|战略规划材料)|上传[^。；\n]*工作区|Codex)/i;

function hasEngineeringContextLeak(d: Deliverable): boolean {
  const text = [d.title, d.meta, deliverableText(d)].filter(Boolean).join('\n');
  return ENGINEERING_CONTEXT_LEAK.test(text);
}

function sanitizeDeliverable(ctx: GenContext, d: Deliverable): Deliverable {
  if (!hasEngineeringContextLeak(d)) return d;
  console.warn('[gateway] deliverable contained engineering context; replaced with business fallback', {
    agentKey: ctx.agentKey,
    deliverableKey: ctx.deliverableKey,
  });
  noteGenDegraded('context_leak');
  return { ...mockDeliverable(ctx), degraded: true };
}

// 输出侧内容审核（合规硬门槛）：AI 产出在返回/持久化前审一遍，命中即抛 MODERATION_BLOCK。
// 输出侧默认 fail-closed（moderation.moderate 对 refType='output' 的约定）——审核服务抖动时宁拦不放。
// 输入侧审核在 7/4 流式化提交中被移除后，输出侧一直缺位；这里重新接回（见售卖前体检 P0/合规）。
async function moderateOutputOrThrow(
  text: string,
  ctx: GenContext,
  meta?: UsageMeta,
  consumed?: Pick<Sourced<unknown>, 'usage' | 'provider' | 'model'>,
): Promise<void> {
  if (!(await moderate('output', text, modOpts(ctx, meta)))) {
    const providerInvoked = !!consumed && ['claude', 'openai', 'dify'].includes(consumed.provider);
    throw Object.assign(new Error('产出未通过内容审核'), {
      code: 'MODERATION_BLOCK',
      providerInvoked,
      ...(providerInvoked ? { generationUsage: consumed!.usage, generationProvider: consumed!.provider, generationModel: consumed!.model } : {}),
    });
  }
}

// P1-B5：审核上下文——沙盒/评测跳过审核，并把租户/用户/会话写入 moderation_log 便于追溯。
function modOpts(ctx: GenContext, meta?: UsageMeta) {
  return { sandbox: meta?.sandbox, tenantId: meta?.tenantId ?? ctx.tenantId ?? null, userId: meta?.userId ?? ctx.userId ?? null, sessionId: meta?.sessionId ?? null };
}

// 计时执行一次 provider 调用并落 trace（成功记 ok + 指标 + 原文；失败记 error 后原样抛出，由调用方兜底）。
async function traced<T>(
  run: () => Promise<Sourced<T>>,
  args: { kind: 'deliverable' | 'chat'; ctx: GenContext; meta?: UsageMeta; provider: string; respText: (r: T) => string },
): Promise<Sourced<T>> {
  const t0 = Date.now();
  const capture = createEndpointCapture();
  try {
    const s = withActualEndpoint(await runWithEndpointCapture(capture, run), capture);
    await recordTrace({
      meta: args.meta, agentKey: args.ctx.agentKey, versionId: args.ctx.versionId, kind: args.kind, provider: s.provider, model: s.model,
      endpointId: s.endpointId, endpointLabel: s.endpointLabel,
      status: 'ok', latencyMs: Date.now() - t0, toolCalls: s.toolCalls, iterations: s.iterations, usage: s.usage,
      promptText: args.ctx.userMessage, responseText: args.respText(s.result), context: args.ctx.contextTrace,
    });
    // PR-0a 禁用词检查：只记录不拦截（fire-and-forget，绝不影响产出）。
    void auditBannedWords({
      tenantId: args.meta?.tenantId ?? args.ctx.tenantId ?? null,
      userId: args.meta?.userId ?? args.ctx.userId ?? null,
      sessionId: args.meta?.sessionId ?? null,
      agentKey: args.ctx.agentKey,
      kind: args.kind,
      text: args.respText(s.result),
    });
    return s;
  } catch (err) {
    await recordTrace({
      meta: args.meta, agentKey: args.ctx.agentKey, versionId: args.ctx.versionId, kind: args.kind,
      provider: capture.hit?.provider ?? args.provider,
      model: capture.hit?.model ?? '',
      endpointId: capture.hit?.endpointId,
      endpointLabel: capture.hit?.endpointLabel,
      status: 'error', errorMessage: (err as Error).message, errorBucket: classifyLlmError(err), latencyMs: Date.now() - t0, promptText: args.ctx.userMessage,
      context: args.ctx.contextTrace,
    });
    throw err;
  }
}

// 对真实计费 provider（claude/openai/dify）记账；mock 与 0-token（缓存命中）跳过。记账内部 catch，不影响产出。
async function maybeRecord(s: Sourced<unknown>, kind: 'deliverable' | 'chat', ctx: GenContext, meta?: UsageMeta): Promise<void> {
  if (meta?.sandbox) return; // 沙盒试跑不计入 token_usage（诊断 trace 仍由 traced() 记录）
  if (s.provider !== 'claude' && s.provider !== 'openai' && s.provider !== 'dify') return;
  const billable = await fillBillable(s);
  await recordTokenUsage({
    tenantId: meta?.tenantId ?? null,
    userId: meta?.userId ?? null,
    sessionId: meta?.sessionId ?? null,
    agentKey: meta?.agentKey ?? ctx.agentKey ?? null,
    kind,
    provider: s.provider,
    model: s.model,
    usage: s.usage,
    // 本次扣的月度额度 = ceil(输入token等价量 × ratio)。等价量按后台单价把输出/缓存各档折算成
    // 输入 token（见 billableTokenEquivalents）——等价合并会让长输出用户被系统性少扣。
    creditCost: Math.ceil(billable * (meta?.ratio ?? 1)),
  });
}

/**
 * 记账前把「输入 token 等价量」算好回填到 usage 上，供路由的额度扣减复用。
 *
 * 只有这里同时握有**实际生效的 model**（端点池会换 model，路由拿不到）和后台单价，所以加权
 * 必须在此完成；路由只负责读 `usage.billableTokens`。两处都用同一个数，口径才不会分叉。
 */
async function fillBillable(s: Sourced<unknown>): Promise<number> {
  const fallback = Math.max(0, s.usage.inputTokens) + Math.max(0, s.usage.outputTokens);
  try {
    const { rate } = await resolveModelRate(s.model);
    const billable = billableTokenEquivalents(s.usage, rate);
    s.usage.billableTokens = billable;
    return billable;
  } catch {
    // 单价解析失败（DB 抖动等）绝不能拖垮产出：退回裸 token 求和，与旧口径一致。
    s.usage.billableTokens = fallback;
    return fallback;
  }
}

// —— per-agent 接入覆盖（providerMode=openai/dify）：绕过全局 provider 与结果缓存 ——

// 把 per-agent 自定义 OpenAI 端点并入一个 ResolvedAiConfig（其余沿用全局/默认）。
function openaiOverrideCfg(ctx: GenContext, base: ResolvedAiConfig): ResolvedAiConfig {
  const rt = ctx.runtime!;
  return {
    ...base,
    provider: 'openai',
    baseUrl: rt.baseUrl || base.baseUrl,
    model: rt.model || base.model,
    apiKey: rt.apiKey || '',
    temperature: rt.temperature ?? base.temperature,
    // providerMode=openai 表示该智能体明确绑定自己的接入；不能再被全局 chat 端点池改写。
    // 探活早已遵守同一边界，真实生成也必须 bypass，否则“测试的是 A、线上跑到 B”。
    poolBypass: true,
    // per-agent 自定义接入不等于全局 activeModelId，避免 trace 误归因。
    endpointId: undefined,
    traceEndpointId: undefined,
    traceEndpointLabel: `${ctx.agentKey} 自定义端点`,
  };
}

// Dify 返回的 conversation_id 回写 Session，维持后续多轮上下文。
async function persistDifyConversation(ctx: GenContext, conversationId: string | null): Promise<void> {
  const rt = ctx.runtime;
  if (!rt?.sessionId || !conversationId || conversationId === rt.conversationId) return;
  await prisma.session
    .update({ where: { id: rt.sessionId }, data: { difyConversationId: conversationId } })
    .catch((err) => console.error('[gateway] persist dify conversation failed:', (err as Error).message));
}

async function runtimeChat(ctx: GenContext): Promise<Sourced<ChatReply>> {
  const rt = ctx.runtime!;
  if (rt.mode === 'dify') {
    const { difyChat } = await import('./providers/dify.js');
    const { reply, conversationId, usage } = await difyChat(ctx);
    await persistDifyConversation(ctx, conversationId);
    return { result: reply, usage, provider: 'dify', model: 'dify' };
  }
  const cfg = openaiOverrideCfg(ctx, await getAiConfig());
  if (!isRealKey(cfg.apiKey)) {
    if (!env.aiFallbackMock && !isAiTestMode()) throw Object.assign(new Error('智能体模型密钥不可用'), { code: 'AI_KEY_MISSING' });
    return { result: await mockUpstream(() => mockChat(ctx)), usage: ZERO_USAGE, provider: 'mock', model: cfg.model };
  }
  const oa = await import('./providers/openai.js');
  const tools = await skillToolsFor(ctx);
  if (tools.length) {
    const m = await oa.openaiChatWithTools(ctx, cfg, tools);
    return { result: m.result, usage: m.usage, provider: 'openai', model: cfg.model, toolCalls: m.toolCalls, iterations: m.iterations };
  }
  const m = await oa.openaiChat(ctx, cfg);
  return { result: m.result, usage: m.usage, provider: 'openai', model: cfg.model };
}

// 解析该 agent 启用的技能工具（未开启或无勾选 → 空，走单次调用）。
// 与「模型接入方式」解耦：读 ctx.skills（inherit/全局模型、自定义 openai 端点都适用）。
// 仅在 openai 兼容 provider 下生效——工具调用循环目前是 openai 协议实现；调用方需确保 openai 上下文（claude/mock/dify 不调本函数）。
async function skillToolsFor(ctx: GenContext) {
  const sk = ctx.skills;
  if (!sk?.enabled || !sk.tools?.length) return [];
  const { loadToolsByNames } = await import('../services/skillTools.js');
  return loadToolsByNames(sk.tools);
}

async function runtimeDeliverable(ctx: GenContext): Promise<Sourced<Deliverable>> {
  const rt = ctx.runtime!;
  if (rt.mode === 'dify') {
    const { difyDeliverable } = await import('./providers/dify.js');
    const { deliverable, conversationId, usage } = await difyDeliverable(ctx);
    await persistDifyConversation(ctx, conversationId);
    return { result: deliverable, usage, provider: 'dify', model: 'dify' };
  }
  const cfg = openaiOverrideCfg(ctx, await getAiConfig());
  if (!isRealKey(cfg.apiKey)) {
    if (!env.aiFallbackMock && !isAiTestMode()) throw Object.assign(new Error('智能体模型密钥不可用'), { code: 'AI_KEY_MISSING' });
    return { result: await mockUpstream(() => mockDeliverable(ctx)), usage: ZERO_USAGE, provider: 'mock', model: cfg.model };
  }
  const oa = await import('./providers/openai.js');
  const tools = await skillToolsFor(ctx);
  if (tools.length) {
    const m = await oa.openaiDeliverableWithTools(ctx, cfg, tools);
    return { result: m.result, usage: m.usage, provider: 'openai', model: cfg.model, toolCalls: m.toolCalls, iterations: m.iterations };
  }
  const m = await oa.openaiDeliverable(ctx, cfg);
  return { result: m.result, usage: m.usage, provider: 'openai', model: cfg.model };
}

// —— 内容审核：见 services/moderation.ts（可插拔 keyword/http provider，落 moderation_log） ——
// —— 算力计量：按次扣费在路由层用 services/credits 完成（产出前校验、成功后扣减）；
//    此处只负责 LLM 调用，不掺计费逻辑。Token 级用量归集留待生产接真实 usage。 ——

// —— 结果缓存：见 services/cache.ts（默认内存，配 REDIS_URL+ioredis 切 Redis） ——
const CACHE_TTL = 5 * 60 * 1000;
// 把一组上下文片段折叠成稳定短哈希：用于缓存键，避免「条数相同但内容不同」误命中（P0-1）。
// 分隔符用 NUL（正常文本不会出现，故拼接结果不可能被内容伪造）。**必须写成转义形式**：
// 这里曾是一个字面 NUL 字节，于是 file(1) 把本文件判成 data、grep/ripgrep 按二进制整文件跳过，
// 整个 LLM 网关对所有代码搜索（含安全扫描）隐形。转义后运行时值与字面字节完全等价。
function contentSig(parts: (string | null | undefined)[]): string {
  return createHash('sha1').update(parts.map((p) => p ?? '').join('\u0000')).digest('hex').slice(0, 16);
}
function cacheKey(kind: string, ctx: GenContext, cfg: ResolvedAiConfig): string {
  // P0-1：引用/知识/记忆/理解按**内容哈希**入键，而非仅条数——否则同租户不同用户、条数偶合即串数据。
  const ctxSig = contentSig([
    ...(ctx.references ?? []),
    ...(ctx.knowledge ?? []),
    ...(ctx.memories ?? []),
    ...(ctx.understanding ?? []),
    // 图片入键：仅凭文本 + 引用条数相同不足以区分「带不同图」的两轮，否则会串用错缓存的成果。
    ...(ctx.images ?? []).map((im) => `${im.mediaType}:${im.base64}`),
  ]);
  const profileSig = [
    ctx.companyName ?? '',
    ctx.profile?.industry ?? '',
    ctx.profile?.stage ?? '',
    ctx.profile?.pain ?? '',
    ctx.projectName ?? '',
    ctx.understandingMaturity ?? '',
    ctx.understandingQuestions?.length ?? 0,
  ].join('|');
  // tenantId + userId 双重入键：tenantId 防跨租户；userId 防同租户内跨用户命中（成果由 per-user 私有记忆/引用生成）。
  const tenantSig = ctx.tenantId ?? '';
  const userSig = ctx.userId ?? '';
  return `${kind}:${tenantSig}:${userSig}:${effectiveProvider(cfg)}:${cfg.model}:${ctx.agentKey}:${ctx.deliverableKey ?? ''}:${ctx.userMessage}:${profileSig}:${ctxSig}`;
}

export async function generateDeliverable(ctx: GenContext, meta?: UsageMeta): Promise<{ result: Deliverable; usage: Usage; providerInvoked: boolean }> {
  await assertKeyHealthy();
  if (!(await moderate('input', ctx.userMessage, modOpts(ctx, meta)))) {
    throw Object.assign(new Error('输入未通过内容审核'), { code: 'MODERATION_BLOCK' });
  }

  // per-agent 接入覆盖：绕过全局 provider 与缓存（端点/会话因人/因体而异）。失败兜底 mock。
  if (ctx.runtime) {
    let sourced: Sourced<Deliverable>;
    let providerInvoked = false;
    try {
      providerInvoked = true;
      sourced = await traced(() => runtimeDeliverable(ctx), { kind: 'deliverable', ctx, meta, provider: ctx.runtime.mode === 'dify' ? 'dify' : 'openai', respText: deliverableText });
    } catch (err) {
      console.error('[gateway] runtime deliverable fallback to mock:', (err as Error).message);
      if (!env.aiFallbackMock) throw Object.assign(aiUnavailable(err), { providerInvoked });
      noteGenDegraded('runtime_deliverable');
      sourced = { result: mockDeliverable(ctx), usage: ZERO_USAGE, provider: 'mock', model: '' };
    }
    sourced.result = sanitizeDeliverable(ctx, sourced.result);
    await maybeRecord(sourced, 'deliverable', ctx, meta);
    // 真实 provider 调用已发生，即使输出审核拦下也要先入 TokenUsage，
    // 并把 usage 挂到异常上供 GenerationJob 按实际消耗结算。
    await moderateOutputOrThrow(deliverableText(sourced.result), ctx, meta, sourced);
    return { result: sourced.result, usage: sourced.usage, providerInvoked };
  }

  const cfg = await getAiConfig();
  const live = liveProvider(cfg);
  // P1-D1：技能启用 + openai/claude 均走工具调用循环（此前只 openai，claude 静默失效）。
  const tools = (live === 'openai' || live === 'claude') ? await skillToolsFor(ctx) : [];
  // 工具产出依赖实时检索/记忆/HTTP 结果，不走结果缓存。
  const ck = cacheKey('deliverable', ctx, cfg);
  if (!tools.length) {
    const cached = await cacheGet<Deliverable>(ck);
    if (cached) return { result: cached, usage: ZERO_USAGE, providerInvoked: false }; // 缓存命中：0 token，不计额度（启用技能不缓存）
  }

  let sourced: Sourced<Deliverable>;
  let providerInvoked = false;
  try {
    sourced = await traced(async () => {
      if (live === 'claude') {
        providerInvoked = true;
        const cl = await import('./providers/claude.js');
        const m = tools.length ? await cl.claudeDeliverableWithTools(ctx, cfg, tools) : await cl.claudeDeliverable(ctx, cfg);
        const mt = m as { toolCalls?: number; iterations?: number };
        return { result: m.result, usage: m.usage, provider: 'claude', model: cfg.model, toolCalls: mt.toolCalls, iterations: mt.iterations };
      }
      if (live === 'openai') {
        providerInvoked = true;
        const oa = await import('./providers/openai.js');
        const m = tools.length ? await oa.openaiDeliverableWithTools(ctx, cfg, tools) : await oa.openaiDeliverable(ctx, cfg);
        const mt = m as { toolCalls?: number; iterations?: number };
        return { result: m.result, usage: m.usage, provider: 'openai', model: cfg.model, toolCalls: mt.toolCalls, iterations: mt.iterations };
      }
      return { result: await mockUpstream(() => mockDeliverable(ctx)), usage: ZERO_USAGE, provider: 'mock', model: cfg.model };
    }, { kind: 'deliverable', ctx, meta, provider: live ?? 'mock', respText: deliverableText });
  } catch (err) {
    console.error('[gateway] deliverable fallback to mock:', (err as Error).message);
    if (!env.aiFallbackMock) throw Object.assign(aiUnavailable(err), { providerInvoked });
    noteGenDegraded('deliverable');
    sourced = { result: mockDeliverable(ctx), usage: ZERO_USAGE, provider: 'mock', model: cfg.model };
  }

  sourced.result = sanitizeDeliverable(ctx, sourced.result);
  await maybeRecord(sourced, 'deliverable', ctx, meta);
  await moderateOutputOrThrow(deliverableText(sourced.result), ctx, meta, sourced);
  if (!tools.length) await cacheSet(ck, sourced.result, CACHE_TTL);
  return { result: sourced.result, usage: sourced.usage, providerInvoked };
}

export async function chatComplete(ctx: GenContext, meta?: UsageMeta, opts?: { inputModerated?: boolean }): Promise<{ result: ChatReply; usage: Usage; providerInvoked: boolean }> {
  await assertKeyHealthy();
  if (!opts?.inputModerated && !(await moderate('input', ctx.userMessage, modOpts(ctx, meta)))) {
    throw Object.assign(new Error('输入未通过内容审核'), { code: 'MODERATION_BLOCK' });
  }

  // per-agent 接入覆盖：走该智能体自己的端点 / Dify 应用。失败兜底 mock。
  if (ctx.runtime) {
    let s: Sourced<ChatReply>;
    let providerInvoked = false;
    try {
      providerInvoked = true;
      s = await traced(() => runtimeChat(ctx), { kind: 'chat', ctx, meta, provider: ctx.runtime.mode === 'dify' ? 'dify' : 'openai', respText: (r) => r.text });
      await maybeRecord(s, 'chat', ctx, meta);
    } catch (err) {
      console.error('[gateway] runtime chat fallback to mock:', (err as Error).message);
      if (!env.aiFallbackMock) throw Object.assign(aiUnavailable(err), { providerInvoked });
      noteGenDegraded('runtime_chat');
      // mock 路径不做 ask 兜底：mockChat 自带 asks，且降级到这里意味着上游已不可用，再发一次抽取只会白等一次失败。
      return { result: withAsks(mockChat(ctx)), usage: ZERO_USAGE, providerInvoked };
    }
    await moderateOutputOrThrow(s.result.text, ctx, meta, s);
    return { result: await withAsksRecovered(s.result, ctx, meta), usage: s.usage, providerInvoked };
  }

  const cfg = await getAiConfig();
  // live 提到 try 外面：下面的 mock 兜底需要区分「mock 本来就是配置的 provider」和
  // 「真 provider 失败后降级」——前者可注入压测用的模拟耗时，后者必须立刻返回。
  const live = liveProvider(cfg);
  let chatResult: Sourced<ChatReply> | null = null;
  let providerInvoked = false;
  try {
    if (live) {
      const tools = (live === 'openai' || live === 'claude') ? await skillToolsFor(ctx) : []; // P1-D1：openai/claude 均支持工具
      const s = await traced(async () => {
        providerInvoked = true;
        if (live === 'claude') {
          const cl = await import('./providers/claude.js');
          const m = tools.length ? await cl.claudeChatWithTools(ctx, cfg, tools) : await cl.claudeChat(ctx, cfg);
          const mt = m as { toolCalls?: number; iterations?: number };
          return { result: m.result, usage: m.usage, provider: 'claude', model: cfg.model, toolCalls: mt.toolCalls, iterations: mt.iterations };
        }
        const oa = await import('./providers/openai.js');
        const m = tools.length ? await oa.openaiChatWithTools(ctx, cfg, tools) : await oa.openaiChat(ctx, cfg);
        const mt = m as { toolCalls?: number; iterations?: number };
        return { result: m.result, usage: m.usage, provider: 'openai', model: cfg.model, toolCalls: mt.toolCalls, iterations: mt.iterations };
      }, { kind: 'chat', ctx, meta, provider: live, respText: (r) => r.text });
      await maybeRecord(s, 'chat', ctx, meta);
      chatResult = s;
    }
  } catch (err) {
    console.error('[gateway] chat fallback to mock:', (err as Error).message);
    if ((err as Error & { code?: string }).code === 'AI_OUTPUT_TRUNCATED') throw err;
    if (!env.aiFallbackMock) throw Object.assign(aiUnavailable(err), { providerInvoked });
    noteGenDegraded('chat');
  }
  if (chatResult) {
    await moderateOutputOrThrow(chatResult.result.text, ctx, meta, chatResult);
    return { result: await withAsksRecovered(chatResult.result, ctx, meta), usage: chatResult.usage, providerInvoked };
  }
  // live 为空 = mock 就是配置的 provider；live 有值却走到这里 = 真 provider 失败后的降级兜底（不注入延迟）。
  const reply = live ? mockChat(ctx) : await mockUpstream(() => mockChat(ctx));
  return { result: withAsks(reply), usage: ZERO_USAGE, providerInvoked };
}

export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; result: ChatReply; usage: Usage; providerInvoked: boolean };
type ProviderChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; result: ChatReply; usage: Usage };

// 按句/词切块，供前端渐进渲染（替代历史「假 sleep」节奏）。
function* chunkText(text: string): Generator<string> {
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if (buf.length >= 12 || '。！？\n.!?'.includes(ch)) { yield buf; buf = ''; }
  }
  if (buf) yield buf;
}

async function* chunkedChatFallback(ctx: GenContext, meta?: UsageMeta, inputModerated = false): AsyncGenerator<ChatStreamEvent> {
  const { result, usage, providerInvoked } = await chatComplete(ctx, meta, { inputModerated });
  for (const piece of chunkText(result.text)) yield { type: 'delta', text: piece };
  yield { type: 'done', result, usage, providerInvoked };
}

async function* tracedChatProviderStream(
  ctx: GenContext,
  meta: UsageMeta | undefined,
  provider: 'openai' | 'claude',
  model: string,
  stream: AsyncGenerator<ProviderChatStreamEvent>,
): AsyncGenerator<ChatStreamEvent> {
  const t0 = Date.now();
  let text = '';
  let done: { result: ChatReply; usage: Usage } | null = null;
  const capture = createEndpointCapture();
  const iterator = stream[Symbol.asyncIterator]();
  let iteratorFinished = false;
  try {
    for (;;) {
      // provider 的 async generator 是惰性执行；每次 next 都要进入本轮隔离的 capture，
      // 否则流式路径实际选中的端点会丢失。
      const step = await runWithEndpointCapture(capture, () => iterator.next());
      if (step.done) { iteratorFinished = true; break; }
      const ev = step.value;
      if (ev.type === 'delta') {
        text += ev.text;
        yield ev;
      } else {
        done = { result: ev.result, usage: ev.usage };
      }
    }
    if (!done) throw Object.assign(new Error(`${provider} 流式响应未返回完整结果`), { code: 'AI_EMPTY_RESPONSE' });
    const actual = withActualEndpoint({ result: done.result, usage: done.usage, provider, model }, capture);
    await recordTrace({
      meta, agentKey: ctx.agentKey, versionId: ctx.versionId, kind: 'chat', provider: actual.provider, model: actual.model,
      endpointId: actual.endpointId, endpointLabel: actual.endpointLabel,
      status: 'ok', latencyMs: Date.now() - t0, usage: done.usage,
      promptText: ctx.userMessage, responseText: done.result.text, context: ctx.contextTrace,
    });
    void auditBannedWords({
      tenantId: meta?.tenantId ?? ctx.tenantId ?? null,
      userId: meta?.userId ?? ctx.userId ?? null,
      sessionId: meta?.sessionId ?? null,
      agentKey: ctx.agentKey,
      kind: 'chat',
      text: done.result.text,
    });
    await maybeRecord(actual, 'chat', ctx, meta);
    // 尾部 ```ask 块在完整结果处剥离并结构化（token 流里已原样流出，前端流式期间负责隐藏）。
    const parsed = withAsks(done.result);
    yield { type: 'done', result: meta?.skipAskRecovery ? parsed : await recoverChatAsks(parsed, undefined, { ctx, meta }), usage: done.usage, providerInvoked: true };
  } catch (err) {
    await recordTrace({
      meta, agentKey: ctx.agentKey, versionId: ctx.versionId, kind: 'chat',
      provider: capture.hit?.provider ?? provider,
      model: capture.hit?.model ?? model,
      endpointId: capture.hit?.endpointId,
      endpointLabel: capture.hit?.endpointLabel,
      status: 'error', errorMessage: (err as Error).message, errorBucket: classifyLlmError(err), latencyMs: Date.now() - t0, promptText: ctx.userMessage,
      responseText: text, context: ctx.contextTrace,
    });
    throw err;
  } finally {
    // 保留原 for-await 的取消语义：客户端断开导致外层 generator 提前 return 时，
    // 必须把 return 透给 provider，释放流式连接与并发槽位。
    if (!iteratorFinished && iterator.return) {
      await runWithEndpointCapture(capture, () => iterator.return!(undefined as never)).catch(() => {});
    }
  }
}

/**
 * 聊天流式：输入侧审核 + 密钥健康检查后，优先走 provider 原生 streaming，模型 token/chunk 到达即下发。
 * 若当前路径暂不支持原生流（Dify、工具调用循环、mock、兼容网关不支持 stream），退回 chatComplete 完整结果后分块。
 *
 * 【输出审核的合规边界】原生流式是 token 逐个已下发、无法事后撤回，故不在此做「拦截式」输出审核（否则要缓冲
 * 整段、丧失流式意义）。合规覆盖如下：① 报告/结构化产出（可分享、可持久化的高风险物）在 generateDeliverable
 * 内 fail-closed 输出审核，命中即不下发；② 非流式对话与流式握手失败的兜底路径走 chatComplete，同样做输出审核；
 * ③ 输入侧对所有路径审核。若监管要求对「流式对话正文」也做拦截式输出审核，把对话关掉原生流式（走下方 fallback
 * 的 chatComplete 分块下发）即可让其纳入输出审核——这是一次配置取舍，非代码缺口。
 */
export async function* chatCompleteStream(ctx: GenContext, meta?: UsageMeta): AsyncGenerator<ChatStreamEvent> {
  await assertKeyHealthy();
  if (!(await moderate('input', ctx.userMessage, modOpts(ctx, meta)))) {
    throw Object.assign(new Error('输入未通过内容审核'), { code: 'MODERATION_BLOCK' });
  }

  let emitted = false;
  let providerInvoked = false;
  // 为什么要记「这轮为什么没走原生流」：非流式对话吃的是总时长超时，2026-08-04 线上那 6 次
  // 精确 60.0s 超时全部落在这条路上。原因分布是那类事故最早的可观测信号（见 metrics.noteChatNonStream）。
  let fellBack: 'tools' | 'dify' | 'mock' | 'no_key' | 'stream_failed' | null = null;
  try {
    if (ctx.runtime?.mode === 'openai') {
      const cfg = openaiOverrideCfg(ctx, await getAiConfig());
      const tools = await skillToolsFor(ctx);
      if (!isRealKey(cfg.apiKey)) fellBack = 'no_key';
      else if (tools.length) fellBack = 'tools';
      if (isRealKey(cfg.apiKey) && !tools.length) {
        const oa = await import('./providers/openai.js');
        providerInvoked = true;
        for await (const ev of tracedChatProviderStream(ctx, meta, 'openai', cfg.model, oa.openaiChatStream(ctx, cfg, { signal: meta?.signal, firstTokenStartedAtMs: meta?.firstTokenStartedAtMs }))) {
          if (ev.type === 'delta') emitted = true;
          yield ev;
        }
        return;
      }
    }

    if (!ctx.runtime) {
      const cfg = await getAiConfig();
      const live = liveProvider(cfg);
      const tools = (live === 'openai' || live === 'claude') ? await skillToolsFor(ctx) : [];
      if (!live) fellBack = 'mock';
      else if (tools.length) fellBack = 'tools';
      if (live === 'openai' && !tools.length) {
        const oa = await import('./providers/openai.js');
        providerInvoked = true;
        for await (const ev of tracedChatProviderStream(ctx, meta, 'openai', cfg.model, oa.openaiChatStream(ctx, cfg, { signal: meta?.signal, firstTokenStartedAtMs: meta?.firstTokenStartedAtMs }))) {
          if (ev.type === 'delta') emitted = true;
          yield ev;
        }
        return;
      }
      if (live === 'claude' && !tools.length) {
        const cl = await import('./providers/claude.js');
        providerInvoked = true;
        for await (const ev of tracedChatProviderStream(ctx, meta, 'claude', cfg.model, cl.claudeChatStream(ctx, cfg, { signal: meta?.signal, firstTokenStartedAtMs: meta?.firstTokenStartedAtMs }))) {
          if (ev.type === 'delta') emitted = true;
          yield ev;
        }
        return;
      }
    }
  } catch (err) {
    if (emitted) throw Object.assign(err as object, { providerInvoked });
    fellBack = 'stream_failed';
    console.error('[gateway] native chat stream failed before visible output:', (err as Error).message);
    if (!env.aiFallbackMock) {
      // 不再拿同一个故障网关做一次非流式重试：会重复花钱/再等一轮，且错误 usage 更难归集。
      throw Object.assign(aiUnavailable(err), { providerInvoked });
    }
    noteChatNonStream('stream_failed');
    noteGenDegraded('chat_stream_failed');
    const fallback = withAsks(mockChat(ctx));
    for (const piece of chunkText(fallback.text)) yield { type: 'delta', text: piece };
    yield { type: 'done', result: fallback, usage: ZERO_USAGE, providerInvoked };
    return;
  }

  // 走到这里就一定是非流式了（原生流成功的分支全都 return 了）。dify runtime 不进上面任何分支，
  // 也没有别的判据能落到 fellBack 上，故在此兜底归类。
  noteChatNonStream(fellBack ?? (ctx.runtime?.mode === 'dify' ? 'dify' : 'stream_failed'));
  for await (const ev of chunkedChatFallback(ctx, meta, true)) yield ev;
}

export type AdaptiveResult =
  | { kind: 'report'; deliverable: Deliverable; usage: Usage }
  | { kind: 'chat'; reply: ChatReply; usage: Usage };

/**
 * 按需产出（skillsConfig.deliverableMode='on-demand'）：模型自行决定本轮出结构化报告还是文本对话。
 * 仅全局 openai 与 mock 支持「自适应」；claude / per-agent runtime 暂回退为对话（避免误出空报告）。
 */
export async function generateAdaptive(ctx: GenContext, meta?: UsageMeta): Promise<AdaptiveResult> {
  await assertKeyHealthy();
  if (!(await moderate('input', ctx.userMessage, modOpts(ctx, meta)))) {
    throw Object.assign(new Error('输入未通过内容审核'), { code: 'MODERATION_BLOCK' });
  }

  // per-agent 接入覆盖：自适应产出未单独实现 → 回退对话（runtimeChat）。
  if (ctx.runtime) {
    let s: Sourced<ChatReply>;
    try {
      s = await traced(() => runtimeChat(ctx), { kind: 'chat', ctx, meta, provider: ctx.runtime.mode === 'dify' ? 'dify' : 'openai', respText: (r) => r.text });
      await maybeRecord(s, 'chat', ctx, meta);
    } catch (err) {
      console.error('[gateway] runtime adaptive fallback to mock:', (err as Error).message);
      if (!env.aiFallbackMock) throw aiUnavailable(err);
      noteGenDegraded('runtime_adaptive');
      // mock 路径不做 ask 兜底：mockChat 自带 asks，且降级到这里意味着上游已不可用，再发一次抽取只会白等一次失败。
      return { kind: 'chat', reply: withAsks(mockChat(ctx)), usage: ZERO_USAGE };
    }
    return { kind: 'chat', reply: await withAsksRecovered(s.result, ctx, meta), usage: s.usage };
  }

  const cfg = await getAiConfig();
  const live = liveProvider(cfg);
  const t0 = Date.now();
  const endpointCapture = createEndpointCapture();
  let out: { kind: 'report'; result: Deliverable } | { kind: 'chat'; result: ChatReply };
  let provider = 'mock';
  const configuredModel = cfg.model;
  let toolCalls: number | undefined;
  let iterations: number | undefined;
  let usage: Usage = ZERO_USAGE;

  try {
    if (live === 'openai') {
      const oa = await import('./providers/openai.js');
      const tools = await skillToolsFor(ctx);
      const m = await runWithEndpointCapture(endpointCapture, () => oa.openaiAdaptive(ctx, cfg, tools));
      provider = 'openai'; usage = m.usage; toolCalls = m.toolCalls; iterations = m.iterations;
      out = m.kind === 'report' ? { kind: 'report', result: m.deliverable } : { kind: 'chat', result: m.reply };
    } else if (live === 'claude') {
      const cl = await import('./providers/claude.js');
      const tools = await skillToolsFor(ctx);
      const m = await runWithEndpointCapture(endpointCapture, () => cl.claudeAdaptive(ctx, cfg, tools));
      provider = 'claude'; usage = m.usage; toolCalls = m.toolCalls; iterations = m.iterations;
      out = m.kind === 'report' ? { kind: 'report', result: m.deliverable } : { kind: 'chat', result: m.reply };
    } else {
      const m = await mockUpstream(() => mockAdaptive(ctx));
      out = m.kind === 'report' ? { kind: 'report', result: m.deliverable } : { kind: 'chat', result: m.reply };
    }
  } catch (err) {
    await recordTrace({
      meta, agentKey: ctx.agentKey, versionId: ctx.versionId, kind: 'chat',
      provider: endpointCapture.hit?.provider ?? live ?? 'mock',
      model: endpointCapture.hit?.model ?? '',
      endpointId: endpointCapture.hit?.endpointId,
      endpointLabel: endpointCapture.hit?.endpointLabel,
      status: 'error', errorMessage: (err as Error).message, errorBucket: classifyLlmError(err), latencyMs: Date.now() - t0, promptText: ctx.userMessage,
      context: ctx.contextTrace,
    });
    console.error('[gateway] adaptive fallback to mock:', (err as Error).message);
    if (!env.aiFallbackMock) throw aiUnavailable(err);
    noteGenDegraded('adaptive');
    const m = mockAdaptive(ctx);
    provider = 'mock'; usage = ZERO_USAGE; toolCalls = undefined; iterations = undefined;
    out = m.kind === 'report' ? { kind: 'report', result: m.deliverable } : { kind: 'chat', result: m.reply };
  }

  const recKind: 'deliverable' | 'chat' = out.kind === 'report' ? 'deliverable' : 'chat';
  const model = provider === 'mock' ? configuredModel : (endpointCapture.hit?.model ?? configuredModel);
  const endpointId = provider === 'mock' ? null : endpointCapture.hit?.endpointId;
  const endpointLabel = provider === 'mock' ? null : endpointCapture.hit?.endpointLabel;
  if (out.kind === 'report') out.result = sanitizeDeliverable(ctx, out.result);
  const respText = out.kind === 'report' ? deliverableText(out.result) : out.result.text;
  await recordTrace({
    meta, agentKey: ctx.agentKey, versionId: ctx.versionId, kind: recKind, provider, model, endpointId, endpointLabel,
    status: 'ok', latencyMs: Date.now() - t0, toolCalls, iterations, usage,
    promptText: ctx.userMessage, responseText: respText, context: ctx.contextTrace,
  });
  await maybeRecord({ result: out.result, usage, provider, model, endpointId, endpointLabel, toolCalls, iterations }, recKind, ctx, meta);

  return out.kind === 'report'
    ? { kind: 'report', deliverable: out.result, usage }
    : { kind: 'chat', reply: await withAsksRecovered(out.result, ctx, meta), usage };
}

/**
 * 从对话文本提炼结构化「洞察」（Learned Memory）。
 * 有真实模型时让模型抽取 1–3 条事实/偏好/决策；否则启发式兜底（截断原文）。
 */
// 军师记忆库六类（key），与 app/contracts 的展示标签一一对应（其人/其业/其时/其志/其略/相与之道）。
export const MEMORY_CATEGORIES = ['founder', 'company', 'status', 'vision', 'strategy', 'rapport'] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export interface ExtractedFact { text: string; category: MemoryCategory | null }

export async function extractInsights(text: string, agentName?: string): Promise<ExtractedFact[]> {
  void agentName;
  const fallback = (): ExtractedFact[] => {
    const t = text.trim().slice(0, 120);
    return t ? [{ text: `老板在对话中提到：${t}`, category: null }] : [];
  };
  const cfg = await getAiConfig();
  const live = liveProvider(cfg);
  if (!live) return fallback();
  try {
    const sys =
      '你是「军师」的记忆抽取官。从对话里提炼 1-3 条对长期辅佐这位老板有价值的事实，' +
      '每条一句话、可独立理解、不含寒暄，并各归入下列六类之一（category 只填英文 key）：\n' +
      'founder（其人：出身/创业故事/性情/决断习惯/天赋与短板）、' +
      'company（其业：起家与沿革/行业/发展阶段/团队班底/业务模式）、' +
      'status（其时：当前经营实况/主要痛点/卡点——经营数字只记老板亲口所报，不得推算）、' +
      'vision（其志：抱负/远图/想把生意做成什么/使命）、' +
      'strategy（其略：主要矛盾/战略定位/主攻赛道/当前打法）、' +
      'rapport（相与之道：沟通偏好/忌讳/对建议的取舍/约定）。\n' +
      '只输出 JSON：{"facts":[{"text":"...","category":"founder"}]}。无可提炼则 {"facts":[]}。';
    const json = await rawJson(cfg, live, sys, text.slice(0, 1500));
    const arr = (json?.facts as unknown[]) ?? [];
    const out: ExtractedFact[] = arr
      .filter((x): x is { text: string; category?: string } => !!x && typeof (x as { text?: unknown }).text === 'string')
      .slice(0, 3)
      .map((x) => ({
        text: x.text.slice(0, 160),
        category: (MEMORY_CATEGORIES as readonly string[]).includes(x.category ?? '') ? (x.category as MemoryCategory) : null,
      }));
    return out.length ? out : fallback();
  } catch (err) {
    console.error('[gateway] extractInsights fallback:', (err as Error).message);
    return fallback();
  }
}

/** 通用结构化 JSON 生成（无 live provider 或失败返回 null，调用方决定兜底）。P3 完整履历用。 */
export async function llmJson(system: string, user: string, maxChars = 9000): Promise<Record<string, unknown> | null> {
  const cfg = await getAiConfig();
  const live = liveProvider(cfg);
  if (!live) return null;
  try {
    const json = await rawJson(cfg, live, system, user.slice(0, maxChars));
    return json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  } catch (err) {
    console.error('[gateway] llmJson failed:', (err as Error).message);
    return null;
  }
}

/** 测试连接：用给定配置发一次最小补全，返回耗时与样例（后台「测试连接」用）。 */
export async function pingModel(cfg: ResolvedAiConfig): Promise<AiTestResult> {
  const eff = effectiveProvider(cfg);
  if (eff === 'mock') {
    return { ok: false, provider: cfg.provider, model: cfg.model, error: cfg.provider === 'mock' ? '当前为本地模板（mock），无需联网' : '未配置真实 API Key，已降级 mock' };
  }
  const t0 = Date.now();
  try {
    const sys = '你是连通性测试。请只回复两个字：可用。';
    const text = eff === 'openai'
      ? await (await import('./providers/openai.js')).openaiRaw(cfg, sys, 'ping')
      : await (await import('./providers/claude.js')).claudeRaw(cfg, sys, 'ping');
    return { ok: true, latencyMs: Date.now() - t0, sample: text.slice(0, 40), provider: cfg.provider, model: cfg.model };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: (err as Error).message, provider: cfg.provider, model: cfg.model };
  }
}

/** 测试某个智能体的 per-agent 接入（后台「测试连接」用）：openai 自定义端点或 Dify 应用。 */
export async function pingAgentRuntime(rt: {
  mode: 'openai' | 'dify';
  baseUrl?: string; model?: string; apiKey?: string;
  difyBaseUrl?: string; difyApiKey?: string; difyInputs?: Record<string, string>;
}): Promise<AiTestResult> {
  if (rt.mode === 'dify') {
    const { difyPing } = await import('./providers/dify.js');
    const r = await difyPing({ difyBaseUrl: rt.difyBaseUrl, difyApiKey: rt.difyApiKey, difyInputs: rt.difyInputs });
    return { ok: r.ok, latencyMs: r.latencyMs, sample: r.sample, error: r.error, missingInputs: r.missingInputs, provider: 'dify', model: 'chat-messages' };
  }
  const base = await getAiConfig(true);
  const cfg: ResolvedAiConfig = {
    ...base,
    provider: 'openai',
    baseUrl: rt.baseUrl || base.baseUrl,
    model: rt.model || base.model,
    apiKey: rt.apiKey || '',
    // 与 mergedTestConfig 同一个理由：探活走的是同一条 withEndpoint 外呼链路，
    // 不 bypass 就会被端点池整体改写成池成员——那样测的根本不是这个智能体自带的接入点。
    // 这是 D1 当时漏掉的第三个入口；三期收尾后旧两个入口已统一为 /admin/ai-endpoints/test。
    poolBypass: true,
  };
  // Agent 自带接入此前完全不过校验（设计稿决策点 5 的 B 项：至少共享地基）。
  // 这里只报 error 级——它是探活入口，warn/info 不该挡住运营去测。
  const { validateEndpoint, hasBlocking, blockingMessage } = await import('./validate.js');
  const issues = validateEndpoint({
    label: rt.model || '智能体自带接入',
    provider: 'openai',
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    thinkingMode: 'disabled',
    thinkingBudget: 1024,
    hasKey: !!rt.apiKey,
  });
  if (hasBlocking(issues)) {
    return { ok: false, provider: 'openai', model: cfg.model, error: blockingMessage(issues) };
  }
  return pingModel(cfg);
}

/** 当前生效模型信息（供 /me 展示）。 */
export async function providerInfo() {
  const cfg = await getAiConfig();
  const eff = effectiveProvider(cfg);
  return {
    provider: cfg.provider,
    model: eff === 'mock' ? 'template' : cfg.model,
    label: cfg.label,
    ready: eff !== 'mock',
    claudeReady: eff === 'claude', // 向后兼容旧字段
  };
}

// —— 内部：以「就绪的 provider」发一次返回原始文本的轻量补全 ——
//
// 这里是**全部辅助抽取的唯一收口**：extractInsights / extractProphecies / summarizeSessionTitle /
// extractGraphTriples / summarizePoints / llmJson / completeJson / structured* 都经由 rawText 或
// rawJson 落到这里。因此「辅助档切小模型」只需在这一处翻译，新增抽取路径自动继承。
//
// allowAux=false 用于调用方**显式指定了 model** 的场景（如评测评委要用独立模型避免自评），
// 那种指定是有意的，不能被辅助档覆盖。
async function rawText(
  cfg: ResolvedAiConfig, live: 'claude' | 'openai', system: string, user: string,
  opts?: {
    allowAux?: boolean; maxTokens?: number; signal?: AbortSignal; usageMeta?: UsageMeta;
    /**
     * 随本次补全一起发的图片（两端 provider 的 raw 出口都已支持，挂在 user 消息上）。
     * 目前唯一调用方是海报 AI 排版引擎的「看图打磨」：把上一版渲染出的成品 PNG 交回模型，
     * 让它像人一样先看画面再改代码。缺省不传 = 纯文本，既有辅助抽取行为零变化。
     */
    images?: { mediaType: string; base64: string }[];
    /**
     * 缺省 **false**（辅助抽取的既定行为，不动）。只有「产物本身要动脑子」的调用方才开：
     * 海报的宣言与整页 HTML 创作属于这一类——上游 canvas-design 在 Claude Code 里就是
     * 长思考之后才动笔的。注意开了之后 Anthropic 会把 temperature 强制为 1（见 thinking.ts），
     * 所以**只有产出格式本身容错的调用方**能开：HTML 有 `<!DOCTYPE` 起始与围栏剥离兜底，
     * 而依赖尾部格式约定的调用方（ask 块那类）绝不能开。
     */
    allowThinking?: boolean;
  },
): Promise<string> {
  // 未配 aux 路由且未配 AI_AUX_MODEL 时原样返回，下面两行等于无操作（默认行为零变化）。
  const useCfg = opts?.allowAux === false ? cfg : await resolveAuxConfigAsync(cfg);
  const useLive: 'claude' | 'openai' = useCfg === cfg
    ? live
    : (useCfg.provider === 'claude' ? 'claude' : 'openai');
  // 用输入摘要做稳定亲和键，既能跨双端点分流，又让同一抽取复用同端点缓存。
  const affinityKey = `aux:${createHash('sha1').update(system).update('\0').update(user).digest('hex').slice(0, 16)}`;

  // 缺省 false = 既有辅助抽取行为一字不变；只有显式要求的调用方（海报创作）才开思考。
  const allowThinking = opts?.allowThinking === true;
  // maxTokens 只在调用方显式要求时传（缺省 undefined → provider 沿用 700 的辅助档预算，行为零变化）。
  //
  // ★ 开思考时必须把 maxTokens 换算成**净正文预算**（chatMaxTokens）：
  //   `max_tokens` 在 Anthropic 协议里管的是「thinking + 正文」的总量，而 provider 侧的
  //   `maxTokensForThinking` 只在 thinkingMode='enabled' 时加预留，**adaptive 档原样返回**。
  //   线上正是 adaptive：于是 12000 全被思考吃掉，接口成功返回但正文是空串 → completeText 返回 null
  //   → 引擎判「模型不可用」→ 整单回落模板。2026-08-12 预发实测到的就是这一格，
  //   现象与 chat 路径当年那个「回复未完整结束」是同一个根因（见 thinking.chatMaxTokens 注释）。
  const mt = opts?.maxTokens
    ? { maxTokens: allowThinking ? chatMaxTokens(opts.maxTokens, useCfg, true) : opts.maxTokens }
    : {};
  const im = opts?.images?.length ? { images: opts.images } : {};
  let out: string;
  if (useLive === 'openai') {
    const { openaiRaw } = await import('./providers/openai.js');
    out = await openaiRaw(useCfg, system, user, { allowThinking, affinityKey, ...mt, ...im, signal: opts?.signal });
  } else {
    const { claudeRaw } = await import('./providers/claude.js');
    out = await claudeRaw(useCfg, system, user, { allowThinking, affinityKey, ...mt, ...im, signal: opts?.signal });
  }
  // 辅助调用（洞察/预言/势研判/履历/汇总/图谱等）此前不入 token_usage → 成本低估。按 kind='aux' 记入基建用量。
  recordAuxUsage(useCfg.model, useLive, `${system}\n${user}`, out, opts?.usageMeta);
  return out;
}

// —— 内部：文本 → JSON 对象（正则抠 {…} + JSON.parse）。既有洞察抽取/汇总沿用此松散口径。 ——
async function rawJson(
  cfg: ResolvedAiConfig, live: 'claude' | 'openai', system: string, user: string,
  opts?: { allowAux?: boolean; maxTokens?: number; signal?: AbortSignal; usageMeta?: UsageMeta },
): Promise<Record<string, unknown> | null> {
  const content = await rawText(cfg, live, system, user, opts);
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * 结构化输出统一原语（借鉴 Vercel AI SDK generateObject / Spring AI StructuredOutputConverter）。
 * 一处收口，取代散落各处的「自拼 system + rawJson + 手写 filter/map/校验」六份脆弱副本：
 * 传入 Zod schema，它同时充当「运行时校验 + TS 返回类型 + 归一化(transform)」的单一真源。
 * 纯逻辑（抠 JSON + 校验）拆到 coerceJson，可零 I/O 单测；provider I/O 与「修复一轮」编排在 structured。
 */
export function coerceJson<S extends z.ZodTypeAny>(schema: S, text: string): { ok: true; data: z.output<S> } | { ok: false; error: string } {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: '未找到 JSON 对象' };
  let raw: unknown;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    // 真实模型偶尔会把客户原话里的英文双引号原样写进 JSON string（未转义），或留下尾逗号。
    // 先严格 parse，只有语法失败才修复；修复后仍必须通过调用方 Zod，摘要层还会继续校验 kind 与批内来源，
    // 因此这里只恢复 JSON 结构，不会把不可信字段升级成事实。
    try { raw = JSON.parse(jsonrepair(m[0])); } catch { return { ok: false, error: 'JSON 解析与修复失败' }; }
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ').slice(0, 300) };
}

/**
 * P1-3 计费口径：结构化生成的「已发生调用信息」。
 * - data：校验通过的结果（成功）；无 live provider / 两轮都没过校验 → null。
 * - attempts：本次实际向真实 provider 发出的调用轮次（0 = 无 live provider，从未触达；1 = 首轮即过或首轮就抛；2 = 走了修复轮）。
 * - live：本次是否触达了真实 provider（据此区分「mock 不计费」与「真实调用但校验失败仍需保守结算」）。
 *
 * 关键：校验失败时 attempts>0 —— 真实 provider 调用已经发生并产生成本，调用方必须按 attempts 保守结算，
 * 不能因为 data=null 就全额退款（这正是 P1-3 要堵的资损口子：过去 structured() 只回 null，调用方 settle(0)）。
 */
export interface StructuredOutcome<T> { data: T | null; attempts: number; live: boolean }

export async function structuredMetered<S extends z.ZodTypeAny>(
  schema: S,
  // maxTokens：产出预算（provider 缺省 700，见 rawText）。**长文 JSON 必须显式给**——
  // 2026-07-30 生产实锤：海报宣言（4-6 段中文 + JSON 壳）被 700 拦腰截断，首轮与纠错轮
  // 一起截，structured 恒 null，AI 排版引擎 100% 回落模板，而错误话术只说「产出不完整」。
  o: {
    system: string; user: string; maxChars?: number; maxTokens?: number; temperature?: number; model?: string;
    signal?: AbortSignal; usageMeta?: UsageMeta;
    /**
     * 单次请求挂钟超时，覆盖全局 `OPENAI_TIMEOUT_MS`（缺省 60s）。与 completeText 上的同名参数同因：
     * 长产出（海报宣言 4–6 段中文 + JSON 壳，还开着思考）跑不进 60s → structured 返回 null →
     * 调用方判「产出不完整」→ 悄悄回落。缺省不传 = 老行为。
     */
    timeoutMs?: number;
  },
): Promise<StructuredOutcome<z.output<S>>> {
  let attempts = 0;
  let live = false;
  try {
    const base = await getAiConfig();
    const lp = liveProvider(base);
    if (!lp) return { data: null, attempts: 0, live: false };
    live = true;
    const cfg: ResolvedAiConfig = (o.temperature != null || o.model || o.timeoutMs)
      ? {
        ...base,
        ...(o.temperature != null ? { temperature: o.temperature } : {}),
        ...(o.model ? { model: o.model } : {}),
        ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
      }
      : base;
    const user = o.user.slice(0, o.maxChars ?? 4000);
    // 调用前自增：即使 rawText 抛错（超时/5xx），provider 侧可能已计费——保守计入本轮。
    attempts++;
    const mt = o.maxTokens ? { maxTokens: o.maxTokens } : {};
    const first = coerceJson(schema, await rawText(cfg, lp, o.system, user, {
      allowAux: !o.model, ...mt, signal: o.signal, usageMeta: o.usageMeta,
    }));
    if (first.ok) return { data: first.data, attempts, live };
    // 一轮修复：把校验错误回喂，要求只输出合规 JSON。
    const repairSys = `${o.system}\n\n【纠错】上次输出无法通过校验：${first.error}。请只输出严格符合要求的 JSON，不要任何解释或多余文字。`;
    attempts++;
    const second = coerceJson(schema, await rawText(cfg, lp, repairSys, user, {
      allowAux: !o.model, ...mt, signal: o.signal, usageMeta: o.usageMeta,
    }));
    return { data: second.ok ? second.data : null, attempts, live };
  } catch (err) {
    console.error('[gateway] structured failed:', (err as Error).message);
    return { data: null, attempts, live };
  }
}

/**
 * P1-3 保守结算口径（纯函数，供路由层把 structuredMetered 结果换算成要 settle 的 token 数；单测锁定）：
 * - ok（校验通过）：按定额 estTokens 结算——「成功时不变」，与既有 quickscan/brandKit 口径一致。
 * - 失败但已发生真实调用（attempts>0）：按 attempts × estTokens 保守扣，覆盖 1-2 轮已花的真实成本，不全额退。
 * - attempts=0（无 live provider / mock 兜底）：0，不实扣。
 */
export function structuredBillTokens(o: { ok: boolean; attempts: number; estTokens: number }): number {
  if (o.ok) return o.estTokens;
  return Math.max(0, o.attempts) * o.estTokens;
}

/**
 * 结构化生成：文本 → schema 校验；失败则把校验错误回喂、只修复一轮；仍失败返回 null（调用方兜底）。
 * 无真实 provider（含测试/mock）或任何异常 → null，绝不伪造（沿用 extractInsights/completeJson 口径）。
 * 非计费消费者（forces/casefile/knowledgePipeline 等）用这个薄封装即可；计费路径改用 structuredMetered 拿 attempts。
 */
export async function structured<S extends z.ZodTypeAny>(
  schema: S,
  o: {
    system: string; user: string; maxChars?: number; maxTokens?: number; temperature?: number; model?: string;
    signal?: AbortSignal; usageMeta?: UsageMeta; timeoutMs?: number;
  },
): Promise<z.output<S> | null> {
  return (await structuredMetered(schema, o)).data;
}

/**
 * **原样文本补全**（raw text，不做 JSON 解析）。骨架照 structuredMetered 抄：
 * `getAiConfig → liveProvider → rawText`，无 live provider（mock / NODE_ENV=test）或任何异常 → `null`，
 * 由调用方兜底 —— 与 `structured` / `completeJson` / `extractInsights` 同一口径，绝不伪造产出。
 *
 * 为什么不复用 `structured()`：产物是**一整页 HTML/CSS**。塞进 JSON string 要转义换行与引号，
 * 模型极易在长文本里破坏转义 → 整份产物因一个反斜杠报废；而 HTML 本身有 `<!DOCTYPE` 起始与
 * 标签闭合，可直接做结构校验，不需要 JSON 这层壳。调用方（海报 AI 排版引擎）自己剥 ``` 围栏。
 *
 * 两个刻意的默认值：
 * · `maxTokens` 默认 4000（`rawText`/provider 的辅助档缺省是 700，会把一页 HTML 拦腰截断）；
 * · `allowAux: false` —— 这不是记忆抽取那类辅助任务，切到小模型等于把「画质」这件事交给最弱的模型。
 *
 * `images` / `allowThinking` 为海报引擎而加（缺省不传 = 老行为）：前者让模型看见自己上一版渲染出的
 * 成品图再改，后者让它动笔前先想（两者的取舍见 rawText 上同名参数的注释）。
 */
export async function completeText(
  system: string,
  user: string,
  o: {
    maxChars?: number; maxTokens?: number; temperature?: number; model?: string;
    images?: { mediaType: string; base64: string }[];
    allowThinking?: boolean;
    /**
     * 单次请求的挂钟超时，覆盖全局 `OPENAI_TIMEOUT_MS`（缺省 60s）。
     *
     * 为海报而加，2026-08-12 预发实测：一整页手写 HTML/CSS（开思考、上万 token 产出，打磨轮还带一张
     * 成品图作输入）**跑不进 60s**——`completeText` 超时返回 null，引擎当成「模型不可用」直接回落模板。
     * 也就是说画质最高的那条路径会被一个与它无关的全局旋钮悄悄掐死。
     * 不改全局值：那个 60s 罩着对话等所有链路，为海报调宽它等于让别的链路陪着一起等。
     * cfg 里改了就够——`llmPool.toCfg` 会把 base 整份铺到每个候选端点上。
     */
    timeoutMs?: number;
  } = {},
): Promise<string | null> {
  const base = await getAiConfig();
  const live = liveProvider(base);
  if (!live) return null;
  const cfg: ResolvedAiConfig = (o.temperature != null || o.model || o.timeoutMs)
    ? {
      ...base,
      ...(o.temperature != null ? { temperature: o.temperature } : {}),
      ...(o.model ? { model: o.model } : {}),
      ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    }
    : base;
  try {
    const text = await rawText(cfg, live, system, user.slice(0, o.maxChars ?? 12_000), {
      allowAux: false,
      maxTokens: o.maxTokens ?? 4000,
      ...(o.images?.length ? { images: o.images } : {}),
      ...(o.allowThinking ? { allowThinking: true } : {}),
    });
    return text.trim() || null;
  } catch (err) {
    console.error('[gateway] completeText failed:', (err as Error).message);
    return null;
  }
}

/** 通用 JSON 补全（评测评委等内部用）：用就绪模型发一次并解析 JSON；未就绪（mock）/失败返回 null。 */
export async function completeJson(
  system: string,
  user: string,
  opts?: { temperature?: number; model?: string; signal?: AbortSignal; usageMeta?: UsageMeta },
): Promise<Record<string, unknown> | null> {
  const base = await getAiConfig();
  const live = liveProvider(base);
  if (!live) return null;
  // P1-A2：允许指定温度（评委评分用 temperature=0 提升可复现性）+ 指定模型（评委用独立模型，避免被测模型自评）。
  const cfg = (opts?.temperature != null || opts?.model)
    ? { ...base, ...(opts.temperature != null ? { temperature: opts.temperature } : {}), ...(opts.model ? { model: opts.model } : {}) }
    : base;
  try {
    // 调用方显式指定 model（评测评委要独立模型避免自评）时不许辅助档覆盖。
    return await rawJson(cfg, live, system, user, { allowAux: !opts?.model, signal: opts?.signal, usageMeta: opts?.usageMeta });
  } catch (err) {
    console.error('[gateway] completeJson failed:', (err as Error).message);
    return null;
  }
}
/**
 * 从文本抽取时序知识图谱三元组（实体 + 关系）。
 * 有真实模型时让模型抽 subject-predicate-object；否则返回空（启发式留给上层，避免误抽）。
 */
export async function extractGraphTriples(
  text: string,
): Promise<{ entities: { name: string; type: string }[]; relations: { subject: string; predicate: string; object: string }[] }> {
  const empty = { entities: [], relations: [] };
  const cfg = await getAiConfig();
  const live = liveProvider(cfg);
  if (!live) return empty;
  try {
    const sys =
      '你是知识图谱抽取器。从文本中抽取「实体」和「关系三元组」，用于构建企业时序知识图谱。' +
      '实体 type 取值：person/org/product/concept/other。关系为 {subject,predicate,object}，' +
      'subject/object 必须是实体 name。只输出 JSON：' +
      '{"entities":[{"name":"","type":""}],"relations":[{"subject":"","predicate":"","object":""}]}。无可抽取则空数组。';
    const json = await rawJson(cfg, live, sys, text.slice(0, 2000));
    if (!json) return empty;
    const entities = ((json.entities as unknown[]) ?? [])
      .filter((e): e is { name: string; type: string } => !!e && typeof (e as { name?: unknown }).name === 'string')
      .map((e) => ({ name: String(e.name).slice(0, 80), type: normEntityType((e as { type?: string }).type) }))
      .slice(0, 20);
    const relations = ((json.relations as unknown[]) ?? [])
      .filter((r): r is { subject: string; predicate: string; object: string } =>
        !!r && typeof (r as { subject?: unknown }).subject === 'string' &&
        typeof (r as { predicate?: unknown }).predicate === 'string' &&
        typeof (r as { object?: unknown }).object === 'string')
      .map((r) => ({ subject: String(r.subject).slice(0, 80), predicate: String(r.predicate).slice(0, 40), object: String(r.object).slice(0, 80) }))
      .slice(0, 30);
    return { entities, relations };
  } catch (err) {
    console.error('[gateway] extractGraphTriples fallback:', (err as Error).message);
    return empty;
  }
}
function normEntityType(t?: string): string {
  return ['person', 'org', 'product', 'concept', 'other'].includes(t ?? '') ? (t as string) : 'other';
}

/** 给汇总服务用：以就绪模型把对话纪要文本归纳成「讨论要点/关键结论/待办」三类。 */
export async function summarizePoints(transcript: string): Promise<{ points: string[]; conclusions: string[]; todos: string[] } | null> {
  const cfg = await getAiConfig();
  const live = liveProvider(cfg);
  if (!live) return null;
  try {
    const sys = '你是会议纪要助手。基于对话整理，只输出 JSON：{"points":["讨论要点…"],"conclusions":["关键结论…"],"todos":["待办/决策…"]}，各 2-5 条、简洁。';
    const json = await rawJson(cfg, live, sys, transcript.slice(0, 4000));
    if (!json) return null;
    const arr = (k: string) => ((json[k] as unknown[]) ?? []).filter((x) => typeof x === 'string').slice(0, 6) as string[];
    return { points: arr('points'), conclusions: arr('conclusions'), todos: arr('todos') };
  } catch (err) {
    console.error('[gateway] summarizePoints fallback:', (err as Error).message);
    return null;
  }
}

/** 会话标题提炼：用一次轻量模型调用把**首轮问答**（用户开场 + 军师第一条回复）概括成不超过 12 字的
 *  中文短标题，替代硬截断。带上回复是因为很多开场只有「帮我看看」「在吗」这种没有信息量的一句，
 *  只喂 user 文本会拟出一个和内容无关的标题；回复里才有本轮真正谈的是什么。
 *  只在真实 provider 就绪时运行（测试/mock 返回 null → 调用方走确定性兜底）；解析失败即放弃。
 *  预算 200 token：标题只有十来个字，给多了纯属让辅助档替正文抢配额。 */
export async function summarizeSessionTitle(userText: string, assistantText?: string): Promise<string | null> {
  const asked = (userText ?? '').trim();
  const answered = (assistantText ?? '').trim();
  if (!asked) return null;
  const cfg = await getAiConfig();
  const live = liveProvider(cfg);
  if (!live) return null;
  try {
    const sys = '你是会话取名助手。把这轮对话概括成一个不超过 12 个字的中文名词短语，作为这次谈话的标题，只保留业务主题。'
      + '不要引号、书名号、句末标点，不要“关于/请教/如何/怎么”之类的虚词开头，不要任何解释或前后缀。'
      + '标题给用户看，语气平实克制，不要“深度/全面/终极”这类推销腔。只输出 JSON：{"title":"…"}。';
    const material = answered ? `用户：${asked.slice(0, 400)}\n军师：${answered.slice(0, 400)}` : `用户：${asked.slice(0, 400)}`;
    const json = await rawJson(cfg, live, sys, material, { maxTokens: SESSION_TITLE_MAX_TOKENS });
    const title = json && typeof json.title === 'string' ? json.title : '';
    return normalizeSessionTitle(title);
  } catch (err) {
    console.error('[gateway] summarizeSessionTitle fallback:', (err as Error).message);
    return null;
  }
}

/** 标题预算：十来个字的产出不需要更多，且它走辅助档、与正文共享上游配额。 */
export const SESSION_TITLE_MAX_TOKENS = 200;
/** 标题上限（字）：产品口径 ≤12 字；模型偶尔超一两个字就直接截，不为此再跑一轮。 */
export const SESSION_TITLE_MAX_CHARS = 12;

/** 标题归一：去首尾引号/书名号/空白 → 去句末标点 → 压掉换行 → 超长截断 → 空串归 null。 */
export function normalizeSessionTitle(raw: string | null | undefined): string | null {
  let title = String(raw ?? '').replace(/\s+/g, ' ').trim();
  // 两类要剥的尾巴会互相遮挡（`《现金流吃紧》。` 的书名号被句号挡在里面），所以剥到不动为止。
  for (let i = 0; i < 4; i++) {
    const before = title;
    title = title.replace(/^[\s"'“”‘’「」『』《》【】]+|[\s"'“”‘’「」『』《》【】]+$/g, '').trim();
    title = title.replace(/[。！？!?.,，、；;：:]+$/, '').trim();
    if (title === before) break;
  }
  if (title.length > SESSION_TITLE_MAX_CHARS) title = title.slice(0, SESSION_TITLE_MAX_CHARS);
  return title || null;
}

/** 预言抽取（M2 PR-9）：从总军师输出里抽「具体、可验证、有期限」的天势判断。
 *  只在真实 provider 就绪时运行（测试/mock 返回空 → 绝不产生伪预言）；解析失败即放弃。
 *  重构：走统一 structured() 原语——Zod schema 取代手写正则 + filter/map/slice。 */
export interface Prophecy { prophecy: string; basis: string; verifyStandard: string; dueDate: string | null }

const PROPHECY_SYS =
  '你是记录员。从下面军师的话里抽取「预言式判断」——必须同时满足：具体（说了会发生什么）、可验证（能对照事实判定）、有大致时限（某月/某周/某节点）。'
  + '只输出 JSON：{"prophecies":[{"prophecy":"…","basis":"依据(可空)","verifyStandard":"什么情况算命中","dueDate":"YYYY-MM-DD 或 null"}]}。'
  + '宽泛建议、方法论、无时限的话都不算预言；没有就输出空数组。最多 2 条。';

// 单条容错到底：缺失/空白/错型不拖垮整批——无效条目归一为 null，由上层过滤（沿用原「filter 掉空 prophecy」口径）。
const ProphecyItem = z
  .object({
    prophecy: z.string(),
    basis: z.string().nullish(),
    verifyStandard: z.string().nullish(),
    dueDate: z.string().nullish(),
  })
  .transform((o): Prophecy => ({
    prophecy: o.prophecy.trim().slice(0, 300),
    basis: (o.basis ?? '').trim().slice(0, 200),
    verifyStandard: (o.verifyStandard ?? '').trim().slice(0, 300),
    dueDate: o.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(o.dueDate) ? o.dueDate : null,
  }))
  .refine((p) => p.prophecy.length > 0)
  .nullable()
  .catch(null);

/** 预言抽取结果 schema（导出供单测）：整批容错，过滤无效条目，最多 2 条。 */
export const ProphecyResult = z.object({
  prophecies: z
    .preprocess((v) => (Array.isArray(v) ? v : []), z.array(ProphecyItem))
    .transform((a) => a.filter((x): x is Prophecy => x !== null).slice(0, 2)),
});

export async function extractProphecies(text: string): Promise<Prophecy[]> {
  const r = await structured(ProphecyResult, { system: PROPHECY_SYS, user: text, maxChars: 3000 });
  return r?.prophecies ?? [];
}
