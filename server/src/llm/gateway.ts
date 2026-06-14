// LLM Gateway（《投产开发指导》§5.1）：统一封装模型调用——
// 路由（mock/claude/openai 兼容，含 Agnes/DeepSeek/Qwen…）、内容审核、Token 计量、结果缓存、故障兜底/降级。
//
// provider 与 baseUrl/model/key 由「运营后台可切换的 DB 配置」决定（services/aiConfig），
// env 仅作兜底；未配置真实 key 时一律降级 mock，保证可用。

import { env, isRealKey } from '../env.js';
import { prisma } from '../db.js';
import { getAiConfig, effectiveProvider, type ResolvedAiConfig } from '../services/aiConfig.js';
import { mockChat, mockDeliverable } from './providers/mock.js';
import { ZERO_USAGE, type Deliverable, type ChatReply, type GenContext, type AiTestResult, type Usage } from './schema.js';
import { recordTokenUsage, type UsageMeta } from '../services/usage.js';

// 当前生效 provider（已就绪才返回 claude/openai，否则 null → mock 兜底）。
function liveProvider(cfg: ResolvedAiConfig): 'claude' | 'openai' | null {
  const eff = effectiveProvider(cfg);
  return eff === 'mock' ? null : eff;
}

// 把「产出 + 真实 token + 来源」打包，便于在输出审核/缓存前统一记账。
type Sourced<T> = { result: T; usage: Usage; provider: string; model: string };

// 仅对真实计费 provider（claude/openai）记账；mock/dify（无 usage）跳过。记账内部 catch，不影响产出。
async function maybeRecord(s: Sourced<unknown>, kind: 'deliverable' | 'chat', ctx: GenContext, meta?: UsageMeta): Promise<void> {
  if (s.provider !== 'claude' && s.provider !== 'openai') return;
  await recordTokenUsage({
    tenantId: meta?.tenantId ?? null,
    userId: meta?.userId ?? null,
    sessionId: meta?.sessionId ?? null,
    agentKey: meta?.agentKey ?? ctx.agentKey ?? null,
    kind,
    provider: s.provider,
    model: s.model,
    usage: s.usage,
  });
}

// —— per-agent 接入覆盖（providerMode=openai/dify）：绕过全局 provider 与结果缓存 ——

// 把 per-agent 自定义 OpenAI 端点并入一个 ResolvedAiConfig（其余沿用全局/默认）。
function openaiOverrideCfg(ctx: GenContext, base: ResolvedAiConfig): ResolvedAiConfig {
  const rt = ctx.runtime!;
  return { ...base, provider: 'openai', baseUrl: rt.baseUrl || base.baseUrl, model: rt.model || base.model, apiKey: rt.apiKey || '' };
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
    const { reply, conversationId } = await difyChat(ctx);
    await persistDifyConversation(ctx, conversationId);
    return { result: reply, usage: ZERO_USAGE, provider: 'dify', model: 'dify' };
  }
  const cfg = openaiOverrideCfg(ctx, await getAiConfig());
  if (!isRealKey(cfg.apiKey)) return { result: mockChat(ctx), usage: ZERO_USAGE, provider: 'mock', model: cfg.model };
  const { openaiChat } = await import('./providers/openai.js');
  const m = await openaiChat(ctx, cfg);
  return { result: m.result, usage: m.usage, provider: 'openai', model: cfg.model };
}

async function runtimeDeliverable(ctx: GenContext): Promise<Sourced<Deliverable>> {
  const rt = ctx.runtime!;
  if (rt.mode === 'dify') {
    const { difyDeliverable } = await import('./providers/dify.js');
    const { deliverable, conversationId } = await difyDeliverable(ctx);
    await persistDifyConversation(ctx, conversationId);
    return { result: deliverable, usage: ZERO_USAGE, provider: 'dify', model: 'dify' };
  }
  const cfg = openaiOverrideCfg(ctx, await getAiConfig());
  if (!isRealKey(cfg.apiKey)) return { result: mockDeliverable(ctx), usage: ZERO_USAGE, provider: 'mock', model: cfg.model };
  const { openaiDeliverable } = await import('./providers/openai.js');
  const m = await openaiDeliverable(ctx, cfg);
  return { result: m.result, usage: m.usage, provider: 'openai', model: cfg.model };
}

// —— 内容审核（演示用关键词；生产替换为合规审核服务） ——
const BLOCK_WORDS = ['暴力', '违法集资', '赌博', '毒品'];

async function moderate(refType: 'input' | 'output', text: string): Promise<boolean> {
  if (!env.moderationEnabled) return true;
  const hit = BLOCK_WORDS.find((w) => text.includes(w));
  const verdict = hit ? 'block' : 'pass';
  await prisma.moderationLog
    .create({ data: { refType, verdict, detailJson: hit ? { word: hit } : {} } })
    .catch(() => {});
  return verdict === 'pass';
}

// —— 算力计量：按次扣费在路由层用 services/credits 完成（产出前校验、成功后扣减）；
//    此处只负责 LLM 调用，不掺计费逻辑。Token 级用量归集留待生产接真实 usage。 ——

