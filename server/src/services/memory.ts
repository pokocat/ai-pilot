// Agent Memory 服务（《投产开发指导》§6）：按 (用户×智能体) 隔离的长期记忆。
// 升级点：写入即向量化；召回支持「按当前问题语义相关性」排序（无 query 时退回 weight+时间）。
// 生产环境把 embedding 迁到 pgvector 做近邻检索；本地用内存余弦兜底，零依赖可跑。

import { prisma } from '../db.js';
import { embed, cosine } from './embedding.js';
import type { MemoryConfig } from '../data/agents.js';

/**
 * 召回长期记忆。
 * - 传 query：先按语义相似度（余弦）排序，再用 weight 微调，取 TopN。
 * - 不传 query：退回 weight + 时间倒序（与历史行为一致）。
 */
export async function recallMemories(
  userId: string, agentKey: string, limit = 5, query?: string,
): Promise<string[]> {
  const now = new Date();
  const where = {
    userId, agentKey,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };

  if (!query?.trim()) {
    const rows = await prisma.memory.findMany({
      where, orderBy: [{ weight: 'desc' }, { createdAt: 'desc' }], take: limit,
    });
    return rows.map((r) => r.text);
  }

  // 语义召回：取较大候选集在内存里排序（演示规模足够；生产用 pgvector 下推）
  const rows = await prisma.memory.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
  if (!rows.length) return [];
  const qv = await embed(query);
  const scored = rows.map((r) => {
    const sem = cosine(qv, (r.embedding as number[] | null) ?? null);
    return { text: r.text, score: sem * 0.8 + (r.weight ?? 1) * 0.2 };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.text);
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

/** 从一次对话提炼并写入长期记忆（autoLearn 开启时）。 */
export async function learnFromConversation(opts: {
  tenantId: string;
  userId: string;
  agentKey: string;
  cfg: MemoryConfig;
  userText: string;
  projectId?: string | null;
}): Promise<boolean> {
  const { tenantId, userId, agentKey, cfg, userText, projectId } = opts;
  if (!cfg.longTerm || !cfg.autoLearn) return false;
  if (!cfg.sources.includes('conversation')) return false;
  const text = userText.trim().slice(0, 120);
  if (!text) return false;
  const memText = `用户在对话中提到：${text}`;
  const embedding = await embed(memText);
  await prisma.memory.create({
    data: {
      tenantId,
      userId,
      agentKey,
      projectId: projectId ?? null,
      kind: 'preference',
      text: memText,
      embedding,
      weight: weightFromIntensity(cfg),
      source: 'conversation',
      expiresAt: ttlFromConfig(cfg),
    },
  });
  return true;
}

/** 成果反馈回流（采纳/修改/忽略）→ feedback 记忆。 */
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
  const memText = `用户${map[signal]}《${title}》`;
  const embedding = await embed(memText);
  await prisma.memory.create({
    data: {
      tenantId,
      userId,
      agentKey,
      kind: 'feedback',
      text: memText,
      embedding,
      weight: signal === 'adopt' ? 1.3 : 0.8,
      source: 'deliverable_feedback',
      expiresAt: ttlFromConfig(cfg),
    },
  });
}
