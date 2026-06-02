import { prisma } from '../db.js';
import { INDUSTRY_BENCHMARK } from '../data/seedConfig.js';
import { recallMemories } from './memory.js';
import type { GenContext } from '../llm/schema.js';
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
