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
// 安全注记：回调资源用 APIv3 密钥做 AES-256-GCM 解密（已实现）。回调「签名」应再用微信平台证书
// （RSA-SHA256，Wechatpay-Signature 头）验证——平台证书需另行下载/缓存，配 WECHAT_PAY_PLATFORM_CERT
// （PEM）后由 verifyNotifySignature 校验；未配则仅依赖 AEAD 解密（解不出即判伪），并记日志提醒补证书。

import { createSign, createVerify, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { applyPlanPurchase, applySkuGrant } from './purchase.js';
import { parseAttribution, recordActivation } from './activation.js';
import { sandboxEnabled } from './sandbox.js';
import { chargeCredits } from './credits.js';
import { sendWechatSubscribeMessage } from './wechatSubscribe.js';

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
  };
}

/** 是否配齐真实支付凭据。未配齐 → 路由回退演示购买。 */
export function payConfigured(): boolean {
  const c = cfg();
  return !!(c.appId && c.mchId && c.apiV3Key && c.certSerial && c.privateKey && c.notifyUrl);
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
}

// 下单频控（P2）：同一用户 10 分钟内最多 10 笔新订单（覆盖套餐+SKU），超出 429。
// 防恶意刷单打微信 API / 刷爆 PaymentOrder 表；正常用户远达不到该频率。
const ORDER_RATE_WINDOW_MS = 10 * 60_000;
const ORDER_RATE_MAX = 10;

