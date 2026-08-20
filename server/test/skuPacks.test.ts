// 单次购买增购包（SKU kind=credits 钻石 / quota 算力）：发放、pack-in-balance 三个同步点保值、
// 退款回收、运营自建档位守卫、下单快照优先。不触网：直接调 markPaidAndApply / refundWechatOrder（mock 单）。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { buildOrderSnapshot, markPaidAndApply, refundWechatOrder } from '../src/services/wechatPay.js';
import { applyPlanPurchase } from '../src/services/purchase.js';
import { getQuotaState, setQuota, chargeQuota } from '../src/services/tokenQuota.js';
import { getBalance } from '../src/services/credits.js';
import { usageView } from '../src/services/planRules.js';
import { periodKeyOf } from '../src/services/planTime.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

let userId = '', tenantId = '';

before(async () => { await getApp(); });
after(async () => { await closeApp(); });

beforeEach(async () => {
  await cleanBusiness();
  await seedBaseline();
  userId = await login(uniquePhone(), '增购包用户');
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  tenantId = u.tenantId;
});

/** 运营自建档位（不进 seedConfig）：kind=credits|quota，数量在 metaJson.amount。 */
async function makePack(kind: 'credits' | 'quota', amount: number, priceFen = 9900, name = `${kind} 包 ${amount}`) {
  return prisma.sku.create({ data: { key: `pack-${kind}-${amount}-${Date.now()}`, name, desc: '测试增购包', priceFen, kind, metaJson: { amount }, sort: 99 } });
}

/** 建一笔已下单待回调的 SKU 订单（默认带 buildOrderSnapshot 快照 + mock 标记，便于本地退款）。 */
async function makeOrder(outTradeNo: string, skuKey: string, opts: { snapshot?: boolean } = {}) {
  const sku = await prisma.sku.findUniqueOrThrow({ where: { key: skuKey } });
  const base = opts.snapshot === false ? null : await buildOrderSnapshot({ skuKey });
  const snapshotJson = base ? { ...(base as object), mock: true } : { kind: 'sku', mock: true };
  return prisma.paymentOrder.create({
    data: {
      outTradeNo, tenantId, userId, planId: '', skuKey, amount: sku.priceFen,
      provider: 'wechat', status: 'created', snapshotJson: snapshotJson as object,
    },
  });
}

/** 直接摆钱包状态（绕开惰性重置，构造「同步点之前」的既有事实）。 */
async function setWallet(row: { quota: number; balance: number; packBalance: number; periodKey: string }) {
  await prisma.tokenWallet.upsert({
    where: { userId },
    update: { ...row, tenantId },
    create: { ...row, tenantId, userId },
  });
}

const wallet = () => prisma.tokenWallet.findUniqueOrThrow({ where: { userId } });
const naturalPk = () => periodKeyOf(null, new Date());

// ───────────────── 1. credits 包到账 ─────────────────

test('credits 包支付到账：合池进 CreditLedger、无重复备注行、entitlement.quantity=发放量', async () => {
  const before = await getBalance(userId);
  const sku = await makePack('credits', 50);
  const order = await makeOrder('ot_pack_credits', sku.key);
  const r = await markPaidAndApply({ outTradeNo: order.outTradeNo, tradeState: 'SUCCESS', rawJson: {}, amountTotal: sku.priceFen });
  assert.equal(r.applied, true);

  assert.equal(await getBalance(userId), before + 50, '钻石余额 +发放量');
  const rows = await prisma.creditLedger.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const packRows = rows.filter((l) => l.reason.includes(sku.name));
  assert.equal(packRows.length, 1, '本单只写一行流水（不再补 delta=0 备注行）');
  assert.equal(packRows[0].delta, 50);
  assert.equal(packRows[0].balance, before + 50);
  assert.equal(await prisma.creditLedger.count({ where: { userId, delta: 0 } }), 0, '不留 delta=0 备注行');

  const ent = await prisma.skuEntitlement.findUniqueOrThrow({ where: { sourceOrderId: order.id } });
  assert.equal(ent.kind, 'credits');
  assert.equal(ent.quantity, 50);
  assert.equal(ent.entitlementKey, `sku:${sku.key}`);
  assert.equal(await prisma.userModule.count({ where: { userId } }), 0, 'credits 包不建 UserModule');
});

