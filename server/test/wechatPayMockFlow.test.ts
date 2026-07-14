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
import { seedBaseline, cleanBusiness } from './helpers.js';

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

const http = async (method: string, url: string, opts: { user?: string; body?: unknown } = {}) => {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.user) headers['x-user-id'] = opts.user;
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
