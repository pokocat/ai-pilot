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

// ——————————————————————————————————————————————————————————————————————————
// 显式引用注入预算（resolveReferences）
//
// 对话可一次带多份资料上来，若把每份全文原样灌进 prompt，几份长报告就能把上下文窗口挤爆
// （系统提示词 / 历史 / 自动召回 / 输出都会被挤掉，模型反而更蠢）。故立三条规矩：
//  ① 单份上限 60000 字符——与 docParse.ts 的 MAX_TEXT 对齐，让「长文转附卷」能完整进入 LLM，
//     不在这一层悄悄腰斩；只在越过上下文安全线时才截，且截了必自报家门。
//  ② 全部引用合计 120000 字符——防上下文爆掉的安全护栏（非产品级字数限制）：
//     中文约 1 字 ≈ 1.5 token，折合 ~180k token，主流长窗口（200k+）下仍留余量给系统提示词、历史与产出；
//  ③ 单轮至多 9 份——与前端 chooseMessageFile({ count: 9 }) 对齐：一次能选几份，就能带几份。
// ——————————————————————————————————————————————————————————————————————————
export const MAX_REF_CHARS_PER_DOC = 60_000;
export const MAX_REF_CHARS_TOTAL = 120_000;
export const MAX_REFS = 9;

/**
 * 总预算分配（最大最小公平 / 注水法）：先按份数等分，用不完的短件把余量回吐给长件，如此往复。
 *
 * 约束（这三条是本函数存在的理由，改动前请先想清楚）：
 *  • 任一份不超过 perDoc；
 *  • 合计不超过 total；
 *  • **不是先到先得**——绝不允许排在前面的长文件吃光总预算，让后面几份一个字都进不去。
 *
 * 返回与 lengths 等长的「每份可注入字符数」。
 */
export function allocateRefBudget(
  lengths: number[],
  total = MAX_REF_CHARS_TOTAL,
  perDoc = MAX_REF_CHARS_PER_DOC,
): number[] {
  const want = lengths.map((n) => Math.min(Math.max(n, 0), perDoc));
  if (want.reduce((a, b) => a + b, 0) <= total) return want; // 装得下就都给足，不必分配
  const alloc = new Array<number>(lengths.length).fill(0);
  let remaining = total;
  let open = want.map((_, i) => i).filter((i) => want[i] > 0);
  while (open.length && remaining > 0) {
    const share = Math.floor(remaining / open.length);
    if (share <= 0) break; // 余量已不足人手一字，收工（误差 < 份数，可忽略）
    for (const i of open) {
      const give = Math.min(want[i] - alloc[i], share);
      alloc[i] += give;
      remaining -= give;
    }
    open = open.filter((i) => alloc[i] < want[i]);
  }
  return alloc;
}

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

/** 一条已取出的引用：head=出处标注（会被 【】 包住），body=正文（受预算裁剪），label=气泡展示名。 */
interface RefEntry { head: string; body: string; label: string; }

export interface ResolvedRefs {
  lines: string[];    // 注入 prompt 的文本（含出处标注；截断处已显式声明为节选）
  labels: string[];   // 「参考了哪些资料」展示用
  notices: string[];  // 用户可见提示：没带上的、还在拆读的——一律明说，绝不静默
}

/**
 * 解析显式引用 → 带出处标注的上下文文本（仅取该用户/租户可见的资料，严格隔离）。
 *
 * 三处「不许瞒着人」的约定：
 *  • 超过 MAX_REFS 的引用会被丢掉，但必须点名回传（notices），不做静默截断；
 *  • 正文超预算时按 allocateRefBudget 裁剪，且在标注里写明「节选 / 全文多少字 / 截了多少字」，
 *    不让模型把节选当全文；
 *  • 上传后仍在拆读（status=parsing）或解析失败的资料，正文本就是空的——直说其未就绪，
 *    而不是塞一个空知识块让模型以为这份资料没内容。
 */
