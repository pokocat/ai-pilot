// 端点检测体系（2026-08-07 · 重设计二期）。
//
// ── 取代了什么 ────────────────────────────────────────────────────────────────
// 从前只有一个按钮、一次最小补全（`'ping'`，700 token）。它只能回答「网络通不通、key 对不对」，
// 而线上真正会炸的那些**恰好都不在它的覆盖里**：
//   · thinking 的方言写法上游认不认（2026-07-27 那次 400 正是这一类，只能靠人肉直测发现）
//   · 工具调用可不可用（成果链路的命脉）
//   · 流式会不会建了流却一个 delta 都不吐
//   · max_tokens 的真实上界、实际出字速度（超时阈值就是按它定的）
//   · model 在不在这把 Key 的模型范围里（七牛 model groups）
//   · 嵌入维度跟既有语料对不对得上
// 于是「能力是靠猜的（正则匹配模型名），验证是靠人的（记得点按钮）」。
//
// 本模块把这些变成 8 个独立可跑、独立记录、可定时的检测项，并把结果**回填 capsJson**——
// 探活说「这个模型不支持思考」，校验器下一秒就开始拦截开思考的配置。这是闭环的关键一步：
// 能力从「猜」变成「测」。
//
// ── 三条铁律 ──────────────────────────────────────────────────────────────────
//  ① **必须 poolBypass**：探活走的是同一条 withEndpoint 外呼链路，不 bypass 就会被端点池
//     整体改写成池成员——那样测的根本不是被测端点（见 aiConfig.mergedTestConfig 的说明）。
//  ② **必须用被测端点自己的方言与参数组装**，与真实请求同一条代码路径；另写一份 mini 请求
//     等于测了个不存在的东西。
//  ③ **探活是真实计费请求**：用量按 kind='probe' 单独记账、后台可见、可一键全停。
//     不可见的定时消耗迟早变成下一桩成本悬案。

import { prisma } from '../db.js';
import { isRealKey } from '../env.js';
import { readAiCredential } from './aiCredentialStorage.js';
import { getAiConfig, type ResolvedAiConfig } from './aiConfig.js';
import { __resetAiRoutes } from './aiRoutes.js';
import { recordTokenUsage } from './usage.js';
import {
  noteProbe, restoreScheduledProbeState, syncScheduledProbeTargets, type ProbeMetricLabels,
} from './metrics.js';
import { testEmbedding } from './embedding.js';
import { testRerank } from './rerank.js';
import type { AiPurpose } from './aiRoutes.js';
import { dialectOf, normalizeThinkingBudget, normalizeThinkingMode } from '../llm/thinking.js';
import { readCaps, type Cap, type EndpointCaps, type ProbeResult } from '../llm/configSchemas.js';
import type { AiProvider, GenContext } from '../llm/schema.js';
import type { Tool } from '../llm/tools/types.js';

export type ProbeKind =
  | 'connectivity' | 'model_scope' | 'thinking' | 'tools' | 'streaming' | 'long_output'
  | 'embedding' | 'rerank';

export const ALL_PROBES: ProbeKind[] = [
  'connectivity', 'model_scope', 'thinking', 'tools', 'streaming', 'long_output', 'embedding', 'rerank',
];

/**
 * 定时探活的默认项与周期。
 *
 * 注意：这里是“检测项自己的频率”，不是说每个端点都跑全部检测。实际调度必须再按在线
 * route purpose 裁剪：embedding/rerank 只能跑各自协议，绝不能拿 chat completion 冒充连通性。
 */
export const SCHEDULED_PROBES: { kind: ProbeKind; everyMs: number }[] = [
  { kind: 'connectivity', everyMs: 10 * 60_000 },
  { kind: 'embedding', everyMs: 10 * 60_000 },
  { kind: 'rerank', everyMs: 10 * 60_000 },
  { kind: 'thinking', everyMs: 60 * 60_000 },
  { kind: 'model_scope', everyMs: 24 * 60 * 60_000 },
];

