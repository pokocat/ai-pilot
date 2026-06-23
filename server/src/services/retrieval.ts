// 混合检索 + 引用解析（上下文工程的核心）。
//
//   • hybridSearch：向量(语义) + 关键词(子串/词重叠) 混合打分，租户+用户隔离、当前项目仅加权。
//     演示规模下在内存里算余弦即可；生产应换成 pgvector 的 `<=>` 距离查询 + HNSW 索引
//     （把候选下推到 SQL，避免全表加载——见 AGENTS §16）。
//   • resolveReferences：把用户显式 @ 的 项目/报告/知识/记忆 取出全文，带「出处标注」，
//     高优先注入 prompt，比让模型自动检索更可控、可溯源。

import { prisma } from '../db.js';
import { embed, cosine } from './embedding.js';
import { rerank } from './rerank.js';
import { pgvectorEnabled, vectorSearchChunks } from './vectorStore.js';
import type { KnowledgeHit, KnowledgeItemT, MessageRef } from '../llm/schema.js';

function toItemT(row: {
  id: string; projectId: string | null; kind: string; title: string | null;
  text: string; sourceType: string; sourceId: string | null; tagsJson: unknown; createdAt: Date;
}): KnowledgeItemT {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as KnowledgeItemT['kind'],
    title: row.title,
    text: row.text,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    tags: Array.isArray(row.tagsJson) ? (row.tagsJson as string[]) : [],
    at: row.createdAt.toISOString(),
  };
}

// 关键词得分：query 的 token 命中 chunk 文本的比例（0..1），与向量分互补。
export function keywordScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const terms = [...(q.match(/[a-z0-9]+/g) ?? []), ...(q.match(/[一-鿿]{2,}/g) ?? [])];
  if (!terms.length) return 0;
  const lower = text.toLowerCase();
  let hit = 0;
  for (const t of terms) if (lower.includes(t)) hit++;
  return hit / terms.length;
}

export interface HybridOpts {
  tenantId: string;
  userId?: string | null;     // 上下文按「用户」隔离：检索该用户的全部知识（不再按项目硬隔离）
  projectId?: string | null;  // 当前会话项目：仅作**加权提升**（命中本项目的项 +PROJECT_BOOST），非过滤墙
  query: string;
  topK?: number;
  alpha?: number; // 向量权重（默认 0.65），(1-alpha) 给关键词
}

// 当前项目命中加权：让本项目资料略微优先，但不排除用户的其它资料（上下文按用户）。
const PROJECT_BOOST = 0.05;

// 候选项：融合分 + 展示 snippet + 供 rerank 的较长正文 + 原始 item 行。
type KItemRow = Parameters<typeof toItemT>[0];
interface Cand { score: number; snippet: string; text: string; item: KItemRow; }

/**
 * 候选 → 最终命中。rerank 开启且可用时，对「5×TopK 候选池」调 rerank 重排再取 TopK；
 * 未开启 / 调用失败时 rerank() 返回 null，退回融合分顺序（绝不因 rerank 异常影响检索）。
 */
async function finalize(query: string, cands: Cand[], topK: number): Promise<KnowledgeHit[]> {
  const sorted = cands.sort((a, b) => b.score - a.score);
  const pool = sorted.slice(0, Math.min(sorted.length, Math.max(topK, topK * 5)));
  const order = await rerank(query, pool.map((c) => c.text), topK);
  if (order) {
    const mapped = order
      .map((o) => ({ cand: pool[o.index], score: o.score }))
      .filter((x): x is { cand: Cand; score: number } => !!x.cand)
      .slice(0, topK)
      .map((x) => ({ item: toItemT(x.cand.item), score: Number(x.score.toFixed(4)), snippet: x.cand.snippet }));
    if (mapped.length) return mapped;
  }
  return sorted.slice(0, topK).map((c) => ({ item: toItemT(c.item), score: Number(c.score.toFixed(4)), snippet: c.snippet }));
}

