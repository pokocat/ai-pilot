import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { applyPlanPurchase } from '../services/purchase.js';
import { payConfigured, createJsapiOrder, payMockSuccessEnabled, resolvePayerOpenid } from '../services/wechatPay.js';
import { sandboxEnabled, demoPurchaseEnabled } from '../services/sandbox.js';
import { computeUpgradeProration } from '../services/proration.js';
import { isExpired, daysRemaining } from '../services/planTime.js';
import { now } from '../services/clock.js';
import { parseAttribution } from '../services/activation.js';
import { recordAudit } from '../services/audit.js';
import type { Plan as PlanView, PlanPurchaseResult, WechatOrderResult } from '../../../shared/contracts';

function publicPlan(plan: {
  id: string;
  name: string;
  price: number;
  period: string;
  creditsPerMonth: number;
  tokenQuotaPerMonth: number;
  agentCount: number;
  featuresJson: unknown;
  highlighted: boolean;
}): PlanView {
  return {
    id: plan.id,
    name: plan.name,
    price: plan.price,
    period: plan.period,
    creditsPerMonth: plan.creditsPerMonth,
    tokenQuotaPerMonth: plan.tokenQuotaPerMonth,
    agentCount: plan.agentCount,
    featuresJson: Array.isArray(plan.featuresJson) ? plan.featuresJson.map(String) : [],
    highlighted: plan.highlighted,
  };
}

