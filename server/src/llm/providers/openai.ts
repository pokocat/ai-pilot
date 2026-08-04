// OpenAI 通用协议提供方（AI_PROVIDER=openai / 任意 openai 兼容网关时启用）。
// 走标准 /v1/chat/completions，兼容 OpenAI / Agnes / DeepSeek / Moonshot(Kimi) / 通义千问兼容模式 等。
// 结构化成果用 function calling（tools）强约束。baseUrl/model/key/温度 来自运行时配置（可后台切换）。

import { CHAT_STYLE_GUIDE, DELIVERABLE_TOOL, ZERO_USAGE, injectVariables, normalizeDeliverableSections, normalizePrescriptions, normalizeCover, type Deliverable, type ChatReply, type GenContext, type Metered, type Usage } from '../schema.js';
import { DELIVERABLES, TRUST_NOTE } from '../../data/deliverables.js';
import type { ResolvedAiConfig } from '../../services/aiConfig.js';
import { runToolLoop } from '../tools/loop.js';
import type { LoopMessage, StepFn, Tool, ToolCall, ToolContext, TurnOutput } from '../tools/types.js';
import {
  assertChatBodyProduced,
  assertChatOutputComplete,
  continuationPrompt,
  dedupeContinuation,
  isTruncatedFinish,
  joinContinuation,
  noteChatTruncated,
  CHAT_MAX_TOKENS,
  CHAT_TOTAL_MAX_TOKENS,
  CONTINUE_DEADLINE_MS,
  CONTINUE_DEDUPE_BUFFER_CHARS,
  MAX_CHAT_CONTINUATIONS,
} from './completionGuard.js';
// 全局并发闸：所有真实外呼都要过闸（压测 P0-2）。见 services/llmGate.ts 顶部说明。
import { withLlmSlot, acquireLlmSlot, noteUpstreamRateLimited, endpointLane } from '../../services/llmGate.js';
// 端点池：多路分流 + 故障转移（压测后续）。未启用池时只有一个候选，行为与直接过闸完全一致。
import { withEndpoint, resolveCandidates, coolEndpoint, isTransferable, noteEndpointAttempt } from '../../services/llmPool.js';
import { chatMaxTokens, maxTokensForThinking, thinkingRequestTuning } from '../thinking.js';
import { deliverableTimeoutMs } from '../providerTimeouts.js';

interface OAToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
// 多模态内容片段（OpenAI vision 协议）：文本或 data URL 图片。
type OAContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };
interface OAMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OAContentPart[] | null;
  tool_calls?: OAToolCall[];
  tool_call_id?: string;
}

