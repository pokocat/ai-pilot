-- ============================================================================
-- pgvector 启用脚本（可选，配合 PGVECTOR_ENABLED=true 使用）
--   用法：  npm run db:pgvector        （内部执行 psql "$DATABASE_URL" -f prisma/pgvector.sql）
--   或：    psql "$DATABASE_URL" -f prisma/pgvector.sql
--
-- 作用：启用 pgvector 扩展，为「知识切片 / 长期记忆」加 vector 列 + HNSW 余弦索引，并回填存量。
-- ⚠️ 维度 N 必须与实际嵌入一致：
--      本地确定性嵌入 = 256（默认）；
--      切换真实嵌入模型（如 text-embedding-3-small=1536）后，需先 DROP 列改 N 再全量重嵌。
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE knowledge_chunk ADD COLUMN IF NOT EXISTS embedding_vec vector(256);
ALTER TABLE memory          ADD COLUMN IF NOT EXISTS embedding_vec vector(256);

-- 回填：把已存的 Json(float[]) 写进 vector 列（'[..]'::vector）
UPDATE knowledge_chunk SET embedding_vec = (embedding::text)::vector
  WHERE embedding IS NOT NULL AND embedding_vec IS NULL;
UPDATE memory          SET embedding_vec = (embedding::text)::vector
  WHERE embedding IS NOT NULL AND embedding_vec IS NULL;

-- HNSW 索引（余弦距离 <=>）
CREATE INDEX IF NOT EXISTS knowledge_chunk_vec_hnsw ON knowledge_chunk USING hnsw (embedding_vec vector_cosine_ops);
CREATE INDEX IF NOT EXISTS memory_vec_hnsw          ON memory          USING hnsw (embedding_vec vector_cosine_ops);

-- 完成后：在 server/.env 设 PGVECTOR_ENABLED=true，重启后检索/记忆召回即走 ANN 下推。