/** 混合检索知识库，返回去重到 KnowledgeItem 粒度的命中（rerank 开启时再重排）。 */
export async function hybridSearch(opts: HybridOpts): Promise<KnowledgeHit[]> {
  const { tenantId, userId, projectId, query } = opts;
  const topK = opts.topK ?? 5;
  const alpha = opts.alpha ?? 0.65;
  if (!query.trim()) return [];

  // pgvector 路径（开启时）：用 ANN 取候选，再关键词混合打分。
  if (pgvectorEnabled()) {
    const qvec = await embed(query);
    const hits = await vectorSearchChunks(tenantId, userId, qvec, topK * 4).catch((e) => {
      console.error('[retrieval] pgvector fallback to in-memory:', (e as Error).message);
      return null;
    });
    if (hits) {
      if (!hits.length) return [];
      const items = await prisma.knowledgeItem.findMany({ where: { id: { in: [...new Set(hits.map((h) => h.itemId))] } } });
      const itemMap = new Map(items.map((i) => [i.id, i]));
      const best = new Map<string, Cand>();
      for (const h of hits) {
        const item = itemMap.get(h.itemId);
        if (!item) continue;
        let score = alpha * (1 - h.dist) + (1 - alpha) * keywordScore(query, h.text);
        if (projectId && item.projectId === projectId) score += PROJECT_BOOST;
        const prev = best.get(h.itemId);
        if (!prev || score > prev.score) best.set(h.itemId, { score, snippet: h.text.slice(0, 120), text: h.text.slice(0, 512), item });
      }
      return finalize(query, [...best.values()], topK);
    }
  }

  const chunks = await prisma.knowledgeChunk.findMany({
    where: { tenantId, ...(userId ? { item: { userId } } : {}) },
    include: { item: true },
    take: 2000, // 演示上限；生产以 pgvector 下推 ORDER BY embedding <=> q LIMIT k 取代
  });
  if (!chunks.length) return [];

  const qv = await embed(query);
  // 每个 item 取其最佳 chunk 分数（命中当前项目的项加权提升）
  const best = new Map<string, Cand>();
  for (const c of chunks) {
    const vec = (c.embedding as number[] | null) ?? null;
    const sem = cosine(qv, vec);
    const kw = keywordScore(query, c.text);
    let score = alpha * sem + (1 - alpha) * kw;
    if (projectId && c.item.projectId === projectId) score += PROJECT_BOOST;
    const prev = best.get(c.itemId);
    if (!prev || score > prev.score) {
      best.set(c.itemId, { score, snippet: c.text.slice(0, 120), text: c.text.slice(0, 512), item: c.item });
    }
  }
  const cands = [...best.values()].filter((x) => x.score > 0.02);
  return finalize(query, cands, topK);
}

/**
 * 解析显式引用 → 带出处标注的上下文文本（仅取该用户/租户可见的资料，严格隔离）。
 * 返回 { lines: 注入文本[], labels: 展示用标签[] }。
 */
