// V7-04：三势结构化 + 认可判断一键生成军令与报告。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { setQuota } from '../src/services/tokenQuota.js';
import { buildForcesContext } from '../src/services/forces.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.js';

let token = '', userId = '', tenantId = '';

before(async () => { await getApp(); });
after(async () => { await closeApp(); });

beforeEach(async () => {
  await cleanBusiness();
  await seedBaseline();
  token = await login(uniquePhone(), '战局用户');
  userId = token;
  const u = await prisma.user.findUnique({ where: { id: userId } });
  tenantId = u!.tenantId;
  await setQuota(tenantId, userId, 1_000_000);
  // P0-3：三势研判需有可研判的现状（非零档案），否则 generateForces 拒绝生成。给个行业即可满足 ctxLines。
  await prisma.tenant.update({ where: { id: tenantId }, data: { industry: '美业' } });
});

test('POST /forces/refresh 生成三势并落库，strength 走 level 映射区间', async () => {
  const r = await api('POST', '/api/forces/refresh', { token, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.forces.length, 3);
  const kinds = r.body.forces.map((f: { kind: string }) => f.kind).sort();
  assert.deepEqual(kinds, ['market', 'people', 'sky']);
  for (const f of r.body.forces) {
    assert.ok([75, 45, 35].includes(f.strength), 'strength 为 level 映射值');
    assert.ok(['strong', 'mid', 'weak'].includes(f.level));
  }
});

test('/me.understanding 带出结构化三势', async () => {
  await api('POST', '/api/forces/refresh', { token, body: {} });
  const me = await api('GET', '/api/me', { token });
  assert.equal(me.status, 200);
  assert.ok(Array.isArray(me.body.understanding.battleForces));
  assert.equal(me.body.understanding.battleForces.length, 3);
});

test('/forces/refresh 每日限频 3 次 → 第 4 次 429', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await api('POST', '/api/forces/refresh', { token, body: {} });
    assert.equal(r.status, 200, `第 ${i + 1} 次应成功`);
  }
  const fourth = await api('POST', '/api/forces/refresh', { token, body: {} });
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.code, 'FORCES_RATE_LIMIT');
});

test('POST /battle/commit → 案卷 + 军令 + 报告四处落库，二次幂等', async () => {
  const r = await api('POST', '/api/battle/commit', { token, body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.reportId, '返回 reportId');
  assert.equal(r.body.alreadyDone, false);

  // 案卷已建
  const cf = await api('GET', '/api/casefile', { token });
  assert.ok(cf.body.casefile, '案卷已生成');
  // 报告已落库
  const reports = await api('GET', '/api/reports', { token });
  assert.ok(reports.body.some((x: { id: string }) => x.id === r.body.reportId), '报告桥接落库');

  // 二次 commit 幂等（5 分钟内返回上次结果）
  const again = await api('POST', '/api/battle/commit', { token, body: {} });
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyDone, true, '二次 commit 幂等');
  assert.equal(again.body.reportId, r.body.reportId);
});

test('P0-3 零档案 → 不生成不落库、返回空三势（前端走空态引导卡）', async () => {
  // 该用户无任何行业/矛盾/定位/阶段/案卷 → ctxLines 空 → generateForces 返回 null。
  await prisma.tenant.update({ where: { id: tenantId }, data: { industry: null } });
  const r = await api('POST', '/api/forces/refresh', { token, body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.forces, [], '零档案不臆造三势');
  // 未落库：/me.understanding 无三势
  const me = await api('GET', '/api/me', { token });
  assert.ok(!me.body.understanding.battleForces?.length, '零档案不落 forcesJson');
});

test('P0-3 生产 LLM 失败 → 不落库捏造默认（仅 test/mock 才兜底 DEFAULT_FORCES）', async () => {
  // 关掉「测试即 mock」→ isAiTestMode()=false（模拟生产判定）；无真实 provider → structured() 返回 null → 不落库。
  const prev = process.env.AI_ALLOW_REAL_PROVIDER;
  process.env.AI_ALLOW_REAL_PROVIDER = '1';
  try {
    const r = await api('POST', '/api/forces/refresh', { token, body: {} }); // 有行业档案，但 LLM 失败
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.forces, [], '生产 LLM 失败不落捏造默认');
    const sp = await prisma.strategicProfile.findUnique({ where: { userId } });
    const battle = (sp?.forcesJson as { battle?: unknown[] } | null)?.battle;
    assert.ok(!battle?.length, 'forcesJson.battle 未被写入 DEFAULT_FORCES');
  } finally {
    if (prev === undefined) delete process.env.AI_ALLOW_REAL_PROVIDER;
    else process.env.AI_ALLOW_REAL_PROVIDER = prev;
  }
});

test('天势接命盘：录入生辰后三势研判上下文含命盘天时行', async () => {
  // 录入生辰（believe 默认 true）→ 排盘落库。
  const r = await api('PUT', '/api/profile/bazi', { token, body: { calendar: 'solar', year: 1988, month: 3, day: 15, hour: 10, gender: 'male' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ctx = await buildForcesContext({ tenantId, userId });
  assert.ok(ctx.includes('命盘：'), '有命盘时上下文含命盘行');
  assert.ok(ctx.includes('逐月攻守'), '有命盘时上下文含逐月攻守概览');
});

test('命理关（believe=false）：三势研判上下文不注入命盘', async () => {
  await api('PUT', '/api/profile/bazi', { token, body: { believe: false } });
  const ctx = await buildForcesContext({ tenantId, userId });
  assert.ok(ctx.length > 0, '仍有行业等业务现状可研判');
  assert.ok(!ctx.includes('命盘'), '命理关时不注入命盘');
});

test('未登录 → 401', async () => {
  const r = await api('POST', '/api/battle/commit', { body: {} });
  assert.equal(r.status, 401);
});
