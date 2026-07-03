// LLM Gateway（《投产开发指导》§5.1）：统一封装模型调用——
// 路由（mock/claude/openai 兼容，含 Agnes/DeepSeek/Qwen…）、内容审核、Token 计量、结果缓存、故障兜底/降级。
//
// provider 与 baseUrl/model/key 由「运营后台可切换的 DB 配置」决定（services/aiConfig），
// env 仅作兜底；未配置真实 key 时一律降级 mock，保证可用。

import { createHash } from 'node:crypto';
import { env, isRealKey, isAiTestMode } from '../env.js';
import { prisma } from '../db.js';
import { getAiConfig, effectiveProvider, type ResolvedAiConfig } from '../services/aiConfig.js';
import { mockChat, mockDeliverable, mockAdaptive } from './providers/mock.js';
import { ZERO_USAGE, type Deliverable, type ChatReply, type GenContext, type AiTestResult, type Usage } from './schema.js';
import { recordTokenUsage, type UsageMeta } from '../services/usage.js';
import { recordTrace } from '../services/trace.js';
import { moderate } from '../services/moderation.js';
import { auditBannedWords } from '../services/bannedWords.js';
import { cacheGet, cacheSet } from '../services/cache.js';

// 当前生效 provider（已就绪才返回 claude/openai，否则 null → mock 兜底）。
function liveProvider(cfg: ResolvedAiConfig): 'claude' | 'openai' | null {
  if (isAiTestMode()) return null; // 测试一律 mock，不触达真实 provider
  const eff = effectiveProvider(cfg);
  return eff === 'mock' ? null : eff;
}

// 真实 provider 调用失败：生产（AI_FALLBACK_MOCK=false）不静默兜底 mock，抛错让前端提示重试，避免答非所问。
function aiUnavailable(err: unknown): Error {
  const aborted = /abort/i.test((err as Error)?.message || '');
  return Object.assign(
    new Error(aborted ? 'AI 响应超时，请稍后重试' : 'AI 服务暂时不可用，请稍后重试'),
    { code: 'AI_UNAVAILABLE', statusCode: 503 },
  );
}

// 把「产出 + 真实 token + 来源」打包，便于在输出审核/缓存前统一记账。
// toolCalls/iterations：启用技能的工具调用循环才有，供可观测 trace 记录。
type Sourced<T> = { result: T; usage: Usage; provider: string; model: string; toolCalls?: number; iterations?: number };

function deliverableText(d: Deliverable): string {
  return d.sections.map((s) => `${s.h} ${s.b ?? ''} ${(s.list ?? []).join(' ')}`).join('\n');
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
  try {
    const s = await run();
    await recordTrace({
      meta: args.meta, agentKey: args.ctx.agentKey, versionId: args.ctx.versionId, kind: args.kind, provider: s.provider, model: s.model,
      status: 'ok', latencyMs: Date.now() - t0, toolCalls: s.toolCalls, iterations: s.iterations, usage: s.usage,
      promptText: args.ctx.userMessage, responseText: args.respText(s.result),
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
      meta: args.meta, agentKey: args.ctx.agentKey, versionId: args.ctx.versionId, kind: args.kind, provider: args.provider, model: '',
      status: 'error', errorMessage: (err as Error).message, latencyMs: Date.now() - t0, promptText: args.ctx.userMessage,
    });
    throw err;
  }
}

// 对真实计费 provider（claude/openai/dify）记账；mock 与 0-token（缓存命中）跳过。记账内部 catch，不影响产出。
async function maybeRecord(s: Sourced<unknown>, kind: 'deliverable' | 'chat', ctx: GenContext, meta?: UsageMeta): Promise<void> {
  if (meta?.sandbox) return; // 沙盒试跑不计入 token_usage（诊断 trace 仍由 traced() 记录）
  if (s.provider !== 'claude' && s.provider !== 'openai' && s.provider !== 'dify') return;
  await recordTokenUsage({
    tenantId: meta?.tenantId ?? null,
    userId: meta?.userId ?? null,
    sessionId: meta?.sessionId ?? null,
    agentKey: meta?.agentKey ?? ctx.agentKey ?? null,
    kind,
    provider: s.provider,
    model: s.model,
    usage: s.usage,
    // 本次扣的月度额度 = ceil(真实token × ratio)，写入 token_usage 作为后台消耗明细口径
    creditCost: Math.ceil((Math.max(0, s.usage.inputTokens) + Math.max(0, s.usage.outputTokens)) * (meta?.ratio ?? 1)),
  });
}

