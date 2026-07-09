// V7-08 能力/模块中心测试。路由由 parent 在 app.ts 接线（未接线前 HTTP 走 404）；故核心断言直接打服务层，
// 与 wechatPay.test.ts 同套路（直调服务、绕过 HTTP），确定性、无需路由注册即可验证全部验收点。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { getBalance, chargeCredits } from '../src/services/credits.ts';
import { listForUser, enable, patchModule } from '../src/services/modules.ts';

let userA = '', tenantA = '';
let userB = '', tenantB = '';

async function tenantOf(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
  return u!.tenantId;
}
/** 覆写余额：插入一条 balance 快照流水（getBalance 读最后一条），使计费测试与默认套餐解耦。 */
async function setBalance(tenantId: string, userId: string, balance: number): Promise<void> {
  await prisma.creditLedger.create({ data: { tenantId, userId, delta: 0, reason: 'test seed balance', balance } });
}

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
  userA = await login(uniquePhone(), '模块用户');
  tenantA = await tenantOf(userA);
  userB = await login(uniquePhone(), '隔壁用户');
  tenantB = await tenantOf(userB);
});
after(async () => { await closeApp(); });

test('listForUser：目录 10 条；免费启用 / 付费未启用；推荐位（无案卷→矛盾初筛）', async () => {
  const view = await listForUser({ tenantId: tenantA, userId: userA });
  assert.equal(view.modules.length, 10);
  const byKey = Object.fromEntries(view.modules.map((m) => [m.key, m]));
  assert.equal(byKey['trend'].enabled, true);
  assert.equal(byKey['trend'].stateLabel, '默认启用'); // 免费模块保留目录态文案
  assert.equal(byKey['conflict'].enabled, true);
  assert.equal(byKey['deep-contradiction'].enabled, false);
  assert.equal(byKey['growth'].enabled, false);
  assert.equal(byKey['finance'].price?.skuKey, 'fin-checkup');
  assert.equal(byKey['growth'].agentKey, 'growth');
  // 新用户无案卷、无 journey 行 → stage 'new' → 推荐 conflict
  assert.ok(view.recommended);
  assert.equal(view.recommended!.key, 'conflict');
});

test('enable free：直启 + 幂等（无重复行、无扣费）', async () => {
  const v1 = await enable({ tenantId: tenantA, userId: userA, moduleKey: 'trend' });
  assert.equal(v1.enabled, true);
  const v2 = await enable({ tenantId: tenantA, userId: userA, moduleKey: 'trend' }); // 幂等
  assert.equal(v2.enabled, true);
  const rows = await prisma.userModule.findMany({ where: { userId: userA, moduleKey: 'trend' } });
  assert.equal(rows.length, 1); // @@unique([userId,moduleKey]) → 幂等 upsert 不产生第二行
  assert.equal(rows[0].source, 'free');
});

test('enable credits：扣算力落 CreditLedger + 幂等不重复扣；不足 → 402', async () => {
  const rich = await login(uniquePhone(), '算力充足');
  const tRich = await tenantOf(rich);
  await setBalance(tRich, rich, 1000);
  const v = await enable({ tenantId: tRich, userId: rich, moduleKey: 'growth' });
  assert.equal(v.enabled, true);
  assert.equal(v.stateLabel, '已启用'); // 付费模块启用后转「已启用」
  assert.equal(await getBalance(rich), 920); // 扣 80
  const charge = await prisma.creditLedger.findFirst({ where: { userId: rich, delta: -80 } });
  assert.ok(charge, '应有一条 delta=-80 扣费流水');
  // 幂等：再次 enable 不重复扣
  await enable({ tenantId: tRich, userId: rich, moduleKey: 'growth' });
  assert.equal(await getBalance(rich), 920);

  const poor = await login(uniquePhone(), '算力不足');
  const tPoor = await tenantOf(poor);
  await setBalance(tPoor, poor, 10); // < 80
  await assert.rejects(
    () => enable({ tenantId: tPoor, userId: poor, moduleKey: 'growth' }),
    (e: any) => e.statusCode === 402 && e.code === 'INSUFFICIENT_CREDITS',
  );
  const view = await listForUser({ tenantId: tPoor, userId: poor });
  assert.equal(view.modules.find((m) => m.key === 'growth')!.enabled, false); // 扣费失败不启用
  assert.equal(await getBalance(poor), 10); // 未扣
});

