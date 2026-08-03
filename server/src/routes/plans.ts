import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { applyPlanPurchase } from '../services/purchase.js';
import { payConfigured, createJsapiOrder, orderPayable, orderPayableUntil, payMockSuccessEnabled, resolvePayerOpenid } from '../services/wechatPay.js';
import { sandboxEnabled, demoPurchaseEnabled } from '../services/sandbox.js';
import { isExpired } from '../services/planTime.js';
import { now } from '../services/clock.js';
import { parseAttribution } from '../services/activation.js';
import { recordAudit } from '../services/audit.js';
import type { Plan as PlanView, PlanAction, PlanFunnelEvent, PlanOption, PlanOptionsResult, PlanPurchaseResult, PlanRelation, WechatOrderResult } from '../../../shared/contracts';
import { getPlanStatus, getQuotaState } from '../services/tokenQuota.js';
import { planFamilyKey, planTierRank, publicUsageLabel, publicUsageLevel, usageView } from '../services/planRules.js';
import { commercialTerms, hashTerms, quotePlanChange } from '../services/planEntitlements.js';
import { cancelSubscription, createContractOrder, papayConfigured, subscriptionView } from '../services/wechatPapay.js';

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
  planFamilyKey?: string | null;
  tierRank?: number | null;
  usageLevel?: string | null;
  usageLabel?: string | null;
  autoRenewEnabled?: boolean;
  wechatContractPlanId?: string | null;
  autoRenewMode?: string;
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
    planFamilyKey: planFamilyKey(plan),
    tierRank: planTierRank(plan),
    usageLevel: publicUsageLevel(plan),
    usageLabel: publicUsageLabel(plan),
    autoRenewAvailable: !!(papayConfigured() && plan.autoRenewEnabled && plan.wechatContractPlanId && plan.autoRenewMode === 'delay_24h' && plan.price > 0),
  };
}

