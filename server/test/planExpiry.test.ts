// 套餐有效期 / 锚点子周期重置 / 购买时快照(B) / 续费叠加 的核心行为测试。
// 用可注入时钟 runWithNow(...) 直接驱动 service 层（不走 HTTP / 不需沙箱），离线快进时间验证到期与降级。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { runWithNow } from '../src/services/clock.js';
import { applyPlanPurchase } from '../src/services/purchase.js';
import { getBalance } from '../src/services/credits.js';
import { computeUpgradeProration } from '../src/services/proration.js';
import { getQuotaState, chargeQuota, assertPlanActive, getPlanStatus, PlanExpiredError } from '../src/services/tokenQuota.js';
import { addMonthsClamped, periodKeyOf, isExpired, computeExpiry, nextResetAt } from '../src/services/planTime.js';
import { cleanBusiness, closeApp } from './helpers.js';

let tenantId = '', userId = '', monthlyId = '', yearlyId = '', freeId = '';

before(async () => { await cleanBusiness(); });
after(async () => { await closeApp(); });

beforeEach(async () => {
  await cleanBusiness();
  await prisma.plan.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: '有效期测试' } });
  tenantId = tenant.id;
  const monthly = await prisma.plan.create({ data: { name: 'M', price: 19800, period: 'month', creditsPerMonth: 68, tokenQuotaPerMonth: 1_000_000, agentCount: 8, featuresJson: [], sort: 1 } });
  const yearly = await prisma.plan.create({ data: { name: 'Y', price: 198000, period: 'year', creditsPerMonth: 68, tokenQuotaPerMonth: 1_000_000, agentCount: 8, featuresJson: [], sort: 2 } });
  const free = await prisma.plan.create({ data: { name: 'F', price: 0, period: 'month', creditsPerMonth: 10, tokenQuotaPerMonth: 100_000, agentCount: 3, featuresJson: [], sort: 0 } });
  monthlyId = monthly.id; yearlyId = yearly.id; freeId = free.id;
  const user = await prisma.user.create({ data: { tenantId, phone: '13900000099', name: '到期测试', role: 'owner' } });
  userId = user.id;
});

function plan(id: string) { return prisma.plan.findUniqueOrThrow({ where: { id } }); }

// —— 纯函数 ——
test('planTime: addMonthsClamped 月末漂移 clamp', () => {
  assert.equal(addMonthsClamped(new Date('2026-01-31T00:00:00Z'), 1).toISOString(), '2026-02-28T00:00:00.000Z');
  assert.equal(addMonthsClamped(new Date('2024-01-31T00:00:00Z'), 1).toISOString(), '2024-02-29T00:00:00.000Z'); // 闰年
  assert.equal(addMonthsClamped(new Date('2026-01-15T00:00:00Z'), 12).toISOString(), '2027-01-15T00:00:00.000Z');
});

test('planTime: periodKeyOf 免费=自然月 / 付费=锚点日，子周期跨界变键', () => {
  const at = new Date('2026-03-20T00:00:00Z');
  assert.equal(periodKeyOf(null, at), '2026-03'); // 免费/历史：自然月
  const anchor = new Date('2026-01-15T00:00:00Z');
  assert.equal(periodKeyOf(anchor, new Date('2026-02-14T00:00:00Z')), '2026-01-15'); // 第 1 子周期
  assert.equal(periodKeyOf(anchor, new Date('2026-02-16T00:00:00Z')), '2026-02-15'); // 第 2 子周期
  assert.equal(isExpired(new Date('2026-02-15T00:00:00Z'), new Date('2026-02-16T00:00:00Z')), true);
  assert.equal(isExpired(null, at), false);
  assert.equal(computeExpiry(anchor, 'year').toISOString(), '2027-01-15T00:00:00.000Z');
  assert.equal(nextResetAt(anchor, new Date('2026-02-16T00:00:00Z')).toISOString(), '2026-03-15T00:00:00.000Z');
});

// —— 行为 ——
test('购买月付：写 activatedAt/expiresAt = now / now+1月', async () => {
  const T0 = new Date('2026-01-15T08:00:00Z');
  await runWithNow(T0, async () => applyPlanPurchase({ id: userId, tenantId }, await plan(monthlyId), { reason: 'buy', source: 'test' }));
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  assert.equal(u.planId, monthlyId);
  assert.equal(u.planActivatedAt?.toISOString(), '2026-01-15T08:00:00.000Z');
  assert.equal(u.planExpiresAt?.toISOString(), '2026-02-15T08:00:00.000Z');
});

