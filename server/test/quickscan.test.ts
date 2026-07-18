// 3 问速诊（WO-06）集成测试 · 对齐 EXEC_SPEC 验收：
//   ① 出三字段初诊卡 + 空档案回填 Profile（industry/stage/pain，revenueBand→stage）；
//   ② 重复提交不覆盖已有档案值；③ 日限流：第 4 次 429；
//   ④ 额度为 0：当日第 1 次 grace 放行、第 2 次 402（grace:'quickscan' 每日 1 次）。
// 全程 mock 模型（structured() 无 live provider → 确定性模板，billable=false → 不实扣）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

const REQ = { industry: '美业', revenueBand: '100-500万', pain: '获客越来越贵，复购上不来' };

async function tenantOf(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
  return u!.tenantId;
}

test('速诊出三字段初诊卡 + 空档案回填 Profile（revenueBand→stage）', async () => {
  const token = await login(uniquePhone(), '速诊新客');
  const r = await api('POST', '/api/quickscan', { token, body: REQ });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.contradiction && r.body.judgement && r.body.firstMove, '三字段非空');
  assert.equal(r.body.cardUrl, null, 'cardUrl 暂为 null（PR-B2 生成）');

  const p = await prisma.profile.findFirst({ where: { tenantId: await tenantOf(token) } });
  assert.equal(p?.industry, REQ.industry);
  assert.equal(p?.stage, REQ.revenueBand); // 年营收段 → Profile.stage
  assert.equal(p?.pain, REQ.pain);
});

test('重复提交不覆盖已有档案值', async () => {
  const token = await login(uniquePhone(), '已有档案');
  const tid = await tenantOf(token);
  await prisma.profile.create({ data: { tenantId: tid, industry: '餐饮', stage: '500-1000万', pain: '老客流失' } });

  const r = await api('POST', '/api/quickscan', { token, body: REQ });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const p = await prisma.profile.findFirst({ where: { tenantId: tid } });
  assert.equal(p?.industry, '餐饮', '已有 industry 不被覆盖');
  assert.equal(p?.stage, '500-1000万', '已有 stage 不被覆盖');
  assert.equal(p?.pain, '老客流失', '已有 pain 不被覆盖');
});

test('日限流：前 3 次放行，第 4 次 429', async () => {
  const token = await login(uniquePhone(), '限流用户');
  for (let i = 1; i <= 3; i++) {
    const r = await api('POST', '/api/quickscan', { token, body: REQ });
    assert.equal(r.status, 200, `第 ${i} 次应放行`);
  }
  const over = await api('POST', '/api/quickscan', { token, body: REQ });
  assert.equal(over.status, 429);
  assert.equal(over.body.code, 'RATE_LIMITED');
});

test('额度为 0：当日第 1 次 grace 放行、第 2 次 402', async () => {
  const token = await login(uniquePhone(), '零额度用户');
  // 先跑一次创建钱包（此时有套餐额度，正常放行），再清零余额模拟额度耗尽
  await api('POST', '/api/quickscan', { token, body: REQ });
  await prisma.tokenWallet.update({ where: { userId: token }, data: { balance: 0 } });

  const first = await api('POST', '/api/quickscan', { token, body: REQ });
  assert.equal(first.status, 200, '零额度当日第 1 次走 grace 放行');

  // grace 结算会退回预留（余额回到 0），再显式清零以模拟持续零额度
  await prisma.tokenWallet.update({ where: { userId: token }, data: { balance: 0 } });
  const second = await api('POST', '/api/quickscan', { token, body: REQ });
  assert.equal(second.status, 402, '当日第 2 次超出 quickscan 保底 → 402');
  assert.equal(second.body.code, 'INSUFFICIENT_QUOTA');

  // grace 审计按 quickscan 类别计 1 次（不与 review 保底串账）
  const grace = await prisma.auditLog.count({ where: { userId: token, action: 'system.quota.grace', payloadJson: { path: ['kind'], equals: 'quickscan' } } });
  assert.equal(grace, 1);
});
