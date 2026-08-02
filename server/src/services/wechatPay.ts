// 微信支付 v3（JSAPI，小程序下单）脚手架 —— 配置开关式：未配齐凭据时 payConfigured()=false，
// 由路由回退「演示购买」通道；配齐后走真实下单 + 回调验签/解密 + 幂等入账。
//
// 需要的环境变量（生产配齐即启用）：
//   WECHAT_MINI_APPID         小程序 AppID（复用登录用的）
//   WECHAT_PAY_MCHID          商户号
//   WECHAT_PAY_APIV3_KEY      APIv3 密钥（32 位，回调资源 AEAD 解密 + 平台证书解密）
//   WECHAT_PAY_CERT_SERIAL    商户证书序列号
//   WECHAT_PAY_PRIVATE_KEY    商户私钥 PEM（apiclient_key.pem 内容；\n 用真实换行或字面 \n）
//   WECHAT_PAY_NOTIFY_URL     支付结果回调地址（公网 https）
//
// 安全注记：回调先用与 Wechatpay-Serial 匹配的平台证书/公钥验签，再做 AEAD 解密；任一步缺失或失败都拒绝。

import { createSign, createVerify, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { applyPlanPurchase, applySkuGrant } from './purchase.js';
import { parseAttribution, recordActivation } from './activation.js';
import { notePayOrderCreated, notePayApplied, notePayRefund, notePaySweep, notePayMock } from './metrics.js';
import { sandboxEnabled } from './sandbox.js';
import { chargeCredits } from './credits.js';
import { sendWechatSubscribeMessage } from './wechatSubscribe.js';
import { revokePlanEntitlement } from './planEntitlements.js';

// 微信支付 API 基址。默认真实商户网关；本地联调可用 WECHAT_PAY_BASE 指向
// mock 微信支付服务器（scripts/wechat-pay-mock.ts），走完整签名/验签/AEAD 解密链路。
function payBase(): string {
  return (process.env.WECHAT_PAY_BASE ?? '').trim().replace(/\/+$/, '') || 'https://api.mch.weixin.qq.com';
}

function cfg() {
  return {
    appId: (process.env.WECHAT_MINI_APPID ?? '').trim(),
    mchId: (process.env.WECHAT_PAY_MCHID ?? '').trim(),
    apiV3Key: (process.env.WECHAT_PAY_APIV3_KEY ?? '').trim(),
    certSerial: (process.env.WECHAT_PAY_CERT_SERIAL ?? '').trim(),
    privateKey: (process.env.WECHAT_PAY_PRIVATE_KEY ?? '').replace(/\\n/g, '\n').trim(),
    notifyUrl: (process.env.WECHAT_PAY_NOTIFY_URL ?? '').trim(),
    platformCert: (process.env.WECHAT_PAY_PLATFORM_CERT ?? '').replace(/\\n/g, '\n').trim(),
    platformCertSerial: (process.env.WECHAT_PAY_PLATFORM_CERT_SERIAL ?? '').trim(),
    publicKeyId: (process.env.WECHAT_PAY_PUBLIC_KEY_ID ?? '').trim(),
    publicKey: (process.env.WECHAT_PAY_PUBLIC_KEY ?? '').replace(/\\n/g, '\n').trim(),
  };
}

const WECHAT_HTTP_TIMEOUT_MS = 5_000;

/** 是否配齐真实支付凭据。未配齐 → 路由回退演示购买。 */
export function payConfigured(): boolean {
  const c = cfg();
  return !!(c.appId && c.mchId && c.apiV3Key && c.certSerial && c.privateKey && c.notifyUrl);
}

/**
 * PAY_MOCK_SUCCESS：**没有微信支付商户凭据时，也把真实支付管线整条跑通**。
 *
 * 与 demoPurchaseEnabled()（/plans/:id/purchase 演示发放）的根本区别：演示发放整条**绕过**支付管线
 * ——不建 PaymentOrder、不走 markPaidAndApply、不发到账通知，所以订单状态机 / 幂等 / 权益发放 /
 * 到账订阅消息在真实环境里从未被执行过。本开关反过来：下单走既有 createJsapiOrder（条款快照、
 * 金额、归因、下单频控、关同类旧单一个不跳），到账走**真实的** markPaidAndApply（advisory lock +
 * appliedAt 终态锚点 + ActivationEvent + 订阅消息）；唯一的差别是「调微信」那两步换成本地模拟
 * （下单不请求 JSAPI，付款由 POST /pay/mock/pay 触发）。
 *
 * 「将来零改动替换」的实现方式就是下面这个 `!payConfigured()`：**真凭据一配齐，mock 自动让位**。
 * 不需要记得去删 PAY_MOCK_SUCCESS，也不存在「配了真支付却还能白拿套餐」的窗口。
 *
 * ⚠️ 只允许非生产测试环境启用；assertSandboxSafe() 会在 production 启动时拒绝该配置。代价必须说清：
 * 开启即等于**任何登录用户都可以自助领取任意付费套餐 / SKU**（下单→点一下模拟支付→权益到账），
 * 仅测试期使用；这些单在库里带 snapshotJson.mock=true、provider='mock'、transactionId 以 `mock` 开头，
 * 已从营收金额统计里排除，并在运营端订单列表显式标「mock」。
 */
export function payMockSuccessEnabled(): boolean {
  return process.env.PAY_MOCK_SUCCESS === 'true' && !payConfigured();
}

// PAY_MOCK_SUCCESS 下给「没有 openid 的账号」合成的占位 openid 命名空间（形如 `mockopenid:<userId>`）。
// 冒号让它与微信真实 openid（^[A-Za-z0-9_-]+$）天然不可能相撞。
const MOCK_OPENID_PREFIX = 'mockopenid:';

/**
 * 解析本次下单的付款人 openid。**套餐（/plans/:id/order）与 SKU（/skus/:key/order）两条下单路径共用**
 * ——同一条规则绝不在两个路由各写一份（本仓已经因为「同一规则两处各写一份」踩过坑）。
 *
 * 为什么 body 里的 openid 不能直接采纳：真实支付模式下 openid 决定微信向**谁**收款，
 * 绝不能由请求体任意指定。历史实现是 `req.body.openid || user.wechatOpenId`，等于让调用方拿任意
 * openid 建单（付款人与订单归属账号脱钩）。小程序端 `api.createOrder/createSkuOrder` 从不传 openid
 * （见 app/src/services/api.ts），body 那个入口纯属测试遗留。
 * 现在的规则：body 值**只在与调用者自己的 wechatOpenId 完全一致时**被采纳（此时与不传等价），
 * 其余一律静默忽略——不报错，忽略后自然落到调用方既有的 OPENID_REQUIRED 判定。
 *
 * mock 兜底：payMockSuccessEnabled() 为真且账号确实没有 openid（如纯短信注册的预发 HTTP E2E 账号）时，
 * 合成确定性占位值 `mockopenid:<userId>`，让「测试期真实支付管线」也能被这类账号跑通。该值
 * **永不会被发往微信**：mock 分支根本不调 JSAPI（见 createJsapiOrder 里 payMockSuccessEnabled() 那段，
 * 全程不引用 openid），继续支付（repayParams）对 mock 单也只回本地占位参数；真实 JSAPI 路径另有
 * 兜底断言把它拦死。**真实凭据配齐时绝不合成**——payMockSuccessEnabled() 自带 `!payConfigured()`，
 * 那时无 openid 账号必须照旧吃 OPENID_REQUIRED。
 */
export function resolvePayerOpenid(
  user: { id: string; wechatOpenId?: string | null },
  claimedOpenid?: string,
): string {
  const own = (user.wechatOpenId ?? '').trim();
  const claimed = (claimedOpenid ?? '').trim();
  if (claimed && claimed !== own) {
    // 留一条线索：正常端上根本不传 openid，传了且不是自己的 = 要么是老脚本，要么有人在试。
    console.warn('[pay] 已忽略请求体里的 openid（不等于调用者自己的 openid），user:', user.id);
  }
  if (own) return own;
  if (payMockSuccessEnabled()) return `${MOCK_OPENID_PREFIX}${user.id}`;
  return '';
}

/** 是否为上面合成的模拟 openid（真实 JSAPI 路径的兜底断言用）。 */
export function isMockPayerOpenid(openid: string): boolean {
  return openid.startsWith(MOCK_OPENID_PREFIX);
}

/**
 * 是否为 PAY_MOCK_SUCCESS 造出来的模拟单。判定锚在**下单时写死的快照 flag** 上（不是当前 env）：
 * 关掉开关、乃至后来配齐真凭据之后，历史 mock 单仍然可被 sweep/退款/营收统计正确识别与追溯。
 * transactionId 前缀 `mock` 只是给人看的第二重线索（快照缺失的极端情况下兜底）。
 */
export function isMockOrder(order: { snapshotJson?: unknown; transactionId?: string | null }): boolean {
  const snap = (order.snapshotJson ?? null) as { mock?: boolean } | null;
  if (snap?.mock === true) return true;
  return MOCK_TXN_RE.test(order.transactionId ?? '');
}

// 模拟微信支付单号形状。**`mock` 后面必须紧跟纯数字、且不许有别的字符**：
//   ① 到账订阅消息的 number6 位是微信 number 类型、只认纯数字，发送侧 digitsOnly 会把字母抽掉
//      （见 services/wechatSubscribe.ts 顶部注释），所以造的是「mock + 时间戳 + 随机数字」，
//      抽完仍是一串有意义、可对回订单的数字；
//   ② 这个正则同时是 isMockOrder 的兜底判据，**必须收得足够紧**——本地 mock 微信网关
//      （services/wechatPayMock.ts）给**真实路径**订单发的是 `mocktx_*`，用 startsWith('mock')
//      会把那些真单误判成模拟单，从而跳过真退款（实测踩到：wechatPayMockFlow 的退款用例）。
const MOCK_TXN_RE = /^mock\d+$/;

/** 造一个「以数字为主」的模拟微信支付单号（mock + 13 位时间戳 + 6 位随机数字）。 */
export function genMockTransactionId(): string {
  return `mock${Date.now()}${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
}

/** 模拟单的「调起参数」占位：端上看到 mock=true 就该跳过 wx.requestPayment，绝不会真用这些值。 */
function mockPayParams(outTradeNo: string): CreateOrderResult['pay'] {
  return {
    timeStamp: Math.floor(Date.now() / 1000).toString(),
    nonceStr: `paymock${outTradeNo.slice(-8)}`,
    package: `prepay_id=paymock_${outTradeNo}`,
    signType: 'RSA',
    paySign: 'PAY_MOCK_NO_SIGN',
  };
}

/** 商户订单号：时间 + 随机，控制在微信要求长度内（≤32）。 */
export function genOutTradeNo(): string {
  return `js${Date.now()}${randomBytes(4).toString('hex')}`.slice(0, 32);
}

// —— v3 请求签名（RSA-SHA256，Authorization 头）——
function buildAuthToken(method: string, urlPath: string, body: string): string {
  const c = cfg();
  const nonce = randomUUID().replace(/-/g, '');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = createSign('RSA-SHA256').update(message).sign(c.privateKey, 'base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${c.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${c.certSerial}"`;
}

// —— 小程序端调起支付的 paySign（RSA-SHA256）——
function buildPayParams(prepayId: string): { timeStamp: string; nonceStr: string; package: string; signType: 'RSA'; paySign: string } {
  const c = cfg();
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = randomUUID().replace(/-/g, '');
  const pkg = `prepay_id=${prepayId}`;
  const message = `${c.appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`;
  const paySign = createSign('RSA-SHA256').update(message).sign(c.privateKey, 'base64');
  return { timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign };
}

export interface CreateOrderResult {
  outTradeNo: string;
  pay: { timeStamp: string; nonceStr: string; package: string; signType: 'RSA'; paySign: string };
  /** PAY_MOCK_SUCCESS 模拟单：pay 是占位值，端上必须跳过 wx.requestPayment，改调 POST /pay/mock/pay。 */
  mock?: true;
}

// 下单频控（P2）：同一用户 10 分钟内最多 10 笔新订单（覆盖套餐+SKU），超出 429。
// 防恶意刷单打微信 API / 刷爆 PaymentOrder 表；正常用户远达不到该频率。
const ORDER_RATE_WINDOW_MS = 10 * 60_000;
const ORDER_RATE_MAX = 10;

// 以同用户 advisory lock 串行化「查最近下单数 → 判定 → 建单」：避免并发下单请求都读到同一份
// 未提交的计数、一起放行超过 ORDER_RATE_MAX 的量（与已修复的证书拉取节流绕过是同一类 TOCTOU 漏洞）。
// 必须在 tx 内对同一把锁调用，紧跟着落库，锁随事务提交/回滚释放。
async function assertOrderRate(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`orderrate:${userId}`}))`;
  const recent = await tx.paymentOrder.count({
    where: { userId, createdAt: { gt: new Date(Date.now() - ORDER_RATE_WINDOW_MS) } },
  });
  if (recent >= ORDER_RATE_MAX) {
    throw Object.assign(new Error('下单过于频繁，请稍后再试'), { code: 'ORDER_RATE_LIMITED', statusCode: 429 });
  }
}

// 下单时的条款快照（P1）：发放以下单时点的套餐/SKU 配置为准，防「下单后改价/改额度/删配置」漂移；
// 也让 plan_not_found/sku_not_found 类卡单可以从快照恢复发放。
async function buildOrderSnapshot(args: { planId?: string; skuKey?: string }): Promise<Prisma.InputJsonValue | undefined> {
  if (args.planId) {
    const p = await prisma.plan.findUnique({ where: { id: args.planId } });
    if (!p) return undefined;
    return {
      kind: 'plan',
      plan: {
        id: p.id, name: p.name, price: p.price, period: p.period,
        planFamilyKey: p.planFamilyKey, tierRank: p.tierRank, usageLevel: p.usageLevel, usageLabel: p.usageLabel,
        usageNormalPercent: p.usageNormalPercent, usageNearPercent: p.usageNearPercent,
        creditsPerMonth: p.creditsPerMonth, tokenQuotaPerMonth: p.tokenQuotaPerMonth,
        agentCount: p.agentCount, featuresJson: p.featuresJson, highlighted: p.highlighted,
      },
    };
  }
  if (args.skuKey) {
    const s = await prisma.sku.findUnique({ where: { key: args.skuKey } });
    if (!s) return undefined;
    return { kind: 'sku', sku: { key: s.key, name: s.name, kind: s.kind, priceFen: s.priceFen, grantsModuleKey: s.grantsModuleKey, metaJson: s.metaJson as object | null } };
  }
  return undefined;
}

// —— 微信关单（P1：消除「陈旧折算单被后付」的 2h 套利窗）——
export async function closeWechatOrder(outTradeNo: string): Promise<void> {
  const c = cfg();
  const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`;
  const body = JSON.stringify({ mchid: c.mchId });
  const res = await fetch(payBase() + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: buildAuthToken('POST', urlPath, body) },
    body,
    signal: AbortSignal.timeout(WECHAT_HTTP_TIMEOUT_MS),
  });
  // 204 = 关单成功；404 = 微信侧无此交易（用户从未调起支付）——两者都可安全置本地 closed。
  if (res.status === 204 || res.status === 404) return;
  const errText = await res.text().catch(() => '');
  // 其它失败（如已支付 ORDERPAID）：抛错让调用方跳过本地关单，等回调/对账按真实状态处理。
  throw Object.assign(new Error(`微信关单失败：HTTP ${res.status} ${errText}`), { code: 'WECHAT_PAY_CLOSE_FAILED', statusCode: 502 });
}

