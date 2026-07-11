// LLM Gateway（《投产开发指导》§5.1）：统一封装模型调用——
// 路由（mock/claude/openai 兼容，含 Agnes/DeepSeek/Qwen…）、输入审核、Token 计量、结果缓存、故障兜底/降级。
//
// provider 与 baseUrl/model/key 由「运营后台可切换的 DB 配置」决定（services/aiConfig），
// env 仅作兜底；未配置真实 key 时一律降级 mock，保证可用。

import { createHash } from 'node:crypto';
import { z } from 'zod';
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

/**
 * 供 rawJson 系调用方（extractGraphTriples/summarizePoints 等不回传真实 token 用量）判断：
 * 本次是否会真正触达真实模型。未就绪（mock/测试）时这些函数直接短路返回空，不产生真实成本，
 * 调用方应据此把预留的额度全额退回，而非按估算定额扣费（避免 mock/demo 环境误扣真实用户额度）。
 */
export async function hasLiveProvider(): Promise<boolean> {
  const cfg = await getAiConfig();
  return liveProvider(cfg) !== null;
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

const ENGINEERING_CONTEXT_LEAK =
  /(当前工作区|工作区中未发现|Git\s*仓库|代码仓库|代码项目|代码库|本地仓库|缺少[^。；\n]*(项目文档|业务数据|战略输入材料)|未发现[^。；\n]*(项目文档|业务文档|业务数据|战略规划材料)|上传[^。；\n]*工作区|README|package\.json|Codex|IDE|文件系统|workspace|repository|codebase)/i;

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
  return { ...mockDeliverable(ctx), degraded: true };
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
    sourced.result = sanitizeDeliverable(ctx, sourced.result);
    await maybeRecord(sourced, 'deliverable', ctx, meta);
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

  sourced.result = sanitizeDeliverable(ctx, sourced.result);
  await maybeRecord(sourced, 'deliverable', ctx, meta);
  if (!tools.length) await cacheSet(ck, sourced.result, CACHE_TTL);
  return { result: sourced.result, usage: sourced.usage };
}

