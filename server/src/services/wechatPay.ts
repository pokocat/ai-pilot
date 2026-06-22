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
import { applyPlanPurchase } from './purchase.js';

const PAY_BASE = 'https://api.mch.weixin.qq.com';

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
 * openid 必填（小程序当前用户的 openid）。
 */
export async function createJsapiOrder(args: {
  user: { id: string; tenantId: string };
  plan: { id: string; name: string; price: number };
  openid: string;
}): Promise<CreateOrderResult> {
  const c = cfg();
  const outTradeNo = genOutTradeNo();
  await prisma.paymentOrder.create({
    data: {
      outTradeNo, tenantId: args.user.tenantId, userId: args.user.id, planId: args.plan.id,
      amount: args.plan.price, provider: 'wechat', status: 'created',
    },
  });

  const body = JSON.stringify({
    appid: c.appId,
    mchid: c.mchId,
    description: `军师 · ${args.plan.name}`,
    out_trade_no: outTradeNo,
    notify_url: c.notifyUrl,
    amount: { total: args.plan.price, currency: 'CNY' },
    payer: { openid: args.openid },
  });
  const urlPath = '/v3/pay/transactions/jsapi';
  const res = await fetch(PAY_BASE + urlPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: buildAuthToken('POST', urlPath, body),
    },
    body,
  });
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
}): Promise<{ applied: boolean; reason?: string }> {
  return prisma.$transaction(async (tx) => {
    // 对同一订单号串行化回调处理。hashtext(text) 返回 int4，适配 pg_advisory_xact_lock(int)。
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${parsed.outTradeNo}))`;

    const order = await tx.paymentOrder.findUnique({ where: { outTradeNo: parsed.outTradeNo } });
    if (!order) return { applied: false, reason: 'order_not_found' };
    if (order.appliedAt || order.status === 'applied') return { applied: false, reason: 'already_applied' };

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

    const plan = await tx.plan.findUnique({ where: { id: order.planId } });
    if (!plan) return { applied: false, reason: 'plan_not_found' };
    await applyPlanPurchase(
      { id: order.userId, tenantId: order.tenantId },
      plan,
      { reason: `${plan.name} · 微信支付`, source: 'wechat_pay' },
      tx,
    );
    // appliedAt 在 applyPlanPurchase 成功后才设置，确保 paid+appliedAt=null 的订单可被后续回调恢复。
    await tx.paymentOrder.update({ where: { outTradeNo: parsed.outTradeNo }, data: { status: 'applied', appliedAt: new Date() } });
    return { applied: true };
  });
}
