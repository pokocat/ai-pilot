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
import { setFeatureFlag, setFeatureFlagPayload, __clearFeatureCache } from '../src/services/featureFlag.js';
import {
  tickCreativeWorker, runJobOnce, sweepCreativeJobs, canRetry, STALE_RUNNING_MS, MAX_ATTEMPTS,
} from '../src/services/creative/worker.js';
import { refundJob } from '../src/services/creative/jobs.js';
import { CREATIVE_FLAG_ID, DEFAULT_PRICE_PER_POSTER } from '../src/services/creative/config.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

const PRICE = DEFAULT_PRICE_PER_POSTER;

/** 打开功能开关并清缓存（行缺失=关，cleanBusiness 每例都把行删了）。 */
async function enableCreative(): Promise<void> {
  await setFeatureFlag(CREATIVE_FLAG_ID, true);
  __clearFeatureCache();
}

/**
 * 反复驱动 worker 直到任务落终态（或达到上限）。
 * 为什么不按 tick 次数循环：一轮 tick 最多连处理 TICK_BATCH_SIZE 单，而失败任务会回 pending，
 * 于是同一轮里可能被再抢一次 —— 「几次 tick」和「几次尝试」不是同一个量。
 * @param onPending 每次驱动前对"仍在排队"的中间态做断言。
 */