test('钻石不限量用户：credits 包下单 409 CREDITS_UNLIMITED，quota 包下单不受影响', async () => {
  // 企业版不限量哨兵：最新流水 balance=-1（grantCredits 对不限量发放会把 -1 写成有限值 → 权益降级）。
  await prisma.creditLedger.create({ data: { tenantId, userId, delta: 0, reason: '企业版 · 不限量', balance: -1 } });
  const creditsSku = await makePack('credits', 50);
  const quotaSku = await makePack('quota', 50_000);
  // 下单口要过 payConfigured/沙箱/mock 三选一的门；用 PAY_MOCK_SUCCESS 走真实建单（不触网）。
  const saved = process.env.PAY_MOCK_SUCCESS;
  process.env.PAY_MOCK_SUCCESS = 'true';
  try {
    const blocked = await api('POST', `/api/skus/${creditsSku.key}/order`, { token: userId, body: {} });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'CREDITS_UNLIMITED');
    assert.equal(await prisma.paymentOrder.count({ where: { skuKey: creditsSku.key } }), 0, '不建单');

    const ok = await api('POST', `/api/skus/${quotaSku.key}/order`, { token: userId, body: {} });
    assert.equal(ok.status, 200, `算力包不受钻石不限量影响：${JSON.stringify(ok.body)}`);
    assert.equal(ok.body.mock, true);
    assert.equal(await prisma.paymentOrder.count({ where: { skuKey: quotaSku.key } }), 1);
  } finally {
    if (saved === undefined) delete process.env.PAY_MOCK_SUCCESS;
    else process.env.PAY_MOCK_SUCCESS = saved;
  }
});

test('入账兜底（下单后才变不限量的竞态）：credits 包不把 -1 降成有限余额', async () => {
  const sku = await makePack('credits', 50);
  const order = await makeOrder('ot_pack_credits_unlimited', sku.key);
  // 绕过下单守卫，直接让「不限量」在回调前成立
  await prisma.creditLedger.create({ data: { tenantId, userId, delta: 0, reason: '企业版 · 不限量', balance: -1 } });
  const rowsBefore = await prisma.creditLedger.count({ where: { userId } });

  assert.equal((await markPaidAndApply({ outTradeNo: order.outTradeNo, tradeState: 'SUCCESS', rawJson: {}, amountTotal: sku.priceFen })).applied, true);

  assert.equal(await getBalance(userId), -1, '不限量哨兵未被降级');
  const rows = await prisma.creditLedger.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  assert.equal(rows.length, rowsBefore + 1, '只多一条备注行');
  const note = rows[rows.length - 1];
  assert.equal(note.delta, 0, '跳过发放时保留 delta=0 备注行（订单流水页仍可见）');
  assert.equal(note.balance, -1);
  assert.ok(note.reason.includes(sku.name));

  const audit = await prisma.auditLog.findFirst({ where: { userId, action: 'user.sku.purchase' }, orderBy: { createdAt: 'desc' } });
  const payload = audit!.payloadJson as { skippedUnlimited?: boolean; amount?: number };
  assert.equal(payload.skippedUnlimited, true, '审计留痕供运营处置');
  assert.equal(payload.amount, 50);
  const ent = await prisma.skuEntitlement.findUniqueOrThrow({ where: { sourceOrderId: order.id } });
  assert.equal(ent.kind, 'credits');
  assert.equal(ent.quantity, 0, 'entitlement 照常写但记「实际发放量 0」（显式盖掉默认值 1）');
});

test('跳过发放的 credits 包退款：即使之后余额变回有限值也不追扣', async () => {
  const sku = await makePack('credits', 50);
  const order = await makeOrder('ot_pack_credits_skip_refund', sku.key);
  await prisma.creditLedger.create({ data: { tenantId, userId, delta: 0, reason: '企业版 · 不限量', balance: -1 } });
  assert.equal((await markPaidAndApply({ outTradeNo: order.outTradeNo, tradeState: 'SUCCESS', rawJson: {}, amountTotal: sku.priceFen })).applied, true);
  assert.equal((await prisma.skuEntitlement.findUniqueOrThrow({ where: { sourceOrderId: order.id } })).quantity, 0);

  // 之后用户被改回有限余额（换普通套餐等）——本单当初一颗都没发，退款不能顺手扣掉这 50 颗
  await prisma.creditLedger.create({ data: { tenantId, userId, delta: 100, reason: '入门版 · 月度权益', balance: 100 } });

  await refundWechatOrder(order.outTradeNo, { reason: '用户申请', by: 'owner' });
  assert.equal(await getBalance(userId), 100, '余额不被追扣（回收量取权益账本的实际发放量 0）');
  assert.equal(await prisma.creditLedger.count({ where: { userId, reason: { contains: '退款追回' } } }), 0, '不写追回流水');
  const ent = await prisma.skuEntitlement.findUniqueOrThrow({ where: { sourceOrderId: order.id } });
  assert.equal(ent.status, 'refunded');
  assert.ok(ent.refundedAt);
});

