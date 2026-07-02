// 战略档案（M1 PR-3 统一状态层）测试：提取规则、认可回写、注入优先级、手动校准、隔离、城市经度。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone, deliverable } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { extractStrategicFacts, strategicBlock } from '../src/services/strategicProfile.ts';
import { buildGenContext } from '../src/services/context.ts';
import { buildSystemParts } from '../src/llm/schema.ts';
import { cityLongitude } from '../src/data/cityLongitude.ts';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

const PLAN = deliverable('增长破局方案', [
  { h: '主要矛盾', b: '不是缺流量，是信任证明断在转化前。\n其余分析略。' },
  { h: '战略定位', b: '高净值老板的私域信任顾问' },
  { h: '聚焦赛道', list: ['美业老板增长陪跑'] },
  { h: '30 天行动清单', list: ['重做案例证明', '只投 3 个主题'] },
]);

test('提取规则：按分节标题取 主要矛盾/定位/赛道，只取首行、没有的不编', () => {
  const facts = extractStrategicFacts(PLAN);
  assert.equal(facts.mainContradiction, '不是缺流量，是信任证明断在转化前。');
  assert.equal(facts.positioning, '高净值老板的私域信任顾问');
  assert.equal(facts.track, '美业老板增长陪跑');
  assert.equal(facts.stage, undefined, '方案里没有阶段分节就不写');
  // 与战略无关的成果 → 空提取
  assert.deepEqual(extractStrategicFacts(deliverable('周报', [{ h: '本周动作', list: ['发视频'] }])), {});
});

test('认可方案 → 战略档案自动回写；再次认可只覆盖出现的字段', async () => {
  const token = await login(uniquePhone(), '档案用户');
  await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN, agentName: '军师' } });

  const r = await api('GET', '/api/profile/strategic', { token });
  assert.equal(r.body.strategic.mainContradiction, '不是缺流量，是信任证明断在转化前。');
  assert.equal(r.body.strategic.positioning, '高净值老板的私域信任顾问');

  // 第二次认可：只带主要矛盾 → 定位保留
  const NEXT = deliverable('修补 v2', [{ h: '核心问题', b: '案例证明未结构化。' }]);
  await api('POST', '/api/casefile/accept', { token, body: { deliverable: NEXT, agentName: '军师' } });
  const r2 = await api('GET', '/api/profile/strategic', { token });
  assert.equal(r2.body.strategic.mainContradiction, '案例证明未结构化。');
  assert.equal(r2.body.strategic.positioning, '高净值老板的私域信任顾问', '未出现的字段不被清空');
});

test('注入：战略档案块出现在 dynamic 段且先于客户档案；空档案不注入', async () => {
  const token = await login(uniquePhone(), '注入档案用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN, agentName: '军师' } });

  const { ctx } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'general', userMessage: '下一步怎么打' });
  const { dynamic } = buildSystemParts(ctx.systemPrompt, ctx, 'chat');
  assert.match(dynamic, /【战略档案（客户已确认的战略事实/);
  assert.match(dynamic, /信任证明断在转化前/);
  assert.ok(dynamic.indexOf('【战略档案') < dynamic.indexOf('【客户档案'), '已确认事实先于推断档案');

  // 空档案用户不注入
  const t2 = await login(uniquePhone(), '空档案用户');
  const u2 = await prisma.user.findFirstOrThrow({ where: { id: t2 } });
  const { ctx: ctx2 } = await buildGenContext({ userId: u2.id, tenantId: u2.tenantId, agentKey: 'general', userMessage: '你好' });
  assert.equal(ctx2.strategicLine ?? null, null);
});

test('手动校准：PUT /profile/strategic 局部更新；跨用户隔离', async () => {
  const token = await login(uniquePhone(), '校准用户');
  await api('PUT', '/api/profile/strategic', { token, body: { mainContradiction: '现金流吃紧', stage: '起步期' } });
  const r = await api('GET', '/api/profile/strategic', { token });
  assert.equal(r.body.strategic.mainContradiction, '现金流吃紧');
  assert.equal(r.body.strategic.stage, '起步期');
  assert.equal(r.body.strategic.positioning, '');

  const other = await login(uniquePhone(), '别人');
  const r2 = await api('GET', '/api/profile/strategic', { token: other });
  assert.equal(r2.body.strategic, null);
});

test('strategicBlock：空/无内容返回 null，不产生空块', () => {
  assert.equal(strategicBlock(null), null);
  assert.equal(strategicBlock({ mainContradiction: '', positioning: '', track: '', stage: '', updatedAt: null }), null);
});

test('城市经度映射：常见写法命中，未知城市不校正；采集时自动生效', async () => {
  assert.equal(cityLongitude('杭州'), 120.2);
  assert.equal(cityLongitude('浙江省杭州市'), 120.2);
  assert.equal(cityLongitude('乌鲁木齐'), 87.6);
  assert.equal(cityLongitude('某个小地方'), undefined);
  assert.equal(cityLongitude(''), undefined);

  // 端到端：出生地=乌鲁木齐、正午 → 真太阳时校正生效（午 → 巳）
  const token = await login(uniquePhone(), '经度用户');
  const r = await api('PUT', '/api/profile/bazi', {
    token,
    body: { calendar: 'solar', year: 1988, month: 3, day: 15, hour: 12, minute: 0, gender: 'male', birthPlace: '乌鲁木齐' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.chart.trueSolarApplied, true);
  assert.equal(r.body.chart.pillars.time.ganZhi, '己巳');
});