export async function planRoutes(app: FastifyInstance) {
  app.get('/plans', async (): Promise<PlanView[]> => {
    const plans = await prisma.plan.findMany({ orderBy: { sort: 'asc' } });
    return plans.map(publicPlan);
  });

  // 演示购买：直接发放权益（不经支付）。仅免费套餐 + 演示环境可用；付费套餐必须走支付。
  app.post<{ Params: { id: string } }>('/plans/:id/purchase', async (req, reply): Promise<PlanPurchaseResult | void> => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const plan = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!plan) return reply.code(404).send({ error: '套餐不存在', code: 'PLAN_NOT_FOUND' });
    // 面议档（price<0，企业版·私有化：不限量点数+不限量 token+永不过期）绝不自助发放——
    // 原判断只拦 price>0，负价从缝里漏过去，任何登录用户拿套餐 id 就能免费开通不限量（生产实际发生，
    // 41/52 用户在企业版）。面议档只能由运营后台 admin_grant 开通。
    if (plan.price < 0) {
      return reply.code(402).send({ error: '该套餐为企业定制，请联系商务开通', code: 'CONTACT_SALES' });
    }
    // 付费套餐绝不免费发放：配了支付 → 强制走下单；未配支付 → 仅测试/显式开启的演示环境可发放，否则提示「支付即将开通」。
    if (plan.price > 0) {
      if (payConfigured()) {
        return reply.code(402).send({ error: '该套餐需通过支付购买，请发起支付下单', code: 'PAYMENT_REQUIRED' });
      }
      if (!demoPurchaseEnabled()) {
        return reply.code(402).send({ error: '支付即将开通，敬请期待', code: 'PAYMENT_COMING_SOON' });
      }
    }
    const r = await applyPlanPurchase(user, plan, { reason: `${plan.name} · 套餐购买`, source: 'demo_purchase' });
    return { ok: true, plan: publicPlan(plan), creditBalance: r.creditBalance, grantedCredits: r.grantedCredits, grantedTokens: r.grantedTokens };
  });

  // 微信支付下单（小程序 JSAPI）：创建订单并返回小程序调起支付所需参数。需配齐支付凭据。
  // P2：接受 source/refId 归因（与 SKU 下单同口径），回调发放时落 ActivationEvent（itemType='plan'）。
  app.post<{ Params: { id: string }; Body: { openid?: string; source?: string; refId?: string } }>('/plans/:id/order', async (req, reply): Promise<WechatOrderResult | void> => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const plan = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!plan) return reply.code(404).send({ error: '套餐不存在', code: 'PLAN_NOT_FOUND' });
    // PAY_MOCK_SUCCESS 一并放行：它建的是**真实 PaymentOrder**（快照/金额/归因/频控/关旧单全走），
    // 只是不去调微信 JSAPI，付款由 POST /pay/mock/pay 模拟——这样订单状态机与发放链路在无凭据环境下也能被跑通。
    if (!payConfigured() && !sandboxEnabled() && !payMockSuccessEnabled()) {
      return reply.code(501).send({ error: '微信支付未配置，演示环境请走 /plans/:id/purchase', code: 'PAYMENT_NOT_CONFIGURED' });
    }
    if (plan.price <= 0) return reply.code(400).send({ error: '免费套餐无需支付', code: 'PLAN_FREE' });
    // openid 取值集中在 resolvePayerOpenid（与 /skus/:key/order 同一函数）：body 里的 openid 只在
    // 等于调用者自己的 wechatOpenId 时被采纳，其余静默忽略 → 落到下面这行 OPENID_REQUIRED。理由见该函数注释。
    const openid = resolvePayerOpenid(user, req.body?.openid);
    if (!openid) return reply.code(400).send({ error: '缺少支付用户 openid', code: 'OPENID_REQUIRED' });
    const cur = await prisma.user.findUnique({
      where: { id: user.id },
      select: { planExpiresAt: true, plan: { select: { id: true, name: true, price: true, period: true } } },
    });
    const curPlan = cur?.plan;
    // 升级折算（D5）：实付 = max(0, 新套餐原价 − 老套餐剩余价值)；不触发时 = 原价。
    // 同时是下面降级守卫的**唯一判定源**——「是不是真升级」的规则只存在于 proration 服务里（只读，不写库），
    // 路由不再自带第二份（此前路由写死「月付→年付」，同周期升级如 入门版→决策版·月付 被守卫误伤 409）。
    const proration = await computeUpgradeProration(user, { id: plan.id, price: plan.price, period: plan.period });
    // 降级守卫（P0）：applyPlanPurchase 对「不同套餐」一律重置有效期锚点——年付降月付/平级横切
    // 会直接烧掉当前套餐剩余时长且无折算（不支持退现）。仅放行：同套餐续费、可折算的升级、当前套餐已过期/免费。
    if (curPlan && curPlan.id !== plan.id) {
      if (curPlan.price < 0) {
        return reply.code(409).send({ error: '企业版套餐由运营管理，如需调整请联系客服', code: 'PLAN_SWITCH_BLOCKED' });
      }
      if (curPlan.price > 0 && !isExpired(cur?.planExpiresAt, now()) && !proration.applies) {
        const days = daysRemaining(cur?.planExpiresAt, now());
        return reply.code(409).send({
          // days=null = 付费套餐但无到期日（历史数据/人工改库的不限期档）：说人话，别报「还有 0 天」。
          error: days === null
            ? `当前套餐「${curPlan.name}」为不限期方案，切换方案请联系客服`
            : `当前套餐「${curPlan.name}」还有 ${days} 天有效期，现在切换将丢失剩余时长；请到期后再购买`,
          code: 'PLAN_SWITCH_BLOCKED',
        });
      }
    }
    const attribution = parseAttribution(req.body?.source, req.body?.refId);
    try {
      const r = await createJsapiOrder({ user, plan: { id: plan.id, name: plan.name, price: plan.price }, openid, amount: proration.chargeAmount, attribution });
      if (proration.applies) {
        await recordAudit({
          tenantId: user.tenantId, userId: user.id, action: 'user.plan.proration',
          payload: {
            outTradeNo: r.outTradeNo, fromPlanId: proration.fromPlanId, fromPlanName: proration.fromPlanName, toPlanId: plan.id,
            fullPrice: proration.fullPrice, remainingDays: proration.remainingDays, remainingValue: proration.remainingValue, chargeAmount: proration.chargeAmount,
          },
        });
      }
      return {
        ok: true, outTradeNo: r.outTradeNo, amount: proration.chargeAmount, pay: r.pay,
        ...(r.mock ? { mock: true as const } : {}),
        proration: proration.applies
          ? { applies: true, fullPrice: proration.fullPrice, remainingDays: proration.remainingDays, remainingValue: proration.remainingValue, chargeAmount: proration.chargeAmount }
          : undefined,
      };
    } catch (e) {
      const err = e as { message?: string; statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? 502).send({ error: err.message ?? '下单失败', code: err.code ?? 'WECHAT_PAY_CREATE_FAILED' });
    }
  });
}