// ───────────────── 2. quota 包到账 ─────────────────

test('quota 包到账：balance 与 packBalance 同增', async () => {
  const st0 = await getQuotaState(userId); // 触发首建（套餐月度快照）
  const sku = await makePack('quota', 120_000);
  const order = await makeOrder('ot_pack_quota', sku.key);
  assert.equal((await markPaidAndApply({ outTradeNo: order.outTradeNo, tradeState: 'SUCCESS', rawJson: {}, amountTotal: sku.priceFen })).applied, true);

  const w = await wallet();
  assert.equal(w.quota, st0.quota, '月度额度不动');
  assert.equal(w.balance, st0.balance + 120_000);
  assert.equal(w.packBalance, 120_000);
  const st1 = await getQuotaState(userId);
  assert.equal(st1.packBalance, 120_000, '派生 packRemaining = 未消耗的存量');
  assert.equal(st1.used, st0.used, '增购包不算进本月已用');
  assert.equal(await prisma.userModule.count({ where: { userId } }), 0, 'quota 包不建 UserModule');
});

test('quota 包到账：钱包不存在时首建带套餐月度快照（有套餐用户买包不丢当月额度）', async () => {
  await prisma.tokenWallet.deleteMany({ where: { userId } });
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { plan: true } });
  const planQuota = u.plan!.tokenQuotaPerMonth;
  assert.ok(planQuota > 0);

  const sku = await makePack('quota', 60_000);
  const order = await makeOrder('ot_pack_quota_first', sku.key);
  assert.equal((await markPaidAndApply({ outTradeNo: order.outTradeNo, tradeState: 'SUCCESS', rawJson: {}, amountTotal: sku.priceFen })).applied, true);

  const w = await wallet();
  assert.equal(w.quota, planQuota, '首建 quota = 套餐月度额度，不是 0');
  assert.equal(w.balance, planQuota + 60_000);
  assert.equal(w.packBalance, 60_000);
  assert.equal(w.periodKey, periodKeyOf(u.planActivatedAt, new Date()), 'periodKey 按套餐锚点派生');
});

// ───────────────── 3. 跨周期重置 ─────────────────

test('吃进 pack 后跨周期重置：月度刷满、pack 只剩未吃部分', async () => {
  await prisma.user.update({ where: { id: userId }, data: { planActivatedAt: null, planExpiresAt: new Date(Date.now() + 30 * 864e5) } });
  await setWallet({ quota: 1000, balance: 1500, packBalance: 500, periodKey: naturalPk() });
  await chargeQuota(userId, 1200, 1); // 月度 1000 吃完，再吃 200 pack → balance=300
  assert.equal((await wallet()).balance, 300);

  await setWallet({ quota: 1000, balance: 300, packBalance: 500, periodKey: '1999-01' }); // 制造跨周期
  const st = await getQuotaState(userId);
  const w = await wallet();
  assert.equal(w.quota, 1000);
  assert.equal(w.packBalance, 300, 'pack 只保留未被吃掉的部分（clamp 口径）');
  assert.equal(w.balance, 1300, '月度刷满 + pack 剩余');
  assert.equal(st.used, 0, '新周期月度已用归零');
  assert.equal(st.packBalance, 300);
});

// ───────────────── 4. 套餐购买 / 续费不抹 pack ─────────────────

test('setQuota 硬覆盖（套餐购买/续费/升级）不抹 pack', async () => {
  await prisma.user.update({ where: { id: userId }, data: { planActivatedAt: null, planExpiresAt: new Date(Date.now() + 30 * 864e5) } });
  await setWallet({ quota: 1000, balance: 1500, packBalance: 500, periodKey: naturalPk() });
  await chargeQuota(userId, 1100, 1); // balance=400 → pack 剩 400

  await setQuota(tenantId, userId, 2000);
  const w = await wallet();
  assert.equal(w.quota, 2000);
  assert.equal(w.packBalance, 400);
  assert.equal(w.balance, 2400, '新月度额度 + pack 剩余');
});