// —— 结果缓存（演示用内存缓存；生产用 Redis） ——
const cache = new Map<string, { v: unknown; at: number }>();
const TTL = 5 * 60 * 1000;
function cacheKey(kind: string, ctx: GenContext, cfg: ResolvedAiConfig): string {
  const refSig = (ctx.references?.length ?? 0) + ':' + (ctx.knowledge?.length ?? 0) + ':' + (ctx.memories?.length ?? 0);
  const profileSig = [
    ctx.companyName ?? '',
    ctx.profile?.industry ?? '',
    ctx.profile?.stage ?? '',
    ctx.profile?.pain ?? '',
    ctx.projectName ?? '',
    ctx.understandingMaturity ?? '',
    ctx.understandingQuestions?.length ?? 0,
  ].join('|');
  return `${kind}:${effectiveProvider(cfg)}:${cfg.model}:${ctx.agentKey}:${ctx.deliverableKey ?? ''}:${ctx.userMessage}:${profileSig}:${refSig}`;
}

export async function generateDeliverable(ctx: GenContext, meta?: UsageMeta): Promise<Deliverable> {
  if (!(await moderate('input', ctx.userMessage))) {
    throw Object.assign(new Error('输入未通过内容审核'), { code: 'MODERATION_BLOCK' });
  }

  // per-agent 接入覆盖：绕过全局 provider 与缓存（端点/会话因人/因体而异）。失败兜底 mock。
  if (ctx.runtime) {
    let sourced: Sourced<Deliverable>;
    try {
      sourced = await runtimeDeliverable(ctx);
    } catch (err) {
      console.error('[gateway] runtime deliverable fallback to mock:', (err as Error).message);
      sourced = { result: mockDeliverable(ctx), usage: ZERO_USAGE, provider: 'mock', model: '' };
    }
    await maybeRecord(sourced, 'deliverable', ctx, meta); // 记账早于输出审核：token 已花，审核拦截也要记
    const outText = sourced.result.sections.map((s) => `${s.h} ${s.b ?? ''} ${(s.list ?? []).join(' ')}`).join('\n');
    if (!(await moderate('output', outText))) {
      throw Object.assign(new Error('产出未通过内容审核'), { code: 'MODERATION_BLOCK' });
    }
    return sourced.result;
  }

  const cfg = await getAiConfig();
  const ck = cacheKey('deliverable', ctx, cfg);
  const cached = cache.get(ck);
  if (cached && Date.now() - cached.at < TTL) return cached.v as Deliverable; // 缓存命中：0 token，不记账

  let sourced: Sourced<Deliverable>;
  try {
    const live = liveProvider(cfg);
    if (live === 'claude') {
      const { claudeDeliverable } = await import('./providers/claude.js');
      const m = await claudeDeliverable(ctx, cfg);
      sourced = { result: m.result, usage: m.usage, provider: 'claude', model: cfg.model };
    } else if (live === 'openai') {
      const { openaiDeliverable } = await import('./providers/openai.js');
      const m = await openaiDeliverable(ctx, cfg);
      sourced = { result: m.result, usage: m.usage, provider: 'openai', model: cfg.model };
    } else {
      sourced = { result: mockDeliverable(ctx), usage: ZERO_USAGE, provider: 'mock', model: cfg.model };
    }
  } catch (err) {
    console.error('[gateway] deliverable fallback to mock:', (err as Error).message);
    sourced = { result: mockDeliverable(ctx), usage: ZERO_USAGE, provider: 'mock', model: cfg.model };
  }

  await maybeRecord(sourced, 'deliverable', ctx, meta);
  const outText = sourced.result.sections.map((s) => `${s.h} ${s.b ?? ''} ${(s.list ?? []).join(' ')}`).join('\n');
  if (!(await moderate('output', outText))) {
    throw Object.assign(new Error('产出未通过内容审核'), { code: 'MODERATION_BLOCK' });
  }
  cache.set(ck, { v: sourced.result, at: Date.now() });
  return sourced.result;
}

export async function chatComplete(ctx: GenContext, meta?: UsageMeta): Promise<ChatReply> {
  if (!(await moderate('input', ctx.userMessage))) {
    throw Object.assign(new Error('输入未通过内容审核'), { code: 'MODERATION_BLOCK' });
  }

  // per-agent 接入覆盖：走该智能体自己的端点 / Dify 应用。失败兜底 mock。
  if (ctx.runtime) {
    try {
      const s = await runtimeChat(ctx);
      await maybeRecord(s, 'chat', ctx, meta);
      await moderate('output', s.result.text);
      return s.result;
    } catch (err) {
      console.error('[gateway] runtime chat fallback to mock:', (err as Error).message);
      return mockChat(ctx);
    }
  }

  const cfg = await getAiConfig();
  try {
    const live = liveProvider(cfg);
    if (live) {
      const m =
        live === 'claude'
          ? await (await import('./providers/claude.js')).claudeChat(ctx, cfg)
          : await (await import('./providers/openai.js')).openaiChat(ctx, cfg);
      const s: Sourced<ChatReply> = { result: m.result, usage: m.usage, provider: live, model: cfg.model };
      await maybeRecord(s, 'chat', ctx, meta);
      await moderate('output', s.result.text);
      return s.result;
    }
  } catch (err) {
    console.error('[gateway] chat fallback to mock:', (err as Error).message);
  }
  return mockChat(ctx);
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
  difyBaseUrl?: string; difyApiKey?: string;
}): Promise<AiTestResult> {
  if (rt.mode === 'dify') {
    const { difyPing } = await import('./providers/dify.js');
    const r = await difyPing({ difyBaseUrl: rt.difyBaseUrl, difyApiKey: rt.difyApiKey });
    return { ok: r.ok, latencyMs: r.latencyMs, sample: r.sample, error: r.error, provider: 'dify', model: 'chat-messages' };
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
