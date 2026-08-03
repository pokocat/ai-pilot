// 微信支付 V2「委托代扣—自动续费」。官方链路与现有 v3 JSAPI 并存：
// ① /pay/contractorder 支付中签约（首次支付 + 用户自愿开通）；② contract notify 建立/解除协议；
// ③ 到期前 24h /pay/pappayapply 申请续费；④ 扣款通知或 /pay/paporderquery 主动查单补账。
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Plan, Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { buildOrderSnapshot, genOutTradeNo, markPaidAndApply, orderPayable, orderPayableUntil } from './wechatPay.js';

const HTTP_TIMEOUT_MS = 5_000;
const DELAY_24H_MS = 24 * 3600_000;

function cfg() {
  return {
    appId: (process.env.WECHAT_MINI_APPID ?? '').trim(),
    mchId: (process.env.WECHAT_PAY_MCHID ?? '').trim(),
    v2Key: (process.env.WECHAT_PAY_V2_KEY ?? '').trim(),
    payNotifyUrl: (process.env.WECHAT_PAPAY_PAY_NOTIFY_URL ?? '').trim(),
    contractNotifyUrl: (process.env.WECHAT_PAPAY_CONTRACT_NOTIFY_URL ?? '').trim(),
    base: (process.env.WECHAT_PAPAY_BASE ?? '').trim().replace(/\/+$/, '') || 'https://api.mch.weixin.qq.com',
  };
}

export function papayConfigured(): boolean {
  const c = cfg();
  return !!(c.appId && c.mchId && c.v2Key.length === 32 && c.payNotifyUrl && c.contractNotifyUrl);
}

