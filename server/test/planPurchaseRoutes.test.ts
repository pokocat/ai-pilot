// 方案下单接口回归：clientRequestId 幂等与 quoteFingerprint/expectedChargeAmount 一致性。
import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { createJsapiOrder } from '../src/services/wechatPay.js';
import { api, cleanBusiness, closeApp, getApp, seedBaseline, uniquePhone } from './helpers.js';

const savedPayMock = process.env.PAY_MOCK_SUCCESS;

before(async () => { process.env.PAY_MOCK_SUCCESS = 'true'; await getApp(); await seedBaseline(); });
after(async () => {
  if (savedPayMock === undefined) delete process.env.PAY_MOCK_SUCCESS;
  else process.env.PAY_MOCK_SUCCESS = savedPayMock;
  await closeApp();
});
beforeEach(async () => { process.env.PAY_MOCK_SUCCESS = 'true'; await cleanBusiness(); await seedBaseline(); });
afterEach(() => { process.env.PAY_MOCK_SUCCESS = 'true'; });

async function createBareUser(label: string) {
  const tenant = await prisma.tenant.create({ data: { name: `${label}企业` } });
  return prisma.user.create({
    data: { tenantId: tenant.id, phone: uniquePhone(), name: label, role: 'owner' },
  });
}

test('clientRequestId：同用户并发重试只产生并返回同一笔可支付订单', async () => {
  const user = await createBareUser('幂等下单');
  const plan = await prisma.plan.findFirstOrThrow({ where: { planFamilyKey: 'starter', period: 'month' } });
  const body = { clientRequestId: 'intent-concurrent-001' };
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    api('POST', `/api/plans/${plan.id}/order`, { token: user.id, body })));

  assert.equal(results.filter((item) => item.status === 200).length, 8, results.map((item) => `${item.status}:${item.body?.code ?? item.body?.outTradeNo}`).join(', '));
  assert.equal(new Set(results.map((item) => item.body.outTradeNo)).size, 1, '所有重试必须返回同一订单号');
  assert.equal(await prisma.paymentOrder.count({ where: { userId: user.id, clientRequestId: body.clientRequestId } }), 1);
});

test('clientRequestId：换 plan / amount / quoteFingerprint 必须 409 IDEMPOTENCY_CONFLICT', async () => {
  const user = await createBareUser('幂等载荷冲突');
  const starter = await prisma.plan.findFirstOrThrow({ where: { planFamilyKey: 'starter', period: 'month' } });
  const decision = await prisma.plan.findFirstOrThrow({ where: { planFamilyKey: 'decision', period: 'month' } });
  const clientRequestId = 'intent-payload-conflict-001';
  const quote = { quoteFingerprint: 'quote-fingerprint-a', remainingValue: 0, chargeAmount: starter.price, relation: 'available' };
  const base = {
    user: { id: user.id, tenantId: user.tenantId },
    plan: { id: starter.id, name: starter.name, price: starter.price },
    openid: `mockopenid:${user.id}`,
    amount: starter.price,
    clientRequestId,
    quote,
  };

  const created = await createJsapiOrder(base);
  assert.ok(created.outTradeNo);

  const assertConflict = async (call: () => Promise<unknown>, field: string) => {
    await assert.rejects(call, (error: unknown) => {
      const value = error as { code?: string; statusCode?: number };
      assert.equal(value.code, 'IDEMPOTENCY_CONFLICT', `${field} 变化必须返回明确错误码`);
      assert.equal(value.statusCode, 409);
      return true;
    });
  };

  await assertConflict(() => createJsapiOrder({
    ...base,
    plan: { id: decision.id, name: decision.name, price: decision.price },
  }), 'plan');
  await assertConflict(() => createJsapiOrder({ ...base, amount: starter.price + 1 }), 'amount');
  await assertConflict(() => createJsapiOrder({
    ...base,
    quote: { ...quote, quoteFingerprint: 'quote-fingerprint-b' },
  }), 'quoteFingerprint');

  assert.equal(await prisma.paymentOrder.count({ where: { userId: user.id, clientRequestId } }), 1, '冲突重试不得再建单');
});