test('applyPlanPurchase（走 setQuota）不抹 pack', async () => {
  const plan = await prisma.plan.findFirstOrThrow({ where: { planFamilyKey: 'decision', period: 'month' } });
  await prisma.user.update({ where: { id: userId }, data: { planActivatedAt: null, planExpiresAt: new Date(Date.now() + 30 * 864e5) } });
  await setWallet({ quota: 1000, balance: 1300, packBalance: 300, periodKey: naturalPk() });

  await applyPlanPurchase({ id: userId, tenantId }, plan, { reason: '决策版 · 测试购买', source: 'demo_purchase' });
  const w = await wallet();
  assert.equal(w.quota, plan.tokenQuotaPerMonth);
  assert.equal(w.packBalance, 300);
  assert.equal(w.balance, plan.tokenQuotaPerMonth + 300);
});

// ───────────────── 5. 过期冻结保 pack ─────────────────

test('过期冻结：月度归 0 但 pack 保值；续费后 balance = 新额度 + pack', async () => {
  // 先在有效期内消耗（吃完月度 1000 + 200 pack），再让套餐过期 → 冻结时 pack 剩 300。
  await prisma.user.update({ where: { id: userId }, data: { planActivatedAt: null, planExpiresAt: new Date(Date.now() + 864e5) } });
  await setWallet({ quota: 1000, balance: 1400, packBalance: 500, periodKey: naturalPk() });
  await chargeQuota(userId, 1100, 1); // balance=300 → pack 剩 300
  await prisma.user.update({ where: { id: userId }, data: { planExpiresAt: new Date(Date.now() - 864e5) } });

  const st = await getQuotaState(userId);
  const frozen = await wallet();
  assert.equal(frozen.quota, 0, '月度额度冻结到 0');
  assert.equal(frozen.balance, 300, '余额只留 pack（买来的算力不因到期蒸发）');
  assert.equal(frozen.packBalance, 300);
  assert.equal(st.packBalance, 300);
  assert.equal(st.used, 0);
  // 幂等：再读一次不再变化
  await getQuotaState(userId);
  const again = await wallet();
  assert.deepEqual([again.quota, again.balance, again.packBalance], [0, 300, 300]);

  // 续费
  await prisma.user.update({ where: { id: userId }, data: { planExpiresAt: new Date(Date.now() + 30 * 864e5) } });
  await setQuota(tenantId, userId, 2000);
  const renewed = await wallet();
  assert.equal(renewed.balance, 2300);
  assert.equal(renewed.packBalance, 300);
});

test('过期 + 跨周期：quota 归 0、balance 只留 pack', async () => {
  await prisma.user.update({ where: { id: userId }, data: { planActivatedAt: null, planExpiresAt: new Date(Date.now() - 864e5) } });
  await setWallet({ quota: 1000, balance: 1200, packBalance: 400, periodKey: '1999-01' });
  await getQuotaState(userId);
  const w = await wallet();
  assert.equal(w.quota, 0);
  assert.equal(w.packBalance, 400);
  assert.equal(w.balance, 400);
});

// ───────────────── 6. 退款回收 ─────────────────

test('退款：quota 包已部分消耗 → 只追回剩余', async () => {
  await prisma.user.update({ where: { id: userId }, data: { planActivatedAt: null, planExpiresAt: new Date(Date.now() + 30 * 864e5) } });
  await setWallet({ quota: 1000, balance: 1000, packBalance: 0, periodKey: naturalPk() });
  const sku = await makePack('quota', 1000);
  const order = await makeOrder('ot_pack_quota_refund', sku.key);
  assert.equal((await markPaidAndApply({ outTradeNo: order.outTradeNo, tradeState: 'SUCCESS', rawJson: {}, amountTotal: sku.priceFen })).applied, true);
  assert.equal((await wallet()).balance, 2000);
  await chargeQuota(userId, 1600, 1); // 月度 1000 + pack 600 → balance=400，pack 剩 400

  const refund = await refundWechatOrder(order.outTradeNo, { reason: '用户申请', by: 'owner' });
  assert.equal(refund.wechatStatus, 'MOCK');
  const w = await wallet();
  assert.equal(w.packBalance, 0, 'pack 存量清零');
  assert.equal(w.balance, 0, '只追回未消耗的 400（不追已消耗的 600）');
  const ent = await prisma.skuEntitlement.findUniqueOrThrow({ where: { sourceOrderId: order.id } });
  assert.equal(ent.status, 'refunded');
});