type ImageInput = { mediaType: string; base64: string };
// 多模态当轮 user content：有图片时组成 [image_url..., text] 数组（data URL 内联 base64）；无图片维持纯字符串。
// 不判断模型是否支持 vision——由上游模型配置负责（见方案说明）。导出供单测组装逻辑。
export function openaiUserContent(userMessage: string, images?: ImageInput[]): string | OAContentPart[] {
  if (!images?.length) return userMessage;
  const parts: OAContentPart[] = images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mediaType};base64,${im.base64}` } }));
  parts.push({ type: 'text', text: userMessage || '（见图，请据图作答）' });
  return parts;
}
interface OAResponse {
  choices?: { message?: { content?: string | null; tool_calls?: OAToolCall[] }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string };
}
interface OAStreamChunk {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: OAResponse['usage'];
  error?: { message?: string };
}

const DELIVERABLE_MAX_TOKENS = 8000; // 报告产出上限（放到整份报告够用，实际按需生成不硬凑）
type RequestPhase = 'chat_completion' | 'deliverable' | 'chat_stream';

function requestTimeoutMs(cfg: ResolvedAiConfig, phase: RequestPhase): number {
  return phase === 'deliverable'
    ? deliverableTimeoutMs(cfg.timeoutMs)
    : cfg.timeoutMs;
}

function gatewayHost(base: string): string {
  try { return new URL(base).host; }
  catch { return 'invalid-base-url'; }
}

function deadline(timeoutMs: number) {
  const ctrl = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
  };
  arm();
  return {
    signal: ctrl.signal,
    refresh: arm,
    clear: () => { if (timer) clearTimeout(timer); timer = null; },
    timedOut: () => timedOut,
    elapsedMs: () => Date.now() - startedAt,
  };
}

function providerFailure(err: unknown, cfg: ResolvedAiConfig, base: string, phase: RequestPhase, timeoutMs: number, watch: ReturnType<typeof deadline>): Error {
  const original = err as Error;
  const failure = watch.timedOut()
    ? Object.assign(new Error(`OpenAI 兼容网关${phase === 'deliverable' ? '成果' : phase === 'chat_stream' ? '流式' : '对话'}响应超时（${timeoutMs}ms）`), { name: 'AbortError', code: 'AI_TIMEOUT' })
    : original;
  // 不记录 prompt 或密钥；保留网关、模型、阶段和耗时，才能区分排队慢、首包慢和流中断。
  console.warn('[llm:openai] request failed', {
    host: gatewayHost(base), model: cfg.model, phase, timeoutMs,
    elapsedMs: watch.elapsedMs(), timeout: watch.timedOut(),
    errorName: failure.name, error: failure.message,
  });
  return failure;
}

// 统一请求封装：注入 baseUrl/model/key/温度，带超时；错误抛出由 gateway 兜底降级 mock。
async function callChat(
  cfg: ResolvedAiConfig,
  body: Record<string, unknown>,
  phase: RequestPhase = 'chat_completion',
  affinity?: string,
  allowThinking?: boolean,
): Promise<OAResponse> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const timeoutMs = requestTimeoutMs(cfg, phase);
  // 超时窗必须**每次端点尝试各建各的**：池在 429/5xx 后会转移端点重发，若整个 callChat 共用
  // 一个窗，第一个端点耗掉大半预算（或直接把窗打超时中止）后，转移到第二个端点的请求带着
  // 已中止/濒死的 signal 立刻失败——重试形同虚设。lastWatch 只供失败诊断（耗时/是否超时）。
  let lastWatch: ReturnType<typeof deadline> | null = null;
  try {
    // 过端点池 + 并发闸：ep 是本次实际选中的端点（未启用池时就是传入的 cfg）。
    // 请求体在闭包里按 ep 组装，故 429/5xx 转移到下一个端点时能原样重发。
    return await withEndpoint(cfg, async (ep) => {
      const watch = deadline(timeoutMs);
      lastWatch = watch;
      try {
        const epBase = ep.baseUrl.replace(/\/+$/, '') || base;
        const res = await fetch(`${epBase}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
          body: JSON.stringify({
            model: ep.model,
            ...body,
            ...thinkingRequestTuning(ep, {
              allowThinking: allowThinking ?? (!body.tools && !body.tool_choice),
            }),
          }),
          signal: watch.signal,
        });
        const data = (await res.json().catch(() => ({}))) as OAResponse;
        if (!res.ok) {
          // 带上 statusCode，让闸门/池能确定性识别 429 而不是靠文案匹配（429 → 整窗冷却 + 转移）。
          throw Object.assign(new Error(`OpenAI 兼容接口 ${res.status}: ${data.error?.message ?? '请求失败'}`), { statusCode: res.status });
        }
        return data;
      } finally {
        watch.clear();
      }
    }, { affinityKey: affinity });
  } catch (err) {
    throw providerFailure(err, cfg, base, phase, timeoutMs, lastWatch ?? deadlineStub());
  }
}

/** withEndpoint 前置阶段（解析候选/占并发槽）就抛错时还没有任何尝试窗——诊断按未超时、0 耗时计。 */
function deadlineStub(): ReturnType<typeof deadline> {
  return {
    signal: new AbortController().signal,
    refresh: () => {},
    clear: () => {},
    timedOut: () => false,
    elapsedMs: () => 0,
  };
}

async function* readOpenAIStream(res: Response, onChunk: () => void): AsyncGenerator<OAStreamChunk> {
  if (!res.body) throw new Error('OpenAI 兼容接口未返回流式响应体');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    // timeout 是「首个字节 / 相邻字节」的空闲上限，不再把正常持续输出的长回复在总时长处截断。
    if (value?.byteLength) onChunk();
    buf += decoder.decode(value, { stream: true });
    buf = buf.replace(/\r\n/g, '\n');
    const blocks = buf.split('\n\n');
    buf = blocks.pop() ?? '';
    for (const block of blocks) {
      for (const line of block.split('\n')) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const raw = s.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let data: OAStreamChunk;
        try { data = JSON.parse(raw) as OAStreamChunk; }
        catch { continue; }
        if (data.error?.message) throw new Error(data.error.message);
        yield data;
      }
    }
  }
  buf = buf.replace(/\r\n/g, '\n');
  if (buf.trim()) {
    for (const line of buf.split('\n')) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const raw = s.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      const data = JSON.parse(raw) as OAStreamChunk;
      if (data.error?.message) throw new Error(data.error.message);
      yield data;
    }
  }
}