test('过期：quota 归 0 冻结 + assertPlanActive 抛 PLAN_EXPIRED(403)', async () => {
  const T0 = new Date('2026-01-15T00:00:00Z');
  await runWithNow(T0, async () => applyPlanPurchase({ id: userId, tenantId }, await plan(monthlyId), { reason: 'buy', source: 'test' }));
  // 到期前：有额度、门禁放行
  await runWithNow(new Date('2026-02-10T00:00:00Z'), async () => {
    const st = await getQuotaState(userId);
    assert.equal(st.quota, 1_000_000);
    await assertPlanActive(userId); // 不抛
    const ps = await getPlanStatus(userId);
    assert.equal(ps.active, true);
    assert.ok((ps.daysRemaining ?? 0) > 0);
  });
  // 到期后：额度冻结 0、门禁拦 403
  await runWithNow(new Date('2026-02-16T00:00:00Z'), async () => {
    const st = await getQuotaState(userId);
    assert.equal(st.quota, 0, '过期后 quota 应归 0');
    assert.equal(st.balance, 0);
    await assert.rejects(() => assertPlanActive(userId), (e: unknown) => e instanceof PlanExpiredError && (e as PlanExpiredError).statusCode === 403 && (e as PlanExpiredError).code === 'PLAN_EXPIRED');
    const ps = await getPlanStatus(userId);
    assert.equal(ps.active, false);
    assert.equal(ps.expired, true);
  });
});

test('锚点月度重置：年付有效期内跨月 → 复用快照重置 balance（不回读 live plan）', async () => {
  const T0 = new Date('2026-01-15T00:00:00Z');
  await runWithNow(T0, async () => {
    await applyPlanPurchase({ id: userId, tenantId }, await plan(yearlyId), { reason: 'buy', source: 'test' });
    await chargeQuota(userId, 300_000, 1); // 用掉 30 万
    assert.equal((await getQuotaState(userId)).balance, 700_000);
  });
  // 后台把套餐月额度砍到 50 万（验证 D1：不应追溯到已购用户）
  await prisma.plan.update({ where: { id: yearlyId }, data: { tokenQuotaPerMonth: 500_000 } });
  // 跨锚点子周期（+1 月）→ 重置
  await runWithNow(new Date('2026-02-16T00:00:00Z'), async () => {
    const st = await getQuotaState(userId);
    assert.equal(st.quota, 1_000_000, '应复用购买时快照 1,000,000，而非 live plan 的 500,000');
    assert.equal(st.balance, 1_000_000, '跨子周期 balance 重置满');
  });
});

test('续费同套餐（未过期）：叠加时长 + 保留锚点', async () => {
  const T0 = new Date('2026-01-15T00:00:00Z');
  await runWithNow(T0, async () => applyPlanPurchase({ id: userId, tenantId }, await plan(monthlyId), { reason: 'buy', source: 'test' }));
  // 第 10 天续费：expiresAt 从原到期(2/15)叠加 +1 月 → 3/15；activatedAt 保留 1/15
  await runWithNow(new Date('2026-01-25T00:00:00Z'), async () => applyPlanPurchase({ id: userId, tenantId }, await plan(monthlyId), { reason: 'renew', source: 'test' }));
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  assert.equal(u.planActivatedAt?.toISOString(), '2026-01-15T00:00:00.000Z', '续费保留原锚点');
  assert.equal(u.planExpiresAt?.toISOString(), '2026-03-15T00:00:00.000Z', '续费叠加时长（从原到期累加，非从 now）');
});

test('免费层 / 升级换锚点：免费 expiresAt=null 不到期；月→年升级锚点重置', async () => {
  const T0 = new Date('2026-01-15T00:00:00Z');
  await runWithNow(T0, async () => applyPlanPurchase({ id: userId, tenantId }, await plan(freeId), { reason: 'free', source: 'test' }));
  let u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  assert.equal(u.planExpiresAt, null, '免费层不到期');
  // 升级到月付，再升级到年付（不同套餐）→ 锚点重置到 now、到期 +12 月
  await runWithNow(new Date('2026-02-01T00:00:00Z'), async () => applyPlanPurchase({ id: userId, tenantId }, await plan(monthlyId), { reason: 'up', source: 'test' }));
  await runWithNow(new Date('2026-02-20T00:00:00Z'), async () => applyPlanPurchase({ id: userId, tenantId }, await plan(yearlyId), { reason: 'up2', source: 'test' }));
  u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  assert.equal(u.planId, yearlyId);
  assert.equal(u.planActivatedAt?.toISOString(), '2026-02-20T00:00:00.000Z', '升级到不同套餐：锚点重置到 now');
  assert.equal(u.planExpiresAt?.toISOString(), '2027-02-20T00:00:00.000Z', '年付 +12 月');
});

test('防刷：重复购买免费套餐不重复发钻石（幂等）', async () => {
  const T0 = new Date('2026-03-01T00:00:00Z');
  // 首次购买免费层 → 发放 creditsPerMonth=10 钻
  const first = await runWithNow(T0, async () => applyPlanPurchase({ id: userId, tenantId }, await plan(freeId), { reason: 'free', source: 'test' }));
  assert.equal(first.grantedCredits, 10, '首次发 10 钻');
  assert.equal(await getBalance(userId), 10);
  // 连点 3 次：已在该免费套餐上 → 不再发钻、余额不变
  for (let i = 0; i < 3; i++) {
    const r = await runWithNow(T0, async () => applyPlanPurchase({ id: userId, tenantId }, await plan(freeId), { reason: 'free', source: 'test' }));
    assert.equal(r.grantedCredits, 0, '重复购买不再发钻');
  }
  assert.equal(await getBalance(userId), 10, '余额仍为 10，未被刷');
  // 重复购买也不应写出垃圾 +0 流水
  const rows = await prisma.creditLedger.count({ where: { userId } });
  assert.equal(rows, 1, '仅首次一条发放流水');
});

