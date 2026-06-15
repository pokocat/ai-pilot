// 重排（rerank）接入：在 hybridSearch 融合打分得到候选后，调用 rerank 模型对候选重排，提升 TopN 精度。
//
// 设计与 embedding 一致：开关 + 可独立配凭证（baseUrl/key 留空回退对话模型）；未开启/不可用/调用失败
// 一律「优雅退回」——保持融合打分的原始顺序，绝不让检索因 rerank 异常而失败。
//
// 兼容口径：面向主流托管 rerank 服务（Jina / Cohere / SiliconFlow / 通义 等）的 OpenAI-style /rerank：
//   POST {baseUrl}/rerank  { model, query, documents: string[], top_n }
//   → { results: [{ index, relevance_score }] }（按分降序）
// 响应解析做了容错：results[].relevance_score|score，或裸数组 [{index, score}]（TEI 风格）。

import { isRealKey } from '../env.js';
import { getAiConfig, type ResolvedAiConfig } from './aiConfig.js';

export interface RerankCreds { enabled: boolean; baseUrl: string; apiKey: string; model: string; }
export interface RerankResult { index: number; score: number; }

/** 解析重排接入凭证：开关 + 模型，baseUrl/key 留空回退对话模型。 */
export function resolveRerank(cfg: ResolvedAiConfig): RerankCreds {
  return {
    enabled: !!cfg.rerankEnabled,
    model: cfg.rerankModel,
    baseUrl: (cfg.rerankBaseUrl || cfg.baseUrl).replace(/\/+$/, ''),
    apiKey: cfg.rerankApiKey || cfg.apiKey,
  };
}
/** 是否可走重排：开关开 + 有模型 + 有 baseUrl + 真实 key。 */
export function rerankUsable(c: RerankCreds): boolean {
  return c.enabled && !!c.model && !!c.baseUrl && isRealKey(c.apiKey);
}

/** 调 rerank API，返回按相关性降序的 { index, score }（index 相对入参 documents 顺序）。失败抛错。 */
async function rerankCall(c: RerankCreds, query: string, documents: string[], topN: number, timeoutMs: number): Promise<RerankResult[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${c.baseUrl}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({
        model: c.model,
        query: query.slice(0, 4000),
        documents: documents.map((d) => d.slice(0, 1500)),
        top_n: topN,
        return_documents: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as
      | { results?: { index: number; relevance_score?: number; score?: number }[] }
      | { index: number; score?: number; relevance_score?: number }[];
    const rows = Array.isArray(data) ? data : data.results;
    if (!Array.isArray(rows)) throw new Error('rerank 返回格式异常');
    const out = rows
      .filter((r) => typeof r.index === 'number')
      .map((r) => ({ index: r.index, score: r.relevance_score ?? r.score ?? 0 }));
    if (!out.length) throw new Error('rerank 返回为空');
    return out.sort((a, b) => b.score - a.score);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 对候选文档重排。未开启 / 不可用 / 调用失败 → 返回 null，调用方退回原始顺序。
 * documents 顺序即返回 index 的参照系。
 */
export async function rerank(query: string, documents: string[], topN: number): Promise<RerankResult[] | null> {
  if (documents.length <= 1 || !query.trim()) return null;
  const cfg = await getAiConfig();
  const c = resolveRerank(cfg);
  if (!rerankUsable(c)) return null;
  try {
    return await rerankCall(c, query, documents, Math.min(topN, documents.length), cfg.timeoutMs);
  } catch (err) {
    console.error('[rerank] fallback to fusion order:', (err as Error).message);
    return null;
  }
}

/** 连通性探活（运营后台「测试连接」用）。 */
export async function testRerank(cfg: ResolvedAiConfig): Promise<{ ok: boolean; error?: string }> {
  const c = resolveRerank(cfg);
  if (!c.enabled) return { ok: false, error: '未开启重排接入' };
  if (!rerankUsable(c)) return { ok: false, error: '缺少模型 / baseUrl / 真实 Key（留空则回退对话模型）' };
  try {
    await rerankCall(c, '连接测试', ['军师是商业战略顾问', '今天天气不错'], 2, cfg.timeoutMs);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