function xmlEscape(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function xmlDecode(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
export function parsePapayXml(raw: string): Record<string, string> {
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw Object.assign(new Error('非法 XML'), { code: 'PAPAY_XML_INVALID', statusCode: 400 });
  const out: Record<string, string> = {};
  const body = raw.match(/^\s*<xml>([\s\S]*)<\/xml>\s*$/i)?.[1];
  if (body === undefined) throw Object.assign(new Error('非法 XML'), { code: 'PAPAY_XML_INVALID', statusCode: 400 });
  const re = /<([A-Za-z_][\w.-]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) out[match[1]] = xmlDecode((match[2] ?? match[3] ?? '').trim());
  return out;
}
export function buildPapayXml(fields: Record<string, unknown>): string {
  return `<xml>${Object.entries(fields).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('')}</xml>`;
}

export function signPapayFields(fields: Record<string, unknown>, key = cfg().v2Key, signType: 'MD5' | 'HMAC-SHA256' = 'MD5'): string {
  const source = Object.entries(fields)
    .filter(([k, v]) => k !== 'sign' && v !== undefined && v !== null && String(v) !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`).join('&') + `&key=${key}`;
  return (signType === 'HMAC-SHA256' ? createHmac('sha256', key).update(source).digest('hex') : createHash('md5').update(source).digest('hex')).toUpperCase();
}
export function verifyPapayFields(fields: Record<string, string>): boolean {
  const got = (fields.sign ?? '').toUpperCase();
  if (!got) return false;
  const type = fields.sign_type === 'HMAC-SHA256' ? 'HMAC-SHA256' : 'MD5';
  const expected = signPapayFields(fields, cfg().v2Key, type);
  const a = Buffer.from(got); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function papaySuccessXml(message = 'OK'): string {
  return buildPapayXml({ return_code: 'SUCCESS', return_msg: message });
}
export function papayFailXml(message: string): string {
  return buildPapayXml({ return_code: 'FAIL', return_msg: message.slice(0, 120) });
}

async function postXml(path: string, fields: Record<string, unknown>): Promise<Record<string, string>> {
  if (!papayConfigured()) throw Object.assign(new Error('自动续费尚未配置'), { code: 'PAPAY_NOT_CONFIGURED', statusCode: 501 });
  // 委托代扣这组旧版接口的请求字段表没有 sign_type；MD5 是接口约定的默认签名方式。
  // 不擅自追加未声明字段，避免微信按“多传参数”拒绝请求。
  const signed = { ...fields, sign: signPapayFields(fields) };
  let res: Response;
  try {
    res = await fetch(cfg().base + path, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body: buildPapayXml(signed), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) {
    throw Object.assign(new Error(`微信自动续费网络异常：${(err as Error).message}`), { code: 'PAPAY_NETWORK_ERROR', statusCode: 502 });
  }
  const parsed = parsePapayXml(await res.text());
  if (parsed.sign && !verifyPapayFields(parsed)) {
    throw Object.assign(new Error('微信自动续费响应验签失败'), { code: 'PAPAY_RESPONSE_SIGNATURE_INVALID', statusCode: 502 });
  }
  if (!res.ok || parsed.return_code !== 'SUCCESS' || (parsed.result_code && parsed.result_code !== 'SUCCESS')) {
    throw Object.assign(new Error(`微信自动续费接口失败：${parsed.err_code_des || parsed.return_msg || `HTTP ${res.status}`}`), { code: parsed.err_code || 'PAPAY_REQUEST_FAILED', statusCode: 502 });
  }
  return parsed;
}

/** 请求可能已被微信受理、但本地拿不到可信终态；这类错误绝不能换新单或恢复扣款。 */
function papayOutcomeUnknown(error: unknown): boolean {
  return ['PAPAY_NETWORK_ERROR', 'PAPAY_RESPONSE_SIGNATURE_INVALID', 'PAPAY_XML_INVALID', 'PAPAY_REQUEST_FAILED', 'SYSTEMERROR']
    .includes((error as { code?: string })?.code ?? '');
}

function contractCode(): string { return `ct${Date.now()}${randomBytes(5).toString('hex')}`.slice(0, 32); }
// 13 位毫秒时间戳 + 5 位随机数 = 18 位正整数，既降低并发碰撞，也严格小于微信 int64 上限。
function requestSerial(): string { return `${Date.now()}${String(randomBytes(3).readUIntBE(0, 3) % 100_000).padStart(5, '0')}`; }
function nonce(): string { return randomBytes(16).toString('hex'); }

export interface ContractOrderResult {
  outTradeNo: string;
  pay: { timeStamp: string; nonceStr: string; package: string; signType: 'MD5'; paySign: string };
}

export async function createContractOrder(args: {
  user: { id: string; tenantId: string }; plan: Plan; openid: string; amount: number;
  clientRequestId: string; quoteFingerprint?: string; termsHash: string;
  attribution?: { source: string; refId?: string };
  spbillCreateIp: string;
}): Promise<ContractOrderResult> {
  if (!papayConfigured()) throw Object.assign(new Error('自动续费尚未开放'), { code: 'PAPAY_NOT_CONFIGURED', statusCode: 501 });
  if (!args.plan.autoRenewEnabled || !args.plan.wechatContractPlanId || args.plan.autoRenewMode !== 'delay_24h') {
    throw Object.assign(new Error('该方案暂不支持自动续费'), { code: 'PLAN_AUTO_RENEW_UNAVAILABLE', statusCode: 409 });
  }
  const family = args.plan.planFamilyKey || args.plan.id;
  const existingIntentResult = (existing: Awaited<ReturnType<typeof prisma.paymentOrder.findUnique>>): ContractOrderResult | null => {
    if (!existing) return null;
    const samePayload = existing.payMode === 'contract_initial'
      && existing.planId === args.plan.id
      && existing.amount === args.amount
      && existing.quoteFingerprint === (args.quoteFingerprint ?? null)
      && existing.termsHash === args.termsHash;
    if (!samePayload) throw Object.assign(new Error('购买请求已用于其他方案，请重新确认'), { code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
    if (existing.status !== 'created') throw Object.assign(new Error('该购买请求已处理，请刷新方案状态'), { code: 'ORDER_ALREADY_PROCESSED', statusCode: 409 });
    if (Date.now() >= new Date(orderPayableUntil(existing)).getTime()) {
      throw Object.assign(new Error('支付会话已过期，请重新确认购买'), { code: 'ORDER_EXPIRED', statusCode: 409 });
    }
    if (existing.prepayId) {
      if (!orderPayable(existing)) throw Object.assign(new Error('该订单当前不可继续支付'), { code: 'ORDER_NOT_PAYABLE', statusCode: 409 });
      return { outTradeNo: existing.outTradeNo, pay: buildV2PayParams(existing.prepayId) };
    }
    return null;
  };
  let existingOrder = await prisma.paymentOrder.findUnique({ where: { userId_clientRequestId: { userId: args.user.id, clientRequestId: args.clientRequestId } } });
  const existingResult = existingIntentResult(existingOrder);
  if (existingResult) return existingResult;
  if (!existingOrder) {
    const existingActive = await prisma.subscriptionContract.findFirst({ where: { userId: args.user.id, planFamilyKey: family, status: { in: ['pending', 'active', 'cancel_pending'] } } });
    if (existingActive) throw Object.assign(new Error('当前方案已有自动续费协议，请勿重复开通'), { code: 'SUBSCRIPTION_EXISTS', statusCode: 409 });
  }

  const outTradeNo = existingOrder?.outTradeNo ?? genOutTradeNo().replace(/^js/, 'cs');
  const code = contractCode();
  const serial = requestSerial();
  const snapshot = await buildOrderSnapshot({ planId: args.plan.id });
  let created: { contract: Awaited<ReturnType<typeof prisma.subscriptionContract.create>>; order: Awaited<ReturnType<typeof prisma.paymentOrder.create>> } | null = null;
  if (!existingOrder) {
    try {
      created = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`papay-contract:${args.user.id}:${family}`}))`;
        const recent = await tx.paymentOrder.count({ where: { userId: args.user.id, createdAt: { gt: new Date(Date.now() - 10 * 60_000) } } });
        if (recent >= 10) throw Object.assign(new Error('下单过于频繁，请稍后再试'), { code: 'ORDER_RATE_LIMITED', statusCode: 429 });
        const again = await tx.subscriptionContract.findFirst({ where: { userId: args.user.id, planFamilyKey: family, status: { in: ['pending', 'active', 'cancel_pending'] } } });
        if (again) throw Object.assign(new Error('当前方案已有自动续费协议，请勿重复开通'), { code: 'SUBSCRIPTION_EXISTS', statusCode: 409 });
        const contract = await tx.subscriptionContract.create({ data: {
          tenantId: args.user.tenantId, userId: args.user.id, planId: args.plan.id, planFamilyKey: family,
          contractCode: code, requestSerial: serial, wechatPlanId: args.plan.wechatContractPlanId!, openid: args.openid,
          renewalAmount: args.plan.price, termsHash: args.termsHash,
        } });
        const order = await tx.paymentOrder.create({ data: {
          outTradeNo, tenantId: args.user.tenantId, userId: args.user.id, planId: args.plan.id, amount: args.amount,
          provider: 'wechat', payMode: 'contract_initial', subscriptionContractId: contract.id,
          snapshotJson: snapshot, clientRequestId: args.clientRequestId, quoteFingerprint: args.quoteFingerprint,
          termsHash: args.termsHash, attrSource: args.attribution?.source, attrRefId: args.attribution?.refId,
        } });
        return { contract, order };
      });
    } catch (error) {
      // 同一意图并发时，另一请求可能已在 advisory lock 内完成建单；按幂等键回读，不能误报成“已有协议”。
      const raced = await prisma.paymentOrder.findUnique({ where: { userId_clientRequestId: { userId: args.user.id, clientRequestId: args.clientRequestId } } });
      if (!raced) throw error;
      existingOrder = raced;
      const racedResult = existingIntentResult(raced);
      if (racedResult) return racedResult;
      // 另一请求已经建好同一订单、但尚未写回 prepay_id；此时不并发重发微信请求。
      // 原请求若最终失败，客户端稍后以同 clientRequestId 重试时会从函数开头进入安全复用路径。
      throw Object.assign(new Error('订单正在创建，请稍后重试'), { code: 'ORDER_CREATING', statusCode: 409 });
    }
  }
  const contract = created?.contract ?? await prisma.subscriptionContract.findUnique({ where: { id: existingOrder!.subscriptionContractId! } });
  if (!contract) throw Object.assign(new Error('自动续费协议初始化失败'), { code: 'SUBSCRIPTION_CREATE_FAILED', statusCode: 500 });
  const c = cfg();
  const response = await postXml('/pay/contractorder', {
    appid: c.appId, mch_id: c.mchId, contract_mchid: c.mchId, contract_appid: c.appId,
    out_trade_no: outTradeNo, nonce_str: nonce(), body: `${args.plan.name}自动续费`,
    notify_url: c.payNotifyUrl, total_fee: args.amount, spbill_create_ip: args.spbillCreateIp, trade_type: 'JSAPI', openid: args.openid,
    plan_id: contract.wechatPlanId, contract_code: contract.contractCode, request_serial: contract.requestSerial,
    contract_display_account: args.user.id.slice(-20), contract_notify_url: c.contractNotifyUrl,
  });
  if (!response.prepay_id) throw Object.assign(new Error('微信未返回 prepay_id'), { code: 'PAPAY_CREATE_FAILED', statusCode: 502 });
  await prisma.paymentOrder.update({ where: { outTradeNo }, data: { prepayId: response.prepay_id } });
  return { outTradeNo, pay: buildV2PayParams(response.prepay_id) };
}

