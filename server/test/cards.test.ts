// B 级卡片（M4 PR-15 第一批）测试：每日战报真数据渲染、天时日历命盘依赖、
// 天命速写（朋友生辰现算不落库）、品牌红线（无米诺）、叙事线/谶语存档与注入。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone, deliverable } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { renderDailyCard, fateCardContent, renderCalendarCard } from '../src/services/cardHtml.ts';
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
  assert.match(html, /paipan-v2/);
  assert.doesNotMatch(html, /米诺|Mino/i);
});

test('天命速写卡（送你一卦）：朋友生辰现算不落库、不产出公开链接，需 consent，返回命格/大势/引导文本（P-4 合规）', async () => {
  const token = await login(uniquePhone(), '送卦用户');
  const before1 = await prisma.natalChart.count();
  const beforeHtml = await prisma.reportHtml.count();
  const friendBazi = { calendar: 'solar' as const, year: 1988, month: 3, day: 15, hour: 10, gender: 'male' as const };

  // 未勾选「已获对方同意」→ 400
  const noConsent = await api('POST', '/api/cards/fate/preview', { token, body: { friendName: '老王', friendBazi } });
  assert.equal(noConsent.status, 400);
  assert.equal(noConsent.body.code, 'CONSENT_REQUIRED');

  const r = await api('POST', '/api/cards/fate/preview', { token, body: { friendName: '老王', friendBazi, consent: true } });
  assert.equal(r.status, 200);
  assert.equal(await prisma.natalChart.count(), before1, '朋友命盘不落库');
  assert.equal(await prisma.reportHtml.count(), beforeHtml, '预览不产出公开链接');

  const chart = computeChart(friendBazi, 2026);
  const expected = fateCardContent(chart, '老王');
  assert.deepEqual(r.body, expected);
  assert.match(r.body.subtitle, /赠与 老王/);
  assert.match(r.body.sketch, /七杀格/);
  assert.doesNotMatch(`${r.body.sketch}${r.body.trend}${r.body.advice}`, /米诺|Mino/i);

  // 旧落库路径（POST /cards/fate + friendBazi）已封禁，指向新预览端点
  const legacy = await api('POST', '/api/cards/fate', { token, body: { friendName: '老王', friendBazi } });
  assert.equal(legacy.status, 400);
  assert.equal(legacy.body.code, 'USE_FATE_PREVIEW');

  // 自己没命盘也没朋友生辰 → 400
  const bare = await api('POST', '/api/cards/fate/preview', { token, body: { consent: true } });
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

test('卡片链接走自有域名（微信可直接打开）+ 小程序码注入降级安全', async () => {
  const token = await login(uniquePhone(), '域名用户');
  const r = await api('POST', '/api/cards/daily', { token, body: {} });
  assert.equal(r.status, 200);
  // 品牌域名链接（不是 OSS）：{PUBLIC_BASE_URL}/api/r/:id，微信聊天里点开即达
  assert.match(r.body.htmlUrl, /\/api\/r\/[a-z0-9]+$/i, '卡片应返回自有域名 /api/r/ 链接');
  assert.ok(!/aliyuncs\.com/.test(r.body.htmlUrl), '卡片不走 OSS 域名');

  // 测试环境铁律：不打微信真实接口 → 无小程序码块
  const row = await prisma.reportHtml.findFirst({ orderBy: { createdAt: 'desc' } });
  assert.ok(row && !row.html.includes('长按识别小程序码'), '测试环境不应产生小程序码');

  // 注入器行为：有码 → 页脚出现长按识别块且结构完整；无码 → 原样
  const { withMiniCode } = await import('../src/services/cardHtml.ts');
  const html = '<html><body><div class="card">x</div></body></html>';
  assert.equal(withMiniCode(html, null), html);
  const withQr = withMiniCode(html, 'data:image/png;base64,AAAA');
  assert.match(withQr, /mp-code/);
  assert.match(withQr, /长按识别小程序码/);
  assert.match(withQr, /<\/div><\/body><\/html>$/);
});
