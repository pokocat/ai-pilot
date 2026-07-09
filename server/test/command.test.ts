// V7-05 军令结构化字段 + V7-10 目标阶梯。mock 模式下 structured() 返回 null → 走确定性缺省口径。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone, deliverable } from './helpers.js';

let token = '', other = '';
const PLAN = deliverable('增长破局方案', [
  { h: '核心判断', b: '当前不是缺流量，而是信任证明断在转化前。' },
  { h: '下一步动作', list: ['上传近 30 天成交漏斗表', '私聊 12 个高意向老客', '发布不下单短视频'] },
  { h: '现在不能做', list: ['不要追加新渠道投放'] },
]);

before(async () => { await getApp(); });
after(async () => { await closeApp(); });
beforeEach(async () => {
  await cleanBusiness();
  await seedBaseline();
  token = await login(uniquePhone(), '命令用户');
  other = await login(uniquePhone(), '隔壁用户');
});

test('accept 后军令带结构化缺省字段（owner=称呼 / actionType 关键词映射 / aligned）', async () => {
  const r = await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN, agentName: '战略诊断官' } });
  assert.equal(r.status, 200);
  const orders = r.body.casefile.orders as Array<Record<string, unknown>>;
  assert.ok(orders.length >= 1, '拆出军令');
  for (const o of orders) {
    assert.equal(o.ownerName, '命令用户', '负责人缺省=用户称呼');
    assert.ok(['upload', 'backfill', 'review', 'topics', 'none'].includes(o.actionType as string));
    assert.ok(Array.isArray(o.steps));
    assert.ok(Array.isArray(o.metrics));
    assert.equal(o.aligned, true);
  }
  // actionType 关键词映射断言
  const funnel = orders.find((o) => String(o.text).includes('漏斗表'));
  assert.equal(funnel?.actionType, 'upload');
  const video = orders.find((o) => String(o.text).includes('短视频'));
  assert.equal(video?.actionType, 'topics');
});

test('mock 抽不出目标阶梯 → goals 为 null（不编造）', async () => {
  const r = await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN, agentName: '军师' } });
  assert.equal(r.body.casefile.goals, null);
});

test('PUT /casefile/goals 局部更新并保留其它字段', async () => {
  await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN, agentName: '军师' } });
  const r = await api('PUT', '/api/casefile/goals', { token, body: { weekly: '修补信任链路', annual: '营收 ×2' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.casefile.goals.weekly, '修补信任链路');
  assert.equal(r.body.casefile.goals.annual, '营收 ×2');
  const r2 = await api('PUT', '/api/casefile/goals', { token, body: { quarterly: '转化率 1.2% → 3%' } });
  assert.equal(r2.body.casefile.goals.weekly, '修补信任链路', '未传字段保留');
  assert.equal(r2.body.casefile.goals.quarterly, '转化率 1.2% → 3%');
});

test('无案卷改目标 → 409 NO_CASEFILE', async () => {
  const r = await api('PUT', '/api/casefile/goals', { token: other, body: { weekly: 'x' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'NO_CASEFILE');
});

test('旧军令（无结构化字段）接口兼容：字段返回缺省', async () => {
  // 手动补一条军令（无结构化字段），确认 view 返回缺省不报错
  await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN, agentName: '军师' } });
  const add = await api('POST', '/api/casefile/orders', { token, body: { text: '手动补一条军令' } });
  assert.equal(add.status, 200);
  const manual = (add.body.casefile.orders as Array<Record<string, unknown>>).find((o) => o.text === '手动补一条军令');
  assert.ok(manual, '手动军令存在');
  assert.equal(manual!.actionType, 'none');
  assert.deepEqual(manual!.steps, []);
});