export function buildV2PayParams(prepayId: string): ContractOrderResult['pay'] {
  const c = cfg(); const timeStamp = Math.floor(Date.now() / 1000).toString(); const nonceStr = nonce();
  const pkg = `prepay_id=${prepayId}`; const signType = 'MD5' as const;
  return { timeStamp, nonceStr, package: pkg, signType, paySign: signPapayFields({ appId: c.appId, timeStamp, nonceStr, package: pkg, signType }) };
}

export async function handleContractNotify(fields: Record<string, string>): Promise<void> {
  if (!verifyPapayFields(fields)) throw Object.assign(new Error('签约通知验签失败'), { code: 'PAPAY_SIGNATURE_INVALID', statusCode: 401 });
  const c = cfg();
  // 官方签约/解约通知没有 appid 字段，只能校验 mch_id；openid、模板和商户协议号在下方逐项绑定本地记录。
  if (fields.mch_id !== c.mchId) throw Object.assign(new Error('签约通知商户信息不一致'), { code: 'PAPAY_MERCHANT_MISMATCH', statusCode: 400 });
  const contract = await prisma.subscriptionContract.findUnique({ where: { contractCode: fields.contract_code } });
  if (!contract || contract.openid !== fields.openid || contract.wechatPlanId !== fields.plan_id) throw Object.assign(new Error('签约协议不匹配'), { code: 'PAPAY_CONTRACT_MISMATCH', statusCode: 400 });
  if (fields.change_type === 'ADD') {
    await prisma.$transaction(async (tx) => {
      // 支付中签约的 ADD 可能重复投递，也可能在用户已发起关闭后迟到。只允许 pending -> active；
      // active 视作幂等成功，cancel_pending/cancelled/failed 绝不被迟到通知重新激活。
      const activated = await tx.subscriptionContract.updateMany({
        where: { id: contract.id, status: 'pending' },
        data: { status: 'active', wechatContractId: fields.contract_id, rawNotifyJson: fields },
      });
      if (activated.count === 1) {
        await tx.auditLog.create({ data: { tenantId: contract.tenantId, userId: contract.userId, action: 'user.plan.subscription.signed', payloadJson: { subscriptionId: contract.id, planId: contract.planId, wechatPlanId: contract.wechatPlanId } } }).catch(() => {});
      }
    });
  } else if (fields.change_type === 'DELETE') {
    await prisma.$transaction(async (tx) => {
      const cancelled = await tx.subscriptionContract.updateMany({
        where: { id: contract.id, status: { not: 'cancelled' } },
        data: { status: 'cancelled', cancelledAt: new Date(), nextBillingAt: null, terminationMode: Number(fields.contract_termination_mode) || null, rawNotifyJson: fields },
      });
      if (cancelled.count === 1) {
        await tx.auditLog.create({ data: { tenantId: contract.tenantId, userId: contract.userId, action: 'user.plan.subscription.terminated', payloadJson: { subscriptionId: contract.id, planId: contract.planId, terminationMode: Number(fields.contract_termination_mode) || null } } }).catch(() => {});
      }
    });
  } else {
    throw Object.assign(new Error('未知签约变更类型'), { code: 'PAPAY_CHANGE_TYPE_INVALID', statusCode: 400 });
  }
}

