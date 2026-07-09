// V7-12：单次付费商品（SKU）。下单/回调复用 PaymentOrder 幂等底座，markPaidAndApply 按 skuKey 分流发放权益。
// 不触网：直接调 markPaidAndApply（= 沙箱/真实 notify 内部同一路径），聚焦三 kind 发放 + 幂等 + 跨租户隔离。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { markPaidAndApply } from '../src/services/wechatPay.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.js';

// admin 路由鉴权：设置共享 ADMIN_TOKEN（与 helpers.api 的 x-admin-token 自动附带一致）。
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

let token = '', userId = '', tenantId = '', otherToken = '';

before(async () => { await getApp(); });
after(async () => { await closeApp(); });

beforeEach(async () => {
  await cleanBusiness();
  await seedBaseline();
  token = await login(uniquePhone(), 'SKU 用户');
  userId = token;
  const u = await prisma.user.findUnique({ where: { id: userId } });
  tenantId = u!.tenantId;
  otherToken = await login(uniquePhone(), '隔壁用户');
});

async function makeSkuOrder(outTradeNo: string, skuKey: string, uid = userId, tid = tenantId): Promise<void> {
  const sku = await prisma.sku.findUnique({ where: { key: skuKey } });
  await prisma.paymentOrder.create({
    data: { outTradeNo, tenantId: tid, userId: uid, planId: '', skuKey, amount: sku!.priceFen, provider: 'mock', status: 'created' },
  });
}

test('GET /skus 返回启用商品目录', async () => {
  const r = await api('GET', '/api/skus', {});
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.ok(r.body.some((s: { key: string }) => s.key === 'deep-organize'), '含深度整理 SKU');
  assert.ok(r.body.every((s: { priceFen: unknown }) => typeof s.priceFen === 'number'), '每条带分价');
});

test('未配支付且非沙箱：下单 501 PAYMENT_NOT_CONFIGURED', async () => {
  const r = await api('POST', '/api/skus/deep-contradiction/order', { token, body: { openid: 'ox_test' } });
  assert.equal(r.status, 501);
  assert.equal(r.body.code, 'PAYMENT_NOT_CONFIGURED');
});

test('未知 SKU：下单 404', async () => {
  const r = await api('POST', '/api/skus/nope/order', { token, body: { openid: 'ox_test' } });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'SKU_NOT_FOUND');
});

test('module SKU 回调：启用对应能力（UserModule source=purchase）', async () => {
  await makeSkuOrder('ot_sku_mod', 'deep-contradiction');
  const r = await markPaidAndApply({ outTradeNo: 'ot_sku_mod', tradeState: 'SUCCESS', rawJson: {} });
  assert.equal(r.applied, true);
  const um = await prisma.userModule.findUnique({ where: { userId_moduleKey: { userId, moduleKey: 'deep-contradiction' } } });
  assert.ok(um && um.enabled && um.source === 'purchase', '模块被启用并标为购买');
});

test('service SKU 回调：记一次性服务凭据 sku:<key>', async () => {
  await makeSkuOrder('ot_sku_svc', 'deep-organize');
  const r = await markPaidAndApply({ outTradeNo: 'ot_sku_svc', tradeState: 'SUCCESS', rawJson: {} });
  assert.equal(r.applied, true);
  const cred = await prisma.userModule.findUnique({ where: { userId_moduleKey: { userId, moduleKey: 'sku:deep-organize' } } });
  assert.ok(cred && cred.source === 'purchase', '一次性服务凭据落库');
});

test('storage SKU 回调：空间加档写 Profile.extraJson.storageBonus', async () => {
  await prisma.profile.create({ data: { tenantId, industry: '零售' } });
  await makeSkuOrder('ot_sku_sto', 'storage-2g');
  const r = await markPaidAndApply({ outTradeNo: 'ot_sku_sto', tradeState: 'SUCCESS', rawJson: {} });
  assert.equal(r.applied, true);
  const p = await prisma.profile.findFirst({ where: { tenantId } });
  const bonus = Number((p!.extraJson as { storageBonus?: number }).storageBonus ?? 0);
  assert.ok(bonus > 0, '空间加档字节数 > 0');
});

test('重复回调幂等：权益只发一次', async () => {
  await makeSkuOrder('ot_sku_idem', 'deep-contradiction');
  const r1 = await markPaidAndApply({ outTradeNo: 'ot_sku_idem', tradeState: 'SUCCESS', rawJson: {} });
  const r2 = await markPaidAndApply({ outTradeNo: 'ot_sku_idem', tradeState: 'SUCCESS', rawJson: {} });
  assert.equal(r1.applied, true);
  assert.equal(r2.applied, false);
  assert.equal(r2.reason, 'already_applied');
  const cnt = await prisma.userModule.count({ where: { userId, moduleKey: 'deep-contradiction' } });
  assert.equal(cnt, 1, '模块启用行仅一条');
});

test('跨租户隔离：A 的 SKU 回调不影响 B', async () => {
  await makeSkuOrder('ot_sku_iso', 'deep-contradiction');
  await markPaidAndApply({ outTradeNo: 'ot_sku_iso', tradeState: 'SUCCESS', rawJson: {} });
  const bModules = await prisma.userModule.count({ where: { userId: otherToken } });
  assert.equal(bModules, 0, 'B 无任何模块授权');
});

test('GET /admin/skus 列出全部 SKU（含 enabled/sort）', async () => {
  const r = await api('GET', '/api/admin/skus', {});
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 6);
  assert.ok(r.body.every((s: { enabled: unknown; sort: unknown }) => typeof s.enabled === 'boolean' && typeof s.sort === 'number'));
});

test('PATCH /admin/skus/:key 改价 + 启停（停用后不公开）', async () => {
  const r = await api('PATCH', '/api/admin/skus/deep-organize', { body: { priceFen: 4900, enabled: false } });
  assert.equal(r.status, 200);
  assert.equal(r.body.priceFen, 4900);
  assert.equal(r.body.enabled, false);
  const pub = await api('GET', '/api/skus', {});
  assert.ok(!pub.body.some((s: { key: string }) => s.key === 'deep-organize'), '停用的 SKU 不在公开目录');
});

test('PATCH 未知 SKU → 404', async () => {
  const r = await api('PATCH', '/api/admin/skus/nope', { body: { priceFen: 100 } });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'SKU_NOT_FOUND');
});

test('admin 路由需鉴权：无 admin token → 401/403', async () => {
  const r = await api('GET', '/api/admin/skus', { adminToken: false });
  assert.ok(r.status === 401 || r.status === 403, `期望 401/403，实际 ${r.status}`);
});
