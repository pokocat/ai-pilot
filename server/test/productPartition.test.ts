// 平台后台按产品分区 + 钱包按产品记账。
//
// 两件事其实是一件：后台是一个、按 productCode 分区，钱包也是一个、按 productCode 切账。
// 这组用例盯的是这条键在两处都真的生效，而不是只写在注释里。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, uniquePhone } from './helpers.js';
import { createOperator, createSession } from '../src/services/adminAccount.js';
import { chargeCredits, grantCredits, getBalance } from '../src/services/credits.js';
import { PRODUCT, productLedgerSlices } from '../src/services/products.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

before(async () => { await getApp(); await seedBaseline(); });
after(async () => { await closeApp(); });
beforeEach(async () => { await cleanBusiness(); });

async function operator(): Promise<{ id: string; token: string }> {
  const acc = await createOperator(`op_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, 'pw-123456', 'operator');
  return { id: acc.id, token: await createSession(acc.id) };
}

async function mkUser() {
  const tenant = await prisma.tenant.create({ data: { name: '分区测试企业' } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, phone: uniquePhone(), name: '分区用户', role: 'owner' },
  });
  return { tenantId: tenant.id, userId: user.id };
}

/* ── 钱包：一个钱包，按产品记账 ── */

test('同一个钱包，军师和爱速拍各记各的账', async () => {
  const { tenantId, userId } = await mkUser();
  await grantCredits(tenantId, userId, 100, '充值', PRODUCT.junshi);
  await chargeCredits(tenantId, userId, 30, '产出', PRODUCT.junshi);
  await chargeCredits(tenantId, userId, 20, '出片', PRODUCT.quickreel);

  // 钱包是一个：军师充的钱，爱速拍花得动。分钱包的话这里得先转账。
  assert.equal(await getBalance(userId), 50);

  const slices = await productLedgerSlices(new Date(Date.now() - 3600_000), new Date(Date.now() + 3600_000));
  const junshi = slices.find((s) => s.productCode === PRODUCT.junshi);
  const quickreel = slices.find((s) => s.productCode === PRODUCT.quickreel);
  assert.equal(junshi?.granted, 100, '收入归属：从军师的入口卖出去的');
  assert.equal(junshi?.spent, 30);
  assert.equal(quickreel?.granted, 0, '爱速拍还没有自己的充值入口');
  assert.equal(quickreel?.spent, 20, '消耗归属：花在爱速拍上的');
});

test('出片走的是爱速拍的账，不记到军师头上', async () => {
  const { tenantId, userId } = await mkUser();
  await grantCredits(tenantId, userId, 200, '充值', PRODUCT.junshi);
  const { reserveVideoCredits } = await import('../src/services/video/credits.js');
  await reserveVideoCredits({
    tenantId, userId, projectId: 'cp_slice', clientRequestId: 'slice:req:0001', credits: 12,
  });
  const rows = await prisma.creditLedger.findMany({ where: { userId, delta: { lt: 0 } } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].productCode, PRODUCT.quickreel, '出片预扣必须记在爱速拍名下');

  const hold = await prisma.videoCreditHold.findFirst({ where: { userId } });
  assert.equal(hold?.productCode, PRODUCT.quickreel, 'hold 与流水同一套归属，对账才对得上');
});

test('归属为空的历史流水单列，不摊进任何产品', async () => {
  const { tenantId, userId } = await mkUser();
  await grantCredits(tenantId, userId, 50, '充值', PRODUCT.junshi);
  // 直接写一行没有归属的，模拟本列上线之前的存量
  await prisma.creditLedger.create({
    data: { tenantId, userId, delta: -7, reason: '历史消耗', balance: 43 },
  });
  const slices = await productLedgerSlices(new Date(Date.now() - 3600_000), new Date(Date.now() + 3600_000));
  const orphan = slices.find((s) => s.productCode === 'unattributed');
  assert.equal(orphan?.spent, 7, '摊进任一产品就是编造归属');
  assert.equal(slices.find((s) => s.productCode === PRODUCT.junshi)?.spent, 0);
});

/* ── 后台：按产品分区 ── */

test('超管看得到全部产品', async () => {
  const res = await api('GET', '/api/admin/products');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.superActor, true);
  assert.deepEqual(res.body.accessible.sort(), [PRODUCT.junshi, PRODUCT.quickreel].sort());
});

test('没被授权的运营，一个产品都看不到', async () => {
  const op = await operator();
  const res = await api('GET', '/api/admin/products', { adminToken: op.token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.superActor, false);
  assert.deepEqual(res.body.accessible, []);
});

test('只授爱速拍的运营，看得到爱速拍、看不到军师', async () => {
  const op = await operator();
  const grant = await api('PUT', `/api/admin/accounts/${op.id}/products`, {
    body: { productCode: PRODUCT.quickreel, role: 'editor' },
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));

  const res = await api('GET', '/api/admin/products', { adminToken: op.token });
  assert.deepEqual(res.body.accessible, [PRODUCT.quickreel]);
});

test('授了爱速拍才看得到爱速拍的价', async () => {
  const op = await operator();
  const before = await api('GET', '/api/admin/video/clone-pricing', { adminToken: op.token });
  assert.equal(before.status, 403, '没授权连读都不给');
  assert.equal(before.body.code, 'ADMIN_PRODUCT_FORBIDDEN');

  await api('PUT', `/api/admin/accounts/${op.id}/products`, {
    body: { productCode: PRODUCT.quickreel, role: 'editor' },
  });
  const after = await api('GET', '/api/admin/video/clone-pricing', { adminToken: op.token });
  assert.equal(after.status, 200, JSON.stringify(after.body));
});

test('产品授权不放松营收管控：改价仍然要超管', async () => {
  // 加产品分区是加一个维度，不是替换既有的闸。改价与套餐改价、海报改价同级，
  // 一直是超管动作（videoClonePricing 用例写明了这条政策）；顺手放松掉是另一件事，
  // 要放也该单独决定，不该作为分区的副作用。
  const op = await operator();
  await api('PUT', `/api/admin/accounts/${op.id}/products`, {
    body: { productCode: PRODUCT.quickreel, role: 'editor' },
  });
  const write = await api('PUT', '/api/admin/video/clone-pricing', {
    adminToken: op.token, body: { avatarCredits: 999 },
  });
  assert.equal(write.status, 403, '有产品授权也改不了价');
  assert.equal(write.body.code, 'OWNER_ONLY', '拒绝的理由仍是「要超管」，不是「没产品权限」');
});

test('收回授权后立刻失效', async () => {
  const op = await operator();
  await api('PUT', `/api/admin/accounts/${op.id}/products`, {
    body: { productCode: PRODUCT.quickreel, role: 'editor' },
  });
  assert.equal((await api('GET', '/api/admin/video/clone-pricing', { adminToken: op.token })).status, 200);
  await api('PUT', `/api/admin/accounts/${op.id}/products`, {
    body: { productCode: PRODUCT.quickreel, role: null },
  });
  assert.equal((await api('GET', '/api/admin/video/clone-pricing', { adminToken: op.token })).status, 403);
});

test('运营改不了自己的产品授权', async () => {
  const op = await operator();
  const res = await api('PUT', `/api/admin/accounts/${op.id}/products`, {
    adminToken: op.token, body: { productCode: PRODUCT.quickreel, role: 'editor' },
  });
  assert.equal(res.status, 403, '授权变更只有超管能做');
});

test('未知产品码一律拒收，不写进授权表', async () => {
  const op = await operator();
  const res = await api('PUT', `/api/admin/accounts/${op.id}/products`, {
    body: { productCode: 'not-a-product', role: 'editor' },
  });
  assert.equal(res.status, 422);
  assert.equal(await prisma.adminProductAccess.count({ where: { accountId: op.id } }), 0);
});

test('分产品账只给看得见的产品，unattributed 只有超管看得到', async () => {
  const { tenantId, userId } = await mkUser();
  await grantCredits(tenantId, userId, 100, '充值', PRODUCT.junshi);
  await chargeCredits(tenantId, userId, 10, '出片', PRODUCT.quickreel);
  await prisma.creditLedger.create({
    data: { tenantId, userId, delta: -1, reason: '历史', balance: 89 },
  });

  const su = await api('GET', '/api/admin/products/ledger');
  assert.equal(su.status, 200, JSON.stringify(su.body));
  const suCodes = su.body.slices.map((s: { productCode: string }) => s.productCode);
  assert.ok(suCodes.includes('unattributed'), '超管该看到没归属的那部分');

  const op = await operator();
  await api('PUT', `/api/admin/accounts/${op.id}/products`, {
    body: { productCode: PRODUCT.quickreel, role: 'viewer' },
  });
  const res = await api('GET', '/api/admin/products/ledger', { adminToken: op.token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const codes = res.body.slices.map((s: { productCode: string }) => s.productCode);
  assert.deepEqual(codes, [PRODUCT.quickreel], '看不见军师，也看不见 unattributed');
});

test('时间区间非法当场拒收', async () => {
  const res = await api('GET', '/api/admin/products/ledger?from=2026-02-01&to=2026-01-01');
  assert.equal(res.status, 422);
});