// 隐藏档（Plan.hidden）白名单：TEST_PLAN_PHONES（逗号分隔手机号）内的账号才能在列表看到、
// 才能下单购买隐藏套餐。用途：生产 ¥0.01 支付链路验证——测试档对线上用户完全不可见，
// 非白名单请求一律按「套餐不存在」处理（404，不泄露存在性）。
function canSeeHiddenPlans(user: { phone: string | null } | null): boolean {
  if (!user?.phone) return false;
  const list = (process.env.TEST_PLAN_PHONES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(user.phone);
}

// GET /plans 历史上是匿名端点；隐藏档判定需要身份，故带 token 时**尽力**解析、
// 解析失败仍按匿名返回公开套餐（列表页绝不能因过期 token 变 401）。
async function resolveUserOptional(token?: string) {
  if (!token) return null;
  try { return await resolveUser(token); } catch { return null; }
}

export async function planRoutes(app: FastifyInstance) {
  const funnelEvents = new Set<PlanFunnelEvent>(['page_open', 'current_view', 'renew_click', 'upgrade_click', 'billing_change_click', 'downgrade_remind_click', 'quote_success', 'quote_failure', 'quote_confirm', 'payment_cancel', 'payment_failure', 'payment_success', 'payment_pending', 'entitlement_applied', 'order_view', 'order_continue', 'auto_renew_select', 'auto_renew_signed', 'auto_renew_cancel']);

  app.post<{ Body: { event?: string; planId?: string; relation?: string; orderNo?: string; code?: string } }>('/plans/events', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const event = req.body?.event as PlanFunnelEvent;
    if (!funnelEvents.has(event)) return reply.code(400).send({ error: '事件类型无效', code: 'PLAN_EVENT_INVALID' });
    await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.plan.funnel', payload: {
      event, planId: req.body?.planId?.slice(0, 80) || null, relation: req.body?.relation?.slice(0, 30) || null,
      orderNo: req.body?.orderNo?.slice(-32) || null, code: req.body?.code?.slice(0, 60) || null,
    } });
    return { ok: true };
  });
  app.get('/plans', async (req): Promise<PlanView[]> => {
    const user = await resolveUserOptional(req.headers['x-user-id'] as string | undefined);
    const where = canSeeHiddenPlans(user) ? {} : { hidden: false };
    const plans = await prisma.plan.findMany({ where, orderBy: { sort: 'asc' } });
    return plans.map(publicPlan);
  });

  // 用户态方案目录：升降档关系和动作只由服务端计算，客户端不复制价格/周期启发式。
  app.get('/plans/options', async (req): Promise<PlanOptionsResult> => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const visibleWhere = canSeeHiddenPlans(user) ? {} : { hidden: false };
    const [plans, state, quota, pending, status, subscription] = await Promise.all([
      prisma.plan.findMany({ where: visibleWhere, orderBy: { sort: 'asc' } }),
      prisma.user.findUnique({ where: { id: user.id }, select: { planId: true, planExpiresAt: true, plan: true } }),
      getQuotaState(user.id),
      prisma.paymentOrder.findMany({ where: { userId: user.id, status: { in: ['created', 'paid'] }, appliedAt: null }, orderBy: { createdAt: 'desc' }, take: 20 }),
      getPlanStatus(user.id),
      prisma.subscriptionContract.findFirst({ where: { userId: user.id, status: { in: ['pending', 'active', 'cancel_pending'] } }, orderBy: { createdAt: 'desc' } }),
    ]);
    const current = state?.plan ?? null;
    const active = !!current && !isExpired(state?.planExpiresAt, now());
    const pendingByPlan = new Map<string, (typeof pending)[number]>();
    for (const order of pending) if (order.planId && !pendingByPlan.has(order.planId)) pendingByPlan.set(order.planId, order);
    const currentTier = current ? planTierRank(current) : -1;
    const nextTier = plans.filter((p) => p.price >= 0 && planTierRank(p) > currentTier).sort((a, b) => planTierRank(a) - planTierRank(b))[0];
    const publicUsage = usageView(quota, status.nextResetAt, current);
    const options: PlanOption[] = plans.map((plan) => {
      const pendingOrder = pendingByPlan.get(plan.id);
      let relation: PlanRelation = 'available';
      let action: PlanAction = 'buy';
      let canPurchase = plan.price >= 0;
      let reason: string | undefined;
      if (plan.hidden && plan.price > 0) {
        // 生产隐藏支付验证档只对白名单可见；一旦可见就延续既有语义，
        // 不让用户的真实高档套餐把 1 分测试档判成降档而拦住。
        relation = 'available'; action = 'buy'; canPurchase = true;
      } else if (plan.price < 0) {
        relation = 'enterprise'; action = 'contact'; canPurchase = false;
      } else if (pendingOrder?.status === 'paid') {
        action = 'wait_applied'; canPurchase = false; reason = '支付已完成，权益正在到账';
      } else if (pendingOrder && orderPayable(pendingOrder)) {
        action = 'continue_payment'; canPurchase = true;
      } else if (current && active) {
        if (current.id === plan.id) {
          relation = 'renew'; action = 'renew';
        } else {
          const curTier = planTierRank(current);
          const targetTier = planTierRank(plan);
          const sameFamily = planFamilyKey(current) === planFamilyKey(plan);
          if (sameFamily && curTier === targetTier && current.period === 'month' && plan.period === 'year') {
            relation = 'billing_change'; action = 'change_billing';
          } else if (targetTier > curTier) {
            relation = 'upgrade'; action = 'upgrade';
          } else {
            relation = 'downgrade'; action = 'remind'; canPurchase = false;
            reason = '当前方案到期后可购买';
          }
        }
      } else if (current?.id === plan.id) {
        relation = 'current'; action = 'buy';
      }
      return {
        plan: publicPlan(plan), relation, action, canPurchase, reason,
        recommended: (publicUsage.usageStatus === 'exhausted' || publicUsage.usageStatus === 'near_limit') && !!nextTier && plan.id === nextTier.id,
        expiresAt: state?.planExpiresAt?.toISOString() ?? null,
        resetsAt: status.nextResetAt,
        ...(pendingOrder ? { pendingOrder: {
          outTradeNo: pendingOrder.outTradeNo,
          status: pendingOrder.status as NonNullable<PlanOption['pendingOrder']>['status'],
          amount: pendingOrder.amount,
          planId: pendingOrder.planId || undefined,
          paidAt: pendingOrder.paidAt?.toISOString(), appliedAt: pendingOrder.appliedAt?.toISOString(),
          itemName: plan.name, createdAt: pendingOrder.createdAt.toISOString(),
          payable: orderPayable(pendingOrder),
          payableUntil: orderPayableUntil(pendingOrder),
        } } : {}),
      };
    });
    const subPlan = subscription ? plans.find((p) => p.id === subscription.planId) ?? await prisma.plan.findUnique({ where: { id: subscription.planId } }) : null;
    return { currentPlanId: state?.planId ?? null, usage: publicUsage, options, subscription: subscription ? subscriptionView(subscription, subPlan?.name ?? '方案') : null };
  });

  // 官方「支付中签约」：首次付款与自动续费授权合并，但微信支付页的自动续费开关由用户主动选择，不能默认开启。
  app.post<{ Params: { id: string }; Body: { clientRequestId?: string; quoteFingerprint?: string; expectedChargeAmount?: number; source?: string; refId?: string } }>('/plans/:id/contract-order', async (req, reply): Promise<WechatOrderResult | void> => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const plan = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!plan || (plan.hidden && !canSeeHiddenPlans(user))) return reply.code(404).send({ error: '套餐不存在', code: 'PLAN_NOT_FOUND' });
    if (!papayConfigured() || !plan.autoRenewEnabled || !plan.wechatContractPlanId) return reply.code(501).send({ error: '该方案自动续费尚未开放', code: 'PAPAY_NOT_CONFIGURED' });
    if (plan.price <= 0) return reply.code(400).send({ error: '该方案不支持自动续费', code: 'PLAN_AUTO_RENEW_UNAVAILABLE' });
    const openid = resolvePayerOpenid(user);
    if (!openid) return reply.code(400).send({ error: '请先使用微信账号登录后开通自动续费', code: 'OPENID_REQUIRED' });
    try {
      const quote = await quotePlanChange(user.id, plan);
      if (quote.chargeAmount <= 0) return reply.code(409).send({ error: '本次无需付款，请先用单次购买完成方案变更；下个周期可再开自动续费', code: 'PAPAY_ZERO_AMOUNT_UNSUPPORTED' });
      if (req.body?.quoteFingerprint !== quote.quoteFingerprint || req.body?.expectedChargeAmount !== quote.chargeAmount) {
        return reply.code(409).send({ error: '方案价格或权益状态已变化，请重新确认', code: 'QUOTE_CHANGED' });
      }
      const attribution = parseAttribution(req.body?.source, req.body?.refId);
      const result = await createContractOrder({
        user, plan, openid, amount: quote.chargeAmount, clientRequestId: req.body?.clientRequestId?.trim() || `contract-${Date.now()}`,
        quoteFingerprint: quote.quoteFingerprint, termsHash: hashTerms(commercialTerms(plan)), spbillCreateIp: req.ip,
        attribution: { source: attribution.source, ...(attribution.refId ? { refId: attribution.refId } : {}) },
      });
      return { ok: true, outTradeNo: result.outTradeNo, amount: quote.chargeAmount, pay: result.pay, autoRenewRequested: true };
    } catch (e) {
      const err = e as { message?: string; statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? 502).send({ error: err.message ?? '自动续费签约失败', code: err.code ?? 'PAPAY_CREATE_FAILED' });
    }
  });

  app.post<{ Params: { id: string } }>('/plans/subscriptions/:id/cancel', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const contract = await cancelSubscription(user.id, req.params.id);
      const plan = await prisma.plan.findUnique({ where: { id: contract.planId } });
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.plan.subscription.cancel', payload: { subscriptionId: contract.id, planId: contract.planId } });
      return { ok: true, subscription: subscriptionView(contract, plan?.name ?? '方案') };
    } catch (e) {
      const err = e as { message?: string; statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? 502).send({ error: err.message ?? '关闭自动续费失败', code: err.code ?? 'SUBSCRIPTION_CANCEL_FAILED' });
    }
  });

  app.post<{ Params: { id: string } }>('/plans/:id/quote', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const plan = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!plan || (plan.hidden && !canSeeHiddenPlans(user))) return reply.code(404).send({ error: '套餐不存在', code: 'PLAN_NOT_FOUND' });
    try {
      const quote = await quotePlanChange(user.id, plan);
      return { ...quote, currentPlan: quote.currentPlan ? { ...quote.currentPlan, autoRenewAvailable: false } : null, targetPlan: publicPlan(plan) };
    }
    catch (e) {
      const err = e as { message?: string; statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? 409).send({ error: err.message ?? '暂时无法变更方案', code: err.code ?? 'PLAN_SWITCH_BLOCKED' });
    }
  });

  // 演示购买：直接发放权益（不经支付）。仅免费套餐 + 演示环境可用；付费套餐必须走支付。
  app.post<{ Params: { id: string } }>('/plans/:id/purchase', async (req, reply): Promise<PlanPurchaseResult | void> => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const plan = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!plan) return reply.code(404).send({ error: '套餐不存在', code: 'PLAN_NOT_FOUND' });
    // 隐藏档对非白名单等同不存在（同 404，不泄露存在性）。
    if (plan.hidden && !canSeeHiddenPlans(user)) return reply.code(404).send({ error: '套餐不存在', code: 'PLAN_NOT_FOUND' });
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
  app.post<{ Params: { id: string }; Body: { openid?: string; source?: string; refId?: string; clientRequestId?: string; quoteFingerprint?: string; expectedChargeAmount?: number } }>('/plans/:id/order', async (req, reply): Promise<WechatOrderResult | void> => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const plan = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!plan) return reply.code(404).send({ error: '套餐不存在', code: 'PLAN_NOT_FOUND' });
    // 隐藏档对非白名单等同不存在（同 404，不泄露存在性）。
    if (plan.hidden && !canSeeHiddenPlans(user)) return reply.code(404).send({ error: '套餐不存在', code: 'PLAN_NOT_FOUND' });
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
    let quote;
    try { quote = await quotePlanChange(user.id, plan); }
    catch (e) {
      const err = e as { message?: string; statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? 409).send({ error: err.message ?? '暂时无法变更方案', code: err.code ?? 'PLAN_SWITCH_BLOCKED' });
    }
    const needsQuote = quote?.relation === 'upgrade' || quote?.relation === 'billing_change';
    const assertedQuote = req.body?.quoteFingerprint !== undefined || req.body?.expectedChargeAmount !== undefined;
    if ((needsQuote || assertedQuote) && (req.body?.quoteFingerprint !== quote.quoteFingerprint || req.body?.expectedChargeAmount !== quote.chargeAmount)) {
      return reply.code(409).send({ error: '方案价格或权益状态已变化，请重新确认', code: 'QUOTE_CHANGED' });
    }
    const attribution = parseAttribution(req.body?.source, req.body?.refId);
    try {
      const r = await createJsapiOrder({
        user, plan: { id: plan.id, name: plan.name, price: plan.price }, openid,
        amount: quote.chargeAmount, attribution,
        clientRequestId: req.body?.clientRequestId?.trim() || undefined,
        quote: {
          quoteFingerprint: quote.quoteFingerprint,
          remainingValue: quote.remainingValue,
          chargeAmount: quote.chargeAmount,
          relation: quote.relation,
        },
        termsHash: hashTerms(commercialTerms(plan)),
      });
      if (quote.relation === 'upgrade' || quote.relation === 'billing_change') {
        await recordAudit({
          tenantId: user.tenantId, userId: user.id, action: 'user.plan.proration',
          payload: {
            outTradeNo: r.outTradeNo, fromPlanId: quote.currentPlan?.id, fromPlanName: quote.currentPlan?.name, toPlanId: plan.id,
            relation: quote.relation, fullPrice: quote.fullPrice, remainingDays: quote.remainingDays,
            remainingValue: quote.remainingValue, chargeAmount: quote.chargeAmount,
          },
        });
      }
      return {
        ok: true, outTradeNo: r.outTradeNo, amount: quote.chargeAmount, pay: r.pay,
        ...(r.mock ? { mock: true as const } : {}),
        proration: quote.relation === 'upgrade' || quote.relation === 'billing_change'
          ? { applies: true, fullPrice: quote.fullPrice, remainingDays: quote.remainingDays, remainingValue: quote.remainingValue, chargeAmount: quote.chargeAmount }
          : undefined,
      };
    } catch (e) {
      const err = e as { message?: string; statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? 502).send({ error: err.message ?? '下单失败', code: err.code ?? 'WECHAT_PAY_CREATE_FAILED' });
    }
  });
}