test('退款：credits 包保守追回 min(当前余额, 发放额)', async () => {
  const sku = await makePack('credits', 50);
  const order = await makeOrder('ot_pack_credits_refund', sku.key);
  assert.equal((await markPaidAndApply({ outTradeNo: order.outTradeNo, tradeState: 'SUCCESS', rawJson: {}, amountTotal: sku.priceFen })).applied, true);
  // 花到只剩 20（低于发放额）→ 只能追回 20
  const balance = await getBalance(userId);
  const { chargeCredits } = await import('../src/services/credits.js');
  await chargeCredits(tenantId, userId, balance - 20, '测试消耗');
  assert.equal(await getBalance(userId), 20);

  await refundWechatOrder(order.outTradeNo, { reason: '用户申请', by: 'owner' });
  assert.equal(await getBalance(userId), 0, '余额不打成负数');
  const clawback = await prisma.creditLedger.findFirst({ where: { userId, reason: { contains: '退款追回' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  assert.equal(clawback?.delta, -20);
});

test('套餐订单退款（权益账本回收）不抹增购包', async () => {
  const plan = await prisma.plan.findFirstOrThrow({ where: { planFamilyKey: 'starter', period: 'month' } });
  const planOrder = await prisma.paymentOrder.create({
    data: {
      outTradeNo: 'ot_plan_with_pack', tenantId, userId, planId: plan.id, amount: plan.price,
      provider: 'wechat', status: 'created', snapshotJson: { kind: 'plan', mock: true } as object,
    },
  });
  assert.equal((await markPaidAndApply({ outTradeNo: planOrder.outTradeNo, tradeState: 'SUCCESS', rawJson: {}, amountTotal: plan.price })).applied, true);

  // 另外买一个算力包
  const sku = await makePack('quota', 80_000);
  const packOrder = await makeOrder('ot_pack_with_plan', sku.key);
  assert.equal((await markPaidAndApply({ outTradeNo: packOrder.outTradeNo, tradeState: 'SUCCESS', rawJson: {}, amountTotal: sku.priceFen })).applied, true);
  assert.equal((await wallet()).packBalance, 80_000);

  // 退套餐单 → 回落到剩余有效权益（注册时的入门版），月度额度按回落套餐重算，pack 原样叠回
  await refundWechatOrder(planOrder.outTradeNo, { reason: '用户申请', by: 'owner' });
  const w = await wallet();
  assert.equal(w.packBalance, 80_000, '增购包保值');
  assert.equal(w.balance, w.quota + 80_000, '回落额度 + pack 剩余');
});

test('套餐权益全撤（无剩余有效权益）：月度归 0，增购包仍保值', async () => {
  const plan = await prisma.plan.findFirstOrThrow({ where: { planFamilyKey: 'starter', period: 'month' } });
  const planOrder = await prisma.paymentOrder.create({
    data: {
      outTradeNo: 'ot_plan_only', tenantId, userId, planId: plan.id, amount: plan.price,
      provider: 'wechat', status: 'created', snapshotJson: { kind: 'plan', mock: true } as object,
    },
  });
  assert.equal((await markPaidAndApply({ outTradeNo: planOrder.outTradeNo, tradeState: 'SUCCESS', rawJson: {}, amountTotal: plan.price })).applied, true);
  const sku = await makePack('quota', 70_000);
  const packOrder = await makeOrder('ot_pack_only', sku.key);
  assert.equal((await markPaidAndApply({ outTradeNo: packOrder.outTradeNo, tradeState: 'SUCCESS', rawJson: {}, amountTotal: sku.priceFen })).applied, true);
  // 只留本单权益：其余（注册时开通）标退，退款后无任何有效权益 → 走「全撤」分支
  await prisma.planEntitlement.updateMany({
    // sourceOrderId 可为 null（注册时开通无订单），SQL 里 `<> 'x'` 对 NULL 恒为 NULL → 必须显式带上 null 分支
    where: { userId, OR: [{ sourceOrderId: null }, { sourceOrderId: { not: planOrder.id } }] },
    data: { status: 'refunded' },
  });

  await refundWechatOrder(planOrder.outTradeNo, { reason: '用户申请', by: 'owner' });
  const w = await wallet();
  assert.equal(w.quota, 0, '套餐额度撤销');
  assert.equal(w.packBalance, 70_000, '增购包保值');
  assert.equal(w.balance, 70_000);
});

// ───────────────── 7. 运营自建档位 ─────────────────

test('POST /admin/skus 建档 + PATCH 改量 + DELETE 删除', async () => {
  const created = await api('POST', '/api/admin/skus', { body: { kind: 'quota', name: '算力包 · 30 万', desc: '一次性增购', priceFen: 4900, amount: 300_000 } });
  assert.equal(created.status, 201);
  assert.match(created.body.key, /^pack-quota-[0-9a-f]{8}$/);
  assert.equal(created.body.amount, 300_000);
  assert.equal(created.body.enabled, true);
  const row = await prisma.sku.findUniqueOrThrow({ where: { key: created.body.key } });
  assert.deepEqual(row.metaJson, { amount: 300_000 });

  const listed = await api('GET', '/api/admin/skus', {});
  assert.equal(listed.body.find((s: { key: string }) => s.key === created.body.key).amount, 300_000);
  assert.equal(listed.body.find((s: { key: string }) => s.key === 'storage-2g').amount, null, '非增购包不带 amount');

  // 公开目录对算力包**不**下发 amount：价 ÷ token 就是每 token 售价，据此可反推供应商成本与毛利，
  // 属商业机密。运营后台（/admin/skus）照旧看得见，发放读库里的 metaJson.amount，都不受影响。
  const pub = await api('GET', '/api/skus', {});
  const pubQuota = pub.body.find((s: { key: string }) => s.key === created.body.key);
  assert.ok(pubQuota, '算力包本身仍要出现在公开目录里（藏的是数量，不是商品）');
  assert.equal(pubQuota.amount, undefined, '公开目录不得下发算力包 token 数');
  const pubCredits = await api('POST', '/api/admin/skus', { body: { kind: 'credits', name: '钻石包 · 50 颗', desc: '', priceFen: 2900, amount: 50 } });
  assert.equal(pubCredits.status, 201);
  const pubAfter = await api('GET', '/api/skus', {});
  assert.equal(pubAfter.body.find((s: { key: string }) => s.key === pubCredits.body.key).amount, 50, '钻石是对外货币口径，颗数照旧下发');

  const patched = await api('PATCH', `/api/admin/skus/${created.body.key}`, { body: { amount: 500_000, priceFen: 6900 } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.amount, 500_000);
  assert.equal(patched.body.priceFen, 6900);
  const audit = await prisma.auditLog.findFirst({ where: { action: 'admin.sku.update' }, orderBy: { createdAt: 'desc' } });
  assert.equal((audit!.payloadJson as { before: { amount: number }; after: { amount: number } }).before.amount, 300_000);
  assert.equal((audit!.payloadJson as { after: { amount: number } }).after.amount, 500_000);

  const del = await api('DELETE', `/api/admin/skus/${created.body.key}`, {});
  assert.equal(del.status, 200);
  assert.equal(await prisma.sku.count({ where: { key: created.body.key } }), 0);
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'admin.sku.delete' } }), '删除留审计');
});

test('建档守卫：kind 白名单 / 正整数 amount / priceFen>0 / 名称必填', async () => {
  const badKind = await api('POST', '/api/admin/skus', { body: { kind: 'module', name: 'x', priceFen: 100, amount: 1 } });
  assert.equal(badKind.status, 400);
  assert.equal(badKind.body.code, 'SKU_KIND_NOT_ALLOWED');

  for (const amount of [0, -5, 1.5, undefined]) {
    const r = await api('POST', '/api/admin/skus', { body: { kind: 'credits', name: '钻石包', priceFen: 100, amount } });
    assert.equal(r.status, 400, `amount=${amount} 应被拒`);
    assert.equal(r.body.code, 'BAD_AMOUNT');
  }
  const freePrice = await api('POST', '/api/admin/skus', { body: { kind: 'credits', name: '钻石包', priceFen: 0, amount: 10 } });
  assert.equal(freePrice.status, 400);
  assert.equal(freePrice.body.code, 'BAD_PRICE');

  const noName = await api('POST', '/api/admin/skus', { body: { kind: 'credits', name: '  ', priceFen: 100, amount: 10 } });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.code, 'BAD_NAME');
});

