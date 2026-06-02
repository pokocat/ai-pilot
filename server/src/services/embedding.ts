// 文本向量化（知识库 / 语义记忆的基座）。
//
// 设计：保持「生产 pgvector / 本地零依赖」一致原则——
//   • 默认走本地「确定性嵌入」(embedLocal)：纯算法、离线、零成本、零网络，
//     维度固定 EMBED_DIM，相同/相近文本得到相近向量，足够驱动语义召回的演示与联调。
//   • 配置 EMBEDDING_MODEL + 真实 openai 兼容 key 时，自动切到真实嵌入模型(embedRemote)，
//     语义质量更高；生产应同时把 KnowledgeChunk.embedding 迁到 pgvector 的 vector 类型 + HNSW 索引。
//
// 注意：同一语料里的向量必须同源同维。切换嵌入来源后需要重新嵌入历史数据（见 AGENTS §16 升级路径）。

import { env, isRealKey } from '../env.js';

export const EMBED_DIM = 256;

// —— FNV-1a 字符串哈希（把 token 稳定散列到桶位） ——
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 取 token：CJK 按「单字 + 相邻双字」，拉丁按「小写词 + 词内三元组」，对中英文都有局部相似度。
function tokenize(text: string): string[] {
  const t = text.toLowerCase().slice(0, 2000);
  const toks: string[] = [];
  // 拉丁词
  const words = t.match(/[a-z0-9]+/g) ?? [];
  for (const w of words) {
    toks.push(w);
    for (let i = 0; i + 3 <= w.length; i++) toks.push(w.slice(i, i + 3));
  }
  // CJK 单字 + 双字
  const cjk = t.match(/[一-鿿]/g) ?? [];
  for (let i = 0; i < cjk.length; i++) {
    toks.push(cjk[i]);
    if (i + 1 < cjk.length) toks.push(cjk[i] + cjk[i + 1]);
  }
  return toks;
}

/** 确定性本地嵌入：把 token 散列累加进固定维向量并做 L2 归一化。 */
export function embedLocal(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  const toks = tokenize(text);
  for (const tok of toks) {
    const h = fnv1a(tok);
    const idx = h % EMBED_DIM;
    const sign = (h >> 16) & 1 ? 1 : -1; // 符号散列，降低碰撞偏置
    v[idx] += sign;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

function remoteEnabled(): boolean {
  return !!env.embeddingModel && env.aiProvider === 'openai' && isRealKey(env.openaiApiKey);
}

/** 真实嵌入（OpenAI 兼容 /embeddings）。失败抛错，由 embed() 兜底回本地。 */
async function embedRemote(text: string): Promise<number[]> {
  const base = env.openaiBaseUrl.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), env.openaiTimeoutMs);
  try {
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.openaiApiKey}` },
      body: JSON.stringify({ model: env.embeddingModel, input: text.slice(0, 4000) }),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as { data?: { embedding?: number[] }[] };
    const emb = data.data?.[0]?.embedding;
    if (!emb?.length) throw new Error('embeddings 返回为空');
    return emb;
  } finally {
    clearTimeout(timer);
  }
}

/** 统一入口：优先真实模型，未配置/失败则本地确定性嵌入兜底。 */
export async function embed(text: string): Promise<number[]> {
  if (remoteEnabled()) {
    try {
      return await embedRemote(text);
    } catch (err) {
      console.error('[embedding] remote fallback to local:', (err as Error).message);
    }
  }
  return embedLocal(text);
}

/** 余弦相似度（维度不一致返回 0，避免混合来源向量误判）。 */
export function cosine(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // 双方均已 L2 归一化时点积即余弦；真实嵌入未归一化也作近似排序用
}
