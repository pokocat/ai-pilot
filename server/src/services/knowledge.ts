// 知识库服务：把「对话提炼 / 报告 / 上传文档 / 手动笔记」统一切片 + 向量化入库，
// 供混合检索（retrieval.hybridSearch）召回，并可被对话显式 @ 引用。

import { randomUUID } from 'node:crypto';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { embed } from './embedding.js';
import { pgvectorEnabled, upsertChunkVector } from './vectorStore.js';
import { parseDocument, detectDocType } from './docParse.js';
import { looksFinancial } from './finParse.js';
import { ossConfigured, ossPutBuffer, ossDelete, ossSignedUrl } from './ossUpload.js';
import { bestUploadName, displayUploadName } from './uploadName.js';
import type { KnowledgeItemT, KnowledgeKind } from '../llm/schema.js';
import type { KnowledgeDocRow, KnowledgeDetail } from '../../../shared/contracts';

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

/** 删除并重建一条 item 的全部切片向量（入库 & 重嵌共用）。返回切片数。 */
export async function chunkAndEmbed(itemId: string, tenantId: string, text: string): Promise<number> {
  await prisma.knowledgeChunk.deleteMany({ where: { itemId } });
  const chunks = chunkText(text);
  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embed(chunks[i]);
    const chunk = await prisma.knowledgeChunk.create({
      data: { itemId, tenantId, ord: i, text: chunks[i], embedding },
    });
    if (pgvectorEnabled()) await upsertChunkVector(chunk.id, embedding).catch(() => {});
  }
  return chunks.length;
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

  await chunkAndEmbed(item.id, opts.tenantId, text);

  return {
    id: item.id,
    projectId: item.projectId,
    kind: item.kind as KnowledgeKind,
    title: displayUploadName(bestUploadName(item.fileName, item.title)),
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
    // 图片（sourceType='image'）是聊天多模态上下文，不是可 @ 引用的资料，从候选列表排除。
    where: { tenantId, sourceType: { not: 'image' }, ...(filter?.projectId ? { projectId: filter.projectId } : {}), ...(filter?.kind ? { kind: filter.kind } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    kind: r.kind as KnowledgeKind,
    title: displayUploadName(bestUploadName(r.fileName, r.title)),
    text: r.text,
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    tags: Array.isArray(r.tagsJson) ? (r.tagsJson as string[]) : [],
    at: r.createdAt.toISOString(),
  }));
}

export async function deleteKnowledge(tenantId: string, id: string): Promise<void> {
  const item = await prisma.knowledgeItem.findFirst({ where: { id, tenantId }, select: { fileKey: true } });
  await prisma.knowledgeItem.deleteMany({ where: { id, tenantId } }); // chunks 级联删除
  if (item?.fileKey) await ossDelete(item.fileKey).catch(() => {}); // 顺带清掉 OSS 原件（best-effort）
}

// ——————————————————————————————————————————————————————————————————————————
// 文档上传管线：原件存 OSS（私有）→ 建 item(parsing) → 立即返回 → 异步解析+切片+嵌入 → status。
// ——————————————————————————————————————————————————————————————————————————

/**
 * 摄取一个上传的文件：先把原件存到 OSS（私有、不可猜 key；未配置 OSS 则跳过、预览不可用），
 * 建一条 status=parsing 的 document item 后**立即返回**，解析+嵌入在后台异步进行。
 */