/**
 * 下新单前关掉同类旧未付单：套餐单关用户全部旧套餐 created 单（防「折算下单→续费→再付旧折算单」），
 * SKU 单只关同 skuKey 的旧 created 单（不同 SKU 可合法并存待付）。
 * 远端关单成功/查无此单才置本地 closed；已支付等失败一律跳过（交回调/对账兜底），绝不本地先斩。
 *
 * opts.mock = PAY_MOCK_SUCCESS 模拟单的关单：语义、筛选与顺序完全照抄真实路径，只是**不调微信**
 * （那笔交易在微信侧根本不存在，调了必然报错），直接置本地 closed——本来也没有远端状态需要对齐。
 */
async function closeStalePendingOrders(
  userId: string,
  target: { planOrder?: boolean; skuKey?: string },
  opts: { mock?: boolean; excludeClientRequestId?: string } = {},
): Promise<void> {
  const provider = opts.mock ? 'mock' : 'wechat';
  const where: Prisma.PaymentOrderWhereInput = target.planOrder
    ? { userId, provider, status: 'created', appliedAt: null, planId: { not: '' } }
    : { userId, provider, status: 'created', appliedAt: null, skuKey: target.skuKey };
  if (opts.excludeClientRequestId) where.NOT = { clientRequestId: opts.excludeClientRequestId };
  const stale = await prisma.paymentOrder.findMany({ where, select: { outTradeNo: true }, take: 20, orderBy: { createdAt: 'asc' } });
  for (const o of stale) {
    try {
      if (!opts.mock) await closeWechatOrder(o.outTradeNo);
      await prisma.paymentOrder.updateMany({
        where: { outTradeNo: o.outTradeNo, status: 'created', appliedAt: null },
        data: { status: 'closed' },
      });
    } catch (err) {
      console.warn('[pay] close stale order blocked new order:', o.outTradeNo, (err as Error).message);
      throw Object.assign(new Error('上一笔待支付订单状态尚未确认，请稍后再试'), { code: 'PENDING_ORDER_UNRESOLVED', statusCode: 409 });
    }
  }
}

