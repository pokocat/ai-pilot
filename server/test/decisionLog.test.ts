// 决策日志（M2 PR-7）测试：认可自动记账、手动记录、验证与准确率（服务端计数）、注入、隔离。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone, deliverable } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { decisionBriefing } from '../src/services/decisionLog.ts';
import { buildGenContext } from '../src/services/context.ts';
import { buildSystemParts } from '../src/llm/schema.ts';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

const PLAN = deliverable('增长破局方案', [
  { h: '现状判断', b: '不是缺流量，是信任证明断在转化前。' },
  { h: '行动清单', list: ['重做案例证明'] },
]);

test('认可方案 → 自动记一条决策（30 天验证期，seq 自增）', async () => {
  const token = await login(uniquePhone(), '决策用户');
  await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN, agentName: '军师' } });
  await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN, agentName: '军师' } });

  const r = await api('GET', '/api/decisions', { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 2);
  assert.deepEqual(r.body.items.map((d: { seq: number }) => d.seq), [2, 1], '按序号倒序');
  const d = r.body.items[1];
  assert.match(d.decision, /^采纳《增长破局方案》：不是缺流量/);
  assert.equal(d.status, 'pending');
  assert.match(d.verifyByDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(d.fast, false);
  // 未验证前：准确率必须是 null（不编 0%）
  assert.equal(r.body.stats.accuracy, null);
  assert.equal(r.body.stats.pending, 2);
});

test('手动记录 + 验证 → 准确率由服务端算出（快/慢分开）', async () => {
  const token = await login(uniquePhone(), '验证用户');
  const d1 = await api('POST', '/api/decisions', { token, body: { decision: '砍掉低毛利产品线', fast: true, verifyStandard: '毛利率回升' } });
  assert.equal(d1.status, 200);
  const d2 = await api('POST', '/api/decisions', { token, body: { decision: '全款预付进一批货', fast: true } });
  const d3 = await api('POST', '/api/decisions', { token, body: { decision: '深思后决定聚焦美业赛道', fast: false } });

  await api('POST', `/api/decisions/${d1.body.decision.id}/verify`, { token, body: { outcome: 'correct', note: '毛利率 +6pp' } });
  await api('POST', `/api/decisions/${d2.body.decision.id}/verify`, { token, body: { outcome: 'revise', note: '库存积压' } });
  const v3 = await api('POST', `/api/decisions/${d3.body.decision.id}/verify`, { token, body: { outcome: 'correct' } });

  const stats = v3.body.stats;
  assert.equal(stats.total, 3);
  assert.equal(stats.correct, 2);
  assert.equal(stats.revise, 1);
  assert.equal(stats.accuracy, 67, '2/(2+1)=67%');
  assert.equal(stats.fastAccuracy, 50, '快决策 1/2');
  assert.equal(stats.slowAccuracy, 100, '慢决策 1/1');

  // 校验：非法 outcome 400
  const bad = await api('POST', `/api/decisions/${d1.body.decision.id}/verify`, { token, body: { outcome: 'maybe' } });
  assert.equal(bad.status, 400);
});

test('注入：有决策 → dynamic 段带【决策账本】与禁止自算口径；无记录不注入', async () => {
  const token = await login(uniquePhone(), '注入决策用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  await api('POST', '/api/decisions', { token, body: { decision: '先修信任链路再投放' } });

  const line = await decisionBriefing(user.id);
  assert.ok(line);
  assert.match(line!, /【决策账本（系统计数/);
  assert.match(line!, /尚无准确率——不要编造数字/);

  const { ctx } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'general', userMessage: '复盘一下' });
  const { dynamic } = buildSystemParts(ctx.systemPrompt, ctx, 'chat');
  assert.match(dynamic, /【决策账本/);
  assert.match(dynamic, /先修信任链路再投放/);

  const empty = await login(uniquePhone(), '无决策用户');
  const u2 = await prisma.user.findFirstOrThrow({ where: { id: empty } });
  assert.equal(await decisionBriefing(u2.id), null);
});

test('隔离：他人不能验证我的决策', async () => {
  const token = await login(uniquePhone(), '我');
  const other = await login(uniquePhone(), '他');
  const d = await api('POST', '/api/decisions', { token, body: { decision: '我的决策' } });
  const r = await api('POST', `/api/decisions/${d.body.decision.id}/verify`, { token: other, body: { outcome: 'correct' } });
  assert.equal(r.status, 404);
  const mine = await api('GET', '/api/decisions', { token });
  assert.equal(mine.body.items[0].status, 'pending');
});
