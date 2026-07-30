// 海报成品图（canvas_design）P5 测试之一：接口层 —— 门禁 / 校验 / 幂等 / 计费 / status / brief 草稿。
// worker 生命周期、sweep 与退款不变量在 test/creativeWorker.test.ts。
//
// 两个必须知道的前提（否则用例会莫名全红）：
//   ① `env.canvasDesignEnabled` 是**模块加载时冻结**的单例（src/env.ts），用例里改 process.env 已经太晚，
//      而 hermeticEnv.mjs 又会抹掉进程启动后新增的键 → 故开关写在 `.env.test`（CANVAS_DESIGN_ENABLED=true）。
//      DB 那一层（FeatureFlag 行 'creative-poster'）才是用例可控的，用来验「双开关合取」。
//   ② featureFlag 读有 60s 内存缓存，而 cleanBusiness() 只删库不清缓存 → 每次改开关后必须 __clearFeatureCache()。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.js';
import { grantCredits, getBalance } from '../src/services/credits.js';
import { setFeatureFlag, setFeatureFlagPayload, __clearFeatureCache } from '../src/services/featureFlag.js';
import { CREATIVE_FLAG_ID, DEFAULT_PRICE_PER_POSTER } from '../src/services/creative/config.js';
import { parseTemplateRecommendation } from '../src/services/creative/briefDraft.js';
import { normalizePosterBrief } from '../src/services/creative/schema.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

const PRICE = DEFAULT_PRICE_PER_POSTER; // 10 钻/张（后台可改，用例按默认值断言）

/** 一份合法 brief（各用例按需覆盖字段）。 */
function brief(over: Record<string, unknown> = {}) {
  return {
    scene: 'personal_brand',
    goal: '拉到 20 个咨询线索',
    audience: '中小企业主',
    headline: '增长顾问',
    subheadline: '十年操盘经验',
    proofPoints: ['服务 200+ 客户', '平均 3 周见效'],
    cta: '扫码预约',
    visualDirection: '克制的深色背景，人物居中',
    ratio: '3:4',
    ...over,
  };
}

/** 建一个「已解锁 poster + 有钻石」的用户。 */
async function posterUser(credits = 100, name = '海报用户'): Promise<{ token: string; tenantId: string }> {
  const token = await login(uniquePhone(), name);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { tenantId: true } });
  await prisma.userAgent.create({ data: { userId: token, agentKey: 'poster', source: 'admin_grant' } });
  // login 已按测试期默认套餐赠了 20 钻，这里再叠加到够跑多次的量。
  await grantCredits(user.tenantId, token, credits, '测试充值');
  return { token, tenantId: user.tenantId };
}

/** 造一条「海报设计师」的成果消息（brief 草稿与 messageId 归属都以它为锚）。 */
async function reportMessage(userId: string, tenantId: string, opts: { agentKey?: string; content?: unknown } = {}): Promise<string> {
  const session = await prisma.session.create({
    data: { tenantId, userId, agentKey: opts.agentKey ?? 'poster', title: '海报方案' },
  });
  const msg = await prisma.message.create({
    data: {
      sessionId: session.id,
      role: 'report',
      contentJson: (opts.content ?? {
        title: '个人品牌海报方案',
        meta: '海报设计师 · 主视觉与文案',
        sections: [
          { h: '主视觉概念', b: '深色背景 + 人物半身，留出上部负空间' },
          { h: '文案', list: ['主标题：增长顾问', '副标题：十年操盘经验'] },
          { h: '版式建议', b: '成品图版式推荐：人物主视觉（person_hero）—— 你的信任感来自本人出镜' },
        ],
        actions: ['save_to_library'],
      }) as object,
    },
  });
  return msg.id;
}

before(async () => { await getApp(); });
after(async () => { await closeApp(); });

