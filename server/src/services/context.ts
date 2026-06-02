import { prisma } from '../db.js';
import { INDUSTRY_BENCHMARK } from '../data/seedConfig.js';
import { recallMemories } from './memory.js';
import type { GenContext } from '../llm/schema.js';
import type { MemoryConfig } from '../data/agents.js';

/** 解析当前用户：演示环境用 x-user-id 头或回退到 seed 出的 demo 用户 */
export async function resolveUser(userIdHeader?: string) {
  if (userIdHeader) {
    const u = await prisma.user.findUnique({ where: { id: userIdHeader }, include: { tenant: true } });
    if (u) return u;
  }
  const demo = await prisma.user.findFirst({ include: { tenant: true } });
  if (!demo) throw new Error('没有可用用户，请先运行 db:seed');
  return demo;
}

export async function buildGenContext(opts: {
  userId: string;
  tenantId: string;
  agentKey: string;
  userMessage: string;
  history?: { role: string; text: string }[];
}): Promise<{ ctx: GenContext; memoryConfig: MemoryConfig }> {
  const agent = await prisma.agent.findUnique({ where: { key: opts.agentKey } });
  if (!agent) throw new Error(`未知智能体：${opts.agentKey}`);
  const profile = await prisma.profile.findFirst({ where: { tenantId: opts.tenantId }, orderBy: { updatedAt: 'desc' } });
  const user = await prisma.user.findUnique({ where: { id: opts.userId } });
  const memories = await recallMemories(opts.userId, opts.agentKey);

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
  };
  return { ctx, memoryConfig: agent.memoryConfig as unknown as MemoryConfig };
}
