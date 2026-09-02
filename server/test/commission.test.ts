// 代理分销佣金：计提 / 冻结 / 冲销 / 追回 / 结算单全生命周期（2026-09-02）。
//
// 这组用例守的是六件事：
//   ① **代码里没有默认比例**：开关关着 → 一分不计提；规则为空 → 一分不计提。
//      这不是「待补的 TODO」，是正确行为（对外数据归运营，代码不许自带比例、不许 seed 等级）。
//   ② **计提口径**：精确 itemType 优先于 'all'、多级各按自己那一级的比例、
//      非代理祖先跳过且**不顺延层级**、`suspended` 代理**不计提**（不是延后计提）。
//   ③ **幂等**：outbox 重复处理、scheduler 续扫、微信重复回调都只计一次
//      （靠 CommissionEntry 的 (outTradeNo, beneficiaryUserId, level, kind) 唯一键）。
//   ④ **冻结期归运营配置**：holdUntil = 支付时刻 + `distribution-hold.days`，到期且订单未退款
//      才由 `confirmMatured` 转 confirmed。
//   ⑤ **退款两条路**：结算前 → 原行 `reversed`（挂在草稿单上还要把那张单的金额重算）；
//      结算后 → **另落一条负额 clawback**，绝不改写已打款的那行。
//   ⑥ **权限与审计**：写端点全部 requireSuper（operator 403），每个写动作都有审计行。
//
// 真实链路，不捏造：支付走 `PAY_MOCK_SUCCESS` + `POST /pay/mock/pay`（与 payMockSuccess.test.ts
// 同一条夹具，真实建单 → 真实 markPaidAndApply），退款走真实 `refundWechatOrder` 的 mock 分支，
// 邀请关系由真实注册链路（`/auth/referral-capture` + `/auth/login`）写出 lv1/lv2/lv3。
//
// 等级与规则是**运营目录**，刻意不在 `prisma/resetBusinessData.ts` 里（进了就会在预发 seed 时
// 清掉运营录入的比例），所以本文件自己建、自己清（见 beforeEach 的 clearCatalog）。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import {
  DISTRIBUTION_FLAG, DISTRIBUTION_HOLD_FLAG, DISTRIBUTION_HOLD_KEY,
  confirmMatured, processCommissionOutbox, scanCommissionOutbox, settleCommissions,
} from '../src/services/commission.js';
import { __clearFeatureCache, mergeFeatureFlagPayload, setFeatureFlag } from '../src/services/featureFlag.js';
import { ensureInviteCode } from '../src/services/community.js';
import { refundWechatOrder } from '../src/services/wechatPay.js';
import { createOperator, createSession } from '../src/services/adminAccount.js';
import { api, cleanBusiness, closeApp, getApp, seedBaseline, uniquePhone } from './helpers.js';
import type {
  AdminCommissionList, AdminDistributionConfig, AdminDistributorDetail, AdminDistributorItem,
  AdminDistributorList, AdminDistributorTier, AdminSettlement, AdminSettlementGenerateResult,
  AdminSettlementList,
} from '../../shared/contracts';

// admin 路由鉴权：node --test 每个文件是独立子进程，不设这行所有 /api/admin/* 恒 401
// ——而那是「没带凭证」，不是本组想验的 requireSuper 403。
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

const TOUCHED_ENV = [
  'PAY_MOCK_SUCCESS', 'WECHAT_PAY_MCHID', 'WECHAT_PAY_APIV3_KEY', 'WECHAT_PAY_CERT_SERIAL',
  'WECHAT_PAY_PRIVATE_KEY', 'WECHAT_PAY_NOTIFY_URL', 'WECHAT_PAY_BASE',
] as const;
const savedEnv: Record<string, string | undefined> = {};

before(async () => {
  for (const k of TOUCHED_ENV) savedEnv[k] = process.env[k];
  process.env.PAY_MOCK_SUCCESS = 'true';
  // 六项凭据必须缺席，否则 mock 自动让位（这正是 PAY_MOCK_SUCCESS「零改动替换」的机制）。
  for (const k of ['WECHAT_PAY_MCHID', 'WECHAT_PAY_APIV3_KEY', 'WECHAT_PAY_CERT_SERIAL', 'WECHAT_PAY_PRIVATE_KEY', 'WECHAT_PAY_NOTIFY_URL', 'WECHAT_PAY_BASE']) delete process.env[k];
  await getApp();
});