async function callChatStream(
  cfg: ResolvedAiConfig,
  body: Record<string, unknown>,
  includeUsage = true,
  affinity?: string,
): Promise<AsyncGenerator<OAStreamChunk>> {
  // 建流阶段走端点池（此前流式完全绕过池：单端点 429/宕机时流式对话没有任何兜底，
  // 冷却态也不共享）。转移规则与 claude 流式一致：响应头返回（res.ok）之前的 429/5xx/超时
  // 可换端点重试；流一旦建立只能如实消费/报错——中途换端点等于让用户看到重复的半截回答。
  const cls = cfg.lane === 'aux' ? 'aux' : 'main';
  const candidates = await resolveCandidates(cfg, { affinityKey: affinity });
  const maxAttempts = Math.max(1, Math.min(candidates.length, Number(process.env.LLM_POOL_MAX_ATTEMPTS ?? 3) || 3));

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ep = candidates[attempt];
    const base = ep.baseUrl.replace(/\/+$/, '') || cfg.baseUrl.replace(/\/+$/, '');
    const lane = ep.endpointId ? endpointLane(cls, ep.endpointId) : cfg.lane;
    // 超时窗每次尝试各建各的（与 callChat 同一坑：共用窗会让转移后的请求带着濒死 signal 出发）。
    const watch = deadline(ep.timeoutMs);
    // 流式的槽位要持有到整条流消费完（一条流在上游眼里全程占一个并发），所以手动 acquire，
    // 并把释放责任移交给下面返回的 generator；建流阶段失败由本轮 finally 兜底释放。
    const slot = await acquireLlmSlot(lane);
    let handedOff = false;
    try {
      noteEndpointAttempt(ep);
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
        body: JSON.stringify({
          model: ep.model,
          ...body,
          ...thinkingRequestTuning(ep, { allowThinking: !body.tools && !body.tool_choice }),
          stream: true,
          ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
        }),
        signal: watch.signal,
      });
      if (!res.ok) {
        const data = (await res.clone().json().catch(async () => {
          const text = await res.text().catch(() => '');
          return text ? { error: { message: text } } : {};
        })) as OAResponse;
        if (res.status === 429) noteUpstreamRateLimited(undefined, lane);
        throw Object.assign(new Error(`OpenAI 兼容接口 ${res.status}: ${data.error?.message ?? '请求失败'}`), { statusCode: res.status });
      }
      handedOff = true;
      return (async function* () {
        try { yield* readOpenAIStream(res, watch.refresh); }
        catch (err) { slot.noteError(err); throw providerFailure(err, ep, base, 'chat_stream', ep.timeoutMs, watch); }
        finally { watch.clear(); slot.release(); }
      })();
    } catch (err) {
      lastErr = err;
      slot.noteError(err);
      const last = attempt === maxAttempts - 1;
      // 不可转移（4xx 请求本身的问题等）或没有池端点 → 如实抛；可转移即使没有下一个候选也要写冷却态。
      if (!ep.endpointId || !isTransferable(err)) throw providerFailure(err, ep, base, 'chat_stream', ep.timeoutMs, watch);
      await coolEndpoint(ep.endpointId, 30_000, 'stream_error');
      if (last) throw providerFailure(err, ep, base, 'chat_stream', ep.timeoutMs, watch);
      console.warn(`[llm:openai] 流式端点 ${ep.label || ep.endpointId} 建流失败并冷却，转移到下一个：${(err as Error).message}`);
    } finally {
      if (!handedOff) { watch.clear(); slot.release(); }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * 端点亲和键：同一会话固定落同一端点，保住上游的提示词缓存（缓存按账号/端点隔离）。
 * 没有 sessionId 时退到 agentKey——比每次随机好，至少同一智能体的连续调用能复用缓存。
 */
function affinityOf(ctx: GenContext): string {
  return ctx.runtime?.sessionId || ctx.agentKey || 'anon';
}

function metaOf(ctx: GenContext): string {
  const parts = [ctx.companyName, ctx.profile?.industry, ctx.profile?.stage].filter(Boolean) as string[];
  return parts.length ? parts.join(' · ') : '经营快照';
}

// OpenAI usage → 归一 Usage。prompt_tokens 已含缓存命中，cached 仅作低价子集。
function usageOf(data: OAResponse): Usage {
  const u = data.usage;
  return {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
    cachedInput: u?.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

function requireText(text: string | null | undefined, usage: Usage, where: string): string {
  const out = (text ?? '').trim();
  if (out) return out;
  const detail = usage.outputTokens > 0 ? `，输出 token=${usage.outputTokens}` : '';
  throw Object.assign(new Error(`OpenAI 兼容接口返回空文本（${where}${detail}）`), { code: 'AI_EMPTY_RESPONSE' });
}

export async function openaiDeliverable(ctx: GenContext, cfg: ResolvedAiConfig): Promise<Metered<Deliverable>> {
  const tpl = ctx.deliverableKey ? DELIVERABLES[ctx.deliverableKey] : undefined;
  const system = injectVariables(ctx.systemPrompt, ctx, 'deliverable');
  const structureHint = tpl
    ? `参考产出结构（小标题）：${tpl.sections.map((s) => s.h).join(' / ')}。标题用「${tpl.title}」。`
    : '产出 3–4 段结构化内容。';

  const history: OAMessage[] = (ctx.history ?? []).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
  const data = await callChat(cfg, {
    max_tokens: DELIVERABLE_MAX_TOKENS,
    messages: [
      { role: 'system', content: `${system}\n\n${structureHint}\n务必调用 emit_deliverable 函数输出结构化成果，不要输出自由长文。` },
      ...history,
      { role: 'user', content: openaiUserContent(ctx.userMessage || `请为我产出一份${tpl?.title ?? '咨询成果'}。`, ctx.images) },
    ] as OAMessage[],
    tools: [{ type: 'function', function: { name: DELIVERABLE_TOOL.name, description: DELIVERABLE_TOOL.description, parameters: DELIVERABLE_TOOL.input_schema } }],
    tool_choice: { type: 'function', function: { name: DELIVERABLE_TOOL.name } },
  }, 'deliverable', affinityOf(ctx));

  const usage = usageOf(data);
  const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (args) {
    const input = parseArgs(args) as { title?: string; sections?: unknown; cover?: unknown };
    const sections = normalizeDeliverableSections(input.sections);
    if (sections.length) {
      return {
        result: {
          title: input.title || tpl?.title || '咨询成果',
          icon: tpl?.icon ?? 'spark',
          meta: metaOf(ctx),
          cover: normalizeCover(input.cover),
          sections,
          trust: TRUST_NOTE,
          actions: ['save_to_library', 'export_pdf'],
        },
        usage,
      };
    }
  }
  const textSections = normalizeDeliverableSections(data.choices?.[0]?.message?.content);
  if (textSections.length) {
    return {
      result: {
        title: tpl?.title || '咨询成果',
        icon: tpl?.icon ?? 'spark',
        meta: metaOf(ctx),
        sections: textSections,
        trust: TRUST_NOTE,
        actions: ['save_to_library', 'export_pdf'],
      },
      usage,
    };
  }
  // 真实调用已花 token：没拿到 function 输出也按真实 usage 记账（供成本可观测），内容兜底 mock 并标 degraded（用户侧不计费、提示可重试）。
  const { mockDeliverable } = await import('./mock.js');
  return { result: { ...mockDeliverable(ctx), degraded: true }, usage };
}

function sumUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInput: a.cachedInput + b.cachedInput,
    cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
  };
}

/** 对话首轮的 messages。续写轮在其后追加「残文 assistant 轮 + 续写指令 user 轮」。 */
function chatBaseMessages(ctx: GenContext): OAMessage[] {
  const system = injectVariables(ctx.systemPrompt, ctx, 'chat');
  const history: OAMessage[] = (ctx.history ?? []).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
  return [
    { role: 'system', content: `${system}\n\n${CHAT_STYLE_GUIDE}` },
    ...history,
    { role: 'user', content: openaiUserContent(ctx.userMessage, ctx.images) },
  ] as OAMessage[];
}

/**
 * 续写轮 messages。与 Claude 侧同一套写法（残文进 assistant 历史、指令进 user 轮）——
 * OpenAI 协议虽然容得下末轮 assistant 续写，但同一网关背后常挂 Claude 模型，
 * 用同一套跨模型都安全的形态，省掉一个按模型分叉的坑。
 */
function continuationMessages(base: OAMessage[], accumulated: string): OAMessage[] {
  return [
    ...base,
    { role: 'assistant', content: accumulated },
    { role: 'user', content: continuationPrompt(accumulated) },
  ] as OAMessage[];
}

export async function openaiChat(ctx: GenContext, cfg: ResolvedAiConfig): Promise<Metered<ChatReply>> {
  const base = chatBaseMessages(ctx);
  const startedAt = Date.now();
  let text = '';
  let usage: Usage = ZERO_USAGE;
  let truncated = false;

  // 撞上限即自动续写（同 Claude 侧口径）：finish_reason=length 不是失败，是「还没写完」。
  for (let round = 0; ; round++) {
    const data = await callChat(cfg, {
      max_tokens: chatMaxTokens(CHAT_MAX_TOKENS, cfg, round === 0),
      messages: round === 0 ? base : continuationMessages(base, text),
    }, 'chat_completion', affinityOf(ctx), round === 0);
    usage = sumUsage(usage, usageOf(data));
    text = joinContinuation(text, (data.choices?.[0]?.message?.content ?? '').trim());

    const reason = data.choices?.[0]?.finish_reason;
    if (!isTruncatedFinish(reason)) break;
    // 一个字正文都没写就撞上限：没有锚点可续写，如实抛错并指向预算（见 assertChatBodyProduced）。
    if (!text) assertChatBodyProduced('OpenAI', reason, usage.outputTokens);
    if (round >= MAX_CHAT_CONTINUATIONS
      || usage.outputTokens >= CHAT_TOTAL_MAX_TOKENS
      || Date.now() - startedAt > CONTINUE_DEADLINE_MS) {
      truncated = true;
      noteChatTruncated('OpenAI', 'given_up');
      break;
    }
    noteChatTruncated('OpenAI', 'continued');
  }

  return { result: { text: requireText(text, usage, 'chat'), ...(truncated ? { truncated: true } : {}) }, usage };
}

type StreamRoundOut = { text: string; usage: Usage; truncated: boolean };

/**
 * 一轮流式对话：逐字 yield，返回本轮正文 / 用量 / 是否撞上限。
 * `dedupeAgainst` 有值时（续写轮）开头先攒一小段再下发，好把模型复述的半句剪掉。
 */
async function* streamChatRound(
  cfg: ResolvedAiConfig,
  messages: OAMessage[],
  opts: { allowThinking: boolean; affinity?: string; dedupeAgainst?: string; onDelta?: () => void },
): AsyncGenerator<{ type: 'delta'; text: string }, StreamRoundOut> {
  const body = { max_tokens: chatMaxTokens(CHAT_MAX_TOKENS, cfg, opts.allowThinking), messages };
  let chunks: AsyncGenerator<OAStreamChunk>;
  try {
    chunks = await callChatStream(cfg, body, true, opts.affinity);
  } catch (err) {
    if (!/stream_options|include_usage/i.test((err as Error).message)) throw err;
    chunks = await callChatStream(cfg, body, false, opts.affinity);
  }

  let text = '';
  let usage: Usage = ZERO_USAGE;
  let finishReason: string | null = null;
  let head: string | null = opts.dedupeAgainst ? '' : null; // null=已过缓冲期/首轮，直接下发

  const emit = (chunk: string): { type: 'delta'; text: string } | null => {
    if (!chunk) return null;
    text += chunk;
    opts.onDelta?.();
    return { type: 'delta', text: chunk };
  };

  for await (const chunk of chunks) {
    if (chunk.usage) usage = usageOf({ usage: chunk.usage });
    const reason = chunk.choices?.find((choice) => choice.finish_reason)?.finish_reason;
    if (reason) finishReason = reason;
    const delta = chunk.choices?.map((c) => c.delta?.content ?? '').join('') ?? '';
    if (!delta) continue;
    if (head !== null) {
      head += delta;
      if (head.length < CONTINUE_DEDUPE_BUFFER_CHARS) continue;
      const cleaned = dedupeContinuation(opts.dedupeAgainst!, head);
      head = null;
      const ev = emit(cleaned);
      if (ev) yield ev;
      continue;
    }
    const ev = emit(delta);
    if (ev) yield ev;
  }
  if (head) { // 整轮短于缓冲长度（续写只补了一句）
    const ev = emit(dedupeContinuation(opts.dedupeAgainst!, head));
    if (ev) yield ev;
  }

  return { text, usage, truncated: isTruncatedFinish(finishReason) };
}

export async function* openaiChatStream(ctx: GenContext, cfg: ResolvedAiConfig): AsyncGenerator<{ type: 'delta'; text: string } | { type: 'done'; result: ChatReply; usage: Usage }> {
  const base = chatBaseMessages(ctx);
  const affinity = affinityOf(ctx);
  const startedAt = Date.now();

  const first = yield* streamChatRound(cfg, base, { allowThinking: true, affinity });
  let text = first.text;
  let usage = first.usage;
  let truncated = first.truncated;
  // 一个字正文都没写就撞上限：没有锚点可续写，如实抛错并指向预算（见 assertChatBodyProduced）。
  if (truncated && !text) assertChatBodyProduced('OpenAI', 'length', usage.outputTokens);

  // —— 续写轮：撞上限不是失败，是「还没写完」——
  // 续写失败**不算整轮失败**：手里已有可读内容，宁可标 truncated 交给用户点「继续」，
  // 也不能把用户已经看完的半篇回答换成一个错误气泡。affinity 不变，尽量落回同一端点保住缓存。
  for (let round = 1; truncated && text && round <= MAX_CHAT_CONTINUATIONS; round++) {
    if (usage.outputTokens >= CHAT_TOTAL_MAX_TOKENS) break;
    // 墙钟兜底：宁可标 truncated 给「继续写完」，也不能为了补齐把整轮拖到客户端超时——
    // 那会走 clientGone（退预留、不落库），用户连已经看完的半篇都拿不到。
    if (Date.now() - startedAt > CONTINUE_DEADLINE_MS) break;
    try {
      const cont = yield* streamChatRound(cfg, continuationMessages(base, text), {
        allowThinking: false,
        affinity,
        dedupeAgainst: text,
      });
      usage = sumUsage(usage, cont.usage);
      text += cont.text; // 轮内已去重，此处只做拼接（避免与已下发的 delta 对不上）
      truncated = cont.truncated;
      noteChatTruncated('OpenAI', 'continued');
    } catch (err) {
      console.warn(`[llm:openai] 第 ${round} 轮续写失败，按未写完交回用户：${(err as Error).message}`);
      break;
    }
  }
  if (truncated) noteChatTruncated('OpenAI', 'given_up');

  const out = requireText(text, usage, 'chat_stream');
  yield { type: 'done', result: { text: out, ...(truncated ? { truncated: true } : {}) }, usage };
}

/** 轻量纯文本补全（供记忆抽取 / 汇总归纳）：返回 content 文本。 */
export async function openaiRaw(
  cfg: ResolvedAiConfig,
  system: string,
  user: string,
  // maxTokens：**缺省仍是 700**（辅助抽取的既定预算，不动）。只有产物本身就长的调用方才传大值——
  // 目前唯一的是海报 AI 排版引擎（gateway.completeText，一整页 HTML/CSS 几千 token，700 会被硬截断成半张页面）。
  opts: { allowThinking?: boolean; affinityKey?: string; maxTokens?: number } = {},
): Promise<string> {
  const allowThinking = opts.allowThinking ?? true;
  const data = await callChat(cfg, {
    max_tokens: maxTokensForThinking(opts.maxTokens ?? 700, cfg, allowThinking),
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }] as OAMessage[],
  }, 'chat_completion', opts.affinityKey, allowThinking);
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

