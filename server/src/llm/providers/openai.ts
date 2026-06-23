// OpenAI 通用协议提供方（AI_PROVIDER=openai / 任意 openai 兼容网关时启用）。
// 走标准 /v1/chat/completions，兼容 OpenAI / Agnes / DeepSeek / Moonshot(Kimi) / 通义千问兼容模式 等。
// 结构化成果用 function calling（tools）强约束。baseUrl/model/key/温度 来自运行时配置（可后台切换）。

import { DELIVERABLE_TOOL, injectVariables, type Deliverable, type ChatReply, type GenContext, type Metered, type Usage } from '../schema.js';
import { DELIVERABLES, TRUST_NOTE } from '../../data/deliverables.js';
import type { ResolvedAiConfig } from '../../services/aiConfig.js';
import { runToolLoop } from '../tools/loop.js';
import type { LoopMessage, StepFn, Tool, ToolCall, ToolContext, TurnOutput } from '../tools/types.js';

interface OAToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface OAMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OAToolCall[];
  tool_call_id?: string;
}
interface OAResponse {
  choices?: { message?: { content?: string | null; tool_calls?: OAToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string };
}

// 统一请求封装：注入 baseUrl/model/key/温度，带超时；错误抛出由 gateway 兜底降级 mock。
async function callChat(cfg: ResolvedAiConfig, body: Record<string, unknown>): Promise<OAResponse> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, temperature: cfg.temperature, ...body }),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as OAResponse;
    if (!res.ok) throw new Error(`OpenAI 兼容接口 ${res.status}: ${data.error?.message ?? '请求失败'}`);
    return data;
  } finally {
    clearTimeout(timer);
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

export async function openaiDeliverable(ctx: GenContext, cfg: ResolvedAiConfig): Promise<Metered<Deliverable>> {
  const tpl = ctx.deliverableKey ? DELIVERABLES[ctx.deliverableKey] : undefined;
  const system = injectVariables(ctx.systemPrompt, ctx, 'deliverable');
  const structureHint = tpl
    ? `参考产出结构（小标题）：${tpl.sections.map((s) => s.h).join(' / ')}。标题用「${tpl.title}」。`
    : '产出 3–4 段结构化内容。';

  const history: OAMessage[] = (ctx.history ?? []).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
  const data = await callChat(cfg, {
    max_tokens: 1500,
    messages: [
      { role: 'system', content: `${system}\n\n${structureHint}\n务必调用 emit_deliverable 函数输出结构化成果，不要输出自由长文。` },
      ...history,
      { role: 'user', content: ctx.userMessage || `请为我产出一份${tpl?.title ?? '咨询成果'}。` },
    ] as OAMessage[],
    tools: [{ type: 'function', function: { name: DELIVERABLE_TOOL.name, description: DELIVERABLE_TOOL.description, parameters: DELIVERABLE_TOOL.input_schema } }],
    tool_choice: { type: 'function', function: { name: DELIVERABLE_TOOL.name } },
  });

  const usage = usageOf(data);
  const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (args) {
    const input = JSON.parse(args) as { title?: string; sections?: Deliverable['sections'] };
    return {
      result: {
        title: input.title || tpl?.title || '咨询成果',
        icon: tpl?.icon ?? 'spark',
        meta: metaOf(ctx),
        sections: input.sections ?? [],
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
    max_tokens: 800,
    messages: [
      { role: 'system', content: `${system}\n\n回复要冷静、克制、机构级，给出可执行判断；结尾不必每次免责。` },
      ...history,
      { role: 'user', content: ctx.userMessage },
    ] as OAMessage[],
  });
  const text = (data.choices?.[0]?.message?.content ?? '').trim();
  return {
    result: { text: text || '我需要更多信息来给你一个可执行的判断，能再补充一点背景吗？' },
    usage: usageOf(data),
  };
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
function toOAMessages(messages: LoopMessage[]): OAMessage[] {
  const out: OAMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant_tools') {
      out.push({
        role: 'assistant',
        content: null,
        tool_calls: m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
      });
    } else if (m.role === 'tool_results') {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    } else {
      out.push({ role: m.role, content: m.text });
    }
  }
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
    step: openaiStep(cfg),
    system: `${system}\n\n回复要冷静、克制、机构级，给出可执行判断；结尾不必每次免责。`,
    history: ctx.history,
    userMessage: ctx.userMessage,
    tools,
    toolCtx: toolCtxOf(ctx),
  });
  return {
    result: { text: (r.text ?? '').trim() || '我需要更多信息来给你一个可执行的判断，能再补充一点背景吗？' },
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
    step: openaiStep(cfg),
    system: `${system}\n\n${structureHint}\n可先调用工具检索知识/召回记忆，掌握依据后务必调用 emit_deliverable 输出结构化成果，不要输出自由长文。`,
    history: ctx.history,
    userMessage: ctx.userMessage || `请为我产出一份${tpl?.title ?? '咨询成果'}。`,
    tools,
    toolCtx: toolCtxOf(ctx),
    finalTool: { name: DELIVERABLE_TOOL.name, description: DELIVERABLE_TOOL.description, schema: DELIVERABLE_TOOL.input_schema },
  });
  const input = (r.toolInput ?? {}) as { title?: string; sections?: Deliverable['sections'] };
  if (input.sections) {
    return {
      result: {
        title: input.title || tpl?.title || '咨询成果',
        icon: tpl?.icon ?? 'spark',
        meta: metaOf(ctx),
        sections: input.sections,
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
    step: openaiStep(cfg),
    system: `${system}\n\n${hint}`,
    history: ctx.history,
    userMessage: ctx.userMessage,
    tools,
    toolCtx: toolCtxOf(ctx),
    finalTool: { name: DELIVERABLE_TOOL.name, description: DELIVERABLE_TOOL.description, schema: DELIVERABLE_TOOL.input_schema },
    forceFinalTool: false, // emit_deliverable 可选，不强制
  });
  const input = (r.toolInput ?? null) as { title?: string; sections?: Deliverable['sections'] } | null;
  if (input?.sections?.length) {
    const tpl = ctx.deliverableKey ? DELIVERABLES[ctx.deliverableKey] : undefined;
    return {
      kind: 'report',
      deliverable: {
        title: input.title || tpl?.title || '咨询成果',
        icon: tpl?.icon ?? 'spark',
        meta: metaOf(ctx),
        sections: input.sections,
        trust: TRUST_NOTE,
        actions: ['save_to_library', 'export_pdf'],
      },
      usage: r.usage, toolCalls: r.toolCalls, iterations: r.iterations,
    };
  }
  return {
    kind: 'chat',
    reply: { text: (r.text ?? '').trim() || '我需要更多信息来给你一个可执行的判断，能再补充一点背景吗？' },
    usage: r.usage, toolCalls: r.toolCalls, iterations: r.iterations,
  };
}

/** 绑定 cfg，返回 provider 无关循环所需的 step 函数。 */
export function openaiStep(cfg: ResolvedAiConfig): StepFn {
  return async (messages, tools, opts) => {
    const finalName = opts.finalTool?.name;
    // 工具集：常规工具 +（deliverable 路径）终结工具 emit_deliverable。
    const toolDefs = [...toOATools(tools)];
    if (opts.finalTool) {
      toolDefs.push({ type: 'function', function: { name: opts.finalTool.name, description: opts.finalTool.description, parameters: opts.finalTool.schema } });
    }

    const body: Record<string, unknown> = { max_tokens: opts.finalTool ? 1500 : 800, messages: toOAMessages(messages) };
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

    const data = await callChat(cfg, body);
    const usage = usageOf(data);
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