export async function handlePapayPaymentNotify(fields: Record<string, string>): Promise<{ applied: boolean; reason?: string }> {
  if (!verifyPapayFields(fields)) throw Object.assign(new Error('扣款通知验签失败'), { code: 'PAPAY_SIGNATURE_INVALID', statusCode: 401 });
  const c = cfg();
  const order = await prisma.paymentOrder.findUnique({ where: { outTradeNo: fields.out_trade_no } });
  if (!order || !['contract_initial', 'papay_recurring'].includes(order.payMode)) {
    throw Object.assign(new Error('代扣订单不存在'), { code: 'PAPAY_ORDER_MISMATCH', statusCode: 400 });
  }
  const contract = order.subscriptionContractId
    ? await prisma.subscriptionContract.findUnique({ where: { id: order.subscriptionContractId } }) : null;
  if (!contract || (fields.openid && fields.openid !== contract.openid)
    || (order.payMode === 'papay_recurring' && (!fields.contract_id || fields.contract_id !== contract.wechatContractId))) {
    throw Object.assign(new Error('代扣协议信息不一致'), { code: 'PAPAY_CONTRACT_MISMATCH', statusCode: 400 });
  }
  // 微信失败通知不返回 total_fee/transaction_id，且历史示例里的 result_code 可能仍为 SUCCESS；
  // 因此必须以“无错误 + 有交易号（或显式 trade_state=SUCCESS）”共同判断成功。
  const succeeded = fields.return_code === 'SUCCESS' && fields.result_code === 'SUCCESS'
    && !fields.err_code && (fields.trade_state === 'SUCCESS' || !!fields.transaction_id);
  const notifiedAmount = fields.total_fee === undefined ? undefined : Number(fields.total_fee);
  // 官方要求 SYSTEMERROR 先查单、确认关闭后才能换单。此处保留 created 等待回调/主动查单，
  // 绝不能直接排第二单，否则首单晚到成功时会造成同周期重复扣款。
  if (!succeeded && fields.err_code === 'SYSTEMERROR') {
    await prisma.paymentOrder.update({ where: { id: order.id }, data: { rawNotifyJson: fields } });
    return { applied: false, reason: 'trade_state_SYSTEMERROR_pending_query' };
  }
  const result = await markPaidAndApply({
    outTradeNo: fields.out_trade_no, transactionId: fields.transaction_id,
    tradeState: succeeded ? 'SUCCESS' : (fields.trade_state || fields.err_code || 'FAIL'),
    amountTotal: notifiedAmount !== undefined && Number.isFinite(notifiedAmount) ? notifiedAmount : undefined,
    appId: fields.appid, mchId: fields.mch_id, rawJson: fields,
  }, 'wechat_papay');
  // 查询代扣订单接口仍可能未向当前商户开放，因此失败回调本身就是重试调度的主来源。
  // 只对真实业务失败延后同周期第二次尝试；字段不一致等安全拒绝绝不自动重试。
  if (order.payMode === 'papay_recurring' && result.reason?.startsWith('trade_state_')) {
    const contractGone = ['CONTRACT_NOT_EXIST', 'CONTRACTERROR'].includes(fields.err_code || fields.trade_state);
    await prisma.subscriptionContract.updateMany({
      where: { id: contract.id, status: 'active' },
      data: contractGone
        ? { status: 'cancelled', cancelledAt: new Date(), nextBillingAt: null }
        : { nextBillingAt: new Date(Date.now() + 6 * 3600_000) },
    });
  }
  return result;
}