// —— 工具调用循环的 provider step（多轮 search_knowledge / recall_memory → 最终答案）——

// LoopMessage[] → OpenAI chat messages（含 tool_calls 助手块与 role:'tool' 结果块）。
// images：本轮图片挂到「最后一条 user 文本消息」（当轮用户原文；历史 user 不挂，图片不重发）。
function toOAMessages(messages: LoopMessage[], images?: ImageInput[]): OAMessage[] {
  const out: OAMessage[] = [];
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') { lastUserIdx = i; break; }
  messages.forEach((m, i) => {
    if (m.role === 'assistant_tools') {
      out.push({
        role: 'assistant',
        content: null,
        tool_calls: m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
      });
    } else if (m.role === 'tool_results') {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: i === lastUserIdx ? openaiUserContent(m.text, images) : m.text });
    } else {
      out.push({ role: m.role, content: m.text });
    }
  });
  return out;
}

function toOATools(tools: Tool[]): Record<string, unknown>[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
}

function parseArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

function toolCtxOf(ctx: GenContext): ToolContext {
  return { tenantId: ctx.tenantId ?? null, userId: ctx.userId ?? null, agentKey: ctx.agentKey, projectId: ctx.projectId ?? null, query: ctx.userMessage };
}

export type LoopMetered<T> = Metered<T> & { toolCalls: number; iterations: number };