test('enable sku：未购 → 402 SKU_REQUIRED(带 skuKey)；已购 → 启用', async () => {
  await assert.rejects(
    () => enable({ tenantId: tenantA, userId: userA, moduleKey: 'finance' }),
    (e: any) => e.statusCode === 402 && e.code === 'SKU_REQUIRED' && e.skuKey === 'fin-checkup',
  );
  // 模拟 SKU 支付回调（purchase.applySkuGrant 写 grantsModuleKey=fin-checkup 行）
  await prisma.userModule.create({ data: { tenantId: tenantA, userId: userA, moduleKey: 'fin-checkup', enabled: true, source: 'purchase' } });
  const v = await enable({ tenantId: tenantA, userId: userA, moduleKey: 'finance' });
  assert.equal(v.enabled, true);
  // listForUser 亦应据 skuKey 映射识别为已启用
  const view = await listForUser({ tenantId: tenantA, userId: userA });
  assert.equal(view.modules.find((m) => m.key === 'finance')!.enabled, true);
});

test('enable member：套餐有效 → 启用；过期 → 403 PLAN_EXPIRED', async () => {
  // 默认新用户套餐有效（planExpiresAt=null 或未来）
  const okv = await enable({ tenantId: tenantA, userId: userA, moduleKey: 'ip-engine' });
  assert.equal(okv.enabled, true);

  const expired = await login(uniquePhone(), '套餐过期');
  const tExp = await tenantOf(expired);
  await prisma.user.update({ where: { id: expired }, data: { planExpiresAt: new Date(Date.now() - 86400_000) } });
  await assert.rejects(
    () => enable({ tenantId: tExp, userId: expired, moduleKey: 'ip-engine' }),
    (e: any) => e.statusCode === 403 && e.code === 'PLAN_EXPIRED',
  );
});

test('PATCH：hidden / sortOrder 持久化，隐藏模块仍返回并 flag', async () => {
  const v = await patchModule({ tenantId: tenantA, userId: userA, moduleKey: 'topic-bank', hidden: true, sortOrder: 7 });
  assert.equal(v.hidden, true);
  assert.equal(v.sortOrder, 7);
  const view = await listForUser({ tenantId: tenantA, userId: userA });
  const tb = view.modules.find((m) => m.key === 'topic-bank');
  assert.ok(tb, '隐藏模块仍在列表中返回');
  assert.equal(tb!.hidden, true); // 持久化
  assert.equal(tb!.sortOrder, 7);
  // 仅改 hidden，sortOrder 保留
  const v2 = await patchModule({ tenantId: tenantA, userId: userA, moduleKey: 'topic-bank', hidden: false });
  assert.equal(v2.hidden, false);
  assert.equal(v2.sortOrder, 7);
});

test('TC-G 跨用户隔离：A 启用不泄漏给 B；B 无法读到 A 的态', async () => {
  const rich = await login(uniquePhone(), 'A侧');
  const tRich = await tenantOf(rich);
  await setBalance(tRich, rich, 1000);
  await enable({ tenantId: tRich, userId: rich, moduleKey: 'growth' });
  const aView = await listForUser({ tenantId: tRich, userId: rich });
  assert.equal(aView.modules.find((m) => m.key === 'growth')!.enabled, true);
  // B（userB）视角：growth 未启用
  const bView = await listForUser({ tenantId: tenantB, userId: userB });
  assert.equal(bView.modules.find((m) => m.key === 'growth')!.enabled, false);
  // A 的 PATCH 不影响 B
  await patchModule({ tenantId: tRich, userId: rich, moduleKey: 'shop-board', hidden: true });
  const bView2 = await listForUser({ tenantId: tenantB, userId: userB });
  assert.equal(bView2.modules.find((m) => m.key === 'shop-board')!.hidden, false);
});

// HTTP 冒烟：parent 在 app.ts 注册 moduleRoutes 后应 200（未接线前 404，容忍）。
test('HTTP GET /api/modules（parent 接线后生效）', async () => {
  const r = await api('GET', '/api/modules', { token: userA });
  assert.ok(r.status === 200 || r.status === 404, `期望 200(已接线) 或 404(未接线)，实得 ${r.status}`);
  if (r.status === 200) {
    assert.equal(r.body.modules.length, 10);
    assert.ok('recommended' in r.body);
  }
});