describe('海报成品图 · 建单门禁与校验', () => {
  beforeEach(async () => {
    await cleanBusiness();
    await seedBaseline();
    __clearFeatureCache(); // cleanBusiness 删了 FeatureFlag 行，但缓存还留着上一个用例写的值
  });

  test('未解锁 poster → 403 AGENT_LOCKED（早于扣费）', async () => {
    const token = await login(uniquePhone(), '未解锁用户');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { tenantId: true } });
    await grantCredits(user.tenantId, token, 100, '测试充值');
    const before = await getBalance(token);

    const r = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'k-locked' } });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'AGENT_LOCKED');
    assert.equal(await getBalance(token), before, '门禁拦住时一分钱都不该扣');
    assert.equal(await prisma.creativeJob.count(), 0, '不该留下任务行');
  });

  test('后台熔断（DB 开关 off）→ 403 CANVAS_DISABLED；重新打开后放行', async () => {
    const { token } = await posterUser();
    await setFeatureFlag(CREATIVE_FLAG_ID, false);

    const off = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'k-off' } });
    assert.equal(off.status, 403, JSON.stringify(off.body));
    assert.equal(off.body.code, 'CANVAS_DISABLED');
    assert.equal(await prisma.creativeJob.count(), 0);

    await setFeatureFlag(CREATIVE_FLAG_ID, true);
    const on = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'k-on' } });
    assert.equal(on.status, 201, JSON.stringify(on.body));
  });

  test('钻石不足 → 402 INSUFFICIENT_CREDITS，不建任务', async () => {
    const token = await login(uniquePhone(), '穷用户');
    await prisma.userAgent.create({ data: { userId: token, agentKey: 'poster', source: 'admin_grant' } });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { tenantId: true } });
    // 把余额压到 3（不足 10）
    await prisma.creditLedger.create({ data: { tenantId: user.tenantId, userId: token, delta: -17, reason: '测试压低余额', balance: 3 } });

    const r = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'k-402' } });
    assert.equal(r.status, 402, JSON.stringify(r.body));
    assert.equal(r.body.code, 'INSUFFICIENT_CREDITS');
    assert.equal(await prisma.creativeJob.count(), 0);
    assert.equal(await getBalance(token), 3, '余额不动');
  });

  test('日限额 → 429 CREATIVE_DAILY_LIMIT', async () => {
    const { token } = await posterUser(500);
    await setFeatureFlagPayload(CREATIVE_FLAG_ID, { dailyLimit: 2 });
    __clearFeatureCache();

    for (const k of ['d1', 'd2']) {
      const ok = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: k } });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
    }
    const r = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'd3' } });
    assert.equal(r.status, 429, JSON.stringify(r.body));
    assert.equal(r.body.code, 'CREATIVE_DAILY_LIMIT');
    assert.equal(await prisma.creativeJob.count(), 2, '超限的那次没建任务');
  });

  test('越权读任务/资产 → 404（不区分「不存在」与「不是你的」）', async () => {
    const { token: mine } = await posterUser(100, '资产主人');
    const { token: other } = await posterUser(100, '路人');
    const created = await api('POST', '/api/creative/posters', { token: mine, body: { brief: brief(), idempotencyKey: 'own' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const jobId = created.body.jobId;

    const peek = await api('GET', `/api/creative/jobs/${jobId}`, { token: other });
    assert.equal(peek.status, 404);
    assert.equal(peek.body.code, 'NOT_FOUND');
    assert.equal((await api('GET', `/api/creative/jobs/${jobId}`, { token: mine })).status, 200, '本人能读');

    // 资产文件同口径
    const asset = await prisma.creativeAsset.create({
      data: { tenantId: (await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } })).tenantId, userId: mine, jobId, kind: 'poster_png', ossKey: 'creative/x/y/z.png', mimeType: 'image/png' },
    });
    const stolen = await api('GET', `/api/creative/assets/${asset.id}/file`, { token: other });
    assert.equal(stolen.status, 404, '别人的资产一律 404');
  });

  test('未登录 → 401（所有 creative 端点）', async () => {
    for (const url of ['/api/creative/status', '/api/creative/posters/brief-draft?messageId=x', '/api/creative/jobs/abc']) {
      const r = await api('GET', url);
      assert.equal(r.status, 401, `${url} 应 401，实际 ${r.status}`);
    }
  });

  test('headline 超 20 字 → 422（不静默截断）', async () => {
    const { token } = await posterUser();
    const long = '一二三四五六七八九十一二三四五六七八九十一'; // 21 字
    const r = await api('POST', '/api/creative/posters', { token, body: { brief: brief({ headline: long }), idempotencyKey: 'k-long' } });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, 'BRIEF_INVALID');
    assert.equal(await prisma.creativeJob.count(), 0);
  });

  test('ratio 非 3:4 → 422（能力未就绪，不兜底出错版式）', async () => {
    const { token } = await posterUser();
    const r = await api('POST', '/api/creative/posters', { token, body: { brief: brief({ ratio: '9:16' }), idempotencyKey: 'k-ratio' } });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, 'BRIEF_INVALID');
  });

  test('templateKey 无效 → 201 且 requestJson 落 scene 默认模板', async () => {
    const { token } = await posterUser();
    const r = await api('POST', '/api/creative/posters', { token, body: { brief: brief({ templateKey: 'not_a_template' }), idempotencyKey: 'k-tpl' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: r.body.jobId } });
    const saved = (job.requestJson as { brief: { templateKey: string } }).brief;
    assert.equal(saved.templateKey, 'person_hero', 'personal_brand 的默认模板');
  });

  test('idempotencyKey 非法 → 422 IDEMPOTENCY_KEY_INVALID', async () => {
    const { token } = await posterUser();
    const r = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: '不合法 key!' } });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, 'IDEMPOTENCY_KEY_INVALID');
  });

  test('引用别人的素材 → 422 ASSET_NOT_FOUND', async () => {
    const { token: mine } = await posterUser(100, '素材主人');
    const { token: other, tenantId: otherTenant } = await posterUser(100, '借图的人');
    const asset = await prisma.creativeAsset.create({
      data: { tenantId: otherTenant, userId: other, jobId: null, kind: 'source', ossKey: 'creative/a/_loose/b.png', mimeType: 'image/png' },
    });
    const r = await api('POST', '/api/creative/posters', { token: mine, body: { brief: brief({ portraitAssetId: asset.id }), idempotencyKey: 'k-asset' } });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, 'ASSET_NOT_FOUND');
  });
});