after(async () => {
  for (const k of TOUCHED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await clearCatalog();
  await closeApp();
});

/** 运营目录（等级 + 规则）自己清：它们不在 resetBusinessData 里，理由见文件头。 */
async function clearCatalog(): Promise<void> {
  await prisma.distributionRule.deleteMany();
  await prisma.distributorTier.deleteMany();
}

beforeEach(async () => {
  process.env.PAY_MOCK_SUCCESS = 'true';
  await cleanBusiness();
  await clearCatalog();
  await seedBaseline();
  // cleanBusiness 直接删表，不经过 setFeatureFlag* 的失效路径 → 进程内缓存还留着上一条用例的值。
  __clearFeatureCache();
});

/* ── 夹具 ───────────────────────────────────────────────────────────────── */

/** 走**真实注册链路**建号（可带邀请码）——物化路径 lv1/lv2/lv3 由 services/referral.ts 写。 */
async function register(inviteCode?: string): Promise<string> {
  const body: Record<string, unknown> = { phone: uniquePhone(), name: '分销用例用户' };
  if (inviteCode) {
    const captured = await api<{ token: string }>('POST', '/api/auth/referral-capture', {
      body: { inviteCode, source: 'share_friend' },
    });
    assert.equal(captured.status, 200, JSON.stringify(captured.body));
    body.inviteCode = inviteCode;
    body.referralToken = captured.body.token;
  }
  const r = await api<{ token: string }>('POST', '/api/auth/login', { body });
  assert.equal(r.status, 200, `注册应成功，实际 ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

interface Chain { a: string; b: string; c: string; buyer: string }

/**
 * 建一条四层真实关系链 a → b → c → buyer。
 * 于是 buyer 的 Referral 是 { lv1: c, lv2: b, lv3: a }，正好把三级都盖住。
 */
async function chain(): Promise<Chain> {
  const a = await register();
  const b = await register(await ensureInviteCode(a));
  const c = await register(await ensureInviteCode(b));
  const buyer = await register(await ensureInviteCode(c));
  const row = await prisma.referral.findUniqueOrThrow({ where: { userId: buyer } });
  assert.deepEqual(
    { lv1: row.lv1, lv2: row.lv2, lv3: row.lv3 }, { lv1: c, lv2: b, lv3: a },
    '真实注册链路应写出三级物化路径（本文件的层级断言全建立在它上面）',
  );
  return { a, b, c, buyer };
}

async function openFlags(holdDays = 7): Promise<void> {
  await setFeatureFlag(DISTRIBUTION_FLAG, true);
  await mergeFeatureFlagPayload(DISTRIBUTION_HOLD_FLAG, { [DISTRIBUTION_HOLD_KEY]: holdDays });
  __clearFeatureCache();
}

/** 建等级 + 整体替换比例矩阵（都走真实后台端点，不直接写库）。 */
async function makeTier(
  name: string,
  rules: { level: 1 | 2 | 3; itemType: 'plan' | 'sku' | 'all'; rateBp: number; enabled?: boolean }[],
): Promise<string> {
  const created = await api<AdminDistributorTier>('POST', '/api/admin/distribution/tiers', { body: { name } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  // 契约：三个写端点都回**完整的** AdminDistributorTier（前端拿返回值直接刷新那张比例矩阵，
  // 不该再补一次 GET）。新建时 rules 空、distributorCount 0，但两个字段必须在。
  assert.deepEqual(created.body.rules, [], '新建等级要回空规则数组，不是缺字段');
  assert.equal(created.body.distributorCount, 0);
  assert.ok(created.body.updatedAt && created.body.id);
  const put = await api<AdminDistributorTier>('PUT', `/api/admin/distribution/tiers/${created.body.id}/rules`, {
    body: { rules: rules.map((r) => ({ ...r, enabled: r.enabled !== false })) },
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.id, created.body.id, '整体替换要回这张等级本身，不是 {ok:true}');
  assert.equal(put.body.rules.length, rules.length, '回值里的 rules 就是刚存进去的那一套');
  for (const r of put.body.rules) assert.ok(r.id, '规则要带库里生成的 id（拼出来的回值没有它）');
  return created.body.id;
}

async function makeDistributor(userId: string, tierId: string | null): Promise<AdminDistributorItem> {
  const r = await api<AdminDistributorItem>('POST', '/api/admin/distribution/distributors', {
    body: { userId, tierId, displayName: '渠道商', contactPhone: '13900000001' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

/** 该用户当前持有的套餐 id（测试期默认套餐；买同一档 = 续费，不触发降级守卫）。 */
async function heldPlanId(userId: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { planId: true } });
  assert.ok(u.planId, '测试期注册应带默认套餐（helpers 的 TEST_DEFAULT_PLAN_NAME）');
  return u.planId!;
}

/** 真实建单 → /pay/mock/pay → paid+applied，并等佣金 outbox 落地。返回 outTradeNo。 */
async function payPlan(buyer: string): Promise<string> {
  const planId = await heldPlanId(buyer);
  const order = await api<{ outTradeNo: string; mock: boolean }>('POST', `/api/plans/${planId}/order`, {
    token: buyer, body: {},
  });
  assert.equal(order.status, 200, JSON.stringify(order.body));
  assert.equal(order.body.mock, true, '未配凭据 + PAY_MOCK_SUCCESS → 下单必须回 mock 标记');
  const pay = await api('POST', '/api/pay/mock/pay', { token: buyer, body: { outTradeNo: order.body.outTradeNo } });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.equal(pay.body.applied, true);
  await settleCommissions();
  return order.body.outTradeNo;
}

async function paySku(buyer: string, key = 'deep-contradiction'): Promise<string> {
  const order = await api<{ orderId: string; mock: boolean }>('POST', `/api/skus/${key}/order`, { token: buyer, body: {} });
  assert.equal(order.status, 200, JSON.stringify(order.body));
  const pay = await api('POST', '/api/pay/mock/pay', { token: buyer, body: { orderId: order.body.orderId } });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.equal(pay.body.applied, true);
  await settleCommissions();
  return order.body.orderId;
}

async function entriesOf(outTradeNo: string) {
  return prisma.commissionEntry.findMany({ where: { outTradeNo }, orderBy: [{ kind: 'asc' }, { level: 'asc' }] });
}

/** 普通运营（role=operator）的会话 token —— 用于验证 requireSuper 拒绝。 */
async function operatorToken(): Promise<string> {
  const acc = await createOperator(`dop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, 'pw-123456', 'operator');
  return createSession(acc.id);
}

/* ── 鉴权 ───────────────────────────────────────────────────────────────── */

describe('鉴权：整块屏在 requireAdmin 之后，写操作再过 requireSuper', () => {
  for (const path of [
    '/api/admin/distribution/config',
    '/api/admin/distribution/tiers',
    '/api/admin/distribution/distributors',
    '/api/admin/distribution/commissions',
    '/api/admin/distribution/settlements',
  ]) {
    test(`无凭证访问 ${path} → 401`, async () => {
      const r = await api('GET', path, { adminToken: false });
      assert.equal(r.status, 401, `应 401，实际 ${r.status}`);
      assert.equal(r.body.code, 'ADMIN_UNAUTHORIZED');
    });
  }

  test('已登录的普通小程序用户（非管理员）→ 403，不是 401', async () => {
    const uid = await register();
    const r = await api('GET', '/api/admin/distribution/distributors', { token: uid, adminToken: false });
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });

  test('operator 对全部写端点 403 OWNER_ONLY，且被拒的写不留痕', async () => {
    const token = await operatorToken();
    const writes: [string, string, unknown][] = [
      ['POST', '/api/admin/distribution/tiers', { name: '偷建的等级' }],
      ['PATCH', '/api/admin/distribution/tiers/whatever', { name: '改名' }],
      ['DELETE', '/api/admin/distribution/tiers/whatever', undefined],
      ['PUT', '/api/admin/distribution/tiers/whatever/rules', { rules: [] }],
      ['POST', '/api/admin/distribution/distributors', { userId: 'u_x' }],
      ['PATCH', '/api/admin/distribution/distributors/whatever', { status: 'suspended' }],
      ['POST', '/api/admin/distribution/settlements/generate', { periodStart: '2026-01-01T00:00:00Z', periodEnd: '2026-02-01T00:00:00Z' }],
      ['POST', '/api/admin/distribution/settlements/whatever/approve', {}],
      ['POST', '/api/admin/distribution/settlements/whatever/paid', { paidRef: 'REF-1' }],
      ['POST', '/api/admin/distribution/settlements/whatever/void', { reason: '手滑' }],
    ];
    for (const [method, url, body] of writes) {
      const r = await api(method as 'POST', url, { adminToken: token, ...(body === undefined ? {} : { body }) });
      assert.equal(r.status, 403, `${method} ${url} 应 403，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'OWNER_ONLY', `${method} ${url} 错误码应是 OWNER_ONLY`);
    }
    assert.equal(await prisma.distributorTier.count(), 0, '被拒的写不得留下任何痕迹');
    assert.equal(await prisma.distributor.count(), 0);
  });
});

/* ── 配置只读 ───────────────────────────────────────────────────────────── */

test('config：默认关 + 冻结期未配时如实回 holdConfigured=false', async () => {
  const r = await api<AdminDistributionConfig>('GET', '/api/admin/distribution/config');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.enabled, false, '库里没这行 = 从没开过 = 不计提');
  assert.equal(r.body.holdConfigured, false, '运营没配过冻结期，必须看得出「这是兜底值」');
  assert.ok(Number.isInteger(r.body.holdDays) && r.body.holdDays >= 0, '仍要给一个能用的兜底数字');
  assert.deepEqual(r.body.flagKeys, { enabled: DISTRIBUTION_FLAG, hold: DISTRIBUTION_HOLD_FLAG });

  await openFlags(3);
  const after = await api<AdminDistributionConfig>('GET', '/api/admin/distribution/config');
  assert.equal(after.body.enabled, true);
  assert.equal(after.body.holdDays, 3);
  assert.equal(after.body.holdConfigured, true);
});

/* ── 计提 ───────────────────────────────────────────────────────────────── */

test('开关关着 → outbox 照常完成，但一条佣金都不落（代码里没有默认比例）', async () => {
  const { c, buyer } = await chain();
  const tierId = await makeTier('金牌', [{ level: 1, itemType: 'all', rateBp: 1000 }]);
  await makeDistributor(c, tierId);

  const no = await payPlan(buyer);
  assert.equal((await entriesOf(no)).length, 0, '总开关关着必须零计提');
  const outbox = await prisma.commissionOutbox.findUniqueOrThrow({ where: { outTradeNo_kind: { outTradeNo: no, kind: 'paid' } } });
  assert.ok(outbox.completedAt, '不计提也是一个已处理的结论，outbox 必须完成（否则会被无限重扫）');
  assert.equal(outbox.lastError, null);
});

test('开关开着但规则为空 → 仍然零计提（空规则 = 不计提，不是待补的 TODO）', async () => {
  await openFlags();
  const { c, buyer } = await chain();
  const tierId = await makeTier('无比例等级', []);
  await makeDistributor(c, tierId);
  const no = await payPlan(buyer);
  assert.equal((await entriesOf(no)).length, 0);
});

test('代理没挂等级 → 零计提（等级目录归运营，代码不替他挑一个）', async () => {
  await openFlags();
  const { c, buyer } = await chain();
  await makeDistributor(c, null);
  assert.equal((await entriesOf(await payPlan(buyer))).length, 0);
});

test('按规则计提：精确 itemType 优先 all、多级各自比例、非代理祖先跳过且不顺延层级', async () => {
  await openFlags(7);
  const { a, b, c, buyer } = await chain();
  // 一级同时配了 'plan' 与 'all'：套餐单必须取 'plan'（精确优先），SKU 单回落 'all'。
  const tierId = await makeTier('金牌', [
    { level: 1, itemType: 'plan', rateBp: 1000 },
    { level: 1, itemType: 'all', rateBp: 500 },
    { level: 2, itemType: 'all', rateBp: 300 },
    { level: 3, itemType: 'plan', rateBp: 100 },
  ]);
  const dc = await makeDistributor(c, tierId);
  const db = await makeDistributor(b, tierId);
  // a 刻意**不**登记为代理：三级规则配着，但这一级没人拿钱。

  const no = await payPlan(buyer);
  const order = await prisma.paymentOrder.findUniqueOrThrow({ where: { outTradeNo: no } });
  const rows = await entriesOf(no);
  assert.equal(rows.length, 2, `只该有一级与二级两行，实际 ${JSON.stringify(rows.map((r) => ({ level: r.level, amount: r.amount })))}`);

  const lv1 = rows.find((r) => r.level === 1)!;
  assert.equal(lv1.beneficiaryUserId, c);
  assert.equal(lv1.distributorId, dc.id);
  assert.equal(lv1.rateBp, 1000, '同层级有精确 plan 规则时必须取它，不能落到 all 的 500');
  assert.equal(lv1.amount, Math.floor((order.amount * 1000) / 10000));
  assert.equal(lv1.baseAmount, order.amount, '计提基数 = 订单实付');
  assert.equal(lv1.itemType, 'plan');
  assert.equal(lv1.status, 'pending');
  assert.equal(lv1.kind, 'accrual');
  assert.equal(lv1.tenantId, order.tenantId);
  assert.equal(lv1.orderId, order.id);
  const snap = lv1.ruleSnapshotJson as { tierName?: string; rateBp?: number; holdDays?: number };
  assert.equal(snap.tierName, '金牌', '规则快照要带等级名：运营改规则，历史行不许漂');
  assert.equal(snap.rateBp, 1000);
  assert.equal(snap.holdDays, 7);

  const lv2 = rows.find((r) => r.level === 2)!;
  assert.equal(lv2.beneficiaryUserId, b);
  assert.equal(lv2.distributorId, db.id);
  assert.equal(lv2.rateBp, 300, '二级拿的是二级的比例，不因为三级空缺而升格');
  assert.equal(lv2.amount, Math.floor((order.amount * 300) / 10000));

  assert.equal(await prisma.commissionEntry.count({ where: { beneficiaryUserId: a } }), 0, '非代理祖先一分都不该有');

  // 同一条链上的 SKU 单：一级没有精确 'sku' 规则 → 回落 'all' 的 500bp。
  const skuNo = await paySku(buyer);
  const skuOrder = await prisma.paymentOrder.findUniqueOrThrow({ where: { outTradeNo: skuNo } });
  const skuRows = await entriesOf(skuNo);
  const skuLv1 = skuRows.find((r) => r.level === 1)!;
  assert.equal(skuLv1.itemType, 'sku');
  assert.equal(skuLv1.itemKey, 'deep-contradiction');
  assert.equal(skuLv1.rateBp, 500, "没有精确 'sku' 规则时才回落 'all'");
  assert.equal(skuLv1.amount, Math.floor((skuOrder.amount * 500) / 10000));
});

test('suspended 代理不计提，且解除暂停也不会补算（暂停 ≠ 延后）', async () => {
  await openFlags();
  const { c, buyer } = await chain();
  const tierId = await makeTier('金牌', [{ level: 1, itemType: 'all', rateBp: 1000 }]);
  const d = await makeDistributor(c, tierId);

  const patched = await api<AdminDistributorItem>('PATCH', `/api/admin/distribution/distributors/${d.id}`, { body: { status: 'suspended' } });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.status, 'suspended');
  assert.ok(patched.body.suspendedAt, '状态机要落时间戳');

  const no = await payPlan(buyer);
  assert.equal((await entriesOf(no)).length, 0, 'suspended 期间成交不计提');

  // 解除暂停 → 只影响此后的订单；刚才那笔永久没有佣金（否则运营一解除就冒出一批意外负债）。
  const back = await api('PATCH', `/api/admin/distribution/distributors/${d.id}`, { body: { status: 'active' } });
  assert.equal(back.status, 200);
  await scanCommissionOutbox();
  assert.equal((await entriesOf(no)).length, 0, '解除暂停不得补算历史订单');

  const no2 = await payPlan(buyer);
  assert.equal((await entriesOf(no2)).length, 1, '恢复 active 后的新订单照常计提');
});

test('terminated 是终态：档案只读，且此后成交不计提', async () => {
  await openFlags();
  const { c, buyer } = await chain();
  const tierId = await makeTier('金牌', [{ level: 1, itemType: 'all', rateBp: 1000 }]);
  const d = await makeDistributor(c, tierId);
  assert.equal((await api('PATCH', `/api/admin/distribution/distributors/${d.id}`, { body: { status: 'terminated' } })).status, 200);

  const again = await api('PATCH', `/api/admin/distribution/distributors/${d.id}`, { body: { displayName: '改个名' } });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.code, 'DISTRIBUTOR_TERMINATED');
  assert.equal((await entriesOf(await payPlan(buyer))).length, 0);
});

test('幂等：outbox 重复处理 / scheduler 续扫 / 重复支付回调都只计一次', async () => {
  await openFlags();
  const { c, buyer } = await chain();
  const tierId = await makeTier('金牌', [{ level: 1, itemType: 'all', rateBp: 1000 }]);
  await makeDistributor(c, tierId);
  const no = await payPlan(buyer);
  assert.equal((await entriesOf(no)).length, 1);

  // ① 直接再处理一遍（把 outbox 行强行放回未完成态，模拟租约过期后的重试）。
  await prisma.commissionOutbox.update({
    where: { outTradeNo_kind: { outTradeNo: no, kind: 'paid' } },
    data: { completedAt: null, nextAttemptAt: new Date(Date.now() - 1000) },
  });
  const again = await processCommissionOutbox(no, 'paid');
  assert.equal(again, 'accrued');
  assert.equal((await entriesOf(no)).length, 1, '唯一键必须兜住重复计提');

  // ② scheduler 续扫（此刻已完成，应该一条都不扫到）。
  const swept = await scanCommissionOutbox();
  assert.equal(swept.scanned, 0, '已完成的行不该被反复扫回来');

  // ③ 重复支付回调（already_applied 分支也会补建 outbox 并派发）。
  const dup = await api('POST', '/api/pay/mock/pay', { token: buyer, body: { outTradeNo: no } });
  assert.equal(dup.status, 200, JSON.stringify(dup.body));
  await settleCommissions();
  assert.equal((await entriesOf(no)).length, 1, '重复回调不得重复计提');
});

/* ── 冻结期 ─────────────────────────────────────────────────────────────── */

test('冻结期走运营配置：holdUntil = 支付时刻 + days；未到期不成熟，到期才 confirmed', async () => {
  await openFlags(3);
  const { c, buyer } = await chain();
  const tierId = await makeTier('金牌', [{ level: 1, itemType: 'all', rateBp: 1000 }]);
  await makeDistributor(c, tierId);
  const no = await payPlan(buyer);
  const order = await prisma.paymentOrder.findUniqueOrThrow({ where: { outTradeNo: no } });
  const row = (await entriesOf(no))[0];
  assert.equal(row.status, 'pending');
  assert.equal(
    row.holdUntil.getTime(), order.paidAt!.getTime() + 3 * 86_400_000,
    '冻结期从支付时刻起算（outbox 退避重试过的单不该因此多冻几天）',
  );

  assert.equal(await confirmMatured(), 0, '未到期的行不许成熟');
  assert.equal((await prisma.commissionEntry.findUniqueOrThrow({ where: { id: row.id } })).status, 'pending');

  // 时间到（等价于三天后）。
  await prisma.commissionEntry.update({ where: { id: row.id }, data: { holdUntil: new Date(Date.now() - 1000) } });
  assert.equal(await confirmMatured(), 1);
  assert.equal((await prisma.commissionEntry.findUniqueOrThrow({ where: { id: row.id } })).status, 'confirmed');
});

test('已退款订单的 pending 行不会成熟（成熟是「钱能被结出去」的最后一道门）', async () => {
  await openFlags(30);
  const { c, buyer } = await chain();
  const tierId = await makeTier('金牌', [{ level: 1, itemType: 'all', rateBp: 1000 }]);
  await makeDistributor(c, tierId);
  const no = await payPlan(buyer);
  const row = (await entriesOf(no))[0];

  // 只把订单置退款、刻意不跑冲销（模拟退款 outbox 卡住），再把冻结期推到过去。
  await prisma.paymentOrder.update({ where: { outTradeNo: no }, data: { status: 'refunded', refundedAt: new Date() } });
  await prisma.commissionEntry.update({ where: { id: row.id }, data: { holdUntil: new Date(Date.now() - 1000) } });
  assert.equal(await confirmMatured(), 0, '订单已退款 → 那笔佣金绝不能成熟成可结算');
});

/* ── 退款 ───────────────────────────────────────────────────────────────── */

test('结算前退款 → 原行 reversed，并把它挂着的草稿单金额重算', async () => {
  await openFlags(0); // 0 天冻结期：本例要的是「已 confirmed 并进了草稿单」这个状态
  const { b, c, buyer } = await chain();
  const tierId = await makeTier('金牌', [
    { level: 1, itemType: 'all', rateBp: 1000 },
    { level: 2, itemType: 'all', rateBp: 300 },
  ]);
  const dc = await makeDistributor(c, tierId);
  await makeDistributor(b, tierId);
  const no = await payPlan(buyer);
  assert.equal(await confirmMatured(), 2, '冻结期 0 天 → 立刻可成熟');

  const gen = await api<AdminSettlementGenerateResult>('POST', '/api/admin/distribution/settlements/generate', {
    body: { distributorId: dc.id, periodStart: new Date(Date.now() - 86_400_000).toISOString(), periodEnd: new Date(Date.now() + 86_400_000).toISOString() },
  });
  assert.equal(gen.status, 200, JSON.stringify(gen.body));
  const draft = gen.body.created[0];
  assert.ok(draft, '应生成一张草稿单');
  assert.equal(draft.entryCount, 1);
  assert.ok(draft.totalAmount > 0);

  const refund = await refundWechatOrder(no, { reason: '测试期误发放，撤回', by: 'qa' });
  assert.equal(refund.ok, true);
  await settleCommissions();

  const rows = await entriesOf(no);
  assert.equal(rows.length, 2, '冲销不追加行，只改原行状态');
  for (const r of rows) {
    assert.equal(r.status, 'reversed', `结算前退款必须冲销原行，实际 ${r.status}`);
    assert.ok(r.reversedAt, 'reversedAt 要落地');
    assert.equal(r.settlementId, null, '冲销的同时必须从结算单上解绑');
  }
  const after = await prisma.commissionSettlement.findUniqueOrThrow({ where: { id: draft.id } });
  assert.equal(after.entryCount, 0, '解绑后那张草稿单必须重算——否则运营会拿着一个不成立的金额去打款');
  assert.equal(after.totalAmount, 0);
});

test('已结算后退款 → 另落一条负额 clawback，绝不改写已打款的那行', async () => {
  await openFlags(0);
  const { c, buyer } = await chain();
  const tierId = await makeTier('金牌', [{ level: 1, itemType: 'all', rateBp: 1000 }]);
  const dc = await makeDistributor(c, tierId);
  const no = await payPlan(buyer);
  await confirmMatured();

  const gen = await api<AdminSettlementGenerateResult>('POST', '/api/admin/distribution/settlements/generate', {
    body: { distributorId: dc.id, periodStart: new Date(Date.now() - 86_400_000).toISOString(), periodEnd: new Date(Date.now() + 86_400_000).toISOString() },
  });
  const st = gen.body.created[0];
  assert.equal((await api('POST', `/api/admin/distribution/settlements/${st.id}/approve`)).status, 200);
  const paid = await api<AdminSettlement>('POST', `/api/admin/distribution/settlements/${st.id}/paid`, { body: { paidRef: 'BANK-20260902-001' } });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  const accrual = (await entriesOf(no)).find((r) => r.kind === 'accrual')!;
  assert.equal(accrual.status, 'settled', '打款同事务把 confirmed 推成 settled');

  await refundWechatOrder(no, { reason: '客户退款', by: 'qa' });
  await settleCommissions();

  const rows = await entriesOf(no);
  assert.equal(rows.length, 2, '应是「原 accrual + 一条 clawback」两行');
  const kept = rows.find((r) => r.kind === 'accrual')!;
  assert.equal(kept.status, 'settled', '已打款那行一个字都不许改');
  assert.equal(kept.settlementId, st.id);
  const claw = rows.find((r) => r.kind === 'clawback')!;
  assert.equal(claw.amount, -accrual.amount, '追回额 = 原额的负数');
  assert.equal(claw.status, 'confirmed', '追回行直接可结算（进下一张单做净额抵扣）');
  assert.equal(claw.settlementId, null);
  assert.equal(claw.level, accrual.level);
  assert.equal(claw.beneficiaryUserId, accrual.beneficiaryUserId);

  // 幂等：再处理一遍退款 outbox 不许多出第二条 clawback。
  await prisma.commissionOutbox.update({
    where: { outTradeNo_kind: { outTradeNo: no, kind: 'refunded' } },
    data: { completedAt: null, nextAttemptAt: new Date(Date.now() - 1000) },
  });
  assert.equal(await processCommissionOutbox(no, 'refunded'), 'reversed');
  assert.equal((await entriesOf(no)).length, 2, '唯一键必须兜住重复追回');

  // 下一张单纳入这条负额：净额为负也要出单（那正是「上期多结了、这期抵扣」的凭据）。
  const next = await api<AdminSettlementGenerateResult>('POST', '/api/admin/distribution/settlements/generate', {
    body: { distributorId: dc.id, periodStart: new Date(Date.now() - 86_400_000).toISOString(), periodEnd: new Date(Date.now() + 86_400_000).toISOString() },
  });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.equal(next.body.created.length, 1);
  assert.equal(next.body.created[0].totalAmount, -accrual.amount);
  assert.equal(next.body.created[0].entryCount, 1);
});

/* ── 结算单生命周期 ─────────────────────────────────────────────────────── */

describe('结算单：generate → approve → paid / void', () => {
  test('全生命周期与流水状态联动；paid 缺 paidRef 400；作废后行放回待结池', async () => {
    await openFlags(0);
    const { c, buyer } = await chain();
    const tierId = await makeTier('金牌', [{ level: 1, itemType: 'all', rateBp: 1000 }]);
    const dc = await makeDistributor(c, tierId);
    const no = await payPlan(buyer);
    await confirmMatured();

    const period = { periodStart: new Date(Date.now() - 86_400_000).toISOString(), periodEnd: new Date(Date.now() + 86_400_000).toISOString() };

    // 周期不合法一律 400（结束早于开始是运营手滑的高频形态）。
    const bad = await api('POST', '/api/admin/distribution/settlements/generate', { body: { periodStart: period.periodEnd, periodEnd: period.periodStart } });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.code, 'PERIOD_INVALID');

    const gen = await api<AdminSettlementGenerateResult>('POST', '/api/admin/distribution/settlements/generate', { body: period });
    assert.equal(gen.status, 200, JSON.stringify(gen.body));
    assert.equal(gen.body.created.length, 1, '缺省 distributorId → 全部 active/suspended 代理各出一张（零行的不出）');
    const st = gen.body.created[0];
    assert.equal(st.status, 'draft');
    assert.equal(st.distributor.id, dc.id);
    assert.equal(st.entryCount, 1);

    // 再生成一次：行已挂单，没有新的可纳入 → 零行不生成。
    const zero = await api<AdminSettlementGenerateResult>('POST', '/api/admin/distribution/settlements/generate', { body: period });
    assert.equal(zero.body.created.length, 0, '零行不生成（不留空单让运营去猜）');
    assert.ok(zero.body.skippedDistributors >= 1);

    // draft 不能直接打款。
    const early = await api('POST', `/api/admin/distribution/settlements/${st.id}/paid`, { body: { paidRef: 'X' } });
    assert.equal(early.status, 409, JSON.stringify(early.body));
    assert.equal(early.body.code, 'SETTLEMENT_STATUS_INVALID');

    const approved = await api<AdminSettlement>('POST', `/api/admin/distribution/settlements/${st.id}/approve`);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, 'approved');
    assert.ok(approved.body.approvedBy, '核准要记操作者');
    assert.equal((await entriesOf(no))[0].status, 'confirmed', '核准只是「金额我看过了」，不碰流水状态');

    // 重复核准 409。
    assert.equal((await api('POST', `/api/admin/distribution/settlements/${st.id}/approve`)).status, 409);

    // paidRef 必填：没有凭证号的「已打款」事后无从对账。
    const noRef = await api('POST', `/api/admin/distribution/settlements/${st.id}/paid`, { body: { note: '忘了填' } });
    assert.equal(noRef.status, 400, JSON.stringify(noRef.body));
    assert.equal(noRef.body.code, 'PAID_REF_REQUIRED');
    assert.equal((await prisma.commissionSettlement.findUniqueOrThrow({ where: { id: st.id } })).status, 'approved', '被拒的写不留痕');

    const paid = await api<AdminSettlement>('POST', `/api/admin/distribution/settlements/${st.id}/paid`, { body: { paidRef: 'BANK-001', note: '对公转账' } });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.status, 'paid');
    assert.equal(paid.body.paidRef, 'BANK-001');
    assert.ok(paid.body.paidBy && paid.body.paidAt);
    assert.equal((await entriesOf(no))[0].status, 'settled', '打款同事务把关联行推成已结算');

    // 已打款不可作废：钱出去了要走追回，不是把凭据抹掉。
    const v = await api('POST', `/api/admin/distribution/settlements/${st.id}/void`, { body: { reason: '想撤回' } });
    assert.equal(v.status, 409, JSON.stringify(v.body));
  });

  test('作废（draft）：行解绑放回待结池，单上原金额保留作凭据；reason 必填', async () => {
    await openFlags(0);
    const { c, buyer } = await chain();
    const tierId = await makeTier('金牌', [{ level: 1, itemType: 'all', rateBp: 1000 }]);
    const dc = await makeDistributor(c, tierId);
    const no = await payPlan(buyer);
    await confirmMatured();
    const period = { distributorId: dc.id, periodStart: new Date(Date.now() - 86_400_000).toISOString(), periodEnd: new Date(Date.now() + 86_400_000).toISOString() };
    const st = (await api<AdminSettlementGenerateResult>('POST', '/api/admin/distribution/settlements/generate', { body: period })).body.created[0];

    const noReason = await api('POST', `/api/admin/distribution/settlements/${st.id}/void`, { body: {} });
    assert.equal(noReason.status, 400, JSON.stringify(noReason.body));
    assert.equal(noReason.body.code, 'VOID_REASON_REQUIRED');

    const voided = await api<AdminSettlement>('POST', `/api/admin/distribution/settlements/${st.id}/void`, { body: { reason: '周期选错了' } });
    assert.equal(voided.status, 200, JSON.stringify(voided.body));
    assert.equal(voided.body.status, 'void');
    assert.equal(voided.body.entryCount, st.entryCount, '作废单保留原条数：它是「当初包含了什么」的凭据');
    assert.equal(voided.body.totalAmount, st.totalAmount);
    assert.match(voided.body.note ?? '', /周期选错了/, '作废原因要留在单上');

    const row = (await entriesOf(no))[0];
    assert.equal(row.settlementId, null, '作废即解绑');
    assert.equal(row.status, 'confirmed', '解绑后仍是可结算，回到待结池');

    // 放回池子后能被下一张单再纳入。
    const again = await api<AdminSettlementGenerateResult>('POST', '/api/admin/distribution/settlements/generate', { body: period });
    assert.equal(again.body.created.length, 1);
    assert.equal(again.body.created[0].entryCount, 1);
  });
});

/* ── 等级目录与规则校验 ─────────────────────────────────────────────────── */

test('等级目录：同名 409、有代理挂靠时 DELETE 409、规则校验与整体替换', async () => {
  const t1 = await api<AdminDistributorTier>('POST', '/api/admin/distribution/tiers', { body: { name: '金牌', sort: 1, note: '核心渠道' } });
  assert.equal(t1.status, 201, JSON.stringify(t1.body));
  assert.equal((await api('POST', '/api/admin/distribution/tiers', { body: { name: '金牌' } })).status, 409);
  assert.equal((await api('POST', '/api/admin/distribution/tiers', { body: { name: '  ' } })).status, 400);

  const id = t1.body.id;
  // PATCH 同样回完整对象（改完名字/排序，前端就地替换那一行）。
  const renamed = await api<AdminDistributorTier>('PATCH', `/api/admin/distribution/tiers/${id}`, { body: { sort: 5, note: '改过的备注' } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.id, id, 'PATCH 要回这张等级本身，不是 {ok:true}');
  assert.equal(renamed.body.sort, 5);
  assert.equal(renamed.body.note, '改过的备注');
  assert.deepEqual(renamed.body.rules, [], '还没配规则时回空数组，字段不许缺');
  assert.equal(renamed.body.distributorCount, 0);

  for (const bad of [
    { rules: [{ level: 4, itemType: 'all', rateBp: 100, enabled: true }] },
    { rules: [{ level: 1, itemType: 'agent', rateBp: 100, enabled: true }] },
    { rules: [{ level: 1, itemType: 'all', rateBp: 10001, enabled: true }] },
    { rules: [{ level: 1, itemType: 'all', rateBp: -1, enabled: true }] },
    { rules: [{ level: 1, itemType: 'all', rateBp: 1, enabled: true }, { level: 1, itemType: 'all', rateBp: 2, enabled: true }] },
    { rules: 'nope' },
  ]) {
    const r = await api('PUT', `/api/admin/distribution/tiers/${id}/rules`, { body: bad });
    assert.equal(r.status, 400, `非法规则应 400：${JSON.stringify(bad)} → ${r.status} ${JSON.stringify(r.body)}`);
  }
  assert.equal(await prisma.distributionRule.count(), 0, '被拒的整体替换不得留下半套规则');

  const saved = await api<AdminDistributorTier>('PUT', `/api/admin/distribution/tiers/${id}/rules`, {
    body: { rules: [{ level: 1, itemType: 'plan', rateBp: 800, enabled: true }, { level: 2, itemType: 'all', rateBp: 200, enabled: false }] },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const listed = await api<AdminDistributorTier[]>('GET', '/api/admin/distribution/tiers');
  assert.equal(listed.status, 200);
  assert.equal(listed.body[0].rules.length, 2);
  assert.equal(listed.body[0].distributorCount, 0);
  // 写端点的回值必须与 GET 的那一项逐字相同（成形只有一处，不许两边各拼一遍）。
  assert.deepEqual(saved.body, listed.body[0], 'PUT rules 的回值应与 GET /tiers 里的同一项一致');
  assert.equal(saved.body.rules.find((r) => r.level === 2)!.enabled, false, 'enabled=false 的格子也要如实回');

  // 整体替换 = 不在列表里的组合视为删除。
  assert.equal((await api('PUT', `/api/admin/distribution/tiers/${id}/rules`, {
    body: { rules: [{ level: 3, itemType: 'sku', rateBp: 50, enabled: true }] },
  })).status, 200);
  const after = await api<AdminDistributorTier[]>('GET', '/api/admin/distribution/tiers');
  assert.deepEqual(after.body[0].rules.map((r) => `${r.level}:${r.itemType}`), ['3:sku']);

  // 挂了代理就不许删（否则那位代理静默失去全部比例 = 悄悄停发）。
  const uid = await register();
  const d = await makeDistributor(uid, id);
  const del = await api('DELETE', `/api/admin/distribution/tiers/${id}`);
  assert.equal(del.status, 409, JSON.stringify(del.body));
  assert.equal(del.body.code, 'TIER_IN_USE');
  assert.equal((await api<AdminDistributorTier[]>('GET', '/api/admin/distribution/tiers')).body[0].distributorCount, 1);

  assert.equal((await api('PATCH', `/api/admin/distribution/distributors/${d.id}`, { body: { tierId: null } })).status, 200);
  assert.equal((await api('DELETE', `/api/admin/distribution/tiers/${id}`)).status, 200);
  assert.equal(await prisma.distributionRule.count(), 0, '删等级应级联删掉它的规则');
});

test('登记代理：用户不存在 404、重复登记 409、响应手机号一律掩码', async () => {
  assert.equal((await api('POST', '/api/admin/distribution/distributors', { body: { userId: 'u_not_exist' } })).status, 404);
  assert.equal((await api('POST', '/api/admin/distribution/distributors', { body: {} })).status, 400);
  const uid = await register();
  const created = await api<AdminDistributorItem>('POST', '/api/admin/distribution/distributors', {
    body: { userId: uid, displayName: '某某传媒', contactPhone: '13812341234', remark: '线下签约' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.status, 'active', '运营登记即生效（pending 那档本期没有入口）');
  assert.equal(created.body.contactPhone, '138****1234', '联系手机必须掩码下发');
  assert.ok(created.body.user.phone && !/^1\d{10}$/.test(created.body.user.phone), '账号手机同样不许下发完整号码');
  assert.ok(created.body.approvedBy, '登记要记操作者');
  assert.equal(
    (await prisma.distributor.findUniqueOrThrow({ where: { userId: uid } })).contactPhone, '13812341234',
    '库里存明文（运营要能打通），只有响应掩码',
  );
  assert.equal((await api('POST', '/api/admin/distribution/distributors', { body: { userId: uid } })).status, 409);
});

/* ── 读投影 ─────────────────────────────────────────────────────────────── */

test('名册 / 流水 / 结算单：分页壳、pageSize 夹 1..200、汇总与明细同源', async () => {
  await openFlags(0);
  const { b, c, buyer } = await chain();
  const tierId = await makeTier('金牌', [
    { level: 1, itemType: 'all', rateBp: 1000 },
    { level: 2, itemType: 'all', rateBp: 300 },
  ]);
  const dc = await makeDistributor(c, tierId);
  await makeDistributor(b, tierId);
  await payPlan(buyer);

  const roster = await api<AdminDistributorList>('GET', '/api/admin/distribution/distributors?pageSize=999');
  assert.equal(roster.status, 200, JSON.stringify(roster.body));
  assert.equal(roster.body.total, 2);
  assert.equal(roster.body.page, 1);
  assert.equal(roster.body.pageSize, 200, 'pageSize 必须夹到 200');
  const mine = roster.body.items.find((i) => i.id === dc.id)!;
  assert.deepEqual(mine.team, { lv1: 1, lv2: 0, lv3: 0 }, 'c 的直邀只有 buyer');
  assert.ok(mine.commission.accrued > 0);
  assert.equal(mine.commission.pending, mine.commission.accrued, '冻结/可结都算待结');
  assert.equal(mine.commission.settled, 0);

  const filtered = await api<AdminDistributorList>('GET', `/api/admin/distribution/distributors?tierId=${tierId}&status=active`);
  assert.equal(filtered.body.total, 2);
  assert.equal((await api<AdminDistributorList>('GET', '/api/admin/distribution/distributors?status=terminated')).body.total, 0);
  assert.equal((await api<AdminDistributorList>('GET', '/api/admin/distribution/distributors?q=某某不存在的名字')).body.total, 0);

  const flow = await api<AdminCommissionList>('GET', '/api/admin/distribution/commissions?days=30');
  assert.equal(flow.status, 200, JSON.stringify(flow.body));
  assert.equal(flow.body.total, 2);
  assert.equal(flow.body.items.length, 2);
  assert.ok(flow.body.items[0].buyer.userId === buyer);
  assert.ok(flow.body.items[0].buyer.phone && !/^1\d{10}$/.test(flow.body.items[0].buyer.phone), '流水里的手机号也要掩码');
  const summaryTotal = flow.body.summary.reduce((a, s) => a + s.count, 0);
  assert.equal(summaryTotal, flow.body.total, '汇总与明细必须吃同一个筛选条件');
  assert.ok(flow.body.daily.length >= 1);
  assert.match(flow.body.daily[0].date, /^\d{4}-\d{2}-\d{2}$/);

  const byDistributor = await api<AdminCommissionList>('GET', `/api/admin/distribution/commissions?distributorId=${dc.id}`);
  assert.equal(byDistributor.body.total, 1);

  const detail = await api<AdminDistributorDetail>('GET', `/api/admin/distribution/distributors/${dc.id}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.distributor.id, dc.id);
  assert.equal(detail.body.team.length, 3);
  assert.equal(detail.body.team[0].users, 1);
  assert.ok((detail.body.team[0].paidGmv ?? 0) > 0, '一级团队的已支付 GMV 要算进来');
  assert.ok(detail.body.team[0].commission !== null, '本人是代理 → 各级佣金合计不是 null');
  assert.equal(detail.body.recentCommissions.length, 1);
  assert.equal((await api('GET', '/api/admin/distribution/distributors/u_not_exist')).status, 404);

  const settlements = await api<AdminSettlementList>('GET', '/api/admin/distribution/settlements');
  assert.equal(settlements.status, 200);
  assert.deepEqual({ total: settlements.body.total, page: settlements.body.page }, { total: 0, page: 1 });
});

/* ── 审计 ───────────────────────────────────────────────────────────────── */

test('每个写动作都有审计行（action 前缀 admin.distribution.*，payload 带 by 与 before/after）', async () => {
  await openFlags(0);
  const { c, buyer } = await chain();
  const tierId = await makeTier('金牌', [{ level: 1, itemType: 'all', rateBp: 1000 }]);
  const d = await makeDistributor(c, tierId);
  await api('PATCH', `/api/admin/distribution/distributors/${d.id}`, { body: { remark: '改个备注' } });
  await api('PATCH', `/api/admin/distribution/tiers/${tierId}`, { body: { sort: 9 } });
  await payPlan(buyer);
  await confirmMatured();
  const period = { periodStart: new Date(Date.now() - 86_400_000).toISOString(), periodEnd: new Date(Date.now() + 86_400_000).toISOString() };
  const st = (await api<AdminSettlementGenerateResult>('POST', '/api/admin/distribution/settlements/generate', { body: period })).body.created[0];
  await api('POST', `/api/admin/distribution/settlements/${st.id}/approve`);
  await api('POST', `/api/admin/distribution/settlements/${st.id}/paid`, { body: { paidRef: 'BANK-777' } });

  for (const action of [
    'admin.distribution.tier.create',
    'admin.distribution.tier.update',
    'admin.distribution.rules.replace',
    'admin.distribution.distributor.create',
    'admin.distribution.distributor.update',
    'admin.distribution.settlement.generate',
    'admin.distribution.settlement.approve',
    'admin.distribution.settlement.paid',
  ]) {
    const row = await prisma.auditLog.findFirst({ where: { action }, orderBy: { createdAt: 'desc' } });
    assert.ok(row, `缺审计行：${action}`);
    const payload = row!.payloadJson as { by?: string };
    assert.ok(payload?.by, `${action} 的审计要带操作者 by`);
  }
  const created = await prisma.auditLog.findFirstOrThrow({ where: { action: 'admin.distribution.distributor.create' } });
  const payload = created.payloadJson as { after?: { contactPhone?: string | null } };
  assert.ok(
    !payload.after?.contactPhone || !/^1\d{10}$/.test(payload.after.contactPhone),
    '审计 payload 里的手机号同样掩码（与响应同一把规则）',
  );
});
