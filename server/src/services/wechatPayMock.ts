// 本地 mock 微信支付服务器（开发/测试专用，生产不引用不启动）。
//
// 与 PAY_SANDBOX 沙箱的区别：沙箱绕过全部加解密（provider='mock' + 合成调起参数 + 直调入账）；
// 本 mock 则原样模拟微信支付 v3 商户网关，让 services/wechatPay.ts 的【真实代码路径】本地走通：
//   ① JSAPI 下单：校验商户 Authorization 请求签名（RSA-SHA256）→ 返回 prepay_id
//   ② 查单：GET /v3/pay/transactions/out-trade-no/{no}（同样验签）→ 返回交易对象
//   ③ 模拟付款：POST /mock/pay/{no} → 按微信回调报文格式（APIv3 密钥 AES-256-GCM 加密 resource
//      + 平台私钥 RSA-SHA256 签名 Wechatpay-* 头）真实 HTTP 投递到下单时的 notify_url
//
// 用法：把 WECHAT_PAY_BASE 指到本 mock，WECHAT_PAY_PLATFORM_CERT 配平台公钥 PEM，
// 其余 WECHAT_PAY_* 与 mock 侧一致即可。独立启动见 scripts/wechat-pay-mock.ts；
// 全链路验证见 scripts/pay-mock-e2e.ts 与 test/wechatPayMockFlow.test.ts。
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { createSign, createVerify, createCipheriv, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';

export interface WechatPayMockKeys {
  /** 商户侧：私钥给被测服务（WECHAT_PAY_PRIVATE_KEY），公钥留 mock 验请求签名 */
  merchantPrivateKeyPem: string;
  merchantPublicKeyPem: string;
  merchantSerial: string;
  /** 平台侧：私钥留 mock 签回调，公钥给被测服务（WECHAT_PAY_PLATFORM_CERT）验签 */
  platformPrivateKeyPem: string;
  platformPublicKeyPem: string;
  platformSerial: string;
}

/** 生成商户 + 平台两对 RSA-2048 密钥（Node verify 接受公钥 PEM，无需真 X.509 证书）。 */
export function generateWechatPayMockKeys(): WechatPayMockKeys {
  const gen = () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return {
      priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      pub: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    };
  };
  const m = gen();
  const p = gen();
  return {
    merchantPrivateKeyPem: m.priv,
    merchantPublicKeyPem: m.pub,
    merchantSerial: `MOCKMCH${randomBytes(8).toString('hex').toUpperCase()}`,
    platformPrivateKeyPem: p.priv,
    platformPublicKeyPem: p.pub,
    platformSerial: `MOCKPLAT${randomBytes(8).toString('hex').toUpperCase()}`,
  };
}

export interface WechatPayMockOptions {
  appId: string;
  mchId: string;
  /** APIv3 密钥（32 字节），与被测服务的 WECHAT_PAY_APIV3_KEY 一致 */
  apiV3Key: string;
  keys: WechatPayMockKeys;
  logger?: boolean;
}

export interface MockTradeOrder {
  outTradeNo: string;
  appId: string;
  mchId: string;
  description: string;
  amountTotal: number;
  payerOpenid: string;
  notifyUrl: string;
  prepayId: string;
  tradeState: 'NOTPAY' | 'SUCCESS' | 'CLOSED' | 'REVOKED' | 'PAYERROR';
  transactionId: string | null;
  successTime: string | null;
  createdAt: string;
}

export interface WechatPayMock {
  app: FastifyInstance;
  orders: Map<string, MockTradeOrder>;
  /** 把订单置为已支付并向 notify_url 投递真实格式回调；tamperSignature 用于负向测试 */
  payOrder(outTradeNo: string, opts?: { deliverNotify?: boolean; tamperSignature?: boolean }): Promise<{ delivered: boolean; notifyStatus?: number; notifyBody?: string }>;
  /** 重投上一次回调（幂等验证用），支付状态不变 */
  redeliverNotify(outTradeNo: string, opts?: { tamperSignature?: boolean }): Promise<{ delivered: boolean; notifyStatus?: number; notifyBody?: string }>;
}

