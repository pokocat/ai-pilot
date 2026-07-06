// 过期只读锁定的 HTTP 端到端门禁：到期用户 AI 入口 403 PLAN_EXPIRED；/me 暴露 planStatus。
// 不依赖时钟/沙箱：直接把 planExpiresAt 设到过去即可触发（assertPlanActive 读真实 now）。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.js';
import { setQuota, getQuotaState, RESERVE_TOKENS } from '../src/services/tokenQuota.js';
import { setAiConfig } from '../src/services/aiConfig.js';

const tenantOf = async (token: string) => (await prisma.user.findUnique({ where: { id: token } }))!.tenantId;

// 放行「真实 provider 代码路径」（fetch 仍被打桩，不出网）——与 gatewayProvider.test.ts 同款手法，
// 用于验证 extractGraphTriples/summarizePoints 真正触达模型时额度确实被消耗（而非只 ensureQuota 放行判断）。
const realFetch = globalThis.fetch;
function stubRawJsonFetch(payload: Record<string, unknown>) {
  globalThis.fetch = (async (url: unknown) => {
    if (!String(url).includes('/chat/completions')) throw new Error(`unexpected fetch: ${String(url)}`);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) } as unknown as Response;
  }) as unknown as typeof fetch;
}
async function withStubbedLiveProvider<T>(fn: () => Promise<T>): Promise<T> {
  const prevEnv = process.env.AI_ALLOW_REAL_PROVIDER;
  process.env.AI_ALLOW_REAL_PROVIDER = '1';
  await setAiConfig({ provider: 'openai', baseUrl: 'http://mock.test/v1', model: 'mock-model', apiKey: 'sk-test-real-123' });
  stubRawJsonFetch({ entities: [], relations: [], points: ['要点'], conclusions: ['结论'], todos: ['待办'] });
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    process.env.AI_ALLOW_REAL_PROVIDER = prevEnv;
    await setAiConfig({ provider: 'mock', apiKey: '' }); // 复位，避免污染后续测试
  }
}

before(async () => { await getApp(); await seedBaseline(); });
after(async () => { await closeApp(); });
beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

