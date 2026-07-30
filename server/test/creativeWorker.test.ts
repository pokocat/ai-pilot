// 海报成品图（canvas_design）P5 测试之二：worker 生命周期 / sweep 自愈 / 退款不变量。
//
// 驱动方式：worker 在 NODE_ENV=test 不自启（startCreativeWorker 直接 return），用例手动调
// `tickCreativeWorker()` 一轮一轮推 —— 不依赖真实计时器，也不会有后台 tick 偷跑掉别的用例的任务。
// 渲染在 test 模式下走 reportPdf 的 1×1 桩 PNG（不起 Chromium），但对外仍上报名义 1080×1440。
//
// 制造「渲染必失败」的确定性手法：把已建任务的 requestJson.brief.templateKey 改成白名单外的值。
// renderPosterHtml 按 templateKey 查渲染器表，查不到就抛 —— 这也是真实世界里「模板改名后老任务被重试」
// 的形态，所以顺带把它当回归用例钉住。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.js';
import { grantCredits, getBalance } from '../src/services/credits.js';
import { __clearFeatureCache } from '../src/services/featureFlag.js';
import { tickCreativeWorker, sweepCreativeJobs, STALE_RUNNING_MS, MAX_ATTEMPTS } from '../src/services/creative/worker.js';
import { refundJob } from '../src/services/creative/jobs.js';
import { DEFAULT_PRICE_PER_POSTER } from '../src/services/creative/config.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

const PRICE = DEFAULT_PRICE_PER_POSTER;

function brief(over: Record<string, unknown> = {}) {
  return {
    scene: 'personal_brand',
    goal: '拉到 20 个咨询线索',
    audience: '中小企业主',
    headline: '增长顾问',
    subheadline: '十年操盘经验',
    proofPoints: ['服务 200+ 客户'],
    cta: '扫码预约',
    visualDirection: '克制的深色背景',
    ratio: '3:4',
    ...over,
  };
}

async function posterUser(credits = 200, name = '出图用户'): Promise<{ token: string; tenantId: string }> {
  const token = await login(uniquePhone(), name);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { tenantId: true } });
  await prisma.userAgent.create({ data: { userId: token, agentKey: 'poster', source: 'admin_grant' } });
  await grantCredits(user.tenantId, token, credits, '测试充值');
  return { token, tenantId: user.tenantId };
}

async function createJob(token: string, key: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: key, ...extra } });
  assert.equal(r.status, 201, `建单应 201：${JSON.stringify(r.body)}`);
  return r.body.jobId;
}

/** 把任务改成「渲染一定失败」（模板 key 落在白名单外）。 */
async function poisonTemplate(jobId: string): Promise<void> {
  const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
  const req = job.requestJson as { brief: Record<string, unknown> };
  await prisma.creativeJob.update({
    where: { id: jobId },
    data: { requestJson: { ...req, brief: { ...req.brief, templateKey: 'template_that_no_longer_exists' } } },
  });
}

/** 退款流水条数（正向 delta，reason 带「海报成品图」前缀）。 */
async function refundLedgerCount(userId: string): Promise<number> {
  return prisma.creditLedger.count({ where: { userId, delta: PRICE, reason: { contains: '海报成品图' } } });
}

before(async () => { await getApp(); });
after(async () => { await closeApp(); });