describe('海报成品图 · 幂等与计费', () => {
  beforeEach(async () => {
    await cleanBusiness();
    await seedBaseline();
    __clearFeatureCache();
  });

  test('同 (userId, idempotencyKey) 重复创建：只 1 个任务、只扣一次 10 钻', async () => {
    const { token } = await posterUser(100);
    const before = await getBalance(token);

    const first = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'same-key' } });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.reused, false);
    assert.equal(first.body.creditCost, PRICE);

    const again = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'same-key' } });
    assert.equal(again.status, 200, '命中幂等键回 200 而非 409（重复点击是正常结果）');
    assert.equal(again.body.reused, true);
    assert.equal(again.body.jobId, first.body.jobId);

    assert.equal(await prisma.creativeJob.count({ where: { userId: token } }), 1, '只 1 个任务');
    assert.equal(await getBalance(token), before - PRICE, '只扣一次');
  });

  test('并发同 key（6 路齐发）：唯一约束兜住 → 1 个任务、1 次扣费', async () => {
    const { token } = await posterUser(200);
    const before = await getBalance(token);

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'race-key' } })),
    );
    const ok = results.filter((r) => r.status === 201 || r.status === 200);
    assert.equal(ok.length, 6, `全部应成功返回同一任务：${JSON.stringify(results.map((r) => [r.status, r.body?.code]))}`);
    const ids = new Set(ok.map((r) => r.body.jobId));
    assert.equal(ids.size, 1, '六路拿到同一个 jobId');
    assert.equal(await prisma.creativeJob.count({ where: { userId: token } }), 1);
    assert.equal(await getBalance(token), before - PRICE, '并发也只扣一次');
  });

  test('不限量用户（余额 -1）：creditCost 记名义价但 chargedAt 为 null（退款路径不铸币）', async () => {
    const { token, tenantId } = await posterUser(0, '不限量用户');
    await grantCredits(tenantId, token, -1, '测试不限量'); // 余额写 -1
    assert.equal(await getBalance(token), -1);

    const r = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'k-unlimited' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: r.body.jobId } });
    assert.equal(job.creditCost, PRICE, '名义价照记（成本统计看这里）');
    assert.equal(job.chargedAt, null, 'chargedAt 严格是「真扣到钻石」——不限量用户零流水，必须为 null');
    assert.equal(await getBalance(token), -1, '不限量余额不动');
  });

  test('revise 不扣钻石（creditCost=0）；regenerate 再扣 10', async () => {
    const { token } = await posterUser(200);
    const created = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'k-base' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const afterCreate = await getBalance(token);

    const revised = await api('POST', `/api/creative/jobs/${created.body.jobId}/revise`, { token, body: { headline: '新主标题', idempotencyKey: 'k-revise' } });
    assert.equal(revised.status, 200, JSON.stringify(revised.body));
    assert.equal(revised.body.creditCost, 0, 'revise 不收费');
    assert.equal(await getBalance(token), afterCreate, 'revise 余额不动');
    const rJob = await prisma.creativeJob.findUniqueOrThrow({ where: { id: revised.body.jobId } });
    assert.equal(rJob.parentJobId, created.body.jobId, 'revise 挂版本链');
    assert.equal(rJob.chargedAt, null, '不扣费路径 chargedAt 必须为 null');
    assert.equal((rJob.requestJson as { brief: { headline: string } }).brief.headline, '新主标题');

    const regen = await api('POST', `/api/creative/jobs/${created.body.jobId}/regenerate`, { token, body: { visualDirection: '换成浅色背景', idempotencyKey: 'k-regen' } });
    assert.equal(regen.status, 200, JSON.stringify(regen.body));
    assert.equal(regen.body.creditCost, PRICE, 'regenerate 重出主视觉要再扣');
    assert.equal(await getBalance(token), afterCreate - PRICE);
    const gJob = await prisma.creativeJob.findUniqueOrThrow({ where: { id: regen.body.jobId } });
    assert.ok(gJob.chargedAt, 'regenerate 已扣');
    assert.equal(gJob.parentJobId, created.body.jobId);
  });

  test('revise 只能改文案：视觉方向/场景沿用父任务', async () => {
    const { token } = await posterUser(200);
    const created = await api('POST', '/api/creative/posters', {
      token, body: { brief: brief({ visualDirection: '原始视觉方向' }), idempotencyKey: 'k-scope' },
    });
    const revised = await api('POST', `/api/creative/jobs/${created.body.jobId}/revise`, {
      token,
      // 故意塞进 revise 不接受的字段
      body: { headline: '只改这个', visualDirection: '偷偷换视觉', scene: 'product', idempotencyKey: 'k-scope-2' },
    });
    assert.equal(revised.status, 200, JSON.stringify(revised.body));
    const saved = (await prisma.creativeJob.findUniqueOrThrow({ where: { id: revised.body.jobId } })).requestJson as
      { brief: { visualDirection: string; scene: string; headline: string } };
    assert.equal(saved.brief.headline, '只改这个');
    assert.equal(saved.brief.visualDirection, '原始视觉方向', 'revise 不得改视觉方向（那属于 regenerate）');
    assert.equal(saved.brief.scene, 'personal_brand', 'revise 不得改场景');
  });

  test('pending 任务取消 → cancelled + 退款一次', async () => {
    const { token } = await posterUser(100);
    const before = await getBalance(token);
    const created = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'k-cancel' } });
    assert.equal(await getBalance(token), before - PRICE);

    const r = await api('POST', `/api/creative/jobs/${created.body.jobId}/cancel`, { token, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'cancelled');
    assert.equal(r.body.refunded, true);
    assert.equal(await getBalance(token), before, '钱退回来了');

    // 再取消一次：不二次退款
    await api('POST', `/api/creative/jobs/${created.body.jobId}/cancel`, { token, body: {} });
    assert.equal(await getBalance(token), before, '重复取消不重复退款');
    assert.equal(
      await prisma.creditLedger.count({ where: { userId: token, delta: PRICE, reason: { contains: '海报成品图' } } }),
      1,
      '退款流水只有一条',
    );
  });
});

