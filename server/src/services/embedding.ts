// 文本向量化（知识库 / 语义记忆的基座）。
//
// 设计：保持「生产 pgvector / 本地零依赖」一致原则——
//   • 默认走本地「确定性嵌入」(embedLocal)：纯算法、离线、零成本、零网络，
//     维度固定 EMBED_DIM，相同/相近文本得到相近向量，足够驱动语义召回的演示与联调。
//   • 配置 EMBEDDING_MODEL + 真实 openai 兼容 key 时，自动切到真实嵌入模型(embedRemote)，
//     语义质量更高；生产应同时把 KnowledgeChunk.embedding 迁到 pgvector 的 vector 类型 + HNSW 索引。
//
// 注意：同一语料里的向量必须同源同维。切换嵌入来源后需要重新嵌入历史数据（见 AGENTS §16 升级路径）。

import { isRealKey } from '../env.js';
import { getAiConfig, type ResolvedAiConfig } from './aiConfig.js';

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

/** 解析嵌入接入凭证：开关 + 模型，baseUrl/key 留空回退对话模型。 */
export interface EmbeddingCreds { enabled: boolean; baseUrl: string; apiKey: string; model: string; }
export function resolveEmbedding(cfg: ResolvedAiConfig): EmbeddingCreds {
  return {
    enabled: !!cfg.embeddingEnabled,
    model: cfg.embeddingModel,
    baseUrl: (cfg.embeddingBaseUrl || cfg.baseUrl).replace(/\/+$/, ''),
    apiKey: cfg.embeddingApiKey || cfg.apiKey,
  };
}
/** 是否可走真实远程嵌入：开关开 + 有模型 + 有 baseUrl + 真实 key（与对话 provider 无关，独立接入）。 */
export function embeddingUsable(c: EmbeddingCreds): boolean {
  return c.enabled && !!c.model && !!c.baseUrl && isRealKey(c.apiKey);
}

/** 真实嵌入（OpenAI 兼容 /embeddings）。返回向量 + 本次 token 数（用于基建用量计量）。失败抛错，由 embed() 兜底回本地。 */
async function embedRemote(c: EmbeddingCreds, text: string, timeoutMs: number): Promise<{ embedding: number[]; tokens: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${c.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({ model: c.model, input: text.slice(0, 4000) }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as { data?: { embedding?: number[] }[]; usage?: { prompt_tokens?: number; total_tokens?: number } };
    const emb = data.data?.[0]?.embedding;
    if (!emb?.length) throw new Error('embeddings 返回为空');
    return { embedding: emb, tokens: data.usage?.total_tokens ?? data.usage?.prompt_tokens ?? 0 };
  } finally {
    clearTimeout(timer);
  }
}

// E1：嵌入结果缓存（按 模型+文本 键）。相同文本重复嵌入（去重比对 / 重复 query）直接命中，省 token/延迟。
// 本地确定性嵌入是纯函数，缓存绝对安全；远程按模型名入键，切模型后旧缓存不会误用；远程失败回退本地缓存到 local 键，不污染 remote 键。FIFO 有界。
const EMB_CACHE = new Map<string, number[]>();
const EMB_CACHE_MAX = 2000;
function embCacheSet(key: string, v: number[]): void {
  if (EMB_CACHE.size >= EMB_CACHE_MAX) {
    const first = EMB_CACHE.keys().next().value;
    if (first !== undefined) EMB_CACHE.delete(first);
  }
  EMB_CACHE.set(key, v);
}

/** 统一入口：开启且凭证可用时走真实模型，否则本地确定性嵌入兜底。真实调用计入「检索基建」用量。带结果缓存（E1）。 */
export async function embed(text: string): Promise<number[]> {
  const cfg = await getAiConfig();
  const c = resolveEmbedding(cfg);
  if (embeddingUsable(c)) {
    const rkey = `${c.model}\u0000${text}`;
    const hit = EMB_CACHE.get(rkey);
    if (hit) return hit;
    try {
      const { embedding, tokens } = await embedRemote(c, text, cfg.timeoutMs);
      const { recordInfraUsage } = await import('./usage.js');
      recordInfraUsage('embedding', c.model, tokens); // fire-and-forget，与用户产出用量区分
      embCacheSet(rkey, embedding);
      return embedding;
    } catch (err) {
      console.error('[embedding] remote fallback to local:', (err as Error).message);
    }
  }
  const lkey = `local:${EMBED_DIM}\u0000${text}`;
  const hit = EMB_CACHE.get(lkey);
  if (hit) return hit;
  const local = embedLocal(text);
  embCacheSet(lkey, local);
  return local;
}

/** 探测当前嵌入维度（不记基建用量）：远程可用→远程实测维度，否则本地维度。供「知识库」体检用。 */
export async function embeddingDim(): Promise<number> {
  const cfg = await getAiConfig();
  const c = resolveEmbedding(cfg);
  if (embeddingUsable(c)) {
    try { return (await embedRemote(c, '维度探测', cfg.timeoutMs)).embedding.length; } catch { /* 回退本地维度 */ }
  }
  return EMBED_DIM;
}

/** 连通性探活（运营后台「测试连接」用）。 */
// tokens：上游 usage 回报的真实消耗，探活据此记账（0 = 上游没报或没成功调用，不编数）。
export async function testEmbedding(cfg: ResolvedAiConfig): Promise<{ ok: boolean; dim?: number; error?: string; tokens?: number }> {
  const c = resolveEmbedding(cfg);
  if (!c.enabled) return { ok: false, error: '未开启嵌入接入' };
  if (!embeddingUsable(c)) return { ok: false, error: '缺少模型 / baseUrl / 真实 Key（留空则回退对话模型）' };
  try {
    const v = await embedRemote(c, '连接测试', cfg.timeoutMs);
    return { ok: true, dim: v.embedding.length, tokens: v.tokens };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** 余弦相似度（维度不一致返回 0，避免混合来源向量误判）。 */
export function cosine(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // 双方均已 L2 归一化时点积即余弦；真实嵌入未归一化也作近似排序用
}