const TEXT_PURPOSES = new Set<AiPurpose>(['chat', 'deliverable', 'aux', 'moderation']);

export interface ProbeRunContext {
  endpointId?: string;
  endpointLabel?: string;
  purposes?: AiPurpose[];
  source?: 'manual' | 'scheduled';
}

function purposeForProbe(kind: ProbeKind, purposes: AiPurpose[]): string {
  return kind === 'embedding' || kind === 'rerank'
    ? kind
    : purposes.filter((p) => TEXT_PURPOSES.has(p)).sort().join('+') || 'manual';
}

function probeMetricLabels(
  kind: ProbeKind,
  cfg: Pick<ResolvedAiConfig, 'endpointId' | 'label'>,
  context: ProbeRunContext,
): ProbeMetricLabels {
  return {
    endpoint: context.endpointId ?? cfg.endpointId ?? 'manual',
    label: context.endpointLabel ?? cfg.label ?? '手动检测',
    purpose: purposeForProbe(kind, context.purposes ?? []),
    kind,
    source: context.source ?? 'manual',
  };
}

/** 在线用途决定允许跑哪些定时检测；同一端点多用途时去重，保留各检测项自己的周期。 */
export function scheduledProbesForPurposes(purposes: AiPurpose[]): { kind: ProbeKind; everyMs: number }[] {
  const text = purposes.some((p) => TEXT_PURPOSES.has(p));
  return SCHEDULED_PROBES.filter(({ kind }) => {
    if (kind === 'embedding') return purposes.includes('embedding');
    if (kind === 'rerank') return purposes.includes('rerank');
    return text;
  });
}

export interface ProbeOutcome {
  endpointId: string | null;
  ok: boolean;
  results: ProbeResult[];
  caps: EndpointCaps;
}

/** 一键全停：定时探活是真实计费请求，必须留一个不发版就能关掉的开关。 */
export function probeSchedulerEnabled(): boolean {
  return (process.env.AI_PROBE_SCHEDULED ?? 'true').trim() !== 'false';
}

function nowIso(at: Date): string { return at.toISOString(); }

/** `GET {base}/models` 的完整地址。OpenAI 兼容的 baseUrl 已含 /v1；Anthropic 协议根要自己补。 */
export function modelsUrl(protocol: string, baseUrl: string): string {
  const b = baseUrl.trim().replace(/\/+$/, '');
  if (!b) return '';
  if (protocol === 'anthropic') return /\/v\d+$/.test(b) ? `${b}/models` : `${b}/v1/models`;
  return `${b}/models`;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: Error }> {
  const t0 = Date.now();
  try {
    // **必须先 await 再取时间**。写成 `{ ms: Date.now() - t0, value: await fn() }` 会恒为 0——
    // 对象字面量按书写顺序求值，`ms` 在 `await` 之前就算好了。
    // 这个写法在单测里看不出来（没人断言耗时 > 0），只有拿真实上游对一次才会暴露：
    // 2026-08-08 预发实测同一次调用，探活记 0ms、自测墙钟 3374ms。
    const value = await fn();
    return { ms: Date.now() - t0, value };
  } catch (err) {
    return { ms: Date.now() - t0, error: err as Error };
  }
}

/** 探活的上游等待：比对话短得多——探活卡住不该拖住定时任务或运营的页面。 */
function probeTimeoutMs(): number {
  const n = Number(process.env.AI_PROBE_TIMEOUT_MS ?? '');
  return Number.isFinite(n) && n > 0 ? n : 20_000;
}

/** 把被测配置收敛成探活口径：bypass 端点池、短超时、不占主车道。 */
function toProbeConfig(cfg: ResolvedAiConfig): ResolvedAiConfig {
  return { ...cfg, poolBypass: true, lane: 'aux', timeoutMs: Math.min(cfg.timeoutMs, probeTimeoutMs()) };
}

// ── 各检测项 ──────────────────────────────────────────────────────────────────

