// V7-07 数据源状态持久化：状态机（unbound→uploaded / →auth_requested）、@@unique 幂等、
// 注入块、hero 计数，以及 TC-G 跨租户隔离。
// 说明：路由尚未在 app.ts 注册（父 agent 负责 register + 跑），故 HTTP 集成用例在注册前会 404；
// 服务层用例（直调 services/dataSources）不依赖路由，注册前即可全绿。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { listForUser, recordUpload, requestAuth, dataSourcesBlock, statusLabelFor } from '../src/services/dataSources.ts';
import { DATA_SOURCES } from '../src/data/dataSources.ts';

let tokenA = '', tokenB = '';
let tenantA = '', tenantB = '';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
  tokenA = await login(uniquePhone(), '数据源用户');
  tokenB = await login(uniquePhone(), '隔壁用户');
  const [a, b] = await Promise.all([
    prisma.user.findUnique({ where: { id: tokenA } }),
    prisma.user.findUnique({ where: { id: tokenB } }),
  ]);
  tenantA = a!.tenantId;
  tenantB = b!.tenantId;
});
after(async () => { await closeApp(); });

// —— 目录事实 ——
test('catalog: 6 basic + 2 advanced = 8', () => {
  assert.equal(DATA_SOURCES.length, 8);
  assert.equal(DATA_SOURCES.filter((s) => s.tier === 'basic').length, 6);
  assert.equal(DATA_SOURCES.filter((s) => s.tier === 'advanced').length, 2);
  // 每条 scope 恰 4 项、icon 单个汉字
  for (const s of DATA_SOURCES) {
    assert.equal(s.scope.length, 4, `${s.key} scope 应 4 项`);
    assert.equal([...s.icon].length, 1, `${s.key} icon 应单字`);
  }
});

test('statusLabel: unbound 依 tier / 其余固定', () => {
  assert.equal(statusLabelFor('unbound', 'basic'), '上传即可');
  assert.equal(statusLabelFor('unbound', 'advanced'), '高级');
  assert.equal(statusLabelFor('auth_requested', 'basic'), '待授权');
  assert.equal(statusLabelFor('uploaded', 'basic'), '待上传');
  assert.equal(statusLabelFor('bound', 'basic'), '已绑定');
});

// —— 状态机（服务层，注册前即可跑）——
test('state machine: unbound → uploaded (recordUpload)', async () => {
  await recordUpload({ tenantId: tenantA, userId: tokenA, sourceKey: 'funnel', knowledgeId: 'k_funnel_1' });
  const view = await listForUser({ tenantId: tenantA, userId: tokenA });
  const funnel = view.sources.find((s) => s.key === 'funnel')!;
  assert.equal(funnel.status, 'uploaded');
  assert.equal(funnel.statusLabel, '待上传');
  // metaJson 落 knowledgeId
  const row = await prisma.userDataSource.findUnique({ where: { userId_sourceKey: { userId: tokenA, sourceKey: 'funnel' } } });
  assert.equal((row!.metaJson as { knowledgeId?: string }).knowledgeId, 'k_funnel_1');
  assert.equal(row!.method, 'upload');
});

test('state machine: unbound → auth_requested (requestAuth)', async () => {
  await requestAuth({ tenantId: tenantA, userId: tokenA, sourceKey: 'crm' });
  const view = await listForUser({ tenantId: tenantA, userId: tokenA });
  const crm = view.sources.find((s) => s.key === 'crm')!;
  assert.equal(crm.status, 'auth_requested');
  assert.equal(crm.statusLabel, '待授权');
  const row = await prisma.userDataSource.findUnique({ where: { userId_sourceKey: { userId: tokenA, sourceKey: 'crm' } } });
  assert.equal(row!.method, 'oauth');
});

// —— @@unique 幂等：双写 = 一行 ——
test('@@unique idempotency: double upload = one row', async () => {
  await recordUpload({ tenantId: tenantA, userId: tokenA, sourceKey: 'shop' });
  await recordUpload({ tenantId: tenantA, userId: tokenA, sourceKey: 'shop', knowledgeId: 'k_shop_2' });
  const rows = await prisma.userDataSource.findMany({ where: { userId: tokenA, sourceKey: 'shop' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'uploaded');
});

// —— 注入块 ——
test('dataSourcesBlock: null when none, lists bound/uploaded otherwise', async () => {
  assert.equal(await dataSourcesBlock(tokenB), null); // B 无任何接入
  const block = await dataSourcesBlock(tokenA);
  assert.ok(block, 'A 已有 uploaded 来源应产出块');
  assert.match(block!, /已接入数据源/);
  assert.match(block!, /成交漏斗数据（已上传）/);
});

// —— hero 计数 ——
test('hero: bound / needed(basic unbound) / total=8', async () => {
  const view = await listForUser({ tenantId: tenantA, userId: tokenA });
  assert.equal(view.total, 8);
  // A 已: funnel(uploaded) shop(uploaded) crm(auth_requested)。bound 仍为 0。
  assert.equal(view.bound, 0);
  // needed = unbound 且 basic：6 basic - funnel - shop = 4
  assert.equal(view.needed, 4);
});

// —— HTTP 集成（父 agent 注册路由后转绿；注册前 404）——
test('GET /data-sources returns merged catalog', async () => {
  const r = await api('GET', '/api/data-sources', { token: tokenA });
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 8);
  assert.equal(r.body.sources.length, 8);
  assert.equal(r.body.sources.find((s: any) => s.key === 'funnel').status, 'uploaded');
});

test('unknown key → 404 with code', async () => {
  const r = await api('POST', '/api/data-sources/not-a-source/upload', { token: tokenA, body: {} });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'DATA_SOURCE_NOT_FOUND');
});

test('unauthenticated → 401', async () => {
  const r = await api('GET', '/api/data-sources', {});
  assert.equal(r.status, 401);
});

// TC-G 跨租户隔离：B 看不到 A 的 uploaded 状态（服务层 + HTTP 双证）
test('TC-G cross-tenant isolation', async () => {
  // 服务层：B 的视图全 unbound，且 needed=6（全部基础未接入）
  const bView = await listForUser({ tenantId: tenantB, userId: tokenB });
  assert.ok(bView.sources.every((s) => s.status === 'unbound'), 'B 应全部 unbound');
  assert.equal(bView.needed, 6);
  assert.equal(bView.bound, 0);
  // HTTP：B GET 同样看不到 A 的 funnel=uploaded
  const r = await api('GET', '/api/data-sources', { token: tokenB });
  assert.equal(r.status, 200);
  assert.equal(r.body.sources.find((s: any) => s.key === 'funnel').status, 'unbound');
});
