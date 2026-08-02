// 隐藏套餐（Plan.hidden + TEST_PLAN_PHONES 白名单）：生产 ¥0.01 支付链路验证专用档的可见性与可购性。
// 规则（routes/plans.ts）：
//   ① /plans 列表：匿名与非白名单不返回 hidden 套餐；白名单手机号返回；
//   ② /plans/:id/order 与 /plans/:id/purchase：非白名单对 hidden 档一律 404（不泄露存在性）；
//   ③ 白名单账号即使持有未到期付费套餐，购买 hidden 档也绕过降级守卫（否则恒 409 测不了）。
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.js';

let hiddenPlanId = '';
let paidPlanId = '';
const savedPhones = process.env.TEST_PLAN_PHONES;

before(async () => {
  await getApp();
  await seedBaseline();
});
after(async () => { await closeApp(); });

beforeEach(async () => {
  await prisma.paymentOrder.deleteMany();
  await cleanBusiness();
  await seedBaseline();
  // 取月付档里最贵的做「当前持有」：换购更便宜档位是降级，守卫必拦——对照断言要的就是这个方向
  // （反向选便宜档会变成升级折算路径，守卫本来就放行，对照失效）。
  const paid = await prisma.plan.findFirst({ where: { price: { gt: 0 }, hidden: false, period: 'month' }, orderBy: { price: 'desc' } });
  paidPlanId = paid!.id;
  const hidden = await prisma.plan.create({
    data: {
      name: '支付链路测试（用例）', price: 1, period: 'month', creditsPerMonth: 1,
      tokenQuotaPerMonth: 10000, agentCount: 1, featuresJson: ['内部'], hidden: true, sort: 99,
    },
  });
  hiddenPlanId = hidden.id;
});
afterEach(() => {
  if (savedPhones === undefined) delete process.env.TEST_PLAN_PHONES; else process.env.TEST_PLAN_PHONES = savedPhones;
});

test('列表：匿名与非白名单看不到隐藏套餐；白名单手机号能看到', async () => {
  const phone = uniquePhone();
  process.env.TEST_PLAN_PHONES = `13000000000, ${phone}`;
  const token = await login(phone, '链路测试员');

  const anon = await api('GET', '/api/plans');
  assert.equal(anon.status, 200);
  assert.ok(!anon.body.some((p: any) => p.id === hiddenPlanId), '匿名请求不应看到隐藏套餐');

  const outsiderToken = await login(uniquePhone(), '路人');
  const outsider = await api('GET', '/api/plans', { token: outsiderToken });
  assert.ok(!outsider.body.some((p: any) => p.id === hiddenPlanId), '非白名单用户不应看到隐藏套餐');

  const insider = await api('GET', '/api/plans', { token });
  assert.ok(insider.body.some((p: any) => p.id === hiddenPlanId), '白名单用户应看到隐藏套餐');
});

test('列表：过期/伪造 token 按匿名处理返回 200，不因隐藏档判定变 401', async () => {
  process.env.TEST_PLAN_PHONES = '13000000000';
  const r = await api('GET', '/api/plans', { token: 'not-a-real-token' });
  assert.equal(r.status, 200);
  assert.ok(!r.body.some((p: any) => p.id === hiddenPlanId));
});

test('下单/演示购买：非白名单对隐藏套餐一律 404，不泄露存在性', async () => {
  process.env.TEST_PLAN_PHONES = '';
  const token = await login(uniquePhone(), '路人');
  const order = await api('POST', `/api/plans/${hiddenPlanId}/order`, { token, body: { openid: 'o_hidden_1' } });
  assert.equal(order.status, 404);
  assert.equal(order.body.code, 'PLAN_NOT_FOUND');
  const purchase = await api('POST', `/api/plans/${hiddenPlanId}/purchase`, { token });
  assert.equal(purchase.status, 404);
  assert.equal(purchase.body.code, 'PLAN_NOT_FOUND');
});

test('用户态 options：白名单隐藏支付档始终是 available/buy，不被当前高档套餐判成降档', async () => {
  const phone = uniquePhone();
  process.env.TEST_PLAN_PHONES = phone;
  const token = await login(phone, '链路测试员');
  await prisma.user.update({
    where: { id: token },
    data: {
      planId: paidPlanId,
      planActivatedAt: new Date(),
      planExpiresAt: new Date(Date.now() + 20 * 24 * 3600 * 1000),
    },
  });

  const response = await api('GET', '/api/plans/options', { token });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const option = response.body.options.find((item: any) => item.plan.id === hiddenPlanId);
  assert.ok(option, '白名单用户的 options 必须包含隐藏支付验证档');
  assert.equal(option.relation, 'available');
  assert.equal(option.action, 'buy');
  assert.equal(option.canPurchase, true);
});

test('白名单 + 持有未到期付费套餐：购买隐藏档绕过降级守卫（PAY_MOCK_SUCCESS 链路下单成功）', async (t) => {
  const phone = uniquePhone();
  process.env.TEST_PLAN_PHONES = phone;
  process.env.PAY_MOCK_SUCCESS = 'true';
  t.after(() => { delete process.env.PAY_MOCK_SUCCESS; });
  const token = await login(phone, '链路测试员');
  // 给账号挂一个未到期付费套餐（模拟测试期默认档）：常规档位切换会被降级守卫 409。
  await prisma.user.update({
    where: { id: token },
    data: { planId: paidPlanId, planExpiresAt: new Date(Date.now() + 20 * 24 * 3600 * 1000) },
  });
  // 对照：换购更便宜的常规套餐（降级）仍被守卫拦住（确认守卫本身没被本改动放松）。
  const cheaper = await prisma.plan.findFirst({
    where: { price: { gt: 0 }, hidden: false, id: { not: paidPlanId }, period: 'month' }, orderBy: { price: 'asc' },
  });
  if (cheaper) {
    const blocked = await api('POST', `/api/plans/${cheaper.id}/order`, { token, body: { openid: 'o_hidden_2' } });
    assert.equal(blocked.status, 409, '常规套餐降级切换应仍被守卫拦截');
  }
  const r = await api('POST', `/api/plans/${hiddenPlanId}/order`, { token, body: { openid: 'o_hidden_2' } });
  assert.equal(r.status, 200, `隐藏档下单应绕过降级守卫：${JSON.stringify(r.body)}`);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.amount, 1, '应付金额应为 1 分');
});
