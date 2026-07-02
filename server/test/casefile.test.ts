// 战略案卷（PR-EX 执行闭环落库）集成测试：
// 认可方案建案卷/拆军令、军令打卡与增删、数据回填 upsert、跨用户隔离、本地案卷幂等导入。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone, deliverable } from './helpers.ts';
import { prisma } from '../src/db.ts';

let token = '';
let other = '';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
  token = await login(uniquePhone(), '案卷用户');
  other = await login(uniquePhone(), '隔壁用户');
});

after(async () => {
  await closeApp();
});

const PLAN = deliverable('增长破局方案', [
  { h: '现状判断', b: '不是缺流量，是信任证明断在转化前。' },
  { h: '30 天行动清单', list: ['重做案例证明，补咨询前问卷', '只投 3 个主题做内容', '每日回填线索/咨询/成交'] },
  { h: '风险与红线', list: ['不要追加新渠道投放', '不要先招销售扩团队'] },
]);

test('未认可方案时：GET /casefile 返回 null；加军令/回填返回 409', async () => {
  const r = await api('GET', '/api/casefile', { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.casefile, null);

  const add = await api('POST', '/api/casefile/orders', { token, body: { text: '先试一条' } });
  assert.equal(add.status, 409);
  assert.equal(add.body.code, 'NO_CASEFILE');

  const bf = await api('PUT', '/api/casefile/backfill', { token, body: { leads: 3 } });
  assert.equal(bf.status, 409);
});

test('认可方案 → 建案卷：判断/风险锁/军令按分节提取，军令标记对齐', async () => {
  const r = await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN, agentName: '战略诊断官' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.newOrders, 3);
  const cf = r.body.casefile;
  assert.equal(cf.title, '增长破局方案');
  assert.equal(cf.sourceAgent, '战略诊断官');
  assert.match(cf.judgment, /信任证明/);
  assert.deepEqual(cf.risks, ['不要追加新渠道投放', '不要先招销售扩团队']);
  assert.equal(cf.orders.length, 3);
  assert.ok(cf.orders.every((o: { aligned: boolean | null }) => o.aligned === true), '认可方案拆出的军令视为对齐主要矛盾');
  assert.ok(cf.orders.every((o: { tag: string }) => o.tag === '军令 · 战略诊断官'));
});

test('再次认可新方案：军令累积、判断与风险覆盖（同一案卷持续推进）', async () => {
  const NEXT = deliverable('信任链路修补 v2', [
    { h: '主要矛盾', b: '案例证明还没形成可复用结构。' },
    { h: '下一步动作', list: ['把成交案例改成问题-证据-结果结构'] },
  ]);
  const r = await api('POST', '/api/casefile/accept', { token, body: { deliverable: NEXT, agentName: '军师' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.newOrders, 1);
  const cf = r.body.casefile;
  assert.equal(cf.title, '信任链路修补 v2');
  assert.match(cf.judgment, /案例证明/);
  // 无风险分节 → 保留旧风险锁
  assert.deepEqual(cf.risks, ['不要追加新渠道投放', '不要先招销售扩团队']);
  assert.equal(cf.orders.length, 4, '军令应累积（3+1）');
});

test('军令：手动添加 / 打卡往返 / 删除', async () => {
  const add = await api('POST', '/api/casefile/orders', { token, body: { text: ' 私聊 12 个老客 ' } });
  assert.equal(add.status, 200);
  const manual = add.body.casefile.orders.find((o: { from: string }) => o.from === '我');
  assert.ok(manual, '手动军令应存在');
  assert.equal(manual.text, '私聊 12 个老客');
  assert.equal(manual.aligned, null, '手动军令未标注对齐性');

  const done = await api('PATCH', `/api/casefile/orders/${manual.id}`, { token, body: {} });
  assert.equal(done.status, 200);
  assert.equal(done.body.casefile.orders.find((o: { id: string }) => o.id === manual.id).done, true);
  const undone = await api('PATCH', `/api/casefile/orders/${manual.id}`, { token, body: { done: false } });
  assert.equal(undone.body.casefile.orders.find((o: { id: string }) => o.id === manual.id).done, false);

  const del = await api('DELETE', `/api/casefile/orders/${manual.id}`, { token });
  assert.equal(del.status, 200);
  assert.ok(!del.body.casefile.orders.some((o: { id: string }) => o.id === manual.id));
});

test('数据回填：当日 upsert（重复提交覆盖），非法值归零', async () => {
  const r1 = await api('PUT', '/api/casefile/backfill', { token, body: { leads: '18', consults: 4, deals: 'abc' } });
  assert.equal(r1.status, 200);
  const today = Object.keys(r1.body.casefile.backfill).sort().pop()!;
  assert.deepEqual(
    { leads: r1.body.casefile.backfill[today].leads, consults: r1.body.casefile.backfill[today].consults, deals: r1.body.casefile.backfill[today].deals },
    { leads: '18', consults: '4', deals: '' },
  );
  const r2 = await api('PUT', '/api/casefile/backfill', { token, body: { leads: 20, consults: 5, deals: 1 } });
  assert.equal(r2.body.casefile.backfill[today].deals, '1');
  const rows = await prisma.casefileMetric.count({ where: { date: today } });
  assert.equal(rows, 1, '同日回填应覆盖而非新增');
});

test('跨用户隔离：他人看不到、也改不动我的案卷与军令', async () => {
  const mine = await api('GET', '/api/casefile', { token });
  const orderId = mine.body.casefile.orders[0].id;

  const theirs = await api('GET', '/api/casefile', { token: other });
  assert.equal(theirs.body.casefile, null);

  const patch = await api('PATCH', `/api/casefile/orders/${orderId}`, { token: other, body: { done: true } });
  assert.equal(patch.status, 404);

  await api('DELETE', `/api/casefile/orders/${orderId}`, { token: other });
  const still = await api('GET', '/api/casefile', { token });
  assert.ok(still.body.casefile.orders.some((o: { id: string }) => o.id === orderId), '他人删除不生效');
});

test('本地案卷导入：无案卷时导入军令与回填；已有活跃案卷则幂等跳过', async () => {
  const localDossier = {
    title: '本地迁移案卷',
    sourceAgent: '军师',
    judgment: '先修信任链路',
    risks: ['不要扩渠道'],
    orders: [
      { text: '发布一条观点短视频', from: 'IP 军师', tag: '军令 · IP', date: '2026-07-01', done: true },
      { text: '', date: '2026-07-01' }, // 空文本应被过滤
      { text: '坏日期', date: '07/01' }, // 非法日期应被过滤
    ],
    backfill: { '2026-07-01': { leads: '8', consults: '2', deals: '0' } },
  };
  // other 用户无案卷 → 导入成功
  const r = await api('POST', '/api/casefile/import', { token: other, body: { dossier: localDossier } });
  assert.equal(r.status, 200);
  assert.equal(r.body.imported, true);
  assert.equal(r.body.casefile.title, '本地迁移案卷');
  assert.equal(r.body.casefile.orders.length, 1);
  assert.equal(r.body.casefile.orders[0].done, true);
  assert.equal(r.body.casefile.backfill['2026-07-01'].leads, '8');

  // 再导一次 → 幂等跳过
  const again = await api('POST', '/api/casefile/import', { token: other, body: { dossier: localDossier } });
  assert.equal(again.body.imported, false);

  // token 用户已有活跃案卷 → 跳过且不覆盖
  const skip = await api('POST', '/api/casefile/import', { token, body: { dossier: localDossier } });
  assert.equal(skip.body.imported, false);
  assert.notEqual(skip.body.casefile.title, '本地迁移案卷');
});