async function probeConnectivity(cfg: ResolvedAiConfig): Promise<{ ok: boolean; error?: string; detail?: Record<string, unknown> }> {
  const { pingModel } = await import('../llm/gateway.js');
  const r = await pingModel(cfg);
  return { ok: r.ok, error: r.error, detail: { sample: r.sample, model: r.model } };
}

/** GET /models 是网关可选能力；明确“不存在/不实现”不能反推实际聊天模型不可用。 */
export function modelListUnsupportedStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

function persistedModelListUnsupported(result: ProbeResult): boolean {
  if (result.kind !== 'model_scope' || result.ok) return false;
  const match = /^HTTP\s+(\d+)$/.exec(result.error?.trim() ?? '');
  return !!match && modelListUnsupportedStatus(Number(match[1]));
}

/**
 * key 的模型范围。七牛的 Key 带 model groups，范围外会报
 * `model not available in your assigned model groups`——这类错误在真实调用时才暴露，
 * 而它其实是**保存配置时就能查出来的**。
 */
async function probeModelScope(cfg: ResolvedAiConfig): Promise<{ ok: boolean; error?: string; detail?: Record<string, unknown> }> {
  const { dialect } = dialectOf(cfg);
  if (!dialect.listModels) return { ok: true, detail: { skipped: '该方言不支持 GET /models' } };
  const url = modelsUrl(dialect.protocol, cfg.baseUrl);
  if (!url) return { ok: true, detail: { skipped: 'baseUrl 为空（官方直连未配网关）' } };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), probeTimeoutMs());
  try {
    const res = await fetch(url, {
      headers: dialect.protocol === 'anthropic'
        ? { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }
        : { Authorization: `Bearer ${cfg.apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (modelListUnsupportedStatus(res.status)) {
        return { ok: true, detail: { skipped: `上游不提供 GET /models（HTTP ${res.status}）` } };
      }
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const body = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
    const models = (body.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
    if (!models.length) return { ok: true, detail: { models: [], note: '上游未返回模型清单' } };
    const inScope = models.includes(cfg.model);
    return {
      ok: inScope,
      error: inScope ? undefined : `模型 ${cfg.model} 不在该 Key 的可用范围内（共 ${models.length} 个可用）`,
      detail: { models, inScope },
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Thinking 的方言写法上游认不认。
 *
 * **必须用被测端点自己的配置真发一次**，不能只看配置对不对：2026-07-27 那次事故里，
 * 两个端点配置一模一样，其中一个就是确定性地返回
 * `thinking.disabled.budget_tokens: Extra inputs are not permitted`——只有真发才知道。
 */
async function probeThinking(cfg: ResolvedAiConfig): Promise<{ ok: boolean; error?: string; cap?: Cap }> {
  const { pingModel } = await import('../llm/gateway.js');
  // 关闭态与开启态是两种写法，都要过一遍：关闭态验的是「省略还是显式 disabled」，
  // 开启态验的是「这个模型到底支不支持思考」。
  const off = await pingModel({ ...cfg, thinkingMode: 'disabled' });
  if (!off.ok) return { ok: false, error: `关闭思考的写法不被接受：${off.error}` };

  const mode = normalizeThinkingMode(cfg.thinkingMode);
  if (mode === 'disabled') return { ok: true };
  const on = await pingModel({ ...cfg, thinkingMode: mode, thinkingBudget: normalizeThinkingBudget(cfg.thinkingBudget) });
  // 开启失败 → 证伪该模型的思考能力，回填 caps，校验器据此拦住后续配置。
  return on.ok ? { ok: true, cap: 'yes' } : { ok: false, error: on.error, cap: 'no' };
}

/** 工具调用——成果链路的命脉，坏了会让所有结构化产出降级成模板。 */
async function probeTools(cfg: ResolvedAiConfig): Promise<{ ok: boolean; error?: string; cap?: Cap }> {
  // 探活只关心「模型愿不愿意、能不能发出 tool_use」，不会走到 run —— 但 Tool 接口要求它存在。
  const tool: Tool = {
    name: 'probe_echo',
    description: '把输入原样回显，仅用于连通性检测',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: async (args) => String(args.text ?? ''),
  };
  try {
    const makeStep = cfg.provider === 'claude'
      ? (await import('../llm/providers/claude.js')).claudeStep
      : (await import('../llm/providers/openai.js')).openaiStep;
    const step = makeStep(cfg);
    const r = await step(
      [
        { role: 'system', text: '你是工具调用检测。必须调用 probe_echo 工具，参数 text 填「ok」。' },
        { role: 'user', text: '请调用工具。' },
      ],
      [tool],
      { forceFinal: false },
    );
    const called = r.kind === 'tool_calls' && r.calls.some((c) => c.name === 'probe_echo');
    return called
      ? { ok: true, cap: 'yes' }
      : { ok: false, error: '模型没有按要求调用工具（可能不支持 function calling）', cap: 'no' };
  } catch (err) {
    return { ok: false, error: (err as Error).message, cap: 'no' };
  }
}

/** 流式：建了流之后到底吐不吐 delta。只等第一个 delta 就断开，不烧 token。 */
async function probeStreaming(cfg: ResolvedAiConfig): Promise<{ ok: boolean; error?: string; cap?: Cap }> {
  const ctrl = new AbortController();
  try {
    const streamFn = cfg.provider === 'claude'
      ? (await import('../llm/providers/claude.js')).claudeChatStream
      : (await import('../llm/providers/openai.js')).openaiChatStream;
    const it = streamFn(probeContext(), cfg, { signal: ctrl.signal });
    for await (const chunk of it) {
      if (chunk.type === 'delta' || chunk.type === 'done') {
        // 拿到第一个事件就够了——问题从来不是「流得完不完」，而是「建了流一个字都不来」。
        // 立刻 abort + return，别把整条流读完白烧 token。
        ctrl.abort();
        await it.return?.(undefined as never).catch?.(() => {});
        return { ok: true, cap: 'yes' };
      }
    }
    return { ok: false, error: '建流成功但一个事件都没收到', cap: 'no' };
  } catch (err) {
    // 我们自己 abort 掉的那一下不算失败——上面已经 return，能走到这里说明是真异常。
    return { ok: false, error: (err as Error).message, cap: 'no' };
  }
}

/**
 * 探活用的最小 GenContext。流式入口按业务上下文取提示词，探活没有业务上下文，
 * 给一个「只求回一个字」的最小体即可——目的是验流，不是验内容。
 */
function probeContext(): GenContext {
  return {
    agentKey: '__probe__',
    agentName: '连通性检测',
    systemPrompt: '你是流式连通性检测。请只回复两个字：可用。',
    deliverableKey: null,
    profile: null,
    memories: [],
    benmingColor: '',
    benchmark: '',
    knowledge: [],
    history: [],
    userMessage: '请回复：可用',
  } as unknown as GenContext;
}

/**
 * 输出上界与出字速度。超时阈值（CHAT_TIMEOUT_MS 等）本来就是按实测速度定的，
 * 换端点后不重测就等于拿旧端点的速度给新端点设超时。
 */
async function probeLongOutput(cfg: ResolvedAiConfig): Promise<{ ok: boolean; error?: string; detail?: Record<string, unknown>; maxOutputTokens?: number }> {
  const want = Number(process.env.AI_PROBE_LONG_TOKENS ?? '') || 600;
  try {
    const eff = cfg.provider === 'claude' ? 'claude' : 'openai';
    const raw = eff === 'claude'
      ? (await import('../llm/providers/claude.js')).claudeRaw
      : (await import('../llm/providers/openai.js')).openaiRaw;
    const t0 = Date.now();
    const text = await raw(cfg, '你是输出速度检测。请连续输出阿拉伯数字，从 1 开始，不要换行也不要解释。', '开始', {
      allowThinking: false, maxTokens: want,
    });
    const seconds = Math.max(0.001, (Date.now() - t0) / 1000);
    const approxTokens = Math.ceil(text.length / 2);
    return {
      ok: approxTokens > 0,
      error: approxTokens > 0 ? undefined : '未产出任何正文',
      detail: { approxTokens, seconds: Number(seconds.toFixed(2)), tokensPerSecond: Math.round(approxTokens / seconds) },
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ── 编排 ──────────────────────────────────────────────────────────────────────

/** 跑一组检测。不抛：任何一项炸了都只体现为它自己的 ok=false。 */
export async function runProbes(
  cfg: ResolvedAiConfig,
  kinds: ProbeKind[],
  at: Date,
  context: ProbeRunContext = {},
): Promise<ProbeOutcome> {
  const probeCfg = toProbeConfig(cfg);
  const results: ProbeResult[] = [];
  const capsPatch: EndpointCaps = {};
  const existing = readCaps(cfg.capsJson);

  const push = (kind: ProbeKind, ok: boolean, ms: number, error?: string, detail?: Record<string, unknown>) => {
    results.push({ kind, ok, at: nowIso(at), latencyMs: ms, ...(error ? { error } : {}), ...(detail ? { detail } : {}) });
    const interval = context.source === 'scheduled'
      ? (SCHEDULED_PROBES.find((p) => p.kind === kind)?.everyMs ?? 0) / 1000
      : 0;
    noteProbe(probeMetricLabels(kind, cfg, context), ok, ms / 1000, interval);
  };
  // 运营手动锁定的能力项不被探活覆盖——探活是证据，运营的显式判断优先。
  const setCap = (key: 'thinking' | 'tools' | 'streaming', cap?: Cap) => {
    if (!cap) return;
    if ((existing.locked ?? []).includes(key)) return;
    capsPatch[key] = cap;
  };

  for (const kind of kinds) {
    if (kind === 'connectivity') {
      const r = await timed(() => probeConnectivity(probeCfg));
      push(kind, !!r.value?.ok, r.ms, r.error?.message ?? r.value?.error, r.value?.detail);
    } else if (kind === 'model_scope') {
      const r = await timed(() => probeModelScope(probeCfg));
      push(kind, !!r.value?.ok, r.ms, r.error?.message ?? r.value?.error, r.value?.detail);
      // 把清单**写回 caps**，否则校验器的 MODEL_OUT_OF_KEY_SCOPE 永远等不到输入——
      // 探活查回来又扔掉，等于一根线的两头从来没接上。
      const models = (r.value?.detail?.models as string[] | undefined) ?? [];
      if (models.length) capsPatch.modelScope = { models, at: nowIso(at) };
    } else if (kind === 'thinking') {
      const r = await timed(() => probeThinking(probeCfg));
      push(kind, !!r.value?.ok, r.ms, r.error?.message ?? r.value?.error);
      setCap('thinking', r.value?.cap);
    } else if (kind === 'tools') {
      const r = await timed(() => probeTools(probeCfg));
      push(kind, !!r.value?.ok, r.ms, r.error?.message ?? r.value?.error);
      setCap('tools', r.value?.cap);
    } else if (kind === 'streaming') {
      const r = await timed(() => probeStreaming(probeCfg));
      push(kind, !!r.value?.ok, r.ms, r.error?.message ?? r.value?.error);
      setCap('streaming', r.value?.cap);
    } else if (kind === 'long_output') {
      const r = await timed(() => probeLongOutput(probeCfg));
      push(kind, !!r.value?.ok, r.ms, r.error?.message ?? r.value?.error, r.value?.detail);
    } else if (kind === 'embedding') {
      const r = await timed(() => testEmbedding(probeCfg));
      push(kind, !!r.value?.ok, r.ms, r.error?.message ?? r.value?.error, r.value?.dim ? { dim: r.value.dim } : undefined);
    } else if (kind === 'rerank') {
      const r = await timed(() => testRerank(probeCfg));
      push(kind, !!r.value?.ok, r.ms, r.error?.message ?? r.value?.error);
    }
  }

  // 探活烧的是真钱。按 kind='probe' 单独记账，成本看板能把它和用户流量分开看。
  if (results.length) {
    void recordTokenUsage({
      kind: 'probe', provider: cfg.provider, model: cfg.model,
      usage: { inputTokens: results.length * 40, outputTokens: results.length * 20, cachedInput: 0 },
    }).catch(() => {});
  }

  return {
    endpointId: cfg.endpointId ?? cfg.traceEndpointId ?? null,
    ok: results.every((r) => r.ok),
    results,
    caps: { ...existing, ...capsPatch },
  };
}

/** 按 AiEndpoint.id 探活并把结果 + 能力回填落库。 */
export async function probeEndpointById(
  id: string,
  kinds: ProbeKind[],
  at: Date,
  context: ProbeRunContext = {},
): Promise<ProbeOutcome | null> {
  const row = await prisma.aiEndpoint.findUnique({ where: { id }, include: { credential: true } });
  if (!row) return null;
  const base = await getAiConfig(true);
  const apiKey = readAiCredential(row.credential.apiKey);
  const cfg: ResolvedAiConfig = {
    ...base,
    provider: (row.provider as AiProvider) ?? 'mock',
    label: row.label,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKey,
    temperature: row.temperature,
    thinkingMode: normalizeThinkingMode(row.thinkingMode),
    thinkingBudget: normalizeThinkingBudget(row.thinkingBudget),
    dialect: row.dialect,
    capsJson: row.capsJson,
    endpointId: row.id,
    traceEndpointId: row.id,
    traceEndpointLabel: row.label,
    // AiEndpoint 是六用途共用的归一化行；embedding/rerank 的调用器仍消费兼容字段。
    // 探单个端点时必须把这行投影到对应用途，否则会误用全局 chat 配置并报“未开启”。
    ...(kinds.includes('embedding') ? {
      embeddingEnabled: true,
      embeddingBaseUrl: row.baseUrl,
      embeddingApiKey: apiKey,
      embeddingModel: row.model,
    } : {}),
    ...(kinds.includes('rerank') ? {
      rerankEnabled: true,
      rerankBaseUrl: row.baseUrl,
      rerankApiKey: apiKey,
      rerankModel: row.model,
    } : {}),
  };
  if (cfg.provider !== 'mock' && !isRealKey(cfg.apiKey)) {
    return {
      endpointId: id, ok: false, caps: readCaps(row.capsJson),
      results: [{ kind: 'connectivity', ok: false, at: nowIso(at), error: '该端点的凭证未配置 API Key' }],
    };
  }

  const outcome = await runProbes(cfg, kinds, at, {
    ...context,
    endpointId: row.id,
    endpointLabel: row.label,
  });
  try {
    const previous = ((row.probeJson as { results?: ProbeResult[] } | null)?.results ?? [])
      .filter((r): r is ProbeResult => !!r && ALL_PROBES.includes(r.kind as ProbeKind));
    const latestByKind = new Map(previous.map((r) => [r.kind, r]));
    for (const result of outcome.results) latestByKind.set(result.kind, result);
    const mergedResults = ALL_PROBES.flatMap((kind) => {
      const result = latestByKind.get(kind);
      return result ? [result] : [];
    });
    // 直接写端点表——运行时读的就是这里，能力回填（「这个模型不支持思考」）当场对校验器生效。
    // 三期收尾前这里写的是 ai_model，还要靠投影才能到运行时，闭环恰好断在最要紧的一环。
    await prisma.aiEndpoint.update({
      where: { id },
      data: {
        lastProbeAt: at,
        lastProbeOk: outcome.ok,
        // 保留每个 kind 的最新结果。旧实现每 10 分钟 connectivity 覆盖整块 JSON，导致
        // thinking/model_scope 的上次时间永久丢失，调度只能拿一个全局 lastProbeAt 猜。
        probeJson: { results: mergedResults } as object,
        capsJson: outcome.caps as object,
      },
    });
    __resetAiRoutes(); // 能力变了，路由缓存里的旧 caps 必须失效
  } catch (err) {
    console.error('[aiProbe] 探活结果落库失败：', (err as Error).message);
  }
  return outcome;
}

/** 定时探活：只对在线用途路由的实际承载端点跑到期且协议匹配的检测项。 */
export async function scheduledProbeSweep(at: Date): Promise<void> {
  if (!probeSchedulerEnabled()) return;
  const routes = await prisma.aiRoute.findMany({
    where: { enabled: true },
    include: {
      members: {
        where: { enabled: true },
        include: { endpoint: { include: { credential: true } } },
      },
    },
  });

  // 与运行时路由语义一致：single 只取 primary（缺失时回退首个），pool 才探全部启用成员。
  // 没挂到任何在线 route 的历史/备用端点不再定时烧钱，也不会污染线上告警。
  const active = new Map<string, { row: (typeof routes)[number]['members'][number]['endpoint']; purposes: Set<AiPurpose> }>();
  for (const route of routes) {
    const candidates = route.members.filter((m) => {
      const endpoint = m.endpoint;
      return endpoint.provider !== 'mock' && isRealKey(readAiCredential(endpoint.credential.apiKey));
    });
    const selected = route.mode === 'pool'
      ? candidates
      : [candidates.find((m) => m.primary) ?? candidates[0]].filter((m): m is (typeof candidates)[number] => !!m);
    for (const member of selected) {
      const found = active.get(member.endpoint.id) ?? { row: member.endpoint, purposes: new Set<AiPurpose>() };
      found.purposes.add(route.purpose as AiPurpose);
      active.set(member.endpoint.id, found);
    }
  }

  syncScheduledProbeTargets([...active.values()].flatMap(({ row, purposes: purposeSet }) => {
    const purposes = [...purposeSet].sort();
    return scheduledProbesForPurposes(purposes).map(({ kind }) => probeMetricLabels(kind, {
      endpointId: row.id,
      label: row.label,
    }, {
      endpointId: row.id,
      endpointLabel: row.label,
      purposes,
      source: 'scheduled',
    }));
  }));

  for (const { row, purposes: purposeSet } of active.values()) {
    const purposes = [...purposeSet].sort();
    const previous = ((row.probeJson as { results?: ProbeResult[] } | null)?.results ?? []);
    const lastByKind = new Map<ProbeKind, number>();
    const resultByKind = new Map<ProbeKind, ProbeResult>();
    for (const result of previous) {
      const kind = result?.kind as ProbeKind;
      const time = Date.parse(result?.at ?? '');
      // 兼容刚修复前已落库的假失败：不要恢复成 latest gauge，也不要等满 24h，
      // 下一轮立刻用新语义重测并覆盖该结果。
      if (persistedModelListUnsupported(result)) continue;
      if (ALL_PROBES.includes(kind) && Number.isFinite(time)) {
        lastByKind.set(kind, time);
        resultByKind.set(kind, result);
      }
    }
    const scheduled = scheduledProbesForPurposes(purposes);
    for (const probe of scheduled) {
      const previousResult = resultByKind.get(probe.kind);
      if (!previousResult) continue;
      restoreScheduledProbeState(probeMetricLabels(probe.kind, {
        endpointId: row.id,
        label: row.label,
      }, {
        endpointId: row.id,
        endpointLabel: row.label,
        purposes,
        source: 'scheduled',
      }), previousResult.ok, lastByKind.get(probe.kind)! / 1000, probe.everyMs / 1000);
    }
    const due = scheduled
      .filter((p) => at.getTime() - (lastByKind.get(p.kind) ?? 0) >= p.everyMs)
      .map((p) => p.kind);
    if (!due.length) continue;
    await probeEndpointById(row.id, due, at, { purposes, source: 'scheduled' });
  }
}
