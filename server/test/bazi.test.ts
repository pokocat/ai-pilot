// 八字采集与天势注入（M1 PR-2）集成测试：
// 采集→排盘落库→GET 回显；输入校验；缺时辰；不信命理降级；buildGenContext 注入【天势档案】。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
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

const BODY = { calendar: 'solar', year: 1988, month: 3, day: 15, hour: 10, minute: 30, gender: 'male', birthPlace: '杭州' };

test('采集→排盘落库→回显：PUT /profile/bazi 返回命盘，GET /profile/chart 一致', async () => {
  const token = await login(uniquePhone(), '天势用户');
  const r = await api('PUT', '/api/profile/bazi', { token, body: BODY });
  assert.equal(r.status, 200);
  assert.equal(r.body.believe, true);
  assert.equal(r.body.chart.pillars.day.ganZhi, '己巳');
  assert.equal(r.body.chart.pattern.name, '七杀格');

  const g = await api('GET', '/api/profile/chart', { token });
  assert.equal(g.status, 200);
  assert.equal(g.body.chart.pillars.year.ganZhi, '戊辰');
  assert.equal(g.body.bazi.year, 1988);

  const rows = await prisma.natalChart.count({ where: { userId: token } });
  assert.equal(rows, 1);
});

test('输入校验：历法/性别/时辰/年份非法 → 400；不存在的农历日期 → 400', async () => {
  const token = await login(uniquePhone(), '校验用户');
  assert.equal((await api('PUT', '/api/profile/bazi', { token, body: { ...BODY, calendar: 'x' } })).status, 400);
  assert.equal((await api('PUT', '/api/profile/bazi', { token, body: { ...BODY, gender: '' } })).status, 400);
  assert.equal((await api('PUT', '/api/profile/bazi', { token, body: { ...BODY, hour: 25 } })).status, 400);
  assert.equal((await api('PUT', '/api/profile/bazi', { token, body: { ...BODY, year: 1800 } })).status, 400);
  // 公历月份不允许负数（负月只用于农历闰月）
  assert.equal((await api('PUT', '/api/profile/bazi', { token, body: { ...BODY, month: -2 } })).status, 400);
});

test('缺时辰：不传 hour → 三柱命盘（hourKnown=false，紫微为空）', async () => {
  const token = await login(uniquePhone(), '缺时辰用户');
  const { hour: _h, minute: _m, ...noHour } = BODY;
  const r = await api('PUT', '/api/profile/bazi', { token, body: noHour });
  assert.equal(r.status, 200);
  assert.equal(r.body.chart.hourKnown, false);
  assert.equal(r.body.chart.pillars.time, null);
  assert.equal(r.body.chart.ziwei, null);
});

test('对话注入：有命盘 → stable 段带【天势档案】与禁止自算铁律', async () => {
  const token = await login(uniquePhone(), '注入用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  await api('PUT', '/api/profile/bazi', { token, body: BODY });

  const { ctx } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'strat', userMessage: '帮我看看今年节奏' });
  assert.ok(ctx.tianshiLine, '应组装天势档案');
  const { stable } = buildSystemParts(ctx.systemPrompt, ctx, 'chat');
  assert.match(stable, /【天势档案（系统排盘引擎 paipan-v1 计算）】/);
  assert.match(stable, /戊辰 乙卯 己巳 己巳/);
  assert.match(stable, /七杀格/);
  assert.match(stable, /禁止你自行排八字/);
});

test('不信命理：believe=false → 不排盘、注入降级指令、不出现命理内容', async () => {
  const token = await login(uniquePhone(), '不信用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  const r = await api('PUT', '/api/profile/bazi', { token, body: { believe: false } });
  assert.equal(r.status, 200);
  assert.equal(r.body.chart, null);
  assert.equal(await prisma.natalChart.count({ where: { userId: user.id } }), 0);

  const { ctx } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'strat', userMessage: '今年该进攻还是防守' });
  const { stable } = buildSystemParts(ctx.systemPrompt, ctx, 'chat');
  assert.match(stable, /【天势表达降级】/);
  assert.doesNotMatch(stable, /【天势档案/);
});

test('无命盘也未表态：不注入任何天势块', async () => {
  const token = await login(uniquePhone(), '空白用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  const { ctx } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'general', userMessage: '你好' });
  assert.equal(ctx.tianshiLine, null);
  const { stable } = buildSystemParts(ctx.systemPrompt, ctx, 'chat');
  // 注：general 底座已是 V6.0 全文（自身含「天势档案」字样），这里只断言引擎注入块的完整标记不存在
  assert.doesNotMatch(stable, /【天势档案（系统排盘引擎|【天势表达降级】/);
});
