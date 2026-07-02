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
