// V7-04：三势结构化 + 认可判断一键生成军令与报告。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { setQuota } from '../src/services/tokenQuota.js';
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

test('未登录 → 401', async () => {
  const r = await api('POST', '/api/battle/commit', { body: {} });
  assert.equal(r.status, 401);
});