describe('海报成品图 · worker 生命周期', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); __clearFeatureCache(); });

  test('create → tick → succeeded：CreativeAsset 落库、resultJson 完整、名义尺寸 1080×1440', async () => {
    const { token } = await posterUser();
    const jobId = await createJob(token, 'w-ok');

    const handled = await tickCreativeWorker();
    assert.equal(handled, 1, '本轮应抢到 1 个任务');

    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, 'succeeded', `任务应成功：${job.errorCode} ${job.errorMessage}`);
    assert.equal(job.progress, null, '终态清掉进度');
    assert.ok(job.startedAt && job.completedAt, '起止时间都落了');
    assert.equal(job.attempts, 1);
    assert.ok(job.promptSnapshot && job.promptSnapshot.length > 0, '视觉哲学快照可追溯');
    assert.equal(job.refundedAt, null, '成功任务不退款');

    const assets = await prisma.creativeAsset.findMany({ where: { jobId } });
    assert.equal(assets.length, 1, '一张成品');
    assert.equal(assets[0].kind, 'poster_png');
    assert.equal(assets[0].mimeType, 'image/png');
    assert.equal(assets[0].width, 1080, 'test 模式渲染桩仍上报名义宽');
    assert.equal(assets[0].height, 1440);
    assert.ok(assets[0].ossKey.includes(jobId), 'key 里带 jobId，且以 assetId(cuid) 收尾不可猜');

    const result = job.resultJson as { assetId: string; width: number; height: number; templateKey: string };
    assert.equal(result.assetId, assets[0].id);
    assert.equal(result.width, 1080);
    assert.equal(result.templateKey, 'person_hero');

    // 视图口径：成品资产可读、动作给到 revise/regenerate
    const view = await api('GET', `/api/creative/jobs/${jobId}`, { token });
    assert.equal(view.status, 200);
    assert.equal(view.body.status, 'succeeded');
    assert.equal(view.body.assets.length, 1);
    assert.deepEqual(view.body.actions, ['revise', 'regenerate']);

    // 未配 OSS 的回退链路：签名 URL 退化为自有鉴权路由，且真能取到字节
    assert.equal(view.body.assets[0].downloadUrl, `/api/creative/assets/${assets[0].id}/file`);
    const file = await api('GET', view.body.assets[0].downloadUrl, { token });
    assert.equal(file.status, 200, '本人可下载');
  });

  test('messageId 存在 → 成功后成果消息 contentJson 补写 assets + creativeJobId', async () => {
    const { token, tenantId } = await posterUser();
    const session = await prisma.session.create({ data: { tenantId, userId: token, agentKey: 'poster', title: '海报方案' } });
    const msg = await prisma.message.create({
      data: {
        sessionId: session.id, role: 'report',
        contentJson: { title: '个人品牌海报方案', sections: [{ h: '主视觉', b: '深色背景' }], actions: ['save_to_library'] },
      },
    });

    const jobId = await createJob(token, 'w-msg', { messageId: msg.id });
    await tickCreativeWorker();
    assert.equal((await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } })).status, 'succeeded');

    const after = await prisma.message.findUniqueOrThrow({ where: { id: msg.id } });
    const content = after.contentJson as { title: string; creativeJobId: string; assets: { kind: string; width: number; downloadUrl: string }[] };
    assert.equal(content.title, '个人品牌海报方案', '原成果内容不被覆盖');
    assert.equal(content.creativeJobId, jobId);
    assert.equal(content.assets.length, 1);
    assert.equal(content.assets[0].kind, 'poster_png');
    assert.equal(content.assets[0].width, 1080);

    // 同 kind 只留最新一张：再出一次（regenerate）后成果卡仍只有一条 poster_png
    const regen = await api('POST', `/api/creative/jobs/${jobId}/regenerate`, { token, body: { idempotencyKey: 'w-msg-2' } });
    assert.equal(regen.status, 200, JSON.stringify(regen.body));
    await tickCreativeWorker();
    const after2 = await prisma.message.findUniqueOrThrow({ where: { id: msg.id } });
    const content2 = after2.contentJson as { creativeJobId: string; assets: { kind: string }[] };
    assert.equal(content2.assets.filter((a) => a.kind === 'poster_png').length, 1, '同 kind 只留最新');
    assert.equal(content2.creativeJobId, regen.body.jobId, 'creativeJobId 指向最近一次成功');
  });

  test('revise 复用父任务主视觉：不再产出 visual 资产、不扣费、仍出一张新成品', async () => {
    const { token } = await posterUser();
    const parentId = await createJob(token, 'w-rev-1');
    await tickCreativeWorker();
    const balanceAfterParent = await getBalance(token);

    const revised = await api('POST', `/api/creative/jobs/${parentId}/revise`, { token, body: { headline: '换个说法', idempotencyKey: 'w-rev-2' } });
    assert.equal(revised.status, 200, JSON.stringify(revised.body));
    await tickCreativeWorker();

    const child = await prisma.creativeJob.findUniqueOrThrow({ where: { id: revised.body.jobId } });
    assert.equal(child.status, 'succeeded', `${child.errorCode} ${child.errorMessage}`);
    assert.equal(child.creditCost, 0);
    assert.equal(await getBalance(token), balanceAfterParent, 'revise 全程零扣费');
    // 父任务资产不被覆盖（版本链上各自一张）
    assert.equal(await prisma.creativeAsset.count({ where: { jobId: parentId, kind: 'poster_png' } }), 1);
    assert.equal(await prisma.creativeAsset.count({ where: { jobId: child.id, kind: 'poster_png' } }), 1);
  });

  test('渲染抛错 → 重试用尽后 failed + 退款一次（退款流水只有一条）', async () => {
    const { token } = await posterUser();
    const before = await getBalance(token);
    const jobId = await createJob(token, 'w-fail');
    assert.equal(await getBalance(token), before - PRICE, '建单即实扣');
    await poisonTemplate(jobId);

    // 前 MAX_ATTEMPTS-1 轮：失败但回 pending 等重试，钱不动
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      assert.equal(await tickCreativeWorker(), 1, `第 ${i} 轮应抢到任务`);
      const mid = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
      assert.equal(mid.status, 'pending', `第 ${i} 轮失败后回队列重试`);
      assert.equal(mid.attempts, i);
      assert.equal(mid.refundedAt, null, '还要重试的任务不退款');
      assert.equal(await getBalance(token), before - PRICE);
    }
    // 最后一轮：终态失败 + 退款
    assert.equal(await tickCreativeWorker(), 1);
    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, MAX_ATTEMPTS);
    // 回归：老任务带着已下线的 templateKey 时，必须落成有语义的 POSTER_RENDER_FAILED，
    // 而不是裸 TypeError 冒上来变成 'INTERNAL'（运营在任务台上要能分清模板问题和代码 bug）。
    assert.equal(job.errorCode, 'POSTER_RENDER_FAILED');
    assert.ok(job.refundedAt, '失败即退款');
    assert.ok(job.completedAt);
    assert.equal(await getBalance(token), before, '钱全额退回');
    assert.equal(await refundLedgerCount(token), 1, '退款流水只有一条');
    assert.equal(await prisma.creativeAsset.count({ where: { jobId } }), 0, '失败不留半成品资产');

    // 对外文案是克制口径（不吐内部堆栈）
    const view = await api('GET', `/api/creative/jobs/${jobId}`, { token });
    assert.equal(view.body.refunded, true);
    assert.ok(view.body.errorMessage.includes('退回钻石'), `面向用户的失败原因：${view.body.errorMessage}`);
    assert.ok(!/template_that_no_longer_exists/.test(String(view.body.errorMessage)), '不泄内部细节');
  });

  test('requestJson 损坏 → 立刻 failed + 退款（不留在 running 等 sweep）', async () => {
    const { token } = await posterUser();
    const before = await getBalance(token);
    const jobId = await createJob(token, 'w-broken');
    await prisma.creativeJob.update({ where: { id: jobId }, data: { requestJson: { brief: null } } });

    await tickCreativeWorker();
    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, 'failed', 'BRIEF_MISSING 不可重试，直接终态');
    assert.equal(job.errorCode, 'BRIEF_MISSING');
    assert.ok(job.refundedAt);
    assert.equal(await getBalance(token), before, '已退款');
    assert.equal(await refundLedgerCount(token), 1);
  });

  test('running 中请求取消 → worker 在检查点收口为 cancelled + 退款', async () => {
    const { token } = await posterUser();
    const before = await getBalance(token);
    const jobId = await createJob(token, 'w-cancel');
    // 先置 running 并打取消标记（模拟「用户在制作中页点了取消」）
    await prisma.creativeJob.update({
      where: { id: jobId },
      data: { status: 'running', startedAt: new Date(), progress: 'philosophy', attempts: 1, metadataJson: { cancelRequested: true } },
    });
    // 直接驱动这一个任务（tick 只抢 pending，这里任务已是 running）
    const { runJobOnce } = await import('../src/services/creative/worker.js');
    const outcome = await runJobOnce(jobId);
    assert.equal(outcome.status, 'cancelled');

    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, 'cancelled');
    assert.ok(job.refundedAt);
    assert.equal(await getBalance(token), before, '取消退款');
    assert.equal(await prisma.creativeAsset.count({ where: { jobId } }), 0, '取消不留悬空产物');
  });

  test('功能关闭时 worker 不消费队列（任务留着，开启后继续）', async () => {
    const { token } = await posterUser();
    const jobId = await createJob(token, 'w-paused');
    const { setFeatureFlag } = await import('../src/services/featureFlag.js');
    const { CREATIVE_FLAG_ID } = await import('../src/services/creative/config.js');

    await setFeatureFlag(CREATIVE_FLAG_ID, false);
    assert.equal(await tickCreativeWorker(), 0, '关着不抢任务');
    assert.equal((await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } })).status, 'pending');

    await setFeatureFlag(CREATIVE_FLAG_ID, true);
    assert.equal(await tickCreativeWorker(), 1, '开回来继续跑');
    assert.equal((await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } })).status, 'succeeded');
  });
});

