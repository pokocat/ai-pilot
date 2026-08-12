// 海报成品图（canvas_design）P5 测试之一：接口层 —— 门禁 / 校验 / 幂等 / 计费 / status / brief 草稿。
// worker 生命周期、sweep 与退款不变量在 test/creativeWorker.test.ts。
//
// 必须知道的前提（否则用例会莫名全红）：
//   ① 功能开关只有一层 —— DB 的 FeatureFlag 行 'creative-poster'，**行缺失视为关**。
//      cleanBusiness() 每例都把它删了，所以每个 describe 的 beforeEach 都要 enableCreative()。
//   ② featureFlag 读有 60s 内存缓存，而 cleanBusiness() 只删库不清缓存，setFeatureFlag 也只清
//      enabled 那半边 → 改完开关/payload 一律补一次 __clearFeatureCache()。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.js';
import { grantCredits, getBalance } from '../src/services/credits.js';
import { setFeatureFlag, setFeatureFlagPayload, __clearFeatureCache } from '../src/services/featureFlag.js';
import {
  CREATIVE_FLAG_ID, DEFAULT_PRICE_PER_POSTER, DEFAULT_PREMIUM_PRICE_PER_POSTER, MAX_TIMEOUT_MS,
  getCreativeConfig, TEMPLATE_CATALOG, assertVisualSize, premiumTierAvailable,
  type CreativeRuntimeConfig, type VisualDialect,
} from '../src/services/creative/config.js';
import { STALE_RUNNING_MS } from '../src/services/creative/worker.js';
import { parseTemplateRecommendation } from '../src/services/creative/briefDraft.js';
import { normalizePosterBrief, normalizeTier } from '../src/services/creative/schema.js';
import { buildVisualBody } from '../src/services/creative/visualProvider.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

const PRICE = DEFAULT_PRICE_PER_POSTER; // 10 钻/张（后台可改，用例按默认值断言）
const PREMIUM_PRICE = DEFAULT_PREMIUM_PRICE_PER_POSTER; // 25 钻/张

/** 只为 buildVisualBody 造一份最小配置（那是纯函数，只读 cfg.visual）。 */
function visualCfg(dialect: VisualDialect, extraParams: Record<string, unknown> = {}): CreativeRuntimeConfig {
  return {
    enabled: true, pricePerPoster: PRICE, premiumPricePerPoster: PREMIUM_PRICE, dailyLimit: 0,
    timeoutMs: 180_000, layoutEngine: 'ai', aiMode: 'auto',
    templates: { person_hero: true, editorial: true, business_launch: true },
    visual: {
      enabled: true, dialect, baseUrl: 'https://example.com/v1', model: 'm', apiKey: 'k',
      size: '1440x1920', timeoutMs: 60_000, extraParams,
    },
  };
}

/** 打开功能开关并清缓存（行缺失=关，所以每个用例都得显式开）。 */
async function enableCreative(): Promise<void> {
  await setFeatureFlag(CREATIVE_FLAG_ID, true);
  __clearFeatureCache();
}

