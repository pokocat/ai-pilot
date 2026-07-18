// 微信支付【真实代码路径】端到端冒烟（本地 mock 微信网关，全程无真实微信、无公网）。
//
// 与 pay:e2e（沙箱通道，绕过全部加解密）互补：本脚本起一个 mock 微信支付服务器 +
// 真实监听端口的 app，让 services/wechatPay.ts 的完整链路本地走通——
//   商户请求 RSA 签名 → mock 网关验签发 prepay_id → paySign 可验 →
//   mock 按官方报文格式投递回调（APIv3 AES-256-GCM 加密 + 平台私钥签名）→
//   /pay/wechat/notify 平台证书验签 + AEAD 解密 → 幂等入账 →
//   回调丢失场景走 GET /pay/orders/:no 主动查单补账 → 篡改签名被 401 拒绝。
// 运行：npm run pay:e2e:mock（需本地 Postgres；不触达微信）。失败退出码非 0。
process.env.NODE_ENV = 'test'; // mock 模型/短信，杜绝任何真实外呼

import { createVerify, randomBytes } from 'node:crypto';
import { buildWechatPayMock, generateWechatPayMockKeys } from '../src/services/wechatPayMock.js';

// —— 支付凭据：先于业务模块 import 之前无所谓（cfg() 惰性读取），但统一在此就位 ——
const keys = generateWechatPayMockKeys();
const APP_ID = 'wxmocke2eappid01';
const MCH_ID = '1900009999';
const API_V3_KEY = randomBytes(16).toString('hex'); // 32 字符
process.env.WECHAT_MINI_APPID = APP_ID;
process.env.WECHAT_PAY_MCHID = MCH_ID;
process.env.WECHAT_PAY_APIV3_KEY = API_V3_KEY;
process.env.WECHAT_PAY_CERT_SERIAL = keys.merchantSerial;
process.env.WECHAT_PAY_PRIVATE_KEY = keys.merchantPrivateKeyPem;
process.env.WECHAT_PAY_PLATFORM_CERT = keys.platformPublicKeyPem;
process.env.WECHAT_PAY_NOTIFY_URL = 'http://127.0.0.1:1/placeholder'; // listen 后回填真实地址
delete process.env.PAY_SANDBOX; // 关键：绝不走沙箱，验证的是真实代码路径

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { payConfigured } = await import('../src/services/wechatPay.js');
const { PLANS, SKUS } = await import('../src/data/seedConfig.js');

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
}

