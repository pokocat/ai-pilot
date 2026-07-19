// Claude 提供方（provider=claude 时启用）。用 tool use 强制结构化成果输出。
// apiKey/model 来自运行时配置（可后台切换）。

import Anthropic from '@anthropic-ai/sdk';
import { DELIVERABLE_TOOL, buildSystemParts, normalizeDeliverableSections, normalizePrescriptions, normalizeCover, type Deliverable, type ChatReply, type GenContext, type Metered, type Usage } from '../schema.js';
import { DELIVERABLES, TRUST_NOTE } from '../../data/deliverables.js';
import type { ResolvedAiConfig } from '../../services/aiConfig.js';
import type { LoopMessage, StepFn, Tool, ToolCall, ToolContext } from '../tools/types.js';
import { runToolLoop } from '../tools/loop.js';
import type { AdaptiveOut } from './openai.js';

const DELIVERABLE_MAX_TOKENS = 8000; // 报告产出上限（放到整份报告够用，实际按需生成不硬凑）
const CHAT_MAX_TOKENS = 4000; // 对话回复上限（放到日常永远碰不到，等于不截断）

// system 拆成「稳定前缀(打缓存断点) + 每轮变化的参考资料」两块，命中缓存按 ~1/10 计费。
// 提示词不足最低缓存阈值(Opus 4.8 约 4096 token、Sonnet 约 2048)时 cache_control 自动忽略，无副作用。
// 提示词缓存在现网为 GA、无需 beta header；SDK 0.32.1 的 TextBlockParam 类型尚无 cache_control 字段，
// 但真实 API 接受该字段且 SDK 原样透传，故用局部 cast 下发。命中情况看 usage.cache_read_input_tokens。
type CachedTextBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };
function systemBlocks(stableText: string, dynamic: string): Anthropic.TextBlockParam[] {
  const out: CachedTextBlock[] = [{ type: 'text', text: stableText, cache_control: { type: 'ephemeral' } }];
  if (dynamic) out.push({ type: 'text', text: dynamic });
  return out as unknown as Anthropic.TextBlockParam[];
}

// 按 (key + baseUrl) 缓存 client（后台切换 key/接入点后自动新建）。
// 第三方 Anthropic 兼容网关（如七牛 qnaigc 的 /bypass/anthropic）：填了 baseUrl 时
// ① 透传 baseURL —— SDK 会自动补 /v1/messages，故把用户可能粘贴的 /v1/messages 后缀去掉，避免重复成 404；
// ② 这类网关多用 Authorization: Bearer 鉴权，而官方 SDK 默认只发 x-api-key，故额外补一个 Bearer 头
//    （两头并存，官方端会忽略多余的 Authorization）。baseUrl 留空＝官方 Anthropic，保持 x-api-key 原状不变。
let cached: { key: string; client: Anthropic } | null = null;
function getClient(apiKey: string, baseUrl?: string): Anthropic {
  const base = baseUrl?.trim().replace(/\/+$/, '').replace(/\/v1\/messages$/, '') || '';
  const cacheKey = `${apiKey}|${base}`;
  if (!cached || cached.key !== cacheKey) {
    cached = {
      key: cacheKey,
      client: new Anthropic(
        base
          ? { apiKey, baseURL: base, defaultHeaders: { Authorization: `Bearer ${apiKey}` } }
          : { apiKey },
      ),
    };
  }
  return cached.client;
}

function metaOf(ctx: GenContext): string {
  const parts = [ctx.companyName, ctx.profile?.industry, ctx.profile?.stage].filter(Boolean) as string[];
  return parts.length ? parts.join(' · ') : '经营快照';
}

// Anthropic usage → 归一 Usage。input_tokens 不含缓存命中，故 total 要把 cache_read/create 加回。
function usageOf(res: Anthropic.Message): Usage {
  const u = res.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: u.input_tokens + cacheRead + cacheCreate,
    outputTokens: u.output_tokens,
    cachedInput: cacheRead,
  };
}

function requireText(text: string | null | undefined, usage: Usage, where: string): string {
  const out = (text ?? '').trim();
  if (out) return out;
  const detail = usage.outputTokens > 0 ? `，输出 token=${usage.outputTokens}` : '';
  throw Object.assign(new Error(`Claude 接口返回空文本（${where}${detail}）`), { code: 'AI_EMPTY_RESPONSE' });
}

