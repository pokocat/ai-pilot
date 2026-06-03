// 知识库服务：把「对话提炼 / 报告 / 上传文档 / 手动笔记」统一切片 + 向量化入库，
// 供混合检索（retrieval.hybridSearch）召回，并可被对话显式 @ 引用。

import { prisma } from '../db.js';
import { embed } from './embedding.js';
import { pgvectorEnabled, upsertChunkVector } from './vectorStore.js';
import type { KnowledgeItemT, KnowledgeKind } from '../llm/schema.js';

// 段落优先切片：按空行/句号聚合到 ~280 字一片，过长再硬切。演示足够；
// 生产可换更讲究的语义切片 / 重叠窗口（见 AGENTS §16）。
export function chunkText(text: string, maxLen = 280): string[] {
  const clean = text.replace(/\r/g, '').trim();
  if (clean.length <= maxLen) return clean ? [clean] : [];
  const paras = clean.split(/\n{2,}|(?<=[。！？!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let buf = '';
  for (const p of paras) {
    if ((buf + p).length > maxLen && buf) {
      out.push(buf.trim());
      buf = '';
    }
    if (p.length > maxLen) {
      for (let i = 0; i < p.length; i += maxLen) out.push(p.slice(i, i + maxLen));
    } else {
      buf += (buf ? ' ' : '') + p;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

export interface IngestOpts {
  tenantId: string;
  userId: string;
  projectId?: string | null;
  kind: KnowledgeKind;
  title?: string | null;
  text: string;
  sourceType: 'conversation' | 'upload' | 'deliverable' | 'manual';
  sourceId?: string | null;
  tags?: string[];
}

/** 摄取一条知识：建 KnowledgeItem + 切片 + 逐片向量化。 */
export async function ingestKnowledge(opts: IngestOpts): Promise<KnowledgeItemT> {
  const text = (opts.text || '').trim();
  if (!text) throw new Error('知识文本为空');

  const item = await prisma.knowledgeItem.create({
    data: {
      tenantId: opts.tenantId,
      userId: opts.userId,
      projectId: opts.projectId ?? null,
      kind: opts.kind,
      title: opts.title ?? null,
      text,
      sourceType: opts.sourceType,
      sourceId: opts.sourceId ?? null,
      tagsJson: opts.tags ?? [],
    },
  });

  const chunks = chunkText(text);
  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embed(chunks[i]);
    const chunk = await prisma.knowledgeChunk.create({
      data: { itemId: item.id, tenantId: opts.tenantId, ord: i, text: chunks[i], embedding },
    });
    if (pgvectorEnabled()) await upsertChunkVector(chunk.id, embedding).catch(() => {});
  }

  return {
    id: item.id,
    projectId: item.projectId,
    kind: item.kind as KnowledgeKind,
    title: item.title,
    text: item.text,
    sourceType: item.sourceType,
    sourceId: item.sourceId,
    tags: opts.tags ?? [],
    at: item.createdAt.toISOString(),
  };
}

/** 列出知识库（租户级，可按项目/类型过滤）。 */
export async function listKnowledge(
  tenantId: string,
  filter?: { projectId?: string; kind?: string },
): Promise<KnowledgeItemT[]> {
  const rows = await prisma.knowledgeItem.findMany({
    where: { tenantId, ...(filter?.projectId ? { projectId: filter.projectId } : {}), ...(filter?.kind ? { kind: filter.kind } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    kind: r.kind as KnowledgeKind,
    title: r.title,
    text: r.text,
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    tags: Array.isArray(r.tagsJson) ? (r.tagsJson as string[]) : [],
    at: r.createdAt.toISOString(),
  }));
}

export async function deleteKnowledge(tenantId: string, id: string): Promise<void> {
  await prisma.knowledgeItem.deleteMany({ where: { id, tenantId } });
}