export async function cancelSubscription(userId: string, id: string) {
  const contract = await prisma.subscriptionContract.findFirst({ where: { id, userId } });
  if (!contract) throw Object.assign(new Error('自动续费协议不存在'), { code: 'SUBSCRIPTION_NOT_FOUND', statusCode: 404 });
  if (contract.status === 'cancelled') return contract;
  // 用户一确认关闭就先停本地调度；远端结果不确定时也不能继续保留下一扣款时间。
  await prisma.subscriptionContract.update({ where: { id }, data: { status: 'cancel_pending', nextBillingAt: null } });
  try {
    await postXml('/papay/deletecontract', {
      appid: cfg().appId, mch_id: cfg().mchId, request_serial: requestSerial(), version: '1.0',
      ...(contract.wechatContractId ? { contract_id: contract.wechatContractId } : { plan_id: contract.wechatPlanId, contract_code: contract.contractCode }),
    });
  } catch (err) {
    // 微信明确返回“协议不存在”说明远端已经没有可扣授权，本地直接收口即可。
    if ((err as { code?: string }).code === 'CONTRACT_NOT_EXIST') {
      // 继续走下方本地 cancelled 收口。
    } else if (papayOutcomeUnknown(err)) {
      // 请求超时/响应不可信时远端可能已经解约；保持 cancel_pending 停扣，由 scheduler 重试确认。
      return prisma.subscriptionContract.findUniqueOrThrow({ where: { id } });
    } else {
      await prisma.subscriptionContract.update({ where: { id }, data: { status: contract.status, nextBillingAt: contract.nextBillingAt } });
      throw err;
    }
  }
  // 微信还会发送 DELETE 通知；先本地停扣，回调重复到达幂等覆盖。
  return prisma.subscriptionContract.update({ where: { id }, data: { status: 'cancelled', cancelledAt: new Date(), nextBillingAt: null } });
}