export async function claudeDeliverable(ctx: GenContext, cfg: ResolvedAiConfig): Promise<Metered<Deliverable>> {
  const tpl = ctx.deliverableKey ? DELIVERABLES[ctx.deliverableKey] : undefined;
  const { stable, dynamic } = buildSystemParts(ctx.systemPrompt, ctx, 'deliverable');
  const structureHint = tpl
    ? `参考产出结构（小标题）：${tpl.sections.map((s) => s.h).join(' / ')}。标题用「${tpl.title}」。`
    : '产出 3–4 段结构化内容。';
  const dlvHistory = (ctx.history ?? []).map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('assistant' as const), content: m.text }));

  const res = await getClient(cfg.apiKey, cfg.baseUrl).messages.create({
    model: cfg.model,
    max_tokens: DELIVERABLE_MAX_TOKENS,
    temperature: cfg.temperature,
    system: systemBlocks(`${stable}\n\n${structureHint}\n务必调用 emit_deliverable 工具输出结构化成果，不要输出自由长文。`, dynamic),
    tools: [DELIVERABLE_TOOL],
    tool_choice: { type: 'tool', name: 'emit_deliverable' },
    messages: [...dlvHistory, { role: 'user', content: ctx.userMessage || `请为我产出一份${tpl?.title ?? '咨询成果'}。` }],
  });
  const usage = usageOf(res);

  const toolUse = res.content.find((c) => c.type === 'tool_use');
  if (toolUse && toolUse.type === 'tool_use') {
    const input = toolUse.input as { title?: string; sections?: unknown; cover?: unknown };
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
          prescriptions: normalizePrescriptions((input as { prescriptions?: unknown } | null)?.prescriptions),
        },
        usage,
      };
    }
  }
  const textSections = normalizeDeliverableSections(
    res.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
  );
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
  // 真实调用已发生（已花 token）：即便没拿到 tool 输出，也按真实 usage 记账（成本可观测），内容兜底 mock 并标 degraded（用户侧不计费、提示可重试）。
  const { mockDeliverable } = await import('./mock.js');
  return { result: { ...mockDeliverable(ctx), degraded: true }, usage };
}

export async function claudeChat(ctx: GenContext, cfg: ResolvedAiConfig): Promise<Metered<ChatReply>> {
  const { stable, dynamic } = buildSystemParts(ctx.systemPrompt, ctx, 'chat');
  const history = (ctx.history ?? []).map((m) => ({
    role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
    content: m.text,
  }));
  const res = await getClient(cfg.apiKey, cfg.baseUrl).messages.create({
    model: cfg.model,
    max_tokens: CHAT_MAX_TOKENS,
    temperature: cfg.temperature,
    system: systemBlocks(`${stable}\n\n回复要冷静、克制、机构级，给出可执行判断；结尾不必每次免责。`, dynamic),
    messages: [...history, { role: 'user', content: ctx.userMessage }],
  });
  const text = res.content
    .filter((c) => c.type === 'text')
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('\n')
    .trim();
  const usage = usageOf(res);
  return { result: { text: requireText(text, usage, 'chat') }, usage };
}

export async function* claudeChatStream(ctx: GenContext, cfg: ResolvedAiConfig): AsyncGenerator<{ type: 'delta'; text: string } | { type: 'done'; result: ChatReply; usage: Usage }> {
  const { stable, dynamic } = buildSystemParts(ctx.systemPrompt, ctx, 'chat');
  const history = (ctx.history ?? []).map((m) => ({
    role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
    content: m.text,
  }));
  const stream = getClient(cfg.apiKey, cfg.baseUrl).messages.stream({
    model: cfg.model,
    max_tokens: CHAT_MAX_TOKENS,
    temperature: cfg.temperature,
    system: systemBlocks(`${stable}\n\n回复要冷静、克制、机构级，给出可执行判断；结尾不必每次免责。`, dynamic),
    messages: [...history, { role: 'user', content: ctx.userMessage }],
  });
  let text = '';
  let usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInput: 0 };
  for await (const event of stream) {
    if (event.type === 'message_start') usage = usageOf(event.message);
    else if (event.type === 'message_delta') usage = { ...usage, outputTokens: event.usage.output_tokens };
    else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text;
      yield { type: 'delta', text: event.delta.text };
    }
  }
  const final = await stream.finalMessage().catch(() => null);
  if (final) usage = usageOf(final);
  const out = requireText(text || final?.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : '')).join('\n'), usage, 'chat_stream');
  yield { type: 'done', result: { text: out }, usage };
}

