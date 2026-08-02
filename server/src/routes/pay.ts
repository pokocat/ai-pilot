// 支付回调路由（微信支付 v3 通知）。独立封装插件：本插件内用「保留原文」的 JSON 解析器，
// 以便对回调做签名校验（v3 验签需原始报文）。不挂任何鉴权 hook —— 回调靠验签 + AEAD 解密自证。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  verifyNotifySignature, decryptNotifyResource, markPaidAndApply, markRefundNotified, payConfigured,
  reconcileOrder, repayParams, orderPayable, orderPayableUntil, payMockSuccessEnabled, isMockOrder, genMockTransactionId,
} from '../services/wechatPay.js';
import { sandboxEnabled } from '../services/sandbox.js';
import { requireAdmin } from '../services/adminAuth.js';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { prisma } from '../db.js';
import type { PayOrderStatus, PayOrderListItem, PayOrderListResult, PayRepayResult, PayMockPayResult } from '../../../shared/contracts';

// 快照里的商品名（订单明细展示；历史无快照单按类型兜底）。
function itemNameOf(order: { snapshotJson: unknown; skuKey: string | null }): string {
  const snap = (order.snapshotJson ?? null) as { plan?: { name?: string }; sku?: { name?: string } } | null;
  return snap?.plan?.name ?? snap?.sku?.name ?? (order.skuKey ? '专项能力' : '方案套餐');
}

interface NotifyBody {
  resource?: { ciphertext: string; nonce: string; associated_data?: string };
}