test('改量/删除守卫：非增购包不许改 amount、不许删；有订单则 409 SKU_IN_USE', async () => {
  const notPack = await api('PATCH', '/api/admin/skus/storage-2g', { body: { amount: 100 } });
  assert.equal(notPack.status, 400);
  assert.equal(notPack.body.code, 'SKU_AMOUNT_NOT_ALLOWED');
  const delNotPack = await api('DELETE', '/api/admin/skus/storage-2g', {});
  assert.equal(delNotPack.status, 400);
  assert.equal(delNotPack.body.code, 'SKU_KIND_NOT_ALLOWED');

  const sku = await makePack('credits', 30);
  const badAmount = await api('PATCH', `/api/admin/skus/${sku.key}`, { body: { amount: 0 } });
  assert.equal(badAmount.status, 400);
  assert.equal(badAmount.body.code, 'BAD_AMOUNT');

  await makeOrder('ot_pack_in_use', sku.key);
  const inUse = await api('DELETE', `/api/admin/skus/${sku.key}`, {});
  assert.equal(inUse.status, 409);
  assert.equal(inUse.body.code, 'SKU_IN_USE');
  assert.equal(inUse.body.refs, 1);
  assert.equal(await prisma.sku.count({ where: { key: sku.key } }), 1, '仍在库（改用停用下架）');

  const del404 = await api('DELETE', '/api/admin/skus/nope', {});
  assert.equal(del404.status, 404);
  assert.equal(del404.body.code, 'SKU_NOT_FOUND');
});