/** 轻量纯文本补全（供记忆抽取 / 汇总归纳）：返回文本。 */
export async function claudeRaw(cfg: ResolvedAiConfig, system: string, user: string): Promise<string> {
  const res = await getClient(cfg.apiKey, cfg.baseUrl).messages.create({
    model: cfg.model,
    max_tokens: 700,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return res.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : '')).join('\n').trim();
}

// —— 工具调用循环的 provider step（Anthropic tool_use / tool_result 形态）——

// LoopMessage[] → Anthropic system（顶层）+ messages（含 tool_use / tool_result 块）。
function toClaudeMessages(messages: LoopMessage[]): { system: string; msgs: Anthropic.MessageParam[] } {
  let system = '';
  const msgs: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'system') system = m.text;
    else if (m.role === 'user') msgs.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') msgs.push({ role: 'assistant', content: m.text });
    else if (m.role === 'assistant_tools') {
      msgs.push({ role: 'assistant', content: m.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} })) });
    } else if (m.role === 'tool_results') {
      msgs.push({ role: 'user', content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: r.isError })) });
    }
  }
  return { system, msgs };
}

/** 绑定 cfg，返回 provider 无关循环所需的 step 函数。 */
export function claudeStep(cfg: ResolvedAiConfig): StepFn {
  return async (messages, tools, opts) => {
    const finalName = opts.finalTool?.name;
    const { system, msgs } = toClaudeMessages(messages);
    const toolDefs: Anthropic.Tool[] = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool['input_schema'] }));
    if (opts.finalTool) toolDefs.push({ name: opts.finalTool.name, description: opts.finalTool.description, input_schema: opts.finalTool.schema as Anthropic.Tool['input_schema'] });

    const req: Anthropic.MessageCreateParamsNonStreaming = {
      model: cfg.model,
      max_tokens: opts.finalTool ? DELIVERABLE_MAX_TOKENS : CHAT_MAX_TOKENS,
      temperature: cfg.temperature,
      system: systemBlocks(system, ''),
      messages: msgs,
    };
    if (opts.forceFinal) {
      // 最后一轮收口。deliverable(强制)→强制 emit_deliverable；自适应(forceFinalTool=false)→只给 emit 但 auto(可 emit 可出文本)；chat→去掉工具出文本。
      if (opts.finalTool && opts.forceFinalTool !== false) {
        req.tools = toolDefs; req.tool_choice = { type: 'tool', name: opts.finalTool.name };
      } else if (opts.finalTool) {
        const emitDef: Anthropic.Tool = { name: opts.finalTool.name, description: opts.finalTool.description, input_schema: opts.finalTool.schema as Anthropic.Tool['input_schema'] };
        req.tools = [emitDef]; req.tool_choice = { type: 'auto' };
      }
    } else if (toolDefs.length) {
      req.tools = toolDefs;
      req.tool_choice = { type: 'auto' };
    }

    const res = await getClient(cfg.apiKey, cfg.baseUrl).messages.create(req);
    const usage = usageOf(res);
    const toolUses = res.content.filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');

    if (finalName) {
      const fin = toolUses.find((c) => c.name === finalName);
      if (fin) return { kind: 'final', toolInput: fin.input as Record<string, unknown>, usage };
    }
    const regular = toolUses.filter((c) => c.name !== finalName);
    if (regular.length) {
      const mapped: ToolCall[] = regular.map((c) => ({ id: c.id, name: c.name, args: (c.input as Record<string, unknown>) ?? {} }));
      return { kind: 'tool_calls', calls: mapped, usage };
    }
    const text = res.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : '')).join('\n').trim();
    return { kind: 'final', text, usage };
  };
}

// —— P1-D1：claude 的工具调用循环（此前 gateway 从不路由工具到 claude，claudeStep 形同死代码）——

