// 钻石预扣退款幂等（资损护栏）：一次 reserveCredits 最多只退一次。
// 真实触发路径：sessions.ts 降级退款（settleCreditForDeliverable）跑完后，紧随的
// quotaReservation.settle 抛错 → catch 块按 `charged` 再调一次 refund。refund 是裸闭包时
// 会给同一次预扣追加第二条正向流水 = 双退（用户白拿钻石）。
//   cd server && npm test -- test/creditReservation.test.ts
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { reserveCredits, getBalance } from '../src/services/credits.ts';

// login 送套餐时已写过一条赠送流水 → 只看本次预扣之后新增的行（skip 掉存量）。
async function deltasSince(userId: string, skip: number): Promise<number[]> {
  const rows = await prisma.creditLedger.findMany({
    where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { delta: true }, skip,
  });
  return rows.map((r) => r.delta);
}

async function tenantOf(userId: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tenantId: true } });
  return u.tenantId;
}

describe('CreditReservation.refund 幂等', () => {
  before(async () => {
    await getApp();
    await cleanBusiness();
    await seedBaseline();
  });
  after(async () => {
    await closeApp();
  });

  test('refund 调两次只退一次（余额与流水都只回一笔）', async () => {
    const userId = await login(uniquePhone(), '双退用户');
    const tenantId = await tenantOf(userId);
    const start = await getBalance(userId);
    assert.ok(start > 0, '测试期默认套餐应已赠钻石');
    const rows0 = await prisma.creditLedger.count({ where: { userId } });

    const cost = 3;
    const res = await reserveCredits(tenantId, userId, cost, '测试预扣');
    assert.equal(res.charged, true);
    assert.equal(res.balance, start - cost);

    const b1 = await res.refund('降级未出结构化成果 · 退回钻石'); // settleCreditForDeliverable
    const b2 = await res.refund(); // 随后 quota settle 抛错 → catch 块兜底退款
    assert.equal(b1, start, '首次退款回到预扣前余额');
    assert.equal(b2, b1, '重复调用返回首次退款后的余额，不再落账');

    assert.equal(await getBalance(userId), start, '净额为 0，绝不能多退一笔');
    assert.deepEqual(await deltasSince(userId, rows0), [-cost, cost], '流水只有一扣一退');
  });

  test('cost<=0：不预扣，refund 多次都不写流水', async () => {
    const userId = await login(uniquePhone(), '免费用户');
    const tenantId = await tenantOf(userId);
    const start = await getBalance(userId);
    const rows0 = await prisma.creditLedger.count({ where: { userId } });

    const res = await reserveCredits(tenantId, userId, 0, '文本产出免费');
    assert.equal(res.charged, false);
    assert.equal(await res.refund(), start);
    assert.equal(await res.refund(), start);

    assert.deepEqual(await deltasSince(userId, rows0), [], '零费用不写任何流水');
    assert.equal(await getBalance(userId), start);
  });

  // 与 tokenQuota.settle 同一取舍：只在落账成功后才算「已退」。退款失败若也置位，
  // 一次 DB 抖动就把用户的钻石吞掉——失败必须允许后续路径重试。
  test('退款失败不算已退：下一次调用仍能把钻石退回', async () => {
    const userId = await login(uniquePhone(), '退款重试用户');
    const tenantId = await tenantOf(userId);
    const start = await getBalance(userId);
    const rows0 = await prisma.creditLedger.count({ where: { userId } });

    const cost = 2;
    const res = await reserveCredits(tenantId, userId, cost, '测试预扣');

    const realTx = prisma.$transaction.bind(prisma);
    let failNext = true;
    (prisma as unknown as { $transaction: unknown }).$transaction = (...args: unknown[]) => {
      if (failNext) { failNext = false; return Promise.reject(new Error('db blip')); }
      return (realTx as (...a: unknown[]) => unknown)(...args);
    };
    try {
      await assert.rejects(() => res.refund(), /db blip/, '首次退款失败要如实抛出');
      assert.equal(await res.refund(), start, '重试退款成功');
    } finally {
      (prisma as unknown as { $transaction: unknown }).$transaction = realTx;
    }

    assert.deepEqual(await deltasSince(userId, rows0), [-cost, cost], '失败那次没落账，最终仍只有一扣一退');
    assert.equal(await getBalance(userId), start);
  });
});
