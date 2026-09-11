// 后台路由的产品闸。
//
// 在这之前只有爱速拍那几条新路由有闸，军师那 40 多条（智能体 / 话术 / 邀请体系 / 内容池）
// 一道都没有 —— 前端的产品视角只是视图过滤，curl 直接打就绕过去了。
// 这组用例盯两件事：该拦的拦住了，**该放的一条都没误伤**（误伤比漏拦更容易上线才发现）。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api } from './helpers.js';
import { createOperator, createSession } from '../src/services/adminAccount.js';
import { PRODUCT } from '../src/services/products.js';
import { productOfAdminPath, DEFAULT_PRODUCT } from '../src/services/adminProductGate.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

before(async () => { await getApp(); await seedBaseline(); });
after(async () => { await closeApp(); });
beforeEach(async () => { await cleanBusiness(); });

async function operator(grant?: { product: string; role: 'viewer' | 'editor' }) {
  const acc = await createOperator(`gate_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, 'pw-123456', 'operator');
  if (grant) {
    await prisma.adminProductAccess.create({
      data: { productCode: grant.product, accountId: acc.id, role: grant.role },
    });
  }
  return { id: acc.id, token: await createSession(acc.id) };
}

/* ── 前缀判定 ── */

test('共享面不归任何产品 —— 钱包是一个、账号中心是一个、审计是一处', () => {
  for (const p of [
    '/admin/users', '/admin/users/abc/credits', '/admin/payments', '/admin/usage',
    '/admin/audit', '/admin/moderation-logs', '/admin/observability/x',
    '/admin/ai-endpoints', '/admin/model', '/admin/accounts', '/admin/plans',
    '/admin/products', '/admin/products/ledger', '/admin/overview', '/admin/flags',
  ]) {
    assert.equal(productOfAdminPath(p), null, `${p} 是共享面，切开另一边就查不了账`);
  }
});

test('爱速拍专属前缀归 quickreel', () => {
  for (const p of ['/admin/video/ops', '/admin/video/holds/x/reconcile', '/admin/video/templates']) {
    assert.equal(productOfAdminPath(p), PRODUCT.quickreel, p);
  }
});

// 前缀表存在的全部理由：新增路由默认**不是**敞开的。逐路由标注的话，
// 半年后有人加一条忘了标就是无闸；这里忘了列，它落进军师、默认要授权。
test('没列进表的路径默认归军师，不是默认放行', () => {
  assert.equal(productOfAdminPath('/admin/whatever-someone-adds-next-year'), DEFAULT_PRODUCT);
  assert.equal(productOfAdminPath('/admin/agents'), DEFAULT_PRODUCT);
  assert.equal(productOfAdminPath('/admin/sayings'), DEFAULT_PRODUCT);
});

test('不是 /admin 的路径不归这一闸管', () => {
  assert.equal(productOfAdminPath('/video/templates'), null);
  assert.equal(productOfAdminPath('/me'), null);
});

test('大小写与查询串不影响判定 —— 别让 ?x= 或大写绕过去', () => {
  assert.equal(productOfAdminPath('/ADMIN/AGENTS'), DEFAULT_PRODUCT);
  assert.equal(productOfAdminPath('/admin/video/ops?days=7'), PRODUCT.quickreel);
  assert.equal(productOfAdminPath('/admin/users?q=x'), null);
});

// 下面几条都是「看着像共享面 / 看着不像后台路径」的绕法。这一闸的价值全在
// 「以后新加的路由默认被拦」，靠「今天恰好没有那样的路由」撑着等于没有闸。
test('前缀必须落在路径段边界上 —— /admin/usersomething 不是 /admin/users', () => {
  assert.equal(productOfAdminPath('/admin/usersomething'), DEFAULT_PRODUCT);
  assert.equal(productOfAdminPath('/admin/models-secret'), DEFAULT_PRODUCT);
  assert.equal(productOfAdminPath('/admin/plansx'), DEFAULT_PRODUCT);
  // 真的共享面照样放行
  assert.equal(productOfAdminPath('/admin/users'), null);
  assert.equal(productOfAdminPath('/admin/users/abc/credits'), null);
  assert.equal(productOfAdminPath('/admin/users/'), null);
});

test('多余斜杠不能让一条后台路径看起来不像后台路径', () => {
  assert.equal(productOfAdminPath('//admin/agents'), DEFAULT_PRODUCT);
  assert.equal(productOfAdminPath('/admin//agents'), DEFAULT_PRODUCT);
  assert.equal(productOfAdminPath('///admin///video///ops'), PRODUCT.quickreel);
});

test('百分号编码不能绕过判定', () => {
  assert.equal(productOfAdminPath('/%61dmin/agents'), DEFAULT_PRODUCT, 'admin 被编码了');
  assert.equal(productOfAdminPath('/admin/%76ideo/ops'), PRODUCT.quickreel, 'video 被编码了');
  // 非法编码不抛，按原串比，落到默认产品（拦），不是放行
  assert.equal(productOfAdminPath('/admin/%zz'), DEFAULT_PRODUCT);
});

test('/admin/ai- 这种带连字符的族前缀照常整族命中', () => {
  for (const p of ['/admin/ai-endpoints', '/admin/ai-routes/x', '/admin/ai-v2', '/admin/ai-dialects']) {
    assert.equal(productOfAdminPath(p), null, `${p} 是平台基建`);
  }
});

/* ── 真打路由 ── */

test('只被授予爱速拍的运营，打不了军师的面', async () => {
  const op = await operator({ product: PRODUCT.quickreel, role: 'editor' });
  for (const p of ['/api/admin/agents', '/api/admin/sayings', '/api/admin/benchmarks']) {
    const r = await api('GET', p, { adminToken: op.token });
    assert.equal(r.status, 403, `${p} 没拦住 —— 前端看不见不等于访问控制`);
  }
});

test('「增长」组也在闸后 —— 它和 admin 共用 requireAdmin，最容易被漏掉', async () => {
  const op = await operator({ product: PRODUCT.quickreel, role: 'editor' });
  // referral / distribution / invites 是三个独立注册的插件，各自 addHook(requireAdmin)。
  // 闸挂在 requireAdmin 里而不是 admin.ts 的 preHandler 里，就是为了一次盖住它们。
  for (const p of ['/api/admin/referral/overview', '/api/admin/invites', '/api/admin/distributors']) {
    const r = await api('GET', p, { adminToken: op.token });
    assert.notEqual(r.status, 200, `${p} 是军师的面，爱速拍运营不该拿到数据`);
  }
});

test('共享面照常放行 —— 误伤比漏拦更难发现', async () => {
  const op = await operator({ product: PRODUCT.quickreel, role: 'viewer' });
  for (const p of ['/api/admin/users', '/api/admin/payments', '/api/admin/usage', '/api/admin/products']) {
    const r = await api('GET', p, { adminToken: op.token });
    assert.equal(r.status, 200, `${p} 被误伤了：这是共享面，切开爱速拍运营就查不了账`);
  }
});

test('军师运营打得了军师的面，打不了爱速拍的', async () => {
  const op = await operator({ product: PRODUCT.junshi, role: 'editor' });
  assert.equal((await api('GET', '/api/admin/agents', { adminToken: op.token })).status, 200);
  assert.equal((await api('GET', '/api/admin/video/ops', { adminToken: op.token })).status, 403);
});

test('超管隐式拥有全部产品，这一闸对他空转', async () => {
  for (const p of ['/api/admin/agents', '/api/admin/video/ops', '/api/admin/users']) {
    const r = await api('GET', p); // 默认带 master ADMIN_TOKEN
    assert.notEqual(r.status, 403, `${p} 把超管也关掉了`);
  }
});

// 今天全平台只有一个超管、没有任何 AdminProductAccess 行，所以这一闸上线零成本。
// 但「一个授权都没有的 operator」这个状态迟早会出现（新建账号还没发授权），
// 那时他应该看得见共享面、看不见任何产品面 —— 而不是整个后台白屏。
// 这个函数只会被 requireAdmin 调到，而 requireAdmin 只挂在后台路由插件上 ——
// 走到这里的请求本来就该长成 /admin/...。长得不像说明路径被做了手脚，
// 或者以后有人把 hook 挂到了别处。两种情况「看不懂就放行」都是错的方向。
test('异常路径按「要授权」处理，不是放行', async () => {
  const { enforceAdminProductAccess, looksLikeAdminPath } = await import('../src/services/adminProductGate.js');
  assert.equal(looksLikeAdminPath('/notadmin/x'), false);

  const op = await operator({ product: PRODUCT.quickreel, role: 'viewer' });
  const acc = await prisma.adminAccount.findUnique({ where: { id: op.id } });
  const actor = { kind: 'account' as const, id: op.id, role: acc!.role, username: acc!.username };
  // 一个不像后台路径的 url：有爱速拍授权但没有军师授权 → 按默认产品（军师）拦
  await assert.rejects(
    () => enforceAdminProductAccess({ raw: { url: '/notadmin/whatever' } } as never, actor),
    /权限/,
  );
});

test('一个授权都没有的运营：共享面还在，产品面全关', async () => {
  const op = await operator();
  assert.equal((await api('GET', '/api/admin/users', { adminToken: op.token })).status, 200, '共享面不该被关掉');
  assert.equal((await api('GET', '/api/admin/agents', { adminToken: op.token })).status, 403);
  assert.equal((await api('GET', '/api/admin/video/ops', { adminToken: op.token })).status, 403);
});