export function subscriptionView(contract: { id: string; planId: string; status: string; nextBillingAt: Date | null; cancelledAt: Date | null }, planName: string) {
  return { id: contract.id, planId: contract.planId, planName, status: contract.status as 'pending' | 'active' | 'cancel_pending' | 'cancelled' | 'failed', nextBillingAt: contract.nextBillingAt?.toISOString() ?? null, cancelledAt: contract.cancelledAt?.toISOString() ?? null };
}

async function createRecurringOrder(contract: Awaited<ReturnType<typeof prisma.subscriptionContract.findFirst>> & {}, plan: Plan, billingPeriodKey: string, attempt: number) {
  const snapshot = await buildOrderSnapshot({ planId: plan.id });
  const outTradeNo = genOutTradeNo().replace(/^js/, 'pr');
  return prisma.paymentOrder.create({ data: {
    outTradeNo, tenantId: contract.tenantId, userId: contract.userId, planId: plan.id, amount: contract.renewalAmount,
    provider: 'wechat', payMode: 'papay_recurring', subscriptionContractId: contract.id, billingPeriodKey, billingAttempt: attempt,
    snapshotJson: snapshot, termsHash: contract.termsHash, attrSource: 'auto_renew',
  } });
}

export async function scanAutoRenewals(limit = 100): Promise<{ scanned: number; submitted: number; failed: number }> {
  if (!papayConfigured()) return { scanned: 0, submitted: 0, failed: 0 };
  const due = await prisma.subscriptionContract.findMany({ where: { status: 'active', nextBillingAt: { lte: new Date() } }, orderBy: { nextBillingAt: 'asc' }, take: limit });
  let submitted = 0; let failed = 0;
  for (const contract of due) {
    try {
      const [plan, user] = await Promise.all([prisma.plan.findUnique({ where: { id: contract.planId } }), prisma.user.findUnique({ where: { id: contract.userId }, select: { planId: true, planExpiresAt: true } })]);
      // 改价、换档、关闭自动续费均不允许用旧授权静默扣新条款；停扣并等待用户重新选择。
      if (!plan || !user || user.planId !== plan.id || !plan.autoRenewEnabled || plan.price !== contract.renewalAmount || plan.wechatContractPlanId !== contract.wechatPlanId) {
        await prisma.subscriptionContract.update({ where: { id: contract.id }, data: { status: 'cancel_pending', nextBillingAt: null } });
        failed += 1; continue;
      }
      const periodKey = user.planExpiresAt?.toISOString() ?? contract.nextBillingAt!.toISOString();
      const previous = await prisma.paymentOrder.findMany({ where: { subscriptionContractId: contract.id, billingPeriodKey: periodKey }, orderBy: { billingAttempt: 'desc' }, take: 1 });
      if (previous[0]?.status === 'applied' || previous[0]?.status === 'paid' || previous[0]?.status === 'created') continue;
      const attempt = (previous[0]?.billingAttempt ?? 0) + 1;
      if (attempt > 2) { await prisma.subscriptionContract.update({ where: { id: contract.id }, data: { status: 'failed', nextBillingAt: null } }); failed += 1; continue; }
      const order = await createRecurringOrder(contract, plan, periodKey, attempt);
      try {
        await postXml('/pay/pappayapply', { appid: cfg().appId, mch_id: cfg().mchId, nonce_str: nonce(), body: `${plan.name}自动续费`, out_trade_no: order.outTradeNo, total_fee: order.amount, notify_url: cfg().payNotifyUrl, trade_type: 'PAP', contract_id: contract.wechatContractId });
        submitted += 1;
      } catch (err) {
        const unknown = papayOutcomeUnknown(err);
        await prisma.paymentOrder.update({
          where: { id: order.id },
          // 结果不确定时必须保留 created，后续只查原单；明确拒绝才允许同周期第二次尝试。
          data: { ...(unknown ? {} : { status: 'failed' }), rawNotifyJson: { error: (err as Error).message, outcomeUnknown: unknown } },
        });
        if (!unknown && ['CONTRACT_NOT_EXIST', 'CONTRACTERROR'].includes((err as { code?: string }).code ?? '')) {
          await prisma.subscriptionContract.updateMany({ where: { id: contract.id, status: 'active' }, data: { status: 'cancelled', cancelledAt: new Date(), nextBillingAt: null } });
        }
        failed += 1;
      }
    } catch (err) { console.error('[papay] renewal scan failed:', contract.id, (err as Error).message); failed += 1; }
  }
  return { scanned: due.length, submitted, failed };
}