// —— per-agent 接入覆盖（providerMode=openai/dify）：绕过全局 provider 与结果缓存 ——

// 把 per-agent 自定义 OpenAI 端点并入一个 ResolvedAiConfig（其余沿用全局/默认）。
function openaiOverrideCfg(ctx: GenContext, base: ResolvedAiConfig): ResolvedAiConfig {
  const rt = ctx.runtime!;
  return { ...base, provider: 'openai', baseUrl: rt.baseUrl || base.baseUrl, model: rt.model || base.model, apiKey: rt.apiKey || '', temperature: rt.temperature ?? base.temperature };
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
  if (!isRealKey(cfg.apiKey)) return { result: mockChat(ctx), usage: ZERO_USAGE, provider: 'mock', model: cfg.model };
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
  if (!isRealKey(cfg.apiKey)) return { result: mockDeliverable(ctx), usage: ZERO_USAGE, provider: 'mock', model: cfg.model };
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
function contentSig(parts: (string | null | undefined)[]): string {
  return createHash('sha1').update(parts.map((p) => p ?? '').join(' ')).digest('hex').slice(0, 16);
}
function cacheKey(kind: string, ctx: GenContext, cfg: ResolvedAiConfig): string {
  // P0-1：引用/知识/记忆/理解按**内容哈希**入键，而非仅条数——否则同租户不同用户、条数偶合即串数据。
  const ctxSig = contentSig([
    ...(ctx.references ?? []),
    ...(ctx.knowledge ?? []),
    ...(ctx.memories ?? []),
    ...(ctx.understanding ?? []),
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

export async function generateDeliverable(ctx: GenContext, meta?: UsageMeta): Promise<{ result: Deliverable; usage: Usage }> {
  if (!(await moderate('input', ctx.userMessage, modOpts(ctx, meta)))) {
    throw Object.assign(new Error('输入未通过内容审核'), { code: 'MODERATION_BLOCK' });
  }

  // per-agent 接入覆盖：绕过全局 provider 与缓存（端点/会话因人/因体而异）。失败兜底 mock。
  if (ctx.runtime) {
    let sourced: Sourced<Deliverable>;
    try {
      sourced = await traced(() => runtimeDeliverable(ctx), { kind: 'deliverable', ctx, meta, provider: ctx.runtime.mode === 'dify' ? 'dify' : 'openai', respText: deliverableText });
    } catch (err) {
      console.error('[gateway] runtime deliverable fallback to mock:', (err as Error).message);
      if (!env.aiFallbackMock) throw aiUnavailable(err);
      sourced = { result: mockDeliverable(ctx), usage: ZERO_USAGE, provider: 'mock', model: '' };
    }
    await maybeRecord(sourced, 'deliverable', ctx, meta); // 记账早于输出审核：token 已花，审核拦截也要记
    const outText = sourced.result.sections.map((s) => `${s.h} ${s.b ?? ''} ${(s.list ?? []).join(' ')}`).join('\n');
    if (!(await moderate('output', outText, modOpts(ctx, meta)))) {
      throw Object.assign(new Error('产出未通过内容审核'), { code: 'MODERATION_BLOCK' });
    }
    return { result: sourced.result, usage: sourced.usage };
  }

  const cfg = await getAiConfig();
  const live = liveProvider(cfg);
  // P1-D1：技能启用 + openai/claude 均走工具调用循环（此前只 openai，claude 静默失效）。
  const tools = (live === 'openai' || live === 'claude') ? await skillToolsFor(ctx) : [];
  // 工具产出依赖实时检索/记忆/HTTP 结果，不走结果缓存。
  const ck = cacheKey('deliverable', ctx, cfg);
  if (!tools.length) {
    const cached = await cacheGet<Deliverable>(ck);
    if (cached) return { result: cached, usage: ZERO_USAGE }; // 缓存命中：0 token，不计额度（启用技能不缓存）
  }

  let sourced: Sourced<Deliverable>;
  try {
    sourced = await traced(async () => {
      if (live === 'claude') {
        const cl = await import('./providers/claude.js');
        const m = tools.length ? await cl.claudeDeliverableWithTools(ctx, cfg, tools) : await cl.claudeDeliverable(ctx, cfg);
        const mt = m as { toolCalls?: number; iterations?: number };
        return { result: m.result, usage: m.usage, provider: 'claude', model: cfg.model, toolCalls: mt.toolCalls, iterations: mt.iterations };
      }
      if (live === 'openai') {
        const oa = await import('./providers/openai.js');
        const m = tools.length ? await oa.openaiDeliverableWithTools(ctx, cfg, tools) : await oa.openaiDeliverable(ctx, cfg);
        const mt = m as { toolCalls?: number; iterations?: number };
        return { result: m.result, usage: m.usage, provider: 'openai', model: cfg.model, toolCalls: mt.toolCalls, iterations: mt.iterations };
      }
      return { result: mockDeliverable(ctx), usage: ZERO_USAGE, provider: 'mock', model: cfg.model };
    }, { kind: 'deliverable', ctx, meta, provider: live ?? 'mock', respText: deliverableText });
  } catch (err) {
    console.error('[gateway] deliverable fallback to mock:', (err as Error).message);
    if (!env.aiFallbackMock) throw aiUnavailable(err);
    sourced = { result: mockDeliverable(ctx), usage: ZERO_USAGE, provider: 'mock', model: cfg.model };
  }

  await maybeRecord(sourced, 'deliverable', ctx, meta);
  const outText = sourced.result.sections.map((s) => `${s.h} ${s.b ?? ''} ${(s.list ?? []).join(' ')}`).join('\n');
  if (!(await moderate('output', outText, modOpts(ctx, meta)))) {
    throw Object.assign(new Error('产出未通过内容审核'), { code: 'MODERATION_BLOCK' });
  }
  if (!tools.length) await cacheSet(ck, sourced.result, CACHE_TTL);
  return { result: sourced.result, usage: sourced.usage };
}

export async function chatComplete(ctx: GenContext, meta?: UsageMeta): Promise<{ result: ChatReply; usage: Usage }> {
  if (!(await moderate('input', ctx.userMessage, modOpts(ctx, meta)))) {
    throw Object.assign(new Error('输入未通过内容审核'), { code: 'MODERATION_BLOCK' });
  }

  // per-agent 接入覆盖：走该智能体自己的端点 / Dify 应用。失败兜底 mock。
  if (ctx.runtime) {
    let s: Sourced<ChatReply>;
    try {
      s = await traced(() => runtimeChat(ctx), { kind: 'chat', ctx, meta, provider: ctx.runtime.mode === 'dify' ? 'dify' : 'openai', respText: (r) => r.text });
      await maybeRecord(s, 'chat', ctx, meta);
    } catch (err) {
      console.error('[gateway] runtime chat fallback to mock:', (err as Error).message);
      if (!env.aiFallbackMock) throw aiUnavailable(err);
      return { result: mockChat(ctx), usage: ZERO_USAGE };
    }
    if (!(await moderate('output', s.result.text, modOpts(ctx, meta)))) {
      throw Object.assign(new Error('产出未通过内容审核'), { code: 'MODERATION_BLOCK' });
    }
    return { result: s.result, usage: s.usage };
  }

  const cfg = await getAiConfig();
  let chatResult: Sourced<ChatReply> | null = null;
  try {
    const live = liveProvider(cfg);
    if (live) {
      const tools = (live === 'openai' || live === 'claude') ? await skillToolsFor(ctx) : []; // P1-D1：openai/claude 均支持工具
      const s = await traced(async () => {
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
    if (!env.aiFallbackMock) throw aiUnavailable(err);
  }
  if (chatResult) {
    if (!(await moderate('output', chatResult.result.text, modOpts(ctx, meta)))) {
      throw Object.assign(new Error('产出未通过内容审核'), { code: 'MODERATION_BLOCK' });
    }
    return { result: chatResult.result, usage: chatResult.usage };
  }
  return { result: mockChat(ctx), usage: ZERO_USAGE };
}

export type ChatStreamEvent =
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

/**
 * P1-B3：聊天流式（渐进渲染）。内容审核是硬约束 → 绝不流式下发未审核的 token，
 * 故必须先拿到「经输入+输出审核的完整结果」再分块推送。复用 chatComplete（审核/计费/trace/provider 分发全在内，
 * 零重复、零安全回退），按真实节奏分块，去掉假 sleep 剧场。
 * 注：real-provider 的「模型 token 级增量」为后续（需 provider SDK 原生流式 + 真机 QA）；
 * 在「必须先审核全量」的产品约束下，渐进渲染已审核结果才是正确架构。
 */
export async function* chatCompleteStream(ctx: GenContext, meta?: UsageMeta): AsyncGenerator<ChatStreamEvent> {
  const { result, usage } = await chatComplete(ctx, meta);
  for (const piece of chunkText(result.text)) yield { type: 'delta', text: piece };
  yield { type: 'done', result, usage };
}

export type AdaptiveResult =
  | { kind: 'report'; deliverable: Deliverable; usage: Usage }
  | { kind: 'chat'; reply: ChatReply; usage: Usage };

/**
 * 按需产出（skillsConfig.deliverableMode='on-demand'）：模型自行决定本轮出结构化报告还是文本对话。
 * 仅全局 openai 与 mock 支持「自适应」；claude / per-agent runtime 暂回退为对话（避免误出空报告）。
 */
export async function generateAdaptive(ctx: GenContext, meta?: UsageMeta): Promise<AdaptiveResult> {
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
      return { kind: 'chat', reply: mockChat(ctx), usage: ZERO_USAGE };
    }
    if (!(await moderate('output', s.result.text, modOpts(ctx, meta)))) {
      throw Object.assign(new Error('产出未通过内容审核'), { code: 'MODERATION_BLOCK' });
    }
    return { kind: 'chat', reply: s.result, usage: s.usage };
  }

  const cfg = await getAiConfig();
  const live = liveProvider(cfg);
  const t0 = Date.now();
  let out: { kind: 'report'; result: Deliverable } | { kind: 'chat'; result: ChatReply };
  let provider = 'mock';
  const model = cfg.model;
  let toolCalls: number | undefined;
  let iterations: number | undefined;
  let usage: Usage = ZERO_USAGE;

  try {
    if (live === 'openai') {
      const oa = await import('./providers/openai.js');
      const tools = await skillToolsFor(ctx);
      const m = await oa.openaiAdaptive(ctx, cfg, tools);
      provider = 'openai'; usage = m.usage; toolCalls = m.toolCalls; iterations = m.iterations;
      out = m.kind === 'report' ? { kind: 'report', result: m.deliverable } : { kind: 'chat', result: m.reply };
    } else if (live === 'claude') {
      const cl = await import('./providers/claude.js');
      const tools = await skillToolsFor(ctx);
      const m = await cl.claudeAdaptive(ctx, cfg, tools);
      provider = 'claude'; usage = m.usage; toolCalls = m.toolCalls; iterations = m.iterations;
      out = m.kind === 'report' ? { kind: 'report', result: m.deliverable } : { kind: 'chat', result: m.reply };
    } else {
      const m = mockAdaptive(ctx);
      out = m.kind === 'report' ? { kind: 'report', result: m.deliverable } : { kind: 'chat', result: m.reply };
    }
  } catch (err) {
    await recordTrace({
      meta, agentKey: ctx.agentKey, versionId: ctx.versionId, kind: 'chat', provider: live ?? 'mock', model: '',
      status: 'error', errorMessage: (err as Error).message, latencyMs: Date.now() - t0, promptText: ctx.userMessage,
    });
    console.error('[gateway] adaptive fallback to mock:', (err as Error).message);
    if (!env.aiFallbackMock) throw aiUnavailable(err);
    const m = mockAdaptive(ctx);
    provider = 'mock'; usage = ZERO_USAGE; toolCalls = undefined; iterations = undefined;
    out = m.kind === 'report' ? { kind: 'report', result: m.deliverable } : { kind: 'chat', result: m.reply };
  }

  const respText = out.kind === 'report' ? deliverableText(out.result) : out.result.text;
  const recKind: 'deliverable' | 'chat' = out.kind === 'report' ? 'deliverable' : 'chat';
  await recordTrace({
    meta, agentKey: ctx.agentKey, kind: recKind, provider, model,
    status: 'ok', latencyMs: Date.now() - t0, toolCalls, iterations, usage,
    promptText: ctx.userMessage, responseText: respText,
  });
  await maybeRecord({ result: out.result, usage, provider, model, toolCalls, iterations }, recKind, ctx, meta);

  if (!(await moderate('output', respText, modOpts(ctx, meta)))) throw Object.assign(new Error('产出未通过内容审核'), { code: 'MODERATION_BLOCK' });

  return out.kind === 'report'
    ? { kind: 'report', deliverable: out.result, usage }
    : { kind: 'chat', reply: out.result, usage };
}

/**
 * 从对话文本提炼结构化「洞察」（Learned Memory）。
 * 有真实模型时让模型抽取 1–3 条事实/偏好/决策；否则启发式兜底（截断原文）。
 */
export async function extractInsights(text: string, agentName?: string): Promise<string[]> {
  const fallback = () => {
    const t = text.trim().slice(0, 120);
    return t ? [`用户在对话中提到：${t}`] : [];
  };
  const cfg = await getAiConfig();
  const live = liveProvider(cfg);
  if (!live) return fallback();
  try {
    const sys =
      '你是记忆抽取器。从用户消息中提炼 1-3 条对长期服务该客户有价值的「洞察」（事实/偏好/决策/约束），' +
      '每条一句话、可独立理解、不含寒暄。只输出 JSON：{"insights":["...","..."]}。无可提炼则 {"insights":[]}。';
    const json = await rawJson(cfg, live, sys, text.slice(0, 1500));
    const arr = (json?.insights as unknown[])?.filter((x) => typeof x === 'string') as string[];
    if (arr?.length) return arr.slice(0, 3).map((s) => s.slice(0, 160));
    return fallback();
  } catch (err) {
    console.error('[gateway] extractInsights fallback:', (err as Error).message);
    return fallback();
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
  const cfg: ResolvedAiConfig = { ...base, provider: 'openai', baseUrl: rt.baseUrl || base.baseUrl, model: rt.model || base.model, apiKey: rt.apiKey || '' };
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

// —— 内部：以「就绪的 provider」发一次返回 JSON 的轻量补全（用于洞察抽取/汇总） ——
async function rawJson(
  cfg: ResolvedAiConfig, live: 'claude' | 'openai', system: string, user: string,
): Promise<Record<string, unknown> | null> {
  let content = '';
  if (live === 'openai') {
    const { openaiRaw } = await import('./providers/openai.js');
    content = await openaiRaw(cfg, system, user);
  } else {
    const { claudeRaw } = await import('./providers/claude.js');
    content = await claudeRaw(cfg, system, user);
  }
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/** 通用 JSON 补全（评测评委等内部用）：用就绪模型发一次并解析 JSON；未就绪（mock）/失败返回 null。 */
export async function completeJson(system: string, user: string, opts?: { temperature?: number; model?: string }): Promise<Record<string, unknown> | null> {
  const base = await getAiConfig();
  const live = liveProvider(base);
  if (!live) return null;
  // P1-A2：允许指定温度（评委评分用 temperature=0 提升可复现性）+ 指定模型（评委用独立模型，避免被测模型自评）。
  const cfg = (opts?.temperature != null || opts?.model)
    ? { ...base, ...(opts.temperature != null ? { temperature: opts.temperature } : {}), ...(opts.model ? { model: opts.model } : {}) }
    : base;
  try {
    return await rawJson(cfg, live, system, user);
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

/** 预言抽取（M2 PR-9）：从总军师输出里抽「具体、可验证、有期限」的天势判断。
 *  只在真实 provider 就绪时运行（测试/mock 返回空 → 绝不产生伪预言）；解析失败即放弃。 */
export async function extractProphecies(text: string): Promise<{ prophecy: string; basis: string; verifyStandard: string; dueDate: string | null }[]> {
  const cfg = await getAiConfig();
  const live = liveProvider(cfg);
  if (!live) return [];
  try {
    const sys = '你是记录员。从下面军师的话里抽取「预言式判断」——必须同时满足：具体（说了会发生什么）、可验证（能对照事实判定）、有大致时限（某月/某周/某节点）。'
      + '只输出 JSON：{"prophecies":[{"prophecy":"…","basis":"依据(可空)","verifyStandard":"什么情况算命中","dueDate":"YYYY-MM-DD 或 null"}]}。'
      + '宽泛建议、方法论、无时限的话都不算预言；没有就输出空数组。最多 2 条。';
    const json = await rawJson(cfg, live, sys, text.slice(0, 3000));
    if (!json) return [];
    return (((json.prophecies as unknown[]) ?? [])
      .filter((p): p is { prophecy: string } => !!p && typeof (p as { prophecy?: unknown }).prophecy === 'string' && !!(p as { prophecy: string }).prophecy.trim())
      .map((p) => {
        const o = p as { prophecy: string; basis?: string; verifyStandard?: string; dueDate?: string | null };
        const due = typeof o.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.dueDate) ? o.dueDate : null;
        return {
          prophecy: o.prophecy.trim().slice(0, 300),
          basis: (o.basis ?? '').trim().slice(0, 200),
          verifyStandard: (o.verifyStandard ?? '').trim().slice(0, 300),
          dueDate: due,
        };
      })
      .slice(0, 2));
  } catch (err) {
    console.error('[gateway] extractProphecies fallback:', (err as Error).message);
    return [];
  }
}
