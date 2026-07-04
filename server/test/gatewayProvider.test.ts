// Gateway × Provider 错误路径集成测试：端到端跑「路由 → gateway → openai provider → fetch」，
// 用 globalThis.fetch stub 模拟 OpenAI 兼容协议的 正常 / 429 / 500 / 超时(abort) 返回，
// 断言 gateway 的兜底决策与错误映射（这正是 PR #4 调整的 AI_FALLBACK_MOCK + aiUnavailable 逻辑）：
//   - 真实调用成功 → 原样返回模型文本（证明走的是真 provider 代码路径，不是 mock）
//   - 调用失败 + AI_FALLBACK_MOCK=false → 503 AI_UNAVAILABLE（abort→「超时」，其它→「不可用」）
//   - 调用失败 + AI_FALLBACK_MOCK=true  → 静默兜底 mock，200
// 不出网：fetch 被打桩；用 AI_ALLOW_REAL_PROVIDER=1 仅放行「provider 代码路径」（见 env.isAiTestMode）。
//   cd server && node --import tsx --test test/gatewayProvider.test.ts
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, login, api, uniquePhone } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';

const CHAT_URL = '/chat/completions';
const realFetch = globalThis.fetch;
const origFallback = env.aiFallbackMock;

// 把 general 配成自定义 OpenAI 端点（providerMode=openai）。明文 key 透传（未配加密），isRealKey=true。
async function makeGeneralOpenai() {
  await prisma.agent.update({
    where: { key: 'general' },
    data: { providerMode: 'openai', apiBaseUrl: 'http://mock.test/v1', apiModel: 'mock-model', apiKey: 'sk-test-real-123' },
  });
}
async function resetGeneral() {
  await prisma.agent.update({
    where: { key: 'general' },
    data: { providerMode: 'inherit', apiBaseUrl: null, apiModel: null, apiKey: null },
  });
}

// 只拦截 chat/completions；其余出站请求一律报错（不该有——嵌入/检索在测试里走本地确定性，不出网）。
function stubFetch(handler: () => { ok: boolean; status: number; body: unknown } | Promise<never>) {
  globalThis.fetch = (async (url: any) => {
    if (!String(url).includes(CHAT_URL)) throw new Error(`unexpected fetch: ${url}`);
    const r = await handler();
    return { ok: r.ok, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
}
// 模拟 AbortController 超时：fetch reject 一个含 abort 字样的错误（aiUnavailable 据此判「超时」）。
function stubAbort() {
  globalThis.fetch = (async (url: any) => {
    if (!String(url).includes(CHAT_URL)) throw new Error(`unexpected fetch: ${url}`);
    const e = new Error('The operation was aborted'); (e as Error & { name: string }).name = 'AbortError';
    throw e;
  }) as unknown as typeof fetch;
}

async function gen(token: string, text: string) {
  return api('POST', '/api/generate-sync', { token, body: { text, agentKey: 'general' } });
}

describe('Gateway × Provider 错误路径', () => {
  before(async () => {
    process.env.AI_ALLOW_REAL_PROVIDER = '1'; // 放行真实 provider 代码路径（fetch 仍被打桩）
    await getApp();
    await cleanBusiness();
    await seedBaseline();
    await makeGeneralOpenai();
  });
  after(async () => {
    await resetGeneral();
    delete process.env.AI_ALLOW_REAL_PROVIDER;
    globalThis.fetch = realFetch;
    env.aiFallbackMock = origFallback;
    await closeApp();
  });
  beforeEach(() => { env.aiFallbackMock = origFallback; });
  afterEach(() => { globalThis.fetch = realFetch; });

  test('真实调用成功 → 原样返回模型文本（证明走真 provider，非 mock）', async () => {
    stubFetch(() => ({
      ok: true, status: 200,
      body: { choices: [{ message: { content: '机构级判断：先稳现金流，再谈增长。' } }], usage: { prompt_tokens: 12, completion_tokens: 8 } },
    }));
    const t = await login(uniquePhone());
    const r = await gen(t, '我该先做什么');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'chat');
    assert.equal(r.body.reply.text, '机构级判断：先稳现金流，再谈增长。');
  });

  test('429 + AI_FALLBACK_MOCK=false → 503 AI_UNAVAILABLE', async () => {
    env.aiFallbackMock = false;
    stubFetch(() => ({ ok: false, status: 429, body: { error: { message: 'rate limited' } } }));
    const t = await login(uniquePhone());
    const r = await gen(t, '帮我看下增长');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'AI_UNAVAILABLE');
  });

  test('500 + AI_FALLBACK_MOCK=false → 503 AI_UNAVAILABLE', async () => {
    env.aiFallbackMock = false;
    stubFetch(() => ({ ok: false, status: 500, body: { error: { message: 'boom' } } }));
    const t = await login(uniquePhone());
    const r = await gen(t, '诊断一下');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'AI_UNAVAILABLE');
  });

  test('OpenAI 兼容返回空 content → 503，不落固定追问兜底', async () => {
    env.aiFallbackMock = false;
    stubFetch(() => ({
      ok: true, status: 200,
      body: {
        choices: [{ finish_reason: 'length', message: { content: '' } }],
        usage: { prompt_tokens: 120, completion_tokens: 1500 },
      },
    }));
    const t = await login(uniquePhone());
    const r = await gen(t, '我已经给了背景，继续判断');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'AI_UNAVAILABLE');
    assert.doesNotMatch(String(r.body.error), /我需要更多信息/);
  });

  test('超时(abort) + AI_FALLBACK_MOCK=false → 503 且提示「超时」', async () => {
    env.aiFallbackMock = false;
    stubAbort();
    const t = await login(uniquePhone());
    const r = await gen(t, '慢慢想');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'AI_UNAVAILABLE');
    assert.match(r.body.error, /超时/);
  });

  test('429 + AI_FALLBACK_MOCK=true → 静默兜底 mock，200', async () => {
    env.aiFallbackMock = true;
    stubFetch(() => ({ ok: false, status: 429, body: { error: { message: 'rate limited' } } }));
    const t = await login(uniquePhone());
    const r = await gen(t, '兜底应答');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'chat');
    assert.ok(r.body.reply.text && r.body.reply.text.length > 0, 'mock 应返回非空文本');
  });
});
