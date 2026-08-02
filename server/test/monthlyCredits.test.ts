// 年付钻石月度恢复：跟随套餐激活锚点惰性发放，同周期重复/并发读取恰好一次。
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { runWithNow } from '../src/services/clock.js';
import { getBalance } from '../src/services/credits.js';
import { applyPlanPurchase } from '../src/services/purchase.js';
import { addMonthsClamped } from '../src/services/planTime.js';
import { getQuotaState } from '../src/services/tokenQuota.js';
import { cleanBusiness, closeApp, getApp, seedBaseline, uniquePhone } from './helpers.js';

before(async () => { await getApp(); await seedBaseline(); });
after(async () => { await closeApp(); });
beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

test('年付跨锚点周期：每月钻石并发触发只发一次，周期键按激活日推进', async () => {
  const tenant = await prisma.tenant.create({ data: { name: '年付月度权益企业' } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, phone: uniquePhone(), name: '年付用户', role: 'owner' },
  });
  const yearly = await prisma.plan.findFirstOrThrow({ where: { planFamilyKey: 'decision', period: 'year' } });

  await runWithNow(new Date('2026-01-15T08:00:00Z'), () => applyPlanPurchase(
    { id: user.id, tenantId: tenant.id }, yearly, { reason: '年付首购', source: 'test' },
  ));
  assert.equal(await getBalance(user.id), yearly.creditsPerMonth);
  assert.deepEqual(
    (await prisma.monthlyCreditGrant.findMany({ where: { userId: user.id }, orderBy: { periodKey: 'asc' } })).map((row) => [row.periodKey, row.amount]),
    [['2026-01-15', yearly.creditsPerMonth]],
  );

  await runWithNow(new Date('2026-02-16T08:00:00Z'), () => Promise.all(
    Array.from({ length: 8 }, () => getQuotaState(user.id)),
  ));
  assert.equal(await getBalance(user.id), yearly.creditsPerMonth * 2, '第二周期只增加一份月度钻石');
  assert.deepEqual(
    (await prisma.monthlyCreditGrant.findMany({ where: { userId: user.id }, orderBy: { periodKey: 'asc' } })).map((row) => [row.periodKey, row.amount]),
    [['2026-01-15', yearly.creditsPerMonth], ['2026-02-15', yearly.creditsPerMonth]],
  );

  await runWithNow(new Date('2026-02-20T08:00:00Z'), () => Promise.all(
    Array.from({ length: 4 }, () => getQuotaState(user.id)),
  ));
  assert.equal(await getBalance(user.id), yearly.creditsPerMonth * 2, '同周期重复读取不得重发');

  const anchor = new Date('2026-01-15T08:00:00Z');
  for (let month = 2; month < 12; month += 1) {
    const crossedAt = new Date(addMonthsClamped(anchor, month).getTime() + 24 * 3600_000);
    await runWithNow(crossedAt, () => Promise.all(
      Array.from({ length: 4 }, () => getQuotaState(user.id)),
    ));
    assert.equal(await getBalance(user.id), yearly.creditsPerMonth * (month + 1), `第 ${month + 1} 个周期只应新增一份`);
  }
  const periods = (await prisma.monthlyCreditGrant.findMany({ where: { userId: user.id }, orderBy: { periodKey: 'asc' } })).map((row) => row.periodKey);
  assert.equal(periods.length, 12, '年付覆盖 12 个独立月度权益周期');
  assert.equal(periods[0], '2026-01-15');
  assert.equal(periods[11], '2026-12-15');
  assert.ok(periods.every((key) => key.endsWith('-15')), '月度周期必须沿激活日推进，不按自然月 1 号');
});