describe('海报成品图 · 退款不变量', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); __clearFeatureCache(); });

  test('已退款任务再触发退款路径 → 不二次退', async () => {
    const { token } = await posterUser();
    const before = await getBalance(token);
    const jobId = await createJob(token, 'r-once');
    await poisonTemplate(jobId);
    for (let i = 0; i < MAX_ATTEMPTS; i++) await tickCreativeWorker();
    assert.equal(await getBalance(token), before);
    assert.equal(await refundLedgerCount(token), 1);

    // 直接再调三次退款入口 + 一次 sweep 兜底扫描
    for (let i = 0; i < 3; i++) {
      const r = await refundJob(jobId, '重复退款测试');
      assert.equal(r.refunded, false, '抢占失败 → 不退');
    }
    await sweepCreativeJobs();
    assert.equal(await getBalance(token), before, '余额没被多退');
    assert.equal(await refundLedgerCount(token), 1, '退款流水仍只有一条');
  });

  test('admin retry 后再失败 → 不二次退款（保留 refundedAt 是有意为之）', async () => {
    const { token } = await posterUser();
    const before = await getBalance(token);
    const jobId = await createJob(token, 'r-retry');
    await poisonTemplate(jobId);
    for (let i = 0; i < MAX_ATTEMPTS; i++) await tickCreativeWorker();
    const failed = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(failed.status, 'failed');
    assert.ok(failed.refundedAt);
    assert.equal(await getBalance(token), before);

    const retry = await api('POST', `/api/admin/creative/jobs/${jobId}/retry`, { body: {} });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    const requeued = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(requeued.status, 'pending');
    assert.equal(requeued.attempts, 0, 'attempts 清零');
    assert.ok(requeued.refundedAt, 'refundedAt 必须保留 —— 清掉它会让重试再失败时又退一次 10 钻（资损）');
    assert.ok(requeued.chargedAt, 'chargedAt 也不动');

    // 重试仍然失败（模板还是坏的）→ 跑满重试
    for (let i = 0; i < MAX_ATTEMPTS; i++) await tickCreativeWorker();
    const again = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(again.status, 'failed');
    assert.equal(await getBalance(token), before, '重试再失败不再退款');
    assert.equal(await refundLedgerCount(token), 1, '退款流水仍只有一条');
  });

  test('admin retry 后成功 → 免费补发一张，不再扣费', async () => {
    const { token } = await posterUser();
    const before = await getBalance(token);
    const jobId = await createJob(token, 'r-retry-ok');
    await poisonTemplate(jobId);
    for (let i = 0; i < MAX_ATTEMPTS; i++) await tickCreativeWorker();
    assert.equal(await getBalance(token), before, '失败已退款');

    // 运营修好模板（这里恢复合法 key）后重试
    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    const req = job.requestJson as { brief: Record<string, unknown> };
    await prisma.creativeJob.update({
      where: { id: jobId },
      data: { requestJson: { ...req, brief: { ...req.brief, templateKey: 'person_hero' } } },
    });
    assert.equal((await api('POST', `/api/admin/creative/jobs/${jobId}/retry`, { body: {} })).status, 200);
    await tickCreativeWorker();

    const done = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(done.status, 'succeeded');
    assert.equal(await getBalance(token), before, '重试成功不再扣费（运营善意补发）');
    assert.equal(await prisma.creativeAsset.count({ where: { jobId, kind: 'poster_png' } }), 1);
  });

  test('不限量用户失败 → 不铸币（chargedAt 为 null → 一分不退、无流水）', async () => {
    const { token, tenantId } = await posterUser(0, '不限量出图');
    await grantCredits(tenantId, token, -1, '测试不限量');
    assert.equal(await getBalance(token), -1);
    const ledgerBefore = await prisma.creditLedger.count({ where: { userId: token } });

    const jobId = await createJob(token, 'r-unlimited');
    await poisonTemplate(jobId);
    for (let i = 0; i < MAX_ATTEMPTS; i++) await tickCreativeWorker();

    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, 'failed');
    assert.equal(job.chargedAt, null, '不限量用户从未真扣');
    assert.equal(job.refundedAt, null, '因此也不该被标记已退');
    assert.equal(job.creditCost, PRICE, '名义价仍记录（成本统计口径）');
    assert.equal(await getBalance(token), -1, '余额仍是不限量');
    assert.equal(await prisma.creditLedger.count({ where: { userId: token } }), ledgerBefore, '一条流水都不该新增');

    // 兜底扫描也不许给它凭空补钱
    await sweepCreativeJobs();
    assert.equal(await prisma.creditLedger.count({ where: { userId: token } }), ledgerBefore);
    assert.equal(await getBalance(token), -1);
  });

  test('revise 任务失败 → 不退款（creditCost=0 本就没扣）', async () => {
    const { token } = await posterUser();
    const parentId = await createJob(token, 'r-rev-1');
    await tickCreativeWorker();
    const balance = await getBalance(token);

    const revised = await api('POST', `/api/creative/jobs/${parentId}/revise`, { token, body: { headline: '再改一版', idempotencyKey: 'r-rev-2' } });
    await poisonTemplate(revised.body.jobId);
    for (let i = 0; i < MAX_ATTEMPTS; i++) await tickCreativeWorker();

    const child = await prisma.creativeJob.findUniqueOrThrow({ where: { id: revised.body.jobId } });
    assert.equal(child.status, 'failed');
    assert.equal(child.chargedAt, null);
    assert.equal(child.refundedAt, null);
    assert.equal(await getBalance(token), balance, 'revise 失败不产生任何资金流动');
  });
});