/** 写 payload 并清缓存（setFeatureFlagPayload 只清 payload 那半边缓存）。 */
async function setPayload(payload: Record<string, unknown>): Promise<void> {
  await setFeatureFlagPayload(CREATIVE_FLAG_ID, payload);
  __clearFeatureCache();
}

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
    await enableCreative(); // cleanBusiness 删了 FeatureFlag 行 → 不开就是关（行缺失视为关）
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
    await setPayload({ dailyLimit: 2 });

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

  // C6 裁定：dailyLimit=0 的语义是「不限量」，不是「禁止创建」。紧急停量走上面那个 master 开关。
  // 把这条钉死，是因为后台文案曾写着「0=不允许创建」——一旦有人照文案去改代码，就会在一次
  // 「先把限额清零看看」的操作里把全量用户拦死。
  test('dailyLimit=0 = 不限量（不是禁止创建）', async () => {
    const { token } = await posterUser(500);
    await setPayload({ dailyLimit: 0 });
    assert.equal((await getCreativeConfig({ fresh: true })).dailyLimit, 0);

    for (const k of ['z1', 'z2', 'z3']) {
      const r = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: k } });
      assert.equal(r.status, 201, `dailyLimit=0 不该拦：${JSON.stringify(r.body)}`);
    }
    assert.equal(await prisma.creativeJob.count({ where: { userId: token } }), 3);
  });

  // D6：显式请求了被停用的模板 → 422，**不静默换版**。静默回退等于"收了 10 钻交付了别的版式"。
  test('显式请求被停用的模板 → 422；未指定时才按 scene 回退', async () => {
    const { token } = await posterUser(200);
    await setPayload({ templates: { editorial: false } });

    const explicit = await api('POST', '/api/creative/posters', {
      token, body: { brief: brief({ templateKey: 'editorial' }), idempotencyKey: 'k-off-tpl' },
    });
    assert.equal(explicit.status, 422, JSON.stringify(explicit.body));
    assert.equal(explicit.body.code, 'BRIEF_INVALID');
    assert.match(String(explicit.body.error), /版式暂时不可用/);
    assert.equal(await prisma.creativeJob.count({ where: { userId: token } }), 0, '不建任务、不扣费');

    // 没指定 templateKey：按 scene 回退默认（personal_brand → person_hero，未被停用）
    const implicit = await api('POST', '/api/creative/posters', {
      token, body: { brief: brief(), idempotencyKey: 'k-fallback-tpl' },
    });
    assert.equal(implicit.status, 201, JSON.stringify(implicit.body));
    const saved = (await prisma.creativeJob.findUniqueOrThrow({ where: { id: implicit.body.jobId } })).requestJson as
      { brief: { templateKey: string } };
    assert.equal(saved.brief.templateKey, 'person_hero');
  });

  // D2：revise 曾漏了 assertPosterAccess —— 被回收 poster 权限的用户能拿旧 jobId 无限免费出新版本。
  test('未解锁 poster 的用户 revise → 403 AGENT_LOCKED', async () => {
    const { token } = await posterUser(200, '先有权限后被回收');
    const created = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'k-rev-gate' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // 运营回收 poster 解锁
    await prisma.userAgent.deleteMany({ where: { userId: token, agentKey: 'poster' } });

    const revise = await api('POST', `/api/creative/jobs/${created.body.jobId}/revise`, {
      token, body: { headline: '偷偷再来一版', idempotencyKey: 'k-rev-gate-2' },
    });
    assert.equal(revise.status, 403, JSON.stringify(revise.body));
    assert.equal(revise.body.code, 'AGENT_LOCKED');
    assert.equal(await prisma.creativeJob.count({ where: { userId: token } }), 1, '没建出第二个任务');

    // regenerate 一直有这道门禁，一并钉住（防止将来有人"统一"门禁时反向删掉）
    const regen = await api('POST', `/api/creative/jobs/${created.body.jobId}/regenerate`, { token, body: { idempotencyKey: 'k-rev-gate-3' } });
    assert.equal(regen.status, 403, JSON.stringify(regen.body));
    assert.equal(regen.body.code, 'AGENT_LOCKED');
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
    await enableCreative();
  });

  // ── 高级档（2026-08-12）──
  // 三条不变式：不可用时 422 而不是静默降级、可用时按高级价扣、与本人照片互斥在**建单时**就拦。
  // 「悄悄给他标准图再照常扣钱」是这条功能里最容易犯也最伤的错，所以三条都要有守卫。
  test('高级档：供应商没配好 → 422 PREMIUM_UNAVAILABLE，不建单不扣费（绝不静默降标准）', async () => {
    const { token } = await posterUser(100);
    const before = await getBalance(token);
    const r = await api('POST', '/api/creative/posters', {
      token, body: { brief: brief({ tier: 'premium' }), idempotencyKey: 'prem-off' },
    });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, 'PREMIUM_UNAVAILABLE');
    assert.equal(await prisma.creativeJob.count({ where: { userId: token } }), 0, '不建单');
    assert.equal(await getBalance(token), before, '不扣费');
  });

  test('高级档：供应商配齐 → 建单成功且按**高级价**扣费', async () => {
    await setPayload({
      visual: { enabled: true, baseUrl: 'https://ark.example.com/api/v3', model: 'doubao-seedream', dialect: 'ark_seedream' },
    });
    const { token } = await posterUser(100);
    const before = await getBalance(token);
    const r = await api('POST', '/api/creative/posters', {
      token, body: { brief: brief({ tier: 'premium' }), idempotencyKey: 'prem-on' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.creditCost, PREMIUM_PRICE, `高级档按 ${PREMIUM_PRICE} 钻计价，不是标准档的 ${PRICE}`);
    assert.equal(await getBalance(token), before - PREMIUM_PRICE);
  });

  test('高级档 + 本人照片 → 422（可预见的冲突在建单时就拦，不先扣 25 钻再退）', async () => {
    await setPayload({
      visual: { enabled: true, baseUrl: 'https://ark.example.com/api/v3', model: 'doubao-seedream', dialect: 'ark_seedream' },
    });
    const { token } = await posterUser(100);
    const before = await getBalance(token);
    const r = await api('POST', '/api/creative/posters', {
      token,
      body: { brief: brief({ tier: 'premium', portraitAssetId: 'cxxxxxxxxxxxxxxxxxxxxxxxx' }), idempotencyKey: 'prem-portrait' },
    });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, 'PREMIUM_PORTRAIT_CONFLICT');
    assert.equal(await getBalance(token), before, '不扣费');
  });

  test('高级档不可用时 status 不下发这个选项（前端据此整块隐藏，而不是让用户点到 422）', async () => {
    const { token } = await posterUser(10);
    const off = await api('GET', '/api/creative/status', { token });
    assert.equal(off.body.premiumAvailable, false, '没配供应商 → 不可用');
    assert.equal(off.body.premiumPricePerPoster, PREMIUM_PRICE, '价格照常下发（前端只在可用时展示）');

    await setPayload({
      visual: { enabled: true, baseUrl: 'https://ark.example.com/api/v3', model: 'doubao-seedream', dialect: 'ark_seedream' },
    });
    const on = await api('GET', '/api/creative/status', { token });
    assert.equal(on.body.premiumAvailable, true);

    // 运营把 aiMode 锁成 graphic = 全局禁用影像路线（供应商出事故时的熔断闸）→ 高级档必须一起关掉，
    // 否则会出现「收了高级价、却必然产出标准形态」的单。
    await setPayload({
      aiMode: 'graphic',
      visual: { enabled: true, baseUrl: 'https://ark.example.com/api/v3', model: 'doubao-seedream', dialect: 'ark_seedream' },
    });
    const locked = await api('GET', '/api/creative/status', { token });
    assert.equal(locked.body.premiumAvailable, false, 'aiMode=graphic 时高级档不可下单');
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
    await enableCreative();
  });

  test('GET /creative/status：后台开关单一真源 + 价格透传', async () => {
    const { token } = await posterUser();
    const on = await api('GET', '/api/creative/status', { token });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.enabled, true, 'beforeEach 打开了后台开关');
    assert.equal(on.body.pricePerPoster, PRICE);

    // 后台改价 → 透传（同一次配置写入也验证 payload 合并不丢开关）
    await setPayload({ pricePerPoster: 18 });
    const priced = await api('GET', '/api/creative/status', { token });
    assert.equal(priced.body.pricePerPoster, 18, '价格来自后台配置，不硬编码');

    await setFeatureFlag(CREATIVE_FLAG_ID, false);
    const off = await api('GET', '/api/creative/status', { token });
    assert.equal(off.body.enabled, false, '后台开关关掉即整体关闭');
    assert.deepEqual(off.body.templates, [], '关闭时不下发版式清单（前端应整块隐藏入口）');
  });

  // C1 的安全默认：删掉部署级 env 之后，唯一的兜底就是「FeatureFlag 行缺失 = 关」。
  // 这条必须钉死 —— 生产库里本就没有这一行，默认若是"开"，删 env 的那次上线就等于无声放量。
  test('FeatureFlag 行缺失 → 功能视为关（不是默认开）', async () => {
    const { token } = await posterUser();
    await prisma.featureFlag.deleteMany({ where: { id: CREATIVE_FLAG_ID } });
    __clearFeatureCache();

    const st = await api('GET', '/api/creative/status', { token });
    assert.equal(st.body.enabled, false, '没有配置行 = 未放量');
    const create = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'k-nodefault' } });
    assert.equal(create.status, 403, JSON.stringify(create.body));
    assert.equal(create.body.code, 'CANVAS_DISABLED');
  });

  // D6：版式清单由服务端下发（只含启用中的），前端不再硬编码三套恒可选。
  test('GET /creative/status 下发启用中的版式清单（停用的不出现）', async () => {
    const { token } = await posterUser();
    const all = await api('GET', '/api/creative/status', { token });
    assert.deepEqual(
      all.body.templates.map((t: { key: string }) => t.key),
      ['person_hero', 'editorial', 'business_launch'],
      '缺省三套全启用，且保持白名单顺序',
    );
    const first = all.body.templates[0];
    assert.equal(first.name, TEMPLATE_CATALOG.person_hero.name, '中文名来自服务端唯一真源');
    assert.ok(first.desc && first.desc.length > 0, '带一句说明供确认页副标');

    await setPayload({ templates: { editorial: false } });
    const partial = await api('GET', '/api/creative/status', { token });
    assert.deepEqual(
      partial.body.templates.map((t: { key: string }) => t.key),
      ['person_hero', 'business_launch'],
      '被停用的 editorial 不下发',
    );
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
    await enableCreative();
  });

  test('配置读写：改价即时生效、apiKey 只回 hasKey、局部更新不丢字段、开关单层如实回传', async () => {
    const got = await api('GET', '/api/admin/creative/config');
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.pricePerPoster, PRICE);
    assert.equal(got.body.enabled, true, 'enabled 就是唯一真源（beforeEach 已打开）');
    assert.equal((got.body as Record<string, unknown>).envEnabled, undefined, '部署级开关已删除，不该再回传这个字段');
    assert.equal((got.body as Record<string, unknown>).maxConcurrency, undefined, 'maxConcurrency 是假旋钮，已删除');
    assert.equal((got.body as Record<string, unknown>).imageModerationProvider, undefined, '图片审核 http 半成品已删除');
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

  // C1：后台开关是唯一真源 —— 关掉立刻对 C 端生效，不需要改 env、不需要重启。
  test('后台把 enabled 关掉 → C 端立即 403 CANVAS_DISABLED；打开即恢复', async () => {
    const { token } = await posterUser(100);
    const off = await api('PUT', '/api/admin/creative/config', { body: { enabled: false } });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.enabled, false);

    __clearFeatureCache();
    const denied = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'k-admin-off' } });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.code, 'CANVAS_DISABLED');

    assert.equal((await api('PUT', '/api/admin/creative/config', { body: { enabled: true } })).body.enabled, true);
    __clearFeatureCache();
    const ok = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'k-admin-on' } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });

  // C1 的第二个坑：FeatureFlag.enabled 在 prisma 里是 @default(true)，而写 payload 走 upsert。
  // 生产库本来没有这一行 —— 若不显式落 enabled，运营第一次进后台"只改了个单价"就会把功能放量。
  test('未放量时保存配置（不碰开关）→ 不该把功能悄悄打开', async () => {
    await prisma.featureFlag.deleteMany({ where: { id: CREATIVE_FLAG_ID } });
    __clearFeatureCache();
    const { token } = await posterUser(100);

    const put = await api('PUT', '/api/admin/creative/config', { body: { pricePerPoster: 12 } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.pricePerPoster, 12, '价格改上了');
    assert.equal(put.body.enabled, false, '改价不该顺手放量');
    assert.equal(
      (await prisma.featureFlag.findUniqueOrThrow({ where: { id: CREATIVE_FLAG_ID } })).enabled,
      false,
      '库里那一行的 enabled 必须显式为 false，不能落到 prisma 的 @default(true)',
    );

    __clearFeatureCache();
    const denied = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'k-still-off' } });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.code, 'CANVAS_DISABLED');
  });

  // D4：渲染超时上限必须收在 sweep 的卡死阈值以内，否则正常长渲染会被 sweep 抢回队列跑第二遍。
  test('timeoutMs 被 clamp 到 480s 上限（且严格小于 sweep 卡死阈值）', async () => {
    assert.ok(MAX_TIMEOUT_MS < STALE_RUNNING_MS, `不变式：渲染超时上限 ${MAX_TIMEOUT_MS} 必须 < sweep 阈值 ${STALE_RUNNING_MS}`);

    const put = await api('PUT', '/api/admin/creative/config', { body: { timeoutMs: 900_000 } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.timeoutMs, MAX_TIMEOUT_MS, '900s 的输入被收到 480s');
    assert.equal((await getCreativeConfig({ fresh: true })).timeoutMs, MAX_TIMEOUT_MS, '运行时读到的也是收敛后的值');

    // 下限同样成立（低于 10s 的渲染超时只会让每一单都超时）
    assert.equal((await api('PUT', '/api/admin/creative/config', { body: { timeoutMs: 500 } })).body.timeoutMs, 10_000);
  });

  // K4：视觉哲学快照此前零读者（LLM 成本白付）。列表按需截断，且截断要有明确标注。
  test('任务台下发 promptSnapshot，超 2000 字截断并标注', async () => {
    const { token } = await posterUser(100, '哲学读者');
    const created = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'k-snapshot' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // 短快照：原样下发
    await prisma.creativeJob.update({ where: { id: created.body.jobId }, data: { promptSnapshot: '【几何静默】空间与形：大面积虚空承担呼吸' } });
    const short = await api('GET', '/api/admin/creative/jobs');
    assert.equal(short.body.items[0].promptSnapshot, '【几何静默】空间与形：大面积虚空承担呼吸');

    // 长快照：截断 + 标注（不静默砍掉，运营要知道自己看的是节选）
    const long = '哲'.repeat(2500);
    await prisma.creativeJob.update({ where: { id: created.body.jobId }, data: { promptSnapshot: long } });
    const clipped = (await api('GET', '/api/admin/creative/jobs')).body.items[0].promptSnapshot as string;
    assert.ok(clipped.length < long.length, '超长快照必须截断，不能整段拖慢列表');
    assert.ok(clipped.startsWith('哲'.repeat(2000)), '保留前 2000 字');
    assert.match(clipped, /已截断，共 2500 字/, '显式标注截断与原长度');
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

  test('normalizePosterBrief：模板白名单 + 停用模板 422 + 卖点去重去空', () => {
    const ok = normalizePosterBrief(brief({ templateKey: 'editorial', proofPoints: ['B', '', 'B'] }));
    assert.equal(ok.templateKey, 'editorial');
    assert.deepEqual(ok.proofPoints, ['B'], '空串剔除、重复去掉、保序');
    assert.equal(ok.ratio, '3:4');
    // 上限按「用户实际填了几条」判，超出直接 422（不静默砍掉多余的）
    assert.throws(() => normalizePosterBrief(brief({ proofPoints: ['1', '2', '3', '4'] })), /卖点最多 3 条/);

    // D6：显式请求被停用的 editorial → 422。**不再静默回退**到 person_hero ——
    // 用户在确认页明确选了这一版，悄悄换成别的再照常扣 10 钻，是拿了钱交付别的东西。
    assert.throws(
      () => normalizePosterBrief(brief({ templateKey: 'editorial' }), { editorial: false }),
      /版式暂时不可用/,
    );

    // 未指定 templateKey：按 scene 回退默认，停用别的模板不影响
    const fallback = normalizePosterBrief(brief({ templateKey: undefined }), { editorial: false });
    assert.equal(fallback.templateKey, 'person_hero', 'personal_brand 的默认模板');

    // 白名单外的值等同「没指定」→ 同样回退（不是 422：那是拼写错误/老客户端，不是"选了停用项"）
    assert.equal(
      normalizePosterBrief(brief({ templateKey: 'not_a_template' }), { editorial: false }).templateKey,
      'person_hero',
    );

    // 连 scene 默认模板也被停用 → 422（不默默出一版运营判定有问题的版式）
    assert.throws(
      () => normalizePosterBrief(brief({ templateKey: undefined }), { person_hero: false }),
      /版式暂时不可用/,
    );
  });

  test('normalizeTier：只认 premium，缺省 / 脏值 / 老客户端不带 → standard', () => {
    assert.equal(normalizeTier('premium'), 'premium');
    assert.equal(normalizeTier('standard'), 'standard');
    assert.equal(normalizeTier(undefined), 'standard', '老客户端不带这个字段，行为必须一字不变');
    assert.equal(normalizeTier('PREMIUM'), 'standard', '大小写不宽容：只认精确值');
    assert.equal(normalizeTier({ tier: 'premium' }), 'standard');
    assert.equal(normalizePosterBrief(brief()).tier, 'standard', 'brief 归一后 tier 必定有值');
    assert.equal(normalizePosterBrief(brief({ tier: 'premium' })).tier, 'premium');
  });

  // ★ 尺寸校验是把一个**静默**故障变成一次可见的保存失败：
  //   主视觉全幅铺底，比例不符会被 object-fit:cover 裁掉一整条，而渲染成功、任务全绿、图是坏的。
  //   2026-08-12 生产实况就是 1440x2560（9:16），每张影像海报都在被上下裁。
  test('assertVisualSize：3:4 放行 / 9:16 拒绝 / 厂商预设原样放行', () => {
    assert.doesNotThrow(() => assertVisualSize('1440x1920'), '正 3:4');
    assert.doesNotThrow(() => assertVisualSize('1024x1536'), 'gpt-image-1 的 2:3，轻微裁切可接受');
    assert.doesNotThrow(() => assertVisualSize('2K'), '厂商预设不做比例校验（比例由提示词描述）');
    assert.doesNotThrow(() => assertVisualSize(''), '空值交给缺省逻辑，不在这里报错');
    assert.throws(() => assertVisualSize('1440x2560'), /宽高比/, '9:16 —— 生产踩过的那个值');
    assert.throws(() => assertVisualSize('1024x1024'), /宽高比/, '方图会被裁掉左右两侧');
    assert.throws(() => assertVisualSize('1920x1080'), /宽高比/, '横图更离谱');
  });

  // 三家 images 接口长得像但不通用。这些差异「填错了才发现」，靠真调去试太贵 —— 用纯函数钉死。
  test('buildVisualBody · 方舟 Seedream：强制关水印 + 原生负向提示词 + 不让 extraParams 改回来', () => {
    const cfg = visualCfg('ark_seedream', { watermark: true, quality: 'high' });
    const body = buildVisualBody(cfg, { prompt: 'a calm advisor', negativePrompt: 'text, watermark' });
    assert.equal(body.watermark, false, '★ 方舟默认加水印；印着水印的付费海报没法交付');
    assert.equal(body.negative_prompt, 'text, watermark', '方舟有原生负向字段，不该拼进正向 prompt');
    assert.equal(body.prompt, 'a calm advisor', '正向 prompt 保持干净');
    assert.equal(body.optimize_prompt, false, '关掉改写：无文字这条约束被改写掉整张图就废了');
    assert.equal(body.quality, 'high', 'extraParams 里的厂商专有项照常透传');
  });

  test('buildVisualBody · gpt_image：绝不发 response_format（发了必 400）', () => {
    const body = buildVisualBody(visualCfg('gpt_image'), { prompt: 'p', negativePrompt: 'no text' });
    assert.equal('response_format' in body, false, '★ gpt-image-1 收到这个参数直接 400');
    assert.match(String(body.prompt), /no text/, '没有负向字段，只能拼进正向');
  });

  test('buildVisualBody · 通用 openai：老行为一字不变', () => {
    const body = buildVisualBody(visualCfg('openai'), { prompt: 'p', negativePrompt: 'q' });
    assert.equal(body.response_format, 'b64_json');
    assert.equal(body.prompt, 'p\n【排除】q');
    assert.equal('negative_prompt' in body, false);
    assert.equal('watermark' in body, false);
  });
});
