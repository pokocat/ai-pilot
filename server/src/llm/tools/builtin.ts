// 内置工具（技能）：复用已有的自建 RAG / 记忆能力，不依赖任何外部框架。
//   search_knowledge → services/retrieval.hybridSearch（pgvector 混合检索）
//   recall_memory    → services/memory.recallMemories（per-user 语义记忆）

import { hybridSearch } from '../../services/retrieval.js';
import { recallMemories } from '../../services/memory.js';
import type { Tool, OutputSkill } from './types.js';

const KNOWLEDGE_MAX = 1500; // 截断工具输出，防多轮 prompt 膨胀

export const searchKnowledge: Tool = {
  name: 'search_knowledge',
  description: '检索当前客户/项目的知识库，返回相关片段。需要事实依据、方法论或资料支撑时调用。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索关键词或问题，缺省用用户原话' },
      topK: { type: 'number', description: '返回片段数，默认 4' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    if (!ctx.tenantId) return '（无租户上下文，知识库不可用）';
    const query = String(args.query ?? '').trim() || ctx.query;
    const topK = Math.min(8, Math.max(1, Number(args.topK) || 4));
    const hits = await hybridSearch({ tenantId: ctx.tenantId, projectId: ctx.projectId, query, topK });
    if (!hits.length) return '（无相关知识）';
    const text = hits.map((h) => `【${h.item.title ?? h.item.kind}】${h.snippet}`).join('\n');
    return text.length > KNOWLEDGE_MAX ? text.slice(0, KNOWLEDGE_MAX) + '…' : text;
  },
};

export const recallMemory: Tool = {
  name: 'recall_memory',
  description: '召回该客户与本顾问的长期记忆（偏好、事实、历史决策与结论）。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '按主题召回，缺省用用户原话' },
      limit: { type: 'number', description: '召回条数，默认 5' },
    },
    required: [],
  },
  async run(args, ctx) {
    if (!ctx.userId) return '（无用户上下文，记忆不可用）';
    const query = String(args.query ?? '').trim() || ctx.query;
    const limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
    const mems = await recallMemories(ctx.userId, ctx.agentKey, limit, query);
    return mems.length ? mems.join('\n') : '（暂无长期记忆）';
  },
};

// 产出处理技能：把结构化成果渲染成可分享的网页版报告，回填 htmlUrl。
// 这是「HTML 生成」作为技能库一员的落地——不再是写死的后处理，而是注册进 registry 的 output 技能。
export const renderReport: OutputSkill = {
  key: 'render_report',
  name: '网页版报告',
  description: '把产出成果渲染成自包含、可分享的网页版报告，回填分享链接（htmlUrl）。',
  async run(deliverable, ctx) {
    const { publishReport } = await import('../../services/reportHtml.js');
    return publishReport(ctx.tenantId, deliverable);
  },
};