async function drainJob(
  jobId: string,
  onPending?: (job: { status: string; attempts: number; refundedAt: Date | null }) => Promise<void> | void,
): Promise<void> {
  for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    if (job.status !== 'pending' && job.status !== 'running') return;
    if (onPending) await onPending(job);
    await tickCreativeWorker();
  }
  throw new Error(`任务 ${jobId} 在 ${MAX_ATTEMPTS + 3} 轮后仍未落终态`);
}

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
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); await enableCreative(); });

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

  // K5：这条用例的标题声称两件事，此前一件都没断言 —— 而且测试环境没有图片供应商，父任务本就
  // 不产出 visual 资产，所以 reusableVisualAssetId() / sourceVisualAssetId / worker 的复用分支
  // **整条零覆盖**。修法：手工往父任务插一条 kind='visual' 的资产，再验子任务真的复用了它。
  test('revise 复用父任务主视觉：sourceVisualAssetId 命中、不新增 visual 资产、不扣费、仍出一张新成品', async () => {
    const { token, tenantId } = await posterUser();
    const parentId = await createJob(token, 'w-rev-1');
    await tickCreativeWorker();
    const balanceAfterParent = await getBalance(token);

    // 模拟「父任务当年配了供应商、产出过主视觉」：内存回退区里没有这个 key，
    // 渲染取图会拿到 null 并按无图路径继续 —— 复用链路本身与字节是否可读无关。
    const parentVisual = await prisma.creativeAsset.create({
      data: {
        tenantId, userId: token, jobId: parentId, kind: 'visual',
        ossKey: `creative/${tenantId}/${parentId}/fake-visual.png`, mimeType: 'image/png', bytes: 1,
      },
    });

    const revised = await api('POST', `/api/creative/jobs/${parentId}/revise`, { token, body: { headline: '换个说法', idempotencyKey: 'w-rev-2' } });
    assert.equal(revised.status, 200, JSON.stringify(revised.body));

    // 建单时就把来源资产写进 requestJson（worker 据此跳过 visual 阶段）
    const childRow = await prisma.creativeJob.findUniqueOrThrow({ where: { id: revised.body.jobId } });
    assert.equal(
      (childRow.requestJson as { sourceVisualAssetId?: string }).sourceVisualAssetId,
      parentVisual.id,
      'revise 必须沿版本链找到父任务的主视觉并记下来（否则复用分支永远走不到）',
    );

    await tickCreativeWorker();
    const child = await prisma.creativeJob.findUniqueOrThrow({ where: { id: revised.body.jobId } });
    assert.equal(child.status, 'succeeded', `${child.errorCode} ${child.errorMessage}`);
    assert.equal(child.creditCost, 0);
    assert.equal(await getBalance(token), balanceAfterParent, 'revise 全程零扣费');
    // 结果里把复用的主视觉记下来，且**没有**新产出 visual 资产（复用的意义就在这里）
    assert.equal((child.resultJson as { visualAssetId: string | null }).visualAssetId, parentVisual.id);
    assert.equal(await prisma.creativeAsset.count({ where: { jobId: child.id, kind: 'visual' } }), 0, '子任务不该新产 visual');
    assert.equal(await prisma.creativeAsset.count({ where: { kind: 'visual' } }), 1, '全库仍只有那一张主视觉');
    // 父任务资产不被覆盖（版本链上各自一张成品）
    assert.equal(await prisma.creativeAsset.count({ where: { jobId: parentId, kind: 'poster_png' } }), 1);
    assert.equal(await prisma.creativeAsset.count({ where: { jobId: child.id, kind: 'poster_png' } }), 1);
  });

  // D1：BrandKit 集成此前在生产走不到（确认页 submit 重拼 brief 时丢了 brandKitVersion），
  // 于是 approvedBrandKit() / 品牌提示块 / 色板表 / 语气合并全是死代码。服务端这一侧必须有覆盖：
  // 带 brandKitVersion 的任务要真的把品牌语气与色板带进视觉哲学（落在 promptSnapshot 里可验）。
  test('brief 带 brandKitVersion → 已确认 BrandKit 的语气与色板进入 promptSnapshot', async () => {
    const { token, tenantId } = await posterUser();
    await prisma.brandKit.create({
      data: {
        tenantId, userId: token, version: 3, approvedAt: new Date(),
        personaJson: { name: '增长顾问', tagline: '十年操盘', tone: '沉稳克制、只说做得到的事', story: '', doNots: [] },
        voiceJson: { hooks: [], openers: [], ctas: [], taboos: ['浮夸'] },
        // colorHint 命中 THEME_HINT_COLORS 的「金」一档 → 回退色板换成金色系
        themeJson: { keywords: ['克制'], colorHint: '金属金', styleRefs: [] },
      },
    });

    const r = await api('POST', '/api/creative/posters', {
      token,
      body: { brief: { ...brief({ brandKitVersion: 3 }) }, idempotencyKey: 'w-brandkit' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await tickCreativeWorker();

    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: r.body.jobId } });
    assert.equal(job.status, 'succeeded', `${job.errorCode} ${job.errorMessage}`);
    const snapshot = job.promptSnapshot ?? '';
    assert.match(snapshot, /沿用品牌语气：沉稳克制、只说做得到的事/, 'BrandKit 的 persona.tone 必须并进气质');
    assert.match(snapshot, /#C9A227/, 'theme.colorHint「金」应命中金色系色板（THEME_HINT_COLORS）');

    // 反证：不带 brandKitVersion 的同一份 brief 不会带上品牌痕迹（说明上面命中的不是巧合）
    const plain = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'w-nokit' } });
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    await tickCreativeWorker();
    const plainSnapshot = (await prisma.creativeJob.findUniqueOrThrow({ where: { id: plain.body.jobId } })).promptSnapshot ?? '';
    assert.doesNotMatch(plainSnapshot, /沿用品牌语气/, '没引用资产包就不该出现品牌语气');
  });

  // D3：成功写入此前是无守卫的 update（失败路径一直有守卫）。叠加 D4 的阈值错配就会出现
  // 「sweep 把长渲染判为卡死回队 → 另一个 worker 跑完置终态 → 老进程回来覆盖终态」，
  // 结果同一单挂着两张成品资产。守卫要在**入口**判：管线中途 saveAsset 已经落库了就来不及了。
  test('终态任务被再驱动一次：资产不翻倍、终态与 resultJson 不被覆盖', async () => {
    const { token } = await posterUser();
    const jobId = await createJob(token, 'w-double');
    await tickCreativeWorker();

    const first = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(first.status, 'succeeded');
    const firstResult = JSON.stringify(first.resultJson);
    const firstCompletedAt = first.completedAt?.toISOString();

    // 直接再驱动一次（模拟老进程回来收口 / 运维误并发驱动同一个 id）
    const outcome = await runJobOnce(jobId);
    assert.equal(outcome.status, 'skipped', '已收口的任务应被跳过，而不是当成功或失败处理');

    const again = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(again.status, 'succeeded');
    assert.equal(again.completedAt?.toISOString(), firstCompletedAt, '终态时间不被改写');
    assert.equal(JSON.stringify(again.resultJson), firstResult, 'resultJson 不被本轮结果覆盖');
    assert.equal(await prisma.creativeAsset.count({ where: { jobId, kind: 'poster_png' } }), 1, '成品资产不翻倍');
    assert.equal(again.refundedAt, null, '跳过不该触发退款');
    assert.equal(await refundLedgerCount(token), 0);
  });

  // D7：供应商降级此前零痕迹 —— 只 console.warn，而 provider 列是建单时的 'configured' 快照，
  // metrics 也用它 → 供应商挂一整天，任务台与监控全绿，用户拿到的全是"无主视觉"版。
  test('图片供应商不可用 → 任务仍成功，但 resultJson.degraded=true 且任务台可见', async () => {
    const { token } = await posterUser();
    // 配一个必然打不通的供应商：127.0.0.1 会被 assertSafeUrl 的 SSRF 防护直接拦下，
    // 不依赖任何真实网络（也不会误发请求到外部）。
    await setFeatureFlagPayload(CREATIVE_FLAG_ID, {
      visual: { enabled: true, baseUrl: 'http://127.0.0.1:9/v1', model: 'demo-model' },
    });
    __clearFeatureCache();

    const jobId = await createJob(token, 'w-degraded');
    assert.equal(
      (await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } })).provider,
      'configured',
      '建单时供应商配着 → 快照是 configured（正是它让降级看不出来）',
    );
    await tickCreativeWorker();

    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, 'succeeded', `纯排版本身是完整交付物，不该失败：${job.errorCode} ${job.errorMessage}`);
    const result = job.resultJson as { degraded?: boolean; visualError?: string; visualAssetId: string | null };
    assert.equal(result.degraded, true, '配了供应商却没拿到主视觉 = 降级，必须留痕');
    assert.ok(result.visualError && result.visualError.length > 0, '带一句对外可读的说明');
    assert.doesNotMatch(String(result.visualError), /127\.0\.0\.1|ECONNREFUSED|SSRF/i, '对外文案不含内部细节');
    assert.equal(result.visualAssetId, null);
    assert.equal(await prisma.creativeAsset.count({ where: { jobId, kind: 'visual' } }), 0);

    // 任务台看得见（老任务无该字段按 false，这里是新任务 → true）
    const list = await api('GET', '/api/admin/creative/jobs');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.items[0].degraded, true, '运营在任务台上要能看出这一单没有主视觉');
  });

  test('未配供应商的正常任务：degraded=false（"没配"不是"降级"）', async () => {
    const { token } = await posterUser();
    const jobId = await createJob(token, 'w-not-degraded');
    await tickCreativeWorker();
    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, 'succeeded');
    assert.equal((job.resultJson as { degraded?: boolean }).degraded, false);
    assert.equal(job.provider, null, '没配供应商时建单快照就是 null');
    assert.equal((await api('GET', '/api/admin/creative/jobs')).body.items[0].degraded, false);
  });

  test('渲染抛错 → 重试用尽后 failed + 退款一次（退款流水只有一条）', async () => {
    const { token } = await posterUser();
    const before = await getBalance(token);
    const jobId = await createJob(token, 'w-fail');
    assert.equal(await getBalance(token), before - PRICE, '建单即实扣');
    await poisonTemplate(jobId);

    // 中途每一次仍在排队时：状态回 pending 等重试、不退款、钱不动
    let midChecks = 0;
    await drainJob(jobId, async (mid) => {
      midChecks += 1;
      assert.equal(mid.status, 'pending', '失败后回队列重试，不该停在 running');
      assert.ok(mid.attempts < MAX_ATTEMPTS, `还能重试的任务 attempts 必须 < ${MAX_ATTEMPTS}，实际 ${mid.attempts}`);
      assert.equal(mid.refundedAt, null, '还要重试的任务不退款');
      assert.equal(await getBalance(token), before - PRICE);
    });
    assert.ok(midChecks >= 2, `应经历多次重试（实际驱动 ${midChecks} 次）`);

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

    await setFeatureFlag(CREATIVE_FLAG_ID, false);
    assert.equal(await tickCreativeWorker(), 0, '关着不抢任务');
    assert.equal((await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } })).status, 'pending');

    await setFeatureFlag(CREATIVE_FLAG_ID, true);
    assert.equal(await tickCreativeWorker(), 1, '开回来继续跑');
    assert.equal((await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } })).status, 'succeeded');
  });
});

