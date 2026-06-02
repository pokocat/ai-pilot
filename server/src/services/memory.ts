// Agent Memory 服务（《投产开发指导》§6）：按 (用户×智能体) 隔离的长期记忆
// 读写 / 留存（TTL）/ 反馈回流。生产环境用 pgvector 做语义召回；
// 本地无 pgvector，这里按 weight + 时间排序的简化召回。

import { prisma } from '../db.js';
import type { MemoryConfig } from '../data/agents.js';

export async function recallMemories(userId: string, agentKey: string, limit = 5): Promise<string[]> {
  const now = new Date();
  const rows = await prisma.memory.findMany({
    where: {
      userId,
      agentKey,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ weight: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  });
  return rows.map((r) => r.text);
}

function ttlFromConfig(cfg: MemoryConfig): Date | null {
  if (cfg.retentionDays < 0) return null; // 永久
  const d = new Date();
  d.setDate(d.getDate() + cfg.retentionDays);
  return d;
}

function weightFromIntensity(cfg: MemoryConfig): number {
  return cfg.intensity === 'aggressive' ? 1.4 : cfg.intensity === 'conservative' ? 0.7 : 1.0;
}

/** 从一次对话提炼并写入长期记忆（autoLearn 开启时） */
export async function learnFromConversation(opts: {
  tenantId: string;
  userId: string;
  agentKey: string;
  cfg: MemoryConfig;
  userText: string;
}): Promise<boolean> {
  const { tenantId, userId, agentKey, cfg, userText } = opts;
  if (!cfg.longTerm || !cfg.autoLearn) return false;
  if (!cfg.sources.includes('conversation')) return false;
  const text = userText.trim().slice(0, 120);
  if (!text) return false;
  await prisma.memory.create({
    data: {
      tenantId,
      userId,
      agentKey,
      kind: 'preference',
      text: `用户在对话中提到：${text}`,
      weight: weightFromIntensity(cfg),
      source: 'conversation',
      expiresAt: ttlFromConfig(cfg),
    },
  });
  return true;
}

/** 成果反馈回流（采纳/修改/忽略）→ feedback 记忆 */
export async function recordFeedback(opts: {
  tenantId: string;
  userId: string;
  agentKey: string;
  cfg: MemoryConfig;
  signal: 'adopt' | 'edit' | 'ignore';
  title: string;
}): Promise<void> {
  const { tenantId, userId, agentKey, cfg, signal, title } = opts;
  if (!cfg.sources.includes('deliverable_feedback')) return;
  const map = { adopt: '采纳了', edit: '修改了', ignore: '忽略了' };
  await prisma.memory.create({
    data: {
      tenantId,
      userId,
      agentKey,
      kind: 'feedback',
      text: `用户${map[signal]}《${title}》`,
      weight: signal === 'adopt' ? 1.3 : 0.8,
      source: 'deliverable_feedback',
      expiresAt: ttlFromConfig(cfg),
    },
  });
}