test('过期用户：/me.planStatus.expired=true 且 /generate-sync 被 PLAN_EXPIRED(403) 拦', async () => {
  const token = await login(uniquePhone(), '过期者');
  await prisma.user.update({ where: { id: token }, data: { planExpiresAt: new Date(Date.now() - 86_400_000) } });

  const me = await api('GET', '/api/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.planStatus.expired, true);
  assert.equal(me.body.planStatus.active, false);
  assert.equal(me.body.tokenQuota.limit, 0, '过期后 /me 额度应显示 0（冻结）');

  const gen = await api('POST', '/api/generate-sync', { token, body: { text: '帮我做个战略诊断' } });
  assert.equal(gen.status, 403);
  assert.equal(gen.body.code, 'PLAN_EXPIRED');

  const sum = await api('POST', '/api/sessions/whatever/summarize', { token });
  assert.equal(sum.status, 403, '会话汇总同样被门禁拦');
  assert.equal(sum.body.code, 'PLAN_EXPIRED');
});

test('有效用户（免费层不到期）：/generate-sync 不被有效期拦', async () => {
  const token = await login(uniquePhone(), '有效者');
  const me = await api('GET', '/api/me', { token });
  assert.equal(me.body.planStatus.active, true);
  const gen = await api('POST', '/api/generate-sync', { token, body: { text: '你好' } });
  assert.notEqual(gen.status, 403); // mock 模型正常产出/对话，不应被 PLAN_EXPIRED 拦
});

// 回归：/graph/extract(text 分支) 与 /sessions/:id/summarize 都会触发真实模型（rawJson 系，不回传用量），
// 此前只 ensureQuota(仅判断放行、从不扣减) → 只要余额一次性 >0 即可无限次触发真实模型调用，额度系统形同虚设。
// 现改用与 /generate* 一致的 reserveQuota + 结算：① 额度耗尽应与 /generate* 同样被 402 拦截；
// ② mock/测试环境（未配置真实模型）下应全额退回预留、不产生净扣减（与 /generate* 的 ZERO_USAGE→settle(0) 同口径）。
test('额度耗尽：/graph/extract(text) 与 /sessions/:id/summarize 均被 402 INSUFFICIENT_QUOTA 拦（此前只 ensureQuota 从不真正扣减，可无限调用）', async () => {
  const token = await login(uniquePhone(), '额度耗尽者');
  const tenantId = await tenantOf(token);
  await setQuota(tenantId, token, 0); // quota=0（非-1不限量）→ balance=0 → reserveQuota 应拒绝

  const extract = await api('POST', '/api/graph/extract', { token, body: { text: '张三是项目负责人，客户是云栖科技' } });
  assert.equal(extract.status, 402, '额度耗尽时 text 抽取分支应被拦截');
  assert.equal(extract.body.code, 'INSUFFICIENT_QUOTA');

  const sum = await api('POST', '/api/sessions/whatever/summarize', { token });
  assert.equal(sum.status, 402, '额度耗尽时会话汇总应被拦截');
  assert.equal(sum.body.code, 'INSUFFICIENT_QUOTA');
});

test('mock 环境（未配置真实模型）：/graph/extract(text) 与 /sessions/:id/summarize 成功后应全额退回预留、余额不变净扣', async () => {
  const token = await login(uniquePhone(), '额度正常者');
  const before = await getQuotaState(token);
  assert.ok(before.balance > 0);

  const extract = await api('POST', '/api/graph/extract', { token, body: { text: '张三是项目负责人，客户是云栖科技' } });
  assert.equal(extract.status, 200);
  const afterExtract = await getQuotaState(token);
  assert.equal(afterExtract.balance, before.balance, 'mock 环境无真实成本，预留应全额退回、不产生净扣减');

  const gen = await api('POST', '/api/generate-sync', { token, body: { text: '帮我做个战略诊断', agentKey: 'strat' } });
  assert.equal(gen.status, 200);
  const afterGen = await getQuotaState(token);

  const sum = await api('POST', `/api/sessions/${gen.body.sessionId}/summarize`, { token });
  assert.equal(sum.status, 200);
  const afterSum = await getQuotaState(token);
  assert.equal(afterSum.balance, afterGen.balance, 'mock 环境无真实成本，会话汇总的预留也应全额退回、不产生净扣减');
});

// 回归（核心）：真实模型接通时，重复调用 text 抽取 / 会话汇总必须真正消耗额度。
// 旧实现只 ensureQuota（仅判断 balance>0 放行，从不扣减）——只要余额一次性 >0，不管调用多少次
// balance 永远不变，等于可无限次触发真实模型调用（额度系统形同虚设）。新实现 reserveQuota+settle
// 会按 RESERVE_TOKENS 定额真正扣减，故给 2 次配额的余额，第 3 次必须被拦。用 AI_ALLOW_REAL_PROVIDER=1
// + fetch 打桩放行「真实 provider 代码路径」（不出网），避免这个判定只在 mock 短路分支里被掩盖。
test('回归：真实模型接通时 /graph/extract(text) 重复调用应真正耗尽额度（此前 ensureQuota 从不扣减，可无限调用）', async () => {
  const token = await login(uniquePhone(), '真实抽取者');
  const tenantId = await tenantOf(token);
  await withStubbedLiveProvider(async () => {
    await setQuota(tenantId, token, RESERVE_TOKENS * 2); // 恰好允许 2 次
    const r1 = await api('POST', '/api/graph/extract', { token, body: { text: '张三负责项目A，客户是云栖科技' } });
    assert.equal(r1.status, 200, '第 1 次应放行');
    const r2 = await api('POST', '/api/graph/extract', { token, body: { text: '李四负责项目B，客户是拾光文化' } });
    assert.equal(r2.status, 200, '第 2 次应放行');
    const r3 = await api('POST', '/api/graph/extract', { token, body: { text: '王五负责项目C，客户是青云网络' } });
    assert.equal(r3.status, 402, '第 3 次应被额度拦截（此前 ensureQuota 从不真正扣减，会无限放行）');
    assert.equal(r3.body.code, 'INSUFFICIENT_QUOTA');
  });
});

test('回归：真实模型接通时 /sessions/:id/summarize 重复调用应真正耗尽额度（此前 ensureQuota 从不扣减，可无限调用）', async () => {
  const token = await login(uniquePhone(), '真实汇总者');
  const tenantId = await tenantOf(token);
  // 会话在 mock 阶段建（避免与本测试的真实 provider 打桩纠缠——/generate-sync 走的是 function-calling 协议，
  // 与 rawJson 系的打桩格式不同）。
  const gen = await api('POST', '/api/generate-sync', { token, body: { text: '帮我做个战略诊断', agentKey: 'strat' } });
  assert.equal(gen.status, 200);
  const sessionId = gen.body.sessionId;
  await withStubbedLiveProvider(async () => {
    await setQuota(tenantId, token, RESERVE_TOKENS * 2); // 恰好允许 2 次
    const r1 = await api('POST', `/api/sessions/${sessionId}/summarize`, { token });
    assert.equal(r1.status, 200, '第 1 次应放行');
    const r2 = await api('POST', `/api/sessions/${sessionId}/summarize`, { token });
    assert.equal(r2.status, 200, '第 2 次应放行');
    const r3 = await api('POST', `/api/sessions/${sessionId}/summarize`, { token });
    assert.equal(r3.status, 402, '第 3 次应被额度拦截（此前 ensureQuota 从不真正扣减，会无限调用）');
    assert.equal(r3.body.code, 'INSUFFICIENT_QUOTA');
  });
});

test('生产硬化：支付未配 + 非演示环境 → 付费套餐 /purchase 拦 PAYMENT_COMING_SOON（不免费发放），免费套餐放行', async () => {
  const token = await login(uniquePhone(), '生产购买者');
  const plans = await api('GET', '/api/plans', { token });
  const paid = (plans.body as Array<{ id: string; price: number }>).find((p) => p.price > 0)!;
  const free = (plans.body as Array<{ id: string; price: number }>).find((p) => p.price === 0)!;

  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production'; // 模拟生产：demoPurchaseEnabled() → false
  try {
    const blocked = await api('POST', `/api/plans/${paid.id}/purchase`, { token });
    assert.equal(blocked.status, 402);
    assert.equal(blocked.body.code, 'PAYMENT_COMING_SOON', '付费套餐在生产不免费发放');
    const okFree = await api('POST', `/api/plans/${free.id}/purchase`, { token });
    assert.equal(okFree.status, 200, '免费套餐不受限');
  } finally {
    process.env.NODE_ENV = prev;
  }
  // 恢复测试环境后（demoPurchaseEnabled=true）→ 付费套餐演示发放仍放行
  const okPaid = await api('POST', `/api/plans/${paid.id}/purchase`, { token });
  assert.equal(okPaid.status, 200, '测试/演示环境允许付费套餐演示发放');
});
