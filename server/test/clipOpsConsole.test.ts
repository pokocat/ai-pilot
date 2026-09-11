// 爱速拍 · 出片对账台。
//
// VideoCreditHold 是唯一一张记着「钱扣了、片子还没交付」的表。这组用例盯两件事：
//   ① 那几个数算得对 —— 尤其「悬挂额不按时间窗口算」和「成功率分母只含已收口的单」，
//      这两条错了都会让最该被看见的卡单从视野里消失；
//   ② 手工对单不会把钱退错 —— 问不清绝不退款，是这条链路上最贵的一条规矩。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, uniquePhone } from './helpers.js';
import { createOperator, createSession } from '../src/services/adminAccount.js';
import { grantCredits, getBalance } from '../src/services/credits.js';
import { PRODUCT } from '../src/services/products.js';
import { clipOpsSummary, listClipHolds, normalizeHoldStatus, OPEN_HOLD_STATUSES } from '../src/services/video/opsConsole.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

before(async () => { await getApp(); await seedBaseline(); });
after(async () => { await closeApp(); });
beforeEach(async () => { await cleanBusiness(); });

const WIDE = () => ({ from: new Date(Date.now() - 86400_000), to: new Date(Date.now() + 86400_000) });

async function mkUser(name = '出片用户') {
  const tenant = await prisma.tenant.create({ data: { name: '出片测试企业' } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, phone: uniquePhone(), name, role: 'owner' },
  });
  return { tenantId: tenant.id, userId: user.id };
}

let seq = 0;
async function mkHold(input: {
  tenantId: string; userId: string; status: string; credits?: number;
  upstreamJobId?: string | null; createdAt?: Date;
}) {
  seq += 1;
  return prisma.videoCreditHold.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      productCode: PRODUCT.quickreel,
      projectId: `cp_${seq}`,
      clientRequestId: `ops:req:${seq}`,
      upstreamJobId: input.upstreamJobId ?? null,
      credits: input.credits ?? 10,
      status: input.status,
      ...(input.createdAt ? { createdAt: input.createdAt, chargedAt: input.createdAt } : {}),
    },
  });
}

/* ── 数算得对不对 ── */

test('悬挂 = 钱扣了既没交付也没退回；已结算和已退款都不算', async () => {
  const u = await mkUser();
  await mkHold({ ...u, status: 'submitting', credits: 10 });
  await mkHold({ ...u, status: 'unknown', credits: 20 });
  await mkHold({ ...u, status: 'submitted', credits: 30, upstreamJobId: 'job-a' });
  await mkHold({ ...u, status: 'notifying', credits: 40, upstreamJobId: 'job-b' });
  await mkHold({ ...u, status: 'settled', credits: 50, upstreamJobId: 'job-c' });
  await mkHold({ ...u, status: 'refunded', credits: 60 });

  const { from, to } = WIDE();
  const v = await clipOpsSummary(from, to);
  assert.equal(v.openCount, 4);
  assert.equal(v.openCredits, 10 + 20 + 30 + 40, 'settled / refunded 是终点，不该算进悬挂');
  assert.equal(v.settledCredits, 50);
  assert.equal(v.refundedCredits, 60);
});

test('notifying 也算悬挂 —— 漏掉它，悬挂额会随扫描节奏自己跳水', async () => {
  const u = await mkUser();
  await mkHold({ ...u, status: 'notifying', credits: 77, upstreamJobId: 'job-n' });
  const { from, to } = WIDE();
  const v = await clipOpsSummary(from, to);
  // notifying 是 submitted 被扫描认领后的瞬时中间态，但钱照样悬着。
  // 把它排除掉的话，每轮扫描认领的那一刻悬挂额就会掉一块，看起来像账在自己变。
  assert.equal(v.openCredits, 77);
  assert.ok((OPEN_HOLD_STATUSES as readonly string[]).includes('notifying'));
});

test('「连上游任务号都没拿到」单独计一档 —— 资损风险集中在这一档', async () => {
  const u = await mkUser();
  await mkHold({ ...u, status: 'submitting', credits: 11 });
  await mkHold({ ...u, status: 'unknown', credits: 22 });
  await mkHold({ ...u, status: 'submitted', credits: 99, upstreamJobId: 'job-x' });
  const { from, to } = WIDE();
  const v = await clipOpsSummary(from, to);
  assert.equal(v.unanchoredCredits, 33, 'submitted 已经有锚点，不在这一档');
  assert.equal(v.unanchoredCount, 2);
});

