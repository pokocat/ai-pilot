// 复盘保底（M2 PR-6）测试：额度耗尽时——普通请求 402，复盘调用每日限次放行（透支记账），
// 超限后复盘也 402；保底触发留审计；不限量套餐不受影响。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { REVIEW_GRACE_PER_DAY } from '../src/services/tokenQuota.ts';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

const REVIEW_TEXT = '帮我做 2026-07-02 的执行复盘。\n今日军令完成情况：\n- [已完成] 私聊老客\n请判断今天的主要问题。';

async function drainWallet(userId: string) {
  // 先触发钱包创建（任意一次成功请求），再清零余额
  await api('POST', '/api/generate-sync', { token: userId, body: { text: '你好', agentKey: 'general' } });
  await prisma.tokenWallet.update({ where: { userId }, data: { balance: 0 } });
}

test('额度耗尽：普通请求 402；复盘请求保底放行且留审计', async () => {
  const token = await login(uniquePhone(), '保底用户');
  await drainWallet(token);

  const normal = await api('POST', '/api/generate-sync', { token, body: { text: '给我一个增长建议', agentKey: 'general' } });
  assert.equal(normal.status, 402);
  assert.equal(normal.body.code, 'INSUFFICIENT_QUOTA');

  const review = await api('POST', '/api/generate-sync', { token, body: { text: REVIEW_TEXT, agentKey: 'general' } });
  assert.equal(review.status, 200, '复盘保底放行');

  const grace = await prisma.auditLog.count({ where: { userId: token, action: 'system.quota.grace' } });
  assert.equal(grace, 1);
});

test('保底限次：同日超过上限后复盘也 402', async () => {
  const token = await login(uniquePhone(), '限次用户');
  await drainWallet(token);

  for (let i = 0; i < REVIEW_GRACE_PER_DAY; i++) {
    await prisma.tokenWallet.update({ where: { userId: token }, data: { balance: 0 } }); // mock settle 会退回预留，重新清零
    const r = await api('POST', '/api/generate-sync', { token, body: { text: REVIEW_TEXT, agentKey: 'general' } });
    assert.equal(r.status, 200, `第 ${i + 1} 次保底应放行`);
  }
  await prisma.tokenWallet.update({ where: { userId: token }, data: { balance: 0 } });
  const over = await api('POST', '/api/generate-sync', { token, body: { text: REVIEW_TEXT, agentKey: 'general' } });
  assert.equal(over.status, 402, '超过每日保底次数');
  assert.equal(await prisma.auditLog.count({ where: { userId: token, action: 'system.quota.grace' } }), REVIEW_GRACE_PER_DAY);
});

test('余额充足时复盘不消耗保底名额；伪装前缀不影响普通判定', async () => {
  const token = await login(uniquePhone(), '正常用户');
  const r = await api('POST', '/api/generate-sync', { token, body: { text: REVIEW_TEXT, agentKey: 'general' } });
  assert.equal(r.status, 200);
  assert.equal(await prisma.auditLog.count({ where: { userId: token, action: 'system.quota.grace' } }), 0, '余额>0 不走保底');
});