/** 启用技能时的对话：多轮工具调用循环，模型自行决定何时检索知识/召回记忆，最后出文本。 */
export async function openaiChatWithTools(ctx: GenContext, cfg: ResolvedAiConfig, tools: Tool[]): Promise<LoopMetered<ChatReply>> {
  const system = injectVariables(ctx.systemPrompt, ctx, 'chat');
  const r = await runToolLoop({
    step: openaiStep(cfg, ctx.images),
    system: `${system}\n\n${CHAT_STYLE_GUIDE}`,
    history: ctx.history,
    userMessage: ctx.userMessage,
    tools,
    toolCtx: toolCtxOf(ctx),
  });
  const text = requireText(r.text, r.usage, 'chat_tools');
  return {
    result: { text, ...(r.truncated ? { truncated: true } : {}) },
    usage: r.usage,
    toolCalls: r.toolCalls,
    iterations: r.iterations,
  };
}

/** 启用技能时的产出：循环里可先检索/召回，最后强制 emit_deliverable 收口成结构化成果。 */
export async function openaiDeliverableWithTools(ctx: GenContext, cfg: ResolvedAiConfig, tools: Tool[]): Promise<LoopMetered<Deliverable>> {
  const tpl = ctx.deliverableKey ? DELIVERABLES[ctx.deliverableKey] : undefined;
  const system = injectVariables(ctx.systemPrompt, ctx, 'deliverable');
  const structureHint = tpl
    ? `参考产出结构（小标题）：${tpl.sections.map((s) => s.h).join(' / ')}。标题用「${tpl.title}」。`
    : '产出 3–4 段结构化内容。';
  const r = await runToolLoop({
    step: openaiStep(cfg, ctx.images),
    system: `${system}\n\n${structureHint}\n可先调用工具检索知识/召回记忆，掌握依据后务必调用 emit_deliverable 输出结构化成果，不要输出自由长文。`,
    history: ctx.history,
    userMessage: ctx.userMessage || `请为我产出一份${tpl?.title ?? '咨询成果'}。`,
    tools,
    toolCtx: toolCtxOf(ctx),
    finalTool: { name: DELIVERABLE_TOOL.name, description: DELIVERABLE_TOOL.description, schema: DELIVERABLE_TOOL.input_schema },
  });
  const input = (r.toolInput ?? {}) as { title?: string; sections?: unknown; cover?: unknown };
  const sections = normalizeDeliverableSections(input.sections);
  if (sections.length) {
    return {
      result: {
        title: input?.title || tpl?.title || '咨询成果',
        icon: tpl?.icon ?? 'spark',
        meta: metaOf(ctx),
        cover: normalizeCover(input.cover),
        sections,
        trust: TRUST_NOTE,
        actions: ['save_to_library', 'export_pdf'],
        prescriptions: normalizePrescriptions((input as { prescriptions?: unknown } | null)?.prescriptions),
      },
      usage: r.usage,
      toolCalls: r.toolCalls,
      iterations: r.iterations,
    };
  }
  const textSections = normalizeDeliverableSections(r.text);
  if (textSections.length) {
    return {
      result: {
        title: tpl?.title || '咨询成果',
        icon: tpl?.icon ?? 'spark',
        meta: metaOf(ctx),
        sections: textSections,
        trust: TRUST_NOTE,
        actions: ['save_to_library', 'export_pdf'],
      },
      usage: r.usage,
      toolCalls: r.toolCalls,
      iterations: r.iterations,
    };
  }
  const { mockDeliverable } = await import('./mock.js');
  return { result: { ...mockDeliverable(ctx), degraded: true }, usage: r.usage, toolCalls: r.toolCalls, iterations: r.iterations };
}