// —— Authorization 头解析 + 商户请求验签（对应微信 v3 网关侧行为）——
function parseAuthHeader(header: string | undefined): Record<string, string> | null {
  if (!header || !header.startsWith('WECHATPAY2-SHA256-RSA2048 ')) return null;
  const out: Record<string, string> = {};
  for (const m of header.slice('WECHATPAY2-SHA256-RSA2048 '.length).matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function verifyMerchantRequest(req: FastifyRequest, rawBody: string, o: WechatPayMockOptions): { ok: boolean; message?: string } {
  const auth = parseAuthHeader(req.headers.authorization);
  if (!auth) return { ok: false, message: 'Authorization 头缺失或格式错误' };
  if (auth.mchid !== o.mchId) return { ok: false, message: `mchid 不匹配：${auth.mchid}` };
  if (auth.serial_no !== o.keys.merchantSerial) return { ok: false, message: `证书序列号不匹配：${auth.serial_no}` };
  // 签名串 = METHOD\n带查询串的完整路径\n时间戳\n随机串\n报文体\n（与商户侧 buildAuthToken 对偶）
  const message = `${req.method}\n${req.url}\n${auth.timestamp}\n${auth.nonce_str}\n${rawBody}\n`;
  try {
    const ok = createVerify('RSA-SHA256').update(message).verify(o.keys.merchantPublicKeyPem, auth.signature, 'base64');
    return ok ? { ok } : { ok: false, message: '签名验证失败' };
  } catch (err) {
    return { ok: false, message: `签名验证异常：${(err as Error).message}` };
  }
}

function transactionJson(order: MockTradeOrder): Record<string, unknown> {
  return {
    appid: order.appId,
    mchid: order.mchId,
    out_trade_no: order.outTradeNo,
    transaction_id: order.transactionId ?? undefined,
    trade_type: 'JSAPI',
    trade_state: order.tradeState,
    trade_state_desc: order.tradeState === 'SUCCESS' ? '支付成功' : '未支付',
    bank_type: order.tradeState === 'SUCCESS' ? 'OTHERS' : undefined,
    success_time: order.successTime ?? undefined,
    payer: { openid: order.payerOpenid },
    amount: { total: order.amountTotal, payer_total: order.tradeState === 'SUCCESS' ? order.amountTotal : undefined, currency: 'CNY' },
  };
}

export function buildWechatPayMock(o: WechatPayMockOptions): WechatPayMock {
  if (Buffer.byteLength(o.apiV3Key, 'utf8') !== 32) throw new Error('apiV3Key 必须为 32 字节（与真实 APIv3 密钥一致）');
  const orders = new Map<string, MockTradeOrder>();
  const app = Fastify({ logger: o.logger ? { level: 'info' } : false });

  // 与被测服务同款「保留原文」JSON 解析器：验签需要原始报文。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as typeof req & { rawBody?: string }).rawBody = body as string;
    const s = (body as string).trim();
    if (!s) return done(null, {});
    try { done(null, JSON.parse(s)); } catch (err) { (err as Error & { statusCode?: number }).statusCode = 400; done(err as Error, undefined); }
  });

  // ① JSAPI 下单
  app.post('/v3/pay/transactions/jsapi', async (req, reply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const v = verifyMerchantRequest(req, rawBody, o);
    if (!v.ok) return reply.code(401).send({ code: 'SIGN_ERROR', message: v.message });

    const b = req.body as { appid?: string; mchid?: string; description?: string; out_trade_no?: string; notify_url?: string; amount?: { total?: number; currency?: string }; payer?: { openid?: string } };
    const bad = (message: string) => reply.code(400).send({ code: 'PARAM_ERROR', message });
    if (b.appid !== o.appId) return bad(`appid 不匹配：${b.appid}`);
    if (b.mchid !== o.mchId) return bad(`mchid 不匹配：${b.mchid}`);
    if (!b.description) return bad('缺少 description');
    if (!b.out_trade_no || b.out_trade_no.length > 32) return bad('out_trade_no 缺失或超长');
    if (!b.notify_url || !/^https?:\/\//.test(b.notify_url)) return bad('notify_url 缺失或非法');
    if (!Number.isInteger(b.amount?.total) || (b.amount!.total as number) <= 0) return bad('amount.total 必须为正整数（分）');
    if ((b.amount?.currency ?? 'CNY') !== 'CNY') return bad('currency 仅支持 CNY');
    if (!b.payer?.openid) return bad('缺少 payer.openid');

    const existing = orders.get(b.out_trade_no);
    if (existing) {
      // 微信对同单号同参数重入返回同一 prepay_id；参数不同则报错。mock 按金额一致性判定。
      if (existing.amountTotal !== b.amount!.total) return bad('同 out_trade_no 参数不一致');
      return { prepay_id: existing.prepayId };
    }
    const order: MockTradeOrder = {
      outTradeNo: b.out_trade_no,
      appId: b.appid!,
      mchId: b.mchid!,
      description: b.description,
      amountTotal: b.amount!.total as number,
      payerOpenid: b.payer.openid,
      notifyUrl: b.notify_url,
      prepayId: `mockprepay_${randomBytes(12).toString('hex')}`,
      tradeState: 'NOTPAY',
      transactionId: null,
      successTime: null,
      createdAt: new Date().toISOString(),
    };
    orders.set(order.outTradeNo, order);
    return { prepay_id: order.prepayId };
  });

  // ② 商户查单
  app.get<{ Params: { outTradeNo: string }; Querystring: { mchid?: string } }>('/v3/pay/transactions/out-trade-no/:outTradeNo', async (req, reply) => {
    const v = verifyMerchantRequest(req, '', o);
    if (!v.ok) return reply.code(401).send({ code: 'SIGN_ERROR', message: v.message });
    if (req.query.mchid !== o.mchId) return reply.code(400).send({ code: 'PARAM_ERROR', message: 'mchid 不匹配' });
    const order = orders.get(req.params.outTradeNo);
    if (!order) return reply.code(404).send({ code: 'ORDER_NOT_EXIST', message: '订单不存在' });
    return transactionJson(order);
  });

  // ②b 商户关单：NOTPAY → CLOSED（204）；已支付 → 400 ORDERPAID；未知单 → 404。
  app.post<{ Params: { outTradeNo: string } }>('/v3/pay/transactions/out-trade-no/:outTradeNo/close', async (req, reply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const v = verifyMerchantRequest(req, rawBody, o);
    if (!v.ok) return reply.code(401).send({ code: 'SIGN_ERROR', message: v.message });
    const order = orders.get(req.params.outTradeNo);
    if (!order) return reply.code(404).send({ code: 'ORDER_NOT_EXIST', message: '订单不存在' });
    if (order.tradeState === 'SUCCESS') return reply.code(400).send({ code: 'ORDERPAID', message: '订单已支付，不可关闭' });
    order.tradeState = 'CLOSED';
    return reply.code(204).send();
  });

  // ②c 商户退款（/v3/refund/domestic/refunds）：全额退款即时 SUCCESS；同 out_refund_no 幂等复用。
  const refunds = new Map<string, { refundId: string; outTradeNo: string; amount: number }>();
  app.post('/v3/refund/domestic/refunds', async (req, reply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const v = verifyMerchantRequest(req, rawBody, o);
    if (!v.ok) return reply.code(401).send({ code: 'SIGN_ERROR', message: v.message });
    const b = req.body as { out_trade_no?: string; out_refund_no?: string; amount?: { refund?: number; total?: number } };
    if (!b.out_trade_no || !b.out_refund_no) return reply.code(400).send({ code: 'PARAM_ERROR', message: '缺少 out_trade_no/out_refund_no' });
    const order = orders.get(b.out_trade_no);
    if (!order) return reply.code(404).send({ code: 'RESOURCE_NOT_EXISTS', message: '订单不存在' });
    if (order.tradeState !== 'SUCCESS') return reply.code(400).send({ code: 'TRADE_STATE_ERROR', message: '订单未支付，无款可退' });
    if (b.amount?.refund !== order.amountTotal || b.amount?.total !== order.amountTotal) {
      return reply.code(400).send({ code: 'PARAM_ERROR', message: '退款金额与订单金额不一致（mock 仅支持全额退款）' });
    }
    const existing = refunds.get(b.out_refund_no);
    const refundId = existing?.refundId ?? `mockrefund_${randomBytes(12).toString('hex')}`;
    if (!existing) refunds.set(b.out_refund_no, { refundId, outTradeNo: b.out_trade_no, amount: order.amountTotal });
    return { refund_id: refundId, out_refund_no: b.out_refund_no, out_trade_no: b.out_trade_no, status: 'SUCCESS', amount: { refund: order.amountTotal, total: order.amountTotal, currency: 'CNY' } };
  });

  // —— 回调构造 + 投递：APIv3 密钥 AES-256-GCM 加密 resource + 平台私钥签名 Wechatpay-* 头 ——
  async function deliverNotify(order: MockTradeOrder, tamperSignature = false): Promise<{ delivered: boolean; notifyStatus?: number; notifyBody?: string }> {
    const plaintext = JSON.stringify(transactionJson(order));
    const nonce = randomBytes(6).toString('hex'); // 12 字节 GCM IV（字符串形态，与官方报文一致）
    const associatedData = 'transaction';
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(o.apiV3Key, 'utf8'), Buffer.from(nonce, 'utf8'));
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    const body = JSON.stringify({
      id: randomUUID(),
      create_time: new Date().toISOString(),
      resource_type: 'encrypt-resource',
      event_type: 'TRANSACTION.SUCCESS',
      summary: '支付成功',
      resource: { original_type: 'transaction', algorithm: 'AEAD_AES_256_GCM', ciphertext: encrypted.toString('base64'), associated_data: associatedData, nonce },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const headerNonce = randomUUID().replace(/-/g, '');
    let signature = createSign('RSA-SHA256').update(`${timestamp}\n${headerNonce}\n${body}\n`).sign(o.keys.platformPrivateKeyPem, 'base64');
    if (tamperSignature) signature = signature.replace(/^..../, 'AAAA'); // 破坏签名，负向用例

    try {
      const res = await fetch(order.notifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Wechatpay-Timestamp': timestamp,
          'Wechatpay-Nonce': headerNonce,
          'Wechatpay-Signature': signature,
          'Wechatpay-Signature-Type': 'WECHATPAY2-SHA256-RSA2048',
          'Wechatpay-Serial': o.keys.platformSerial,
        },
        body,
      });
      return { delivered: true, notifyStatus: res.status, notifyBody: await res.text().catch(() => '') };
    } catch (err) {
      return { delivered: false, notifyBody: (err as Error).message };
    }
  }

  async function payOrder(outTradeNo: string, opts: { deliverNotify?: boolean; tamperSignature?: boolean } = {}) {
    const order = orders.get(outTradeNo);
    if (!order) throw new Error(`mock 订单不存在：${outTradeNo}`);
    if (order.tradeState !== 'SUCCESS') {
      order.tradeState = 'SUCCESS';
      order.transactionId = `mocktx_${randomBytes(12).toString('hex')}`;
      order.successTime = new Date().toISOString();
    }
    if (opts.deliverNotify === false) return { delivered: false };
    return deliverNotify(order, opts.tamperSignature);
  }

  async function redeliverNotify(outTradeNo: string, opts: { tamperSignature?: boolean } = {}) {
    const order = orders.get(outTradeNo);
    if (!order) throw new Error(`mock 订单不存在：${outTradeNo}`);
    if (order.tradeState !== 'SUCCESS') throw new Error('订单未支付，无回调可重投');
    return deliverNotify(order, opts.tamperSignature);
  }

  // ③ 模拟用户付款（控制端点，不验签）：curl -X POST /mock/pay/<outTradeNo>
  app.post<{ Params: { outTradeNo: string }; Body: { deliverNotify?: boolean; tamperSignature?: boolean } | null }>('/mock/pay/:outTradeNo', async (req, reply) => {
    try {
      const r = await payOrder(req.params.outTradeNo, req.body ?? {});
      return { ok: true, ...r };
    } catch (err) {
      return reply.code(404).send({ ok: false, error: (err as Error).message });
    }
  });

  // 调试：查看 mock 侧全部订单
  app.get('/mock/orders', async () => [...orders.values()]);

  return { app, orders, payOrder, redeliverNotify };
}