// —— 月→年折算（D5）——
test('折算：月付剩余 10 天 → 升年付抵 ¥66、实付 ¥1914（按老套餐日单价）', async () => {
  const T0 = new Date('2026-01-15T00:00:00Z'); // 月付到期 2026-02-15
  await runWithNow(T0, async () => applyPlanPurchase({ id: userId, tenantId }, await plan(monthlyId), { reason: 'buy', source: 'test' }));
  await runWithNow(new Date('2026-02-05T00:00:00Z'), async () => {
    const pr = await computeUpgradeProration({ id: userId }, { id: yearlyId, price: 198000, period: 'year' });
    assert.equal(pr.applies, true);
    assert.equal(pr.remainingDays, 10);
    assert.equal(pr.remainingValue, 6600, '¥198/30 × 10 天 = ¥66（按老月付日单价）');
    assert.equal(pr.chargeAmount, 191400, '¥1980 − ¥66 = ¥1914');
    assert.equal(pr.fromPlanId, monthlyId);
  });
});

test('折算封顶（修复 over-credit）：31 天月即时升年付，抵扣不超过老套餐实付 ¥198（非 ¥204.6）', async () => {
  const T0 = new Date('2026-01-01T00:00:00Z'); // 月付 → 到期 2026-02-01（31 天跨度）
  await runWithNow(T0, async () => {
    await applyPlanPurchase({ id: userId, tenantId }, await plan(monthlyId), { reason: 'buy', source: 'test' });
    const pr = await computeUpgradeProration({ id: userId }, { id: yearlyId, price: 198000, period: 'year' });
    assert.equal(pr.remainingDays, 31);
    assert.ok(pr.remainingValue <= 19800, `抵扣不得超过老套餐实付 ¥198，实际 ${pr.remainingValue}`);
    assert.equal(pr.remainingValue, 19800, '封顶到 ¥198（裸算 ¥198/30×31=¥204.6 会被夹回）');
    assert.equal(pr.chargeAmount, 178200);
  });
});

test('续费再锚点（修复月末漂移）：1/31 月付续费 → 到期 3/31（不漂移成 3/28）', async () => {
  const T0 = new Date('2026-01-31T00:00:00Z');
  await runWithNow(T0, async () => applyPlanPurchase({ id: userId, tenantId }, await plan(monthlyId), { reason: 'buy', source: 'test' }));
  let u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  assert.equal(u.planExpiresAt?.toISOString(), '2026-02-28T00:00:00.000Z', '首期 1/31+1月 clamp 到 2/28');
  await runWithNow(new Date('2026-02-20T00:00:00Z'), async () => applyPlanPurchase({ id: userId, tenantId }, await plan(monthlyId), { reason: 'renew', source: 'test' }));
  u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  assert.equal(u.planActivatedAt?.toISOString(), '2026-01-31T00:00:00.000Z', '续费保留 1/31 锚点');
  assert.equal(u.planExpiresAt?.toISOString(), '2026-03-31T00:00:00.000Z', '从激活锚点再派生到 3/31，而非漂移的 3/28');
});

test('折算反套利：免费→年付不折算；年→年(续费)不折算；过期月付不折算 → 一律全价', async () => {
  // 免费用户升年付：无老付费套餐 → 全价
  await runWithNow(new Date('2026-01-15T00:00:00Z'), async () => applyPlanPurchase({ id: userId, tenantId }, await plan(freeId), { reason: 'free', source: 'test' }));
  let pr = await computeUpgradeProration({ id: userId }, { id: yearlyId, price: 198000, period: 'year' });
  assert.equal(pr.applies, false);
  assert.equal(pr.chargeAmount, 198000);
  // 年付用户再买年付（续费，老 period=year 非 month）→ 不折算
  await runWithNow(new Date('2026-01-16T00:00:00Z'), async () => applyPlanPurchase({ id: userId, tenantId }, await plan(yearlyId), { reason: 'buy', source: 'test' }));
  pr = await computeUpgradeProration({ id: userId }, { id: yearlyId, price: 198000, period: 'year' });
  assert.equal(pr.applies, false, '年→年不触发（仅月→年）');
  // 过期月付升年付 → 不折算（剩余价值 0）
  const user2 = await prisma.user.create({ data: { tenantId, phone: '13900000077', name: '过期月付', role: 'owner' } });
  await runWithNow(new Date('2026-01-15T00:00:00Z'), async () => applyPlanPurchase({ id: user2.id, tenantId }, await plan(monthlyId), { reason: 'buy', source: 'test' }));
  await runWithNow(new Date('2026-03-01T00:00:00Z'), async () => {
    const pr2 = await computeUpgradeProration({ id: user2.id }, { id: yearlyId, price: 198000, period: 'year' });
    assert.equal(pr2.applies, false, '老月付已过期 → 不折算');
    assert.equal(pr2.chargeAmount, 198000);
  });
});
