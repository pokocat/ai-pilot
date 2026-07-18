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
const PLAN2 = deliverable('现金流保卫方案', [
  { h: '现状判断', b: '现金比利润更早要命，先把回款抓起来。' },
  { h: '行动清单', list: ['压账期'] },
]);

test('认可方案 → 自动记一条；P1-1 重复认可同一方案幂等（不重复记账）；换方案 seq 自增', async () => {
  const token = await login(uniquePhone(), '决策用户');
  await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN, agentName: '军师' } });
  // P1-1：同一方案 accept 两次 → DecisionLog 只有一条（否则重复记账污染准确率统计的分母）。
  await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN, agentName: '军师' } });

  let r = await api('GET', '/api/decisions', { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 1, '同一方案 accept 两次 → 只记一条');

  // 认可另一份方案 → 第 2 条决策，seq 自增。
  await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN2, agentName: '军师' } });
  r = await api('GET', '/api/decisions', { token });
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

test('手动记录 + 验证 → 准确率由服务端算出（快/慢分开；P-2 最小样本：已验证 <5 条不出比率）', async () => {
  const token = await login(uniquePhone(), '验证用户');
  const record = (fast: boolean, decision: string) => api('POST', '/api/decisions', { token, body: { decision, fast } });
  const verify = (id: string, outcome: string, note?: string) => api('POST', `/api/decisions/${id}/verify`, { token, body: { outcome, note } });

  const d1 = await record(true, '砍掉低毛利产品线');
  const d2 = await record(true, '全款预付进一批货');
  const d3 = await record(false, '深思后决定聚焦美业赛道');

  await verify(d1.body.decision.id, 'correct', '毛利率 +6pp');
  await verify(d2.body.decision.id, 'revise', '库存积压');
  const v3 = await verify(d3.body.decision.id, 'correct');

  // 已验证仅 3 条（<5）：批次C 最小样本保护——即使全对/全错也不出比率，避免 1 条即 100% 直接喂晋升
  const before = v3.body.stats;
  assert.equal(before.total, 3);
  assert.equal(before.correct, 2);
  assert.equal(before.revise, 1);
  assert.equal(before.accuracy, null, '已验证 3 条 <5，不出总比率');
  assert.equal(before.fastAccuracy, null, '快决策已验证 2 条 <5，不出比率');
  assert.equal(before.slowAccuracy, null, '慢决策已验证 1 条 <5，不出比率');

  // 各分桶补到 ≥5 条已验证，比率才由服务端算出
  const more: Array<[boolean, string]> = [
    [true, 'correct'], [true, 'correct'], [true, 'correct'], // 快：补 3 → 快共 5 条（4 正确 1 修正）=80%
    [false, 'correct'], [false, 'correct'], [false, 'revise'], [false, 'revise'], // 慢：补 4 → 慢共 5 条（3 正确 2 修正）=60%
  ];
  let last = v3;
  for (const [fast, outcome] of more) {
    const d = await record(fast, `补测决策-${fast ? '快' : '慢'}-${outcome}`);
    last = await verify(d.body.decision.id, outcome);
  }

  const after = last.body.stats;
  assert.equal(after.total, 10);
  assert.equal(after.correct, 7);
  assert.equal(after.revise, 3);
  assert.equal(after.accuracy, 70, '7/(7+3)=70%（已验证 10 条 ≥5）');
  assert.equal(after.fastAccuracy, 80, '快决策 4/5=80%（≥5）');
  assert.equal(after.slowAccuracy, 60, '慢决策 3/5=60%（≥5）');

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
