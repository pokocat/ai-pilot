// 挂牌价 / 优惠价 / 生效时间（2026-08-08）。
//
// 这组用例钉住的核心事实只有一条：**用户看到几折，就必须按几折扣钱**。
// 折扣是纯展示、扣款读另一个字段，是这类需求最典型的翻车方式——所以除了折扣率算法，
// 下面把报价（quote）、下单金额（PaymentOrder.amount）、权益账本快照（PlanEntitlement.listPrice）
// 和委托代扣授权额（SubscriptionContract.renewalAmount）逐个对到同一个成交价上。
//
// 另一半是护栏：优惠只允许配在正价档、必须真的低于挂牌价，否则 `price<=0`（免费层不设到期）
// 与 `price<0`（面议档禁止自助购买）这些语义会被优惠悄悄翻转。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { api, cleanBusiness, closeApp, getApp, seedBaseline, uniquePhone } from './helpers.js';
import { discountLabel, discountRate, effectivePrice, planPromotion, promoActive, withEffectivePrice } from '../src/services/planPricing.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

const savedPayMock = process.env.PAY_MOCK_SUCCESS;
before(async () => { process.env.PAY_MOCK_SUCCESS = 'true'; await getApp(); await seedBaseline(); });
after(async () => {
  if (savedPayMock === undefined) delete process.env.PAY_MOCK_SUCCESS;
  else process.env.PAY_MOCK_SUCCESS = savedPayMock;
  await cleanBusiness();
  await closeApp();
});

const LIST_FEN = 3_980_000; // ¥39800/年 挂牌价
const PROMO_FEN = 398_000; // ¥3980 优惠价 → 1 折

/** 一档带优惠的年付套餐（挂牌 ¥39800、优惠 ¥3980，长期有效）。 */
async function promoPlan(overrides: Record<string, unknown> = {}) {
  return prisma.plan.create({
    data: {
      name: `优惠档-${Math.random().toString(36).slice(2, 8)}`, price: LIST_FEN, period: 'year',
      planFamilyKey: `promo-${Math.random().toString(36).slice(2, 8)}`, tierRank: 900,
      usageLevel: 'custom', usageLabel: '专属用量',
      creditsPerMonth: 200, tokenQuotaPerMonth: 20_000_000, agentCount: 12, featuresJson: [],
      promoPrice: PROMO_FEN, sort: 900, ...overrides,
    },
  });
}

async function bareUser(label: string) {
  const tenant = await prisma.tenant.create({ data: { name: `${label}企业` } });
  return prisma.user.create({ data: { tenantId: tenant.id, phone: uniquePhone(), name: label, role: 'owner' } });
}

describe('折扣费率：服务端一次算准', () => {
  test('¥39800 挂牌 / ¥3980 优惠 = 1 折，立省 ¥35820', () => {
    const promo = planPromotion({ price: LIST_FEN, promoPrice: PROMO_FEN, promoLabel: ' 首发价 ' });
    assert.ok(promo);
    assert.equal(promo.listPrice, LIST_FEN);
    assert.equal(promo.price, PROMO_FEN);
    assert.equal(promo.savedFen, 3_582_000);
    assert.equal(promo.discountRate, 1);
    assert.equal(promo.discountLabel, '1折');
    assert.equal(promo.label, '首发价', '活动名去掉首尾空格再下发');
    assert.equal(promo.endsAt, null, '未配结束时间 = 长期有效');
  });

  test('折扣率保留一位小数；折得太浅不写成「10折」；极深折扣下限 0.1 折', () => {
    assert.equal(discountRate(8_500, 10_000), 8.5);
    assert.equal(discountLabel(8_500, 10_000), '8.5折');
    assert.equal(discountLabel(9_990, 10_000), '限时优惠', '四舍五入到 10 折时不写死数字');
    assert.equal(discountLabel(1, LIST_FEN), '0.1折', '¥0.01 测试档不能显示成「0折」');
  });

  test('优惠价 ≥ 挂牌价、面议档、免费档一律不生效（读侧兜底，不依赖写入口校验）', () => {
    assert.equal(promoActive({ price: 10_000, promoPrice: 10_000 }), false);
    assert.equal(promoActive({ price: 10_000, promoPrice: 0 }), false, '0 分会把付费档变成免费档语义');
    assert.equal(promoActive({ price: -1, promoPrice: 100 }), false, '面议档：优惠会让它变成可自助购买');
    assert.equal(promoActive({ price: 0, promoPrice: 100 }), false);
    assert.equal(effectivePrice({ price: -1, promoPrice: 100 }), -1, '生效价保持负数，面议语义不被翻转');
  });
});

