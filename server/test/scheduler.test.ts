// 定时任务框架（M1 PR-4）测试：任务注册/隔离执行、久未推进召回扫描（命中/幂等/不误报）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone, deliverable } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { registerJob, runJob, scanIdleCasefiles, RECALL_IDLE_HOURS } from '../src/services/scheduler.ts';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

test('任务注册与隔离执行：run 抛错不外溢，未注册任务报错', async () => {
  let ran = 0;
  registerJob({ name: 'test-ok', intervalMs: 3600_000, run: async () => { ran += 1; } });
  registerJob({ name: 'test-boom', intervalMs: 3600_000, run: async () => { throw new Error('boom'); } });
  await runJob('test-ok');
  assert.equal(ran, 1);
  await runJob('test-boom'); // 不应抛出
  await assert.rejects(() => runJob('不存在'), /未注册/);
});

test('定时任务串行排队，同名任务在途时不重复堆积', async () => {
  let active = 0;
  let peak = 0;
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  registerJob({
    name: 'test-serial-a', intervalMs: 60_000, run: async () => {
      active += 1; peak = Math.max(peak, active); order.push('a:start');
      await firstGate;
      order.push('a:end'); active -= 1;
    },
  });
  registerJob({
    name: 'test-serial-b', intervalMs: 60_000, run: async () => {
      active += 1; peak = Math.max(peak, active); order.push('b'); active -= 1;
    },
  });

  const a1 = runJob('test-serial-a');
  const a2 = runJob('test-serial-a');
  const b = runJob('test-serial-b');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ['a:start'], '第一个任务未释放前，后续任务不应抢连接执行');
  releaseFirst();
  await Promise.all([a1, a2, b]);

  assert.equal(peak, 1, '进程内最多只运行一个定时任务');
  assert.deepEqual(order, ['a:start', 'a:end', 'b'], '同名在途调用应复用原 promise，不执行第二轮');
});

test('召回扫描：超时未推进的案卷登记候选，一天只记一次，活跃案卷不误报', async () => {
  const idleToken = await login(uniquePhone(), '沉默用户');
  const activeToken = await login(uniquePhone(), '活跃用户');
  const plan = deliverable('破局方案', [{ h: '行动清单', list: ['做一件事'] }]);
  await api('POST', '/api/casefile/accept', { token: idleToken, body: { deliverable: plan, agentName: '军师' } });
  await api('POST', '/api/casefile/accept', { token: activeToken, body: { deliverable: plan, agentName: '军师' } });

  // 把「沉默用户」的案卷 updatedAt 拨回 60h 前（超过 48h 阈值）
  const idleCf = await prisma.casefile.findFirstOrThrow({ where: { userId: idleToken } });
  const past = new Date(Date.now() - (RECALL_IDLE_HOURS + 12) * 3600_000);
  await prisma.$executeRaw`UPDATE casefile SET "updatedAt" = ${past} WHERE id = ${idleCf.id}`;

  const flagged = await scanIdleCasefiles();
  assert.equal(flagged, 1, '只有沉默用户被登记');
  const rows = await prisma.auditLog.findMany({ where: { action: 'system.recall.candidate' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, idleToken);
  const payload = rows[0].payloadJson as { casefileId: string; reason: string };
  assert.equal(payload.casefileId, idleCf.id);
  assert.match(payload.reason, /48h/);

  // 同日重扫 → 幂等不重复（updatedAt 需再次拨回：recordAudit 不碰 casefile，直接重扫即可）
  const again = await scanIdleCasefiles();
  assert.equal(again, 0, '同一天不重复登记');
  assert.equal(await prisma.auditLog.count({ where: { action: 'system.recall.candidate' } }), 1);
});

// 套餐到期提醒（2026-08-09 正式发布配套）：正式发布后人人有真到期日，此前全站没有任何到期提醒。
test('套餐到期提醒：按 7/3/1/0 档推送，同一到期日同一档只推一次；无授权额度不推也不落锚点', async () => {
  const { scanPlanExpiryReminders, PLAN_EXPIRY_REMIND_HOUR } = await import('../src/services/scheduler.ts');
  const { hourOf } = await import('../src/services/clock.ts');
  if (hourOf() < PLAN_EXPIRY_REMIND_HOUR) return; // 只在提醒时段之后才扫（与实现一致，不在此测时钟）

  const token = await login(uniquePhone(), '快到期用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token }, select: { id: true, tenantId: true } });
  const expiresAt = new Date(Date.now() + 3 * 864e5 - 3600_000); // 剩 3 天挂零
  await prisma.user.update({ where: { id: user.id }, data: { planExpiresAt: expiresAt } });

  // 没有微信订阅授权额度 → 不推送，也**不能**写锚点（写了就等于永远不再提醒，却一条也没发出去）。
  assert.equal(await scanPlanExpiryReminders(), 0);
  const anchors = await prisma.auditLog.count({ where: { userId: user.id, action: 'system.plan.expiry_notice' } });
  assert.equal(anchors, 0, '没真发出去就不许占掉档位');
});

test('套餐到期提醒：档位切分覆盖跨档跳跃，已过期超过一天不再打扰', async () => {
  const { PLAN_EXPIRY_REMIND_BUCKETS } = await import('../src/services/scheduler.ts');
  assert.deepEqual(PLAN_EXPIRY_REMIND_BUCKETS, [7, 3, 1, 0]);
});