/**
 * 创建订单 + 调微信 JSAPI 下单，落 PaymentOrder(created) 并回传小程序调起参数。
 * openid 必填（小程序当前用户的 openid）。amount 可由调用方传入（如月→年折算后的实付）；默认= plan.price。
 *
 * 防陈旧订单被后付（双保险）：① 真实单设 time_expire=now+2h，过期后微信侧不可再支付；
 * ② 下新单前先调微信 close-order 关掉同类旧 created 单（closeStalePendingOrders），远端关掉才置本地
 * closed——绝不只改本地状态（那会造成「已付但本地非 created → 入账被跳过 → 收钱不发权益」的资损路径）。
 * markPaidAndApply 以 appliedAt 做「恰好一次」幂等。
 */
export async function createJsapiOrder(args: {
  user: { id: string; tenantId: string };
  plan?: { id: string; name: string; price: number };  // 套餐订单
  sku?: { key: string; name: string; priceFen: number }; // V7-12：单次付费商品订单（与 plan 二选一）
  openid: string;
  amount?: number;
  attribution?: { source: string; refId: string | null }; // D-1 开通来源归因（回调发放时落 ActivationEvent）
  clientRequestId?: string;
  quote?: { quoteFingerprint: string; remainingValue: number; chargeAmount: number; relation: string };
  termsHash?: string;
}): Promise<CreateOrderResult> {
  const itemName = args.plan?.name ?? args.sku?.name ?? '专项能力';
  const itemPrice = args.plan?.price ?? args.sku?.priceFen ?? 0;
  const planId = args.plan?.id ?? '';
  const skuKey = args.sku?.key ?? null;
  const attrSource = args.attribution?.source ?? null;
  const attrRefId = args.attribution?.refId ?? null;
  const total = args.amount ?? itemPrice;
  const outTradeNo = genOutTradeNo();

  const existingIntentResult = (existing: {
    outTradeNo: string; status: string; provider: string; prepayId: string | null; snapshotJson: Prisma.JsonValue;
    planId: string; skuKey: string | null; amount: number; quoteFingerprint: string | null;
  }): CreateOrderResult => {
    const samePayload = existing.planId === planId
      && existing.skuKey === skuKey
      && existing.amount === total
      && existing.quoteFingerprint === (args.quote?.quoteFingerprint ?? null);
    if (!samePayload) {
      throw Object.assign(new Error('购买请求已用于其他方案，请重新确认'), { code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
    }
    if (existing.status !== 'created') {
      throw Object.assign(new Error('该购买请求已处理，请刷新方案状态'), { code: 'ORDER_ALREADY_PROCESSED', statusCode: 409 });
    }
    if (isMockOrder(existing)) return { outTradeNo: existing.outTradeNo, pay: mockPayParams(existing.outTradeNo), mock: true };
    if (sandboxEnabled() && existing.provider === 'mock') {
      return {
        outTradeNo: existing.outTradeNo,
        pay: { timeStamp: Math.floor(Date.now() / 1000).toString(), nonceStr: `sandbox${existing.outTradeNo.slice(-8)}`, package: `prepay_id=mock_${existing.outTradeNo}`, signType: 'RSA', paySign: 'SANDBOX_NO_SIGN' },
      };
    }
    if (existing.prepayId) return { outTradeNo: existing.outTradeNo, pay: buildPayParams(existing.prepayId) };
    throw Object.assign(new Error('订单正在创建，请稍后重试'), { code: 'ORDER_CREATING', statusCode: 409 });
  };

  const recoverIntentRace = async (error: unknown): Promise<CreateOrderResult> => {
    if ((error as { code?: string })?.code !== 'P2002' || !args.clientRequestId) throw error;
    const existing = await prisma.paymentOrder.findUnique({
      where: { userId_clientRequestId: { userId: args.user.id, clientRequestId: args.clientRequestId } },
    });
    if (!existing) throw error;
    return existingIntentResult(existing);
  };

  if (args.clientRequestId) {
    const existing = await prisma.paymentOrder.findUnique({
      where: { userId_clientRequestId: { userId: args.user.id, clientRequestId: args.clientRequestId } },
    });
    if (existing) {
      return existingIntentResult(existing);
    }
  }

  const baseSnapshot = await buildOrderSnapshot({ planId: args.plan?.id, skuKey: args.sku?.key });
  const snapshotJson = args.quote
    ? { ...((baseSnapshot as object | undefined) ?? {}), quote: args.quote } as Prisma.InputJsonValue
    : baseSnapshot;

  // 沙箱（可测性 D9）：跳过真实微信下单，落 provider='mock' 单 + 返回合成调起参数（不签名）。
  // 由 /pay/sandbox/notify 仿真回调驱动入账；真实 notify 端点严格不动。
  if (sandboxEnabled()) {
    try { await prisma.$transaction(async (tx) => {
      await assertOrderRate(tx, args.user.id);
      await tx.paymentOrder.create({
        data: {
          outTradeNo, tenantId: args.user.tenantId, userId: args.user.id, planId, skuKey,
          amount: total, provider: 'mock', status: 'created', attrSource, attrRefId, snapshotJson,
          clientRequestId: args.clientRequestId, quoteFingerprint: args.quote?.quoteFingerprint, termsHash: args.termsHash,
        },
      });
    }); } catch (error) { return recoverIntentRace(error); }
    return {
      outTradeNo,
      pay: { timeStamp: Math.floor(Date.now() / 1000).toString(), nonceStr: `sandbox${outTradeNo.slice(-8)}`, package: `prepay_id=mock_${outTradeNo}`, signType: 'RSA', paySign: 'SANDBOX_NO_SIGN' },
    };
  }

  const staleTarget = args.plan ? { planOrder: true } : { skuKey: args.sku?.key };

  // PAY_MOCK_SUCCESS（测试期，无真凭据）：走**同一段**真实下单逻辑——关同类旧单、下单频控、
  // 条款快照、金额、归因全部照旧，只把「调微信 JSAPI 下单」换成不做（没有 prepay_id 可拿）。
  // 快照打 mock=true，让 sweep / 退款 / 营收统计 / 运营列表都能识别它，且历史单永久可追溯。
  // 付款动作由 POST /pay/mock/pay 触发，到账仍走真实 markPaidAndApply。
  if (payMockSuccessEnabled()) {
    await closeStalePendingOrders(args.user.id, staleTarget, { mock: true, excludeClientRequestId: args.clientRequestId });
    try { await prisma.$transaction(async (tx) => {
      await assertOrderRate(tx, args.user.id);
      await tx.paymentOrder.create({
        data: {
          outTradeNo, tenantId: args.user.tenantId, userId: args.user.id, planId, skuKey,
          amount: total, provider: 'mock', status: 'created', attrSource, attrRefId,
          snapshotJson: { ...((snapshotJson as object | undefined) ?? {}), mock: true } as Prisma.InputJsonValue,
          clientRequestId: args.clientRequestId,
          quoteFingerprint: args.quote?.quoteFingerprint, termsHash: args.termsHash,
        },
      });
    }); } catch (error) { return recoverIntentRace(error); }
    notePayMock('created'); // 不计 notePayOrderCreated：那条指标的口径是「微信支付下单成功数」
    return { outTradeNo, pay: mockPayParams(outTradeNo), mock: true };
  }

  // 兜底断言：合成的模拟 openid 绝不能走到真实 JSAPI（微信不认识它，且这意味着
  // 「账号无 openid + 真凭据已配齐」这种本该被 OPENID_REQUIRED 拦住的组合漏了下来）。
  if (isMockPayerOpenid(args.openid)) {
    throw Object.assign(new Error('缺少支付用户 openid'), { code: 'OPENID_REQUIRED', statusCode: 400 });
  }

  // 关同类旧未付单（P1）：微信侧关掉才置本地 closed，消除陈旧单被后付的窗口。
  await closeStalePendingOrders(args.user.id, staleTarget, { excludeClientRequestId: args.clientRequestId });

  const c = cfg();
  try { await prisma.$transaction(async (tx) => {
    await assertOrderRate(tx, args.user.id);
    await tx.paymentOrder.create({
      data: {
        outTradeNo, tenantId: args.user.tenantId, userId: args.user.id, planId, skuKey,
        amount: total, provider: 'wechat', status: 'created', attrSource, attrRefId, snapshotJson,
        clientRequestId: args.clientRequestId,
        quoteFingerprint: args.quote?.quoteFingerprint, termsHash: args.termsHash,
      },
    });
  }); } catch (error) { return recoverIntentRace(error); }

  // 订单支付截止时刻（RFC3339，真实时钟）：2 小时后微信侧不可再支付，杜绝陈旧 prepay 被后付。
  const timeExpire = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const body = JSON.stringify({
    appid: c.appId,
    mchid: c.mchId,
    description: `军师 · ${itemName}`,
    out_trade_no: outTradeNo,
    time_expire: timeExpire,
    notify_url: c.notifyUrl,
    amount: { total, currency: 'CNY' },
    payer: { openid: args.openid },
  });
  const urlPath = '/v3/pay/transactions/jsapi';
  let res: Response;
  try {
    res = await fetch(payBase() + urlPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: buildAuthToken('POST', urlPath, body),
      },
      body,
      signal: AbortSignal.timeout(WECHAT_HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    await prisma.paymentOrder.update({ where: { outTradeNo }, data: { status: 'failed' } }).catch(() => {});
    throw Object.assign(new Error(`微信下单网络异常：${(err as Error).message}`), { code: 'WECHAT_PAY_CREATE_FAILED', statusCode: 502 });
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    await prisma.paymentOrder.update({ where: { outTradeNo }, data: { status: 'failed' } }).catch(() => {});
    throw Object.assign(new Error(`微信下单失败：HTTP ${res.status} ${errText}`), { code: 'WECHAT_PAY_CREATE_FAILED', statusCode: 502 });
  }
  const data = (await res.json()) as { prepay_id?: string };
  if (!data.prepay_id) throw Object.assign(new Error('微信未返回 prepay_id'), { code: 'WECHAT_PAY_CREATE_FAILED', statusCode: 502 });
  await prisma.paymentOrder.update({ where: { outTradeNo }, data: { prepayId: data.prepay_id } });
  notePayOrderCreated();
  return { outTradeNo, pay: buildPayParams(data.prepay_id) };
}

// —— 继续支付（P1）：对 created 且 prepay 未过期的本人订单重签调起参数（prepay_id 有效期 2h）。 ——
// 距过期 <10 分钟不再放行，避免用户拿到参数后支付时已被微信侧拒绝。（2h 与 time_expire/ORDER_EXPIRE_MS 一致）
const REPAY_SAFE_WINDOW_MS = 2 * 60 * 60 * 1000 - 10 * 60_000;

export async function repayParams(outTradeNo: string, userId: string): Promise<CreateOrderResult> {
  const order = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
  if (!order || order.userId !== userId) throw Object.assign(new Error('订单不存在'), { code: 'ORDER_NOT_FOUND', statusCode: 404 });
  if (order.status !== 'created') throw Object.assign(new Error('订单已不可支付，请重新下单'), { code: 'ORDER_NOT_PAYABLE', statusCode: 409 });
  if (Date.now() - order.createdAt.getTime() > REPAY_SAFE_WINDOW_MS) {
    throw Object.assign(new Error('订单已过支付时限，请重新下单'), { code: 'ORDER_EXPIRED', statusCode: 409 });
  }
  // PAY_MOCK_SUCCESS 模拟单：继续支付同样不调微信，回 mock 标记让端上改调 POST /pay/mock/pay。
  if (isMockOrder(order)) return { outTradeNo, pay: mockPayParams(outTradeNo), mock: true };
  if (order.provider === 'mock') {
    // 沙箱单：与下单时同款合成参数。
    return {
      outTradeNo,
      pay: { timeStamp: Math.floor(Date.now() / 1000).toString(), nonceStr: `sandbox${outTradeNo.slice(-8)}`, package: `prepay_id=mock_${outTradeNo}`, signType: 'RSA', paySign: 'SANDBOX_NO_SIGN' },
    };
  }
  if (!order.prepayId) throw Object.assign(new Error('订单缺少支付会话，请重新下单'), { code: 'ORDER_NOT_PAYABLE', statusCode: 409 });
  if (!payConfigured()) throw Object.assign(new Error('微信支付未配置'), { code: 'PAYMENT_NOT_CONFIGURED', statusCode: 501 });
  return { outTradeNo, pay: buildPayParams(order.prepayId) };
}

/** 判断 created 单是否仍可继续支付（订单列表展示用，与 repayParams 同口径）。 */
export function orderPayable(order: { status: string; createdAt: Date; provider: string; prepayId: string | null }): boolean {
  if (order.status !== 'created') return false;
  if (Date.now() - order.createdAt.getTime() > REPAY_SAFE_WINDOW_MS) return false;
  return order.provider === 'mock' || !!order.prepayId;
}

export function orderPayableUntil(order: { createdAt: Date }): string {
  return new Date(order.createdAt.getTime() + REPAY_SAFE_WINDOW_MS).toISOString();
}

// —— 回调验签（平台证书 RSA-SHA256）——
// 证书来源优先级：① 自动下载缓存中与回调头 Wechatpay-Serial 匹配的证书（轮换无感）；
// ② env 静态证书 WECHAT_PAY_PLATFORM_CERT（兜底/离线，必须同时配置匹配序列号）。两者皆无则拒绝。
export async function verifyNotifySignature(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean> {
  const c = cfg();
  const ts = headers['wechatpay-timestamp'];
  const nonce = headers['wechatpay-nonce'];
  const signature = headers['wechatpay-signature'];
  const serial = headers['wechatpay-serial'];

  if (!ts || !nonce || !signature || !serial) return false;
  const tsSeconds = Number(ts);
  if (!Number.isFinite(tsSeconds) || Math.abs(Date.now() / 1000 - tsSeconds) > 5 * 60) return false;

  let certPem = '';
  if (serial === c.publicKeyId && c.publicKey) certPem = c.publicKey;
  if (!certPem && serial && payConfigured()) {
    let certs = await fetchPlatformCertificates();
    if (!certs.has(serial)) certs = await fetchPlatformCertificates(true); // 未知 serial：多半在轮换，强刷一次
    certPem = certs.get(serial) ?? '';
  }
  if (!certPem && c.platformCert && c.platformCertSerial === serial) certPem = c.platformCert;
  if (!certPem) return false;
  const message = `${ts}\n${nonce}\n${rawBody}\n`;
  try {
    return createVerify('RSA-SHA256').update(message).verify(certPem, signature, 'base64');
  } catch {
    return false;
  }
}

// —— APIv3 密钥 AEAD 解密（AES-256-GCM）：回调 resource 是 JSON、平台证书下载的是 PEM 原文，分两层。 ——
export function decryptAeadResource(resource: { ciphertext: string; nonce: string; associated_data?: string }): string {
  const c = cfg();
  const key = Buffer.from(c.apiV3Key, 'utf8');
  const data = Buffer.from(resource.ciphertext, 'base64');
  const authTag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(0, data.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce, 'utf8'));
  decipher.setAuthTag(authTag);
  if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function decryptNotifyResource(resource: { ciphertext: string; nonce: string; associated_data?: string }): Record<string, unknown> {
  return JSON.parse(decryptAeadResource(resource));
}

// —— 平台证书自动下载/轮换（GET /v3/certificates）——
// 微信平台证书约每 5 年轮换，且换发期间新旧并存；回调头 Wechatpay-Serial 标明用哪张签名。
// 策略：按 serial 内存缓存（TTL 12h），遇到未知 serial 立即强刷一次（拿新证书）；
// 距上次尝试不足 5 分钟一律不重试（防打爆），期间回退 env 静态证书（WECHAT_PAY_PLATFORM_CERT）。
// 例行 QA 安全修复：`force` 只应绕开「缓存仍新鲜」这一条短路，不能绕开「距上次尝试的最短间隔」——
// 否则 /pay/wechat/notify 是 permitAll 的公开 webhook，攻击者每次带一个伪造/随机的
// wechatpay-serial 头都会命中 certs.has(serial)===false → force=true，若 force 能绕开节流，
// 等于可以无限触发对微信证书接口的真实出站请求（放大攻击 / 拖垮微信侧对本商户的调用配额）。
const CERT_TTL_MS = 12 * 3600_000;
const CERT_RETRY_MS = 5 * 60_000;
const platformCertCache = { certs: new Map<string, string>(), fetchedAt: 0, failedAt: 0, lastAttemptAt: 0 };

export async function fetchPlatformCertificates(force = false): Promise<Map<string, string>> {
  if (!payConfigured()) return platformCertCache.certs;
  const at = Date.now();
  const fresh = platformCertCache.certs.size > 0 && at - platformCertCache.fetchedAt < CERT_TTL_MS;
  if (!force && fresh) return platformCertCache.certs;
  const sinceLastAttempt = at - platformCertCache.lastAttemptAt;
  if (platformCertCache.lastAttemptAt > 0 && sinceLastAttempt < CERT_RETRY_MS) return platformCertCache.certs;
  platformCertCache.lastAttemptAt = at;
  try {
    const urlPath = '/v3/certificates';
    const res = await fetch(payBase() + urlPath, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: buildAuthToken('GET', urlPath, '') },
      signal: AbortSignal.timeout(WECHAT_HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: { serial_no?: string; encrypt_certificate?: { ciphertext: string; nonce: string; associated_data?: string } }[] };
    const next = new Map<string, string>();
    for (const item of data.data ?? []) {
      if (!item.serial_no || !item.encrypt_certificate) continue;
      try {
        next.set(item.serial_no, decryptAeadResource(item.encrypt_certificate).trim());
      } catch (err) {
        console.warn('[pay] 平台证书解密失败（跳过该张）:', item.serial_no, (err as Error).message);
      }
    }
    if (next.size > 0) {
      platformCertCache.certs = next;
      platformCertCache.fetchedAt = at;
    }
  } catch (err) {
    platformCertCache.failedAt = at;
    console.warn('[pay] 平台证书下载失败（回退静态证书/下轮重试）:', (err as Error).message);
  }
  return platformCertCache.certs;
}

/** 测试用：清空平台证书缓存。 */
export function resetPlatformCertCache(): void {
  platformCertCache.certs = new Map();
  platformCertCache.fetchedAt = 0;
  platformCertCache.failedAt = 0;
  platformCertCache.lastAttemptAt = 0;
}

/**
 * 处理「支付成功」业务：幂等地把订单置 paid→applied 并发放权益。
 * 幂等核心：同一 outTradeNo 先拿 PostgreSQL 事务级 advisory lock，再做条件更新。
 * 重复回调 / 并发回调会按订单串行化，后到者看到 appliedAt 后直接跳过（防双发）。
 */
// 下单时落库的条款快照形状（buildOrderSnapshot 产出）。
interface OrderSnapshot {
  kind: 'plan' | 'sku';
  plan?: {
    id: string; name: string; price: number; period: string; creditsPerMonth: number; tokenQuotaPerMonth: number;
    planFamilyKey?: string | null; tierRank?: number | null; usageLevel?: string | null; usageLabel?: string | null;
    usageNormalPercent?: number; usageNearPercent?: number; agentCount?: number; featuresJson?: unknown; highlighted?: boolean;
  };
  sku?: { key: string; name: string; kind: string; priceFen: number; grantsModuleKey: string | null; metaJson: unknown };
  /** PAY_MOCK_SUCCESS 模拟单标记（见 isMockOrder）。schema 不加列，标记只挂在这份 Json 快照里。 */
  mock?: boolean;
  quote?: { quoteFingerprint?: string; remainingValue?: number; chargeAmount?: number; relation?: string };
}

export async function markPaidAndApply(parsed: {
  outTradeNo: string; transactionId?: string; tradeState: string; rawJson: Record<string, unknown>;
  /** 解密报文/查单结果中的订单金额（分）、appid、mchid：提供即校验，与本单不一致绝不入账（防串单/伪造）。 */
  amountTotal?: number; appId?: string; mchId?: string;
}, source = 'wechat_pay'): Promise<{ applied: boolean; reason?: string }> {
  const result = await markPaidAndApplyTx(parsed, source);
  // 支付成功订阅消息（P2）：入账后事务外 fire-and-forget，失败绝不影响入账结果。
  if (result.applied) void notifyPaymentApplied(parsed.outTradeNo).catch(() => {});
  return result;
}

async function markPaidAndApplyTx(parsed: {
  outTradeNo: string; transactionId?: string; tradeState: string; rawJson: Record<string, unknown>;
  amountTotal?: number; appId?: string; mchId?: string;
}, source: string): Promise<{ applied: boolean; reason?: string }> {
  return prisma.$transaction(async (tx) => {
    // 对同一订单号串行化回调处理。hashtext(text) 返回 int4，适配 pg_advisory_xact_lock(int)。
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${parsed.outTradeNo}))`;

    const order = await tx.paymentOrder.findUnique({ where: { outTradeNo: parsed.outTradeNo } });
    if (!order) return { applied: false, reason: 'order_not_found' };
    if (order.appliedAt || order.status === 'applied') return { applied: false, reason: 'already_applied' };
    // 不同订单也必须按用户串行化，否则两笔同时到账会各自读取同一份旧套餐状态，造成时长覆盖。
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`entitlement:${order.userId}`}))`;

    // 报文一致性校验（防串单/防伪造的标准防御）：字段存在才比对（沙箱/降级报文可能不带）。
    // 不一致时保持订单原状态（绝不发放、也不标 failed——伪造报文不能影响真单），
    // 原文落 rawNotifyJson 供 admin 卡单清单排查，交给对账/人工处置。
    const c = cfg();
    const mismatch =
      (parsed.amountTotal !== undefined && parsed.amountTotal !== order.amount && 'amount') ||
      (parsed.appId !== undefined && c.appId && parsed.appId !== c.appId && 'appid') ||
      (parsed.mchId !== undefined && c.mchId && parsed.mchId !== c.mchId && 'mchid') || null;
    if (mismatch) {
      console.error(`[pay] 报文字段不一致，拒绝入账 outTradeNo=${parsed.outTradeNo} field=${mismatch} got=${JSON.stringify({ amount: parsed.amountTotal, appid: parsed.appId, mchid: parsed.mchId })} want=${JSON.stringify({ amount: order.amount, appid: c.appId, mchid: c.mchId })}`);
      await tx.paymentOrder.update({
        where: { outTradeNo: parsed.outTradeNo },
        data: { rawNotifyJson: parsed.rawJson as Prisma.InputJsonValue },
      }).catch(() => {});
      return { applied: false, reason: `field_mismatch_${mismatch}` };
    }

    if (parsed.tradeState !== 'SUCCESS') {
      if (order.status === 'created') {
        await tx.paymentOrder.update({
          where: { outTradeNo: parsed.outTradeNo },
          data: { status: 'failed', rawNotifyJson: parsed.rawJson as Prisma.InputJsonValue },
        });
      }
      return { applied: false, reason: `trade_state_${parsed.tradeState}` };
    }

    // status='created' 首次成功回调；status='paid'+appliedAt=null 用于恢复已确认支付但未完成权益发放的订单。
    const claim = await tx.paymentOrder.updateMany({
      where: { outTradeNo: parsed.outTradeNo, status: { in: ['created', 'paid'] }, appliedAt: null },
      data: { status: 'paid', paidAt: new Date(), transactionId: parsed.transactionId ?? null, rawNotifyJson: parsed.rawJson as Prisma.InputJsonValue },
    });
    if (claim.count !== 1) return { applied: false, reason: 'already_applied' };

    // 流水/审计里的支付方式标签。mock 单必须自带「测试模拟」字样：这条 reason 会出现在用户的
    // 算力流水与运营的审计里，不写清楚事后就分不出哪些额度是测试期白发的。
    const payLabel = source === 'wechat_pay_sandbox' ? '微信支付(沙箱)'
      : source === 'wechat_pay_mock' ? '微信支付(测试模拟)'
      : '微信支付';
    // 条款快照优先（P1）：发放按下单时点的配置，防「下单后改价/改额度/删配置」漂移；
    // 历史无快照订单回退读当前配置（行为与旧版一致）。
    const snapshot = (order.snapshotJson ?? null) as OrderSnapshot | null;
    const { source: attrSource, refId: attrRefId } = parseAttribution(order.attrSource, order.attrRefId);
    if (order.skuKey) {
      // V7-12：单次付费商品 → 发放对应权益（模块启用/一次性服务/空间加档）。
      const skuRow = snapshot?.kind === 'sku' && snapshot.sku ? null : await tx.sku.findUnique({ where: { key: order.skuKey } });
      const sku = snapshot?.kind === 'sku' && snapshot.sku
        ? { key: snapshot.sku.key, name: snapshot.sku.name, kind: snapshot.sku.kind, grantsModuleKey: snapshot.sku.grantsModuleKey, metaJson: snapshot.sku.metaJson }
        : skuRow;
      if (!sku) return { applied: false, reason: 'sku_not_found' };
      await applySkuGrant(
        { id: order.userId, tenantId: order.tenantId },
        { key: sku.key, name: sku.name, kind: sku.kind, grantsModuleKey: sku.grantsModuleKey, metaJson: sku.metaJson },
        { reason: `${sku.name} · ${payLabel}`, source, orderId: order.id },
        tx,
      );
      // D-1 开通来源归因：SKU 发放成功 → 落 ActivationEvent（来源来自下单时随订单存的 attrSource；缺省 catalog）。
      await recordActivation({ tenantId: order.tenantId, userId: order.userId, itemType: 'sku', itemKey: sku.key, source: attrSource, refId: attrRefId }, tx).catch(() => {});
    } else {
      const planRow = snapshot?.kind === 'plan' && snapshot.plan ? null : await tx.plan.findUnique({ where: { id: order.planId } });
      const plan = snapshot?.kind === 'plan' && snapshot.plan ? snapshot.plan : planRow;
      if (!plan) return { applied: false, reason: 'plan_not_found' };
      await applyPlanPurchase(
        { id: order.userId, tenantId: order.tenantId },
        plan,
        {
          reason: `${plan.name} · ${payLabel}`, source,
          order: {
            id: order.id, outTradeNo: order.outTradeNo, amount: order.amount, termsHash: order.termsHash,
            quote: snapshot?.quote ?? null,
          },
        },
        tx,
      );
      // 套餐订单归因（P2）：与 SKU 同口径落 ActivationEvent，供多来源漏斗报表。
      await recordActivation({ tenantId: order.tenantId, userId: order.userId, itemType: 'plan', itemKey: plan.id, source: attrSource, refId: attrRefId }, tx).catch(() => {});
    }
    // appliedAt 在 applyPlanPurchase 成功后才设置，确保 paid+appliedAt=null 的订单可被后续回调恢复。
    await tx.paymentOrder.update({ where: { outTradeNo: parsed.outTradeNo }, data: { status: 'applied', appliedAt: new Date() } });
    // 观测口径=发放动作完成；对账以 payment_order 为准。
    // mock 单**不进营收指标**（单量与金额都不进）——假钱进营收看板比缺个数字更糟；
    // 它单独计一条 junshi_pay_mock_total，测试期的量仍然可见。
    if (isMockOrder(order)) notePayMock('applied');
    else notePayApplied(order.skuKey ? 'sku' : 'plan', order.amount);
    return { applied: true };
  });
}

// —— 主动查单（GET /v3/pay/transactions/out-trade-no/{no}）——
// 回调可能丢失/延迟（网络抖动、服务重启窗口），前端 requestPayment 成功后轮询订单状态时，
// 用查单结果补账，消除「已付款但权益未到」的回调竞态。
export interface WechatTransaction {
  out_trade_no?: string;
  transaction_id?: string;
  trade_state?: string;
  [key: string]: unknown;
}

export async function queryWechatOrder(outTradeNo: string): Promise<WechatTransaction> {
  const c = cfg();
  const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(c.mchId)}`;
  let res: Response;
  try {
    res = await fetch(payBase() + urlPath, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: buildAuthToken('GET', urlPath, '') },
      signal: AbortSignal.timeout(WECHAT_HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw Object.assign(new Error(`微信查单网络异常：${(err as Error).message}`), { code: 'WECHAT_PAY_QUERY_FAILED', statusCode: 502 });
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    // 404 = 微信侧不存在该交易（用户从未调起支付 / 单太旧转历史）：调用方据此把超期 created 单安全关单。
    if (res.status === 404) {
      throw Object.assign(new Error(`微信订单不存在：${outTradeNo}`), { code: 'WECHAT_PAY_ORDER_NOT_EXIST', statusCode: 404 });
    }
    throw Object.assign(new Error(`微信查单失败：HTTP ${res.status} ${errText}`), { code: 'WECHAT_PAY_QUERY_FAILED', statusCode: 502 });
  }
  return (await res.json()) as WechatTransaction;
}

// 微信侧终态失败（不会再变成 SUCCESS）：本地订单可安全标 failed。
// NOTPAY / USERPAYING / ACCEPT 是中间态，保持 created 等用户继续支付或下次对账。
const TERMINAL_FAIL_STATES = new Set(['CLOSED', 'REVOKED', 'PAYERROR', 'REFUND']);

/**
 * 查单对账：对 provider=wechat 且尚未发放权益的订单，主动向微信查询交易状态并幂等补账。
 * SUCCESS → markPaidAndApply（与回调同一套「恰好一次」底座，source 区分 wechat_pay_query）；
 * 终态失败 → 标 failed；中间态 → 不动。已发放/非微信单/未配支付则直接短路，不触网。
 */
export async function reconcileOrder(outTradeNo: string): Promise<{ applied: boolean; reason?: string; tradeState?: string }> {
  const order = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
  if (!order) return { applied: false, reason: 'order_not_found' };
  if (order.appliedAt || order.status === 'applied') return { applied: false, reason: 'already_applied' };
  // PAY_MOCK_SUCCESS 模拟单：微信侧根本没有这笔交易，查单必然报错（或被 sweep 当成卡单误处置）。
  // 显式短路——**只跳过，绝不标 failed**：它是一笔合法的本地测试单，等用户点模拟支付即可。
  // 这一条也是 sweepPendingOrders 的兜底（sweep 的 provider='wechat' 筛选已把它排除在外）。
  if (isMockOrder(order)) return { applied: false, reason: 'mock_order' };
  if (order.provider !== 'wechat') return { applied: false, reason: 'provider_not_wechat' };
  if (!payConfigured()) return { applied: false, reason: 'pay_not_configured' };
  if (!['created', 'paid'].includes(order.status)) return { applied: false, reason: `status_${order.status}` };

  const tx = await queryWechatOrder(outTradeNo);
  const tradeState = String(tx.trade_state ?? 'UNKNOWN');
  if (tradeState !== 'SUCCESS' && !TERMINAL_FAIL_STATES.has(tradeState)) {
    return { applied: false, reason: `trade_state_${tradeState}`, tradeState };
  }
  if (tradeState === 'SUCCESS' && (!tx.transaction_id || typeof (tx.amount as { total?: unknown } | undefined)?.total !== 'number'
    || typeof tx.appid !== 'string' || typeof tx.mchid !== 'string')) {
    return { applied: false, reason: 'missing_required_transaction_fields', tradeState };
  }
  // SUCCESS 入账；终态失败由 markPaidAndApply 的非 SUCCESS 分支标 failed —— 两条路径共用同一幂等锁。
  const amt = (tx.amount as { total?: number } | undefined)?.total;
  const r = await markPaidAndApply(
    {
      outTradeNo, transactionId: tx.transaction_id ? String(tx.transaction_id) : undefined, tradeState,
      rawJson: tx as Record<string, unknown>,
      amountTotal: typeof amt === 'number' ? amt : undefined,
      appId: typeof tx.appid === 'string' ? tx.appid : undefined,
      mchId: typeof tx.mchid === 'string' ? tx.mchid : undefined,
    },
    'wechat_pay_query',
  );
  return { ...r, tradeState };
}

// —— 定时对账 sweep（P0：回调丢失/卡单自愈，不依赖用户轮询）——
// 扫两类未终结单（仅 provider=wechat 且已配支付）：
//   paid 未 applied（收钱未发权益的卡单）→ 查单补账；
//   created 超 15 分钟（回调可能丢了）→ 查单：SUCCESS 补账 / 终态失败标 failed /
//     微信侧查无此单且已过 time_expire（2h）→ 本地安全关单（closed），终结陈旧单。
// 由 scheduler 每 5 分钟跑一次（services/scheduler.ts 注册）；admin 手动补账走 reconcileOrder 单发。
const ORDER_EXPIRE_MS = 2 * 60 * 60 * 1000; // 与 createJsapiOrder 的 time_expire 一致

export async function sweepPendingOrders(opts: { batch?: number } = {}): Promise<{ scanned: number; applied: number; failed: number; closed: number }> {
  const stats = { scanned: 0, applied: 0, failed: 0, closed: 0 };
  if (!payConfigured()) return stats;
  const batch = opts.batch ?? 50;
  const staleCreatedBefore = new Date(Date.now() - 15 * 60_000);
  const horizon = new Date(Date.now() - 7 * 86400_000); // 只扫近 7 天，历史遗留交人工
  // provider='wechat' 这一条同时把沙箱单与 PAY_MOCK_SUCCESS 模拟单（provider='mock'）挡在批扫之外——
  // 它们在微信侧不存在，查单必然报错。reconcileOrder 里还有一道按快照 flag 的显式短路兜底。
  const candidates = await prisma.paymentOrder.findMany({
    where: {
      provider: 'wechat',
      appliedAt: null,
      createdAt: { gt: horizon },
      OR: [
        { status: 'paid' },
        { status: 'created', createdAt: { lt: staleCreatedBefore } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: batch,
    select: { outTradeNo: true, status: true, createdAt: true },
  });
  for (const o of candidates) {
    stats.scanned += 1;
    try {
      const r = await reconcileOrder(o.outTradeNo);
      if (r.applied) stats.applied += 1;
      else if (r.tradeState && TERMINAL_FAIL_STATES.has(r.tradeState)) stats.failed += 1;
    } catch (err) {
      const code = (err as { code?: string }).code;
      const expired = Date.now() - o.createdAt.getTime() > ORDER_EXPIRE_MS + 5 * 60_000;
      if (code === 'WECHAT_PAY_ORDER_NOT_EXIST' && o.status === 'created' && expired) {
        // 用户从未调起支付且微信侧已过支付截止：本地关单（微信侧不可再付，安全）。
        await prisma.paymentOrder.updateMany({
          where: { outTradeNo: o.outTradeNo, status: 'created', appliedAt: null },
          data: { status: 'closed' },
        }).catch(() => {});
        stats.closed += 1;
      } else {
        // 网络/网关异常：跳过，下轮再试（不打断整批）。
        console.warn('[pay] sweep reconcile failed:', o.outTradeNo, (err as Error).message);
      }
    }
  }
  notePaySweep(stats);
  return stats;
}

// —— 支付成功订阅消息（P2）：入账后事务外触发；模板未配置/无订阅额度时静默跳过，绝不影响入账。 ——
function snapshotItemName(order: { snapshotJson: unknown; skuKey: string | null; planId: string }): string {
  const snap = (order.snapshotJson ?? null) as OrderSnapshot | null;
  return snap?.plan?.name ?? snap?.sku?.name ?? (order.skuKey ? '专项能力' : '方案套餐');
}

async function notifyPaymentApplied(outTradeNo: string): Promise<void> {
  const order = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
  if (!order) return;
  await sendWechatSubscribeMessage({
    tenantId: order.tenantId,
    userId: order.userId,
    scene: 'payment',
    title: snapshotItemName(order), // 模板「类型」位 = 套餐/能力名
    note: `已到账 ¥${(order.amount / 100).toFixed(2)}，权益已生效`, // 该模板无备注位，只留作通知日志可读
    amountFen: order.amount,
    // 订单号位是纯数字型：优先微信支付单号（全数字，也正是用户在微信账单里看到的那个），
    // 回调还没回填时退化为我们的商户单号（发送侧抽数字）。
    orderNo: order.transactionId || order.outTradeNo,
    // 跳过也要留痕（2026-07-31 真机实测教训）：套餐购买路径此前从不索权 payment 场景，
    // 用户永远没有配额 → 这里静默 return，`wechat_notification_log` 里一条记录都没有，
    // 于是「到账通知从未发出」这件事在库里完全无痕、查不到任何线索，上线至今无人发现。
    // 有了 skipped 行（reason='no subscription quota'），这类失败下次一眼可见。
    logSkipped: true,
  });
}

// —— 退款闭环（P1，后端）：全额退款 + 幂等权益回收。触发入口 = 运营端点（admin 路由，requireSuper）。 ——
// 策略（保守、可审计）：
//   SKU module  → 停用对应 UserModule（仅回收 source='purchase' 的发放，不动运营手动开通）
//   SKU service → 停用一次性凭据 sku:<key>
//   SKU storage → 追回快照记录的字节数（advisory lock，下限 0）
//   套餐        → 用户仍在该套餐上则立即到期（只读/额度冻结由既有过期机制接管）+
//                 追回本单发放的钻石（扣 min(当前余额, 发放额)，不打成负数；不限量余额不动）
export interface RefundResult { ok: boolean; refundId: string; wechatStatus: string }

async function revokeOrderGrant(
  order: { id: string; outTradeNo: string; tenantId: string; userId: string; planId: string; skuKey: string | null; snapshotJson: unknown },
  tx: Prisma.TransactionClient,
): Promise<void> {
  const snap = (order.snapshotJson ?? null) as OrderSnapshot | null;
  if (order.skuKey) {
    const skuRow = snap?.kind === 'sku' && snap.sku ? null : await tx.sku.findUnique({ where: { key: order.skuKey } });
    const kind = snap?.sku?.kind ?? skuRow?.kind ?? 'module';
    const grantsModuleKey = snap?.sku?.grantsModuleKey ?? skuRow?.grantsModuleKey ?? null;
    const sourceEntitlement = await tx.skuEntitlement.findUnique({ where: { sourceOrderId: order.id } });
    if (sourceEntitlement && sourceEntitlement.status === 'active') {
      await tx.skuEntitlement.update({ where: { id: sourceEntitlement.id }, data: { status: 'refunded', refundedAt: new Date() } });
    }
    const otherActiveSources = sourceEntitlement
      ? await tx.skuEntitlement.count({ where: { userId: order.userId, entitlementKey: sourceEntitlement.entitlementKey, status: 'active' } })
      : 0;
    if (kind === 'storage') {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`storage:${order.userId}`}))`;
      const bytes = Number((snap?.sku?.metaJson as { bytes?: number } | null)?.bytes ?? (skuRow?.metaJson as { bytes?: number } | null)?.bytes ?? 0);
      const profile = await tx.profile.findFirst({ where: { tenantId: order.tenantId }, orderBy: { updatedAt: 'desc' } });
      if (profile && bytes > 0) {
        const extra = (profile.extraJson as Record<string, unknown> | null) ?? {};
        const bonus = Math.max(0, Number(extra.storageBonus ?? 0) - bytes);
        await tx.profile.update({ where: { id: profile.id }, data: { extraJson: { ...extra, storageBonus: bonus } as Prisma.InputJsonValue } });
      }
    } else if (kind === 'module' && grantsModuleKey && (!sourceEntitlement || otherActiveSources === 0)) {
      await tx.userModule.updateMany({
        where: { userId: order.userId, moduleKey: grantsModuleKey, source: 'purchase' },
        data: { enabled: false },
      });
    } else if (!sourceEntitlement || otherActiveSources === 0) {
      await tx.userModule.updateMany({
        where: { userId: order.userId, moduleKey: `sku:${order.skuKey}` },
        data: { enabled: false },
      });
    }
  } else {
    const ledger = await revokePlanEntitlement(tx, { orderId: order.id, userId: order.userId });
    if (!ledger.handled) {
      // 迁移前历史订单无权益账本，只能保留旧版保守回收口径。
      const user = await tx.user.findUnique({ where: { id: order.userId }, select: { planId: true } });
      if (user?.planId === order.planId) await tx.user.update({ where: { id: order.userId }, data: { planExpiresAt: new Date() } });
    }
    const planRow = snap?.kind === 'plan' && snap.plan ? null : await tx.plan.findUnique({ where: { id: order.planId } });
    const granted = ledger.handled ? ledger.creditsToRevoke : (snap?.plan?.creditsPerMonth ?? planRow?.creditsPerMonth ?? 0);
    if (granted > 0) {
      const last = await tx.creditLedger.findFirst({ where: { userId: order.userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      const balance = last?.balance ?? 0;
      // 不限量（-1）与零余额不追扣；只追回「本单发放且尚未消耗」的部分。
      if (balance > 0) {
        await chargeCredits(order.tenantId, order.userId, Math.min(balance, granted), `退款追回 · ${snapshotItemName(order)}`, tx);
      }
    }
  }
}

export async function refundWechatOrder(outTradeNo: string, opts: { reason?: string; by?: string } = {}): Promise<RefundResult> {
  const order = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
  if (!order) throw Object.assign(new Error('订单不存在'), { code: 'ORDER_NOT_FOUND', statusCode: 404 });
  // PAY_MOCK_SUCCESS 模拟单可退：**不调微信真退款接口**（那笔交易在微信侧不存在，也确实没有钱要退），
  // 但**本地权益回收照常执行**——运营必须能撤掉测试期的误发放（套餐立即到期 / 追回未消耗算力 /
  // 停用模块），否则测试期白发的权益永远撤不掉。沙箱单（provider='mock' 但无 mock 快照）行为不变，
  // 仍然拒绝退款。
  const mock = isMockOrder(order);
  if (!mock && order.provider !== 'wechat') throw Object.assign(new Error('非微信支付订单，无法原路退款'), { code: 'PROVIDER_NOT_WECHAT', statusCode: 409 });
  if (order.refundedAt || order.status === 'refunded') throw Object.assign(new Error('订单已退款'), { code: 'ALREADY_REFUNDED', statusCode: 409 });
  if (!['paid', 'applied'].includes(order.status)) throw Object.assign(new Error('订单未支付成功，无款可退'), { code: 'ORDER_NOT_PAID', statusCode: 409 });
  if (!mock && !payConfigured()) throw Object.assign(new Error('微信支付未配置'), { code: 'PAYMENT_NOT_CONFIGURED', statusCode: 501 });

  // 商户退款单号：js 前缀换 rf，长度不变（≤32），同单幂等复用同一退款单号。
  const outRefundNo = `rf${outTradeNo.slice(2)}`.slice(0, 32);
  let remoteRefundId: string | undefined;
  // 模拟单的「退款受理状态」标 MOCK：它会进 user.pay.refund 审计与运营端提示，
  // 一眼能看出这笔退款没有真实资金流。
  let wechatStatus = 'MOCK';
  if (!mock) {
    const urlPath = '/v3/refund/domestic/refunds';
    const body = JSON.stringify({
      out_trade_no: outTradeNo,
      out_refund_no: outRefundNo,
      reason: (opts.reason ?? '').trim().slice(0, 80) || undefined,
      notify_url: cfg().notifyUrl,
      amount: { refund: order.amount, total: order.amount, currency: 'CNY' },
    });
    let res: Response;
    try {
      res = await fetch(payBase() + urlPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: buildAuthToken('POST', urlPath, body) },
        body,
        signal: AbortSignal.timeout(WECHAT_HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      throw Object.assign(new Error(`微信退款网络异常：${(err as Error).message}`), { code: 'WECHAT_PAY_REFUND_FAILED', statusCode: 502 });
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw Object.assign(new Error(`微信退款失败：HTTP ${res.status} ${errText}`), { code: 'WECHAT_PAY_REFUND_FAILED', statusCode: 502 });
    }
    const data = (await res.json()) as { refund_id?: string; status?: string };
    remoteRefundId = data.refund_id;
    wechatStatus = data.status ?? 'PROCESSING';
  }

  const normalized = wechatStatus.toUpperCase();
  const finalSuccess = mock || normalized === 'SUCCESS';
  const refundStatus = finalSuccess ? 'refunded'
    : normalized === 'CLOSED' ? 'refund_closed'
      : normalized === 'ABNORMAL' ? 'refund_abnormal'
        : normalized === 'PROCESSING' ? 'refund_processing' : 'refund_requested';
  // 申请受理不等于退款完成。只有 SUCCESS（或无真实资金流的 mock）才回收权益并写 refundedAt。
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${outTradeNo}))`;
    const cur = await tx.paymentOrder.findUnique({ where: { outTradeNo } });
    if (!cur || cur.refundedAt) return;
    if (finalSuccess) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`entitlement:${cur.userId}`}))`;
      if (cur.appliedAt) await revokeOrderGrant(cur, tx);
    }
    await tx.paymentOrder.update({
      where: { outTradeNo },
      data: {
        ...(finalSuccess ? { status: 'refunded', refundedAt: new Date() } : {}),
        refundStatus, refundUpdatedAt: new Date(), refundId: remoteRefundId ?? outRefundNo,
        refundReason: (opts.reason ?? '').trim().slice(0, 200) || null,
      },
    });
    await tx.auditLog.create({
      data: {
        tenantId: order.tenantId, userId: order.userId, action: 'user.pay.refund',
        payloadJson: { outTradeNo, outRefundNo, amount: order.amount, reason: opts.reason ?? null, by: opts.by ?? null, wechatStatus, mock, item: snapshotItemName(order) },
      },
    }).catch(() => {});
  });
  // mock 单同样不进退款金额指标（进了会把营收/退款两侧同时污染）；单独计 mock 事件。
  if (finalSuccess) {
    if (mock) notePayMock('refunded');
    else notePayRefund(order.amount);
  }
  return { ok: true, refundId: remoteRefundId ?? outRefundNo, wechatStatus };
}

