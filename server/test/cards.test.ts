// B 级卡片（M4 PR-15 第一批）测试：每日战报真数据渲染、天时日历命盘依赖、
// 天命速写（朋友生辰现算不落库）、品牌红线（无米诺）、叙事线/谶语存档与注入。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone, deliverable } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { renderDailyCard, renderFateCard, renderCalendarCard } from '../src/services/cardHtml.ts';
import { computeChart } from '../src/services/paipan.ts';
import { loadStrategicProfile, strategicBlock } from '../src/services/strategicProfile.ts';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

const PLAN = deliverable('破局方案', [
  { h: '现状判断', b: '信任链路断裂。' },
  { h: '行动清单', list: ['重做案例证明', '私聊 12 个老客'] },
]);

test('每日战报卡：军令完成/对齐率/回填/段位/连续天数全部来自真实账本', async () => {
  const token = await login(uniquePhone(), '战报用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN, agentName: '军师' } });
  const cf = await api('GET', '/api/casefile', { token });
  await api('PATCH', `/api/casefile/orders/${cf.body.casefile.orders[0].id}`, { token, body: { done: true } });
  await api('PUT', '/api/casefile/backfill', { token, body: { leads: 8, consults: 2, deals: 1 } });
  await api('POST', '/api/casefile/review', { token, body: {} });

  const html = await renderDailyCard({ tenantId: user.tenantId, userId: user.id });
  assert.match(html, /每日战报/);
  assert.match(html, /1\/2/, '军令完成 1/2');
  assert.match(html, /100%/, '对齐率（认可拆出的军令全对齐）');
  assert.match(html, /已回填/);
  assert.match(html, /连续复盘第 1 天/);
  assert.match(html, /重做案例证明/);
  assert.match(html, /军师参谋部/);
  assert.doesNotMatch(html, /米诺|Mino/i, '品牌红线');
});

test('卡片路由：daily 返回 htmlUrl（后端 /api/r/:id 兜底可打开）；未知类型 400', async () => {
  const token = await login(uniquePhone(), '路由用户');
  const r = await api('POST', '/api/cards/daily', { token, body: {} });
  assert.equal(r.status, 200);
  assert.ok(r.body.htmlUrl, '应返回链接');
  const bad = await api('POST', '/api/cards/xxx', { token, body: {} });
  assert.equal(bad.status, 400);
  // 留底行存在
  assert.ok(await prisma.reportHtml.findFirst({ where: { title: '每日战报' } }));
});

test('天时日历卡：无命盘 400；有命盘含 12 个月攻守与拐点标注', async () => {
  const token = await login(uniquePhone(), '日历用户');
  const none = await api('POST', '/api/cards/calendar', { token, body: {} });
  assert.equal(none.status, 400);
  assert.equal(none.body.code, 'NO_CHART');

  await api('PUT', '/api/profile/bazi', { token, body: { calendar: 'solar', year: 1988, month: 3, day: 15, hour: 10, gender: 'male' } });
  const ok = await api('POST', '/api/cards/calendar', { token, body: {} });
  assert.equal(ok.status, 200);

  const chart = computeChart({ calendar: 'solar', year: 1988, month: 3, day: 15, hour: 10, gender: 'male' }, 2026);
  const html = renderCalendarCard(chart, '测试主理人', '守得寒冬三尺雪');
  for (let m = 1; m <= 12; m++) assert.match(html, new RegExp(`${m}月`));
  assert.match(html, /守得寒冬三尺雪/);
  assert.match(html, /paipan-v1/);
  assert.doesNotMatch(html, /米诺|Mino/i);
});

test('天命速写卡（送你一卦）：朋友生辰现算不落库，含命格/大势/引导', async () => {
  const token = await login(uniquePhone(), '送卦用户');
  const before1 = await prisma.natalChart.count();
  const r = await api('POST', '/api/cards/fate', {
    token,
    body: { friendName: '老王', friendBazi: { calendar: 'solar', year: 1988, month: 3, day: 15, hour: 10, gender: 'male' } },
  });
  assert.equal(r.status, 200);
  assert.equal(await prisma.natalChart.count(), before1, '朋友命盘不落库');

  const chart = computeChart({ calendar: 'solar', year: 1988, month: 3, day: 15, hour: 10, gender: 'male' }, 2026);
  const html = renderFateCard(chart, '老王');
  assert.match(html, /赠与 老王/);
  assert.match(html, /七杀格/);
  assert.match(html, /找军师参谋部/);
  assert.doesNotMatch(html, /米诺|Mino/i);

  // 自己没命盘也没朋友生辰 → 400
  const bare = await api('POST', '/api/cards/fate', { token, body: {} });
  assert.equal(bare.status, 400);
});

test('叙事线/谶语存档：PUT 往返 + 注入块带「保持前后一致」口径', async () => {
  const token = await login(uniquePhone(), '叙事用户');
  await api('PUT', '/api/profile/strategic', { token, body: { narrative: '前半程靠手艺吃饭，这盘生意是你的翻篇之战。', verse: '蛰龙勿用待秋风' } });
  const p = await loadStrategicProfile(token);
  assert.equal(p?.verse, '蛰龙勿用待秋风');
  assert.match(p!.narrative, /翻篇之战/);
  const block = strategicBlock(p);
  assert.match(block!, /命运叙事线：.*不得重生成矛盾版本/);
  assert.match(block!, /年度谶语：「蛰龙勿用待秋风」/);
});
