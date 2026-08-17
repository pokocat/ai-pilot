// B 级卡片（M4 PR-15 第一批）测试：每日战报真数据渲染、天时日历命盘依赖、
// 天命速写（朋友生辰现算不落库）、品牌红线（无米诺）、叙事线/谶语存档与注入。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone, deliverable } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { fateCardContent, renderCalendarCard } from '../src/services/cardHtml.ts';
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
  await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN, agentName: '军师' } });
  const cf = await api('GET', '/api/casefile', { token });
  await api('PATCH', `/api/casefile/orders/${cf.body.casefile.orders[0].id}`, { token, body: { done: true } });
  await api('PUT', '/api/casefile/backfill', { token, body: { leads: 8, consults: 2, deals: 1 } });
  await api('POST', '/api/casefile/review', { token, body: {} });

  const report = await api('GET', '/api/cards/daily', { token });
  assert.equal(report.status, 200);
  assert.equal(report.body.done, 1);
  assert.equal(report.body.total, 2);
  assert.equal(report.body.alignRate, 100, '认可方案拆出的军令全对齐');
  assert.deepEqual(report.body.backfill, { leads: 8, consults: 2, deals: 1 });
  assert.equal(report.body.streak, 1);
  assert.ok(report.body.orders.some((order: { text: string }) => order.text === '重做案例证明'));
});

test('卡片路由：daily 仅允许鉴权 GET 内嵌取数，旧 POST 不再生成公开页', async () => {
  const token = await login(uniquePhone(), '路由用户');
  const before = await prisma.reportHtml.count({ where: { title: '每日战报' } });
  const get = await api('GET', '/api/cards/daily', { token });
  assert.equal(get.status, 200);
  assert.equal(get.body.casefileTitle, null);
  const unauth = await api('GET', '/api/cards/daily', {});
  assert.equal(unauth.status, 401);
  const legacy = await api('POST', '/api/cards/daily', { token, body: {} });
  assert.equal(legacy.status, 410);
  assert.equal(legacy.body.code, 'DAILY_REPORT_EMBEDDED_ONLY');
  assert.equal(await prisma.reportHtml.count({ where: { title: '每日战报' } }), before, '不得创建公开页');
  const bad = await api('POST', '/api/cards/xxx', { token, body: {} });
  assert.equal(bad.status, 400);
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
  assert.match(html, /paipan-v4/);
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

test('历史每日战报公开页统一失效 + 小程序码注入降级安全', async () => {
  const token = await login(uniquePhone(), '域名用户');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token } });
  const legacy = await prisma.reportHtml.create({ data: { tenantId: user.tenantId, title: '每日战报', html: '<html><body>经营隐私</body></html>' } });
  const page = await api('GET', `/api/r/${legacy.id}`, {});
  assert.equal(page.status, 404, '历史 daily 公开链接必须立即失效');
  const pdf = await api('GET', `/api/r/${legacy.id}/pdf`, {});
  assert.equal(pdf.status, 404, '历史 daily PDF 也必须失效');

  // 注入器行为：有码 → 页脚出现长按识别块且结构完整；无码 → 原样
  const { withMiniCode } = await import('../src/services/cardHtml.ts');
  const html = '<html><body><div class="card">x</div></body></html>';
  assert.equal(withMiniCode(html, null), html);
  const withQr = withMiniCode(html, 'data:image/png;base64,AAAA');
  assert.match(withQr, /mp-code/);
  assert.match(withQr, /长按识别小程序码/);
  assert.match(withQr, /<\/div><\/body><\/html>$/);
});
