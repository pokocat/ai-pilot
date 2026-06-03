// 混合检索 + 引用解析（上下文工程的核心）。
//
//   • hybridSearch：向量(语义) + 关键词(子串/词重叠) 混合打分，租户隔离、可按项目过滤。
//     演示规模下在内存里算余弦即可；生产应换成 pgvector 的 `<=>` 距离查询 + HNSW 索引
//     （把候选下推到 SQL，避免全表加载——见 AGENTS §16）。
//   • resolveReferences：把用户显式 @ 的 项目/报告/知识/记忆 取出全文，带「出处标注」，
//     高优先注入 prompt，比让模型自动检索更可控、可溯源。

import { prisma } from '../db.js';
import { embed, cosine } from './embedding.js';
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
function keywordScore(query: string, text: string): number {
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
  projectId?: string | null;
  query: string;
  topK?: number;
  alpha?: number; // 向量权重（默认 0.65），(1-alpha) 给关键词
}

/** 混合检索知识库，返回去重到 KnowledgeItem 粒度的命中。 */
export async function hybridSearch(opts: HybridOpts): Promise<KnowledgeHit[]> {
  const { tenantId, projectId, query } = opts;
  const topK = opts.topK ?? 5;
  const alpha = opts.alpha ?? 0.65;
  if (!query.trim()) return [];

  // pgvector 路径（开启时）：用 ANN 取候选，再关键词重排（混合）。
  if (pgvectorEnabled()) {
    const qvec = await embed(query);
    const hits = await vectorSearchChunks(tenantId, projectId, qvec, topK * 4).catch((e) => {
      console.error('[retrieval] pgvector fallback to in-memory:', (e as Error).message);
      return null;
    });
    if (hits) {
      if (!hits.length) return [];
      const items = await prisma.knowledgeItem.findMany({ where: { id: { in: [...new Set(hits.map((h) => h.itemId))] } } });
      const itemMap = new Map(items.map((i) => [i.id, i]));
      const best = new Map<string, { score: number; snippet: string; item: (typeof items)[number] }>();
      for (const h of hits) {
        const item = itemMap.get(h.itemId);
        if (!item) continue;
        const score = alpha * (1 - h.dist) + (1 - alpha) * keywordScore(query, h.text);
        const prev = best.get(h.itemId);
        if (!prev || score > prev.score) best.set(h.itemId, { score, snippet: h.text.slice(0, 120), item });
      }
      return [...best.values()].sort((a, b) => b.score - a.score).slice(0, topK)
        .map((x) => ({ item: toItemT(x.item), score: Number(x.score.toFixed(4)), snippet: x.snippet }));
    }
  }

  const chunks = await prisma.knowledgeChunk.findMany({
    where: { tenantId, ...(projectId ? { item: { projectId } } : {}) },
    include: { item: true },
    take: 2000, // 演示上限；生产以 pgvector 下推 ORDER BY embedding <=> q LIMIT k 取代
  });
  if (!chunks.length) return [];

  const qv = await embed(query);
  // 每个 item 取其最佳 chunk 分数
  const best = new Map<string, { score: number; snippet: string; item: typeof chunks[number]['item'] }>();
  for (const c of chunks) {
    const vec = (c.embedding as number[] | null) ?? null;
    const sem = cosine(qv, vec);
    const kw = keywordScore(query, c.text);
    const score = alpha * sem + (1 - alpha) * kw;
    const prev = best.get(c.itemId);
    if (!prev || score > prev.score) {
      best.set(c.itemId, { score, snippet: c.text.slice(0, 120), item: c.item });
    }
  }
  return [...best.values()]
    .filter((x) => x.score > 0.02)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => ({ item: toItemT(x.item), score: Number(x.score.toFixed(4)), snippet: x.snippet }));
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
