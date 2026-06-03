import { prisma } from '../db.js';
import { INDUSTRY_BENCHMARK } from '../data/seedConfig.js';
import { recallMemories } from './memory.js';
import { hybridSearch, resolveReferences } from './retrieval.js';
import type { GenContext, MessageRef } from '../llm/schema.js';
import type { MemoryConfig } from '../data/agents.js';

function unauthorized() {
  return Object.assign(new Error('未登录或登录已失效'), { statusCode: 401, code: 'UNAUTHORIZED' });
}

/**
 * 解析当前用户：token（x-user-id 头，值为 userId）必须有效。
 * 不再回退 demo 用户——保证账号间数据隔离；无 token 或失效一律 401。
 */
export async function resolveUser(token?: string) {
  const id = (token ?? '').trim();
  if (!id) throw unauthorized();
  const u = await prisma.user.findUnique({ where: { id }, include: { tenant: true } });
  if (!u) throw unauthorized();
  return u;
}

export async function buildGenContext(opts: {
  userId: string;
  tenantId: string;
  agentKey: string;
  userMessage: string;
  history?: { role: string; text: string }[];
  projectId?: string | null;       // 归属项目 → 注入项目背景 + 项目内知识召回
  refs?: MessageRef[];             // 显式 @ 引用 → 高优先注入、可溯源
}): Promise<{ ctx: GenContext; memoryConfig: MemoryConfig; knowledgeUsed: string[] }> {
  const agent = await prisma.agent.findUnique({ where: { key: opts.agentKey } });
  if (!agent) throw new Error(`未知智能体：${opts.agentKey}`);
  const profile = await prisma.profile.findFirst({ where: { tenantId: opts.tenantId }, orderBy: { updatedAt: 'desc' } });
  const user = await prisma.user.findUnique({ where: { id: opts.userId } });

  // 长期记忆：按当前问题做语义召回
  const memories = await recallMemories(opts.userId, opts.agentKey, 5, opts.userMessage);

  // 项目背景
  let projectName: string | null = null;
  let projectSummary: string | null = null;
  if (opts.projectId) {
    const proj = await prisma.project.findFirst({ where: { id: opts.projectId, tenantId: opts.tenantId } });
    if (proj) { projectName = proj.name; projectSummary = proj.summary ?? null; }
  }

  // 显式引用（可溯源）+ 知识库混合检索（自动召回，项目内优先）
  const { lines: refLines, labels: refLabels } = await resolveReferences(opts.tenantId, opts.userId, opts.refs);
  const hits = await hybridSearch({ tenantId: opts.tenantId, projectId: opts.projectId ?? undefined, query: opts.userMessage, topK: 4 });
  const knowledge = hits.map((h) => `【知识：${h.item.title ?? h.item.kind}】${h.snippet}`);
  const knowledgeUsed = [...refLabels, ...hits.map((h) => h.item.title ?? h.snippet.slice(0, 20))];

  const ctx: GenContext = {
    agentKey: agent.key,
    agentName: agent.name,
    systemPrompt: agent.systemPrompt,
    deliverableKey: agent.deliverableKey,
    profile: profile ? { industry: profile.industry, stage: profile.stage, pain: profile.pain } : null,
    memories,
    benmingColor: user?.benmingColor ?? 'gold',
    benchmark: INDUSTRY_BENCHMARK,
    userMessage: opts.userMessage,
    history: opts.history,
    references: refLines,
    knowledge,
    projectName,
    projectSummary,
  };
  return { ctx, memoryConfig: agent.memoryConfig as unknown as MemoryConfig, knowledgeUsed };
}