/**
 * 退款结果通知（REFUND.SUCCESS 等）。两条来源，均需在此收口：
 *  1) 本地 refundWechatOrder 主动退款 → 状态已同步落库，这里幂等补记原文即可。
 *  2) 商户在微信商户后台/客服直接退款 → 本地订单仍是 paid/applied，从未走过 revokeOrderGrant。
 *     必须在这里补齐权益回收 + 置 refunded，否则「钱退了、权益还在」（开卖即资损口）。
 * 幂等：outTradeNo advisory lock（与 refundWechatOrder 同锁串行化）+ refundedAt 短路；
 * 仅对 refund_status==='SUCCESS' 且全额退款回收权益，部分退款/金额不符不自动撤权益、留人工。
 */
export async function markRefundNotified(decoded: {
  out_trade_no?: string; refund_status?: string; refund_id?: string; out_refund_no?: string;
  amount?: { refund?: number; total?: number; payer_refund?: number };
}): Promise<void> {
  if (!decoded.out_trade_no) return;
  const outTradeNo = decoded.out_trade_no;
  const remoteStatus = (decoded.refund_status ?? '').toUpperCase();
  const success = remoteStatus === 'SUCCESS';
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${outTradeNo}))`;
    const cur = await tx.paymentOrder.findUnique({ where: { outTradeNo } });
    if (!cur) return;
    // 已是退款终态（本地主动退款已处理，或此前回调已回收）：仅幂等补记原文。
    if (cur.refundedAt || cur.status === 'refunded') {
      await tx.paymentOrder.update({ where: { outTradeNo }, data: { refundRawJson: decoded as Prisma.InputJsonValue, refundUpdatedAt: new Date() } });
      return;
    }
    // 非成功态（CLOSED/ABNORMAL 等）：不动权益，只记原文。
    if (!success) {
      const refundStatus = remoteStatus === 'CLOSED' ? 'refund_closed'
        : remoteStatus === 'ABNORMAL' ? 'refund_abnormal'
          : remoteStatus === 'PROCESSING' ? 'refund_processing' : 'refund_requested';
      await tx.paymentOrder.update({ where: { outTradeNo }, data: { refundStatus, refundRawJson: decoded as Prisma.InputJsonValue, refundUpdatedAt: new Date() } });
      return;
    }
    // 金额校验：仅全额退款自动回收；部分退款或金额不符 → 记原文 + 审计告警，交人工，绝不误撤。
    const refundAmt = decoded.amount?.refund;
    const totalAmt = decoded.amount?.total;
    if (typeof refundAmt !== 'number' || typeof totalAmt !== 'number' || refundAmt !== cur.amount || totalAmt !== cur.amount) {
      await tx.paymentOrder.update({ where: { outTradeNo }, data: { refundRawJson: decoded as Prisma.InputJsonValue, refundUpdatedAt: new Date() } });
      await tx.auditLog.create({
        data: { tenantId: cur.tenantId, userId: cur.userId, action: 'user.pay.refund.partial_unhandled',
          payloadJson: { outTradeNo, refundAmt, totalAmt, orderAmount: cur.amount, item: snapshotItemName(cur) } },
      }).catch(() => {});
      return;
    }
    // 商户后台退款成功、本地尚未回收：撤权益（仅 appliedAt 已发放的单）+ 置 refunded。
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`entitlement:${cur.userId}`}))`;
    if (cur.appliedAt) await revokeOrderGrant(cur, tx);
    await tx.paymentOrder.update({
      where: { outTradeNo },
      data: {
        status: 'refunded',
        refundStatus: 'refunded',
        refundId: decoded.refund_id ?? decoded.out_refund_no ?? null,
        refundedAt: new Date(),
        refundUpdatedAt: new Date(),
        refundReason: '商户后台退款（回调触发）',
        refundRawJson: decoded as Prisma.InputJsonValue,
      },
    });
    await tx.auditLog.create({
      data: { tenantId: cur.tenantId, userId: cur.userId, action: 'user.pay.refund.notify_revoked',
        payloadJson: { outTradeNo, refundId: decoded.refund_id ?? null, amount: cur.amount, item: snapshotItemName(cur), source: 'merchant_backend' } },
    }).catch(() => {});
  });
}