test('悬挂额不按时间窗口算 —— 卡了 40 天的单照样是今天悬着的钱', async () => {
  const u = await mkUser();
  const old = new Date(Date.now() - 40 * 86400_000);
  await mkHold({ ...u, status: 'unknown', credits: 500, createdAt: old });

  // 窗口只取最近 7 天，那单不在窗口里
  const v = await clipOpsSummary(new Date(Date.now() - 7 * 86400_000), new Date(Date.now() + 1000));
  assert.equal(v.openCredits, 500, '按窗口算会把最该被看见的陈年卡单藏起来，正好和这一屏的目的相反');
  assert.ok(v.oldestOpenAt && new Date(v.oldestOpenAt).getTime() < Date.now() - 39 * 86400_000);
  // 但窗口内的收口统计仍然是窗口内的
  assert.equal(v.settledCount, 0);
});

test('成功率分母只含已收口的单；一单都没收口时给 null 而不是 0%', async () => {
  const u = await mkUser();
  const { from, to } = WIDE();

  await mkHold({ ...u, status: 'submitted', upstreamJobId: 'job-q' });
  const pending = await clipOpsSummary(from, to);
  assert.equal(pending.successRate, null, '窗口里只有在跑的单 —— 0% 会被读成「全挂了」，那是谎报');

  await mkHold({ ...u, status: 'settled', upstreamJobId: 'job-s1' });
  await mkHold({ ...u, status: 'settled', upstreamJobId: 'job-s2' });
  await mkHold({ ...u, status: 'settled', upstreamJobId: 'job-s3' });
  await mkHold({ ...u, status: 'refunded' });
  const v = await clipOpsSummary(from, to);
  // 3 成 / 1 退 = 75%。那条 submitted 不进分母 —— 进了的话成功率会随队列长度上下飘，
  // 变成排队长度指标而不是质量指标。
  assert.equal(v.successRate, 75);
});

/* ── 列表 ── */

test('不传状态时默认只看还悬着的单', async () => {
  const u = await mkUser();
  await mkHold({ ...u, status: 'settled', upstreamJobId: 'job-done' });
  await mkHold({ ...u, status: 'unknown' });
  const list = await listClipHolds({ ...WIDE(), toExclusive: WIDE().to, page: 1, pageSize: 30 });
  assert.equal(list.total, 1, '这一屏是来处置问题的，默认把几万条已结算的摆最前面等于让人自己翻');
  assert.equal(list.items[0].status, 'unknown');
});

test('能不能手工对单由服务端判定，前端不猜', async () => {
  const u = await mkUser();
  await mkHold({ ...u, status: 'unknown' });
  await mkHold({ ...u, status: 'submitted', upstreamJobId: 'job-anchored' });
  const list = await listClipHolds({ ...WIDE(), toExclusive: WIDE().to, page: 1, pageSize: 30 });
  const byStatus = new Map(list.items.map((i) => [i.status, i]));
  assert.equal(byStatus.get('unknown')?.reconcilable, true);
  assert.equal(byStatus.get('submitted')?.reconcilable, false, '有锚点的单归出片完成扫描推进，手工插一脚只会和它抢');
});

test('状态筛选只认已知的几个，其它当作不筛而不是拼进查询', () => {
  assert.equal(normalizeHoldStatus('unknown'), 'unknown');
  assert.equal(normalizeHoldStatus('settled'), 'settled');
  assert.equal(normalizeHoldStatus('DROP TABLE'), undefined);
  assert.equal(normalizeHoldStatus(''), undefined);
  assert.equal(normalizeHoldStatus(undefined), undefined);
});

/* ── 权限 ── */