describe('海报成品图 · status 与 brief 草稿', () => {
  beforeEach(async () => {
    await cleanBusiness();
    await seedBaseline();
    __clearFeatureCache();
  });

  test('GET /creative/status：env && DB 合取 + 价格透传', async () => {
    const { token } = await posterUser();
    const on = await api('GET', '/api/creative/status', { token });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.enabled, true, 'env(.env.test)=true 且 DB 缺省视为开 → 开');
    assert.equal(on.body.pricePerPoster, PRICE);

    // 后台改价 → 透传（同一次配置写入也验证 payload 合并不丢开关）
    await setFeatureFlagPayload(CREATIVE_FLAG_ID, { pricePerPoster: 18 });
    __clearFeatureCache();
    const priced = await api('GET', '/api/creative/status', { token });
    assert.equal(priced.body.pricePerPoster, 18, '价格来自后台配置，不硬编码');

    await setFeatureFlag(CREATIVE_FLAG_ID, false);
    const off = await api('GET', '/api/creative/status', { token });
    assert.equal(off.body.enabled, false, 'DB 一层关掉即整体关闭');
  });

  test('brief-draft：无 provider 也不抛错，返回可用预填 + templateKey/templateReason', async () => {
    const { token, tenantId } = await posterUser();
    const messageId = await reportMessage(token, tenantId);

    const r = await api('GET', `/api/creative/posters/brief-draft?messageId=${messageId}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.brief.ratio, '3:4');
    assert.equal(r.body.brief.scene, 'personal_brand', 'poster agent → personal_brand');
    assert.ok(r.body.brief.headline, 'headline 至少兜到成果标题');
    // 兜底层②：从成果原文的「成品图版式推荐」行解析
    assert.equal(r.body.brief.templateKey, 'person_hero');
    assert.ok(r.body.templateReason && r.body.templateReason.length > 0, '带一句给客户看的理由');
  });

  test('brief-draft：无推荐行时按 scene 默认模板兜底', async () => {
    const { token, tenantId } = await posterUser();
    const messageId = await reportMessage(token, tenantId, {
      agentKey: 'promo',
      content: { title: '开业活动方案', sections: [{ h: '节奏', b: '预热三天，当天开场' }] },
    });
    const r = await api('GET', `/api/creative/posters/brief-draft?messageId=${messageId}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.brief.scene, 'event', 'promo agent → event');
    assert.equal(r.body.brief.templateKey, 'business_launch', 'event 的默认模板');
  });

  test('brief-draft：越权 messageId → 404；缺 messageId → 422', async () => {
    const { token } = await posterUser(100, '本人');
    const { token: other, tenantId: otherTenant } = await posterUser(100, '别人');
    const foreign = await reportMessage(other, otherTenant);

    const stolen = await api('GET', `/api/creative/posters/brief-draft?messageId=${foreign}`, { token });
    assert.equal(stolen.status, 404, JSON.stringify(stolen.body));
    assert.equal(stolen.body.code, 'MESSAGE_NOT_FOUND');

    const missing = await api('GET', '/api/creative/posters/brief-draft', { token });
    assert.equal(missing.status, 422);
    assert.equal(missing.body.code, 'MESSAGE_ID_REQUIRED');
  });

  test('建单挂越权 messageId → 404 MESSAGE_NOT_FOUND，不扣费', async () => {
    const { token } = await posterUser(100, '本人2');
    const { token: other, tenantId: otherTenant } = await posterUser(100, '别人2');
    const foreign = await reportMessage(other, otherTenant);
    const before = await getBalance(token);

    const r = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), messageId: foreign, idempotencyKey: 'k-foreign' } });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.code, 'MESSAGE_NOT_FOUND');
    assert.equal(await getBalance(token), before, '归属校验失败不扣费');
    assert.equal(await prisma.creativeJob.count({ where: { userId: token } }), 0);
  });
});

