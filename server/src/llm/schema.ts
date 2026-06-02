// 结构化成果数据契约（《投产开发指导》§4.2）。
// 真实模型输出必须约束成此结构（claude 提供方用 tool/function calling 强约束）。

export interface DeliverableSection {
  h: string;
  b?: string;
  list?: string[];
}

export interface Deliverable {
  title: string;
  icon: string;
  meta: string;
  sections: DeliverableSection[];
  trust: string;
  actions: string[]; // ["save_to_library", "export_pdf"]
}

export interface ChatReply {
  text: string;
  points?: string[];
  acts?: [string, string][]; // [icon, label]
}

export interface GenContext {
  agentKey: string;
  agentName: string;
  systemPrompt: string;
  deliverableKey: string | null;
  profile: { industry?: string | null; stage?: string | null; pain?: string | null } | null;
  memories: string[]; // 召回的长期记忆文本
  benmingColor: string;
  benchmark: string;
  userMessage: string;
  history?: { role: string; text: string }[];
}

// Anthropic tool 定义：强制模型以结构化成果输出
export const DELIVERABLE_TOOL = {
  name: 'emit_deliverable',
  description:
    '以固定结构产出一份咨询成果。必须分段输出，每段含标题 h，正文 b 或要点列表 list 二选一或并存。',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: '成果标题，如「战略诊断报告」' },
      sections: {
        type: 'array',
        description: '3–4 段结构化内容',
        items: {
          type: 'object',
          properties: {
            h: { type: 'string', description: '小标题' },
            b: { type: 'string', description: '段落正文（可选）' },
            list: { type: 'array', items: { type: 'string' }, description: '要点列表（可选）' },
          },
          required: ['h'],
        },
      },
    },
    required: ['title', 'sections'],
  },
};

// 运行时变量注入：把 system prompt 中的 {企业档案}/{行业基准}/{长期记忆}/{本命色} 替换为真实值
export function injectVariables(prompt: string, ctx: GenContext): string {
  const profileText = ctx.profile
    ? `行业=${ctx.profile.industry ?? '未知'}；阶段=${ctx.profile.stage ?? '未知'}；最关注=${ctx.profile.pain ?? '未知'}`
    : '暂无企业档案';
  const memText = ctx.memories.length ? ctx.memories.join('；') : '暂无长期记忆';
  return prompt
    .replaceAll('{企业档案}', profileText)
    .replaceAll('{行业基准}', ctx.benchmark)
    .replaceAll('{长期记忆}', memText)
    .replaceAll('{本命色}', ctx.benmingColor);
}
