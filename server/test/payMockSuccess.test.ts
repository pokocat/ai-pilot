// PAY_MOCK_SUCCESS（测试期模拟支付成功）：**没有微信支付商户凭据时，也把真实支付管线整条跑通**。
//
// 与仓库里另外三套「不花钱拿权益」的通道分工（别混淆）：
//   services/wechatPayMock.ts = 本地 mock 微信网关（走真加解密，见 wechatPayMockFlow.test.ts）；
//   PAY_SANDBOX  = /pay/sandbox/notify 仿真回调（admin 鉴权 + 生产启动期硬禁）；
//   demoPurchase = /plans/:id/purchase 演示发放（**整条绕过**支付管线，什么都验不到）。
// 本文件覆盖第四种：真实建单（快照/金额/归因/频控/关旧单）→ POST /pay/mock/pay →
// **真实的** markPaidAndApply（幂等 + 权益发放 + 归因 + 到账订阅消息），并钉住四条不污染真实链路的边界
// （对账 sweep / 主动查单 / 微信退款 / 营收金额统计）与最关键的一条「关门」：payConfigured() 为真时一律拒绝。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import {
  payMockSuccessEnabled, isMockOrder, sweepPendingOrders, reconcileOrder, refundWechatOrder,
} from '../src/services/wechatPay.js';
import { _resetTokenCache } from '../src/services/wechat.js';
import { generateWechatPayMockKeys } from '../src/services/wechatPayMock.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, uniquePhone } from './helpers.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

// 用例会临时改这些键（关门 / 订阅消息场景），统一存档并在 after 里还原，避免污染同进程的其它测试文件。
const TOUCHED_ENV = [
  'PAY_MOCK_SUCCESS', 'WECHAT_PAY_BASE', 'WECHAT_MINI_APPID', 'WECHAT_MINI_SECRET',
  'WECHAT_PAY_MCHID', 'WECHAT_PAY_APIV3_KEY', 'WECHAT_PAY_CERT_SERIAL', 'WECHAT_PAY_PRIVATE_KEY',
  'WECHAT_PAY_NOTIFY_URL', 'WECHAT_SUBSCRIBE_PAYMENT_TEMPLATE_ID',
] as const;
const savedEnv: Record<string, string | undefined> = {};

let userId = '', tenantId = '', otherId = '';
let planId = '', planName = '', planPrice = 0, planCredits = 0, planTokens = 0;

// 真实可用的商户私钥（本地生成，非真凭据）：让「配齐凭据」后的失败是**纯网络失败**，
// 而不是签名报错——否则分不清「它去调微信了」和「它连签名都没做成」。
const payKeys = generateWechatPayMockKeys();

/**
 * 临时配齐「真凭据」跑一段逻辑。WECHAT_PAY_BASE 指向必然拒连的端口：
 * 若某条本该走 mock 的路径在配齐凭据后仍去调微信，会立刻以连接失败暴露出来（而不是静默通过）。
 */
async function withPayCredentials<T>(fn: () => Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {};
  const set: Record<string, string> = {
    WECHAT_MINI_APPID: 'wxmockcfgappid001',
    WECHAT_PAY_MCHID: '1900001111',
    WECHAT_PAY_APIV3_KEY: '0123456789abcdef0123456789abcdef',
    WECHAT_PAY_CERT_SERIAL: payKeys.merchantSerial,
    WECHAT_PAY_PRIVATE_KEY: payKeys.merchantPrivateKeyPem,
    WECHAT_PAY_NOTIFY_URL: 'https://example.invalid/api/pay/wechat/notify',
    WECHAT_PAY_BASE: 'http://127.0.0.1:1',
  };
  for (const [k, v] of Object.entries(set)) { before[k] = process.env[k]; process.env[k] = v; }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(set)) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
}