test('报价一致性：目标价格或预期金额变化均返回 QUOTE_CHANGED，重新报价后才能下单', async () => {
  const user = await createBareUser('报价校验');
  const starter = await prisma.plan.findFirstOrThrow({ where: { planFamilyKey: 'starter', period: 'month' } });
  const target = await prisma.plan.findFirstOrThrow({ where: { planFamilyKey: 'decision', period: 'month' } });

  const first = await api('POST', `/api/plans/${starter.id}/order`, {
    token: user.id, body: { clientRequestId: 'quote-source-order' },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const paid = await api('POST', '/api/pay/mock/pay', { token: user.id, body: { outTradeNo: first.body.outTradeNo } });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.applied, true);

  const quoted = await api('POST', `/api/plans/${target.id}/quote`, { token: user.id, body: {} });
  assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
  assert.equal(quoted.body.relation, 'upgrade');

  await prisma.plan.update({ where: { id: target.id }, data: { price: { increment: 100 } } });
  const changedTerms = await api('POST', `/api/plans/${target.id}/order`, {
    token: user.id,
    body: {
      clientRequestId: 'quote-stale-terms',
      quoteFingerprint: quoted.body.quoteFingerprint,
      expectedChargeAmount: quoted.body.chargeAmount,
    },
  });
  assert.equal(changedTerms.status, 409, JSON.stringify(changedTerms.body));
  assert.equal(changedTerms.body.code, 'QUOTE_CHANGED');
  assert.equal(await prisma.paymentOrder.count({ where: { userId: user.id, planId: target.id } }), 0, '失效报价不得建单');

  const sourceQuoted = await api('POST', `/api/plans/${target.id}/quote`, { token: user.id, body: {} });
  assert.equal(sourceQuoted.status, 200, JSON.stringify(sourceQuoted.body));
  const sourceEntitlement = await prisma.planEntitlement.findFirstOrThrow({
    where: { userId: user.id, planId: starter.id, status: 'active' },
  });
  await prisma.planEntitlement.update({
    where: { id: sourceEntitlement.id },
    data: { creditedAmount: { increment: 1 } },
  });
  const changedSource = await api('POST', `/api/plans/${target.id}/order`, {
    token: user.id,
    body: {
      clientRequestId: 'quote-stale-source',
      quoteFingerprint: sourceQuoted.body.quoteFingerprint,
      expectedChargeAmount: sourceQuoted.body.chargeAmount,
    },
  });
  assert.equal(changedSource.status, 409, JSON.stringify(changedSource.body));
  assert.equal(changedSource.body.code, 'QUOTE_CHANGED', '来源权益版本变化必须强制重新确认');

  const refreshed = await api('POST', `/api/plans/${target.id}/quote`, { token: user.id, body: {} });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  const wrongAmount = await api('POST', `/api/plans/${target.id}/order`, {
    token: user.id,
    body: {
      clientRequestId: 'quote-wrong-amount',
      quoteFingerprint: refreshed.body.quoteFingerprint,
      expectedChargeAmount: refreshed.body.chargeAmount + 1,
    },
  });
  assert.equal(wrongAmount.status, 409, JSON.stringify(wrongAmount.body));
  assert.equal(wrongAmount.body.code, 'QUOTE_CHANGED');

  const valid = await api('POST', `/api/plans/${target.id}/order`, {
    token: user.id,
    body: {
      clientRequestId: 'quote-valid',
      quoteFingerprint: refreshed.body.quoteFingerprint,
      expectedChargeAmount: refreshed.body.chargeAmount,
    },
  });
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
  assert.equal(valid.body.amount, refreshed.body.chargeAmount);
  const order = await prisma.paymentOrder.findUniqueOrThrow({ where: { outTradeNo: valid.body.outTradeNo } });
  assert.equal(order.quoteFingerprint, refreshed.body.quoteFingerprint);
  assert.equal(order.amount, refreshed.body.chargeAmount);
});
