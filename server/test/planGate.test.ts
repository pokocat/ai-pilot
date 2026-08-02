// 商业化禁写闸（2026-07-28 去免费档改版）：无有效套餐的登录用户只读。
//   cd server && node --import tsx --test test/planGate.test.ts
//
// 口径：
//   - 没有免费档了，注册默认不送套餐（除非 TEST_DEFAULT_PLAN_NAME 配置了测试期默认档）
//   - 无套餐 / 套餐到期 → 业务写操作拦 403 PLAN_REQUIRED；GET 不受影响
//   - auth / pay / wechat / admin 前缀放行（注册、购买、平台回调、后台各有各的门）
//   - 无套餐新用户可写入局资料，并且 quickscan 每日 1 次 grace 首判；已过期用户仍禁写
//   - 未带 token 的写请求不在此拦，路由自身 401 兜底
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { api, login, uniquePhone, seedBaseline, cleanBusiness, closeApp, getApp } from './helpers.js';
import { __resetPlanGate, bustPlanGate, hasActivePlan } from '../src/services/planGate.js';

before(async () => { await cleanBusiness(); await seedBaseline(); });
after(async () => { await closeApp(); });
beforeEach(() => __resetPlanGate());

/** 造一个「仅注册」用户：有账号、无套餐（绕过 login 的测试期默认开通）。 */
async function bareUser(): Promise<string> {
  const tenant = await prisma.tenant.create({ data: { name: '' } });
  const u = await prisma.user.create({ data: { tenantId: tenant.id, phone: uniquePhone(), name: '裸注册', role: 'owner' } });
  return u.id; // 测试环境未配 APP_JWT_SECRET 时 token=userId 原样
}

test('测试期默认开通：login 注册即有入门版，写操作放行', async () => {
  const token = await login(uniquePhone(), '测试期用户');
  const r = await api('POST', '/api/projects', { token, body: { name: '新项目' } });
  assert.notEqual(r.status, 403, `不应被禁写闸拦：${JSON.stringify(r.body)}`);
  const u = await prisma.user.findFirst({ where: { id: token }, include: { plan: true } });
  assert.equal(u?.plan?.name, '入门版');
  assert.ok(u?.planExpiresAt, '测试期开通走正式购买链路，必须有到期日');
});

test('无套餐用户：业务写 403 PLAN_REQUIRED，读放行', async () => {
  const id = await bareUser();
  const w = await api('POST', '/api/projects', { token: id, body: { name: 'x' } });
  assert.equal(w.status, 403);
  assert.equal(w.body.code, 'PLAN_REQUIRED');
  const r = await api('GET', '/api/projects', { token: id });
  assert.notEqual(r.status, 403, 'GET 不应被禁写闸拦');
});

