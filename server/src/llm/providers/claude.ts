// Claude 提供方（真实模型，AI_PROVIDER=claude 时启用）。
// 用 tool use 强制模型以结构化成果 schema 输出（避免自由长文），对齐《投产开发指导》§4.2 / §5.2。

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../env.js';
import { DELIVERABLE_TOOL, injectVariables, type Deliverable, type ChatReply, type GenContext } from '../schema.js';
import { DELIVERABLES, TRUST_NOTE } from '../../data/deliverables.js';

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env.anthropicApiKey });
  return client;
}

function metaOf(ctx: GenContext): string {
  const p = ctx.profile;
  if (p?.industry) return `云栖科技 · ${p.industry}${p.stage ? ' · ' + p.stage : ''}`;
  return '云栖科技 · 已就绪';
}

export async function claudeDeliverable(ctx: GenContext): Promise<Deliverable> {
  const tpl = ctx.deliverableKey ? DELIVERABLES[ctx.deliverableKey] : undefined;
  const system = injectVariables(ctx.systemPrompt, ctx);
  const structureHint = tpl
    ? `参考产出结构（小标题）：${tpl.sections.map((s) => s.h).join(' / ')}。标题用「${tpl.title}」。`
    : '产出 3–4 段结构化内容。';

  const res = await getClient().messages.create({
    model: env.claudeModel,
    max_tokens: 1500,
    system: `${system}\n\n${structureHint}\n务必调用 emit_deliverable 工具输出结构化成果，不要输出自由长文。`,
    tools: [DELIVERABLE_TOOL],
    tool_choice: { type: 'tool', name: 'emit_deliverable' },
    messages: [{ role: 'user', content: ctx.userMessage || `请为我产出一份${tpl?.title ?? '咨询成果'}。` }],
  });

  const toolUse = res.content.find((c) => c.type === 'tool_use');
  if (toolUse && toolUse.type === 'tool_use') {
    const input = toolUse.input as { title: string; sections: Deliverable['sections'] };
    return {
      title: input.title || tpl?.title || '咨询成果',
      icon: tpl?.icon ?? 'spark',
      meta: metaOf(ctx),
      sections: input.sections ?? [],
      trust: TRUST_NOTE,
      actions: ['save_to_library', 'export_pdf'],
    };
  }
  // 兜底：模型未走工具时退回模板
  const { mockDeliverable } = await import('./mock.js');
  return mockDeliverable(ctx);
}

export async function claudeChat(ctx: GenContext): Promise<ChatReply> {
  const system = injectVariables(ctx.systemPrompt, ctx);
  const history = (ctx.history ?? []).map((m) => ({
    role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
    content: m.text,
  }));
  const res = await getClient().messages.create({
    model: env.claudeModel,
    max_tokens: 800,
    system: `${system}\n\n回复要冷静、克制、机构级，给出可执行判断；结尾不必每次免责。`,
    messages: [...history, { role: 'user', content: ctx.userMessage }],
  });
  const text = res.content
    .filter((c) => c.type === 'text')
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('\n')
    .trim();
  return { text: text || '我需要更多信息来给你一个可执行的判断，能再补充一点背景吗？' };
}
