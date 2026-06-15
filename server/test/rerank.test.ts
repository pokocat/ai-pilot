// 检索增强（向量嵌入 / 重排）接入单元测试（纯单元、不连库、不联网）。
// stub globalThis.fetch，断言「凭证回退（留空复用对话模型）/ 请求构造 / 响应解析 / 优雅兜底」。
//   cd server && node --import tsx --test test/rerank.test.ts
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRerank, rerankUsable, testRerank } from '../src/services/rerank.js';
import { resolveEmbedding, embeddingUsable, testEmbedding } from '../src/services/embedding.js';
import type { ResolvedAiConfig } from '../src/services/aiConfig.js';

const realFetch = globalThis.fetch;
let lastCall: { url: string; init: any; body: any } | null = null;
function stubFetch(out: (call: { url: string; body: any }) => { ok: boolean; status: number; body: unknown }): void {
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    lastCall = { url: String(url), init, body };
    const { ok, status, body: resBody } = out({ url: String(url), body });
    return { ok, status, json: async () => resBody } as unknown as Response;
  }) as unknown as typeof fetch;
}
beforeEach(() => { lastCall = null; });
afterEach(() => { globalThis.fetch = realFetch; });

// 基础对话模型配置；各用例按需覆盖嵌入/重排字段。
function cfg(over: Partial<ResolvedAiConfig> = {}): ResolvedAiConfig {
  return {
    provider: 'openai', label: 'Chat', baseUrl: 'https://chat.example.com/v1', model: 'gpt-x',
    apiKey: 'sk-real-chat-key', embeddingModel: '', temperature: 0.7, timeoutMs: 5000,
    embeddingEnabled: false, embeddingBaseUrl: '', embeddingApiKey: '',
    rerankEnabled: false, rerankModel: '', rerankBaseUrl: '', rerankApiKey: '',
    ...over,
  };
}

describe('resolveRerank 凭证回退', () => {
  test('rerank baseUrl/key 留空 → 回退对话模型，trailing slash 裁掉', () => {
    const c = resolveRerank(cfg({ rerankEnabled: true, rerankModel: 'bge', baseUrl: 'https://chat.example.com/v1/' }));
    assert.equal(c.baseUrl, 'https://chat.example.com/v1');
    assert.equal(c.apiKey, 'sk-real-chat-key');
    assert.equal(c.model, 'bge');
    assert.equal(c.enabled, true);
  });
  test('rerank 独立 baseUrl/key 覆盖对话模型', () => {
    const c = resolveRerank(cfg({ rerankEnabled: true, rerankModel: 'bge', rerankBaseUrl: 'https://rr.example.com/v1', rerankApiKey: 'sk-rr' }));
    assert.equal(c.baseUrl, 'https://rr.example.com/v1');
    assert.equal(c.apiKey, 'sk-rr');
  });
});

describe('rerankUsable 门槛', () => {
  test('未开启 → false', () => assert.equal(rerankUsable(resolveRerank(cfg({ rerankModel: 'bge' }))), false));
  test('开启但无模型 → false', () => assert.equal(rerankUsable(resolveRerank(cfg({ rerankEnabled: true }))), false));
  test('开启但 key 是假占位 → false', () => assert.equal(rerankUsable(resolveRerank(cfg({ rerankEnabled: true, rerankModel: 'bge', apiKey: 'your_key_here' }))), false));
  test('开启+模型+真实 key → true', () => assert.equal(rerankUsable(resolveRerank(cfg({ rerankEnabled: true, rerankModel: 'bge' }))), true));
});

describe('testRerank 探活', () => {
  test('未开启 → ok:false 且不发请求', async () => {
    let called = false; stubFetch(() => { called = true; return { ok: true, status: 200, body: {} }; });
    const r = await testRerank(cfg());
    assert.equal(r.ok, false);
    assert.equal(called, false);
  });
  test('连通：POST {baseUrl}/rerank，body 含 model/query/documents/top_n，带 Bearer', async () => {
    stubFetch(() => ({ ok: true, status: 200, body: { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] } }));
    const r = await testRerank(cfg({ rerankEnabled: true, rerankModel: 'bge', rerankBaseUrl: 'https://rr.example.com/v1', rerankApiKey: 'sk-rr' }));
    assert.equal(r.ok, true);
    assert.equal(lastCall!.url, 'https://rr.example.com/v1/rerank');
    assert.equal(lastCall!.init.headers.Authorization, 'Bearer sk-rr');
    assert.equal(lastCall!.body.model, 'bge');
    assert.ok(Array.isArray(lastCall!.body.documents));
    assert.equal(typeof lastCall!.body.query, 'string');
    assert.equal(lastCall!.body.top_n, 2);
  });
  test('非 2xx → ok:false 且 error 含状态码', async () => {
    stubFetch(() => ({ ok: false, status: 503, body: {} }));
    const r = await testRerank(cfg({ rerankEnabled: true, rerankModel: 'bge', rerankApiKey: 'sk-x' }));
    assert.equal(r.ok, false);
    assert.match(r.error || '', /503/);
  });
});

describe('resolveEmbedding 凭证回退 + testEmbedding', () => {
  test('embedding baseUrl/key 留空 → 回退对话模型；与对话 provider（claude）无关也可用', () => {
    const c = resolveEmbedding(cfg({ provider: 'claude', embeddingEnabled: true, embeddingModel: 'text-emb', baseUrl: 'https://chat/v1', apiKey: 'sk-chat' }));
    assert.equal(c.baseUrl, 'https://chat/v1');
    assert.equal(c.apiKey, 'sk-chat');
    assert.equal(embeddingUsable(c), true);
  });
  test('连通：POST {baseUrl}/embeddings，返回向量维度', async () => {
    stubFetch(() => ({ ok: true, status: 200, body: { data: [{ embedding: [0.1, 0.2, 0.3] }] } }));
    const r = await testEmbedding(cfg({ embeddingEnabled: true, embeddingModel: 'text-emb', embeddingBaseUrl: 'https://emb/v1', embeddingApiKey: 'sk-emb' }));
    assert.equal(r.ok, true);
    assert.equal(r.dim, 3);
    assert.equal(lastCall!.url, 'https://emb/v1/embeddings');
    assert.equal(lastCall!.body.model, 'text-emb');
  });
  test('未开启 → ok:false', async () => {
    const r = await testEmbedding(cfg());
    assert.equal(r.ok, false);
  });
});