describe('海报成品图 · 退款不变量', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); await enableCreative(); });

  test('已退款任务再触发退款路径 → 不二次退', async () => {
    const { token } = await posterUser();
    const before = await getBalance(token);
    const jobId = await createJob(token, 'r-once');
    await poisonTemplate(jobId);
    await drainJob(jobId);
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
    await drainJob(jobId);
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
    await drainJob(jobId);
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
    await drainJob(jobId);
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
    await drainJob(jobId);

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
    await drainJob(revised.body.jobId);

    const child = await prisma.creativeJob.findUniqueOrThrow({ where: { id: revised.body.jobId } });
    assert.equal(child.status, 'failed');
    assert.equal(child.chargedAt, null);
    assert.equal(child.refundedAt, null);
    assert.equal(await getBalance(token), balance, 'revise 失败不产生任何资金流动');
  });
});

describe('海报成品图 · sweep 自愈', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); await enableCreative(); });

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

  // D5：worker 收口与 sweep 回收必须用同一把尺子（canRetry）。此前两处分别写 `<` 与 `<=`，
  // 于是 attempts 正好等于 MAX_ATTEMPTS 的任务被 worker 判为"重试用尽、终态失败"，
  // 同一个数在 sweep 眼里却还能再入队一次。这里用 MAX_ATTEMPTS（而不是 +1）钉住边界。
  test('卡死 running（attempts 已用尽）→ sweep 置 failed + 退款一次', async () => {
    assert.equal(canRetry(MAX_ATTEMPTS - 1), true, '还差一次：可重试');
    assert.equal(canRetry(MAX_ATTEMPTS), false, `attempts=${MAX_ATTEMPTS} 就是用尽 —— worker 与 sweep 同一判定`);

    const { token } = await posterUser();
    const before = await getBalance(token);
    const jobId = await createJob(token, 's-fail');
    await staleRunning(jobId, MAX_ATTEMPTS);

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
