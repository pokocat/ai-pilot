// 战略案卷（PR-EX 执行闭环落库）集成测试：
// 认可方案建案卷/拆军令、军令打卡与增删、数据回填 upsert、跨用户隔离、本地案卷幂等导入。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone, deliverable } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { dateKey } from '../src/services/clock.ts';

// 上海无夏令时，回退 24h 恒落到前一上海日历日；casefileView 的 14 天窗口按上海日历日算，
// 用固定字面量日期（如硬编码的某个过去日子）会随执行日期推移滚出窗口——机器 UTC 时间只要过了
// 16:00（对应上海 00:00），上海「今天」已跨入下一天，14 天前的边界也随之前移一天，命中固定字面量
// 就会被滤掉（同一坑 reviewLog.test.ts 的 isoDaysAgo 已修过，这里补齐）。
function isoDaysAgo(n: number, from: Date = new Date()): string {
  return dateKey(new Date(from.getTime() - n * 86400_000));
}

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
  assert.equal(r.body.skippedOrders, 0);
  const cf = r.body.casefile;
  assert.equal(cf.title, '增长破局方案');
  assert.equal(cf.sourceAgent, '战略诊断官');
  assert.match(cf.judgment, /信任证明/);
  assert.deepEqual(cf.risks, ['不要追加新渠道投放', '不要先招销售扩团队']);
  assert.equal(cf.orders.length, 3);
  assert.ok(cf.orders.every((o: { aligned: boolean | null }) => o.aligned === true), '认可方案拆出的军令视为对齐主要矛盾');
  assert.ok(cf.orders.every((o: { tag: string }) => o.tag === '军令 · 战略诊断官'));
});

test('重复认可同一方案：今日军令幂等，不重复追加', async () => {
  const r = await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN, agentName: '战略诊断官' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.newOrders, 0);
  assert.equal(r.body.skippedOrders, 3);
  assert.equal(r.body.casefile.orders.length, 3, '重复认可同一成果不应撑长今日军令列表');
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
  const dup = await api('POST', '/api/casefile/orders', { token, body: { text: '私聊   12 个老客' } });
  assert.equal(dup.status, 200);
  assert.equal(
    dup.body.casefile.orders.filter((o: { text: string }) => o.text === '私聊 12 个老客').length,
    1,
    '手动重复添加同日同文本军令应被忽略',
  );

  const done = await api('PATCH', `/api/casefile/orders/${manual.id}`, { token, body: {} });
  assert.equal(done.status, 200);
  assert.equal(done.body.casefile.orders.find((o: { id: string }) => o.id === manual.id).done, true);

  // 完成后就地回填「做完了多少」：带 resultNote 的 PATCH 只落战果、不翻转完成态
  const filled = await api('PATCH', `/api/casefile/orders/${manual.id}`, { token, body: { resultNote: '发了 8 条，见 3 个客户' } });
  assert.equal(filled.status, 200);
  const filledOrder = filled.body.casefile.orders.find((o: { id: string }) => o.id === manual.id);
  assert.equal(filledOrder.resultNote, '发了 8 条，见 3 个客户');
  assert.equal(filledOrder.done, true, '回填不应把已完成军令翻回未完成');

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
  const orderDate = isoDaysAgo(3); // 舒适落在 casefileView 14 天窗口内，不随执行日期临界滚出
  const localDossier = {
    title: '本地迁移案卷',
    sourceAgent: '军师',
    judgment: '先修信任链路',
    risks: ['不要扩渠道'],
    orders: [
      { text: '发布一条观点短视频', from: 'IP 军师', tag: '军令 · IP', date: orderDate, done: true },
      { text: '', date: orderDate }, // 空文本应被过滤
      { text: '坏日期', date: '07/01' }, // 非法日期应被过滤
    ],
    backfill: { [orderDate]: { leads: '8', consults: '2', deals: '0' } },
  };
  // other 用户无案卷 → 导入成功
  const r = await api('POST', '/api/casefile/import', { token: other, body: { dossier: localDossier } });
  assert.equal(r.status, 200);
  assert.equal(r.body.imported, true);
  assert.equal(r.body.casefile.title, '本地迁移案卷');
  assert.equal(r.body.casefile.orders.length, 1);
  assert.equal(r.body.casefile.orders[0].done, true);
  assert.equal(r.body.casefile.backfill[orderDate].leads, '8');

  // 再导一次 → 幂等跳过
  const again = await api('POST', '/api/casefile/import', { token: other, body: { dossier: localDossier } });
  assert.equal(again.body.imported, false);

  // token 用户已有活跃案卷 → 跳过且不覆盖
  const skip = await api('POST', '/api/casefile/import', { token, body: { dossier: localDossier } });
  assert.equal(skip.body.imported, false);
  assert.notEqual(skip.body.casefile.title, '本地迁移案卷');
});

// —— 2026-07-22：报告 V2 类型化成果的拆军令/风险兜底 + 行内标记清洗（纯函数，不走 LLM）——
test('extractOrders：白卡 list 缺位时兜底 phases.actions，再兜底 gantt 行 label', async () => {
  const { extractOrders } = await import('../src/services/casefile.ts');
  const phasesD = { title: 'x', sections: [
    { h: '定调', b: '正文' },
    { type: 'phases', h: '分步打法', items: [{ tab: '第一阶段', h: '止血', actions: ['关掉两家亏损店', '收拢现金'] }] },
  ] } as any;
  assert.deepEqual(extractOrders(phasesD), ['关掉两家亏损店', '收拢现金']);
  const ganttD = { title: 'x', sections: [
    { type: 'gantt', h: '排期', rows: [{ label: '青州踩点', from: 1, to: 2 }, { label: '首店落地', from: 3, to: 5 }] },
  ] } as any;
  assert.deepEqual(extractOrders(ganttD), ['青州踩点', '首店落地']);
});

test('extractOrders：军令文本剥行内强调标记', async () => {
  const { extractOrders } = await import('../src/services/casefile.ts');
  const d = { title: 'x', sections: [{ h: '下一步行动', list: ['**关店**两家', '==保住老店==', '!!不动班底!!'] }] } as any;
  assert.deepEqual(extractOrders(d), ['关店两家', '保住老店', '不动班底']);
});

test('extractRisks：tone=风险 的 callout 也计入风险锁', async () => {
  const { extractRisks } = await import('../src/services/casefile.ts');
  const d = { title: 'x', sections: [
    { type: 'callout', tone: '风险', h: '警讯', b: '!!资金链!!承压，勿再开新店' },
  ] } as any;
  assert.deepEqual(extractRisks(d), ['资金链承压，勿再开新店']);
});