export type AdaptiveOut =
  | { kind: 'report'; deliverable: Deliverable; usage: Usage; toolCalls: number; iterations: number }
  | { kind: 'chat'; reply: ChatReply; usage: Usage; toolCalls: number; iterations: number };

/** 按需产出：对话优先，模型自行决定是否调用 emit_deliverable。emit→结构化成果(report)；否则→文本对话(chat)。 */
export async function openaiAdaptive(ctx: GenContext, cfg: ResolvedAiConfig, tools: Tool[]): Promise<AdaptiveOut> {
  const system = injectVariables(ctx.systemPrompt, ctx, 'chat');
  const hint = '默认用文字正常对话回答用户。只有当你判断此刻需要交付一份完整的报告或卡片成果时，才调用 emit_deliverable 以结构化分段输出（含标题与各段小标题/正文/要点）；其余所有情况都直接用文字回复，不要调用 emit_deliverable。';
  const r = await runToolLoop({
    step: openaiStep(cfg, ctx.images),
    system: `${system}\n\n${hint}`,
    history: ctx.history,
    userMessage: ctx.userMessage,
    tools,
    toolCtx: toolCtxOf(ctx),
    finalTool: { name: DELIVERABLE_TOOL.name, description: DELIVERABLE_TOOL.description, schema: DELIVERABLE_TOOL.input_schema },
    forceFinalTool: false, // emit_deliverable 可选，不强制
  });
  const input = (r.toolInput ?? null) as { title?: string; sections?: unknown; cover?: unknown } | null;
  const sections = normalizeDeliverableSections(input?.sections);
  if (sections.length) {
    const tpl = ctx.deliverableKey ? DELIVERABLES[ctx.deliverableKey] : undefined;
    return {
      kind: 'report',
      deliverable: {
        title: input?.title || tpl?.title || '咨询成果',
        icon: tpl?.icon ?? 'spark',
        meta: metaOf(ctx),
        cover: normalizeCover(input?.cover),
        sections,
        trust: TRUST_NOTE,
        actions: ['save_to_library', 'export_pdf'],
        prescriptions: normalizePrescriptions((input as { prescriptions?: unknown } | null)?.prescriptions),
      },
      usage: r.usage, toolCalls: r.toolCalls, iterations: r.iterations,
    };
  }
  const text = requireText(r.text, r.usage, 'adaptive');
  return {
    kind: 'chat',
    reply: { text, ...(r.truncated ? { truncated: true } : {}) },
    usage: r.usage, toolCalls: r.toolCalls, iterations: r.iterations,
  };
}

