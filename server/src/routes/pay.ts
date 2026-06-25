// 支付回调路由（微信支付 v3 通知）。独立封装插件：本插件内用「保留原文」的 JSON 解析器，
// 以便对回调做签名校验（v3 验签需原始报文）。不挂任何鉴权 hook —— 回调靠验签 + AEAD 解密自证。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyNotifySignature, decryptNotifyResource, markPaidAndApply } from '../services/wechatPay.js';
import { sandboxEnabled } from '../services/sandbox.js';
import { requireAdmin } from '../services/adminAuth.js';

interface NotifyBody {
  resource?: { ciphertext: string; nonce: string; associated_data?: string };
}

export async function payRoutes(app: FastifyInstance) {
  // 仿真回调（可测性 D9，仅 sandboxEnabled + admin 鉴权）：给 outTradeNo 构造合成成功通知直调 markPaidAndApply，
  // 绕过验签/解密做离线端到端验证；真实 notify 端点（下方）严格不动。发放标 source='wechat_pay_sandbox'。
  if (sandboxEnabled()) {
    app.post<{ Body: { outTradeNo?: string; tradeState?: string } }>('/pay/sandbox/notify', { preHandler: requireAdmin }, async (req, reply) => {
      const outTradeNo = (req.body?.outTradeNo || '').trim();
      if (!outTradeNo) return reply.code(400).send({ error: '缺少 outTradeNo', code: 'OUT_TRADE_NO_REQUIRED' });
      const tradeState = (req.body?.tradeState || 'SUCCESS').trim();
      const r = await markPaidAndApply(
        { outTradeNo, transactionId: `sandbox_${outTradeNo}`, tradeState, rawJson: { sandbox: true, outTradeNo, tradeState } },
        'wechat_pay_sandbox',
      );
      return { ok: r.applied, applied: r.applied, reason: r.reason };
    });
  }

  // 原文(req.rawBody)由 app.ts 的全局 application/json 解析器保留，回调验签直接读取。
  // 微信支付结果通知。成功务必回 200 + {code:'SUCCESS'}，否则微信会重试。
  app.post('/pay/wechat/notify', async (req, reply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const headers = req.headers as Record<string, string | undefined>;

    if (!verifyNotifySignature(headers, rawBody)) {
      return reply.code(401).send({ code: 'FAIL', message: '签名校验失败' });
    }
    const body = req.body as NotifyBody;
    if (!body?.resource?.ciphertext) {
      return reply.code(400).send({ code: 'FAIL', message: '回调缺少 resource' });
    }
    try {
      const decoded = decryptNotifyResource(body.resource) as {
        out_trade_no?: string; transaction_id?: string; trade_state?: string;
      };
      if (!decoded.out_trade_no) return reply.code(400).send({ code: 'FAIL', message: '解密结果缺少订单号' });
      const r = await markPaidAndApply({
        outTradeNo: decoded.out_trade_no,
        transactionId: decoded.transaction_id,
        tradeState: decoded.trade_state ?? 'UNKNOWN',
        rawJson: decoded as Record<string, unknown>,
      });
      // 即便业务侧判为「已处理/非成功态」，也回 SUCCESS 让微信停止重试（订单状态已落库，可对账）。
      if (!r.applied && r.reason && !['already_applied', 'trade_state_SUCCESS'].includes(r.reason)) {
        console.warn('[pay] notify not applied:', r.reason, decoded.out_trade_no);
      }
      return reply.code(200).send({ code: 'SUCCESS', message: '成功' });
    } catch (err) {
      // 解密失败 = 报文不可信或密钥不符：拒绝，微信会重试。
      console.error('[pay] notify decrypt/handle failed:', (err as Error).message);
      return reply.code(400).send({ code: 'FAIL', message: '处理失败' });
    }
  });
}
