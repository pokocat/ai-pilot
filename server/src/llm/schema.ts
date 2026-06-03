// 结构化成果数据契约（《投产开发指导》§4.2）。
// 真实模型输出必须约束成此结构（claude 提供方用 tool/function calling 强约束）。
// 成果/回复的数据模型统一来自 SSOT（shared/contracts），前后端/运营端同口径。

import type {
  Deliverable, DeliverableSection, ChatReply,
  KnowledgeItemT, KnowledgeKind, KnowledgeHit, MessageRef,
  ReportDiff, SectionDiff, WordOp, SaveReportResult, SummarizeResult,
  AiProvider, AiConfig, AiConfigUpdate, AiPreset, AiConfigView, AiTestResult,
} from '../../../shared/contracts';
export type {
  Deliverable, DeliverableSection, ChatReply,
  KnowledgeItemT, KnowledgeKind, KnowledgeHit, MessageRef,
  ReportDiff, SectionDiff, WordOp, SaveReportResult, SummarizeResult,
  AiProvider, AiConfig, AiConfigUpdate, AiPreset, AiConfigView, AiTestResult,
};

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
  // —— 上下文工程扩展 ——
  references?: string[];      // 用户显式 @ 引用的资料（带出处标注，高优先）
  knowledge?: string[];       // 知识库混合检索自动召回（项目内相关资料）
  projectName?: string | null;
  projectSummary?: string | null;
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

// 运行时变量注入：把 system prompt 中的占位符替换为真实值；
// 并把「显式引用 / 项目背景 / 知识库召回」作为可溯源的参考资料块追加到 system 末尾，
// 这样即便某个智能体的提示词没写对应占位符，真实模型也能用上这些上下文。
export function injectVariables(prompt: string, ctx: GenContext): string {
  const profileText = ctx.profile
    ? `行业=${ctx.profile.industry ?? '未知'}；阶段=${ctx.profile.stage ?? '未知'}；最关注=${ctx.profile.pain ?? '未知'}`
    : '暂无企业档案';
  const memText = ctx.memories.length ? ctx.memories.join('；') : '暂无长期记忆';
  const refText = ctx.references?.length ? ctx.references.join('\n') : '无';
  const projText = ctx.projectSummary
    ? `${ctx.projectName ? ctx.projectName + '：' : ''}${ctx.projectSummary}`
    : '无特定项目背景';
  const knowText = ctx.knowledge?.length ? ctx.knowledge.join('\n') : '无相关知识';

  let out = prompt
    .replaceAll('{企业档案}', profileText)
    .replaceAll('{行业基准}', ctx.benchmark)
    .replaceAll('{长期记忆}', memText)
    .replaceAll('{本命色}', ctx.benmingColor)
    .replaceAll('{引用资料}', refText)
    .replaceAll('{项目背景}', projText)
    .replaceAll('{知识库}', knowText);

  // 通用追加：用户显式引用 + 项目背景 + 自动召回，统一以「参考资料」块给到模型。
  const blocks: string[] = [];
  if (ctx.projectSummary) blocks.push(`【当前项目】${projText}`);
  if (ctx.references?.length) blocks.push(`【用户引用的资料（请优先采纳并标注出处）】\n${ctx.references.join('\n')}`);
  if (ctx.knowledge?.length) blocks.push(`【知识库相关召回（仅供参考）】\n${ctx.knowledge.join('\n')}`);
  if (blocks.length) out += `\n\n— 参考资料 —\n${blocks.join('\n\n')}`;
  return out;
}