export async function chatComplete(ctx: GenContext, meta?: UsageMeta, opts?: { inputModerated?: boolean }): Promise<{ result: ChatReply; usage: Usage }> {
  if (!opts?.inputModerated && !(await moderate('input', ctx.userMessage, modOpts(ctx, meta)))) {
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

async function* chunkedChatFallback(ctx: GenContext, meta?: UsageMeta, inputModerated = false): AsyncGenerator<ChatStreamEvent> {
  const { result, usage } = await chatComplete(ctx, meta, { inputModerated });
  for (const piece of chunkText(result.text)) yield { type: 'delta', text: piece };
  yield { type: 'done', result, usage };
}

async function* tracedChatProviderStream(
  ctx: GenContext,
  meta: UsageMeta | undefined,
  provider: 'openai' | 'claude',
  model: string,
  stream: AsyncGenerator<ChatStreamEvent>,
): AsyncGenerator<ChatStreamEvent> {
  const t0 = Date.now();
  let text = '';
  let done: { result: ChatReply; usage: Usage } | null = null;
  try {
    for await (const ev of stream) {
      if (ev.type === 'delta') {
        text += ev.text;
        yield ev;
      } else {
        done = { result: ev.result, usage: ev.usage };
      }
    }
    if (!done) throw Object.assign(new Error(`${provider} 流式响应未返回完整结果`), { code: 'AI_EMPTY_RESPONSE' });
    await recordTrace({
      meta, agentKey: ctx.agentKey, versionId: ctx.versionId, kind: 'chat', provider, model,
      status: 'ok', latencyMs: Date.now() - t0, usage: done.usage,
      promptText: ctx.userMessage, responseText: done.result.text,
    });
    void auditBannedWords({
      tenantId: meta?.tenantId ?? ctx.tenantId ?? null,
      userId: meta?.userId ?? ctx.userId ?? null,
      sessionId: meta?.sessionId ?? null,
      agentKey: ctx.agentKey,
      kind: 'chat',
      text: done.result.text,
    });
    await maybeRecord({ result: done.result, usage: done.usage, provider, model }, 'chat', ctx, meta);
    yield { type: 'done', result: done.result, usage: done.usage };
  } catch (err) {
    await recordTrace({
      meta, agentKey: ctx.agentKey, versionId: ctx.versionId, kind: 'chat', provider, model,
      status: 'error', errorMessage: (err as Error).message, latencyMs: Date.now() - t0, promptText: ctx.userMessage,
      responseText: text,
    });
    throw err;
  }
}

/**
 * 聊天流式：只在输入侧做审核；合规后优先走 provider 原生 streaming，模型 token/chunk 到达即下发。
 * 若当前路径暂不支持原生流（Dify、工具调用循环、mock、兼容网关不支持 stream），退回完整结果后分块，保证可用。
 */
export async function* chatCompleteStream(ctx: GenContext, meta?: UsageMeta): AsyncGenerator<ChatStreamEvent> {
  if (!(await moderate('input', ctx.userMessage, modOpts(ctx, meta)))) {
    throw Object.assign(new Error('输入未通过内容审核'), { code: 'MODERATION_BLOCK' });
  }

  let emitted = false;
  try {
    if (ctx.runtime?.mode === 'openai') {
      const cfg = openaiOverrideCfg(ctx, await getAiConfig());
      const tools = await skillToolsFor(ctx);
      if (isRealKey(cfg.apiKey) && !tools.length) {
        const oa = await import('./providers/openai.js');
        for await (const ev of tracedChatProviderStream(ctx, meta, 'openai', cfg.model, oa.openaiChatStream(ctx, cfg))) {
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
      if (live === 'openai' && !tools.length) {
        const oa = await import('./providers/openai.js');
        for await (const ev of tracedChatProviderStream(ctx, meta, 'openai', cfg.model, oa.openaiChatStream(ctx, cfg))) {
          if (ev.type === 'delta') emitted = true;
          yield ev;
        }
        return;
      }
      if (live === 'claude' && !tools.length) {
        const cl = await import('./providers/claude.js');
        for await (const ev of tracedChatProviderStream(ctx, meta, 'claude', cfg.model, cl.claudeChatStream(ctx, cfg))) {
          if (ev.type === 'delta') emitted = true;
          yield ev;
        }
        return;
      }
    }
  } catch (err) {
    if (emitted) throw err;
    console.error('[gateway] native chat stream fallback:', (err as Error).message);
    if (!env.aiFallbackMock) {
      // 保持老行为：流式握手失败时仍尝试非流式 provider；若 provider 真不可用，chatComplete 会抛 AI_UNAVAILABLE。
    }
  }

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

  const recKind: 'deliverable' | 'chat' = out.kind === 'report' ? 'deliverable' : 'chat';
  if (out.kind === 'report') out.result = sanitizeDeliverable(ctx, out.result);
  const respText = out.kind === 'report' ? deliverableText(out.result) : out.result.text;
  await recordTrace({
    meta, agentKey: ctx.agentKey, kind: recKind, provider, model,
    status: 'ok', latencyMs: Date.now() - t0, toolCalls, iterations, usage,
    promptText: ctx.userMessage, responseText: respText,
  });
  await maybeRecord({ result: out.result, usage, provider, model, toolCalls, iterations }, recKind, ctx, meta);

  return out.kind === 'report'
    ? { kind: 'report', deliverable: out.result, usage }
    : { kind: 'chat', reply: out.result, usage };
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

// —— 内部：以「就绪的 provider」发一次返回原始文本的轻量补全 ——
async function rawText(
  cfg: ResolvedAiConfig, live: 'claude' | 'openai', system: string, user: string,
): Promise<string> {
  if (live === 'openai') {
    const { openaiRaw } = await import('./providers/openai.js');
    return openaiRaw(cfg, system, user);
  }
  const { claudeRaw } = await import('./providers/claude.js');
  return claudeRaw(cfg, system, user);
}

// —— 内部：文本 → JSON 对象（正则抠 {…} + JSON.parse）。既有洞察抽取/汇总沿用此松散口径。 ——
async function rawJson(
  cfg: ResolvedAiConfig, live: 'claude' | 'openai', system: string, user: string,
): Promise<Record<string, unknown> | null> {
  const content = await rawText(cfg, live, system, user);
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
  try { raw = JSON.parse(m[0]); } catch { return { ok: false, error: 'JSON 解析失败' }; }
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
  o: { system: string; user: string; maxChars?: number; temperature?: number; model?: string },
): Promise<StructuredOutcome<z.output<S>>> {
  let attempts = 0;
  let live = false;
  try {
    const base = await getAiConfig();
    const lp = liveProvider(base);
    if (!lp) return { data: null, attempts: 0, live: false };
    live = true;
    const cfg: ResolvedAiConfig = (o.temperature != null || o.model)
      ? { ...base, ...(o.temperature != null ? { temperature: o.temperature } : {}), ...(o.model ? { model: o.model } : {}) }
      : base;
    const user = o.user.slice(0, o.maxChars ?? 4000);
    // 调用前自增：即使 rawText 抛错（超时/5xx），provider 侧可能已计费——保守计入本轮。
    attempts++;
    const first = coerceJson(schema, await rawText(cfg, lp, o.system, user));
    if (first.ok) return { data: first.data, attempts, live };
    // 一轮修复：把校验错误回喂，要求只输出合规 JSON。
    const repairSys = `${o.system}\n\n【纠错】上次输出无法通过校验：${first.error}。请只输出严格符合要求的 JSON，不要任何解释或多余文字。`;
    attempts++;
    const second = coerceJson(schema, await rawText(cfg, lp, repairSys, user));
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
  o: { system: string; user: string; maxChars?: number; temperature?: number; model?: string },
): Promise<z.output<S> | null> {
  return (await structuredMetered(schema, o)).data;
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
