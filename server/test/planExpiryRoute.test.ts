// 过期只读锁定的 HTTP 端到端门禁：到期用户 AI 入口 403 PLAN_EXPIRED；/me 暴露 planStatus。
// 不依赖时钟/沙箱：直接把 planExpiresAt 设到过去即可触发（assertPlanActive 读真实 now）。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.js';

before(async () => { await getApp(); await seedBaseline(); });
after(async () => { await closeApp(); });
beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

test('过期用户：/me.planStatus.expired=true 且 /generate-sync 被 PLAN_EXPIRED(403) 拦', async () => {
  const token = await login(uniquePhone(), '过期者');
  await prisma.user.update({ where: { id: token }, data: { planExpiresAt: new Date(Date.now() - 86_400_000) } });

  const me = await api('GET', '/api/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.planStatus.expired, true);
  assert.equal(me.body.planStatus.active, false);
  assert.equal(me.body.tokenQuota.limit, 0, '过期后 /me 额度应显示 0（冻结）');

  const gen = await api('POST', '/api/generate-sync', { token, body: { text: '帮我做个战略诊断' } });
  assert.equal(gen.status, 403);
  assert.equal(gen.body.code, 'PLAN_EXPIRED');

  const sum = await api('POST', '/api/sessions/whatever/summarize', { token });
  assert.equal(sum.status, 403, '会话汇总同样被门禁拦');
  assert.equal(sum.body.code, 'PLAN_EXPIRED');
});

test('有效用户（免费层不到期）：/generate-sync 不被有效期拦', async () => {
  const token = await login(uniquePhone(), '有效者');
  const me = await api('GET', '/api/me', { token });
  assert.equal(me.body.planStatus.active, true);
  const gen = await api('POST', '/api/generate-sync', { token, body: { text: '你好' } });
  assert.notEqual(gen.status, 403); // mock 模型正常产出/对话，不应被 PLAN_EXPIRED 拦
});
