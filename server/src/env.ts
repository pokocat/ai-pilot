import 'dotenv/config';

// 占位/假 key 识别：fake 一个 token 时，不浪费网络往返，直接走 mock 兜底。
export function isRealKey(k: string): boolean {
  return !!k && !/fake|replace|your[-_]?key|xxxx|0{6,}|^sk-\.{3,}$/i.test(k.trim());
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  aiProvider: (process.env.AI_PROVIDER ?? 'mock') as 'mock' | 'claude' | 'openai',

  // Claude（Anthropic）
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  claudeModel: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',

  // OpenAI 通用协议（兼容 DeepSeek / Moonshot / 通义千问兼容模式 等）
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  openaiTimeoutMs: Number(process.env.OPENAI_TIMEOUT_MS ?? 20000),

  // 嵌入模型（知识库/语义记忆）。留空=用本地确定性嵌入（零依赖、离线）；
  // 配置后 + openai 兼容真实 key，走 /embeddings 真实向量（生产建议配合 pgvector）。
  embeddingModel: process.env.EMBEDDING_MODEL ?? '',

  moderationEnabled: (process.env.MODERATION_ENABLED ?? 'true') === 'true',

  // 知识/记忆向量近邻检索：默认关闭走内存余弦（零依赖）；
  // 置 true 且已执行 prisma/pgvector.sql（建 vector 列 + HNSW）后，走 pgvector 的 <=> 下推。
  pgvectorEnabled: (process.env.PGVECTOR_ENABLED ?? 'false') === 'true',
};
