// 微信支付【真实代码路径】集成测试：本地 mock 微信网关 + 真实监听端口的 app。
// 与 wechatPay.test.ts（直调 markPaidAndApply 的幂等/并发）互补，本文件覆盖完整加解密链路：
//   商户请求签名 → mock 网关验签发 prepay_id → paySign 可验 →
//   官方格式加密回调（AES-256-GCM + 平台签名）→ /pay/wechat/notify 验签解密入账 →
//   重复回调幂等 → 篡改签名 401 → 回调丢失时 GET /pay/orders/:no 主动查单补账。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { buildWechatPayMock, generateWechatPayMockKeys, type WechatPayMock } from '../src/services/wechatPayMock.js';
import { sweepPendingOrders, resetPlatformCertCache, fetchPlatformCertificates } from '../src/services/wechatPay.js';
import { seedBaseline, cleanBusiness } from './helpers.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

const APP_ID = 'wxmocktestappid1';
const MCH_ID = '1900008888';
const API_V3_KEY = randomBytes(16).toString('hex');
const keys = generateWechatPayMockKeys();

const PAY_ENV_KEYS = ['WECHAT_PAY_BASE', 'WECHAT_MINI_APPID', 'WECHAT_PAY_MCHID', 'WECHAT_PAY_APIV3_KEY', 'WECHAT_PAY_CERT_SERIAL', 'WECHAT_PAY_PRIVATE_KEY', 'WECHAT_PAY_PLATFORM_CERT', 'WECHAT_PAY_NOTIFY_URL'] as const;
const savedEnv: Record<string, string | undefined> = {};

let app: FastifyInstance;
let mock: WechatPayMock;
let api = '';
let userId = '', tenantId = '', planId = '', planName = '', planPrice = 0;

const http = async (method: string, url: string, opts: { user?: string; admin?: boolean; body?: unknown } = {}) => {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.user) headers['x-user-id'] = opts.user;
  if (opts.admin) headers['x-admin-token'] = process.env.ADMIN_TOKEN!;
  const res = await fetch(api + url, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  let body: any = null; try { body = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, body };
};

before(async () => {
  for (const k of PAY_ENV_KEYS) savedEnv[k] = process.env[k];

  mock = buildWechatPayMock({ appId: APP_ID, mchId: MCH_ID, apiV3Key: API_V3_KEY, keys });
  await mock.app.listen({ port: 0, host: '127.0.0.1' });
  const mockPort = (mock.app.server.address() as { port: number }).port;

  process.env.WECHAT_PAY_BASE = `http://127.0.0.1:${mockPort}`;
  process.env.WECHAT_MINI_APPID = APP_ID;
  process.env.WECHAT_PAY_MCHID = MCH_ID;
  process.env.WECHAT_PAY_APIV3_KEY = API_V3_KEY;
  process.env.WECHAT_PAY_CERT_SERIAL = keys.merchantSerial;
  process.env.WECHAT_PAY_PRIVATE_KEY = keys.merchantPrivateKeyPem;
  process.env.WECHAT_PAY_PLATFORM_CERT = keys.platformPublicKeyPem;

  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const appPort = (app.server.address() as { port: number }).port;
  api = `http://127.0.0.1:${appPort}/api`;
  process.env.WECHAT_PAY_NOTIFY_URL = `${api}/pay/wechat/notify`;

  await cleanBusiness();
  await seedBaseline();
  const tenant = await prisma.tenant.create({ data: { name: 'MockFlowCo' } });
  tenantId = tenant.id;
  const user = await prisma.user.create({ data: { tenantId, phone: '13900000077', name: '真实链路用户', role: 'owner', wechatOpenId: 'o_mockflow_1' } });
  userId = user.id;
  const plan = await prisma.plan.findFirst({ where: { period: 'month', price: { gt: 0 } }, orderBy: { sort: 'asc' } });
  assert.ok(plan, '缺少付费月付套餐（seedBaseline 应已灌入）');
  planId = plan!.id; planName = plan!.name; planPrice = plan!.price;
});

