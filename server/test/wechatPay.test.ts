// 微信支付幂等入账测试：同一订单的成功回调处理多次（含并发），权益只发一次。
// 不触网：直接调 markPaidAndApply（绕过下单/验签），聚焦「恰好一次」入账的并发安全。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { markPaidAndApply } from '../src/services/wechatPay.js';
import { getApp, closeApp, seedBaseline, cleanBusiness } from './helpers.js';

let userId = '', tenantId = '', planId = '', plan2Id = '';

before(async () => {
  await getApp();
  await seedBaseline();
});
after(async () => { await closeApp(); });

beforeEach(async () => {
  await prisma.paymentOrder.deleteMany();
  await cleanBusiness();
  await seedBaseline();
  const tenant = await prisma.tenant.create({ data: { name: 'PayCo' } });
  tenantId = tenant.id;
  const user = await prisma.user.create({ data: { tenantId, phone: '13900000001', name: '付费用户', role: 'owner' } });
  userId = user.id;
  const plans = await prisma.plan.findMany({ orderBy: { sort: 'asc' } });
  planId = plans.find((p) => p.creditsPerMonth > 0)?.id ?? plans[0].id;
  plan2Id = planId;
});

async function makeOrder(outTradeNo: string): Promise<void> {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  await prisma.paymentOrder.create({
    data: { outTradeNo, tenantId, userId, planId, amount: plan!.price, provider: 'wechat', status: 'created' },
  });
}

test('重复成功回调：权益只发一次（流水仅一条）', async () => {
  await makeOrder('ot_dup_1');
  const r1 = await markPaidAndApply({ outTradeNo: 'ot_dup_1', transactionId: 'wx_1', tradeState: 'SUCCESS', rawJson: {} });
  const r2 = await markPaidAndApply({ outTradeNo: 'ot_dup_1', transactionId: 'wx_1', tradeState: 'SUCCESS', rawJson: {} });
  assert.equal(r1.applied, true, '首次应入账');
  assert.equal(r2.applied, false, '重复回调不应再次入账');
  assert.equal(r2.reason, 'already_applied');

  const ledgers = await prisma.creditLedger.count({ where: { userId } });
  assert.equal(ledgers, 1, '钻石流水应只有一条');
  const order = await prisma.paymentOrder.findUnique({ where: { outTradeNo: 'ot_dup_1' } });
  assert.equal(order!.status, 'applied');
});

test('并发成功回调：原子抢占保证只发一次', async () => {
  await makeOrder('ot_race_1');
  const calls = Array.from({ length: 8 }, () =>
    markPaidAndApply({ outTradeNo: 'ot_race_1', transactionId: 'wx_r', tradeState: 'SUCCESS', rawJson: {} }),
  );
  const results = await Promise.all(calls);
  const appliedCount = results.filter((r) => r.applied).length;
  assert.equal(appliedCount, 1, '并发下只有一次真正入账');

  const ledgers = await prisma.creditLedger.count({ where: { userId } });
  assert.equal(ledgers, 1, '并发下钻石流水仍只有一条');
});

test('非成功交易态：不发权益，订单标记 failed', async () => {
  await makeOrder('ot_fail_1');
  const r = await markPaidAndApply({ outTradeNo: 'ot_fail_1', tradeState: 'CLOSED', rawJson: {} });
  assert.equal(r.applied, false);
  const order = await prisma.paymentOrder.findUnique({ where: { outTradeNo: 'ot_fail_1' } });
  assert.equal(order!.status, 'failed');
  assert.equal(await prisma.creditLedger.count({ where: { userId } }), 0);
});

test('未知订单号：安全返回 not_found', async () => {
  const r = await markPaidAndApply({ outTradeNo: 'nope', tradeState: 'SUCCESS', rawJson: {} });
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'order_not_found');
});

test('报文金额与订单不一致：拒绝入账且订单保持原状态（防串单/伪造）', async () => {
  await makeOrder('ot_amt_1');
  const order = await prisma.paymentOrder.findUnique({ where: { outTradeNo: 'ot_amt_1' } });
  const r = await markPaidAndApply({
    outTradeNo: 'ot_amt_1', transactionId: 'wx_amt', tradeState: 'SUCCESS',
    rawJson: { forged: true }, amountTotal: order!.amount + 1,
  });
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'field_mismatch_amount');
  const after = await prisma.paymentOrder.findUnique({ where: { outTradeNo: 'ot_amt_1' } });
  assert.equal(after!.status, 'created', '不一致时不得改变订单状态（不发放也不标 failed）');
  assert.equal(await prisma.creditLedger.count({ where: { userId } }), 0, '不得发放权益');

  // 金额正确的后续回调仍可正常入账（拒绝不留死锁）
  const ok = await markPaidAndApply({ outTradeNo: 'ot_amt_1', transactionId: 'wx_amt', tradeState: 'SUCCESS', rawJson: {}, amountTotal: order!.amount });
  assert.equal(ok.applied, true);
});