export async function ingestUploadedFile(opts: {
  tenantId: string;
  userId: string;
  projectId?: string | null;
  fileName: string;
  mime?: string;
  buf: Buffer;
}): Promise<{ id: string; status: string }> {
  const type = detectDocType(opts.fileName, opts.mime); // null → 仍入库，processDocument 会以清晰错误落 failed

  let fileKey: string | null = null;
  if (ossConfigured()) {
    const ext = (opts.fileName.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
    const key = `${env.ossKeyPrefix ? env.ossKeyPrefix + '/' : ''}kb/${opts.tenantId}/${randomUUID()}.${ext}`;
    try {
      fileKey = await ossPutBuffer(key, opts.buf, opts.mime || 'application/octet-stream');
    } catch (e) {
      console.error('[knowledge] OSS put failed, 仅入库文本（无原件预览）:', (e as Error).message);
    }
  }

  const item = await prisma.knowledgeItem.create({
    data: {
      tenantId: opts.tenantId,
      userId: opts.userId,
      projectId: opts.projectId ?? null,
      kind: 'document',
      title: opts.fileName,
      text: '',
      sourceType: 'upload',
      status: 'parsing',
      fileName: opts.fileName,
      fileType: type ?? null,
      fileSize: opts.buf.length,
      fileKey,
      tagsJson: [],
    },
  });

  // 异步处理（不阻塞响应）；buf 由闭包持有直到处理完。失败不抛、落 status=failed。
  void processDocument(item.id, opts.tenantId, opts.buf, opts.fileName, opts.mime);
  return { id: item.id, status: item.status };
}

/** 异步：解析文档 → 落正文 → 切片+嵌入 → status=ready；任何失败落 status=failed + error。绝不抛出。 */
export async function processDocument(itemId: string, tenantId: string, buf: Buffer, fileName: string, mime?: string): Promise<void> {
  try {
    const { text } = await parseDocument(buf, fileName, mime);
    await prisma.knowledgeItem.update({ where: { id: itemId }, data: { text, status: 'embedding', error: null } });
    await chunkAndEmbed(itemId, tenantId, text);
    await prisma.knowledgeItem.update({ where: { id: itemId }, data: { status: 'ready' } });
  } catch (e) {
    const msg = ((e as Error).message ?? '解析失败').slice(0, 500);
    await prisma.knowledgeItem.update({ where: { id: itemId }, data: { status: 'failed', error: msg } }).catch(() => {});
    console.error(`[knowledge] processDocument ${itemId} failed:`, msg);
  }
}

/** 重嵌一条 item：从已存正文重新切片+向量化（不重新解析原件）。空文本则跳过。 */
export async function reembedItem(tenantId: string, id: string): Promise<{ chunks: number }> {
  const item = await prisma.knowledgeItem.findFirst({ where: { id, tenantId } });
  if (!item || !item.text.trim()) return { chunks: 0 };
  await prisma.knowledgeItem.update({ where: { id }, data: { status: 'embedding', error: null } });
  const chunks = await chunkAndEmbed(id, tenantId, item.text);
  await prisma.knowledgeItem.update({ where: { id }, data: { status: 'ready' } });
  return { chunks };
}

/** 知识项详情 + 切片（含每片向量维度，便于排查嵌入是否正常）。 */
export async function getKnowledgeDetail(tenantId: string, id: string): Promise<KnowledgeDetail | null> {
  const item = await prisma.knowledgeItem.findFirst({
    where: { id, tenantId },
    include: { chunks: { orderBy: { ord: 'asc' } } },
  });
  if (!item) return null;
  return {
    id: item.id,
    kind: item.kind,
    title: displayUploadName(bestUploadName(item.fileName, item.title)),
    sourceType: item.sourceType,
    status: item.status,
    fileName: displayUploadName(bestUploadName(item.fileName, item.title)),
    fileType: item.fileType,
    fileSize: item.fileSize,
    projectId: item.projectId,
    error: item.error,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    textPreview: item.text.slice(0, 2000),
    chunks: item.chunks.map((c) => ({
      id: c.id,
      ord: c.ord,
      text: c.text,
      dim: Array.isArray(c.embedding) ? (c.embedding as number[]).length : 0,
    })),
    // WO-09：解析完成（ready）且正文像财务/表格 → 可发起经营体检。
    canAnalyze: item.status === 'ready' && looksFinancial(item.text),
  };
}

/** 取知识项原件的有时限签名预览 URL；无原件 / OSS 未配置 → null。 */
export async function knowledgePreviewUrl(tenantId: string, id: string): Promise<string | null> {
  const item = await prisma.knowledgeItem.findFirst({ where: { id, tenantId }, select: { fileKey: true } });
  if (!item?.fileKey || !ossConfigured()) return null;
  return ossSignedUrl(item.fileKey, 600);
}

/** 列出某用户的知识库（文档视图：状态 + 文件元信息 + 切片数）。 */
export async function listKnowledgeDocs(tenantId: string, userId: string, filter?: { projectId?: string }): Promise<KnowledgeDocRow[]> {
  const rows = await prisma.knowledgeItem.findMany({
    // 图片不在「我的资料库」文档视图中呈现（属聊天多模态上下文，非上传文档）。
    where: { tenantId, userId, sourceType: { not: 'image' }, ...(filter?.projectId ? { projectId: filter.projectId } : {}) },
    orderBy: { updatedAt: 'desc' },
    take: 200,
    include: { _count: { select: { chunks: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: displayUploadName(bestUploadName(r.fileName, r.title)),
    sourceType: r.sourceType,
    status: r.status, // staged 解析失败的项 status 已如实为 failed（见 ingestStagedFile），此处原样透出
    stage: r.stage,
    fileName: displayUploadName(bestUploadName(r.fileName, r.title)),
    fileType: r.fileType,
    fileSize: r.fileSize,
    chunkCount: r._count.chunks,
    // 一行摘要：正文首段折叠空白后截断，供列表信息密度（原名 + 摘要 + 状态 + 时间）用；空文本（解析中/失败）返回空串。
    summary: (r.text || '').replace(/\s+/g, ' ').trim().slice(0, 48),
    projectId: r.projectId,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}
