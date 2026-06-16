// 运营端「知识库」视图 + 存量重嵌。
// 看到用户知识库被切片/嵌入加工的状态，并做「维度体检」：存量切片维度 ≠ 当前嵌入维度时
// 向量召回会静默失效（cosine 维度不匹配返回 0），此处显式标出并提供一键重嵌。
import { prisma } from '../db.js';
import { embed, embeddingDim, embeddingUsable, resolveEmbedding } from './embedding.js';
import { getAiConfig } from './aiConfig.js';
import { pgvectorEnabled, upsertChunkVector, upsertMemoryVector } from './vectorStore.js';
import type { AdminKnowledgeView, AdminKnowledgeItemRow, ReembedResult } from '../../../shared/contracts';

export async function knowledgeView(): Promise<AdminKnowledgeView> {
  const cfg = await getAiConfig();
  const embedRemote = embeddingUsable(resolveEmbedding(cfg));
  const embedDim = await embeddingDim();
  const embedModel = embedRemote ? cfg.embeddingModel : '本地确定性嵌入';

  const items = await prisma.knowledgeItem.findMany({
    select: { id: true, title: true, kind: true, tenantId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  // 每个知识项的切片数 + 去重维度（jsonb_array_length）。
  const dimRows = await prisma.$queryRawUnsafe<{ itemId: string; dim: number; cnt: number }[]>(
    `SELECT "itemId", jsonb_array_length(embedding) AS dim, count(*)::int AS cnt
     FROM knowledge_chunk WHERE embedding IS NOT NULL GROUP BY 1, 2`,
  );
  const byItem = new Map<string, { dims: Set<number>; chunks: number }>();
  let chunks = 0;
  let staleChunks = 0;
  for (const r of dimRows) {
    const e = byItem.get(r.itemId) ?? { dims: new Set<number>(), chunks: 0 };
    e.dims.add(r.dim);
    e.chunks += Number(r.cnt);
    byItem.set(r.itemId, e);
    chunks += Number(r.cnt);
    if (r.dim !== embedDim) staleChunks += Number(r.cnt);
  }

  const tenantIds = [...new Set(items.map((i) => i.tenantId))];
  const tenants = tenantIds.length
    ? await prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })
    : [];
  const tn = new Map(tenants.map((t) => [t.id, t.name]));

  const rows: AdminKnowledgeItemRow[] = items.map((i) => {
    const e = byItem.get(i.id);
    const dims = e ? [...e.dims].sort((a, b) => a - b) : [];
    return {
      id: i.id,
      title: i.title || '（无标题）',
      kind: i.kind,
      tenantId: i.tenantId,
      tenantName: tn.get(i.tenantId) ?? null,
      chunks: e?.chunks ?? 0,
      dims,
      stale: dims.some((d) => d !== embedDim),
      createdAt: i.createdAt.toISOString(),
    };
  });

  const memRows = await prisma.$queryRawUnsafe<{ dim: number; cnt: number }[]>(
    `SELECT jsonb_array_length(embedding) AS dim, count(*)::int AS cnt FROM memory WHERE embedding IS NOT NULL GROUP BY 1`,
  );
  let memories = 0;
  let staleMemories = 0;
  for (const r of memRows) {
    memories += Number(r.cnt);
    if (r.dim !== embedDim) staleMemories += Number(r.cnt);
  }

  return { embedDim, embedRemote, embedModel, totals: { items: items.length, chunks, staleChunks, memories, staleMemories }, items: rows };
}

/** 重嵌全部存量（知识库切片 + 长期记忆）。换嵌入来源后用。reembed.ts 脚本与 admin 接口共用。 */
export async function reembedAll(): Promise<ReembedResult> {
  const pg = pgvectorEnabled();
  const chunks = await prisma.knowledgeChunk.findMany({ select: { id: true, text: true } });
  for (const c of chunks) {
    const v = await embed(c.text);
    await prisma.knowledgeChunk.update({ where: { id: c.id }, data: { embedding: v } });
    if (pg) await upsertChunkVector(c.id, v).catch(() => {});
  }
  const mems = await prisma.memory.findMany({ select: { id: true, text: true } });
  for (const m of mems) {
    const v = await embed(m.text);
    await prisma.memory.update({ where: { id: m.id }, data: { embedding: v } });
    if (pg) await upsertMemoryVector(m.id, v).catch(() => {});
  }
  return { ok: true, chunks: chunks.length, memories: mems.length, dim: await embeddingDim() };
}