async function assertOrderRate(userId: string): Promise<void> {
  const recent = await prisma.paymentOrder.count({
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
    return { kind: 'plan', plan: { id: p.id, name: p.name, price: p.price, period: p.period, creditsPerMonth: p.creditsPerMonth, tokenQuotaPerMonth: p.tokenQuotaPerMonth } };
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
 */
async function closeStalePendingOrders(userId: string, target: { planOrder?: boolean; skuKey?: string }): Promise<void> {
  const where: Prisma.PaymentOrderWhereInput = target.planOrder
    ? { userId, provider: 'wechat', status: 'created', appliedAt: null, planId: { not: '' } }
    : { userId, provider: 'wechat', status: 'created', appliedAt: null, skuKey: target.skuKey };
  const stale = await prisma.paymentOrder.findMany({ where, select: { outTradeNo: true }, take: 5, orderBy: { createdAt: 'asc' } });
  for (const o of stale) {
    try {
      await closeWechatOrder(o.outTradeNo);
      await prisma.paymentOrder.updateMany({
        where: { outTradeNo: o.outTradeNo, status: 'created', appliedAt: null },
        data: { status: 'closed' },
      });
    } catch (err) {
      console.warn('[pay] close stale order skipped:', o.outTradeNo, (err as Error).message);
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
}): Promise<CreateOrderResult> {
  const itemName = args.plan?.name ?? args.sku?.name ?? '专项能力';
  const itemPrice = args.plan?.price ?? args.sku?.priceFen ?? 0;
  const planId = args.plan?.id ?? '';
  const skuKey = args.sku?.key ?? null;
  const attrSource = args.attribution?.source ?? null;
  const attrRefId = args.attribution?.refId ?? null;
  const total = args.amount ?? itemPrice;
  const outTradeNo = genOutTradeNo();

  await assertOrderRate(args.user.id);
  const snapshotJson = await buildOrderSnapshot({ planId: args.plan?.id, skuKey: args.sku?.key });

  // 沙箱（可测性 D9）：跳过真实微信下单，落 provider='mock' 单 + 返回合成调起参数（不签名）。
  // 由 /pay/sandbox/notify 仿真回调驱动入账；真实 notify 端点严格不动。
  if (sandboxEnabled()) {
    await prisma.paymentOrder.create({
      data: {
        outTradeNo, tenantId: args.user.tenantId, userId: args.user.id, planId, skuKey,
        amount: total, provider: 'mock', status: 'created', attrSource, attrRefId, snapshotJson,
      },
    });
    return {
      outTradeNo,
      pay: { timeStamp: Math.floor(Date.now() / 1000).toString(), nonceStr: `sandbox${outTradeNo.slice(-8)}`, package: `prepay_id=mock_${outTradeNo}`, signType: 'RSA', paySign: 'SANDBOX_NO_SIGN' },
    };
  }

  // 关同类旧未付单（P1）：微信侧关掉才置本地 closed，消除陈旧单被后付的窗口。
  await closeStalePendingOrders(args.user.id, args.plan ? { planOrder: true } : { skuKey: args.sku?.key });

  const c = cfg();
  await prisma.paymentOrder.create({
    data: {
      outTradeNo, tenantId: args.user.tenantId, userId: args.user.id, planId, skuKey,
      amount: total, provider: 'wechat', status: 'created', attrSource, attrRefId, snapshotJson,
    },
  });

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

// —— 回调验签（平台证书 RSA-SHA256）——
// 证书来源优先级：① 自动下载缓存中与回调头 Wechatpay-Serial 匹配的证书（轮换无感）；
// ② env 静态证书 WECHAT_PAY_PLATFORM_CERT（兜底/离线）。两者皆无 → 跳过签名校验，
// 仅靠 AEAD 解密判真伪（与历史行为一致，记日志提醒）。
export async function verifyNotifySignature(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean> {
  const c = cfg();
  const ts = headers['wechatpay-timestamp'];
  const nonce = headers['wechatpay-nonce'];
  const signature = headers['wechatpay-signature'];
  const serial = headers['wechatpay-serial'];

  let certPem = '';
  if (serial && payConfigured()) {
    let certs = await fetchPlatformCertificates();
    if (!certs.has(serial)) certs = await fetchPlatformCertificates(true); // 未知 serial：多半在轮换，强刷一次
    certPem = certs.get(serial) ?? '';
  }
  if (!certPem) certPem = c.platformCert;
  if (!certPem) {
    console.warn('[pay] 无可用平台证书（自动下载失败且未配 WECHAT_PAY_PLATFORM_CERT）：跳过回调签名校验，仅靠 AEAD 解密判真伪');
    return true;
  }
  if (!ts || !nonce || !signature) return false;
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
// 拉取失败 5 分钟内不重试（防打爆），期间回退 env 静态证书（WECHAT_PAY_PLATFORM_CERT）。
const CERT_TTL_MS = 12 * 3600_000;
const CERT_RETRY_MS = 5 * 60_000;
const platformCertCache = { certs: new Map<string, string>(), fetchedAt: 0, failedAt: 0 };

export async function fetchPlatformCertificates(force = false): Promise<Map<string, string>> {
  if (!payConfigured()) return platformCertCache.certs;
  const at = Date.now();
  const fresh = platformCertCache.certs.size > 0 && at - platformCertCache.fetchedAt < CERT_TTL_MS;
  const inBackoff = at - platformCertCache.failedAt < CERT_RETRY_MS;
  if ((!force && fresh) || (inBackoff && !fresh && !force)) return platformCertCache.certs;
  try {
    const urlPath = '/v3/certificates';
    const res = await fetch(payBase() + urlPath, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: buildAuthToken('GET', urlPath, '') },
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
}

/**
 * 处理「支付成功」业务：幂等地把订单置 paid→applied 并发放权益。
 * 幂等核心：同一 outTradeNo 先拿 PostgreSQL 事务级 advisory lock，再做条件更新。
 * 重复回调 / 并发回调会按订单串行化，后到者看到 appliedAt 后直接跳过（防双发）。
 */
// 下单时落库的条款快照形状（buildOrderSnapshot 产出）。
interface OrderSnapshot {
  kind: 'plan' | 'sku';
  plan?: { id: string; name: string; price: number; period: string; creditsPerMonth: number; tokenQuotaPerMonth: number };
  sku?: { key: string; name: string; kind: string; priceFen: number; grantsModuleKey: string | null; metaJson: unknown };
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

    const payLabel = source === 'wechat_pay_sandbox' ? '微信支付(沙箱)' : '微信支付';
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
        { reason: `${sku.name} · ${payLabel}`, source },
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
        { reason: `${plan.name} · ${payLabel}`, source },
        tx,
      );
      // 套餐订单归因（P2）：与 SKU 同口径落 ActivationEvent，供多来源漏斗报表。
      await recordActivation({ tenantId: order.tenantId, userId: order.userId, itemType: 'plan', itemKey: plan.id, source: attrSource, refId: attrRefId }, tx).catch(() => {});
    }
    // appliedAt 在 applyPlanPurchase 成功后才设置，确保 paid+appliedAt=null 的订单可被后续回调恢复。
    await tx.paymentOrder.update({ where: { outTradeNo: parsed.outTradeNo }, data: { status: 'applied', appliedAt: new Date() } });
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
  if (order.provider !== 'wechat') return { applied: false, reason: 'provider_not_wechat' };
  if (!payConfigured()) return { applied: false, reason: 'pay_not_configured' };
  if (!['created', 'paid'].includes(order.status)) return { applied: false, reason: `status_${order.status}` };

  const tx = await queryWechatOrder(outTradeNo);
  const tradeState = String(tx.trade_state ?? 'UNKNOWN');
  if (tradeState !== 'SUCCESS' && !TERMINAL_FAIL_STATES.has(tradeState)) {
    return { applied: false, reason: `trade_state_${tradeState}`, tradeState };
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
    title: snapshotItemName(order),
    note: `已到账 ¥${(order.amount / 100).toFixed(2)}，权益已生效`,
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
  order: { outTradeNo: string; tenantId: string; userId: string; planId: string; skuKey: string | null; snapshotJson: unknown },
  tx: Prisma.TransactionClient,
): Promise<void> {
  const snap = (order.snapshotJson ?? null) as OrderSnapshot | null;
  if (order.skuKey) {
    const skuRow = snap?.kind === 'sku' && snap.sku ? null : await tx.sku.findUnique({ where: { key: order.skuKey } });
    const kind = snap?.sku?.kind ?? skuRow?.kind ?? 'module';
    const grantsModuleKey = snap?.sku?.grantsModuleKey ?? skuRow?.grantsModuleKey ?? null;
    if (kind === 'storage') {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`storage:${order.userId}`}))`;
      const bytes = Number((snap?.sku?.metaJson as { bytes?: number } | null)?.bytes ?? (skuRow?.metaJson as { bytes?: number } | null)?.bytes ?? 0);
      const profile = await tx.profile.findFirst({ where: { tenantId: order.tenantId }, orderBy: { updatedAt: 'desc' } });
      if (profile && bytes > 0) {
        const extra = (profile.extraJson as Record<string, unknown> | null) ?? {};
        const bonus = Math.max(0, Number(extra.storageBonus ?? 0) - bytes);
        await tx.profile.update({ where: { id: profile.id }, data: { extraJson: { ...extra, storageBonus: bonus } as Prisma.InputJsonValue } });
      }
    } else if (kind === 'module' && grantsModuleKey) {
      await tx.userModule.updateMany({
        where: { userId: order.userId, moduleKey: grantsModuleKey, source: 'purchase' },
        data: { enabled: false },
      });
    } else {
      await tx.userModule.updateMany({
        where: { userId: order.userId, moduleKey: `sku:${order.skuKey}` },
        data: { enabled: false },
      });
    }
  } else {
    const user = await tx.user.findUnique({ where: { id: order.userId }, select: { planId: true } });
    if (user?.planId === order.planId) {
      await tx.user.update({ where: { id: order.userId }, data: { planExpiresAt: new Date() } });
    }
    const planRow = snap?.kind === 'plan' && snap.plan ? null : await tx.plan.findUnique({ where: { id: order.planId } });
    const granted = snap?.plan?.creditsPerMonth ?? planRow?.creditsPerMonth ?? 0;
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
  if (order.provider !== 'wechat') throw Object.assign(new Error('非微信支付订单，无法原路退款'), { code: 'PROVIDER_NOT_WECHAT', statusCode: 409 });
  if (order.refundedAt || order.status === 'refunded') throw Object.assign(new Error('订单已退款'), { code: 'ALREADY_REFUNDED', statusCode: 409 });
  if (!['paid', 'applied'].includes(order.status)) throw Object.assign(new Error('订单未支付成功，无款可退'), { code: 'ORDER_NOT_PAID', statusCode: 409 });
  if (!payConfigured()) throw Object.assign(new Error('微信支付未配置'), { code: 'PAYMENT_NOT_CONFIGURED', statusCode: 501 });

  // 商户退款单号：js 前缀换 rf，长度不变（≤32），同单幂等复用同一退款单号。
  const outRefundNo = `rf${outTradeNo.slice(2)}`.slice(0, 32);
  const urlPath = '/v3/refund/domestic/refunds';
  const body = JSON.stringify({
    out_trade_no: outTradeNo,
    out_refund_no: outRefundNo,
    reason: (opts.reason ?? '').trim().slice(0, 80) || undefined,
    amount: { refund: order.amount, total: order.amount, currency: 'CNY' },
  });
  let res: Response;
  try {
    res = await fetch(payBase() + urlPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: buildAuthToken('POST', urlPath, body) },
      body,
    });
  } catch (err) {
    throw Object.assign(new Error(`微信退款网络异常：${(err as Error).message}`), { code: 'WECHAT_PAY_REFUND_FAILED', statusCode: 502 });
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw Object.assign(new Error(`微信退款失败：HTTP ${res.status} ${errText}`), { code: 'WECHAT_PAY_REFUND_FAILED', statusCode: 502 });
  }
  const data = (await res.json()) as { refund_id?: string; status?: string };
  const wechatStatus = data.status ?? 'PROCESSING';

  // 微信已受理退款（SUCCESS/PROCESSING 均不可逆）→ 幂等落状态 + 回收权益（同订单 advisory lock 串行化）。
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${outTradeNo}))`;
    const cur = await tx.paymentOrder.findUnique({ where: { outTradeNo } });
    if (!cur || cur.refundedAt) return;
    if (cur.appliedAt) await revokeOrderGrant(cur, tx);
    await tx.paymentOrder.update({
      where: { outTradeNo },
      data: { status: 'refunded', refundId: data.refund_id ?? outRefundNo, refundedAt: new Date(), refundReason: (opts.reason ?? '').trim().slice(0, 200) || null },
    });
    await tx.auditLog.create({
      data: {
        tenantId: order.tenantId, userId: order.userId, action: 'user.pay.refund',
        payloadJson: { outTradeNo, outRefundNo, amount: order.amount, reason: opts.reason ?? null, by: opts.by ?? null, wechatStatus, item: snapshotItemName(order) },
      },
    }).catch(() => {});
  });
  return { ok: true, refundId: data.refund_id ?? outRefundNo, wechatStatus };
}

/** 退款结果通知（REFUND.SUCCESS 等）：退款状态在 refundWechatOrder 已同步落库，这里仅幂等补记原文与终态。 */
export async function markRefundNotified(decoded: { out_trade_no?: string; refund_status?: string }): Promise<void> {
  if (!decoded.out_trade_no) return;
  await prisma.paymentOrder.updateMany({
    where: { outTradeNo: decoded.out_trade_no, status: 'refunded' },
    data: { rawNotifyJson: decoded as Prisma.InputJsonValue },
  }).catch(() => {});
}
