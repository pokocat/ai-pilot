// Agent Memory 服务（《投产开发指导》§6）：按 (用户×智能体) 隔离的长期记忆。
// 升级点：写入即向量化；召回支持「按当前问题语义相关性」排序（无 query 时退回 weight+时间）。
// 生产环境把 embedding 迁到 pgvector 做近邻检索；本地用内存余弦兜底，零依赖可跑。

import { prisma } from '../db.js';
import { now } from './clock.js';
import { embed, cosine } from './embedding.js';
import { keywordScore } from './retrieval.js';
import { extractInsights } from '../llm/gateway.js';
import { pgvectorEnabled, vectorSearchMemories, upsertMemoryVector } from './vectorStore.js';
import type { MemoryConfig } from '../data/agents.js';
import type { AdminUserMemory, AdminAgentMemoryItem } from '../../../shared/contracts';

// —— E2：更聪明的记忆召回 —— 混合(向量+关键词) + 时间衰减(halfLife 30d) + MMR 多样性重排。
// 取舍：本地确定性嵌入下向量信号弱，故关键词与向量持平(MEM_ALPHA=0.5)；衰减把「旧记忆」平滑降权（取代硬 TTL 悬崖之外的突然消失感）；
// MMR 避免一次召回多条近义记忆挤占 TopN。pgvector 路径暂沿用 ANN（衰减/MMR 下推待办，见 README/TODO）。
const MEM_CANDIDATES = 60;   // 候选池上限（内存重排，默认/演示规模足够）
const MEM_ALPHA = 0.5;       // 向量权重，(1-α) 给关键词
const HALF_LIFE_DAYS = 30;   // 时间衰减半衰期
const MMR_LAMBDA = 0.7;      // 相关性 vs 多样性

export function recencyDecay(ageDays: number): number {
  return Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE_DAYS);
}
function ageDaysOf(d: Date, now: Date): number {
  return (now.getTime() - d.getTime()) / 86_400_000;
}
export interface MemoryRecallDetail {
  id: string;
  text: string;
  source: string;
  score: number;
  createdAt: Date;
}

type MmrCandidate = MemoryRecallDetail & { emb: number[] | null };

/** MMR 重排：在相关性与多样性间平衡，保留命中 id/来源/得分供 trace 诊断。 */
function mmrSelectDetails(cands: MmrCandidate[], limit: number, lambda = MMR_LAMBDA): MmrCandidate[] {
  if (!cands.length) return [];
  const maxS = Math.max(...cands.map((c) => c.score)) || 1;
  const pool = cands.map((c) => ({ ...c, rel: c.score / maxS }));
  const picked: MmrCandidate[] = [];
  while (picked.length < limit && pool.length) {
    let bi = 0, bv = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const div = picked.length ? Math.max(...picked.map((p) => cosine(pool[i].emb, p.emb))) : 0;
      const val = lambda * pool[i].rel - (1 - lambda) * div;
      if (val > bv) { bv = val; bi = i; }
    }
    const [c] = pool.splice(bi, 1);
    picked.push(c);
  }
  return picked;
}

/** 兼容既有测试/调用：只返回文本。 */
export function mmrSelect(
  cands: { text: string; emb: number[] | null; score: number }[], limit: number, lambda = MMR_LAMBDA,
): string[] {
  return mmrSelectDetails(
    cands.map((c, i) => ({ ...c, id: String(i), source: 'unknown', createdAt: new Date(0) })),
    limit,
    lambda,
  ).map((p) => p.text);
}

/**
 * 召回长期记忆。
 * - 传 query：先按语义相似度（余弦）排序，再用 weight 微调，取 TopN。
 * - 不传 query：退回 weight + 时间倒序（与历史行为一致）。
 */
