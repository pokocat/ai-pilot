// LLM Gateway（《投产开发指导》§5.1）：统一封装模型调用——
// 路由（mock/claude/openai 兼容，含 Agnes/DeepSeek/Qwen…）、内容审核、Token 计量、结果缓存、故障兜底/降级。
//
// provider 与 baseUrl/model/key 由「运营后台可切换的 DB 配置」决定（services/aiConfig），
// env 仅作兜底；未配置真实 key 时一律降级 mock，保证可用。

import { env } from '../env.js';
import { prisma } from '../db.js';
import { getAiConfig, effectiveProvider, type ResolvedAiConfig } from '../services/aiConfig.js';
import { mockChat, mockDeliverable } from './providers/mock.js';
import type { Deliverable, ChatReply, GenContext, AiTestResult } from './schema.js';

// 当前生效 provider（已就绪才返回 claude/openai，否则 null → mock 兜底）。
function liveProvider(cfg: ResolvedAiConfig): 'claude' | 'openai' | null {
  const eff = effectiveProvider(cfg);
  return eff === 'mock' ? null : eff;
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
  const refSig = (ctx.references?.length ?? 0) + ':' + (ctx.knowledge?.length ?? 0);
  const profileSig = [
    ctx.companyName ?? '',
    ctx.profile?.industry ?? '',
    ctx.profile?.stage ?? '',
    ctx.profile?.pain ?? '',
    ctx.projectName ?? '',
  ].join('|');
  return `${kind}:${effectiveProvider(cfg)}:${cfg.model}:${ctx.agentKey}:${ctx.deliverableKey ?? ''}:${ctx.userMessage}:${profileSig}:${refSig}`;
}

export async function generateDeliverable(ctx: GenContext): Promise<Deliverable> {
  if (!(await moderate('input', ctx.userMessage))) {
    throw Object.assign(new Error('输入未通过内容审核'), { code: 'MODERATION_BLOCK' });
  }
  const cfg = await getAiConfig();
  const ck = cacheKey('deliverable', ctx, cfg);
  const cached = cache.get(ck);
  if (cached && Date.now() - cached.at < TTL) return cached.v as Deliverable;

  let result: Deliverable;
  try {
    const live = liveProvider(cfg);
    if (live === 'claude') {
      const { claudeDeliverable } = await import('./providers/claude.js');
      result = await claudeDeliverable(ctx, cfg);
    } else if (live === 'openai') {
      const { openaiDeliverable } = await import('./providers/openai.js');
      result = await openaiDeliverable(ctx, cfg);
    } else {
      result = mockDeliverable(ctx);
    }
  } catch (err) {
    console.error('[gateway] deliverable fallback to mock:', (err as Error).message);
    result = mockDeliverable(ctx);
  }

  const outText = result.sections.map((s) => `${s.h} ${s.b ?? ''} ${(s.list ?? []).join(' ')}`).join('\n');
  if (!(await moderate('output', outText))) {
    throw Object.assign(new Error('产出未通过内容审核'), { code: 'MODERATION_BLOCK' });
  }
  cache.set(ck, { v: result, at: Date.now() });
  return result;
}

export async function chatComplete(ctx: GenContext): Promise<ChatReply> {
  if (!(await moderate('input', ctx.userMessage))) {
    throw Object.assign(new Error('输入未通过内容审核'), { code: 'MODERATION_BLOCK' });
  }
  const cfg = await getAiConfig();
  try {
    const live = liveProvider(cfg);
    if (live) {
      const r =
        live === 'claude'
          ? await (await import('./providers/claude.js')).claudeChat(ctx, cfg)
          : await (await import('./providers/openai.js')).openaiChat(ctx, cfg);
      await moderate('output', r.text);
      return r;
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