before(async () => {
  for (const k of TOUCHED_ENV) savedEnv[k] = process.env[k];
  process.env.PAY_MOCK_SUCCESS = 'true';
  // 六项凭据必须缺席，否则 mock 自动让位（这正是「零改动替换」的机制）。
  for (const k of ['WECHAT_PAY_MCHID', 'WECHAT_PAY_APIV3_KEY', 'WECHAT_PAY_CERT_SERIAL', 'WECHAT_PAY_PRIVATE_KEY', 'WECHAT_PAY_NOTIFY_URL', 'WECHAT_PAY_BASE']) delete process.env[k];
  await getApp();
});

after(async () => {
  for (const k of TOUCHED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await closeApp();
});

beforeEach(async () => {
  process.env.PAY_MOCK_SUCCESS = 'true';
  await cleanBusiness();
  await seedBaseline();
  const tenant = await prisma.tenant.create({ data: { name: 'PayMockCo' } });
  tenantId = tenant.id;
  // 直建用户（不走 login）：避开测试期默认套餐带来的「活跃套餐买不同套餐 → 409 降级守卫」，
  // 与 wechatPayMockFlow.test.ts 同一手法。全局禁写闸对 /api/pay/ 与 /api/plans/ 前缀放行。
  const u = await prisma.user.create({ data: { tenantId, phone: uniquePhone(), name: '模拟支付用户', role: 'owner', wechatOpenId: 'o_paymock_1' } });
  userId = u.id;
  const other = await prisma.user.create({ data: { tenantId, phone: uniquePhone(), name: '隔壁老板', role: 'owner', wechatOpenId: 'o_paymock_2' } });
  otherId = other.id;
  const plan = await prisma.plan.findFirst({ where: { period: 'month', price: { gt: 0 } }, orderBy: { sort: 'asc' } });
  assert.ok(plan, '缺少付费月付套餐（seedBaseline 应已灌入）');
  planId = plan!.id; planName = plan!.name; planPrice = plan!.price;
  planCredits = plan!.creditsPerMonth; planTokens = plan!.tokenQuotaPerMonth;
});

/** 下一笔套餐 mock 单，返回 outTradeNo（顺手断言 mock 标记与真实建单副作用）。 */
async function orderPlan(uid = userId, body: Record<string, unknown> = {}): Promise<string> {
  const r = await api('POST', `/api/plans/${planId}/order`, { token: uid, body: { openid: 'o_paymock_1', ...body } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mock, true, '未配凭据 + PAY_MOCK_SUCCESS → 下单必须回 mock 标记');
  return r.body.outTradeNo as string;
}

test('开关：PAY_MOCK_SUCCESS=true 且未配凭据 → 启用', () => {
  assert.equal(payMockSuccessEnabled(), true);
});

test('全链路（套餐）：真实建单 → /pay/mock/pay → paid+appliedAt + 权益真的发放', async () => {
  const no = await orderPlan(userId, { source: 'catalog' });

  // 建的是**真实 PaymentOrder**：金额、条款快照、归因、mock flag 一个不缺。
  const created = await prisma.paymentOrder.findUnique({ where: { outTradeNo: no } });
  assert.ok(created, '必须真的落 PaymentOrder 行（演示发放通道正是缺了这一步）');
  assert.equal(created!.status, 'created');
  assert.equal(created!.provider, 'mock');
  assert.equal(created!.amount, planPrice, '金额走真实下单逻辑（含折算）');
  assert.equal(created!.planId, planId);
  assert.equal(created!.attrSource, 'catalog', '归因随订单落库');
  const snap = created!.snapshotJson as { kind?: string; mock?: boolean; plan?: { name?: string; creditsPerMonth?: number } };
  assert.equal(snap.mock, true, '快照打 mock flag（schema 不加列，全靠这个 Json 标记）');
  assert.equal(snap.kind, 'plan');
  assert.equal(snap.plan?.creditsPerMonth, planCredits, '条款快照照常写入，发放按下单时点配置');
  assert.equal(isMockOrder(created!), true);

  // 模拟支付 = 用户点了那一下
  const pay = await api('POST', '/api/pay/mock/pay', { token: userId, body: { outTradeNo: no } });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.equal(pay.body.applied, true);
  assert.equal(pay.body.status, 'applied');

  // 订单状态机走到终态
  const paid = await prisma.paymentOrder.findUnique({ where: { outTradeNo: no } });
  assert.equal(paid!.status, 'applied');
  assert.ok(paid!.paidAt, 'paidAt 落地');
  assert.ok(paid!.appliedAt, 'appliedAt 落地（幂等终态锚点）');
  assert.ok(paid!.transactionId?.startsWith('mock'), `transactionId 以 mock 开头：${paid!.transactionId}`);
  assert.match(paid!.transactionId!.slice(4), /^\d+$/, 'mock 之后必须是纯数字（到账模板 number6 位只认数字）');

  // 权益真的发放：套餐 + 到期日 + 算力入账 + token 额度
  const u = await prisma.user.findUnique({ where: { id: userId } });
  assert.equal(u!.planId, planId);
  assert.ok(u!.planExpiresAt && u!.planExpiresAt.getTime() > Date.now(), '付费套餐应写未来到期日');
  const ledger = await prisma.creditLedger.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
  assert.ok(ledger, '算力流水应入账');
  assert.equal(ledger!.delta, planCredits);
  assert.match(ledger!.reason, /测试模拟/, '流水必须自带「测试模拟」，事后才分得清哪些额度是测试期白发的');
  const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
  assert.equal(wallet!.quota, planTokens, 'token 月度额度按快照授予');

  // 归因事件与审计
  const act = await prisma.activationEvent.findFirst({ where: { userId, itemType: 'plan', itemKey: planId } });
  assert.ok(act, '入账应落 ActivationEvent（与真实回调同一段代码）');
  const audit = await prisma.auditLog.findFirst({ where: { userId, action: 'pay.mock.paid' } });
  assert.ok(audit, '假到账必须可审计');
  const ap = audit!.payloadJson as { outTradeNo?: string; amount?: number; planId?: string; itemName?: string };
  assert.equal(ap.outTradeNo, no);
  assert.equal(ap.amount, planPrice);
  assert.equal(ap.planId, planId);
  assert.equal(ap.itemName, planName);
});

test('全链路（SKU）：模块权益按 skuKey 发放', async () => {
  const r = await api('POST', '/api/skus/deep-contradiction/order', { token: userId, body: { openid: 'o_paymock_1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mock, true);
  const no = r.body.orderId as string;
  const row = await prisma.paymentOrder.findUnique({ where: { outTradeNo: no } });
  assert.equal(row!.skuKey, 'deep-contradiction');
  assert.equal((row!.snapshotJson as { mock?: boolean }).mock, true);

  const pay = await api('POST', '/api/pay/mock/pay', { token: userId, body: { orderId: no } }); // orderId 别名
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.equal(pay.body.applied, true);
  const um = await prisma.userModule.findUnique({ where: { userId_moduleKey: { userId, moduleKey: 'deep-contradiction' } } });
  assert.ok(um && um.enabled && um.source === 'purchase', '模块启用并标为购买（与真实回调同一发放口径）');
});

test('到账订阅消息：配了模板 + 有订阅额度时真发，number6 位是纯数字', async () => {
  process.env.WECHAT_SUBSCRIBE_PAYMENT_TEMPLATE_ID = 'tpl-payment';
  process.env.WECHAT_MINI_APPID = 'wx-test-app'; // 仅 appid 不足以让 payConfigured() 为真
  process.env.WECHAT_MINI_SECRET = 'secret-test';
  _resetTokenCache();
  assert.equal(payMockSuccessEnabled(), true, '只配小程序 appid/secret 不算配齐支付凭据');
  await prisma.wechatSubscription.create({
    data: { tenantId, userId, scene: 'payment', templateId: 'tpl-payment', status: 'accept', remaining: 1, acceptedAt: new Date() },
  });

  const no = await orderPlan();
  const oldFetch = globalThis.fetch;
  type SendBody = { touser?: string; template_id?: string; data: Record<string, { value: string }> };
  const calls: { url: string; body?: SendBody }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return {
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => (href.includes('/stable_token')
        ? { access_token: 'access-token-test', expires_in: 7200 }
        : { errcode: 0, errmsg: 'ok' }),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    const pay = await api('POST', '/api/pay/mock/pay', { token: userId, body: { outTradeNo: no } });
    assert.equal(pay.body.applied, true);
    // 到账通知是入账后事务外 fire-and-forget（绝不阻塞入账）→ 轮询等它落日志。
    let log = null as { status: string; payloadJson: unknown } | null;
    for (let i = 0; i < 40 && !log; i++) {
      log = await prisma.wechatNotificationLog.findFirst({ where: { userId, scene: 'payment' }, orderBy: { createdAt: 'desc' } });
      if (!log) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(log, '支付到账订阅消息应被尝试发送');
    assert.equal(log!.status, 'sent');
  } finally {
    globalThis.fetch = oldFetch;
    delete process.env.WECHAT_SUBSCRIBE_PAYMENT_TEMPLATE_ID;
    delete process.env.WECHAT_MINI_APPID;
    delete process.env.WECHAT_MINI_SECRET;
    _resetTokenCache();
  }
  const send = calls.find((c) => c.url.includes('/message/subscribe/send'));
  assert.ok(send, '应真的调用订阅消息发送接口');
  assert.equal(send!.body!.template_id, 'tpl-payment');
  // 关键：number6 是微信 number 类型，只认纯数字——mock 单号正是为此造成「mock+数字」的形状。
  assert.match(send!.body!.data.number6.value, /^\d+$/, 'number6 必须是纯数字，否则整条推送 47003 被拒');
  assert.ok(send!.body!.data.number6.value.length > 0);
});

test('幂等：重复 /pay/mock/pay 只发一次权益，流水只一条', async () => {
  const no = await orderPlan();
  const r1 = await api('POST', '/api/pay/mock/pay', { token: userId, body: { outTradeNo: no } });
  const r2 = await api('POST', '/api/pay/mock/pay', { token: userId, body: { outTradeNo: no } });
  assert.equal(r1.body.applied, true);
  assert.equal(r2.body.applied, false, '重复模拟支付不得再次发放');
  assert.equal(r2.body.reason, 'already_applied', '复用 markPaidAndApply 既有的 appliedAt 幂等锚点，不另造一套');
  assert.equal(await prisma.creditLedger.count({ where: { userId } }), 1, '算力流水只一条');
  assert.equal(await prisma.activationEvent.count({ where: { userId } }), 1, '归因事件只一条');
});

test('幂等（并发）：8 个并发模拟支付只有一次真正入账', async () => {
  const no = await orderPlan();
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    api('POST', '/api/pay/mock/pay', { token: userId, body: { outTradeNo: no } })));
  assert.equal(results.filter((r) => r.body.applied === true).length, 1, '并发下只有一次入账');
  assert.equal(await prisma.creditLedger.count({ where: { userId } }), 1);
});

test('关门（最重要）：payConfigured() 为真时 mock 一律让位——不需要改任何代码', async () => {
  const no = await orderPlan(); // 先在未配凭据时留一笔 mock 单
  await withPayCredentials(async () => {
    assert.equal(payMockSuccessEnabled(), false, '真凭据配齐 → 开关自动失效（零改动替换的保证）');
    // 已存在的 mock 单也不能再被模拟支付（否则等于配了真支付还能白拿）
    const pay = await api('POST', '/api/pay/mock/pay', { token: userId, body: { outTradeNo: no } });
    assert.equal(pay.status, 501);
    assert.equal(pay.body.code, 'PAYMENT_NOT_CONFIGURED');
    // 新下单必须走真实微信路径：WECHAT_PAY_BASE 指向拒连端口 → 502 证明它确实去调微信了
    const order = await api('POST', `/api/plans/${planId}/order`, { token: userId, body: { openid: 'o_paymock_1' } });
    assert.equal(order.status, 502, JSON.stringify(order.body));
    assert.equal(order.body.code, 'WECHAT_PAY_CREATE_FAILED');
  });
  const still = await prisma.paymentOrder.findUnique({ where: { outTradeNo: no } });
  assert.equal(still!.status, 'created', '被拒绝的模拟支付不得改动订单状态');
  assert.equal(await prisma.creditLedger.count({ where: { userId } }), 0, '不得发放任何权益');
});

test('关门：PAY_MOCK_SUCCESS 未设时，下单 501、模拟支付 501（与未配支付同一错误，不泄露端点存在）', async () => {
  const no = await orderPlan();
  delete process.env.PAY_MOCK_SUCCESS;
  assert.equal(payMockSuccessEnabled(), false);
  const pay = await api('POST', '/api/pay/mock/pay', { token: userId, body: { outTradeNo: no } });
  assert.equal(pay.status, 501);
  assert.equal(pay.body.code, 'PAYMENT_NOT_CONFIGURED');
  const order = await api('POST', `/api/plans/${planId}/order`, { token: userId, body: { openid: 'o_paymock_1' } });
  assert.equal(order.status, 501);
  assert.equal(order.body.code, 'PAYMENT_NOT_CONFIGURED');
  const sku = await api('POST', '/api/skus/deep-contradiction/order', { token: userId, body: { openid: 'o_paymock_1' } });
  assert.equal(sku.status, 501);
  assert.equal(sku.body.code, 'PAYMENT_NOT_CONFIGURED');
});

test('隔离：他人订单 404，且不发放任何权益', async () => {
  const no = await orderPlan();
  const cross = await api('POST', '/api/pay/mock/pay', { token: otherId, body: { outTradeNo: no } });
  assert.equal(cross.status, 404);
  assert.equal(cross.body.code, 'ORDER_NOT_FOUND');
  const unknown = await api('POST', '/api/pay/mock/pay', { token: userId, body: { outTradeNo: 'js_nope_0001' } });
  assert.equal(unknown.status, 404, '不存在的单与他人单同一响应');
  const row = await prisma.paymentOrder.findUnique({ where: { outTradeNo: no } });
  assert.equal(row!.status, 'created');
  assert.equal(await prisma.creditLedger.count({ where: { userId } }), 0);
});

test('隔离：真实微信单不能被模拟支付「模拟」成已付款', async () => {
  await prisma.paymentOrder.create({
    data: { outTradeNo: 'js_real_0001', tenantId, userId, planId, amount: planPrice, provider: 'wechat', status: 'created' },
  });
  const r = await api('POST', '/api/pay/mock/pay', { token: userId, body: { outTradeNo: 'js_real_0001' } });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ORDER_NOT_MOCK');
  const row = await prisma.paymentOrder.findUnique({ where: { outTradeNo: 'js_real_0001' } });
  assert.equal(row!.status, 'created');
});

test('不污染：mock 单被 sweepPendingOrders 跳过且不被标 failed；查单也短路', async () => {
  // 先造 paid 未 applied 的 mock 单（sweep 最积极处置的形态，必须同样被跳过）：
  // 必须先它、再下第二笔 created 单——否则第二笔下单会把它当同类旧 created 单本地关掉。
  const stuckMock = await orderPlan();
  await prisma.paymentOrder.update({ where: { outTradeNo: stuckMock }, data: { status: 'paid', paidAt: new Date() } });
  // 一笔陈旧 created mock 单 + 一笔陈旧 created 真实单（后者才是 sweep 的正当猎物）
  const mockNo = await orderPlan();
  await prisma.paymentOrder.update({ where: { outTradeNo: mockNo }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } });
  await prisma.paymentOrder.create({
    data: { outTradeNo: 'js_sweep_real', tenantId, userId, planId, amount: planPrice, provider: 'wechat', status: 'created', createdAt: new Date(Date.now() - 20 * 60_000) },
  });

  await withPayCredentials(async () => {
    // 查单短路：不触网、只返回 mock_order（不是 provider_not_wechat 那条泛化分支）
    const rec = await reconcileOrder(mockNo);
    assert.equal(rec.applied, false);
    assert.equal(rec.reason, 'mock_order');

    const stats = await sweepPendingOrders();
    assert.equal(stats.scanned, 1, `批扫只应看到那笔真实单：${JSON.stringify(stats)}`);
    assert.equal(stats.failed, 0);
  });

  for (const no of [mockNo, stuckMock]) {
    const row = await prisma.paymentOrder.findUnique({ where: { outTradeNo: no } });
    assert.ok(row!.status !== 'failed' && row!.status !== 'closed', `mock 单不得被批扫标 failed/closed（实际 ${row!.status}）`);
  }
  assert.equal((await prisma.paymentOrder.findUnique({ where: { outTradeNo: mockNo } }))!.status, 'created');
  assert.equal((await prisma.paymentOrder.findUnique({ where: { outTradeNo: stuckMock } }))!.status, 'paid');
});

test('不污染：下新 mock 单会本地关掉同类旧 mock 单（不调微信关单接口）', async () => {
  const oldFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound += 1; throw new Error('mock 路径不应有任何出站请求'); }) as unknown as typeof fetch;
  let first = '', second = '';
  try {
    first = await orderPlan();
    second = await orderPlan();
  } finally {
    globalThis.fetch = oldFetch;
  }
  assert.equal(outbound, 0, '下单/关单全程不得触网');
  assert.equal((await prisma.paymentOrder.findUnique({ where: { outTradeNo: first } }))!.status, 'closed', '旧 mock created 单应被本地关闭');
  assert.equal((await prisma.paymentOrder.findUnique({ where: { outTradeNo: second } }))!.status, 'created');
});

test('不污染：mock 单退款不调微信，但本地权益照常回收', async () => {
  const no = await orderPlan();
  await api('POST', '/api/pay/mock/pay', { token: userId, body: { outTradeNo: no } });
  const balBefore = (await prisma.creditLedger.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } }))!.balance;
  assert.ok(balBefore > 0, '入账后应有算力余额');

  const oldFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound += 1; throw new Error('mock 单退款不应调微信'); }) as unknown as typeof fetch;
  let r: { ok: boolean; wechatStatus: string };
  try {
    // 配齐凭据也一样：mock 单永远不走真退款接口（判定锚在订单快照 flag，不是当前 env）。
    r = await withPayCredentials(() => refundWechatOrder(no, { reason: '测试期误发放，撤回', by: 'qa' }));
  } finally {
    globalThis.fetch = oldFetch;
  }
  assert.equal(outbound, 0, '不得调用微信退款接口');
  assert.equal(r.wechatStatus, 'MOCK', '退款状态标 MOCK，一眼看出无真实资金流');

  const row = await prisma.paymentOrder.findUnique({ where: { outTradeNo: no } });
  assert.equal(row!.status, 'refunded');
  assert.ok(row!.refundedAt && row!.refundId);
  // 权益回收照常：套餐立即到期 + 追回未消耗算力
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { planExpiresAt: true } });
  assert.ok(u!.planExpiresAt && u!.planExpiresAt.getTime() <= Date.now(), '套餐应立即到期');
  const last = await prisma.creditLedger.findFirst({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  assert.ok(last!.delta < 0 && last!.reason.includes('退款追回'), `应有追回流水：${JSON.stringify(last)}`);
  assert.equal(last!.balance, 0, '全额追回后余额归零');
  const audit = await prisma.auditLog.findFirst({ where: { userId, action: 'user.pay.refund' }, orderBy: { createdAt: 'desc' } });
  assert.equal((audit!.payloadJson as { mock?: boolean }).mock, true, '审计标明这是 mock 单退款');

  // 幂等：重复退款仍 409
  await assert.rejects(() => refundWechatOrder(no, {}), (e: { code?: string }) => e.code === 'ALREADY_REFUNDED');
});