describe('生效时间窗', () => {
  const plan = { price: LIST_FEN, promoPrice: PROMO_FEN, promoStartsAt: new Date('2026-09-01T00:00:00Z'), promoEndsAt: new Date('2026-10-01T00:00:00Z') };

  test('未到生效时间按挂牌价；窗口内按优惠价；到点自动回挂牌价（无需人工操作）', () => {
    assert.equal(effectivePrice(plan, new Date('2026-08-31T23:59:59Z')), LIST_FEN);
    assert.equal(effectivePrice(plan, new Date('2026-09-15T00:00:00Z')), PROMO_FEN);
    assert.equal(effectivePrice(plan, new Date('2026-10-01T00:00:00Z')), LIST_FEN, '结束时刻当刻即失效（左闭右开）');
    assert.equal(planPromotion(plan, new Date('2026-10-02T00:00:00Z')), null);
  });

  test('withEffectivePrice 幂等：重复解析不会把已生效的优惠抹回原价', () => {
    const once = withEffectivePrice({ id: 'p', period: 'year', ...plan }, new Date('2026-09-15T00:00:00Z'));
    const twice = withEffectivePrice(once, new Date('2026-09-15T00:00:00Z'));
    assert.equal(twice.price, PROMO_FEN);
    assert.equal(twice.listPrice, LIST_FEN);
    assert.ok(twice.promotion);
  });

  test('withEffectivePrice 固化 tierRank：优惠开停不会让同一档的商业档位跳变', () => {
    // tierRank 为空的存量档会回退到 price 排档位；不固化的话，优惠一开档位就掉下去，
    // 升级会被判成降档而拦住用户下单。
    const legacy = { id: 'legacy', period: 'year', price: LIST_FEN, promoPrice: PROMO_FEN, tierRank: null };
    assert.equal(withEffectivePrice(legacy, new Date()).tierRank, LIST_FEN);
  });
});

describe('用户侧：看到几折就扣几折的钱', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('GET /plans：price 是成交价，挂牌价只出现在 promotion.listPrice', async () => {
    const plan = await promoPlan();
    const r = await api('GET', '/api/plans');
    const view = (r.body as { id: string; price: number; promotion: { listPrice: number; discountLabel: string } | null }[]).find((p) => p.id === plan.id);
    assert.ok(view);
    assert.equal(view.price, PROMO_FEN, '端上直接渲染 price，这里给挂牌价就会「显示 ¥39800、实扣 ¥3980」');
    assert.equal(view.promotion?.listPrice, LIST_FEN);
    assert.equal(view.promotion?.discountLabel, '1折');
  });

  test('报价与下单：fullPrice / 订单金额都按优惠价，且订单快照落的是成交价', async () => {
    const plan = await promoPlan();
    const user = await bareUser('优惠下单');

    const quote = await api('POST', `/api/plans/${plan.id}/quote`, { token: user.id, body: {} });
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    assert.equal(quote.body.fullPrice, PROMO_FEN, '报价的「方案价格」就是用户要付的钱');
    assert.equal(quote.body.chargeAmount, PROMO_FEN);
    assert.equal(quote.body.targetPlan.promotion.listPrice, LIST_FEN, '划线原价随报价一起下发');

    const order = await api('POST', `/api/plans/${plan.id}/order`, { token: user.id, body: {} });
    assert.equal(order.status, 200, JSON.stringify(order.body));
    assert.equal(order.body.amount, PROMO_FEN);
    const row = await prisma.paymentOrder.findUniqueOrThrow({ where: { outTradeNo: order.body.outTradeNo } });
    assert.equal(row.amount, PROMO_FEN, '真正提交给微信的金额');
  });

  test('权益账本快照记成交价，不记挂牌价（否则 ¥3980 买的档能抵掉 ¥39800）', async () => {
    const plan = await promoPlan();
    const user = await bareUser('优惠账本');
    const order = await api('POST', `/api/plans/${plan.id}/order`, { token: user.id, body: {} });
    const paid = await api('POST', '/api/pay/mock/pay', { token: user.id, body: { outTradeNo: order.body.outTradeNo } });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));

    const entitlement = await prisma.planEntitlement.findFirstOrThrow({ where: { userId: user.id, planId: plan.id } });
    assert.equal(entitlement.listPrice, PROMO_FEN);
    assert.equal(entitlement.paidAmount, PROMO_FEN);
  });

  test('优惠结束后即刻回到挂牌价：同一个档的报价从 ¥3980 变回 ¥39800', async () => {
    const plan = await promoPlan({ promoEndsAt: new Date(Date.now() - 60_000) });
    const user = await bareUser('优惠已过期');
    const quote = await api('POST', `/api/plans/${plan.id}/quote`, { token: user.id, body: {} });
    assert.equal(quote.body.fullPrice, LIST_FEN);
    assert.equal(quote.body.targetPlan.promotion, null, '过期后不再展示折扣角标');
  });
});

