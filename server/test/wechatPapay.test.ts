import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { buildPapayXml, handleContractNotify, handlePapayPaymentNotify, parsePapayXml, reconcilePendingSubscriptions, scanAutoRenewals, signPapayFields, verifyPapayFields } from '../src/services/wechatPapay.js';
import { closeApp, cleanBusiness, getApp, seedBaseline } from './helpers.js';

const V2_KEY = '12345678901234567890123456789012';
let userId = ''; let tenantId = ''; let planId = '';

before(async () => {
  process.env.WECHAT_MINI_APPID = 'wx_test_papay';
  process.env.WECHAT_PAY_MCHID = '1900000109';
  process.env.WECHAT_PAY_V2_KEY = V2_KEY;
  process.env.WECHAT_PAPAY_PAY_NOTIFY_URL = 'https://example.test/api/pay/wechat/v2/notify';
  process.env.WECHAT_PAPAY_CONTRACT_NOTIFY_URL = 'https://example.test/api/pay/wechat/contract/notify';
  await getApp(); await seedBaseline();
});
after(async () => { await closeApp(); });

beforeEach(async () => {
  await cleanBusiness(); await seedBaseline();
  const tenant = await prisma.tenant.create({ data: { name: '自动续费测试' } }); tenantId = tenant.id;
  const user = await prisma.user.create({ data: { tenantId, phone: `139${Date.now().toString().slice(-8)}`, name: '订阅用户', role: 'owner', wechatOpenId: 'openid_test' } }); userId = user.id;
  const plan = await prisma.plan.findFirstOrThrow({ where: { price: { gt: 0 } }, orderBy: { sort: 'asc' } }); planId = plan.id;
});

function signed(fields: Record<string, string | number>): Record<string, string> {
  const normalized = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)]));
  return { ...normalized, sign: signPapayFields(normalized, V2_KEY) };
}