test('不污染：营收金额不含 mock 单，但运营端订单列表能看出是 mock', async () => {
  const mockNo = await orderPlan();
  await api('POST', '/api/pay/mock/pay', { token: userId, body: { outTradeNo: mockNo } });
  // 一笔真实已支付单作对照（营收只应统计它）
  await prisma.paymentOrder.create({
    data: {
      outTradeNo: 'js_real_paid_1', tenantId, userId: otherId, planId, amount: 12800, provider: 'wechat',
      status: 'applied', paidAt: new Date(), appliedAt: new Date(),
    },
  });

  const view = await api('GET', '/api/admin/payments?days=30', {});
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.summary.paidAmount, 12800, '期内实收只算真实微信收款，mock 单的钱绝不进营收');
  assert.equal(view.body.summary.paidCount, 1);
  const byDayTotal = (view.body.summary.byDay as { amount: number }[]).reduce((a, x) => a + x.amount, 0);
  assert.equal(byDayTotal, 12800, '按天曲线同口径');

  const items = view.body.items as { outTradeNo: string; mock: boolean }[];
  const mockItem = items.find((x) => x.outTradeNo === mockNo);
  assert.ok(mockItem, 'mock 单仍必须出现在订单列表里（可见）');
  assert.equal(mockItem!.mock, true, '且显式标出 mock');
  assert.equal(items.find((x) => x.outTradeNo === 'js_real_paid_1')!.mock, false);

  // CSV 导出也要能把测试期假单剔掉（导出常被拿去对账）
  const csv = await api('GET', '/api/admin/payments/export?days=30', {});
  assert.equal(csv.status, 200);
  const text = String(csv.body);
  assert.ok(text.includes('模拟单'), 'CSV 应有「模拟单」列');
  assert.ok(text.includes('"mock"'), 'mock 单在 CSV 里被标出');
});

