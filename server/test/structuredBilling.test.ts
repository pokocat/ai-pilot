// P1-3 结构化生成计费口径 · 集成测试：真实 provider 已发生调用但 schema 校验失败时，
// 额度必须按已发生轮次「保守扣」而非全额退（过去 structured() 只回 null → 调用方 settle(0) → 资损）。
// 用 globalThis.fetch 打桩返回「合法 JSON 但不合 schema」的响应，逼 structured() 走满两轮仍失败；
// AI_ALLOW_REAL_PROVIDER=1 仅放行 provider 代码路径（fetch 不出网）。
//   cd server && node --import tsx --test test/structuredBilling.test.ts
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { getApp, closeApp, seedBaseline, cleanBusiness, login, api, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { setAiConfig } from '../src/services/aiConfig.ts';
import { structuredMetered } from '../src/llm/gateway.ts';

const CHAT_URL = '/chat/completions';
const realFetch = globalThis.fetch;

// 返回 200 + 合法 JSON 但缺字段（过不了任何非空 schema）→ coerceJson 抠到 JSON 但 safeParse 失败。
function stubBadJson() {
  globalThis.fetch = (async (url: unknown) => {
    if (!String(url).includes(CHAT_URL)) throw new Error(`unexpected fetch: ${url}`);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"wrong":1}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

// 钱包惰性创建（首次 reserveQuota 时 balance=quota）→ 用 quota - balance 读「本次净扣减」。
async function deductedOf(userId: string): Promise<number> {
  const w = await prisma.tokenWallet.findUnique({ where: { userId }, select: { quota: true, balance: true } });
  assert.ok(w, '钱包应已随首次预留创建');
  return w!.quota - w!.balance;
}

describe('P1-3 structured() 计费口径（真实调用发生但校验失败）', () => {
  before(async () => {
    process.env.AI_ALLOW_REAL_PROVIDER = '1'; // 放行真实 provider 代码路径（fetch 仍打桩）
    await getApp();
    await cleanBusiness();
    await seedBaseline();
    // 全局配成 openai 兼容端点（明文 key，isRealKey=true）→ liveProvider=openai。
    await setAiConfig({ provider: 'openai', baseUrl: 'http://mock.test/v1', model: 'mock-model', apiKey: 'sk-test-real-123' });
  });
  after(async () => {
    delete process.env.AI_ALLOW_REAL_PROVIDER;
    globalThis.fetch = realFetch;
    await closeApp();
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  test('structuredMetered：校验失败仍报告已发生轮次（attempts=2, data=null, live=true）', async () => {
    stubBadJson();
    const out = await structuredMetered(z.object({ must: z.string().min(1) }), { system: 's', user: 'u' });
    assert.equal(out.data, null);
    assert.equal(out.live, true);
    assert.equal(out.attempts, 2, '首轮 + 修复轮各一次真实调用');
  });

  test('quickscan 路由：schema 校验失败 → 额度按 2 轮保守扣，而非全额退', async () => {
    const token = await login(uniquePhone(), '计费用户');

    stubBadJson();
    const r = await api('POST', '/api/quickscan', { token, body: { industry: '美业', revenueBand: '100-500万', pain: '获客贵' } });
    // 结构化失败 → 路由回退确定性模板，仍 200；但已发生 2 轮真实调用 → 必须扣额度。
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // 净扣减 = ceil(attempts(2) × EST_TOKENS(800) × RATIO(0.3)) = 480（此前的 bug：settle(0) → 净扣减 0，全额退）。
    assert.equal(await deductedOf(token), 480, '按 2 轮已发生调用保守结算，非全额退');
  });
});