describe('海报成品图 · 运营后台配置与任务台', () => {
  beforeEach(async () => {
    await cleanBusiness();
    await seedBaseline();
    __clearFeatureCache();
  });

  test('配置读写：改价即时生效、apiKey 只回 hasKey、局部更新不丢字段、envEnabled 如实回传', async () => {
    const got = await api('GET', '/api/admin/creative/config');
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.pricePerPoster, PRICE);
    assert.equal(got.body.envEnabled, true, '部署级开关如实回传（.env.test 里为 true）');
    assert.equal(got.body.visual.hasKey, false);

    const put = await api('PUT', '/api/admin/creative/config', {
      body: { pricePerPoster: 15, dailyLimit: 5, visual: { enabled: true, baseUrl: 'https://example.invalid/v1/images', model: 'demo-model', apiKey: 'sk-secret-value' } },
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.pricePerPoster, 15);
    assert.equal(put.body.dailyLimit, 5);
    assert.equal(put.body.visual.hasKey, true, '只回 hasKey');
    assert.equal((put.body.visual as Record<string, unknown>).apiKey, undefined, '绝不回明文密钥');

    // 局部更新：不传 apiKey 保留原密钥；传空串清空
    const partial = await api('PUT', '/api/admin/creative/config', { body: { dailyLimit: 7 } });
    assert.equal(partial.body.visual.hasKey, true, '未传 apiKey → 保留库内密钥');
    assert.equal(partial.body.pricePerPoster, 15, '未传的字段保持原值');
    assert.equal(partial.body.visual.model, 'demo-model');
    const cleared = await api('PUT', '/api/admin/creative/config', { body: { visual: { apiKey: '' } } });
    assert.equal(cleared.body.visual.hasKey, false, '空串 = 清空密钥');

    // 改完价格 C 端立即（写入即清缓存）按新价扣费
    __clearFeatureCache();
    const { token } = await posterUser(100);
    const created = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'k-priced' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.creditCost, 15, '按后台价扣费，不是硬编码 10');
  });

  test('配了主密钥时 apiKey 落密文（未配主密钥全仓按设计透传，见 services/secretBox.ts）', async () => {
    process.env.APP_ENCRYPTION_KEY = 'creative-test-master-key';
    try {
      const enc = await api('PUT', '/api/admin/creative/config', {
        body: { visual: { enabled: true, baseUrl: 'https://example.invalid/v1/images', model: 'demo-model', apiKey: 'sk-secret-value' } },
      });
      assert.equal(enc.status, 200, JSON.stringify(enc.body));
      assert.equal(enc.body.visual.hasKey, true, '写完能读回（说明解得开）');
      const stored = JSON.stringify((await prisma.featureFlag.findUniqueOrThrow({ where: { id: CREATIVE_FLAG_ID } })).payload);
      assert.ok(!stored.includes('sk-secret-value'), '库里不含明文密钥');
      assert.ok(stored.includes('enc:v1:'), '带 secretBox 版本前缀');
      // 清掉密钥，避免残留密文影响后续用例（本 describe 每例都会 cleanBusiness，这里只是显式收尾）
      await api('PUT', '/api/admin/creative/config', { body: { visual: { apiKey: '' } } });
    } finally {
      delete process.env.APP_ENCRYPTION_KEY;
    }
  });

  test('无管理员令牌 → 401；任务台汇总含退款计数与脱敏用户标识', async () => {
    const anon = await api('GET', '/api/admin/creative/jobs', { adminToken: false });
    assert.equal(anon.status, 401, '没令牌进不来');

    const { token } = await posterUser(100, '张三');
    const created = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'k-admin-list' } });
    await api('POST', `/api/creative/jobs/${created.body.jobId}/cancel`, { token, body: {} });

    const list = await api('GET', '/api/admin/creative/jobs');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.total, 1);
    assert.equal(list.body.summary.cancelled, 1);
    assert.equal(list.body.summary.refunded, 1, '汇总能看出退款笔数');
    const item = list.body.items[0];
    assert.equal(item.templateKey, 'person_hero');
    assert.equal(item.charged, true);
    assert.equal(item.refunded, true);
    assert.ok(item.userLabel.includes('张三'), '带昵称');
    assert.ok(!/\d{11}/.test(item.userLabel), '手机号必须掩码');
  });

  test('已 pending/succeeded 的任务不可 retry → 409 JOB_NOT_RETRIABLE', async () => {
    const { token } = await posterUser(100);
    const created = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'k-retry-guard' } });
    const r = await api('POST', `/api/admin/creative/jobs/${created.body.jobId}/retry`, { body: {} });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'JOB_NOT_RETRIABLE');
    const missing = await api('POST', '/api/admin/creative/jobs/does-not-exist/retry', { body: {} });
    assert.equal(missing.status, 404);
  });
});