test('增购包写端点需 admin 鉴权', async () => {
  const r = await api('POST', '/api/admin/skus', { adminToken: false, body: { kind: 'credits', name: 'x', priceFen: 100, amount: 1 } });
  assert.ok(r.status === 401 || r.status === 403, `期望 401/403，实际 ${r.status}`);
  const d = await api('DELETE', '/api/admin/skus/nope', { adminToken: false });
  assert.ok(d.status === 401 || d.status === 403);
});

// ───────────────── 8. 下单快照优先 ─────────────────

test('下单后运营改 amount：入账仍按下单时快照量发放', async () => {
  const sku = await makePack('quota', 100_000);
  const order = await makeOrder('ot_pack_snapshot', sku.key); // 快照存 metaJson={amount:100000}
  const patched = await api('PATCH', `/api/admin/skus/${sku.key}`, { body: { amount: 999_999 } });
  assert.equal(patched.status, 200);

  const st0 = await getQuotaState(userId);
  assert.equal((await markPaidAndApply({ outTradeNo: order.outTradeNo, tradeState: 'SUCCESS', rawJson: {}, amountTotal: sku.priceFen })).applied, true);
  const w = await wallet();
  assert.equal(w.packBalance, 100_000, '按快照量发放，不按运营改后的现行量');
  assert.equal(w.balance, st0.balance + 100_000);
  const ent = await prisma.skuEntitlement.findUniqueOrThrow({ where: { sourceOrderId: order.id } });
  assert.equal(ent.quantity, 100_000);

  // 退款也按快照量回收（此时现行行是 999999）
  await refundWechatOrder(order.outTradeNo, { reason: '用户申请', by: 'owner' });
  const after = await wallet();
  assert.equal(after.packBalance, 0);
  assert.equal(after.balance, st0.balance, '回收 100000，不多扣');
});

test('credits 包同样按快照量发放（运营改量只影响新订单）', async () => {
  const sku = await makePack('credits', 40);
  const order = await makeOrder('ot_pack_credits_snapshot', sku.key);
  assert.equal((await api('PATCH', `/api/admin/skus/${sku.key}`, { body: { amount: 4000 } })).status, 200);
  const before = await getBalance(userId);
  assert.equal((await markPaidAndApply({ outTradeNo: order.outTradeNo, tradeState: 'SUCCESS', rawJson: {}, amountTotal: sku.priceFen })).applied, true);
  assert.equal(await getBalance(userId), before + 40);
});

// ───────────────── 9. 展示口径 ─────────────────