export async function resolveReferences(
  tenantId: string,
  userId: string,
  refs: MessageRef[] | undefined,
): Promise<ResolvedRefs> {
  const lines: string[] = [];
  const labels: string[] = [];
  const notices: string[] = [];
  if (!refs?.length) return { lines, labels, notices };

  const taken = refs.slice(0, MAX_REFS);
  const dropped = refs.slice(MAX_REFS);

  const entries: RefEntry[] = [];
  for (const ref of taken) {
    try {
      // 图片引用不文本化（由 buildGenContext 解析成多模态入参 ctx.images，见 chatImage.resolveImageRefs）。
      if (ref.kind === 'image') continue;
      if (ref.kind === 'project') {
        const p = await prisma.project.findFirst({ where: { id: ref.id, tenantId } });
        if (p) {
          entries.push({ head: `项目：${p.name}`, body: p.summary ?? '（暂无项目摘要）', label: `项目《${p.name}》` });
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
            entries.push({ head: `报告：${doc.title} v${ver.version}`, body, label: `报告《${doc.title}》v${ver.version}` });
          }
        }
      } else if (ref.kind === 'knowledge') {
        const k = await prisma.knowledgeItem.findFirst({ where: { id: ref.id, tenantId } });
        if (k) {
          const title = k.title ?? k.kind;
          // 上传即挂引用、解析却是异步的：客户手快时正文尚未落库。此时明说未就绪，不塞空块。
          if (k.status === 'parsing' || k.status === 'embedding') {
            entries.push({
              head: `知识：${title}（尚在拆读，正文未到手）`,
              body: '此件仍在拆读，正文尚未成形。不可臆测其内容；若需据此件断事，直言尚在拆读、请客户稍候再问。',
              label: `知识「${title}」（拆读中）`,
            });
            notices.push(`「${title}」尚在拆读，这一轮未能引其正文——稍候再问一次便是。`);
          } else if (k.status === 'failed' || !k.text.trim()) {
            entries.push({
              head: `知识：${title}（未能读出正文）`,
              body: '此件未能读出正文。不可臆测其内容；若需据此件断事，直言此件读不出、请客户换个格式重传。',
              label: `知识「${title}」（读不出）`,
            });
            notices.push(`「${title}」读不出正文，这一轮未能引用——换个格式重传即可。`);
          } else {
            entries.push({ head: `知识：${title}`, body: k.text, label: `知识「${k.title ?? k.text.slice(0, 12)}」` });
          }
        }
      } else if (ref.kind === 'memory') {
        const m = await prisma.memory.findFirst({ where: { id: ref.id, tenantId, userId } });
        if (m) {
          entries.push({ head: '记忆', body: m.text, label: '一段记忆' });
        }
      }
    } catch {
      /* 单条引用解析失败不影响整体 */
    }
  }

  // 预算：单份 ≤ 60000 字，合计 ≤ 120000 字（防上下文爆掉的安全护栏）；按最大最小公平分，短件不因排在后面而挨饿。
  const budgets = allocateRefBudget(entries.map((e) => e.body.length));
  entries.forEach((e, i) => {
    const budget = budgets[i];
    if (e.body.length <= budget) {
      lines.push(`【${e.head}】${e.body}`);
    } else {
      // 截断必须自报家门：否则模型会把节选当全文，据半篇文章下满篇结论。
      lines.push(`【${e.head}（节选，全文 ${e.body.length} 字，此处截取前 ${budget} 字）】${e.body.slice(0, budget)}`);
    }
    labels.push(e.label);
  });
  if (dropped.length) {
    const names = dropped.map((r) => r.label).filter(Boolean).join('、');
    notices.push(`一轮至多带 ${MAX_REFS} 份资料，另有 ${dropped.length} 份未带上${names ? `（${names}）` : ''}——另起一轮再问便是。`);
  }
  return { lines, labels, notices };
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