type LoopMeteredC<T> = Metered<T> & { toolCalls: number; iterations: number };

function toolCtxOf(ctx: GenContext): ToolContext {
  return { tenantId: ctx.tenantId ?? null, userId: ctx.userId ?? null, agentKey: ctx.agentKey, projectId: ctx.projectId ?? null, query: ctx.userMessage };
}

/** 启用技能时的对话（claude）：多轮工具调用循环，模型自行检索知识/召回记忆后出文本。 */
export async function claudeChatWithTools(ctx: GenContext, cfg: ResolvedAiConfig, tools: Tool[]): Promise<LoopMeteredC<ChatReply>> {
  const { stable, dynamic } = buildSystemParts(ctx.systemPrompt, ctx, 'chat');
  const system = dynamic ? `${stable}\n\n${dynamic}` : stable;
  const r = await runToolLoop({
    step: claudeStep(cfg),
    system: `${system}\n\n回复要冷静、克制、机构级，给出可执行判断；结尾不必每次免责。`,
    history: ctx.history,
    userMessage: ctx.userMessage,
    tools,
    toolCtx: toolCtxOf(ctx),
  });
  return { result: { text: requireText(r.text, r.usage, 'chat_tools') }, usage: r.usage, toolCalls: r.toolCalls, iterations: r.iterations };
}

/** 启用技能时的产出（claude）：循环里可先检索/召回，最后强制 emit_deliverable 收口。 */
export async function claudeDeliverableWithTools(ctx: GenContext, cfg: ResolvedAiConfig, tools: Tool[]): Promise<LoopMeteredC<Deliverable>> {
  const tpl = ctx.deliverableKey ? DELIVERABLES[ctx.deliverableKey] : undefined;
  const { stable, dynamic } = buildSystemParts(ctx.systemPrompt, ctx, 'deliverable');
  const system = dynamic ? `${stable}\n\n${dynamic}` : stable;
  const structureHint = tpl
    ? `参考产出结构（小标题）：${tpl.sections.map((s) => s.h).join(' / ')}。标题用「${tpl.title}」。`
    : '产出 3–4 段结构化内容。';
  const r = await runToolLoop({
    step: claudeStep(cfg),
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
        title: input.title || tpl?.title || '咨询成果',
        icon: tpl?.icon ?? 'spark',
        meta: metaOf(ctx),
        cover: normalizeCover(input.cover),
        sections,
        trust: TRUST_NOTE,
        actions: ['save_to_library', 'export_pdf'],
        prescriptions: normalizePrescriptions((input as { prescriptions?: unknown } | null)?.prescriptions),
      },
      usage: r.usage, toolCalls: r.toolCalls, iterations: r.iterations,
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
      usage: r.usage, toolCalls: r.toolCalls, iterations: r.iterations,
    };
  }
  const { mockDeliverable } = await import('./mock.js');
  return { result: { ...mockDeliverable(ctx), degraded: true }, usage: r.usage, toolCalls: r.toolCalls, iterations: r.iterations };
}

/** 按需产出（claude）：对话优先，模型自行决定是否调用 emit_deliverable。emit→结构化成果(report)；否则→文本对话(chat)。
 *  与 openaiAdaptive 契约一致（forceFinalTool=false → emit 可选）；总军师 general 走此路，平时聊天、时机到位才出报告。 */
export async function claudeAdaptive(ctx: GenContext, cfg: ResolvedAiConfig, tools: Tool[]): Promise<AdaptiveOut> {
  const { stable, dynamic } = buildSystemParts(ctx.systemPrompt, ctx, 'chat');
  const system = dynamic ? `${stable}\n\n${dynamic}` : stable;
  const hint = '默认用文字正常对话回答用户。只有当你判断此刻需要交付一份完整的报告或卡片成果时，才调用 emit_deliverable 以结构化分段输出（含标题与各段小标题/正文/要点）；其余所有情况都直接用文字回复，不要调用 emit_deliverable。';
  const r = await runToolLoop({
    step: claudeStep(cfg),
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
  return {
    kind: 'chat',
    reply: { text: requireText(r.text, r.usage, 'adaptive') },
    usage: r.usage, toolCalls: r.toolCalls, iterations: r.iterations,
  };
}
