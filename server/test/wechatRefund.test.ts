// 微信退款状态机：PROCESSING 不撤权益；SUCCESS 只撤对应来源订单并保留其它有效权益。
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { runWithNow } from '../src/services/clock.js';
import { getBalance } from '../src/services/credits.js';
import { generateWechatPayMockKeys } from '../src/services/wechatPayMock.js';
import { markPaidAndApply, markRefundNotified, refundWechatOrder } from '../src/services/wechatPay.js';
import { cleanBusiness, closeApp, getApp, seedBaseline, uniquePhone } from './helpers.js';

const ENV_KEYS = [
  'WECHAT_PAY_BASE', 'WECHAT_MINI_APPID', 'WECHAT_PAY_MCHID', 'WECHAT_PAY_APIV3_KEY',
  'WECHAT_PAY_CERT_SERIAL', 'WECHAT_PAY_PRIVATE_KEY', 'WECHAT_PAY_NOTIFY_URL',
] as const;
const savedEnv: Record<string, string | undefined> = {};

before(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  await getApp();
  await seedBaseline();
});
after(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await closeApp();
});
beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

test('退款 PROCESSING 后 SUCCESS：中间态不撤，成功只撤对应订单来源并保留另一笔续期', async () => {
  const tenant = await prisma.tenant.create({ data: { name: '退款来源企业' } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, phone: uniquePhone(), name: '退款来源用户', role: 'owner' },
  });
  const plan = await prisma.plan.findFirstOrThrow({ where: { planFamilyKey: 'starter', period: 'month' } });
  const orders = [];
  for (const outTradeNo of ['ot_ref_source_a', 'ot_ref_source_b']) {
    const order = await prisma.paymentOrder.create({
      data: { outTradeNo, tenantId: tenant.id, userId: user.id, planId: plan.id, amount: plan.price, provider: 'wechat', status: 'created' },
    });
    orders.push(order);
  }
  await runWithNow(new Date('2026-01-15T08:00:00Z'), async () => {
    for (const [index, order] of orders.entries()) {
      const result = await markPaidAndApply({
        outTradeNo: order.outTradeNo, transactionId: `wx_ref_${index}`, tradeState: 'SUCCESS', rawJson: {}, amountTotal: plan.price,
      });
      assert.equal(result.applied, true);
    }
  });
  const expiresBefore = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).planExpiresAt;
  const creditsBefore = await getBalance(user.id);
  assert.equal(await prisma.planEntitlement.count({ where: { userId: user.id, status: 'active' } }), 2);

  const keys = generateWechatPayMockKeys();
  process.env.WECHAT_PAY_BASE = 'https://refund.test.invalid';
  process.env.WECHAT_MINI_APPID = 'wxrefundtest';
  process.env.WECHAT_PAY_MCHID = '1900009999';
  process.env.WECHAT_PAY_APIV3_KEY = '0123456789abcdef0123456789abcdef';
  process.env.WECHAT_PAY_CERT_SERIAL = keys.merchantSerial;
  process.env.WECHAT_PAY_PRIVATE_KEY = keys.merchantPrivateKeyPem;
  process.env.WECHAT_PAY_NOTIFY_URL = 'https://example.test/api/pay/wechat/notify';

  const originalFetch = globalThis.fetch;
  let sentBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return { ok: true, status: 200, json: async () => ({ refund_id: 'wx_refund_processing_1', status: 'PROCESSING' }) } as Response;
  }) as typeof fetch;
  try {
    const accepted = await refundWechatOrder(orders[0].outTradeNo, { reason: '用户申请', by: 'owner' });
    assert.equal(accepted.wechatStatus, 'PROCESSING');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(sentBody?.notify_url, process.env.WECHAT_PAY_NOTIFY_URL, '退款请求必须显式携带结果通知地址');

  const processing = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: orders[0].id } });
  assert.equal(processing.status, 'applied');
  assert.equal(processing.refundStatus, 'refund_processing');
  assert.equal(processing.refundedAt, null);
  assert.equal(await getBalance(user.id), creditsBefore, 'PROCESSING 不得追回钻石');
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).planExpiresAt?.toISOString(), expiresBefore?.toISOString(), 'PROCESSING 不得缩短权益');
  assert.equal(await prisma.planEntitlement.count({ where: { userId: user.id, status: 'active' } }), 2);

  await runWithNow(new Date('2026-01-20T08:00:00Z'), () => markRefundNotified({
    out_trade_no: orders[0].outTradeNo,
    refund_status: 'SUCCESS',
    refund_id: 'wx_refund_success_1',
    out_refund_no: 'rf_ref_source_a',
    amount: { refund: plan.price, total: plan.price, payer_refund: plan.price },
  }));

  const refunded = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: orders[0].id } });
  const untouched = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: orders[1].id } });
  assert.equal(refunded.status, 'refunded');
  assert.equal(refunded.refundStatus, 'refunded');
  assert.ok(refunded.refundedAt);
  assert.equal(untouched.status, 'applied', '另一笔订单必须保持已入账');
  assert.equal(await prisma.planEntitlement.count({ where: { sourceOrderId: orders[0].id, status: 'refunded' } }), 1);
  assert.equal(await prisma.planEntitlement.count({ where: { sourceOrderId: orders[1].id, status: 'active' } }), 1, '只撤退款来源，续期来源仍有效');
  const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(userAfter.planId, plan.id, '仍有未退款来源时套餐不能整体失效');
  assert.equal(userAfter.planExpiresAt?.toISOString(), expiresBefore?.toISOString(), '保留未退款续期带来的最终到期日');

  await markRefundNotified({
    out_trade_no: orders[0].outTradeNo,
    refund_status: 'SUCCESS',
    refund_id: 'wx_refund_success_1',
    amount: { refund: plan.price, total: plan.price, payer_refund: plan.price },
  });
  assert.equal(await prisma.planEntitlement.count({ where: { sourceOrderId: orders[0].id, status: 'refunded' } }), 1, '重复 SUCCESS 通知必须幂等');
});