export async function reconcilePapayOrders(limit = 100): Promise<{ scanned: number; applied: number; failed: number }> {
  if (!papayConfigured()) return { scanned: 0, applied: 0, failed: 0 };
  const rows = await prisma.paymentOrder.findMany({ where: { payMode: 'papay_recurring', status: 'created', createdAt: { lt: new Date(Date.now() - 2 * 60_000) } }, take: limit, orderBy: { createdAt: 'asc' } });
  let applied = 0; let failed = 0;
  for (const order of rows) {
    try {
      const result = await postXml('/pay/paporderquery', { appid: cfg().appId, mch_id: cfg().mchId, nonce_str: nonce(), out_trade_no: order.outTradeNo });
      if (result.trade_state === 'SUCCESS') {
        const done = await markPaidAndApply({ outTradeNo: order.outTradeNo, transactionId: result.transaction_id, tradeState: 'SUCCESS', amountTotal: Number(result.total_fee), appId: result.appid, mchId: result.mch_id, rawJson: result }, 'wechat_papay_query');
        if (done.applied) applied += 1;
      } else if (['PAY_FAIL', 'CLOSED'].includes(result.trade_state)) {
        await prisma.$transaction(async (tx) => {
          await tx.paymentOrder.updateMany({ where: { id: order.id, status: 'created' }, data: { status: 'failed', rawNotifyJson: result } });
          if (order.subscriptionContractId) await tx.subscriptionContract.updateMany({ where: { id: order.subscriptionContractId, status: 'active' }, data: { nextBillingAt: new Date(Date.now() + 6 * 3600_000) } });
        });
        failed += 1;
      }
    } catch (err) { console.warn('[papay] query failed:', order.outTradeNo, (err as Error).message); }
  }
  return { scanned: rows.length, applied, failed };
}

/** 手动换档/退款把协议置 cancel_pending 后，由 scheduler 补做微信侧解约，避免只停本地不关远端授权。 */
export async function scanPendingSubscriptionCancellations(limit = 50): Promise<{ scanned: number; cancelled: number }> {
  if (!papayConfigured()) return { scanned: 0, cancelled: 0 };
  const rows = await prisma.subscriptionContract.findMany({ where: { status: 'cancel_pending' }, orderBy: { updatedAt: 'asc' }, take: limit });
  let cancelled = 0;
  for (const row of rows) {
    try {
      await postXml('/papay/deletecontract', {
        appid: cfg().appId, mch_id: cfg().mchId, request_serial: requestSerial(), version: '1.0',
        ...(row.wechatContractId ? { contract_id: row.wechatContractId } : { plan_id: row.wechatPlanId, contract_code: row.contractCode }),
      });
      await prisma.subscriptionContract.updateMany({ where: { id: row.id, status: 'cancel_pending' }, data: { status: 'cancelled', cancelledAt: new Date(), nextBillingAt: null } });
      cancelled += 1;
    } catch (err) {
      if ((err as { code?: string }).code === 'CONTRACT_NOT_EXIST') {
        await prisma.subscriptionContract.updateMany({ where: { id: row.id, status: 'cancel_pending' }, data: { status: 'cancelled', cancelledAt: new Date(), nextBillingAt: null } });
        cancelled += 1;
      } else {
        console.warn('[papay] pending cancel failed:', row.id, (err as Error).message);
      }
    }
  }
  return { scanned: rows.length, cancelled };
}

/**
 * 官方签约回调丢失/延迟时，按 plan_id + contract_code 主动查询签约关系补偿。
 * 这与扣款查单不同：/papay/querycontract 是正式开放接口，不依赖代扣订单查询的灰度权限。
 */
