// Admin 运营能力（Agent-S）：per-user 用量下钻 + 三个资金/额度写端点 + 概览环比口径 + 支付订单只读。
// 全程无外部服务（NODE_ENV=test）；admin 路由默认带测试 ADMIN_TOKEN（=master 超管），operator 用会话 token 模拟。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, uniquePhone } from './helpers.js';
import { createOperator, createSession } from '../src/services/adminAccount.js';
import { periodKeyOf } from '../src/services/planTime.js';
import { dateKey, now } from '../src/services/clock.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

before(async () => { await getApp(); });
after(async () => { await closeApp(); });

// 造一个操作员会话 token（role=operator）——用于验证 requireSuper 拒绝。
async function operatorToken(): Promise<string> {
  const acc = await createOperator(`op_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, 'pw-123456', 'operator');
  return createSession(acc.id);
}

async function mkTenantUser(opts: { planId?: string; planActivatedAt?: Date | null; planExpiresAt?: Date | null } = {}) {
  const tenant = await prisma.tenant.create({ data: { name: 'Ops 测试企业' } });
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id, phone: uniquePhone(), name: 'Ops 用户', role: 'owner',
      planId: opts.planId ?? null, planActivatedAt: opts.planActivatedAt ?? null, planExpiresAt: opts.planExpiresAt ?? null,
    },
  });
  return { tenantId: tenant.id, userId: user.id };
}

async function mkPlan(tokenQuotaPerMonth: number): Promise<string> {
  const p = await prisma.plan.create({
    data: { name: `测试套餐 ${tokenQuotaPerMonth}`, price: 9900, period: 'month', creditsPerMonth: 100, tokenQuotaPerMonth, agentCount: 3, featuresJson: [], sort: 99 },
  });
  return p.id;
}

describe('S1 · GET /admin/users/:id/usage', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('404：用户不存在', async () => {
    const r = await api('GET', '/api/admin/users/nope/usage');
    assert.equal(r.status, 404);
  });

  test('quota / tokens 聚合正确；byDay 按上海日历日；orderNo 尾 6 位；无钱包=null', async () => {
    const { tenantId, userId } = await mkTenantUser(); // 无套餐 → periodKey 走自然月(UTC)
    // 钱包：periodKey 对齐 periodKeyOf(null, now) 以免 getQuotaState 惰性重置
    const pk = periodKeyOf(null, now());
    await prisma.tokenWallet.create({ data: { tenantId, userId, quota: 100000, balance: 63000, periodKey: pk } });

    const d1 = new Date(Date.now() - 2 * 864e5);
    const d2 = new Date(Date.now() - 3 * 864e5);
    await prisma.tokenUsage.createMany({
      data: [
        { tenantId, userId, kind: 'chat', provider: 'claude', model: 'claude-x', agentKey: 'brand', inputTokens: 1000, outputTokens: 500, totalTokens: 1500, costMicros: 3000, createdAt: d1 },
        { tenantId, userId, kind: 'deliverable', provider: 'claude', model: 'claude-x', agentKey: 'brand', inputTokens: 2000, outputTokens: 800, totalTokens: 2800, costMicros: 5000, createdAt: d1 },
        { tenantId, userId, kind: 'chat', provider: 'openai', model: 'gpt-y', agentKey: 'poster', inputTokens: 400, outputTokens: 100, totalTokens: 500, costMicros: 900, createdAt: d2 },
      ],
    });
    await prisma.creditLedger.create({ data: { tenantId, userId, delta: 100, reason: '初始', balance: 100 } });
    await prisma.paymentOrder.create({ data: { outTradeNo: 'ORDER-ABC123456', tenantId, userId, planId: '', amount: 9900, status: 'paid', paidAt: d1, attrSource: 'catalog' } });
    await prisma.activationEvent.create({ data: { tenantId, userId, itemType: 'agent', itemKey: 'brand', source: 'catalog' } });

    const r = await api('GET', `/api/admin/users/${userId}/usage?days=30`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body;
    // quota
    assert.deepEqual(b.quota, { limit: 100000, used: 37000, remaining: 63000, unlimited: false, periodKey: pk });
    // tokens totals (SQL 聚合)
    assert.equal(b.tokens.totalTokens, 1500 + 2800 + 500);
    assert.equal(b.tokens.inputTokens, 1000 + 2000 + 400);
    assert.equal(b.tokens.outputTokens, 500 + 800 + 100);
    assert.equal(b.tokens.costMicros, 3000 + 5000 + 900);
    assert.equal(b.tokens.calls, 3);
    // byModel：claude-x 合计 4300，居首
    assert.equal(b.tokens.byModel[0].key, 'claude-x');
    assert.equal(b.tokens.byModel[0].totalTokens, 4300);
    // byAgent：brand 合计 4300
    const brand = b.tokens.byAgent.find((a: { key: string }) => a.key === 'brand');
    assert.equal(brand.totalTokens, 4300);
    // byDay：上海日历日键
    const dayMap = new Map(b.tokens.byDay.map((x: { day: string; totalTokens: number }) => [x.day, x.totalTokens]));
    assert.equal(dayMap.get(dateKey(d1)), 4300);
    assert.equal(dayMap.get(dateKey(d2)), 500);
    // 支付脱敏尾 6 位
    assert.equal(b.payments[0].orderNo, '123456');
    assert.equal(b.credits[0].delta, 100);
    assert.equal(b.activations[0].itemKey, 'brand');
    assert.equal(b.plan.status, 'none');
  });

  test('无钱包时 quota = null', async () => {
    const { userId } = await mkTenantUser();
    const r = await api('GET', `/api/admin/users/${userId}/usage`);
    assert.equal(r.status, 200);
    assert.equal(r.body.quota, null);
  });
});

describe('S2 · POST /admin/users/:id/token-quota', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('operator → 403', async () => {
    const { userId } = await mkTenantUser();
    const r = await api('POST', `/api/admin/users/${userId}/token-quota`, { body: { mode: 'set', quota: 100 }, adminToken: await operatorToken() });
    assert.equal(r.status, 403);
  });

  test('reset_to_plan：无套餐 → 400', async () => {
    const { userId } = await mkTenantUser();
    const r = await api('POST', `/api/admin/users/${userId}/token-quota`, { body: { mode: 'reset_to_plan' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'NO_PLAN');
  });

  test('reset_to_plan：正确取套餐额度', async () => {
    const planId = await mkPlan(88888);
    const { userId } = await mkTenantUser({ planId });
    const r = await api('POST', `/api/admin/users/${userId}/token-quota`, { body: { mode: 'reset_to_plan' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = await prisma.tokenWallet.findUnique({ where: { userId } });
    assert.equal(w!.quota, 88888);
    assert.equal(w!.balance, 88888);
  });

  test('set：非法 quota（-2 / 小数）→ 400；成功路径审计落库', async () => {
    const { userId } = await mkTenantUser();
    assert.equal((await api('POST', `/api/admin/users/${userId}/token-quota`, { body: { mode: 'set', quota: -2 } })).status, 400);
    assert.equal((await api('POST', `/api/admin/users/${userId}/token-quota`, { body: { mode: 'set', quota: 1.5 } })).status, 400);
    const ok = await api('POST', `/api/admin/users/${userId}/token-quota`, { body: { mode: 'set', quota: 5000 } });
    assert.equal(ok.status, 200);
    const w = await prisma.tokenWallet.findUnique({ where: { userId } });
    assert.equal(w!.quota, 5000);
    const audit = await prisma.auditLog.findFirst({ where: { userId, action: 'admin.user.quota.set' }, orderBy: { createdAt: 'desc' } });
    assert.ok(audit, '审计落库');
    const payload = audit!.payloadJson as any;
    assert.equal(payload.after.quota, 5000);
    assert.ok(payload.by, 'payload 带操作者 by');
  });

  test('set：-1 表示不限量放行', async () => {
    const { userId } = await mkTenantUser();
    const r = await api('POST', `/api/admin/users/${userId}/token-quota`, { body: { mode: 'set', quota: -1 } });
    assert.equal(r.status, 200);
    const w = await prisma.tokenWallet.findUnique({ where: { userId } });
    assert.equal(w!.quota, -1);
  });
});

describe('S2 · POST /admin/users/:id/credits', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('operator → 403', async () => {
    const { userId } = await mkTenantUser();
    const r = await api('POST', `/api/admin/users/${userId}/credits`, { body: { delta: 10, reason: '补偿' }, adminToken: await operatorToken() });
    assert.equal(r.status, 403);
  });

  test('参数校验：delta=0 / reason 空 / reason 超 50 字 → 400', async () => {
    const { userId } = await mkTenantUser();
    assert.equal((await api('POST', `/api/admin/users/${userId}/credits`, { body: { delta: 0, reason: 'x' } })).status, 400);
    assert.equal((await api('POST', `/api/admin/users/${userId}/credits`, { body: { delta: 5, reason: '' } })).status, 400);
    assert.equal((await api('POST', `/api/admin/users/${userId}/credits`, { body: { delta: 5, reason: 'x'.repeat(51) } })).status, 400);
  });

  test('正 delta 补发：写 CreditLedger(admin: 前缀) + 审计', async () => {
    const { tenantId, userId } = await mkTenantUser();
    await prisma.creditLedger.create({ data: { tenantId, userId, delta: 20, reason: '初始', balance: 20 } });
    const r = await api('POST', `/api/admin/users/${userId}/credits`, { body: { delta: 30, reason: '活动补偿' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.balance, 50);
    const led = await prisma.creditLedger.findFirst({ where: { userId, delta: 30 }, orderBy: { createdAt: 'desc' } });
    assert.equal(led!.reason, 'admin:活动补偿');
    const audit = await prisma.auditLog.findFirst({ where: { userId, action: 'admin.user.credits.adjust' }, orderBy: { createdAt: 'desc' } });
    assert.ok(audit);
  });

  test('负 delta 越界（余额不足）→ 400，不写流水', async () => {
    const { tenantId, userId } = await mkTenantUser();
    await prisma.creditLedger.create({ data: { tenantId, userId, delta: 10, reason: '初始', balance: 10 } });
    const before = await prisma.creditLedger.count({ where: { userId } });
    const r = await api('POST', `/api/admin/users/${userId}/credits`, { body: { delta: -20, reason: '扣减' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'BALANCE_UNDERFLOW');
    assert.equal(await prisma.creditLedger.count({ where: { userId } }), before, '不新增流水');
  });

  test('负 delta 在余额内：成功扣减', async () => {
    const { tenantId, userId } = await mkTenantUser();
    await prisma.creditLedger.create({ data: { tenantId, userId, delta: 40, reason: '初始', balance: 40 } });
    const r = await api('POST', `/api/admin/users/${userId}/credits`, { body: { delta: -15, reason: '误发扣回' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.balance, 25);
  });
});

describe('S2 · POST /admin/users/:id/plan-extend', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('operator → 403', async () => {
    const planId = await mkPlan(1000);
    const { userId } = await mkTenantUser({ planId, planExpiresAt: new Date(Date.now() + 5 * 864e5) });
    const r = await api('POST', `/api/admin/users/${userId}/plan-extend`, { body: { days: 10 }, adminToken: await operatorToken() });
    assert.equal(r.status, 403);
  });

  test('days 越界 → 400', async () => {
    const planId = await mkPlan(1000);
    const { userId } = await mkTenantUser({ planId, planExpiresAt: new Date(Date.now() + 5 * 864e5) });
    assert.equal((await api('POST', `/api/admin/users/${userId}/plan-extend`, { body: { days: 0 } })).status, 400);
    assert.equal((await api('POST', `/api/admin/users/${userId}/plan-extend`, { body: { days: 400 } })).status, 400);
  });

  test('无套餐 → 400', async () => {
    const { userId } = await mkTenantUser();
    const r = await api('POST', `/api/admin/users/${userId}/plan-extend`, { body: { days: 10 } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'NO_PLAN');
  });

  test('成功：planExpiresAt = max(now,现值)+days，只动到期日；审计落库', async () => {
    const planId = await mkPlan(1000);
    const cur = new Date(Date.now() + 5 * 864e5);
    const { userId } = await mkTenantUser({ planId, planActivatedAt: new Date(), planExpiresAt: cur });
    const r = await api('POST', `/api/admin/users/${userId}/plan-extend`, { body: { days: 10 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const u = await prisma.user.findUnique({ where: { id: userId } });
    const expected = cur.getTime() + 10 * 864e5;
    assert.ok(Math.abs(u!.planExpiresAt!.getTime() - expected) < 2000, '在现值基础上加 10 天');
    assert.ok(u!.planId, 'planId 未被清空');
    const audit = await prisma.auditLog.findFirst({ where: { userId, action: 'admin.user.plan.extend' }, orderBy: { createdAt: 'desc' } });
    assert.ok(audit);
    assert.equal((audit!.payloadJson as any).days, 10);
  });
});

describe('S3 · GET /admin/overview 环比口径', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('stats 新形 {t,v,deltaPct,sub}，5 张卡；无前期数据 deltaPct=null；Token 成本卡为元', async () => {
    const { tenantId, userId } = await mkTenantUser();
    await prisma.tokenUsage.create({ data: { tenantId, userId, kind: 'chat', provider: 'claude', model: 'm', totalTokens: 100, costMicros: 1_500_000, createdAt: new Date(Date.now() - 864e5) } });
    const r = await api('GET', '/api/admin/overview');
    assert.equal(r.status, 200);
    const stats = r.body.stats;
    assert.equal(stats.length, 5);
    for (const s of stats) {
      assert.ok(typeof s.t === 'string' && typeof s.v === 'string' && typeof s.sub === 'string');
      assert.ok(s.deltaPct === null || typeof s.deltaPct === 'number');
      assert.equal('trend' in s, false, 'trend 字段已删除');
    }
    const cost = stats.find((s: { t: string }) => s.t === '30 天 Token 成本');
    assert.equal(cost.v, '1.50'); // 1_500_000 微元 = 1.5 元
    const diamond = stats.find((s: { t: string }) => s.t === '钻石消耗');
    assert.ok(diamond, '「钻石消耗」卡存在');
    // 无前期（前 7 天）数据 → deltaPct null
    assert.equal(cost.deltaPct, null);
  });
});

describe('S3 · GET /admin/users 增量字段', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('tokenUsed30d 与 quotaRemaining 正确（-1=不限量，null=无钱包）', async () => {
    const { tenantId, userId } = await mkTenantUser();
    await prisma.tokenUsage.createMany({ data: [
      { tenantId, userId, kind: 'chat', provider: 'claude', model: 'm', totalTokens: 700, costMicros: 0, createdAt: new Date(Date.now() - 864e5) },
      { tenantId, userId, kind: 'chat', provider: 'claude', model: 'm', totalTokens: 300, costMicros: 0, createdAt: new Date(Date.now() - 2 * 864e5) },
    ] });
    await prisma.tokenWallet.create({ data: { tenantId, userId, quota: 5000, balance: 4200, periodKey: 'x' } });
    const { userId: u2 } = await mkTenantUser();
    const { tenantId: t3, userId: u3 } = await mkTenantUser();
    await prisma.tokenWallet.create({ data: { tenantId: t3, userId: u3, quota: -1, balance: -1, periodKey: 'x' } });

    const r = await api('GET', '/api/admin/users');
    assert.equal(r.status, 200);
    const byId = new Map(r.body.map((u: { id: string }) => [u.id, u]));
    assert.equal((byId.get(userId) as any).tokenUsed30d, 1000);
    assert.equal((byId.get(userId) as any).quotaRemaining, 4200);
    assert.equal((byId.get(u2) as any).quotaRemaining, null, '无钱包 → null');
    assert.equal((byId.get(u2) as any).tokenUsed30d, 0);
    assert.equal((byId.get(u3) as any).quotaRemaining, -1, '不限量 → -1');
  });
});

describe('S4 · GET /admin/payments', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('summary（paid 口径）+ items（尾 6 位 + 用户名）+ 状态筛选', async () => {
    const { tenantId, userId } = await mkTenantUser();
    const d1 = new Date(Date.now() - 864e5);
    await prisma.paymentOrder.createMany({ data: [
      { outTradeNo: 'PAY-000000111222', tenantId, userId, planId: '', amount: 9900, status: 'paid', paidAt: d1, attrSource: 'catalog' },
      { outTradeNo: 'PAY-000000333444', tenantId, userId, planId: '', amount: 19900, status: 'applied', paidAt: d1, attrSource: 'prescription' },
      { outTradeNo: 'PAY-000000555666', tenantId, userId, planId: '', amount: 5000, status: 'created', paidAt: null, attrSource: null },
    ] });
    const r = await api('GET', '/api/admin/payments?days=30');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.summary.paidAmount, 9900 + 19900); // created 不计
    assert.equal(r.body.summary.paidCount, 2);
    assert.ok(r.body.summary.byDay.some((x: { day: string; amount: number }) => x.day === dateKey(d1) && x.amount === 29800));
    assert.equal(r.body.items.length, 3);
    assert.ok(r.body.items.every((it: { orderNo: string }) => it.orderNo.length === 6));
    assert.equal(r.body.items[0].userName, 'Ops 用户');
    // 状态筛选 items
    const paidOnly = await api('GET', '/api/admin/payments?status=paid');
    assert.equal(paidOnly.body.items.length, 1);
    assert.equal(paidOnly.body.items[0].status, 'paid');
  });
});
