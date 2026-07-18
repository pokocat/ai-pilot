// 用户进度（M2 PR-10）测试：段位门槛派生（含 null 不达标）、只升不降、里程碑解锁幂等、
// 晋升审计（晋升卡素材）、注入门槛（新用户不注入）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { deriveRank, syncProgress, progressBriefing } from '../src/services/progress.ts';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

function isoDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86400_000);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

test('deriveRank 门槛：无数据不放水（null 准确率/命中率视为不达标）', () => {
  assert.equal(deriveRank({ streak: 0, monthlyReviewed: false, accuracy: null, hitRate: null }), '新兵');
  assert.equal(deriveRank({ streak: 14, monthlyReviewed: false, accuracy: null, hitRate: null }), '尉官');
  assert.equal(deriveRank({ streak: 30, monthlyReviewed: false, accuracy: null, hitRate: null }), '尉官', '没做过月复盘上不了校官');
  assert.equal(deriveRank({ streak: 30, monthlyReviewed: true, accuracy: null, hitRate: null }), '校官');
  assert.equal(deriveRank({ streak: 90, monthlyReviewed: true, accuracy: null, hitRate: null }), '校官', '准确率无数据上不了将军');
  assert.equal(deriveRank({ streak: 90, monthlyReviewed: true, accuracy: 61, hitRate: null }), '将军');
  assert.equal(deriveRank({ streak: 180, monthlyReviewed: true, accuracy: 71, hitRate: 51 }), '元帅');
  assert.equal(deriveRank({ streak: 180, monthlyReviewed: true, accuracy: 71, hitRate: 50 }), '将军', '命中率不达标卡元帅');
});

test('晋升：连续 14 天复盘 → 尉官 + 审计记录；断档后只升不降', async () => {
  const token = await login(uniquePhone(), '晋升用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  // 造 14 天连续 day 复盘
  for (let i = 0; i < 14; i++) {
    await prisma.reviewLog.create({ data: { tenantId: user.tenantId, userId: user.id, layer: 'day', date: isoDaysAgo(i) } });
  }
  const p = await syncProgress(user.id);
  assert.equal(p!.rank, '尉官');
  assert.equal(p!.promoted, true);
  assert.equal(p!.streak, 14);
  const audits = await prisma.auditLog.findMany({ where: { userId: user.id, action: 'user.rank.promoted' } });
  assert.equal(audits.length, 1);
  assert.deepEqual((audits[0].payloadJson as { from: string; to: string }).to, '尉官');

  // 再同步：无变化不再记晋升
  const again = await syncProgress(user.id);
  assert.equal(again!.promoted, false);
  assert.equal(await prisma.auditLog.count({ where: { userId: user.id, action: 'user.rank.promoted' } }), 1);

  // 断档（删掉复盘记录）→ streak 归零但段位保留（只升不降）
  await prisma.reviewLog.deleteMany({ where: { userId: user.id } });
  const after1 = await syncProgress(user.id);
  assert.equal(after1!.streak, 0);
  assert.equal(after1!.rank, '尉官', '段位不降');
});

test('里程碑：按使用天数解锁一次（幂等），记录解锁日期', async () => {
  const token = await login(uniquePhone(), '里程碑用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  // 把注册时间拨回 31 天前 → 使用第 32 天，应解锁 7/30
  await prisma.user.update({ where: { id: user.id }, data: { createdAt: new Date(Date.now() - 31 * 86400_000) } });
  const p = await syncProgress(user.id);
  assert.deepEqual(p!.newMilestones, [7, 30]);
  assert.ok(p!.milestones['7'] && p!.milestones['30']);
  assert.ok(!p!.milestones['90']);
  // 再同步：不重复解锁
  const again = await syncProgress(user.id);
  assert.deepEqual(again!.newMilestones, []);
});

test('注入与接口：新用户不注入；发起复盘后接口/注入都有真实数字', async () => {
  const fresh = await login(uniquePhone(), '新兵用户');
  const freshUser = await prisma.user.findFirstOrThrow({ where: { id: fresh } });
  assert.equal(await progressBriefing(freshUser.id), null, '全新用户不注入噪音');

  const token = await login(uniquePhone(), '进度用户');
  const r = await api('POST', '/api/casefile/review', { token, body: {} });
  assert.equal(r.body.progress.streak, 1);
  assert.equal(r.body.progress.rank, '新兵');
  assert.match(r.body.progress.nextRank.requirement, /14 天/);

  const g = await api('GET', '/api/progress', { token });
  assert.equal(g.body.progress.streak, 1);

  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  const line = await progressBriefing(user.id);
  assert.ok(line);
  assert.match(line!, /【段位·里程碑（系统计数/);
  assert.match(line!, /连续复盘 1 天/);
  assert.match(line!, /下一段位：尉官/);
});

test('WO-03 冷启动去百分比：连续复盘 <3 天不注入准确率/命中率（样本太薄）', async () => {
  const token = await login(uniquePhone(), '冷启动用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  // streak=2（<3），但已有一条已验证正确的决策 → decisionAccuracy 非 null。
  for (let i = 0; i < 2; i++) {
    await prisma.reviewLog.create({ data: { tenantId: user.tenantId, userId: user.id, layer: 'day', date: isoDaysAgo(i) } });
  }
  await prisma.decisionLog.create({
    data: { tenantId: user.tenantId, userId: user.id, seq: 1, decision: '试投小红书', reasons: ['成本低'], verifyStandard: '两周有 10 条线索', status: 'correct', verifiedAt: new Date() },
  });

  const line = await progressBriefing(user.id);
  assert.ok(line, 'streak≠0 → 注入');
  assert.match(line!, /连续复盘 2 天/);
  assert.doesNotMatch(line!, /准确率/, '新用户上下文不含准确率百分比');
  assert.doesNotMatch(line!, /命中率/, '新用户上下文不含命中率百分比');
});