export async function recallMemoryDetails(
  userId: string, agentKey: string, limit = 5, query?: string,
): Promise<MemoryRecallDetail[]> {
  void agentKey; // A-3：用户级共享事实池——跨所有军师召回该用户记忆，不再按 agentKey 隔离（general 学到的，专业军师也记得）。
  const now = new Date();
  const where = {
    userId,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };

  if (!query?.trim()) {
    const rows = await prisma.memory.findMany({
      where, orderBy: [{ weight: 'desc' }, { createdAt: 'desc' }], take: limit,
    });
    return rows.map((r) => ({ id: r.id, text: r.text, source: r.source, score: r.weight, createdAt: r.createdAt }));
  }

  // pgvector 路径（开启时）：ANN 下推（agentKey=null → 用户级共享池）
  if (pgvectorEnabled()) {
    const qv = await embed(query);
    const hits = await vectorSearchMemories(userId, null, qv, limit).catch((e) => {
      console.error('[memory] pgvector fallback to in-memory:', (e as Error).message);
      return null;
    });
    if (hits) {
      const rows = await prisma.memory.findMany({
        where: { id: { in: hits.map((h) => h.id) } },
        select: { id: true, source: true, createdAt: true },
      });
      const meta = new Map(rows.map((r) => [r.id, r]));
      return hits.map((h) => ({
        id: h.id,
        text: h.text,
        source: meta.get(h.id)?.source ?? 'unknown',
        score: Number((1 / (1 + Math.max(0, h.dist))).toFixed(4)),
        createdAt: meta.get(h.id)?.createdAt ?? new Date(0),
      }));
    }
  }

  // E2：混合(向量+关键词) + 时间衰减 + MMR 多样性（取代纯余弦 sem*0.8+weight*0.2）。
  const rows = await prisma.memory.findMany({ where, orderBy: { createdAt: 'desc' }, take: MEM_CANDIDATES });
  if (!rows.length) return [];
  const qv = await embed(query);
  const cands = rows.map((r) => {
    const emb = (r.embedding as number[] | null) ?? null;
    const rel = MEM_ALPHA * cosine(qv, emb) + (1 - MEM_ALPHA) * keywordScore(query, r.text);
    const score = Math.max(0, rel) * recencyDecay(ageDaysOf(r.createdAt, now)) * (r.weight ?? 1);
    return { id: r.id, text: r.text, source: r.source, createdAt: r.createdAt, emb, score };
  });
  return mmrSelectDetails(cands, limit).map(({ emb: _emb, ...detail }) => ({ ...detail, score: Number(detail.score.toFixed(4)) }));
}

/** 兼容现有业务调用：只消费记忆文本；诊断链路使用 recallMemoryDetails。 */
export async function recallMemories(
  userId: string, agentKey: string, limit = 5, query?: string,
): Promise<string[]> {
  return (await recallMemoryDetails(userId, agentKey, limit, query)).map((m) => m.text);
}

function ttlFromConfig(cfg: MemoryConfig): Date | null {
  if (cfg.retentionDays < 0) return null; // 永久
  // 过期时刻 = 现在 + retentionDays（纯毫秒运算，与时区无关；走可注入时钟 now()）。
  return new Date(now().getTime() + cfg.retentionDays * 86400_000);
}

function weightFromIntensity(cfg: MemoryConfig): number {
  return cfg.intensity === 'aggressive' ? 1.4 : cfg.intensity === 'conservative' ? 0.7 : 1.0;
}

// E1：去重-on-write 的近重判定（文本归一相同 或 向量余弦≥阈值）。本地嵌入噪声大，阈值取保守 0.92，避免误并。
const DEDUP_SIM = 0.92;
function normText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '');
}
async function findDuplicateMemory(userId: string, text: string, emb: number[]): Promise<{ id: string; weight: number } | null> {
  const norm = normText(text);
  const recent = await prisma.memory.findMany({
    // A-3 共享池：跨军师去重（general 与专业军师记同一事实不再堆两行）。
    where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    orderBy: { createdAt: 'desc' }, take: 50,
    select: { id: true, text: true, weight: true, embedding: true },
  });
  for (const r of recent) {
    if (normText(r.text) === norm) return { id: r.id, weight: r.weight };
    if (cosine(emb, (r.embedding as number[] | null) ?? null) >= DEDUP_SIM) return { id: r.id, weight: r.weight };
  }
  return null;
}

