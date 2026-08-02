// 方案权益并发与月度权益回归：不同订单必须按用户串行，续期/同档转年不得刷新当月权益。
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { runWithNow } from '../src/services/clock.js';
import { getBalance } from '../src/services/credits.js';
import { applyPlanPurchase } from '../src/services/purchase.js';
import { chargeQuota, getQuotaState } from '../src/services/tokenQuota.js';
import { markPaidAndApply } from '../src/services/wechatPay.js';
import { cleanBusiness, closeApp, getApp, seedBaseline, uniquePhone } from './helpers.js';

before(async () => { await getApp(); await seedBaseline(); });
after(async () => { await closeApp(); });
beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

async function createBareUser(label: string) {
  const tenant = await prisma.tenant.create({ data: { name: `${label}企业` } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, phone: uniquePhone(), name: label, role: 'owner' },
  });
  return { tenantId: tenant.id, userId: user.id };
}

test('两笔不同套餐订单并发到账：用户级权益锁保证时长累计两期且当月权益只发一次', async () => {
  const { tenantId, userId } = await createBareUser('双单并发');
  const plan = await prisma.plan.findFirstOrThrow({
    where: { planFamilyKey: 'starter', period: 'month' },
  });
  const orders = await Promise.all(['ot_two_orders_a', 'ot_two_orders_b'].map((outTradeNo) =>
    prisma.paymentOrder.create({
      data: { outTradeNo, tenantId, userId, planId: plan.id, amount: plan.price, provider: 'wechat', status: 'created' },
    })));

  const T0 = new Date('2026-01-15T08:00:00Z');
  const results = await runWithNow(T0, () => Promise.all(orders.map((order, i) => markPaidAndApply({
    outTradeNo: order.outTradeNo,
    transactionId: `wx_two_${i}`,
    tradeState: 'SUCCESS',
    rawJson: {},
    amountTotal: plan.price,
  }))));

  assert.equal(results.filter((item) => item.applied).length, 2, '两笔真实付款都必须完成权益入账');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  assert.equal(user.planActivatedAt?.toISOString(), '2026-01-15T08:00:00.000Z');
  assert.equal(user.planExpiresAt?.toISOString(), '2026-03-15T08:00:00.000Z', '两笔月付应累计到两个月，不能互相覆盖');
  assert.equal(await prisma.planEntitlement.count({ where: { userId, status: 'active' } }), 2, '每笔订单各有一条可退款来源');
  assert.equal(await prisma.paymentOrder.count({ where: { userId, status: 'applied' } }), 2);
  assert.equal(await prisma.monthlyCreditGrant.count({ where: { userId } }), 1, '续期不能重复发当前月钻石');
  assert.equal(await getBalance(userId), plan.creditsPerMonth, '当前月钻石只发一次');
  const wallet = await prisma.tokenWallet.findUniqueOrThrow({ where: { userId } });
  assert.equal(wallet.balance, plan.tokenQuotaPerMonth, '当前月 token 钱包只初始化一次');
});

test('续期与同 family 月转年：只调整有效期，不重置已消耗 quota 或重复发钻石', async () => {
  const { tenantId, userId } = await createBareUser('续期权益');
  const monthly = await prisma.plan.findFirstOrThrow({ where: { planFamilyKey: 'decision', period: 'month' } });
  const yearly = await prisma.plan.findFirstOrThrow({ where: { planFamilyKey: 'decision', period: 'year' } });
  assert.equal(monthly.tokenQuotaPerMonth, yearly.tokenQuotaPerMonth, '夹具必须保证同 family 月/年额度一致');
  assert.equal(monthly.creditsPerMonth, yearly.creditsPerMonth, '夹具必须保证同 family 月/年钻石一致');

  await runWithNow(new Date('2026-01-15T00:00:00Z'), () => applyPlanPurchase(
    { id: userId, tenantId }, monthly, { reason: '首购', source: 'test' },
  ));
  await runWithNow(new Date('2026-01-20T00:00:00Z'), () => chargeQuota(userId, 300_000, 1));
  const quotaAfterUse = await runWithNow(new Date('2026-01-20T00:00:00Z'), () => getQuotaState(userId));
  const creditsAfterUse = await getBalance(userId);

  await runWithNow(new Date('2026-01-25T00:00:00Z'), () => applyPlanPurchase(
    { id: userId, tenantId }, monthly, { reason: '月付续期', source: 'test' },
  ));
  assert.deepEqual(
    await runWithNow(new Date('2026-01-25T00:00:00Z'), () => getQuotaState(userId)),
    quotaAfterUse,
    '续期后已用量与余额必须原样保留',
  );
  assert.equal(await getBalance(userId), creditsAfterUse, '续期不得重复发当前月钻石');

  await runWithNow(new Date('2026-01-26T00:00:00Z'), () => applyPlanPurchase(
    { id: userId, tenantId }, yearly, { reason: '同档转年付', source: 'test' },
  ));
  assert.deepEqual(
    await runWithNow(new Date('2026-01-26T00:00:00Z'), () => getQuotaState(userId)),
    quotaAfterUse,
    '同档转年付不得刷新当月 token 钱包',
  );
  assert.equal(await getBalance(userId), creditsAfterUse, '同档转年付不得重复发当前月钻石');
  assert.equal(await prisma.monthlyCreditGrant.count({ where: { userId } }), 1);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  assert.equal(user.planId, yearly.id);
  assert.equal(user.planActivatedAt?.toISOString(), '2026-01-15T00:00:00.000Z', '月度权益锚点必须保持不变');
});