test('退款 CLOSED / ABNORMAL：只推进退款状态，不写 refundedAt、不撤权益', async () => {
  const tenant = await prisma.tenant.create({ data: { name: '退款非成功态企业' } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, phone: uniquePhone(), name: '退款非成功态用户', role: 'owner' },
  });
  const plan = await prisma.plan.findFirstOrThrow({ where: { planFamilyKey: 'starter', period: 'month' } });
  const order = await prisma.paymentOrder.create({
    data: { outTradeNo: 'ot_ref_non_success', tenantId: tenant.id, userId: user.id, planId: plan.id, amount: plan.price, provider: 'wechat', status: 'created' },
  });
  assert.equal((await markPaidAndApply({
    outTradeNo: order.outTradeNo, transactionId: 'wx_ref_non_success', tradeState: 'SUCCESS', rawJson: {}, amountTotal: plan.price,
  })).applied, true);
  const expiresAt = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).planExpiresAt;

  for (const [remote, local] of [['CLOSED', 'refund_closed'], ['ABNORMAL', 'refund_abnormal']] as const) {
    await markRefundNotified({
      out_trade_no: order.outTradeNo, refund_status: remote, refund_id: `wx_${remote.toLowerCase()}`,
      amount: { refund: plan.price, total: plan.price, payer_refund: plan.price },
    });
    const current = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(current.status, 'applied');
    assert.equal(current.refundStatus, local);
    assert.equal(current.refundedAt, null);
    assert.equal(await prisma.planEntitlement.count({ where: { sourceOrderId: order.id, status: 'active' } }), 1);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).planExpiresAt?.toISOString(), expiresAt?.toISOString());
  }
});

test('重复购买同一模块：退款一单只撤该来源，最后一份来源退款后才停用模块', async () => {
  const tenant = await prisma.tenant.create({ data: { name: '模块退款来源企业' } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, phone: uniquePhone(), name: '模块退款用户', role: 'owner' },
  });
  const sku = await prisma.sku.findFirstOrThrow({ where: { kind: 'module', grantsModuleKey: { not: null } } });
  const orders = [];
  for (const outTradeNo of ['ot_sku_ref_a', 'ot_sku_ref_b']) {
    const order = await prisma.paymentOrder.create({
      data: {
        outTradeNo, tenantId: tenant.id, userId: user.id, skuKey: sku.key,
        amount: sku.priceFen, provider: 'wechat', status: 'created',
      },
    });
    orders.push(order);
    const applied = await markPaidAndApply({
      outTradeNo, transactionId: `wx_${outTradeNo}`, tradeState: 'SUCCESS', rawJson: {}, amountTotal: sku.priceFen,
    });
    assert.equal(applied.applied, true);
  }
  assert.equal(await prisma.skuEntitlement.count({ where: { userId: user.id, status: 'active' } }), 2);
  assert.equal((await prisma.userModule.findUniqueOrThrow({
    where: { userId_moduleKey: { userId: user.id, moduleKey: sku.grantsModuleKey! } },
  })).enabled, true);

  await markRefundNotified({
    out_trade_no: orders[0].outTradeNo,
    refund_status: 'SUCCESS',
    refund_id: 'wx_sku_refund_a',
    amount: { refund: sku.priceFen, total: sku.priceFen, payer_refund: sku.priceFen },
  });
  assert.equal(await prisma.skuEntitlement.count({ where: { sourceOrderId: orders[0].id, status: 'refunded' } }), 1);
  assert.equal(await prisma.skuEntitlement.count({ where: { sourceOrderId: orders[1].id, status: 'active' } }), 1);
  assert.equal((await prisma.userModule.findUniqueOrThrow({
    where: { userId_moduleKey: { userId: user.id, moduleKey: sku.grantsModuleKey! } },
  })).enabled, true, '仍有一份未退款来源时模块必须继续可用');

  await markRefundNotified({
    out_trade_no: orders[1].outTradeNo,
    refund_status: 'SUCCESS',
    refund_id: 'wx_sku_refund_b',
    amount: { refund: sku.priceFen, total: sku.priceFen, payer_refund: sku.priceFen },
  });
  assert.equal(await prisma.skuEntitlement.count({ where: { userId: user.id, status: 'active' } }), 0);
  assert.equal((await prisma.userModule.findUniqueOrThrow({
    where: { userId_moduleKey: { userId: user.id, moduleKey: sku.grantsModuleKey! } },
  })).enabled, false, '最后一份来源退款后才停用模块');
});