/** 主动查退款：通知丢失时仍可把 PROCESSING 推进到成功/关闭/异常终态。 */
export async function queryWechatRefund(outRefundNo: string): Promise<Record<string, unknown>> {
  const urlPath = `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`;
  let res: Response;
  try {
    res = await fetch(payBase() + urlPath, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: buildAuthToken('GET', urlPath, '') },
      signal: AbortSignal.timeout(WECHAT_HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw Object.assign(new Error(`微信查退款网络异常：${(err as Error).message}`), { code: 'WECHAT_PAY_REFUND_QUERY_FAILED', statusCode: 502 });
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw Object.assign(new Error(`微信查退款失败：HTTP ${res.status} ${detail}`), { code: 'WECHAT_PAY_REFUND_QUERY_FAILED', statusCode: 502 });
  }
  return await res.json() as Record<string, unknown>;
}

export async function sweepPendingRefunds(opts: { batch?: number } = {}): Promise<{ scanned: number; completed: number }> {
  if (!payConfigured()) return { scanned: 0, completed: 0 };
  const rows = await prisma.paymentOrder.findMany({
    where: { provider: 'wechat', refundedAt: null, refundStatus: { in: ['refund_requested', 'refund_processing'] }, refundId: { not: null } },
    orderBy: { refundUpdatedAt: 'asc' }, take: Math.min(Math.max(opts.batch ?? 50, 1), 200),
  });
  let completed = 0;
  for (const row of rows) {
    try {
      const remote = await queryWechatRefund(row.refundId!);
      await markRefundNotified({
        out_trade_no: String(remote.out_trade_no ?? row.outTradeNo),
        refund_status: String(remote.status ?? 'PROCESSING'),
        refund_id: typeof remote.refund_id === 'string' ? remote.refund_id : row.refundId ?? undefined,
        out_refund_no: typeof remote.out_refund_no === 'string' ? remote.out_refund_no : undefined,
        amount: remote.amount as { refund?: number; total?: number; payer_refund?: number } | undefined,
      });
      if (String(remote.status ?? '').toUpperCase() === 'SUCCESS') completed += 1;
    } catch (err) {
      console.warn('[pay] refund sweep failed:', row.outTradeNo, (err as Error).message);
    }
  }
  return { scanned: rows.length, completed };
}
