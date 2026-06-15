// Claude 提供方（provider=claude 时启用）。用 tool use 强制结构化成果输出。
// apiKey/model 来自运行时配置（可后台切换）。

import Anthropic from '@anthropic-ai/sdk';
import { DELIVERABLE_TOOL, injectVariables, type Deliverable, type ChatReply, type GenContext, type Metered, type Usage } from '../schema.js';
import { DELIVERABLES, TRUST_NOTE } from '../../data/deliverables.js';
import type { ResolvedAiConfig } from '../../services/aiConfig.js';
import type { LoopMessage, StepFn, Tool, ToolCall } from '../tools/types.js';

// 按 key 缓存 client（后台切换 key 后自动新建）。
let cached: { key: string; client: Anthropic } | null = null;
function getClient(apiKey: string): Anthropic {
  if (!cached || cached.key !== apiKey) cached = { key: apiKey, client: new Anthropic({ apiKey }) };
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

export async function claudeDeliverable(ctx: GenContext, cfg: ResolvedAiConfig): Promise<Metered<Deliverable>> {
  const tpl = ctx.deliverableKey ? DELIVERABLES[ctx.deliverableKey] : undefined;
  const system = injectVariables(ctx.systemPrompt, ctx);
  const structureHint = tpl
    ? `参考产出结构（小标题）：${tpl.sections.map((s) => s.h).join(' / ')}。标题用「${tpl.title}」。`
    : '产出 3–4 段结构化内容。';

  const res = await getClient(cfg.apiKey).messages.create({
    model: cfg.model,
    max_tokens: 1500,
    temperature: cfg.temperature,
    system: `${system}\n\n${structureHint}\n务必调用 emit_deliverable 工具输出结构化成果，不要输出自由长文。`,
    tools: [DELIVERABLE_TOOL],
    tool_choice: { type: 'tool', name: 'emit_deliverable' },
    messages: [{ role: 'user', content: ctx.userMessage || `请为我产出一份${tpl?.title ?? '咨询成果'}。` }],
  });
  const usage = usageOf(res);

  const toolUse = res.content.find((c) => c.type === 'tool_use');
  if (toolUse && toolUse.type === 'tool_use') {
    const input = toolUse.input as { title: string; sections: Deliverable['sections'] };
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
  // 真实调用已发生（已花 token）：即便没拿到 tool 输出，也按真实 usage 记账，内容兜底 mock。
  const { mockDeliverable } = await import('./mock.js');
  return { result: mockDeliverable(ctx), usage };
}

export async function claudeChat(ctx: GenContext, cfg: ResolvedAiConfig): Promise<Metered<ChatReply>> {
  const system = injectVariables(ctx.systemPrompt, ctx);
  const history = (ctx.history ?? []).map((m) => ({
    role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
    content: m.text,
  }));
  const res = await getClient(cfg.apiKey).messages.create({
    model: cfg.model,
    max_tokens: 800,
    temperature: cfg.temperature,
    system: `${system}\n\n回复要冷静、克制、机构级，给出可执行判断；结尾不必每次免责。`,
    messages: [...history, { role: 'user', content: ctx.userMessage }],
  });
  const text = res.content
    .filter((c) => c.type === 'text')
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('\n')
    .trim();
  return {
    result: { text: text || '我需要更多信息来给你一个可执行的判断，能再补充一点背景吗？' },
    usage: usageOf(res),
  };
}

/** 轻量纯文本补全（供记忆抽取 / 汇总归纳）：返回文本。 */
export async function claudeRaw(cfg: ResolvedAiConfig, system: string, user: string): Promise<string> {
  const res = await getClient(cfg.apiKey).messages.create({
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
      max_tokens: opts.finalTool ? 1500 : 800,
      temperature: cfg.temperature,
      system,
      messages: msgs,
    };
    if (opts.forceFinal) {
      // 最后一轮强制收口：deliverable 强制 emit_deliverable；chat 去掉工具直接出文本。
      if (opts.finalTool) { req.tools = toolDefs; req.tool_choice = { type: 'tool', name: opts.finalTool.name }; }
    } else if (toolDefs.length) {
      req.tools = toolDefs;
      req.tool_choice = { type: 'auto' };
    }

    const res = await getClient(cfg.apiKey).messages.create(req);
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