async function main() {
  // —— 起 mock 微信网关 + 真实监听的 app ——
  const mock = buildWechatPayMock({ appId: APP_ID, mchId: MCH_ID, apiV3Key: API_V3_KEY, keys });
  await mock.app.listen({ port: 0, host: '127.0.0.1' });
  const mockPort = (mock.app.server.address() as { port: number }).port;
  process.env.WECHAT_PAY_BASE = `http://127.0.0.1:${mockPort}`;

  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const appPort = (app.server.address() as { port: number }).port;
  const api = `http://127.0.0.1:${appPort}/api`;
  process.env.WECHAT_PAY_NOTIFY_URL = `${api}/pay/wechat/notify`;

  const http = async (method: string, url: string, opts: { user?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.user) headers['x-user-id'] = opts.user;
    const res = await fetch(api + url, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    let body: any = null; try { body = await res.json(); } catch { /* 非 JSON */ }
    return { status: res.status, body };
  };

  // —— 准备：测试租户/用户 + 保证有付费月付套餐与 SKU 目录 ——
  const tenant = await prisma.tenant.create({ data: { name: 'MockPayE2E' } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, phone: '1' + String(9_100_000_000 + Math.floor(Math.random() * 1_000_000_00)).slice(0, 10), name: 'MockPay', role: 'owner', wechatOpenId: `o_mock_${Date.now()}` } });
  let monthly = await prisma.plan.findFirst({ where: { period: 'month', price: { gt: 0 } }, orderBy: { sort: 'asc' } });
  if (!monthly) {
    const p = PLANS.find((x) => x.period === 'month' && x.price > 0)!;
    monthly = await prisma.plan.create({ data: { name: p.name, price: p.price, period: p.period, creditsPerMonth: p.creditsPerMonth, tokenQuotaPerMonth: p.tokenQuotaPerMonth, agentCount: p.agentCount, featuresJson: p.features, highlighted: p.highlighted, sort: 99 } });
  }
  const sk = SKUS.find((s) => s.grantsModuleKey && s.priceFen > 0)!;
  await prisma.sku.upsert({
    where: { key: sk.key },
    update: { enabled: true, priceFen: sk.priceFen },
    create: { key: sk.key, name: sk.name, desc: sk.desc, priceFen: sk.priceFen, kind: sk.kind, grantsModuleKey: sk.grantsModuleKey ?? null, sort: 99 },
  });
  const cleanup = async () => {
    await prisma.paymentOrder.deleteMany({ where: { userId: user.id } });
    await prisma.userModule.deleteMany({ where: { userId: user.id } });
    await prisma.tokenWallet.deleteMany({ where: { userId: user.id } });
    await prisma.creditLedger.deleteMany({ where: { userId: user.id } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.activationEvent.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: tenant.id } }).catch(() => {});
  };

  try {
    check('payConfigured() = true（凭据齐备，非沙箱）', payConfigured());

    // 1) 套餐下单：真实签名请求 → mock 网关验商户签名 → prepay_id → paySign 可验
    const order = await http('POST', `/plans/${monthly.id}/order`, { user: user.id, body: { openid: user.wechatOpenId } });
    check('真实路径下单成功（mock 网关验签通过）', order.status === 200 && order.body?.ok === true, order.body);
    const outTradeNo = order.body.outTradeNo as string;
    const pay = order.body.pay as { timeStamp: string; nonceStr: string; package: string; signType: string; paySign: string };
    const mockOrder = mock.orders.get(outTradeNo);
    check('mock 网关收到订单（NOTPAY）且 prepay_id 与 package 一致', mockOrder?.tradeState === 'NOTPAY' && pay.package === `prepay_id=${mockOrder?.prepayId}`, { pkg: pay.package });
    check('订单金额透传正确（分）', mockOrder?.amountTotal === monthly.price, { got: mockOrder?.amountTotal, want: monthly.price });
    const paySignOk = createVerify('RSA-SHA256')
      .update(`${APP_ID}\n${pay.timeStamp}\n${pay.nonceStr}\n${pay.package}\n`)
      .verify(keys.merchantPublicKeyPem, pay.paySign, 'base64');
    check('wx.requestPayment 调起参数 paySign 验签通过', paySignOk);
    const dbOrder = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
    check('订单落库 provider=wechat / status=created / prepayId 已回填', dbOrder?.provider === 'wechat' && dbOrder?.status === 'created' && !!dbOrder?.prepayId);

    // 2) 支付前轮询：查单返回 NOTPAY，本地订单保持 created（不误标 failed）
    const poll0 = await http('GET', `/pay/orders/${outTradeNo}`, { user: user.id });
    check('支付前轮询 status=created（NOTPAY 不误标失败）', poll0.status === 200 && poll0.body?.status === 'created' && !poll0.body?.appliedAt, poll0.body);

    // 3) 模拟付款 → 官方格式加密回调 → 验签 + AEAD 解密 → 幂等入账
    const paid = await mock.payOrder(outTradeNo);
    check('回调投递成功且 app 应答 200 SUCCESS', paid.delivered && paid.notifyStatus === 200 && (paid.notifyBody ?? '').includes('SUCCESS'), paid);
    const dbOrder2 = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
    check('订单 status=applied + transactionId 落库', dbOrder2?.status === 'applied' && !!dbOrder2?.appliedAt && !!dbOrder2?.transactionId, { status: dbOrder2?.status });
    const me = await http('GET', '/me', { user: user.id });
    check('/me 套餐生效', me.body?.plan?.name === monthly.name, me.body?.plan);
    check('钻石流水 1 条', (await prisma.creditLedger.count({ where: { userId: user.id } })) === 1);

    // 4) 重复回调：幂等（应答 200 停止重试，权益不双发）
    const dup = await mock.redeliverNotify(outTradeNo);
    check('重复回调应答 200 SUCCESS（停止微信重试）', dup.notifyStatus === 200, dup);
    check('重复回调不双发（流水仍 1 条）', (await prisma.creditLedger.count({ where: { userId: user.id } })) === 1);

    // 5) 篡改签名的回调：401 拒绝，不入账
    const tampered = await mock.redeliverNotify(outTradeNo, { tamperSignature: true });
    check('篡改签名回调被 401 拒绝', tampered.notifyStatus === 401, tampered);

    // 6) 回调丢失场景：SKU 下单 → mock 付款但不投回调 → 前端轮询触发主动查单补账
    const skuOrder = await http('POST', `/skus/${sk.key}/order`, { user: user.id, body: { openid: user.wechatOpenId } });
    check('SKU 真实路径下单成功', skuOrder.status === 200 && !!skuOrder.body?.orderId, skuOrder.body);
    const skuOut = skuOrder.body.orderId as string;
    await mock.payOrder(skuOut, { deliverNotify: false }); // 已付款，但回调「丢了」
    const poll1 = await http('GET', `/pay/orders/${skuOut}`, { user: user.id });
    check('轮询触发查单补账：status=applied', poll1.status === 200 && poll1.body?.status === 'applied' && !!poll1.body?.appliedAt, poll1.body);
    const um = await prisma.userModule.findUnique({ where: { userId_moduleKey: { userId: user.id, moduleKey: sk.grantsModuleKey! } } });
    check('查单补账后 SKU 权益已发放（UserModule）', !!um && um.enabled && um.source === 'purchase');
    const skuDb = await prisma.paymentOrder.findUnique({ where: { outTradeNo: skuOut } });
    check('补账订单 transactionId 来自查单结果', !!skuDb?.transactionId?.startsWith('mocktx_'), { tx: skuDb?.transactionId });

    // 7) 越权防护：他人订单查询 404
    const stranger = await prisma.user.create({ data: { tenantId: tenant.id, phone: '19999990000', name: '路人', role: 'member' } });
    const cross = await http('GET', `/pay/orders/${outTradeNo}`, { user: stranger.id });
    check('他人订单轮询 → 404', cross.status === 404, { status: cross.status });
    await prisma.user.delete({ where: { id: stranger.id } }).catch(() => {});
  } finally {
    await cleanup();
    await app.close();
    await mock.app.close();
    await prisma.$disconnect();
  }

  console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
