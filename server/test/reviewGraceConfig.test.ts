// D-10 复盘保底额度可配置：FeatureFlag('review-grace').payload.perDay 覆盖默认（6）。
// 配置 1 → 第 2 次被拦；配置 3 → 第 3 次放行。admin PATCH /admin/flags/:id 写入即时生效（清 payload 缓存）。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { __clearFeatureCache } from '../src/services/featureFlag.ts';

// admin 路由鉴权：设置共享 ADMIN_TOKEN（与 helpers.api 的 x-admin-token 自动附带一致）。
// 缺这行时，node --test 的每文件独立子进程下 process.env.ADMIN_TOKEN 未定义，
// 下面三个用例的 PATCH /api/admin/flags/review-grace 都会直接 401，测试恒定失败。
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

const REVIEW_TEXT = '帮我做 2026-07-02 的执行复盘。\n今日军令完成情况：\n- [已完成] 私聊老客\n请判断今天的主要问题。';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

beforeEach(async () => {
  await prisma.featureFlag.deleteMany({ where: { id: 'review-grace' } });
  __clearFeatureCache();
});

async function drainWallet(userId: string) {
  await api('POST', '/api/generate-sync', { token: userId, body: { text: '你好', agentKey: 'general' } });
  await prisma.tokenWallet.update({ where: { userId }, data: { balance: 0 } });
}

async function reviewOnce(token: string) {
  await prisma.tokenWallet.update({ where: { userId: token }, data: { balance: 0 } }); // mock settle 退回预留，重新清零
  return api('POST', '/api/generate-sync', { token, body: { text: REVIEW_TEXT, agentKey: 'general' } });
}

test('admin 配置 review-grace=1 → 第 1 次放行、第 2 次 402', async () => {
  const token = await login(uniquePhone(), '配置1用户');
  await drainWallet(token);
  const patch = await api('PATCH', '/api/admin/flags/review-grace', { body: { value: 1 } });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.value, 1);
  __clearFeatureCache();

  assert.equal((await reviewOnce(token)).status, 200, '第 1 次保底放行');
  assert.equal((await reviewOnce(token)).status, 402, '配置 1 → 第 2 次被拦');
});

test('admin 配置 review-grace=3 → 前 3 次放行、第 4 次 402', async () => {
  const token = await login(uniquePhone(), '配置3用户');
  await drainWallet(token);
  const patch = await api('PATCH', '/api/admin/flags/review-grace', { body: { value: 3 } });
  assert.equal(patch.status, 200);
  __clearFeatureCache();

  for (let i = 1; i <= 3; i++) assert.equal((await reviewOnce(token)).status, 200, `第 ${i} 次应放行`);
  assert.equal((await reviewOnce(token)).status, 402, '配置 3 → 第 4 次被拦');
});

test('review-grace 校验：越界值 400', async () => {
  const bad = await api('PATCH', '/api/admin/flags/review-grace', { body: { value: 999 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'BAD_VALUE');
});