describe('运营后台：挂牌价 / 优惠价 / 生效时间可配', () => {
  const BASE = {
    name: '后台优惠档', price: LIST_FEN, period: 'year',
    planFamilyKey: 'admin-promo', tierRank: 950, usageLevel: 'custom', usageLabel: '专属用量',
    creditsPerMonth: 200, tokenQuotaPerMonth: 20_000_000, agentCount: 12, featuresJson: [],
  };
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); await prisma.plan.deleteMany({ where: { name: { contains: '后台优惠档' } } }); });

  test('建档即可带优惠：返回体同时给出挂牌价、成交价与用户侧折扣文案', async () => {
    const r = await api('POST', '/api/admin/plans', { body: { ...BASE, promoPrice: PROMO_FEN, promoLabel: '首发价' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.price, LIST_FEN, '后台这一栏是挂牌价（也是回写字段）');
    assert.equal(r.body.promoPrice, PROMO_FEN);
    assert.equal(r.body.effectivePrice, PROMO_FEN);
    assert.equal(r.body.promoActive, true);
    assert.equal(r.body.promotion.discountLabel, '1折', '后台能直接核对小程序上显示几折');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'admin.plan.create' }, orderBy: { createdAt: 'desc' } });
    assert.equal((audit!.payloadJson as { promoPrice?: number }).promoPrice, PROMO_FEN, '改价同级风险，优惠必须留痕');
  });

  test('预配未来生效：现在仍按挂牌价卖，到点自动切换', async () => {
    const starts = new Date(Date.now() + 86_400_000);
    const r = await api('POST', '/api/admin/plans', { body: { ...BASE, promoPrice: PROMO_FEN, promoStartsAt: starts.toISOString() } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.promoActive, false);
    assert.equal(r.body.effectivePrice, LIST_FEN);
    assert.equal(r.body.promotion, null);
    const list = await api('GET', '/api/plans');
    assert.equal((list.body as { id: string; price: number }[]).find((p) => p.id === r.body.id)?.price, LIST_FEN);
  });

  test('护栏：优惠价不低于挂牌价 400、面议档不能配优惠 400、结束早于生效 400', async () => {
    const tooHigh = await api('POST', '/api/admin/plans', { body: { ...BASE, name: '后台优惠档-高', promoPrice: LIST_FEN } });
    assert.equal(tooHigh.status, 400);
    assert.equal(tooHigh.body.code, 'PLAN_PROMO_PRICE_INVALID');

    const enterprise = await api('POST', '/api/admin/plans', { body: { ...BASE, name: '后台优惠档-面议', price: -1, promoPrice: 100 } });
    assert.equal(enterprise.status, 400);
    assert.equal(enterprise.body.code, 'PLAN_PROMO_UNSUPPORTED');

    const badWindow = await api('POST', '/api/admin/plans', { body: {
      ...BASE, name: '后台优惠档-窗口', promoPrice: PROMO_FEN,
      promoStartsAt: '2026-10-01T00:00:00Z', promoEndsAt: '2026-09-01T00:00:00Z',
    } });
    assert.equal(badWindow.status, 400);
    assert.equal(badWindow.body.code, 'PLAN_PROMO_WINDOW_INVALID');

    const badDate = await api('POST', '/api/admin/plans', { body: { ...BASE, name: '后台优惠档-日期', promoPrice: PROMO_FEN, promoEndsAt: '明年双十一' } });
    assert.equal(badDate.status, 400);
    assert.equal(badDate.body.code, 'PLAN_PROMO_WINDOW_INVALID', '非法时间要报错，不能静默落 null 变成长期优惠');

    assert.equal(await prisma.plan.count({ where: { name: { contains: '后台优惠档-' } } }), 0, '被拦下的建档不得落库');
  });

  test('PATCH：显式传 null 取消优惠；不传则保持不变', async () => {
    const created = await api('POST', '/api/admin/plans', { body: { ...BASE, promoPrice: PROMO_FEN, promoEndsAt: '2026-12-31T15:59:59Z' } });
    const renamed = await api('PATCH', `/api/admin/plans/${created.body.id}`, { body: { name: '后台优惠档改名' } });
    assert.equal(renamed.body.promoPrice, PROMO_FEN, '只改名不该把优惠冲掉');

    const cleared = await api('PATCH', `/api/admin/plans/${created.body.id}`, { body: { promoPrice: null } });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.promoPrice, null);
    assert.equal(cleared.body.effectivePrice, LIST_FEN);
    assert.equal(cleared.body.promotion, null);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'admin.plan.update' }, orderBy: { createdAt: 'desc' } });
    const payload = audit!.payloadJson as { before?: { promoPrice?: number | null }; after?: { promoPrice?: number | null } };
    assert.equal(payload.before?.promoPrice, PROMO_FEN, '审计要能回答「谁在什么时候撤了优惠」');
    assert.equal(payload.after?.promoPrice, null);
  });

  test('改挂牌价后优惠价若不再低于挂牌价 → 400，不会留下一个「负折扣」的档', async () => {
    const created = await api('POST', '/api/admin/plans', { body: { ...BASE, promoPrice: PROMO_FEN } });
    const r = await api('PATCH', `/api/admin/plans/${created.body.id}`, { body: { price: 100_000 } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'PLAN_PROMO_PRICE_INVALID');
    assert.equal((await prisma.plan.findUniqueOrThrow({ where: { id: created.body.id } })).price, LIST_FEN, '被拦下的改价不得落库');
  });
});
