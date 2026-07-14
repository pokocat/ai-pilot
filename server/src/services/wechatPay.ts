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

/**
 * 创建订单 + 调微信 JSAPI 下单，落 PaymentOrder(created) 并回传小程序调起参数。
 * openid 必填（小程序当前用户的 openid）。amount 可由调用方传入（如月→年折算后的实付）；默认= plan.price。
 *
 * 防陈旧订单被后付：真实单设 time_expire=now+2h，过期后微信侧不可再支付（避免「先下单再升级后又付旧单」类陈旧支付）。
 * 注：刻意不在本地把旧 created 单改 'closed'——那只改本地状态、微信侧仍可付，会造成「已付但本地非 created → 入账被跳过
 * → 收钱不发权益」的资损路径。markPaidAndApply 以 appliedAt 做「恰好一次」幂等；用户若真付了两单即两次合法叠加
 * （各自付费、续费/升级时长叠加），非资损。严格「同一时刻仅一个未付单」需调微信 close-order API，留后续硬化。
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

  // 沙箱（可测性 D9）：跳过真实微信下单，落 provider='mock' 单 + 返回合成调起参数（不签名）。
  // 由 /pay/sandbox/notify 仿真回调驱动入账；真实 notify 端点严格不动。
  if (sandboxEnabled()) {
    await prisma.paymentOrder.create({
      data: {
        outTradeNo, tenantId: args.user.tenantId, userId: args.user.id, planId, skuKey,
        amount: total, provider: 'mock', status: 'created', attrSource, attrRefId,
      },
    });
    return {
      outTradeNo,
      pay: { timeStamp: Math.floor(Date.now() / 1000).toString(), nonceStr: `sandbox${outTradeNo.slice(-8)}`, package: `prepay_id=mock_${outTradeNo}`, signType: 'RSA', paySign: 'SANDBOX_NO_SIGN' },
    };
  }

  const c = cfg();
  await prisma.paymentOrder.create({
    data: {
      outTradeNo, tenantId: args.user.tenantId, userId: args.user.id, planId, skuKey,
      amount: total, provider: 'wechat', status: 'created', attrSource, attrRefId,
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

// —— 回调验签（平台证书 RSA-SHA256；配了平台证书才校验）——
export function verifyNotifySignature(headers: Record<string, string | undefined>, rawBody: string): boolean {
  const c = cfg();
  if (!c.platformCert) return true; // 未配平台证书：跳过签名校验，仅靠 AEAD 解密判真伪（记日志提醒补证书）
  const ts = headers['wechatpay-timestamp'];
  const nonce = headers['wechatpay-nonce'];
  const signature = headers['wechatpay-signature'];
  if (!ts || !nonce || !signature) return false;
  const message = `${ts}\n${nonce}\n${rawBody}\n`;
  try {
    return createVerify('RSA-SHA256').update(message).verify(c.platformCert, signature, 'base64');
  } catch {
    return false;
  }
}

// —— 回调资源 AEAD 解密（APIv3 密钥，AES-256-GCM）——
export function decryptNotifyResource(resource: { ciphertext: string; nonce: string; associated_data?: string }): Record<string, unknown> {
  const c = cfg();
  const key = Buffer.from(c.apiV3Key, 'utf8');
  const data = Buffer.from(resource.ciphertext, 'base64');
  const authTag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(0, data.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce, 'utf8'));
  decipher.setAuthTag(authTag);
  if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

/**
 * 处理「支付成功」业务：幂等地把订单置 paid→applied 并发放权益。
 * 幂等核心：同一 outTradeNo 先拿 PostgreSQL 事务级 advisory lock，再做条件更新。
 * 重复回调 / 并发回调会按订单串行化，后到者看到 appliedAt 后直接跳过（防双发）。
 */
export async function markPaidAndApply(parsed: {
  outTradeNo: string; transactionId?: string; tradeState: string; rawJson: Record<string, unknown>;
  /** 解密报文/查单结果中的订单金额（分）、appid、mchid：提供即校验，与本单不一致绝不入账（防串单/伪造）。 */
  amountTotal?: number; appId?: string; mchId?: string;
}, source = 'wechat_pay'): Promise<{ applied: boolean; reason?: string }> {
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
    if (order.skuKey) {
      // V7-12：单次付费商品 → 发放对应权益（模块启用/一次性服务/空间加档）。
      const sku = await tx.sku.findUnique({ where: { key: order.skuKey } });
      if (!sku) return { applied: false, reason: 'sku_not_found' };
      await applySkuGrant(
        { id: order.userId, tenantId: order.tenantId },
        { key: sku.key, name: sku.name, kind: sku.kind, grantsModuleKey: sku.grantsModuleKey, metaJson: sku.metaJson },
        { reason: `${sku.name} · ${payLabel}`, source },
        tx,
      );
      // D-1 开通来源归因：SKU 发放成功 → 落 ActivationEvent（来源来自下单时随订单存的 attrSource；缺省 catalog）。
      const { source: attrSource, refId: attrRefId } = parseAttribution(order.attrSource, order.attrRefId);
      await recordActivation({ tenantId: order.tenantId, userId: order.userId, itemType: 'sku', itemKey: sku.key, source: attrSource, refId: attrRefId }, tx).catch(() => {});
    } else {
      const plan = await tx.plan.findUnique({ where: { id: order.planId } });
      if (!plan) return { applied: false, reason: 'plan_not_found' };
      await applyPlanPurchase(
        { id: order.userId, tenantId: order.tenantId },
        plan,
        { reason: `${plan.name} · ${payLabel}`, source },
        tx,
      );
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