/** 绑定 cfg（+ 本轮图片），返回 provider 无关循环所需的 step 函数。 */
export function openaiStep(cfg: ResolvedAiConfig, images?: ImageInput[]): StepFn {
  return async (messages, tools, opts) => {
    const finalName = opts.finalTool?.name;
    // 工具集：常规工具 +（deliverable 路径）终结工具 emit_deliverable。
    const toolDefs = [...toOATools(tools)];
    if (opts.finalTool) {
      toolDefs.push({ type: 'function', function: { name: opts.finalTool.name, description: opts.finalTool.description, parameters: opts.finalTool.schema } });
    }

    const body: Record<string, unknown> = { max_tokens: opts.finalTool ? DELIVERABLE_MAX_TOKENS : CHAT_MAX_TOKENS, messages: toOAMessages(messages, images) };
    if (opts.forceFinal) {
      // 最后一轮收口。deliverable(强制)→强制 emit_deliverable；自适应(forceFinalTool=false)→只给 emit 但 auto(可 emit 可出文本)；chat→去掉工具出文本。
      if (opts.finalTool && opts.forceFinalTool !== false) {
        body.tools = toolDefs; body.tool_choice = { type: 'function', function: { name: opts.finalTool.name } };
      } else if (opts.finalTool) {
        const emitDef = { type: 'function', function: { name: opts.finalTool.name, description: opts.finalTool.description, parameters: opts.finalTool.schema } };
        body.tools = [emitDef]; body.tool_choice = 'auto';
      }
    } else if (toolDefs.length) {
      body.tools = toolDefs;
      body.tool_choice = 'auto';
    }

    const data = await callChat(cfg, body, opts.finalTool ? 'deliverable' : 'chat_completion');
    const usage = usageOf(data);
    const msg = data.choices?.[0]?.message;
    const calls = msg?.tool_calls ?? [];
    // 撞上限的处理按「产物能不能半份出厂」分两种：
    //   · 有 tool_calls / 本轮期待结构化成果 → 截断的 arguments 就是坏 JSON，半份报告不能出厂，按失败抛；
    //   · 纯文本对话（含自适应回落文本）→ 内容是可读的，标 truncated 交回，由端上给「继续」。
    const truncated = isTruncatedFinish(data.choices?.[0]?.finish_reason);
    if (truncated && (calls.length || (opts.finalTool && opts.forceFinalTool !== false))) {
      assertChatOutputComplete('OpenAI', data.choices?.[0]?.finish_reason, usage.outputTokens);
    }

    // 命中终结工具 → 最终 deliverable 入参。
    if (finalName) {
      const fin = calls.find((c) => c.function?.name === finalName);
      if (fin) return { kind: 'final', toolInput: parseArgs(fin.function?.arguments), usage };
    }
    // 常规工具调用 → 继续循环。
    const regular = calls.filter((c) => c.function?.name && c.function.name !== finalName);
    if (regular.length) {
      const mapped: ToolCall[] = regular.map((c, i) => ({ id: c.id || `call_${i}`, name: c.function!.name!, args: parseArgs(c.function?.arguments) }));
      return { kind: 'tool_calls', calls: mapped, usage } as TurnOutput;
    }
    // 无工具调用 → 文本即最终答案。
    return { kind: 'final', text: (msg?.content ?? '').trim(), usage, truncated };
  };
}