describe('海报成品图 · sweep 自愈', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); __clearFeatureCache(); });

  /** 把任务摆成「卡死的 running」：startedAt 推到 11 分钟前。 */
  async function staleRunning(jobId: string, attempts: number): Promise<void> {
    await prisma.creativeJob.update({
      where: { id: jobId },
      data: {
        status: 'running',
        progress: 'render',
        attempts,
        startedAt: new Date(Date.now() - STALE_RUNNING_MS - 60_000),
      },
    });
  }

  test('卡死 running（attempts 未超限）→ sweep 回 pending，钱不动', async () => {
    const { token } = await posterUser();
    const before = await getBalance(token);
    const jobId = await createJob(token, 's-requeue');
    await staleRunning(jobId, 1);

    const r = await sweepCreativeJobs();
    assert.equal(r.requeued, 1);
    assert.equal(r.failed, 0);
    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, 'pending');
    assert.equal(job.progress, null);
    assert.equal(job.errorCode, 'STALE_REQUEUED');
    assert.equal(job.refundedAt, null, '还要重跑就不退钱');
    assert.equal(await getBalance(token), before - PRICE);

    // 重新入队后 worker 能把它跑完
    assert.equal(await tickCreativeWorker(), 1);
    assert.equal((await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } })).status, 'succeeded');
  });

  test('卡死 running（attempts 超限）→ sweep 置 failed + 退款一次', async () => {
    const { token } = await posterUser();
    const before = await getBalance(token);
    const jobId = await createJob(token, 's-fail');
    await staleRunning(jobId, MAX_ATTEMPTS + 1);

    const r = await sweepCreativeJobs();
    assert.equal(r.failed, 1);
    assert.equal(r.requeued, 0);
    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, 'failed');
    assert.equal(job.errorCode, 'TIMEOUT');
    assert.ok(job.refundedAt);
    assert.equal(await getBalance(token), before, '超时失败退款');
    assert.equal(await refundLedgerCount(token), 1);

    // 再扫一次：幂等，不重复退
    await sweepCreativeJobs();
    assert.equal(await refundLedgerCount(token), 1);
    assert.equal(await getBalance(token), before);
  });

  test('没到 10 分钟的 running 不被 sweep 动（正在跑的任务不许被抢走）', async () => {
    const { token } = await posterUser();
    const jobId = await createJob(token, 's-fresh');
    await prisma.creativeJob.update({
      where: { id: jobId },
      data: { status: 'running', attempts: 1, startedAt: new Date(Date.now() - 60_000) },
    });
    const r = await sweepCreativeJobs();
    assert.equal(r.requeued, 0);
    assert.equal(r.failed, 0);
    assert.equal((await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } })).status, 'running');
  });

  test('兜底退款：已扣未退的终态任务被 sweep 捞回来退掉（模拟退款曾抛错）', async () => {
    const { token } = await posterUser();
    const before = await getBalance(token);
    const jobId = await createJob(token, 's-orphan');
    // 手工摆成「失败了、扣过钱、没退过」的历史遗留形态
    await prisma.creativeJob.update({
      where: { id: jobId },
      data: { status: 'failed', errorCode: 'INTERNAL', errorMessage: '模拟历史遗留', completedAt: new Date(), refundedAt: null },
    });
    assert.equal(await getBalance(token), before - PRICE);

    await sweepCreativeJobs();
    assert.ok((await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } })).refundedAt, '兜底退款已标记');
    assert.equal(await getBalance(token), before);
    assert.equal(await refundLedgerCount(token), 1);
  });

  test('并发 tick：FOR UPDATE SKIP LOCKED 保证同一任务不被两个 worker 同时跑', async () => {
    const { token } = await posterUser(500);
    const ids = [await createJob(token, 'c-1'), await createJob(token, 'c-2'), await createJob(token, 'c-3')];
    const handled = await Promise.all([tickCreativeWorker(), tickCreativeWorker(), tickCreativeWorker()]);
    assert.equal(handled.reduce((a, b) => a + b, 0), 3, '三个任务恰好被处理三次（没有重复抢占）');
    for (const id of ids) {
      const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id } });
      assert.equal(job.status, 'succeeded', `${id}: ${job.errorCode}`);
      assert.equal(job.attempts, 1, '每个任务只被抢占一次');
      assert.equal(await prisma.creativeAsset.count({ where: { jobId: id, kind: 'poster_png' } }), 1, '不产出重复成品');
    }
  });
});