describe('海报成品图 · 纯函数单测', () => {
  test('parseTemplateRecommendation 三态：标准格式 / 缺失 / 乱写', () => {
    const std = parseTemplateRecommendation([
      '版式建议',
      '成品图版式推荐：人物主视觉（person_hero）—— 你的信任感来自本人出镜',
      '其他内容',
    ].join('\n'));
    assert.equal(std.templateKey, 'person_hero');
    assert.equal(std.reason, '你的信任感来自本人出镜');

    const halfWidth = parseTemplateRecommendation('成品图版式推荐：编辑杂志(editorial) —— 观点先行');
    assert.equal(halfWidth.templateKey, 'editorial', '半角括号也认');
    assert.equal(halfWidth.reason, '观点先行');

    const missing = parseTemplateRecommendation('主视觉概念：深色背景\n文案：增长顾问');
    assert.equal(missing.templateKey, null, '没有推荐行 → null');
    assert.equal(missing.reason, '');

    const garbage = parseTemplateRecommendation('成品图版式推荐：随便写点什么（super_template）—— 理由乱写');
    assert.equal(garbage.templateKey, null, '白名单外的 key 一律 null（由调用方回退 scene 默认）');
    assert.equal(garbage.reason, '理由乱写', '理由仍可用');

    const noKey = parseTemplateRecommendation('成品图版式推荐：就用人物那版吧');
    assert.equal(noKey.templateKey, null);
  });

  test('normalizePosterBrief：模板白名单 + 停用模板回退 + 卖点去重去空', () => {
    const ok = normalizePosterBrief(brief({ templateKey: 'editorial', proofPoints: ['B', '', 'B'] }));
    assert.equal(ok.templateKey, 'editorial');
    assert.deepEqual(ok.proofPoints, ['B'], '空串剔除、重复去掉、保序');
    assert.equal(ok.ratio, '3:4');
    // 上限按「用户实际填了几条」判，超出直接 422（不静默砍掉多余的）
    assert.throws(() => normalizePosterBrief(brief({ proofPoints: ['1', '2', '3', '4'] })), /卖点最多 3 条/);

    // 后台停用 editorial → 回退 scene 默认（personal_brand → person_hero）
    const fallback = normalizePosterBrief(brief({ templateKey: 'editorial' }), { editorial: false });
    assert.equal(fallback.templateKey, 'person_hero');

    // 连默认模板都被停用 → 422（不默默出一版运营判定有问题的版式）
    assert.throws(
      () => normalizePosterBrief(brief({ templateKey: 'editorial' }), { editorial: false, person_hero: false }),
      /版式暂时不可用/,
    );
  });
});