after(async () => {
  for (const k of PAY_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await app?.close();
  await mock?.app.close();
  await prisma.$disconnect();
});

test('下单：商户签名过 mock 网关验签，prepay/paySign/落库正确', async () => {
  const r = await http('POST', `/plans/${planId}/order`, { user: userId, body: { openid: 'o_mockflow_1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  const mo = mock.orders.get(r.body.outTradeNo);
  assert.ok(mo, 'mock 网关应收到订单');
  assert.equal(mo!.tradeState, 'NOTPAY');
  assert.equal(mo!.amountTotal, planPrice);
  assert.equal(r.body.pay.package, `prepay_id=${mo!.prepayId}`);
  const ok = createVerify('RSA-SHA256')
    .update(`${APP_ID}\n${r.body.pay.timeStamp}\n${r.body.pay.nonceStr}\n${r.body.pay.package}\n`)
    .verify(keys.merchantPublicKeyPem, r.body.pay.paySign, 'base64');
  assert.ok(ok, '调起参数 paySign 应可用商户公钥验签');
  const db = await prisma.paymentOrder.findUnique({ where: { outTradeNo: r.body.outTradeNo } });
  assert.equal(db!.provider, 'wechat');
  assert.equal(db!.status, 'created');
  assert.ok(db!.prepayId);
});

test('加密回调入账 → 重复回调幂等 → 篡改签名 401', async () => {
  const r = await http('POST', `/plans/${planId}/order`, { user: userId, body: { openid: 'o_mockflow_1' } });
  const outTradeNo = r.body.outTradeNo as string;
  const before = await prisma.creditLedger.count({ where: { userId } });

  const paid = await mock.payOrder(outTradeNo);
  assert.equal(paid.notifyStatus, 200, paid.notifyBody);
  const db = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
  assert.equal(db!.status, 'applied');
  assert.ok(db!.transactionId?.startsWith('mocktx_'));
  assert.equal(await prisma.creditLedger.count({ where: { userId } }), before + 1);
  const me = await http('GET', '/me', { user: userId });
  assert.equal(me.body.plan?.name, planName);

  const dup = await mock.redeliverNotify(outTradeNo);
  assert.equal(dup.notifyStatus, 200, '重复回调应答 200 让微信停止重试');
  assert.equal(await prisma.creditLedger.count({ where: { userId } }), before + 1, '重复回调不双发');

  const bad = await mock.redeliverNotify(outTradeNo, { tamperSignature: true });
  assert.equal(bad.notifyStatus, 401, '篡改签名的回调应被拒绝');
});

test('回调丢失：轮询 /pay/orders/:no 主动查单补账；未付时不误标失败', async () => {
  const r = await http('POST', `/plans/${planId}/order`, { user: userId, body: { openid: 'o_mockflow_1' } });
  const outTradeNo = r.body.outTradeNo as string;

  // 未支付时轮询：NOTPAY → 保持 created
  const poll0 = await http('GET', `/pay/orders/${outTradeNo}`, { user: userId });
  assert.equal(poll0.body.status, 'created');

  // mock 侧已支付但「回调丢失」→ 轮询触发查单补账
  await mock.payOrder(outTradeNo, { deliverNotify: false });
  const poll1 = await http('GET', `/pay/orders/${outTradeNo}`, { user: userId });
  assert.equal(poll1.body.status, 'applied', JSON.stringify(poll1.body));
  assert.ok(poll1.body.appliedAt);
  const db = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
  assert.ok(db!.transactionId?.startsWith('mocktx_'), '查单结果的 transaction_id 应落库');
});

test('订单归属校验：他人订单轮询 404', async () => {
  const r = await http('POST', `/plans/${planId}/order`, { user: userId, body: { openid: 'o_mockflow_1' } });
  const stranger = await prisma.user.create({ data: { tenantId, phone: '13900000078', name: '路人', role: 'member' } });
  const cross = await http('GET', `/pay/orders/${r.body.outTradeNo}`, { user: stranger.id });
  assert.equal(cross.status, 404);
});

test('降级守卫：活跃年付降月付 409，同套餐续费放行，过期后放行', async () => {
  const yearPlan = await prisma.plan.findFirst({ where: { period: 'year', price: { gt: 0 } }, orderBy: { sort: 'asc' } });
  assert.ok(yearPlan, '缺少付费年付套餐');
  const u = await prisma.user.create({ data: { tenantId, phone: '13900000079', name: '年付用户', role: 'owner', wechatOpenId: 'o_mockflow_year', planId: yearPlan!.id, planActivatedAt: new Date(), planExpiresAt: new Date(Date.now() + 200 * 86400_000) } });

  // 年付活跃 → 买月付 = 降级，409 且不落订单
  const down = await http('POST', `/plans/${planId}/order`, { user: u.id, body: { openid: 'o_mockflow_year' } });
  assert.equal(down.status, 409, JSON.stringify(down.body));
  assert.equal(down.body.code, 'PLAN_SWITCH_BLOCKED');
  assert.equal(await prisma.paymentOrder.count({ where: { userId: u.id } }), 0, '被拦下的降级不得创建订单');

  // 同套餐（年付）续费 → 放行
  const renew = await http('POST', `/plans/${yearPlan!.id}/order`, { user: u.id, body: { openid: 'o_mockflow_year' } });
  assert.equal(renew.status, 200, JSON.stringify(renew.body));

  // 年付过期 → 买月付放行
  await prisma.user.update({ where: { id: u.id }, data: { planExpiresAt: new Date(Date.now() - 86400_000) } });
  const afterExpire = await http('POST', `/plans/${planId}/order`, { user: u.id, body: { openid: 'o_mockflow_year' } });
  assert.equal(afterExpire.status, 200, JSON.stringify(afterExpire.body));
});

test('对账 sweep：回调丢失的已付单自动补账；微信侧无单的超期 created 自动关单', async () => {
  // A：真实下单 → mock 已支付但回调「丢失」 → 回溯 createdAt 使其进入 sweep 窗口（>15min）
  const r = await http('POST', `/plans/${planId}/order`, { user: userId, body: { openid: 'o_mockflow_1' } });
  const lostNo = r.body.outTradeNo as string;
  await mock.payOrder(lostNo, { deliverNotify: false });
  await prisma.paymentOrder.update({ where: { outTradeNo: lostNo }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } });

  // B：微信侧不存在的超期 created 单（用户从未调起支付且已过 time_expire）
  const ghostNo = `js_ghost_${Date.now()}`;
  await prisma.paymentOrder.create({
    data: { outTradeNo: ghostNo, tenantId, userId, planId, amount: planPrice, provider: 'wechat', status: 'created', createdAt: new Date(Date.now() - 3 * 3600_000) },
  });

  const stats = await sweepPendingOrders();
  assert.ok(stats.applied >= 1, `sweep 应补账丢回调的已付单：${JSON.stringify(stats)}`);
  assert.ok(stats.closed >= 1, `sweep 应关闭微信侧无单的超期单：${JSON.stringify(stats)}`);
  const lost = await prisma.paymentOrder.findUnique({ where: { outTradeNo: lostNo } });
  assert.equal(lost!.status, 'applied');
  const ghost = await prisma.paymentOrder.findUnique({ where: { outTradeNo: ghostNo } });
  assert.equal(ghost!.status, 'closed');
});

test('admin：卡单清单可见 + 手动查单补账（审计留痕）', async () => {
  // 造一笔「已支付但回调丢失」的卡单（回溯 40min 让它进入 stuck 的 created_stale 窗口）
  const r = await http('POST', `/plans/${planId}/order`, { user: userId, body: { openid: 'o_mockflow_1' } });
  const stuckNo = r.body.outTradeNo as string;
  await mock.payOrder(stuckNo, { deliverNotify: false });
  await prisma.paymentOrder.update({ where: { outTradeNo: stuckNo }, data: { createdAt: new Date(Date.now() - 40 * 60_000) } });

  const view = await http('GET', '/admin/payments', { admin: true });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const stuck = (view.body.stuck as { outTradeNo: string; kind: string }[]).find((o) => o.outTradeNo === stuckNo);
  assert.ok(stuck, '卡单应出现在 stuck 清单（带完整单号）');

  const rec = await http('POST', `/admin/payments/${stuckNo}/reconcile`, { admin: true });
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  assert.equal(rec.body.applied, true);
  assert.equal(rec.body.status, 'applied');
  const audit = await prisma.auditLog.findFirst({ where: { action: 'admin.pay.reconcile', userId }, orderBy: { createdAt: 'desc' } });
  assert.ok(audit, '手动补账应写审计');

  // 已入账订单重复补账：幂等，不再发放
  const again = await http('POST', `/admin/payments/${stuckNo}/reconcile`, { admin: true });
  assert.equal(again.body.applied, false);
});

test('条款快照：下单后改价仍按下单时配置发放；新单自动关同类旧单', async () => {
  const u = await prisma.user.create({ data: { tenantId, phone: '13900000080', name: '快照用户', role: 'owner', wechatOpenId: 'o_snap_1' } });
  const plan = (await prisma.plan.findUnique({ where: { id: planId } }))!;

  // 旧单 → 新单：旧 created 单被微信侧关单 + 本地 closed（消除陈旧单被后付窗口）
  const r1 = await http('POST', `/plans/${planId}/order`, { user: u.id, body: { openid: 'o_snap_1' } });
  const r2 = await http('POST', `/plans/${planId}/order`, { user: u.id, body: { openid: 'o_snap_1' } });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  const old = await prisma.paymentOrder.findUnique({ where: { outTradeNo: r1.body.outTradeNo } });
  assert.equal(old!.status, 'closed', '旧 created 单应被自动关闭');
  assert.equal(mock.orders.get(r1.body.outTradeNo)!.tradeState, 'CLOSED', '微信侧同步关单');

  // 支付前改价/改额度 → 发放仍按下单时快照
  await prisma.plan.update({ where: { id: planId }, data: { creditsPerMonth: plan.creditsPerMonth + 777, price: plan.price + 100 } });
  try {
    const before = await prisma.creditLedger.count({ where: { userId: u.id } });
    const paid = await mock.payOrder(r2.body.outTradeNo);
    assert.equal(paid.notifyStatus, 200, paid.notifyBody);
    const ledger = await prisma.creditLedger.findFirst({ where: { userId: u.id }, orderBy: { createdAt: 'desc' } });
    assert.equal(await prisma.creditLedger.count({ where: { userId: u.id } }), before + 1);
    assert.equal(ledger!.delta, plan.creditsPerMonth, '发放额 = 下单时快照的 creditsPerMonth，不吃改价后的新值');
    // 套餐订单归因（P2）：入账落 ActivationEvent(itemType=plan)
    const act = await prisma.activationEvent.findFirst({ where: { userId: u.id, itemType: 'plan', itemKey: planId } });
    assert.ok(act, '套餐入账应落开通归因事件');
  } finally {
    await prisma.plan.update({ where: { id: planId }, data: { creditsPerMonth: plan.creditsPerMonth, price: plan.price } });
  }
});

test('订单列表 + 继续支付：payable 单可重签调起参数；超时单 409', async () => {
  const u = await prisma.user.create({ data: { tenantId, phone: '13900000081', name: '续付用户', role: 'owner', wechatOpenId: 'o_repay_1' } });
  const r = await http('POST', `/plans/${planId}/order`, { user: u.id, body: { openid: 'o_repay_1' } });
  const no = r.body.outTradeNo as string;

  const list = await http('GET', '/pay/orders', { user: u.id });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const item = (list.body.items as { outTradeNo: string; payable: boolean; itemName: string; status: string }[]).find((x) => x.outTradeNo === no);
  assert.ok(item, '列表应包含本人订单');
  assert.equal(item!.payable, true, 'created 未超时 → 可继续支付');
  assert.equal(item!.itemName, planName, 'itemName 来自下单快照');

  const rp = await http('POST', `/pay/orders/${no}/pay-params`, { user: u.id });
  assert.equal(rp.status, 200, JSON.stringify(rp.body));
  assert.equal(rp.body.pay.package, `prepay_id=${mock.orders.get(no)!.prepayId}`, '重签参数复用原 prepay_id');

  // 继续支付后正常入账
  const paid = await mock.payOrder(no);
  assert.equal(paid.notifyStatus, 200);
  const list2 = await http('GET', '/pay/orders', { user: u.id });
  const item2 = (list2.body.items as { outTradeNo: string; status: string; payable: boolean }[]).find((x) => x.outTradeNo === no);
  assert.equal(item2!.status, 'applied');
  assert.equal(item2!.payable, false);

  // 超时单：回溯 115 分钟 → 继续支付 409
  const r3 = await http('POST', `/plans/${planId}/order`, { user: u.id, body: { openid: 'o_repay_1' } });
  await prisma.paymentOrder.update({ where: { outTradeNo: r3.body.outTradeNo }, data: { createdAt: new Date(Date.now() - 115 * 60_000) } });
  const rpExpired = await http('POST', `/pay/orders/${r3.body.outTradeNo}/pay-params`, { user: u.id });
  assert.equal(rpExpired.status, 409, JSON.stringify(rpExpired.body));
  assert.equal(rpExpired.body.code, 'ORDER_EXPIRED');

  // 他人订单：404
  const cross = await http('POST', `/pay/orders/${no}/pay-params`, { user: userId });
  assert.equal(cross.status, 404);
});

test('退款闭环：全额退款 + 套餐立即到期 + 追回算力 + 幂等', async () => {
  const u = await prisma.user.create({ data: { tenantId, phone: '13900000082', name: '退款用户', role: 'owner', wechatOpenId: 'o_refund_1' } });
  const r = await http('POST', `/plans/${planId}/order`, { user: u.id, body: { openid: 'o_refund_1' } });
  const no = r.body.outTradeNo as string;
  await mock.payOrder(no);
  const applied = await prisma.paymentOrder.findUnique({ where: { outTradeNo: no } });
  assert.equal(applied!.status, 'applied');
  const balBefore = (await prisma.creditLedger.findFirst({ where: { userId: u.id }, orderBy: { createdAt: 'desc' } }))!.balance;
  assert.ok(balBefore > 0, '入账后应有算力余额');

  const refund = await http('POST', `/admin/payments/${no}/refund`, { admin: true, body: { reason: '用户申请退款' } });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  assert.equal(refund.body.wechatStatus, 'SUCCESS');
  const after = await prisma.paymentOrder.findUnique({ where: { outTradeNo: no } });
  assert.equal(after!.status, 'refunded');
  assert.ok(after!.refundedAt && after!.refundId, '退款单号/时间落库');

  // 权益回收：套餐立即到期 + 本单发放算力被追回
  const user = await prisma.user.findUnique({ where: { id: u.id }, select: { planExpiresAt: true } });
  assert.ok(user!.planExpiresAt && user!.planExpiresAt.getTime() <= Date.now(), '套餐应立即到期');
  const last = await prisma.creditLedger.findFirst({ where: { userId: u.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  assert.ok(last!.delta < 0 && last!.reason.includes('退款追回'), `应有追回流水：${JSON.stringify(last)}`);
  assert.equal(last!.balance, 0, '全额追回后余额归零');

  // 幂等：重复退款 409
  const again = await http('POST', `/admin/payments/${no}/refund`, { admin: true, body: {} });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.code, 'ALREADY_REFUNDED');
});

test('下单频控：同一用户 10 分钟内第 11 单 429', async () => {
  const u = await prisma.user.create({ data: { tenantId, phone: '13900000083', name: '频控用户', role: 'owner', wechatOpenId: 'o_rate_1' } });
  for (let i = 0; i < 10; i++) {
    const r = await http('POST', `/plans/${planId}/order`, { user: u.id, body: { openid: 'o_rate_1' } });
    assert.equal(r.status, 200, `第 ${i + 1} 单应放行：${JSON.stringify(r.body)}`);
  }
  const blocked = await http('POST', `/plans/${planId}/order`, { user: u.id, body: { openid: 'o_rate_1' } });
  assert.equal(blocked.status, 429, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, 'ORDER_RATE_LIMITED');
});

test('admin 手动开通：无套餐用户直接开通套餐 + 发放/收回模块', async () => {
  const u = await prisma.user.create({ data: { tenantId, phone: '13900000084', name: '手动开通用户', role: 'owner' } });

  const grant = await http('POST', `/admin/users/${u.id}/plan`, { admin: true, body: { planId } });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  assert.equal(grant.body.planName, planName);
  assert.ok(grant.body.expiresAt, '付费套餐应带到期时间');
  const user = await prisma.user.findUnique({ where: { id: u.id }, select: { planId: true } });
  assert.equal(user!.planId, planId);
  const ledger = await prisma.creditLedger.findFirst({ where: { userId: u.id } });
  assert.ok(ledger && ledger.reason.includes('运营开通'), '发放流水标运营开通');

  const mod = await http('POST', `/admin/users/${u.id}/modules`, { admin: true, body: { moduleKey: 'deep-contradiction' } });
  assert.equal(mod.status, 200, JSON.stringify(mod.body));
  const um = await prisma.userModule.findUnique({ where: { userId_moduleKey: { userId: u.id, moduleKey: 'deep-contradiction' } } });
  assert.ok(um && um.enabled && um.source === 'admin');

  const revoke = await http('DELETE', `/admin/users/${u.id}/modules/deep-contradiction`, { admin: true });
  assert.equal(revoke.status, 200);
  const um2 = await prisma.userModule.findUnique({ where: { userId_moduleKey: { userId: u.id, moduleKey: 'deep-contradiction' } } });
  assert.equal(um2!.enabled, false);
});

test('平台证书自动下载/轮换：不配静态证书也能验签，篡改签名仍 401', async () => {
  const u = await prisma.user.create({ data: { tenantId, phone: '13900000085', name: '证书轮换用户', role: 'owner', wechatOpenId: 'o_cert_1' } });
  const savedCert = process.env.WECHAT_PAY_PLATFORM_CERT;
  delete process.env.WECHAT_PAY_PLATFORM_CERT; // 只留自动下载通道
  resetPlatformCertCache();
  try {
    const r = await http('POST', `/plans/${planId}/order`, { user: u.id, body: { openid: 'o_cert_1' } });
    const no = r.body.outTradeNo as string;
    const paid = await mock.payOrder(no);
    assert.equal(paid.notifyStatus, 200, `自动下载证书应验签通过：${paid.notifyBody}`);
    const db = await prisma.paymentOrder.findUnique({ where: { outTradeNo: no } });
    assert.equal(db!.status, 'applied');
    // 关键断言：篡改签名必须 401——证明验签确实用了下载的证书，而不是「无证书跳过」
    const bad = await mock.redeliverNotify(no, { tamperSignature: true });
    assert.equal(bad.notifyStatus, 401, '篡改签名应被下载证书拒绝');
  } finally {
    if (savedCert === undefined) delete process.env.WECHAT_PAY_PLATFORM_CERT;
    else process.env.WECHAT_PAY_PLATFORM_CERT = savedCert;
    resetPlatformCertCache();
  }
});

test('admin 订单搜索/分页/导出：q 命中单号与手机号、分页 total、CSV 含完整单号', async () => {
  const u = await prisma.user.create({ data: { tenantId, phone: '13711112222', name: '搜索目标用户', role: 'owner', wechatOpenId: 'o_search_1' } });
  const r1 = await http('POST', `/plans/${planId}/order`, { user: u.id, body: { openid: 'o_search_1' } });
  const r2 = await http('POST', `/plans/${planId}/order`, { user: u.id, body: { openid: 'o_search_1' } });
  const no2 = r2.body.outTradeNo as string;

  // q=手机号：命中该用户全部订单（含被关单的 r1）
  const byPhone = await http('GET', '/admin/payments?q=13711112222', { admin: true });
  assert.equal(byPhone.status, 200, JSON.stringify(byPhone.body));
  const nos = (byPhone.body.items as { outTradeNo: string }[]).map((x) => x.outTradeNo);
  assert.ok(nos.includes(no2) && nos.includes(r1.body.outTradeNo), `按手机号应命中订单：${JSON.stringify(nos)}`);
  assert.ok(byPhone.body.total >= 2);

  // q=单号后缀：精确命中一单
  const byNo = await http('GET', `/admin/payments?q=${no2.slice(-10)}`, { admin: true });
  assert.equal((byNo.body.items as { outTradeNo: string }[]).some((x) => x.outTradeNo === no2), true);

  // 分页：pageSize=1 → items 1 条、total 不变
  const page1 = await http('GET', '/admin/payments?q=13711112222&page=1&pageSize=1', { admin: true });
  assert.equal((page1.body.items as unknown[]).length, 1);
  assert.equal(page1.body.total, byPhone.body.total);
  assert.equal(page1.body.pageSize, 1);

  // 导出 CSV：master=super 放行，含完整单号与手机号
  const res = await fetch(`${api}/admin/payments/export?q=13711112222`, { headers: { 'x-admin-token': process.env.ADMIN_TOKEN! } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
  const csv = await res.text();
  assert.ok(csv.includes(no2) && csv.includes('13711112222'), 'CSV 应含完整单号与手机号');
});

test('例行 QA 安全修复：admin 导出 CSV 对疑似公式的用户昵称做中和（防 CSV/公式注入）', async () => {
  const u = await prisma.user.create({
    data: { tenantId, phone: '13744445555', name: '=HYPERLINK("http://evil.example","x")', role: 'owner', wechatOpenId: 'o_csv_inj_1' },
  });
  const r = await http('POST', `/plans/${planId}/order`, { user: u.id, body: { openid: 'o_csv_inj_1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const res = await fetch(`${api}/admin/payments/export?q=13744445555`, { headers: { 'x-admin-token': process.env.ADMIN_TOKEN! } });
  assert.equal(res.status, 200);
  const csv = await res.text();
  assert.ok(csv.includes(r.body.outTradeNo), 'CSV 应含该订单');
  // 恶意昵称必须被中和：CSV 字段不能以裸 = 开头（Excel/Sheets 会当公式执行），必须带前导单引号。
  assert.ok(!csv.includes('"=HYPERLINK'), 'CSV 不应包含未中和、以 = 开头的字段');
  assert.ok(csv.includes("'=HYPERLINK"), 'CSV 中该昵称应带前导单引号中和为纯文本');
});

test('例行 QA 安全修复：平台证书拉取节流不可被伪造 serial 的重复 force 刷新绕开', async () => {
  resetPlatformCertCache();
  const realFetch = globalThis.fetch;
  let certFetchCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/v3/certificates')) certFetchCount++;
    return realFetch(input as any, init);
  }) as typeof fetch;
  try {
    // 模拟 verifyNotifySignature 连续收到三个「未知/伪造 serial」的回调，各自触发一次 force=true 刷新。
    await fetchPlatformCertificates(true);
    await fetchPlatformCertificates(true);
    await fetchPlatformCertificates(true);
    assert.equal(certFetchCount, 1, '5 分钟节流窗口内，重复 force 刷新只应真正出站请求一次');
  } finally {
    globalThis.fetch = realFetch;
    resetPlatformCertCache();
  }
});
