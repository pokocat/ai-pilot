// pgvector 近邻检索（可选，env.pgvectorEnabled 开启）。
// 默认关闭：检索走内存余弦（零依赖、已验证）。开启前需先执行 prisma/pgvector.sql
// 建立 `embedding_vec vector(N)` 列 + HNSW 索引，并对存量数据回填（见该 SQL 注释）。
//
// 说明：列名用 Prisma 的驼峰列（"itemId"/"tenantId"…需双引号），向量以 $n::vector 传入。
// 本路径需对接真实 Postgres + pgvector 验证（本地无扩展时请保持关闭）。

import { prisma } from '../db.js';
import { env } from '../env.js';

export function pgvectorEnabled(): boolean {
  return env.pgvectorEnabled;
}

// number[] → pgvector 字面量 '[0.1,0.2,...]'
function lit(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

export interface ChunkHit { id: string; itemId: string; text: string; dist: number; }

/** 知识切片向量检索（ANN）。userId 可选过滤（上下文按用户隔离）。返回按距离升序的候选。 */
export async function vectorSearchChunks(
  tenantId: string, userId: string | null | undefined, queryVec: number[], k: number,
): Promise<ChunkHit[]> {
  const v = lit(queryVec);
  if (userId) {
    return prisma.$queryRawUnsafe<ChunkHit[]>(
      `SELECT c.id, c."itemId" AS "itemId", c.text, (c.embedding_vec <=> $1::vector) AS dist
       FROM knowledge_chunk c JOIN knowledge_item i ON i.id = c."itemId"
       WHERE c."tenantId" = $2 AND i."userId" = $3 AND c.embedding_vec IS NOT NULL
       ORDER BY c.embedding_vec <=> $1::vector LIMIT $4`,
      v, tenantId, userId, k,
    );
  }
  return prisma.$queryRawUnsafe<ChunkHit[]>(
    `SELECT c.id, c."itemId" AS "itemId", c.text, (c.embedding_vec <=> $1::vector) AS dist
     FROM knowledge_chunk c
     WHERE c."tenantId" = $2 AND c.embedding_vec IS NOT NULL
     ORDER BY c.embedding_vec <=> $1::vector LIMIT $3`,
    v, tenantId, k,
  );
}

export interface MemHit { id: string; text: string; weight: number; dist: number; }

/** 长期记忆向量检索（ANN），按用户 + 未过期。agentKey=null → 用户级共享池（跨军师，A-3）；传值则按智能体隔离。 */
export async function vectorSearchMemories(
  userId: string, agentKey: string | null, queryVec: number[], k: number,
): Promise<MemHit[]> {
  const v = lit(queryVec);
  if (agentKey === null) {
    return prisma.$queryRawUnsafe<MemHit[]>(
      `SELECT id, text, weight, (embedding_vec <=> $1::vector) AS dist
       FROM memory
       WHERE "userId" = $2 AND embedding_vec IS NOT NULL
         AND ("expiresAt" IS NULL OR "expiresAt" > now())
       ORDER BY embedding_vec <=> $1::vector LIMIT $3`,
      v, userId, k,
    );
  }
  return prisma.$queryRawUnsafe<MemHit[]>(
    `SELECT id, text, weight, (embedding_vec <=> $1::vector) AS dist
     FROM memory
     WHERE "userId" = $2 AND "agentKey" = $3 AND embedding_vec IS NOT NULL
       AND ("expiresAt" IS NULL OR "expiresAt" > now())
     ORDER BY embedding_vec <=> $1::vector LIMIT $4`,
    v, userId, agentKey, k,
  );
}

/** 写入/更新某切片的向量列（pgvector 开启时，与 Json embedding 双写）。 */
export async function upsertChunkVector(id: string, vec: number[]): Promise<void> {
  await prisma.$executeRawUnsafe(`UPDATE knowledge_chunk SET embedding_vec = $1::vector WHERE id = $2`, lit(vec), id);
}
export async function upsertMemoryVector(id: string, vec: number[]): Promise<void> {
  await prisma.$executeRawUnsafe(`UPDATE memory SET embedding_vec = $1::vector WHERE id = $2`, lit(vec), id);
}