test('V2 XML：转义可往返，DOCTYPE/ENTITY 被拒绝，签名篡改后失败', () => {
  const fields = signed({ return_code: 'SUCCESS', body: '军师 & <续费>', total_fee: 19800 });
  const parsed = parsePapayXml(buildPapayXml(fields));
  assert.equal(parsed.body, '军师 & <续费>');
  assert.equal(verifyPapayFields(parsed), true);
  assert.equal(verifyPapayFields({ ...parsed, total_fee: '1' }), false);
  assert.throws(() => parsePapayXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><xml><a>&e;</a></xml>'), /非法 XML/);
});

test('配置降级：V2 配置缺失时只隐藏自动续费，套餐目录仍正常返回', async () => {
  await prisma.plan.update({ where: { id: planId }, data: { autoRenewEnabled: true, wechatContractPlanId: '900000' } });
  const oldKey = process.env.WECHAT_PAY_V2_KEY;
  process.env.WECHAT_PAY_V2_KEY = '';
  try {
    const response = await (await getApp()).inject({ method: 'GET', url: '/api/plans/options', headers: { 'x-user-id': userId } });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { options: Array<{ plan: { id: string; autoRenewAvailable: boolean } }> };
    assert.equal(body.options.find((item) => item.plan.id === planId)?.plan.autoRenewAvailable, false);
    assert.ok(body.options.length > 0, '自动续费未配置不能让单次购买套餐目录消失');
  } finally {
    process.env.WECHAT_PAY_V2_KEY = oldKey;
  }
});

test('用户主动选择自动续费：路由创建支付中签约首单与 pending 协议', async () => {
  await prisma.plan.update({ where: { id: planId }, data: { autoRenewEnabled: true, wechatContractPlanId: '900010' } });
  const app = await getApp();
  const quoteResponse = await app.inject({ method: 'POST', url: `/api/plans/${planId}/quote`, headers: { 'x-user-id': userId } });
  assert.equal(quoteResponse.statusCode, 200);
  const quote = quoteResponse.json() as { quoteFingerprint: string; chargeAmount: number };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/pay\/contractorder$/);
    const request = parsePapayXml(String(init?.body ?? ''));
    assert.equal(verifyPapayFields(request), true);
    assert.equal(request.plan_id, '900010');
    assert.equal(request.openid, 'openid_test');
    assert.equal(request.total_fee, String(quote.chargeAmount));
    const response = signed({
      return_code: 'SUCCESS', result_code: 'SUCCESS', appid: 'wx_test_papay', mch_id: '1900000109',
      nonce_str: 'response_nonce', prepay_id: 'wx_prepay_contract_1', trade_type: 'JSAPI',
      plan_id: '900010', request_serial: request.request_serial, contract_code: request.contract_code,
      out_trade_no: request.out_trade_no,
    });
    return new Response(buildPapayXml(response), { status: 200, headers: { 'Content-Type': 'application/xml' } });
  };
  let response;
  try {
    response = await app.inject({
      method: 'POST', url: `/api/plans/${planId}/contract-order`, headers: { 'x-user-id': userId },
      payload: { clientRequestId: 'auto-intent-1', quoteFingerprint: quote.quoteFingerprint, expectedChargeAmount: quote.chargeAmount },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as { outTradeNo: string; autoRenewRequested: boolean; pay: { package: string; signType: string; paySign: string } };
  assert.equal(body.autoRenewRequested, true);
  assert.equal(body.pay.package, 'prepay_id=wx_prepay_contract_1');
  assert.equal(body.pay.signType, 'MD5');
  const [order, contract] = await Promise.all([
    prisma.paymentOrder.findUniqueOrThrow({ where: { outTradeNo: body.outTradeNo } }),
    prisma.subscriptionContract.findFirstOrThrow({ where: { userId } }),
  ]);
  assert.equal(order.payMode, 'contract_initial');
  assert.equal(order.subscriptionContractId, contract.id);
  assert.equal(contract.status, 'pending');
  assert.equal(contract.wechatPlanId, '900010');
  assert.match(contract.requestSerial, /^\d{18}$/);
  assert.ok(BigInt(contract.requestSerial) <= 9223372036854775807n);
  const idempotentRetry = await app.inject({
    method: 'POST', url: `/api/plans/${planId}/contract-order`, headers: { 'x-user-id': userId },
    payload: { clientRequestId: 'auto-intent-1', quoteFingerprint: quote.quoteFingerprint, expectedChargeAmount: quote.chargeAmount },
  });
  assert.equal(idempotentRetry.statusCode, 200, '同一购买意图重试必须复用原签约首单');
  assert.equal((idempotentRetry.json() as { outTradeNo: string }).outTradeNo, body.outTradeNo);
  const repay = await app.inject({ method: 'POST', url: `/api/pay/orders/${body.outTradeNo}/pay-params`, headers: { 'x-user-id': userId } });
  assert.equal(repay.statusCode, 200);
  await prisma.paymentOrder.update({ where: { outTradeNo: body.outTradeNo }, data: { status: 'closed' } });
  const closedRepay = await app.inject({ method: 'POST', url: `/api/pay/orders/${body.outTradeNo}/pay-params`, headers: { 'x-user-id': userId } });
  assert.equal(closedRepay.statusCode, 409, '已关闭/已完成的签约首单不能重新签出支付参数');
  const closedIntentRetry = await app.inject({
    method: 'POST', url: `/api/plans/${planId}/contract-order`, headers: { 'x-user-id': userId },
    payload: { clientRequestId: 'auto-intent-1', quoteFingerprint: quote.quoteFingerprint, expectedChargeAmount: quote.chargeAmount },
  });
  assert.equal(closedIntentRetry.statusCode, 409, '终态签约首单也不能通过原购买意图重新调起');
});

test('自动续费并发下单：同一购买意图只向微信创建一次签约首单', async () => {
  await prisma.plan.update({ where: { id: planId }, data: { autoRenewEnabled: true, wechatContractPlanId: '900011' } });
  const app = await getApp();
  const quoteResponse = await app.inject({ method: 'POST', url: `/api/plans/${planId}/quote`, headers: { 'x-user-id': userId } });
  const quote = quoteResponse.json() as { quoteFingerprint: string; chargeAmount: number };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (_input, init) => {
    fetchCalls += 1;
    const request = parsePapayXml(String(init?.body ?? ''));
    await new Promise((resolve) => setTimeout(resolve, 80));
    return new Response(buildPapayXml(signed({
      return_code: 'SUCCESS', result_code: 'SUCCESS', appid: 'wx_test_papay', mch_id: '1900000109',
      nonce_str: 'response_nonce_concurrent', prepay_id: 'wx_prepay_contract_concurrent', trade_type: 'JSAPI',
      plan_id: request.plan_id, request_serial: request.request_serial, contract_code: request.contract_code,
      out_trade_no: request.out_trade_no,
    })), { status: 200, headers: { 'Content-Type': 'application/xml' } });
  };
  try {
    const request = () => app.inject({
      method: 'POST', url: `/api/plans/${planId}/contract-order`, headers: { 'x-user-id': userId },
      payload: { clientRequestId: 'auto-intent-concurrent', quoteFingerprint: quote.quoteFingerprint, expectedChargeAmount: quote.chargeAmount },
    });
    const responses = await Promise.all([request(), request()]);
    assert.equal(fetchCalls, 1, '并发幂等重试不能向微信重复发签约下单请求');
    assert.deepEqual(responses.map((item) => item.statusCode).sort(), [200, 409]);
    assert.equal((responses.find((item) => item.statusCode === 409)?.json() as { code?: string }).code, 'ORDER_CREATING');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(await prisma.paymentOrder.count({ where: { userId, clientRequestId: 'auto-intent-concurrent' } }), 1);
  assert.equal(await prisma.subscriptionContract.count({ where: { userId } }), 1);
});

test('签约 ADD + 支付通知重复投递：协议激活且套餐权益只发一次', async () => {
  const contract = await prisma.subscriptionContract.create({ data: {
    tenantId, userId, planId, planFamilyKey: planId, contractCode: 'contract_case_1', requestSerial: '100000000000000001',
    wechatPlanId: '900001', openid: 'openid_test', renewalAmount: 19800, termsHash: 'terms-1',
  } });
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
  await prisma.paymentOrder.create({ data: {
    outTradeNo: 'papay_initial_case_1', tenantId, userId, planId, amount: plan.price, provider: 'wechat',
    payMode: 'contract_initial', subscriptionContractId: contract.id,
  } });

  const addNotify = signed({
    mch_id: '1900000109', change_type: 'ADD', contract_code: contract.contractCode,
    contract_id: 'wx_contract_001', plan_id: '900001', openid: 'openid_test', request_serial: contract.requestSerial,
  });
  await handleContractNotify(addNotify);
  await handleContractNotify(addNotify);
  const payload = signed({
    return_code: 'SUCCESS', result_code: 'SUCCESS', appid: 'wx_test_papay', mch_id: '1900000109',
    out_trade_no: 'papay_initial_case_1', transaction_id: 'wx_papay_tx_001', total_fee: plan.price,
  });
  const first = await handlePapayPaymentNotify(payload);
  const second = await handlePapayPaymentNotify(payload);
  assert.equal(first.applied, true);
  assert.equal(second.reason, 'already_applied');
  const afterContract = await prisma.subscriptionContract.findUniqueOrThrow({ where: { id: contract.id } });
  assert.equal(afterContract.status, 'active');
  assert.equal(afterContract.wechatContractId, 'wx_contract_001');
  assert.ok(afterContract.nextBillingAt, '首次到账后应建立下一扣款锚点');
  const options = await (await getApp()).inject({ method: 'GET', url: '/api/plans/options', headers: { 'x-user-id': userId } });
  assert.equal(options.statusCode, 200);
  const current = (options.json() as { subscription: { id: string; status: string; nextBillingAt: string | null } | null }).subscription;
  assert.equal(current?.id, contract.id);
  assert.equal(current?.status, 'active', '方案页接口必须返回当前已生效的自动续费状态');
  assert.ok(current?.nextBillingAt, '方案页接口必须返回下一续费时间');
  assert.equal(await prisma.planEntitlement.count({ where: { userId } }), 1, '重复通知不能重复发权益');
  assert.equal(await prisma.auditLog.count({ where: { userId, action: 'user.plan.subscription.signed' } }), 1, '重复 ADD 不能重复记签约审计');
});

test('签约通知 openid/模板不一致时拒绝，不能劫持协议', async () => {
  await prisma.subscriptionContract.create({ data: {
    tenantId, userId, planId, planFamilyKey: planId, contractCode: 'contract_case_2', requestSerial: '100000000000000002',
    wechatPlanId: '900002', openid: 'openid_test', renewalAmount: 19800, termsHash: 'terms-2',
  } });
  await assert.rejects(() => handleContractNotify(signed({
    mch_id: '1900000109', change_type: 'ADD', contract_code: 'contract_case_2',
    contract_id: 'wx_contract_attack', plan_id: '900002', openid: 'other_openid',
  })), /签约协议不匹配/);
  const row = await prisma.subscriptionContract.findUniqueOrThrow({ where: { contractCode: 'contract_case_2' } });
  assert.equal(row.status, 'pending');
});

test('签约回调丢失：主动查询签约关系补激活，且请求不多传 sign_type', async () => {
  const contract = await prisma.subscriptionContract.create({ data: {
    tenantId, userId, planId, planFamilyKey: planId, contractCode: 'contract_query_1', requestSerial: '100000000000000004',
    wechatPlanId: '900004', openid: 'openid_test', renewalAmount: 19800, termsHash: 'terms-4',
    createdAt: new Date(Date.now() - 5 * 60_000), nextBillingAt: new Date(Date.now() + 20 * 86400_000),
  } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/papay\/querycontract$/);
    const request = parsePapayXml(String(init?.body ?? ''));
    assert.equal(request.sign_type, undefined, '官方字段表没有 sign_type，不能擅自多传');
    assert.equal(verifyPapayFields(request), true);
    assert.equal(request.plan_id, '900004');
    assert.equal(request.contract_code, 'contract_query_1');
    const response = signed({
      return_code: 'SUCCESS', result_code: 'SUCCESS', appid: 'wx_test_papay', mch_id: '1900000109',
      contract_id: 'wx_contract_query_1', plan_id: '900004', request_serial: contract.requestSerial,
      contract_code: contract.contractCode, contract_display_account: 'test', contract_state: 0, openid: 'openid_test',
    });
    return new Response(buildPapayXml(response), { status: 200, headers: { 'Content-Type': 'application/xml' } });
  };
  try {
    const result = await reconcilePendingSubscriptions();
    assert.deepEqual(result, { scanned: 1, activated: 1, closed: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const after = await prisma.subscriptionContract.findUniqueOrThrow({ where: { id: contract.id } });
  assert.equal(after.status, 'active');
  assert.equal(after.wechatContractId, 'wx_contract_query_1');
  assert.equal(await prisma.auditLog.count({ where: { userId, action: 'user.plan.subscription.reconciled' } }), 1);
});

test('用户关闭自动续费：调用微信解约，当前周期协议本地停扣', async () => {
  const contract = await prisma.subscriptionContract.create({ data: {
    tenantId, userId, planId, planFamilyKey: planId, contractCode: 'contract_cancel_1', requestSerial: '100000000000000005',
    wechatPlanId: '900005', wechatContractId: 'wx_contract_cancel_1', openid: 'openid_test', renewalAmount: 19800,
    termsHash: 'terms-5', status: 'active', nextBillingAt: new Date(Date.now() + 20 * 86400_000),
  } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/papay\/deletecontract$/);
    const request = parsePapayXml(String(init?.body ?? ''));
    assert.equal(verifyPapayFields(request), true);
    assert.equal(request.contract_id, 'wx_contract_cancel_1');
    const response = signed({ return_code: 'SUCCESS', result_code: 'SUCCESS', appid: 'wx_test_papay', mch_id: '1900000109', nonce_str: 'cancel_nonce' });
    return new Response(buildPapayXml(response), { status: 200, headers: { 'Content-Type': 'application/xml' } });
  };
  let response;
  try {
    response = await (await getApp()).inject({
      method: 'POST', url: `/api/plans/subscriptions/${contract.id}/cancel`, headers: { 'x-user-id': userId },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as { subscription: { status: string; nextBillingAt: string | null } };
  assert.equal(body.subscription.status, 'cancelled');
  assert.equal(body.subscription.nextBillingAt, null);
  const after = await prisma.subscriptionContract.findUniqueOrThrow({ where: { id: contract.id } });
  assert.equal(after.status, 'cancelled');
  assert.equal(after.nextBillingAt, null);
  assert.equal(await prisma.auditLog.count({ where: { userId, action: 'user.plan.subscription.cancel' } }), 1);
});

test('解约请求结果不确定：保持 cancel_pending 停扣，由 scheduler 重试而非恢复 active', async () => {
  const contract = await prisma.subscriptionContract.create({ data: {
    tenantId, userId, planId, planFamilyKey: planId, contractCode: 'contract_cancel_timeout', requestSerial: '100000000000000006',
    wechatPlanId: '900006', wechatContractId: 'wx_contract_cancel_timeout', openid: 'openid_test', renewalAmount: 19800,
    termsHash: 'terms-6', status: 'active', nextBillingAt: new Date(Date.now() + 20 * 86400_000),
  } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('socket timeout'); };
  let response;
  try {
    response = await (await getApp()).inject({
      method: 'POST', url: `/api/plans/subscriptions/${contract.id}/cancel`, headers: { 'x-user-id': userId },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((response.json() as { subscription: { status: string } }).subscription.status, 'cancel_pending');
  const after = await prisma.subscriptionContract.findUniqueOrThrow({ where: { id: contract.id } });
  assert.equal(after.status, 'cancel_pending');
  assert.equal(after.nextBillingAt, null);
});

test('扣款申请结果不确定：保留原单待查，重复扫描不创建第二笔扣款', async () => {
  const plan = await prisma.plan.update({
    where: { id: planId }, data: { autoRenewEnabled: true, wechatContractPlanId: '900007' },
  });
  await prisma.user.update({ where: { id: userId }, data: { planId, planActivatedAt: new Date(), planExpiresAt: new Date(Date.now() + 24 * 3600_000) } });
  const contract = await prisma.subscriptionContract.create({ data: {
    tenantId, userId, planId, planFamilyKey: planId, contractCode: 'contract_charge_timeout', requestSerial: '100000000000000007',
    wechatPlanId: '900007', wechatContractId: 'wx_contract_charge_timeout', openid: 'openid_test', renewalAmount: plan.price,
    termsHash: 'terms-7', status: 'active', nextBillingAt: new Date(Date.now() - 60_000),
  } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('socket timeout'); };
  try {
    const first = await scanAutoRenewals();
    const second = await scanAutoRenewals();
    assert.equal(first.scanned, 1);
    assert.equal(second.scanned, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const orders = await prisma.paymentOrder.findMany({ where: { subscriptionContractId: contract.id, payMode: 'papay_recurring' } });
  assert.equal(orders.length, 1, '未知结果只能查原单，不能换单重复扣款');
  assert.equal(orders[0].status, 'created');
  assert.equal((orders[0].rawNotifyJson as { outcomeUnknown?: boolean })?.outcomeUnknown, true);
  assert.equal((await prisma.subscriptionContract.findUniqueOrThrow({ where: { id: contract.id } })).status, 'active');
});

test('周期扣款失败通知：不把缺少金额误判成功，并在同周期安排第二次尝试', async () => {
  const before = new Date(Date.now() - 60_000);
  const contract = await prisma.subscriptionContract.create({ data: {
    tenantId, userId, planId, planFamilyKey: planId, contractCode: 'contract_case_3', requestSerial: '100000000000000003',
    wechatPlanId: '900003', wechatContractId: 'wx_contract_003', openid: 'openid_test', renewalAmount: 19800,
    termsHash: 'terms-3', status: 'active', nextBillingAt: before,
  } });
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
  await prisma.paymentOrder.create({ data: {
    outTradeNo: 'papay_recurring_case_3', tenantId, userId, planId, amount: plan.price, provider: 'wechat',
    payMode: 'papay_recurring', subscriptionContractId: contract.id, billingPeriodKey: 'period-3', billingAttempt: 1,
  } });

  const failed = await handlePapayPaymentNotify(signed({
    return_code: 'SUCCESS', result_code: 'FAIL', appid: 'wx_test_papay', mch_id: '1900000109',
    out_trade_no: 'papay_recurring_case_3', contract_id: 'wx_contract_003', err_code: 'NOTENOUGH',
  }));
  assert.equal(failed.reason, 'trade_state_NOTENOUGH');
  const [order, after] = await Promise.all([
    prisma.paymentOrder.findUniqueOrThrow({ where: { outTradeNo: 'papay_recurring_case_3' } }),
    prisma.subscriptionContract.findUniqueOrThrow({ where: { id: contract.id } }),
  ]);
  assert.equal(order.status, 'failed');
  assert.ok(after.nextBillingAt && after.nextBillingAt.getTime() > Date.now() + 5 * 3600_000, '失败后应延后约 6 小时再试');

  await assert.rejects(() => handlePapayPaymentNotify(signed({
    return_code: 'SUCCESS', result_code: 'FAIL', appid: 'wx_test_papay', mch_id: '1900000109',
    out_trade_no: 'papay_recurring_case_3', contract_id: 'other_contract', err_code: 'NOTENOUGH',
  })), /代扣协议信息不一致/);

  await prisma.paymentOrder.create({ data: {
    outTradeNo: 'papay_system_case_3', tenantId, userId, planId, amount: plan.price, provider: 'wechat',
    payMode: 'papay_recurring', subscriptionContractId: contract.id, billingPeriodKey: 'period-system-3', billingAttempt: 1,
  } });
  const pending = await handlePapayPaymentNotify(signed({
    return_code: 'SUCCESS', result_code: 'FAIL', appid: 'wx_test_papay', mch_id: '1900000109',
    out_trade_no: 'papay_system_case_3', contract_id: 'wx_contract_003', err_code: 'SYSTEMERROR',
  }));
  assert.equal(pending.reason, 'trade_state_SYSTEMERROR_pending_query');
  assert.equal((await prisma.paymentOrder.findUniqueOrThrow({ where: { outTradeNo: 'papay_system_case_3' } })).status, 'created', 'SYSTEMERROR 必须等查单，不能直接换单重扣');
});