async function operator(): Promise<{ id: string; token: string }> {
  const acc = await createOperator(`ops_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, 'pw-123456', 'operator');
  return { id: acc.id, token: await createSession(acc.id) };
}

test('没被授予爱速拍的运营看不到这一屏', async () => {
  const op = await operator();
  const r = await api('GET', '/api/admin/video/ops', { adminToken: op.token });
  assert.equal(r.status, 403);
});

test('授予 viewer 就能看，但改不动', async () => {
  const op = await operator();
  await prisma.adminProductAccess.create({
    data: { productCode: PRODUCT.quickreel, accountId: op.id, role: 'viewer' },
  });
  const r = await api('GET', '/api/admin/video/ops', { adminToken: op.token });
  assert.equal(r.status, 200);

  const u = await mkUser();
  const hold = await mkHold({ ...u, status: 'unknown' });
  // 手工对单是动钱的操作，超管门槛不因产品授权而放松（与改价同一形制）
  const w = await api('POST', `/api/admin/video/holds/${hold.id}/reconcile`, { adminToken: op.token });
  assert.equal(w.status, 403);
});

/* ── 手工对单 ── */

test('已经有上游任务号的单不许手工对 —— 会和出片完成扫描抢同一行', async () => {
  const u = await mkUser();
  const hold = await mkHold({ ...u, status: 'submitted', upstreamJobId: 'job-live' });
  const r = await api('POST', `/api/admin/video/holds/${hold.id}/reconcile`);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'CLIP_HOLD_NOT_RECONCILABLE');
});

test('不存在的单回 404，不是 500', async () => {
  const r = await api('POST', '/api/admin/video/holds/nope_not_a_real_id/reconcile');
  assert.equal(r.status, 404);
});

test('上游问不清时绝不退款 —— 它可能已经在跑了，退了就是白送一次出片', async () => {
  const u = await mkUser();
  await grantCredits(u.tenantId, u.userId, 100, '充值', PRODUCT.junshi);
  const before = await getBalance(u.userId);
  const hold = await mkHold({ ...u, status: 'submitting', credits: 25 });

  // 测试环境没有真上游，videoSubmissionProbe 连不上 → outcome=unknown，这正是要验的那条路径
  const r = await api('POST', `/api/admin/video/holds/${hold.id}/reconcile`);
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, 'unknown');
  assert.equal(r.body.refunded, false);
  assert.equal(await getBalance(u.userId), before, '一分钱都不该动');

  const after = await prisma.videoCreditHold.findUnique({ where: { id: hold.id } });
  assert.equal(after?.status, 'unknown', '标成受理不明，留给下一轮，而不是就地判死');
  assert.equal(after?.refundedAt, null);
});

test('手工对单会落审计 —— 动钱的操作必须能倒查是谁点的', async () => {
  const u = await mkUser();
  const hold = await mkHold({ ...u, status: 'unknown' });
  await api('POST', `/api/admin/video/holds/${hold.id}/reconcile`);
  const log = await prisma.auditLog.findFirst({
    where: { action: 'admin.clip.hold.reconcile' }, orderBy: { createdAt: 'desc' },
  });
  assert.ok(log, '没落审计');
  assert.equal((log!.payloadJson as { holdId?: string })?.holdId, hold.id);
  assert.equal((log!.payloadJson as { outcome?: string })?.outcome, 'unknown');
});

/* ── 模板货架（代理 AIStar） ── */

test('模板货架要爱速拍的权限；上下架还要超管', async () => {
  const op = await operator();
  assert.equal((await api('GET', '/api/admin/video/templates', { adminToken: op.token })).status, 403);

  await prisma.adminProductAccess.create({
    data: { productCode: PRODUCT.quickreel, accountId: op.id, role: 'editor' },
  });
  // 有权限了，但测试环境没有真上游 → 502（不是 403、也不是伪装成空数组）
  const listed = await api('GET', '/api/admin/video/templates', { adminToken: op.token });
  assert.notEqual(listed.status, 403, '授权后不该再被产品闸挡住');
  assert.notEqual(listed.status, 200, '测试环境没有真上游，不该返回成功');

  // 上下架直接改变小程序首页看得到什么，与改价同级：产品 editor 也不够，仍要超管
  const w = await api('PUT', '/api/admin/video/templates/ct_x/status', {
    adminToken: op.token, body: { status: 'published' },
  });
  assert.equal(w.status, 403);
});

test('状态只收 published / draft —— 别的一律 422，不静默当成下架', async () => {
  // AIStar 的 upsert 里是 `"published".equals(x) ? "published" : "draft"`：拼错一个字母
  // 就静默下架。运营点「上架」却下了架还不报错，是最难查的那类，两边都得挡。
  for (const status of ['Published', 'PUBLISHED', '', 'online', undefined]) {
    const r = await api('PUT', '/api/admin/video/templates/ct_x/status', { body: { status } });
    assert.equal(r.status, 422, `status=${String(status)} 应该被拒`);
    assert.equal((r.body as { code?: string }).code, 'CLIP_TEMPLATE_STATUS_INVALID');
  }
});

test('上游挂了要如实报 502，不能吞成「一个模板都没有」', async () => {
  // 「货架是空的」和「问不到货架」在运营眼里是完全不同的两件事：前者会让人以为模板被清空了，
  // 跑去重新导入一遍。测试环境没有配上游，正好走的就是这条路径。
  const r = await api('GET', '/api/admin/video/templates');
  assert.ok(r.status >= 500, `期望 5xx，实际 ${r.status}`);
  assert.ok(!Array.isArray(r.body), '绝不能返回空数组冒充成功');
});

/* ── 终态保护（codex 2026-09-11 审出的两条，都能让用户既拿退款又拿到片子） ── */

test('已退款的单，回填任务号不许把它复活', async () => {
  const u = await mkUser();
  await grantCredits(u.tenantId, u.userId, 100, '充值', PRODUCT.junshi);
  const hold = await mkHold({ ...u, status: 'refunded', credits: 20 });
  await prisma.videoCreditHold.update({ where: { id: hold.id }, data: { refundedAt: new Date() } });

  const { attachVideoJob } = await import('../src/services/video/credits.js');
  // 真实撞法：手工对单向上游查单（慢），期间用户取消 → 退款写 refunded；
  // 查单回 accepted → 原来这里无条件 update，把 refunded 改回 submitted，refundedAt 还留着。
  // 这单看起来又活了，出片完成扫描随后结算掉 —— 用户既拿了退款又拿到片子。
  const ok = await attachVideoJob(hold.id, 'job-late-arrival');
  assert.equal(ok, false, '终态的单不该被回填');

  const after = await prisma.videoCreditHold.findUnique({ where: { id: hold.id } });
  assert.equal(after?.status, 'refunded', '被复活了');
  assert.equal(after?.upstreamJobId, null);
});

test('已结算的单也不许被重新回填', async () => {
  const u = await mkUser();
  const hold = await mkHold({ ...u, status: 'settled', upstreamJobId: 'job-settled' });
  const { attachVideoJob } = await import('../src/services/video/credits.js');
  assert.equal(await attachVideoJob(hold.id, 'job-other'), false);
  const after = await prisma.videoCreditHold.findUnique({ where: { id: hold.id } });
  assert.equal(after?.upstreamJobId, 'job-settled', '任务号被改掉了');
});

test('正常路径仍然回填得上', async () => {
  const u = await mkUser();
  const hold = await mkHold({ ...u, status: 'submitting' });
  const { attachVideoJob } = await import('../src/services/video/credits.js');
  assert.equal(await attachVideoJob(hold.id, 'job-normal'), true);
  const after = await prisma.videoCreditHold.findUnique({ where: { id: hold.id } });
  assert.equal(after?.status, 'submitted');
  assert.equal(after?.upstreamJobId, 'job-normal');
});

/**
 * ⚠️ 这一条**验的是不变式，不是那个竞态本身**。
 *
 * 真正的 TOCTOU 是：settleVideoJob 先 findUnique 读到 submitted，几行之后才写 —— 中间
 * 并发的取消路径完成退款并写 refunded，那次写就把 refunded 盖成 settled。顺序执行的用例
 * 复现不了这个交错（把 hold 直接建成 refunded 的话，函数开头那个 refunded 快速分支就先接住了），
 * 而用 Promise.all 去撞时序会得到一条时好时坏的用例，比没有更糟。
 *
 * 所以防线不在这条用例上，在实现里：终态判断被挪进了 updateMany 的 where，
 * 判定与写入是同一条 SQL，由数据库裁决。这条用例守的是「refunded 绝不会变成 settled」
 * 这个结果 —— 两条路径（快速分支、条件更新）任何一条被拆掉，它都还在。
 */
test('succeeded 结算不许盖掉已经发生的退款', async () => {
  const u = await mkUser();
  await grantCredits(u.tenantId, u.userId, 100, '充值', PRODUCT.junshi);
  const hold = await mkHold({ ...u, status: 'refunded', upstreamJobId: 'job-refunded', credits: 30 });
  await prisma.videoCreditHold.update({ where: { id: hold.id }, data: { refundedAt: new Date() } });

  const { settleVideoJob } = await import('../src/services/video/credits.js');
  await settleVideoJob('job-refunded', 'succeeded');

  const after = await prisma.videoCreditHold.findUnique({ where: { id: hold.id } });
  assert.equal(after?.status, 'refunded', 'refunded 是终点，任何路径都不许迁出去');
  assert.ok(after?.refundedAt, '退款时间还在，状态却成了已结算 —— 那是账面与资金不一致');
  assert.equal(after?.lastJobStatus, 'succeeded', '上游最后状态照记，只是不动 status');
});

test('succeeded 正常结算仍然结得掉', async () => {
  const u = await mkUser();
  await mkHold({ ...u, status: 'submitted', upstreamJobId: 'job-ok' });
  const { settleVideoJob } = await import('../src/services/video/credits.js');
  await settleVideoJob('job-ok', 'succeeded');
  const after = await prisma.videoCreditHold.findFirst({ where: { upstreamJobId: 'job-ok' } });
  assert.equal(after?.status, 'settled');
});

test('供应商对账要爱速拍权限；上游挂了如实报错，不伪装成「额度充足」', async () => {
  const op = await operator();
  assert.equal((await api('GET', '/api/admin/video/vendor', { adminToken: op.token })).status, 403);

  // 测试环境没有真上游 —— 这里要的就是「如实 5xx」。额度这种数字一旦被伪装成 0 或空，
  // 运营看到「槽位 0」会去找供应商扩容，而真实情况可能是我们自己没连上。
  const r = await api('GET', '/api/admin/video/vendor');
  assert.ok(r.status >= 500, `期望 5xx，实际 ${r.status}`);
});