export async function payRoutes(app: FastifyInstance) {
  // 我的支付订单列表（P1，鉴权）：订单明细页展示；created 且未过支付时限的单可继续支付。
  app.get('/pay/orders', async (req): Promise<PayOrderListResult> => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const orders = await prisma.paymentOrder.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const items: PayOrderListItem[] = orders.map((o) => ({
      outTradeNo: o.outTradeNo,
      status: o.status as PayOrderListItem['status'],
      amount: o.amount,
      planId: o.planId || undefined,
      skuKey: o.skuKey ?? undefined,
      paidAt: o.paidAt?.toISOString(),
      appliedAt: o.appliedAt?.toISOString(),
      refundStatus: (o.refundStatus as PayOrderListItem['refundStatus']) ?? null,
      refundedAt: o.refundedAt?.toISOString(),
      itemName: itemNameOf(o),
      createdAt: o.createdAt.toISOString(),
      payable: orderPayable(o),
      payableUntil: orderPayableUntil(o),
      ...(isMockOrder(o) ? { mock: true as const } : {}), // 前台要能看出这单是测试期模拟支付，不能装成真付款
    }));
    return { items };
  });

  // 继续支付（P1，鉴权，仅本人订单）：对未过支付时限的 created 单重签 wx.requestPayment 参数。
  app.post<{ Params: { outTradeNo: string } }>('/pay/orders/:outTradeNo/pay-params', async (req, reply): Promise<PayRepayResult | void> => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const r = await repayParams(req.params.outTradeNo, user.id);
      return { ok: true, outTradeNo: r.outTradeNo, pay: r.pay, ...(r.mock ? { mock: true as const } : {}) };
    } catch (e) {
      const err = e as { message?: string; statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? 502).send({ error: err.message ?? '获取支付参数失败', code: err.code ?? 'ORDER_NOT_PAYABLE' });
    }
  });

  // 订单状态查询（鉴权，仅本人订单）：requestPayment 成功后前端轮询到 appliedAt 有值即权益到账。
  // 微信单尚未发放且已配支付时，先主动查单补账（reconcileOrder，与回调共用幂等底座）——
  // 回调丢失/延迟也能在用户轮询时把「已付款未发权益」自愈；查单网络异常不阻塞状态返回。
  app.get<{ Params: { outTradeNo: string } }>('/pay/orders/:outTradeNo', async (req, reply): Promise<PayOrderStatus | void> => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const outTradeNo = req.params.outTradeNo;
    let order = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
    if (!order || order.userId !== user.id) return reply.code(404).send({ error: '订单不存在', code: 'ORDER_NOT_FOUND' });

    if (order.provider === 'wechat' && !order.appliedAt && ['created', 'paid'].includes(order.status) && payConfigured()) {
      try {
        await reconcileOrder(outTradeNo);
        order = (await prisma.paymentOrder.findUnique({ where: { outTradeNo } })) ?? order;
      } catch (err) {
        console.warn('[pay] reconcile on poll failed:', outTradeNo, (err as Error).message);
      }
    }
    return {
      outTradeNo: order.outTradeNo,
      status: order.status as PayOrderStatus['status'],
      amount: order.amount,
      planId: order.planId || undefined,
      skuKey: order.skuKey ?? undefined,
      paidAt: order.paidAt?.toISOString(),
      appliedAt: order.appliedAt?.toISOString(),
      refundStatus: (order.refundStatus as PayOrderStatus['refundStatus']) ?? null,
      payableUntil: orderPayableUntil(order),
    };
  });

  // —— 测试期模拟支付（PAY_MOCK_SUCCESS）：普通用户鉴权，等价于「用户点了支付 + 微信回调成功」。——
  // 与沙箱 /pay/sandbox/notify 的区别：那条要 admin 鉴权、生产启动期硬禁，是运营/测试脚本的工具；
  // 这条是**用户自己在小程序里点的那一下**（下单返回 mock:true 时代替 wx.requestPayment），
  // 允许在生产测试期开启，所以必须自己把住三道门：开关、订单归属、只认 mock 单。
  //
  // 路由**无条件注册**、开关在处理器内判定：这样运行期改 env 即生效（不用重启才挂上路由），
  // 且关闭时的响应与「未配置支付」完全一致（501 PAYMENT_NOT_CONFIGURED），不通过状态码差异
  // 泄露这个端点在本环境是否存在。
  app.post<{ Body: { outTradeNo?: string; orderId?: string } }>('/pay/mock/pay', async (req, reply): Promise<PayMockPayResult | void> => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    // ① 开关（含 payConfigured 让位）——放在任何库查询之前。
    if (!payMockSuccessEnabled()) {
      return reply.code(501).send({ error: '微信支付未配置', code: 'PAYMENT_NOT_CONFIGURED' });
    }
    const outTradeNo = (req.body?.outTradeNo || req.body?.orderId || '').trim();
    if (!outTradeNo) return reply.code(400).send({ error: '缺少 outTradeNo', code: 'OUT_TRADE_NO_REQUIRED' });
    const order = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
    // ② 订单归属：他人订单一律 404（与 /pay/orders/:no 同口径，不区分「不存在」与「不是你的」）。
    if (!order || order.userId !== user.id) return reply.code(404).send({ error: '订单不存在', code: 'ORDER_NOT_FOUND' });
    // ③ 只认 mock 单：真实微信单绝不能被这条端点「模拟」成已付款（那就是白拿）。
    if (!isMockOrder(order)) return reply.code(409).send({ error: '该订单不是模拟支付订单', code: 'ORDER_NOT_MOCK' });

    // 走**真实的** markPaidAndApply：advisory lock + appliedAt 终态锚点保证重复调用只发放一次，
    // 权益发放 / ActivationEvent 归因 / 到账订阅消息全部与真实回调同一条路径（source 区分 mock）。
    // transactionId 以数字为主（mock+时间戳+随机数字）：到账模板 number6 位是微信 number 类型、
    // 发送侧只抽数字，纯字母单号会让整条订阅消息被拒（见 services/wechatSubscribe.ts）。
    const transactionId = genMockTransactionId();
    const r = await markPaidAndApply({
      outTradeNo,
      transactionId,
      tradeState: 'SUCCESS',
      rawJson: { mock: true, source: 'pay_mock_success', outTradeNo, transactionId },
      amountTotal: order.amount, // 自校验：与本单金额比对，走的是与真实回调同一段防串单逻辑
    }, 'wechat_pay_mock');
    const after = await prisma.paymentOrder.findUnique({ where: { outTradeNo }, select: { status: true } });
    // 测试期的假到账必须可审计、可与真营收区分：单号 / 金额 / 套餐或 SKU 全部留痕。
    await recordAudit({
      tenantId: order.tenantId,
      userId: order.userId,
      action: 'pay.mock.paid',
      payload: {
        outTradeNo, transactionId, amount: order.amount,
        planId: order.planId || null, skuKey: order.skuKey ?? null, itemName: itemNameOf(order),
        applied: r.applied, reason: r.reason ?? null, status: after?.status ?? order.status,
      },
    });
    return { ok: true, applied: r.applied, reason: r.reason, status: after?.status ?? order.status };
  });

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

    if (!(await verifyNotifySignature(headers, rawBody))) {
      return reply.code(401).send({ code: 'FAIL', message: '签名校验失败' });
    }
    const body = req.body as NotifyBody & { event_type?: string };
    if (!body?.resource?.ciphertext) {
      return reply.code(400).send({ code: 'FAIL', message: '回调缺少 resource' });
    }
    // 退款结果通知（REFUND.SUCCESS 等）：退款状态在 refundWechatOrder 已同步落库，
    // 这里只幂等补记原文并应答，避免退款事件被当成交易事件误处理。
    if (typeof body.event_type === 'string' && body.event_type.startsWith('REFUND')) {
      try {
        const decodedRefund = decryptNotifyResource(body.resource) as { out_trade_no?: string; refund_status?: string };
        await markRefundNotified(decodedRefund);
        return reply.code(200).send({ code: 'SUCCESS', message: '成功' });
      } catch (err) {
        console.error('[pay] refund notify decrypt failed:', (err as Error).message);
        return reply.code(400).send({ code: 'FAIL', message: '处理失败' });
      }
    }
    try {
      const decoded = decryptNotifyResource(body.resource) as {
        out_trade_no?: string; transaction_id?: string; trade_state?: string;
        appid?: string; mchid?: string; amount?: { total?: number };
      };
      if (!decoded.out_trade_no) return reply.code(400).send({ code: 'FAIL', message: '解密结果缺少订单号' });
      if (!decoded.transaction_id || decoded.trade_state !== 'SUCCESS' || typeof decoded.amount?.total !== 'number'
        || !decoded.appid || !decoded.mchid) {
        return reply.code(400).send({ code: 'FAIL', message: '解密结果缺少必填交易字段' });
      }
      const r = await markPaidAndApply({
        outTradeNo: decoded.out_trade_no,
        transactionId: decoded.transaction_id,
        tradeState: decoded.trade_state ?? 'UNKNOWN',
        rawJson: decoded as Record<string, unknown>,
        // 防串单/伪造：报文自带的金额/appid/mchid 与本单比对，不一致绝不入账（markPaidAndApply 内校验）。
        amountTotal: typeof decoded.amount?.total === 'number' ? decoded.amount.total : undefined,
        appId: decoded.appid,
        mchId: decoded.mchid,
      });
      // 已幂等处理可回成功；关键字段不一致必须拒绝，让微信重试并保留告警窗口。
      if (!r.applied && r.reason?.startsWith('field_mismatch_')) {
        console.error('[pay] notify rejected:', r.reason, decoded.out_trade_no);
        return reply.code(400).send({ code: 'FAIL', message: '交易字段不一致' });
      }
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
