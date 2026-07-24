// OpenAI 通用协议提供方（AI_PROVIDER=openai / 任意 openai 兼容网关时启用）。
// 走标准 /v1/chat/completions，兼容 OpenAI / Agnes / DeepSeek / Moonshot(Kimi) / 通义千问兼容模式 等。
// 结构化成果用 function calling（tools）强约束。baseUrl/model/key/温度 来自运行时配置（可后台切换）。

import { DELIVERABLE_TOOL, injectVariables, normalizeDeliverableSections, normalizePrescriptions, normalizeCover, type Deliverable, type ChatReply, type GenContext, type Metered, type Usage } from '../schema.js';
import { DELIVERABLES, TRUST_NOTE } from '../../data/deliverables.js';
import type { ResolvedAiConfig } from '../../services/aiConfig.js';
import { runToolLoop } from '../tools/loop.js';
import type { LoopMessage, StepFn, Tool, ToolCall, ToolContext, TurnOutput } from '../tools/types.js';
import { assertChatOutputComplete, CHAT_MAX_TOKENS } from './completionGuard.js';

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
// 结构化成果通常比普通问答更慢，尤其是强制 tool calling 的兼容网关。
// 保留 OPENAI_TIMEOUT_MS 作为全局下限；成果请求至少允许两分钟完成。
const DELIVERABLE_TIMEOUT_MS = 120_000;

type RequestPhase = 'chat_completion' | 'deliverable' | 'chat_stream';

function requestTimeoutMs(cfg: ResolvedAiConfig, phase: RequestPhase): number {
  return phase === 'deliverable'
    ? Math.max(cfg.timeoutMs, DELIVERABLE_TIMEOUT_MS)
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
async function callChat(cfg: ResolvedAiConfig, body: Record<string, unknown>, phase: RequestPhase = 'chat_completion'): Promise<OAResponse> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const timeoutMs = requestTimeoutMs(cfg, phase);
  const watch = deadline(timeoutMs);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, temperature: cfg.temperature, ...body }),
      signal: watch.signal,
    });
    const data = (await res.json().catch(() => ({}))) as OAResponse;
    if (!res.ok) throw new Error(`OpenAI 兼容接口 ${res.status}: ${data.error?.message ?? '请求失败'}`);
    return data;
  } catch (err) {
    throw providerFailure(err, cfg, base, phase, timeoutMs, watch);
  } finally {
    watch.clear();
  }
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

async function callChatStream(cfg: ResolvedAiConfig, body: Record<string, unknown>, includeUsage = true): Promise<AsyncGenerator<OAStreamChunk>> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const watch = deadline(cfg.timeoutMs);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: cfg.temperature,
        ...body,
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
      throw new Error(`OpenAI 兼容接口 ${res.status}: ${data.error?.message ?? '请求失败'}`);
    }
    return (async function* () {
      try { yield* readOpenAIStream(res, watch.refresh); }
      catch (err) { throw providerFailure(err, cfg, base, 'chat_stream', cfg.timeoutMs, watch); }
      finally { watch.clear(); }
    })();
  } catch (err) {
    throw providerFailure(err, cfg, base, 'chat_stream', cfg.timeoutMs, watch);
  }
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
  }, 'deliverable');

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

export async function openaiChat(ctx: GenContext, cfg: ResolvedAiConfig): Promise<Metered<ChatReply>> {
  const system = injectVariables(ctx.systemPrompt, ctx, 'chat');
  const history: OAMessage[] = (ctx.history ?? []).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
  const data = await callChat(cfg, {
    max_tokens: CHAT_MAX_TOKENS,
    messages: [
      { role: 'system', content: `${system}\n\n回复要冷静、克制、机构级，给出可执行判断；结尾不必每次免责。` },
      ...history,
      { role: 'user', content: openaiUserContent(ctx.userMessage, ctx.images) },
    ] as OAMessage[],
  });
  const usage = usageOf(data);
  assertChatOutputComplete('OpenAI', data.choices?.[0]?.finish_reason, usage.outputTokens);
  const text = requireText(data.choices?.[0]?.message?.content, usage, 'chat');
  return {
    result: { text },
    usage,
  };
}

export async function* openaiChatStream(ctx: GenContext, cfg: ResolvedAiConfig): AsyncGenerator<{ type: 'delta'; text: string } | { type: 'done'; result: ChatReply; usage: Usage }> {
  const system = injectVariables(ctx.systemPrompt, ctx, 'chat');
  const history: OAMessage[] = (ctx.history ?? []).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
  const body = {
    max_tokens: CHAT_MAX_TOKENS,
    messages: [
      { role: 'system', content: `${system}\n\n回复要冷静、克制、机构级，给出可执行判断；结尾不必每次免责。` },
      ...history,
      { role: 'user', content: openaiUserContent(ctx.userMessage, ctx.images) },
    ] as OAMessage[],
  };
  let chunks: AsyncGenerator<OAStreamChunk>;
  try {
    chunks = await callChatStream(cfg, body, true);
  } catch (err) {
    if (!/stream_options|include_usage/i.test((err as Error).message)) throw err;
    chunks = await callChatStream(cfg, body, false);
  }
  let text = '';
  let usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInput: 0 };
  let finishReason: string | null = null;
  for await (const chunk of chunks) {
    if (chunk.usage) usage = usageOf({ usage: chunk.usage });
    const reason = chunk.choices?.find((choice) => choice.finish_reason)?.finish_reason;
    if (reason) finishReason = reason;
    const delta = chunk.choices?.map((c) => c.delta?.content ?? '').join('') ?? '';
    if (delta) {
      text += delta;
      yield { type: 'delta', text: delta };
    }
  }
  assertChatOutputComplete('OpenAI', finishReason, usage.outputTokens);
  const out = requireText(text, usage, 'chat_stream');
  yield { type: 'done', result: { text: out }, usage };
}

/** 轻量纯文本补全（供记忆抽取 / 汇总归纳）：返回 content 文本。 */
export async function openaiRaw(cfg: ResolvedAiConfig, system: string, user: string): Promise<string> {
  const data = await callChat(cfg, {
    max_tokens: 700,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }] as OAMessage[],
  });
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
    system: `${system}\n\n回复要冷静、克制、机构级，给出可执行判断；结尾不必每次免责。`,
    history: ctx.history,
    userMessage: ctx.userMessage,
    tools,
    toolCtx: toolCtxOf(ctx),
  });
  const text = requireText(r.text, r.usage, 'chat_tools');
  return {
    result: { text },
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
    reply: { text },
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
    assertChatOutputComplete('OpenAI', data.choices?.[0]?.finish_reason, usage.outputTokens);
    const msg = data.choices?.[0]?.message;
    const calls = msg?.tool_calls ?? [];

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
    return { kind: 'final', text: (msg?.content ?? '').trim(), usage };
  };
}