/** 从一次对话提炼并写入长期记忆（autoLearn 开启时）。 */
export async function learnFromConversation(opts: {
  tenantId: string;
  userId: string;
  agentKey: string;
  cfg: MemoryConfig;
  userText: string;
  projectId?: string | null;
  assistantText?: string; // P1-C1：顾问产出的结论，纳入抽取输入，记住「军师判断过什么」
}): Promise<boolean> {
  const { tenantId, userId, agentKey, cfg, userText, projectId, assistantText } = opts;
  if (!cfg.longTerm || !cfg.autoLearn) return false;
  if (!cfg.sources.includes('conversation')) return false;
  if (!userText.trim()) return false;

  // Learned Memory：有真实模型时抽取 1-3 条结构化洞察；否则启发式兜底（截断原文）。
  // P1-C1：若带顾问结论，一并喂入抽取，捕获决策/结论而非仅用户原话。
  const learnInput = assistantText?.trim() ? `用户：${userText}\n顾问结论：${assistantText}` : userText;
  const insights = await extractInsights(learnInput, undefined);
  if (!insights.length) return false;
  const weight = weightFromIntensity(cfg);
  const expiresAt = ttlFromConfig(cfg);
  for (const { text, category } of insights) {
    const embedding = await embed(text);
    // E1：与近期记忆近重 → 加权刷新（提权 + 刷新时间，配合 E2 衰减），不再堆重复行。
    const dup = await findDuplicateMemory(userId, text, embedding);
    if (dup) {
      await prisma.memory.update({ where: { id: dup.id }, data: { weight: Math.min(2, dup.weight + 0.1), createdAt: new Date(), expiresAt } });
      if (pgvectorEnabled()) await upsertMemoryVector(dup.id, embedding).catch(() => {});
      continue;
    }
    const m = await prisma.memory.create({
      data: { tenantId, userId, agentKey, projectId: projectId ?? null, kind: 'preference', category, text, embedding, weight, source: 'conversation', expiresAt },
    });
    if (pgvectorEnabled()) await upsertMemoryVector(m.id, embedding).catch(() => {});
  }
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
  if (!cfg.longTerm) return;
  if (!cfg.sources.includes('deliverable_feedback')) return;
  const map = { adopt: '采纳了', edit: '修改了', ignore: '忽略了' };
  const memText = `用户${map[signal]}《${title}》`;
  const embedding = await embed(memText);
  const m = await prisma.memory.create({
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
  if (pgvectorEnabled()) await upsertMemoryVector(m.id, embedding).catch(() => {});
}

// ——————————————————————————————————————————————————————————————————————————
// 运营端：查看 / 删除某用户的长期记忆（观测系统"记住"了什么 + 纠正脏记忆 / 隐私删除）。
// ——————————————————————————————————————————————————————————————————————————

/** 列出某用户全部长期记忆（按顾问分组排序，含过期项；运营端用，不做语义召回）。 */
export async function listUserMemories(tenantId: string, userId: string): Promise<AdminUserMemory[]> {
  const rows = await prisma.memory.findMany({
    where: { tenantId, userId },
    orderBy: [{ agentKey: 'asc' }, { weight: 'desc' }, { createdAt: 'desc' }],
    take: 300,
  });
  return rows.map((m) => ({
    id: m.id,
    agentKey: m.agentKey,
    kind: m.kind,
    text: m.text,
    weight: m.weight,
    source: m.source,
    createdAt: m.createdAt.toISOString(),
    expiresAt: m.expiresAt ? m.expiresAt.toISOString() : null,
  }));
}

/** 删除某用户的一条长期记忆（租户+用户双重校验，防越权）。 */
export async function deleteUserMemory(tenantId: string, userId: string, id: string): Promise<void> {
  await prisma.memory.deleteMany({ where: { id, tenantId, userId } });
}

/**
 * P1-C4：按 agent 跨用户列出记忆（运营治理自动学习写入的脏记忆）。
 * tenantId 传入则限定作用域（避免跨租户全量拉取/误删）；不传 = 平台级全量（超管默认视图）。
 */
export async function listAgentMemories(agentKey: string, limit = 200, tenantId?: string): Promise<AdminAgentMemoryItem[]> {
  const rows = await prisma.memory.findMany({
    where: { agentKey, ...(tenantId ? { tenantId } : {}) },
    orderBy: { createdAt: 'desc' }, take: Math.min(500, Math.max(1, limit)),
  });
  return rows.map((m) => ({
    id: m.id, tenantId: m.tenantId, userId: m.userId, kind: m.kind, text: m.text, weight: m.weight,
    source: m.source, createdAt: m.createdAt.toISOString(), expiresAt: m.expiresAt ? m.expiresAt.toISOString() : null,
  }));
}

/**
 * P1-C4：运营按 id+agentKey 删除一条记忆（纠正脏记忆）。返回是否命中。
 * tenantId 传入则叠加租户校验，防跨租户越权删除（超管不传 = 平台级）。
 */
export async function deleteAgentMemory(agentKey: string, id: string, tenantId?: string): Promise<boolean> {
  const r = await prisma.memory.deleteMany({ where: { id, agentKey, ...(tenantId ? { tenantId } : {}) } });
  return r.count > 0;
}

/** P1-C2：用户编辑自己的一条长期记忆（重写文本并重嵌入）。租户+用户双重校验，防越权。返回是否命中。 */
export async function updateOwnMemory(tenantId: string, userId: string, id: string, text: string): Promise<boolean> {
  const t = text.trim();
  if (!t) return false;
  const embedding = await embed(t);
  const r = await prisma.memory.updateMany({ where: { id, tenantId, userId }, data: { text: t, embedding } });
  if (r.count > 0 && pgvectorEnabled()) await upsertMemoryVector(id, embedding).catch(() => {});
  return r.count > 0;
}