export async function resolveReferences(
  tenantId: string,
  userId: string,
  refs: MessageRef[] | undefined,
): Promise<{ lines: string[]; labels: string[] }> {
  const lines: string[] = [];
  const labels: string[] = [];
  if (!refs?.length) return { lines, labels };

  for (const ref of refs.slice(0, 8)) {
    try {
      if (ref.kind === 'project') {
        const p = await prisma.project.findFirst({ where: { id: ref.id, tenantId } });
        if (p) {
          lines.push(`【项目：${p.name}】${p.summary ?? '（暂无项目摘要）'}`);
          labels.push(`项目《${p.name}》`);
        }
      } else if (ref.kind === 'report') {
        const doc = await prisma.reportDoc.findFirst({ where: { id: ref.id, tenantId } });
        if (doc) {
          const ver = ref.versionId
            ? await prisma.reportVersion.findFirst({ where: { id: ref.versionId, reportId: doc.id } })
            : await prisma.reportVersion.findFirst({ where: { reportId: doc.id }, orderBy: { version: 'desc' } });
          if (ver) {
            const content = ver.contentJson as { sections?: { h: string; b?: string; list?: string[] }[] };
            const body = (content.sections ?? [])
              .map((s) => `${s.h}：${s.b ?? ''}${(s.list ?? []).join('、')}`)
              .join('；');
            lines.push(`【报告：${doc.title} v${ver.version}】${body}`);
            labels.push(`报告《${doc.title}》v${ver.version}`);
          }
        }
      } else if (ref.kind === 'knowledge') {
        const k = await prisma.knowledgeItem.findFirst({ where: { id: ref.id, tenantId } });
        if (k) {
          lines.push(`【知识：${k.title ?? k.kind}】${k.text}`);
          labels.push(`知识「${k.title ?? k.text.slice(0, 12)}」`);
        }
      } else if (ref.kind === 'memory') {
        const m = await prisma.memory.findFirst({ where: { id: ref.id, tenantId, userId } });
        if (m) {
          lines.push(`【记忆】${m.text}`);
          labels.push('一段记忆');
        }
      }
    } catch {
      /* 单条引用解析失败不影响整体 */
    }
  }
  return { lines, labels };
}

/**
 * 检索调试：与 hybridSearch 同源打分，但**展开**每个候选的 sem/kw/融合分 + rerank 前后名次，
 * 不做 TopK 截断收口（取较大候选池），供运营「检索调试台」排查「召回了什么、为什么、rerank 改了啥」。
 */
export async function hybridSearchDebug(opts: {
  tenantId: string; userId?: string | null; projectId?: string | null; query: string; topK?: number; alpha?: number;
}): Promise<{
  candidates: Array<{ itemId: string; title: string | null; kind: string; projectId: string | null; snippet: string; semScore: number; kwScore: number; fusionScore: number; rerankScore: number | null; rerankRank: number | null }>;
  rerankApplied: boolean;
}> {
  const { tenantId, userId, projectId, query } = opts;
  const topK = opts.topK ?? 8;
  const alpha = opts.alpha ?? 0.65;
  if (!query.trim()) return { candidates: [], rerankApplied: false };

  const chunks = await prisma.knowledgeChunk.findMany({
    where: { tenantId, ...(userId ? { item: { userId } } : {}) },
    include: { item: true },
    take: 2000,
  });
  if (!chunks.length) return { candidates: [], rerankApplied: false };

  const qv = await embed(query);
  type D = { sem: number; kw: number; score: number; snippet: string; text: string; item: KItemRow };
  const best = new Map<string, D>();
  for (const c of chunks) {
    const vec = (c.embedding as number[] | null) ?? null;
    const sem = cosine(qv, vec);
    const kw = keywordScore(query, c.text);
    let score = alpha * sem + (1 - alpha) * kw;
    if (projectId && c.item.projectId === projectId) score += PROJECT_BOOST;
    const prev = best.get(c.itemId);
    if (!prev || score > prev.score) best.set(c.itemId, { sem, kw, score, snippet: c.text.slice(0, 160), text: c.text.slice(0, 512), item: c.item });
  }
  const sorted = [...best.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(topK, topK * 2));
  const order = await rerank(query, sorted.map((c) => c.text), topK);
  const rankByIdx = new Map<number, { score: number; rank: number }>();
  if (order) order.forEach((o, i) => rankByIdx.set(o.index, { score: o.score, rank: i + 1 }));

  const candidates = sorted.map((c, idx) => ({
    itemId: c.item.id,
    title: c.item.title,
    kind: c.item.kind,
    projectId: c.item.projectId,
    snippet: c.snippet,
    semScore: Number(c.sem.toFixed(4)),
    kwScore: Number(c.kw.toFixed(4)),
    fusionScore: Number(c.score.toFixed(4)),
    rerankScore: rankByIdx.has(idx) ? Number(rankByIdx.get(idx)!.score.toFixed(4)) : null,
    rerankRank: rankByIdx.get(idx)?.rank ?? null,
  }));
  return { candidates, rerankApplied: !!order };
}