test('无套餐新账号：可完成入局建档与每日 1 次首判，其他写能力仍锁定', async () => {
  const id = await bareUser();

  const identity = await api('PUT', '/api/me', { token: id, body: { company: '新品牌' } });
  assert.equal(identity.status, 200, JSON.stringify(identity.body));
  const color = await api('PUT', '/api/me/color', { token: id, body: { color: 'green' } });
  assert.equal(color.status, 200, JSON.stringify(color.body));
  const profile = await api('PUT', '/api/profile', {
    token: id,
    body: { industry: '美业', stage: '100-500 万', pain: '获客越来越贵' },
  });
  assert.equal(profile.status, 200, JSON.stringify(profile.body));

  const first = await api('POST', '/api/quickscan', {
    token: id,
    body: { industry: '美业', revenueBand: '100-500 万', pain: '获客越来越贵' },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.judgement, '首判应返回军师判断');

  const second = await api('POST', '/api/quickscan', {
    token: id,
    body: { industry: '美业', revenueBand: '100-500 万', pain: '复购停滞' },
  });
  assert.equal(second.status, 402, '无套餐用户当日第 2 次首判不应继续免费放行');
  assert.equal(second.body.code, 'INSUFFICIENT_QUOTA');

  const project = await api('POST', '/api/projects', { token: id, body: { name: 'x' } });
  assert.equal(project.status, 403);
  assert.equal(project.body.code, 'PLAN_REQUIRED');
});

test('套餐已到期：同样禁写，但错误码是 PLAN_EXPIRED（前端续费引导依赖它）', async () => {
  const token = await login(uniquePhone(), '过期用户');
  await prisma.user.update({ where: { id: token }, data: { planExpiresAt: new Date(Date.now() - 86400_000) } });
  __resetPlanGate();
  const w = await api('POST', '/api/projects', { token, body: { name: 'x' } });
  assert.equal(w.status, 403);
  assert.equal(w.body.code, 'PLAN_EXPIRED', '到期 ≠ 未开通：不能把续费用户引去「开通」文案');
  const onboardingWrite = await api('PUT', '/api/profile', {
    token,
    body: { industry: '美业', stage: '100-500 万', pain: '获客贵' },
  });
  assert.equal(onboardingWrite.status, 403);
  assert.equal(onboardingWrite.body.code, 'PLAN_EXPIRED', '首次入局例外只属于从未开通的新账号');
});

test('放行前缀：无套餐也能走 auth / pay 写路径（不被 PLAN_REQUIRED 拦）', async () => {
  const id = await bareUser();
  // auth：换绑手机验证码发送（对不对无所谓，只看不是 403 PLAN_REQUIRED）
  const a = await api('POST', '/api/auth/sms/send', { token: id, body: { phone: uniquePhone() } });
  assert.notEqual(a.body?.code, 'PLAN_REQUIRED');
  // pay：创建订单必须永远可达，否则用户没法从只读变付费
  const p = await api('POST', '/api/pay/orders', { token: id, body: {} });
  assert.notEqual(p.body?.code, 'PLAN_REQUIRED');
});

test('未带 token 的写：401 而非 403（闸不抢路由自己的鉴权语义）', async () => {
  const r = await api('POST', '/api/projects', { body: { name: 'x' } });
  assert.equal(r.status, 401);
});

test('缓存与 bust：开通套餐后立即可写', async () => {
  const id = await bareUser();
  assert.equal(await hasActivePlan(id), false);
  const plan = await prisma.plan.findFirstOrThrow({ where: { name: '入门版' } });
  await prisma.user.update({ where: { id }, data: { planId: plan.id } });
  // 30s 缓存内仍是旧值 → bust 后立即翻转
  assert.equal(await hasActivePlan(id), false);
  bustPlanGate(id);
  assert.equal(await hasActivePlan(id), true);
});

test('应急开关 PLAN_WRITE_GATE=false：闸不注册', async (t) => {
  process.env.PLAN_WRITE_GATE = 'false';
  t.after(() => { delete process.env.PLAN_WRITE_GATE; });
  const { buildApp } = await import('../src/app.js');
  const app2 = await buildApp();
  t.after(async () => { await app2.close(); });
  const id = await bareUser();
  const res = await app2.inject({
    method: 'POST', url: '/api/projects',
    headers: { 'content-type': 'application/json', 'x-user-id': id },
    payload: { name: 'x' },
  });
  assert.notEqual(res.statusCode, 403, '开关关掉后无套餐用户不应被拦');
});

test('套餐目录：免费档已移除，第一档为付费入门版', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: '/api/plans' });
  const plans = res.json();
  const list = Array.isArray(plans) ? plans : plans.plans;
  assert.ok(Array.isArray(list), `plans 响应形状：${JSON.stringify(plans).slice(0, 120)}`);
  for (const p of list) {
    assert.notEqual(p.name, '体验版', '免费体验版必须下架');
  }
  const first = list[0];
  assert.equal(first.name, '入门版');
  assert.ok(first.price > 0, '起步就收费');
});
