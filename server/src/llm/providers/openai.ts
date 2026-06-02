// OpenAI 通用协议提供方（AI_PROVIDER=openai 时启用）。
// 走标准 /v1/chat/completions，兼容 OpenAI / DeepSeek / Moonshot(Kimi) / 通义千问兼容模式 等。
// 结构化成果用 function calling（tools）强约束，对齐 claude 提供方的 tool use 思路。

import { env } from '../../env.js';
import { DELIVERABLE_TOOL, injectVariables, type Deliverable, type ChatReply, type GenContext } from '../schema.js';
import { DELIVERABLES, TRUST_NOTE } from '../../data/deliverables.js';

interface OAMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OAResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { total_tokens?: number };
  error?: { message?: string };
}

// 统一请求封装：注入 model / key，带超时，错误抛出由 gateway 兜底降级到 mock。
async function callChat(body: Record<string, unknown>): Promise<OAResponse> {
  const base = env.openaiBaseUrl.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), env.openaiTimeoutMs);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openaiApiKey}`,
      },
      body: JSON.stringify({ model: env.openaiModel, ...body }),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as OAResponse;
    if (!res.ok) {
      throw new Error(`OpenAI 兼容接口 ${res.status}: ${data.error?.message ?? '请求失败'}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function metaOf(ctx: GenContext): string {
  const p = ctx.profile;
  if (p?.industry) return `云栖科技 · ${p.industry}${p.stage ? ' · ' + p.stage : ''}`;
  return '云栖科技 · 已就绪';
}

export async function openaiDeliverable(ctx: GenContext): Promise<Deliverable> {
  const tpl = ctx.deliverableKey ? DELIVERABLES[ctx.deliverableKey] : undefined;
  const system = injectVariables(ctx.systemPrompt, ctx);
  const structureHint = tpl
    ? `参考产出结构（小标题）：${tpl.sections.map((s) => s.h).join(' / ')}。标题用「${tpl.title}」。`
    : '产出 3–4 段结构化内容。';

  const data = await callChat({
    max_tokens: 1500,
    messages: [
      {
        role: 'system',
        content: `${system}\n\n${structureHint}\n务必调用 emit_deliverable 函数输出结构化成果，不要输出自由长文。`,
      },
      { role: 'user', content: ctx.userMessage || `请为我产出一份${tpl?.title ?? '咨询成果'}。` },
    ] as OAMessage[],
    tools: [
      {
        type: 'function',
        function: {
          name: DELIVERABLE_TOOL.name,
          description: DELIVERABLE_TOOL.description,
          parameters: DELIVERABLE_TOOL.input_schema,
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: DELIVERABLE_TOOL.name } },
  });

  const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (args) {
    const input = JSON.parse(args) as { title?: string; sections?: Deliverable['sections'] };
    return {
      title: input.title || tpl?.title || '咨询成果',
      icon: tpl?.icon ?? 'spark',
      meta: metaOf(ctx),
      sections: input.sections ?? [],
      trust: TRUST_NOTE,
      actions: ['save_to_library', 'export_pdf'],
    };
  }
  // 兜底：模型未走函数调用时退回模板
  const { mockDeliverable } = await import('./mock.js');
  return mockDeliverable(ctx);
}

export async function openaiChat(ctx: GenContext): Promise<ChatReply> {
  const system = injectVariables(ctx.systemPrompt, ctx);
  const history: OAMessage[] = (ctx.history ?? []).map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.text,
  }));
  const data = await callChat({
    max_tokens: 800,
    messages: [
      { role: 'system', content: `${system}\n\n回复要冷静、克制、机构级，给出可执行判断；结尾不必每次免责。` },
      ...history,
      { role: 'user', content: ctx.userMessage },
    ] as OAMessage[],
  });
  const text = (data.choices?.[0]?.message?.content ?? '').trim();
  return { text: text || '我需要更多信息来给你一个可执行的判断，能再补充一点背景吗？' };
}