export async function reconcilePendingSubscriptions(limit = 100): Promise<{ scanned: number; activated: number; closed: number }> {
  if (!papayConfigured()) return { scanned: 0, activated: 0, closed: 0 };
  const rows = await prisma.subscriptionContract.findMany({
    where: { status: 'pending', createdAt: { lt: new Date(Date.now() - 2 * 60_000) } },
    orderBy: { createdAt: 'asc' }, take: limit,
  });
  let activated = 0; let closed = 0;
  for (const row of rows) {
    try {
      const result = await postXml('/papay/querycontract', {
        appid: cfg().appId, mch_id: cfg().mchId, plan_id: row.wechatPlanId,
        contract_code: row.contractCode, version: '1.0',
      });
      const mismatch = result.appid !== cfg().appId || result.mch_id !== cfg().mchId
        || result.plan_id !== row.wechatPlanId || result.contract_code !== row.contractCode
        || result.openid !== row.openid || result.request_serial !== row.requestSerial;
      if (mismatch) {
        console.error('[papay] query contract mismatch:', row.id);
        continue;
      }
      if (result.contract_state === '0' && result.contract_id) {
        await prisma.$transaction(async (tx) => {
          const changed = await tx.subscriptionContract.updateMany({
            where: { id: row.id, status: 'pending' },
            data: { status: 'active', wechatContractId: result.contract_id, rawNotifyJson: result },
          });
          if (changed.count === 1) {
            await tx.auditLog.create({ data: {
              tenantId: row.tenantId, userId: row.userId, action: 'user.plan.subscription.reconciled',
              payloadJson: { subscriptionId: row.id, planId: row.planId, wechatPlanId: row.wechatPlanId },
            } }).catch(() => {});
            activated += 1;
          }
        });
      } else if (result.contract_state === '1') {
        const terminated = !!result.contract_terminated_time;
        const changed = await prisma.subscriptionContract.updateMany({
          where: { id: row.id, status: 'pending' },
          data: {
            status: terminated ? 'cancelled' : 'failed', nextBillingAt: null,
            ...(terminated ? { cancelledAt: new Date(), terminationMode: Number(result.contract_termination_mode) || null } : {}),
            rawNotifyJson: result,
          },
        });
        closed += changed.count;
      } else if (result.contract_state === '9') {
        await prisma.subscriptionContract.updateMany({ where: { id: row.id, status: 'pending' }, data: { rawNotifyJson: result } });
      }
    } catch (err) {
      // 未签约时微信可能返回 -25/RESULT_NULL；保留 pending，交给完整回调窗口后的清理任务判断。
      console.warn('[papay] pending contract query failed:', row.id, (err as Error).message);
    }
  }
  return { scanned: rows.length, activated, closed };
}

/** 支付中签约允许用户只付款、不打开续费开关；没有 ADD/查询成功就不能把 pending 冒充已签约。 */
export async function expireStalePendingSubscriptions(limit = 100): Promise<number> {
  const rows = await prisma.subscriptionContract.findMany({ where: { status: 'pending', createdAt: { lt: new Date(Date.now() - 2 * 3600_000) } }, take: limit });
  let expired = 0;
  for (const row of rows) {
    const order = await prisma.paymentOrder.findFirst({ where: { subscriptionContractId: row.id, payMode: 'contract_initial' }, select: { status: true, createdAt: true } });
    const ageMs = order ? Date.now() - order.createdAt.getTime() : Number.POSITIVE_INFINITY;
    const paid = order?.status === 'applied' || order?.status === 'paid';
    // 未付款单保留完整 2h 支付窗口；已付款但无签约结果保留至少 6h，覆盖官方回调重试周期并给主动查询补偿留时间。
    if (!order || (!paid && ageMs > 2 * 3600_000) || (paid && ageMs > 6 * 3600_000)) {
      const result = await prisma.subscriptionContract.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'failed', nextBillingAt: null } });
      expired += result.count;
    }
  }
  return expired;
}

/** 用户支付后轮询单笔补账：签约首单走普通 V2 查单，周期续费单走 PAP 查单。 */
export async function reconcilePapayOrder(outTradeNo: string): Promise<{ applied: boolean; reason?: string }> {
  const order = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
  if (!order || !['contract_initial', 'papay_recurring'].includes(order.payMode)) return { applied: false, reason: 'order_not_found' };
  const path = order.payMode === 'papay_recurring' ? '/pay/paporderquery' : '/pay/orderquery';
  const result = await postXml(path, { appid: cfg().appId, mch_id: cfg().mchId, nonce_str: nonce(), out_trade_no: outTradeNo });
  const state = result.trade_state ?? result.result_code ?? 'UNKNOWN';
  if (state !== 'SUCCESS') return { applied: false, reason: `trade_state_${state}` };
  return markPaidAndApply({ outTradeNo, transactionId: result.transaction_id, tradeState: 'SUCCESS', amountTotal: Number(result.total_fee), appId: result.appid, mchId: result.mch_id, rawJson: result }, 'wechat_papay_query');
}