test('usageView：月度用满但 pack 有余 → near_limit，不报 exhausted', async () => {
  const resetsAt = new Date().toISOString();
  const withPack = usageView({ quota: 1000, used: 1000, unlimited: false, packBalance: 200 }, resetsAt, null);
  assert.equal(withPack.usagePercent, 100, '分母只算月度');
  assert.equal(withPack.usageStatus, 'near_limit');
  assert.equal(withPack.packRemaining, 200);

  const noPack = usageView({ quota: 1000, used: 1000, unlimited: false, packBalance: 0 }, resetsAt, null);
  assert.equal(noPack.usageStatus, 'exhausted');
  assert.equal(noPack.packRemaining, 0);

  const legacy = usageView({ quota: 1000, used: 1000, unlimited: false }, resetsAt, null);
  assert.equal(legacy.usageStatus, 'exhausted', '无 pack 字段（旧调用）行为不变');
});

test('GET /me：packRemaining 透传，used 只算月度，月度用满不报 exhausted', async () => {
  await prisma.user.update({ where: { id: userId }, data: { planActivatedAt: null, planExpiresAt: new Date(Date.now() + 30 * 864e5) } });
  await setWallet({ quota: 1000, balance: 200, packBalance: 200, periodKey: naturalPk() });
  const r = await api('GET', '/api/me', { token: userId });
  assert.equal(r.status, 200, `GET /api/me 应 200，实际 ${r.status}：${JSON.stringify(r.body)}`);
  assert.equal(r.body.tokenQuota.packRemaining, 200);
  assert.equal(r.body.tokenQuota.used, 1000, '月度已用不含 pack');
  assert.equal(r.body.tokenQuota.remaining, 200, 'remaining 是含 pack 的总余额');
  assert.equal(r.body.usage.usagePercent, 100);
  assert.equal(r.body.usage.usageStatus, 'near_limit');
});

test('GET /admin/users/:id/token-quota-detail 带 packBalance；恢复标准额度不抹 pack', async () => {
  await prisma.user.update({ where: { id: userId }, data: { planActivatedAt: null, planExpiresAt: new Date(Date.now() + 30 * 864e5) } });
  await setWallet({ quota: 1000, balance: 700, packBalance: 500, periodKey: naturalPk() });
  const detail = await api('GET', `/api/admin/users/${userId}/token-quota-detail`, {});
  assert.equal(detail.status, 200);
  assert.equal(detail.body.packBalance, 500);
  assert.equal(detail.body.used, 800, '月度已用 = 1000 - (700-500)');

  const restore = await api('POST', `/api/admin/users/${userId}/token-quota/restore-plan`, { body: {} });
  assert.equal(restore.status, 200);
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { plan: true } });
  const w = await wallet();
  assert.equal(w.quota, u.plan!.tokenQuotaPerMonth);
  assert.equal(w.packBalance, 500, 'pack 原样保留');
  assert.equal(w.balance, u.plan!.tokenQuotaPerMonth - 800 + 500, '月度已用保留、pack 叠回');
});

test('POST /admin/users/:id/token-quota（set，经 setQuota）不抹 pack', async () => {
  await prisma.user.update({ where: { id: userId }, data: { planActivatedAt: null, planExpiresAt: new Date(Date.now() + 30 * 864e5) } });
  await setWallet({ quota: 1000, balance: 700, packBalance: 500, periodKey: naturalPk() });
  const r = await api('POST', `/api/admin/users/${userId}/token-quota`, { body: { mode: 'set', quota: 3000 } });
  assert.equal(r.status, 200);
  const w = await wallet();
  assert.equal(w.quota, 3000);
  assert.equal(w.packBalance, 500);
  assert.equal(w.balance, 3500);
});

test('临时加额不复活已消耗的 pack（packBalance 归到派生值）', async () => {
  await prisma.user.update({ where: { id: userId }, data: { planActivatedAt: null, planExpiresAt: new Date(Date.now() + 30 * 864e5) } });
  await setWallet({ quota: 1000, balance: 300, packBalance: 500, periodKey: naturalPk() }); // pack 实际只剩 300
  const r = await api('POST', `/api/admin/users/${userId}/token-quota-adjustments`, { body: { delta: 5000, reason: '临时加额' } });
  assert.equal(r.status, 201);
  const w = await wallet();
  assert.equal(w.balance, 5300);
  assert.equal(w.packBalance, 300, 'pack 存量归到派生值，不因 balance 变大而复活');
});