test('不污染：下单频控等既有守卫对 mock 单同样生效（一条都不跳）', async () => {
  for (let i = 0; i < 10; i++) {
    const r = await api('POST', `/api/plans/${planId}/order`, { token: userId, body: { openid: 'o_paymock_1' } });
    assert.equal(r.status, 200, `第 ${i + 1} 单应放行：${JSON.stringify(r.body)}`);
  }
  const blocked = await api('POST', `/api/plans/${planId}/order`, { token: userId, body: { openid: 'o_paymock_1' } });
  assert.equal(blocked.status, 429, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, 'ORDER_RATE_LIMITED');
});

test('前台可见性：订单列表带 mock 标记与继续支付能力（重签也是 mock）', async () => {
  const no = await orderPlan();
  const list = await api('GET', '/api/pay/orders', { token: userId });
  assert.equal(list.status, 200);
  const item = (list.body.items as { outTradeNo: string; mock?: boolean; payable: boolean; itemName: string }[]).find((x) => x.outTradeNo === no);
  assert.ok(item, '列表应包含本人 mock 单');
  assert.equal(item!.mock, true, '前台必须能看出这单是测试期模拟支付，不能装成真付款');
  assert.equal(item!.payable, true);
  assert.equal(item!.itemName, planName, 'itemName 来自下单快照');

  const rp = await api('POST', `/api/pay/orders/${no}/pay-params`, { token: userId });
  assert.equal(rp.status, 200, JSON.stringify(rp.body));
  assert.equal(rp.body.mock, true, '继续支付同样回 mock 标记（端上据此改调 /pay/mock/pay）');
});
