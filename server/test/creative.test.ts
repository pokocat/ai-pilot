// 海报成品图（canvas_design）P5 测试之一：接口层 —— 门禁 / 校验 / 幂等 / 计费 / status / brief 草稿。
// worker 生命周期、sweep 与退款不变量在 test/creativeWorker.test.ts。
//
// 必须知道的前提（否则用例会莫名全红）：
//   ① 功能开关只有一层 —— DB 的 FeatureFlag 行 'creative-poster'，**行缺失视为关**。
//      cleanBusiness() 每例都把它删了，所以每个 describe 的 beforeEach 都要 enableCreative()。
//   ② featureFlag 读有 60s 内存缓存，而 cleanBusiness() 只删库不清缓存，setFeatureFlag 也只清
//      enabled 那半边 → 改完开关/payload 一律补一次 __clearFeatureCache()。
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.js';
import { grantCredits, getBalance } from '../src/services/credits.js';
import { setFeatureFlag, setFeatureFlagPayload, __clearFeatureCache } from '../src/services/featureFlag.js';
import {
  CREATIVE_FLAG_ID, DEFAULT_PRICE_PER_POSTER, DEFAULT_PREMIUM_PRICE_PER_POSTER, MAX_TIMEOUT_MS,
  getCreativeConfig, TEMPLATE_CATALOG, TEMPLATE_KEYS, TEMPLATE_DENSITIES, assertVisualSize, premiumTierAvailable,
  type CreativeRuntimeConfig, type VisualDialect, type TemplateKey,
} from '../src/services/creative/config.js';
import {
  renderPosterHtml, auditPosterHtml, extractStat, metaRow, QR_HOLD_TEXT,
} from '../src/services/creative/templates.js';
import { fallbackPhilosophy } from '../src/services/creative/philosophy.js';
import { STALE_RUNNING_MS } from '../src/services/creative/worker.js';
import {
  parseTemplateRecommendation, resolveRecommendation, isRecommendationConsistent, RECOMMEND_REASON_LIMIT,
} from '../src/services/creative/briefDraft.js';
import { POSTER_DIRECTIONS, directionFor } from '../src/services/creative/directions.js';
import { normalizePosterBrief, normalizeTier } from '../src/services/creative/schema.js';
import { buildVisualBody } from '../src/services/creative/visualProvider.js';
// designNote 抽取分支守卫（见文末新增 describe）：默认测试环境无 live provider，
// 240 截断 / DRAFT_SYS 是否撑爆抽取分支这两条必须真的走到「AI 吐出了 designNote」这条分支才验证得到，
// 用 AI_ALLOW_REAL_PROVIDER=1 + globalThis.fetch 打桩放行 provider 代码路径（不出网）——
// 与 test/structuredBilling.test.ts、test/gatewayProvider.test.ts 同一手法（见 src/env.ts isAiTestMode 注释）。
import { configurePurpose, __wipeAiV2 } from '../src/services/aiV2Admin.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

const PRICE = DEFAULT_PRICE_PER_POSTER; // 10 钻/张（后台可改，用例按默认值断言）
const PREMIUM_PRICE = DEFAULT_PREMIUM_PRICE_PER_POSTER; // 25 钻/张

/** 只为 buildVisualBody 造一份最小配置（那是纯函数，只读 cfg.visual）。 */
function visualCfg(dialect: VisualDialect, extraParams: Record<string, unknown> = {}): CreativeRuntimeConfig {
  return {
    enabled: true, pricePerPoster: PRICE, premiumPricePerPoster: PREMIUM_PRICE, dailyLimit: 0,
    timeoutMs: 180_000, layoutEngine: 'ai',
    templates: Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, true])) as Record<TemplateKey, boolean>,
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

  // 详情页「换方向」只能按 tier 过滤时，会给没传照片的单摆出「本人形象」——选中提交必 422，
  // 而那页没有上传入口。视图必须下发这个布尔事实，且**只下发布尔**：素材本体照旧不进 assets。
  test('任务视图下发 hasPortrait（只回布尔事实，素材本体仍不进 assets）', async () => {
    const { token, tenantId } = await posterUser(100, '有照片的人');
    const portrait = await prisma.creativeAsset.create({
      data: { tenantId, userId: token, jobId: null, kind: 'source', ossKey: 'creative/p/_loose/me.png', mimeType: 'image/png' },
    });
    const withIt = await api('POST', '/api/creative/posters', {
      token,
      body: { brief: brief({ portraitAssetId: portrait.id, directionKey: 'graphic_portrait' }), idempotencyKey: 'hp-yes' },
    });
    assert.equal(withIt.status, 201, JSON.stringify(withIt.body));
    const withView = await api('GET', `/api/creative/jobs/${withIt.body.jobId}`, { token });
    assert.equal(withView.body.hasPortrait, true, '带了照片就得说有，否则详情页永远露不出「本人形象」');
    assert.ok(
      !(withView.body.assets as Array<{ kind: string }>).some((a) => a.kind === 'source'),
      '只多一个布尔，素材本体不许跟着进视图',
    );

    const without = await api('POST', '/api/creative/posters', { token, body: { brief: brief(), idempotencyKey: 'hp-no' } });
    assert.equal(without.status, 201, JSON.stringify(without.body));
    const withoutView = await api('GET', `/api/creative/jobs/${without.body.jobId}`, { token });
    assert.equal(withoutView.body.hasPortrait, false, '没照片必须是 false —— 摆出一个必 422 的方向比不摆更糟');
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

    // 图片供应商熔断只看 visual.enabled；退役的 aiMode 不再参与路线裁决。
    await setPayload({
      visual: { enabled: false, baseUrl: 'https://ark.example.com/api/v3', model: 'doubao-seedream', dialect: 'ark_seedream' },
    });
    const locked = await api('GET', '/api/creative/status', { token });
    assert.equal(locked.body.premiumAvailable, false, 'visual.enabled=false 时高级档不可下单');
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

  // D6：版式清单由服务端下发（只含启用中的），前端不再硬编码一份本地目录。
  test('GET /creative/status 下发启用中的版式清单（停用的不出现）', async () => {
    const { token } = await posterUser();
    const all = await api('GET', '/api/creative/status', { token });
    assert.deepEqual(
      all.body.templates.map((t: { key: string }) => t.key),
      [...TEMPLATE_KEYS],
      '缺省整池全启用，且保持白名单顺序',
    );
    const first = all.body.templates[0];
    assert.equal(first.name, TEMPLATE_CATALOG.person_hero.name, '中文名来自服务端唯一真源');
    assert.ok(first.desc && first.desc.length > 0, '带一句说明供确认页副标');

    await setPayload({ templates: { editorial: false } });
    const partial = await api('GET', '/api/creative/status', { token });
    assert.ok(
      !partial.body.templates.some((t: { key: string }) => t.key === 'editorial'),
      '被停用的 editorial 不下发',
    );
    assert.equal(partial.body.templates.length, TEMPLATE_KEYS.length - 1, '只少这一套');
  });

  // 密度是用户挑版式时真正在挑的东西（"说一句话还是说满一版"），必须跟着清单一起下发，
  // 否则前端只能靠 key 名去猜分组 —— 那就是当年 app / admin 各维护一份目录的老路。
  test('GET /creative/status 每套版式带 density，且取值在三档之内', async () => {
    const { token } = await posterUser();
    const r = await api('GET', '/api/creative/status', { token });
    for (const t of r.body.templates as { key: TemplateKey; density?: string }[]) {
      assert.ok(t.density, `${t.key} 缺 density`);
      assert.ok(
        (TEMPLATE_DENSITIES as readonly string[]).includes(t.density!),
        `${t.key} 的 density=${t.density} 不在 ${TEMPLATE_DENSITIES.join('/')} 之内`,
      );
      assert.equal(t.density, TEMPLATE_CATALOG[t.key].density, '下发值必须来自唯一真源');
    }
    // 三档都真的有版式：只有一档的"分档"等于没分。
    const got = new Set(r.body.templates.map((t: { density: string }) => t.density));
    assert.deepEqual([...got].sort(), [...TEMPLATE_DENSITIES].sort(), '三档密度都要有版式');
  });

  test('brief-draft：无 provider 也不抛错，返回可用预填 + templateKey/templateReason', async () => {
    const { token, tenantId } = await posterUser();
    const messageId = await reportMessage(token, tenantId);

    const r = await api('GET', `/api/creative/posters/brief-draft?messageId=${messageId}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.brief.ratio, '3:4');
    assert.equal(r.body.brief.scene, 'personal_brand', 'poster agent → personal_brand');
    // 2026-08-13 改造：headline 抽不出就留空，不再兜底成果标题——那是方案报告时代的产物，
    // 海报设计师现在不出报告（见 briefDraft.ts buildPosterBriefDraft 的注释）。无 provider
    // 时结构化抽取必失败，headline 因此确定性地是空串，不是"至少有点什么"。
    assert.equal(r.body.brief.headline, '', 'AI 不可用时 headline 留空，不再兜底成果标题');
    // 兜底层②：从成果原文的「成品图版式推荐」行解析——这条不依赖 provider，AI 抽取失败也照样拿到。
    assert.equal(r.body.brief.templateKey, 'person_hero');
    assert.ok(r.body.templateReason && r.body.templateReason.length > 0, '带一句给客户看的理由');
  });

  // 2026-08-14 新增：designNote 是确认页的主视图，「抽不出来」与「抽出来是空串」对前端是
  // 两种不同行为（showForm 的初值 = !draftNote）。必须钉死「键整个不存在」，不是「值为假」——
  // 用 assert.ok(!('designNote' in body)) 而不是 assert.ok(!body.designNote)，
  // 否则哪天有人手滑把 `designNote: ''` 也下发了，这条用例还是绿的。
  test('brief-draft：无 provider 时 designNote 键不下发（不是空串，是键都不存在）', async () => {
    const { token, tenantId } = await posterUser();
    const messageId = await reportMessage(token, tenantId);
    const r = await api('GET', `/api/creative/posters/brief-draft?messageId=${messageId}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!('designNote' in r.body), '抽不出说明时确认页要退回表单打头，键必须整个不存在');
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
    assert.ok(!('designNote' in r.body), '这条也是无 provider 路径，同样不该带 designNote 键');
  });

  // 2026-08-13 改造前：越权/缺参分别报 404 MESSAGE_NOT_FOUND / 422 MESSAGE_ID_REQUIRED——
  // 那是「brief-draft 必须锚定一条 report 成果消息」时代的校验。现在 brief-draft 只是「读得到
  // 会话就抽、读不到就给空表单」的预填助手，缺参＝没线索、越权＝没权限，两者都不算错误，
  // 统一回 200 + 空 brief（见 briefDraft.ts buildPosterBriefDraft/resolveDraftSession 的注释）。
  test('brief-draft：越权 messageId 与缺 messageId 都不报错，统一回空草稿（不泄漏也不 4xx）', async () => {
    const { token } = await posterUser(100, '本人');
    const { token: other, tenantId: otherTenant } = await posterUser(100, '别人');
    const foreign = await reportMessage(other, otherTenant);

    const stolen = await api('GET', `/api/creative/posters/brief-draft?messageId=${foreign}`, { token });
    assert.equal(stolen.status, 200, JSON.stringify(stolen.body));
    assert.deepEqual(stolen.body, { brief: {} }, '越权 messageId 拿不到对方任何字段，也不该用 404 探测资源是否存在');

    const missing = await api('GET', '/api/creative/posters/brief-draft', { token });
    assert.equal(missing.status, 200, JSON.stringify(missing.body));
    assert.deepEqual(missing.body, { brief: {} }, '缺 messageId 不再是校验错误，前端渲染空表单即可');
  });

  // 任务要求专门补的一条：resolveDraftSession 的 sessionId 分支和 messageId 分支是两段独立查询，
  // 各自都要卡权限——此前所有用例都只走 messageId，sessionId 分支的跨用户场景完全没覆盖过。
  test('TC-G brief-draft：跨用户越权 sessionId 拿不到对方内容', async () => {
    const { token: mine } = await posterUser(100, '本人3');
    const { token: victim, tenantId: victimTenant } = await posterUser(100, '受害者');
    // 受害者会话里塞一条实打实能抽出版式推荐的消息，确保下面「拿不到」不是因为这个会话本来就是空的。
    const victimSession = await prisma.session.create({
      data: { tenantId: victimTenant, userId: victim, agentKey: 'poster', title: '受害者的海报会话' },
    });
    await prisma.message.create({
      data: {
        sessionId: victimSession.id,
        role: 'assistant',
        contentJson: { text: '够了，去出图吧。成品图版式推荐：人物主视觉（person_hero）—— 你的信任感来自本人出镜' },
      },
    });

    const stolen = await api('GET', `/api/creative/posters/brief-draft?sessionId=${victimSession.id}`, { token: mine });
    assert.equal(stolen.status, 200, JSON.stringify(stolen.body));
    assert.deepEqual(stolen.body, { brief: {} }, 'A 拿 B 的 sessionId 必须拿不到任何字段，尤其不能拿到 person_hero 推荐');

    // 对照组：受害者本人用同一个 sessionId 读得到东西——证明上面的「拿不到」是权限拦的，
    // 不是 sessionId 分支本身失灵才恰好返回空。
    const own = await api('GET', `/api/creative/posters/brief-draft?sessionId=${victimSession.id}`, { token: victim });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.brief.templateKey, 'person_hero', '本人能读到自己会话里的版式推荐');
    assert.ok(!('designNote' in own.body), '无 provider 时本人读自己的会话也不该带 designNote 键');
  });

  // 下面三条是任务点名要核实的 loadConversationText 边界：空会话 / 只有 user 消息 / 超长会话，
  // 都必须不炸（不是必须抽出多少内容，是不能 500）。
  test('brief-draft：空会话（0 条消息）不炸，按 agent 兜底出可用草稿', async () => {
    const { token, tenantId } = await posterUser(100, '空会话用户');
    const session = await prisma.session.create({
      data: { tenantId, userId: token, agentKey: 'poster', title: '还没聊过' },
    });
    const r = await api('GET', `/api/creative/posters/brief-draft?sessionId=${session.id}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.brief.scene, 'personal_brand', '空会话按 agentKey 兜底 scene，不炸');
    assert.equal(r.body.brief.templateKey, 'person_hero', 'scene 默认模板兜底');
    assert.ok(!('designNote' in r.body), '空会话没有素材可抽，designNote 键不该出现');
  });

  test('brief-draft：只有 user 消息（设计师还没回）不炸', async () => {
    const { token, tenantId } = await posterUser(100, '只发了一句的用户');
    const session = await prisma.session.create({
      data: { tenantId, userId: token, agentKey: 'poster', title: '刚开口' },
    });
    await prisma.message.create({
      data: { sessionId: session.id, role: 'user', contentJson: { text: '帮我做个招生海报' } },
    });
    const r = await api('GET', `/api/creative/posters/brief-draft?sessionId=${session.id}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.brief.scene, 'personal_brand');
    assert.ok(!('designNote' in r.body), '设计师还没回、且无 provider，designNote 键不该出现');
  });

  test('brief-draft：超长会话（消息数超上限 + 单条超长文本）不炸，尾部推荐行仍留在截取窗口内', async () => {
    const { token, tenantId } = await posterUser(100, '话痨用户');
    const session = await prisma.session.create({
      data: { tenantId, userId: token, agentKey: 'poster', title: '聊了很久' },
    });
    // 30 条早期噪音消息：超过素材读取条数上限，验证消息量大不炸、且不影响"取最后几条"的语义。
    for (let i = 0; i < 30; i++) {
      await prisma.message.create({
        data: { sessionId: session.id, role: i % 2 === 0 ? 'user' : 'assistant', contentJson: { text: `早期闲聊第 ${i} 句` } },
      });
    }
    // 最后一条单条就超过素材字数上限（约 8000 字），且推荐行在文本末尾——
    // 验证「取末尾若干字」不会把这一行反而切没。
    const longPrefix = '很长的补充说明。'.repeat(1000);
    await prisma.message.create({
      data: {
        sessionId: session.id,
        role: 'assistant',
        contentJson: { text: `${longPrefix}够了，去出图吧。成品图版式推荐：人物主视觉（person_hero）—— 你的信任感来自本人出镜` },
      },
    });

    const r = await api('GET', `/api/creative/posters/brief-draft?sessionId=${session.id}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.brief.scene, 'personal_brand');
    assert.equal(r.body.brief.templateKey, 'person_hero', '超长文本尾部的推荐行仍在保留的字数窗口内，没被切没');
    assert.ok(!('designNote' in r.body), '无 provider 时即便会话很长也不该带 designNote 键');
  });

  // 2026-08-16 军师推荐组合：确认页据它预选，用户零次必答即可下单。
  // 因此它**恒在**——无 provider 是线上最常见的一条路径，那条路上给不出组合，
  // 用户就又被推回「方式 / 方向 / 版式」三次选择，正是这次要消灭的东西。
  test('brief-draft：无 provider 也带 recommendation，且是一套可直接下单的组合', async () => {
    const { token, tenantId } = await posterUser(100, '推荐兜底用户');
    const messageId = await reportMessage(token, tenantId);

    const r = await api('GET', `/api/creative/posters/brief-draft?messageId=${messageId}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rec = r.body.recommendation;
    assert.ok(rec, 'AI 不可用也必须给出推荐组合（服务端确定性合成）');
    assert.equal(rec.tier, 'standard', '兜底恒 standard —— 默认不推贵档');
    assert.equal(directionFor(rec.directionKey).tier, 'standard', '方向必须与档位同档，否则建单直接 422');
    assert.ok((TEMPLATE_KEYS as readonly string[]).includes(rec.templateKey), '版式必须在白名单内');
    assert.ok(rec.reason && rec.reason.length <= RECOMMEND_REASON_LIMIT, `理由非空且不超 ${RECOMMEND_REASON_LIMIT} 字`);
    assert.equal(
      isRecommendationConsistent(rec, { hasPortrait: false, premiumAvailable: false }),
      true,
      '下发前后走同一套一致性校验：确认页拿到的组合必须原样下得了单',
    );
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

// ─────────────────────────────────────────────────────────────────────────
// 军师推荐组合（纯函数，不起 app、不碰库）
//
// 这套函数是「零次必答」的全部安全绳：确认页把它预选上，用户可以一次都不改就下单。
// 所以这里验的不是「推得准不准」（那是模型的事），而是**推出来的组合必须下得了单**——
// 档位与方向同档、requiresPortrait 有照片、premium 真的能下单、理由不超长。
describe('海报成品图 · 军师推荐组合（纯函数：白名单校验与确定性兜底）', () => {
  /** 最保守的上下文：无照片、高级档不可用、无卖点。 */
  const BARE = { scene: 'personal_brand' as const, proofPointCount: 0, hasPortrait: false, premiumAvailable: false };

  test('LLM 正常路径：合法组合原样保留，理由用模型写的那句', () => {
    const std = resolveRecommendation(
      { tier: 'standard', directionKey: 'graphic_symbol', templateKey: 'quote_card', reason: '你的主张一句话就能立住，图形做记忆点' },
      { ...BARE, scene: 'service' },
    );
    assert.deepEqual(std, {
      tier: 'standard', directionKey: 'graphic_symbol', templateKey: 'quote_card',
      reason: '你的主张一句话就能立住，图形做记忆点',
    }, '合法组合不许被服务端改写——改写等于把模型读过的对话丢掉');

    const pre = resolveRecommendation(
      { tier: 'premium', directionKey: 'photo_character', templateKey: 'editorial', reason: '这张要靠人物气场立住，用实拍质感出主视觉' },
      { ...BARE, premiumAvailable: true },
    );
    assert.equal(pre.tier, 'premium', '高级档可下单时保留模型的判断');
    assert.equal(pre.directionKey, 'photo_character');
    assert.equal(pre.reason, '这张要靠人物气场立住，用实拍质感出主视觉');
  });

  test('非法值逐项回退：档位/方向/版式各自兜底，不因一项非法丢掉整组判断', () => {
    const out = resolveRecommendation(
      { tier: 'deluxe', directionKey: 'photo_hero_x', templateKey: 'gone_template', reason: '' },
      { ...BARE, scene: 'service', proofPointCount: 2 },
    );
    assert.equal(out.tier, 'standard', '档位非法 → standard（不是随手给个 premium）');
    assert.equal(out.directionKey, 'graphic_symbol', 'service + 无照片的确定性默认方向');
    assert.equal(out.templateKey, 'editorial', '有卖点 → balanced 档，service 的默认版式恰在该档');
    assert.ok(out.reason.length > 0, '模型没给理由时用确定性模板句，不下发空理由');

    // 只有版式非法时，方向仍走模型给的那个（逐项回退，不是整组作废）。
    const partial = resolveRecommendation(
      { tier: 'standard', directionKey: 'graphic_bold_type', templateKey: 123, reason: '一句主张撑满画面' },
      BARE,
    );
    assert.equal(partial.directionKey, 'graphic_bold_type', '版式非法不该连累方向');
    assert.equal(partial.reason, '一句主张撑满画面', '也不该连累理由');
  });

  test('版式兜底按内容密度：一句观点 airy、有卖点 balanced、活动议程 dense', () => {
    const at = (scene: 'personal_brand' | 'event' | 'service' | 'product', proofPointCount: number) =>
      resolveRecommendation({}, { ...BARE, scene, proofPointCount }).templateKey;
    assert.equal(TEMPLATE_CATALOG[at('personal_brand', 0)].density, 'airy', '一条卖点都没有＝一句观点');
    assert.equal(at('personal_brand', 0), 'person_hero', 'scene 默认版式恰在 airy 档时优先用它，不另起一套');
    assert.equal(TEMPLATE_CATALOG[at('personal_brand', 3)].density, 'balanced', '有卖点要摆就不能再留白');
    assert.equal(TEMPLATE_CATALOG[at('service', 0)].density, 'airy');
    assert.equal(TEMPLATE_CATALOG[at('event', 0)].density, 'dense', '活动/议程要一屏交代完，与卖点条数无关');
    assert.equal(at('event', 3), 'agenda_event');
  });

  test('premium 不可用 → 降级 standard 并换理由（原理由已经不成立）', () => {
    const aiReason = '这张要靠人物实拍质感立住，用高级出图';
    const out = resolveRecommendation(
      { tier: 'premium', directionKey: 'photo_character', templateKey: 'editorial', reason: aiReason },
      BARE, // premiumAvailable: false
    );
    assert.equal(out.tier, 'standard', '高级档下不了单就不能推给用户（推了必 422）');
    assert.equal(directionFor(out.directionKey).tier, 'standard', '方向跟着降档，不能留一个 premium 方向');
    assert.notEqual(out.reason, aiReason, '组合被改写了，理由必须跟着改——留着原句就是在承诺一个没买的东西');
    assert.ok(out.reason.includes('高级'), '降级理由要说清是"暂时用不了"，不是悄悄换了个便宜的');
    assert.equal(out.templateKey, 'editorial', '版式合法就不受降级影响');
  });

  test('requiresPortrait 方向只有真有本人照才可推', () => {
    const without = resolveRecommendation(
      { tier: 'standard', directionKey: 'graphic_portrait', templateKey: 'person_hero', reason: '本人出镜最有信任感' },
      BARE,
    );
    assert.notEqual(without.directionKey, 'graphic_portrait', '没上传本人照就推"本人形象"＝确认页点下去必 422');
    assert.equal(without.directionKey, 'graphic_bold_type', 'personal_brand + 无照片的确定性默认');

    const withPortrait = resolveRecommendation(
      { tier: 'standard', directionKey: 'graphic_portrait', templateKey: 'person_hero', reason: '本人出镜最有信任感' },
      { ...BARE, hasPortrait: true },
    );
    assert.equal(withPortrait.directionKey, 'graphic_portrait', '有照片时这条约束不该反过来拦住合法推荐');
  });

  test(`理由超 ${RECOMMEND_REASON_LIMIT} 字被截断，不是原样透传也不是清空`, () => {
    const long = '甲'.repeat(200);
    const out = resolveRecommendation({ tier: 'standard', directionKey: 'graphic_symbol', templateKey: 'quote_card', reason: long }, BARE);
    assert.equal(out.reason.length, RECOMMEND_REASON_LIMIT);
    assert.equal(out.reason, long.slice(0, RECOMMEND_REASON_LIMIT), '截前 N 字，不做省略号处理');
    // 确定性模板句自己也不许超限（含最长的中文方向名/版式名时）。
    for (const scene of ['personal_brand', 'event', 'service', 'product'] as const) {
      const fb = resolveRecommendation({ tier: 'premium' }, { ...BARE, scene });
      assert.ok(fb.reason.length <= RECOMMEND_REASON_LIMIT, `${scene} 的降级模板句超限：${fb.reason}`);
    }
  });

  test('isRecommendationConsistent：四条硬约束逐条拦得住', () => {
    const ok = { tier: 'standard' as const, directionKey: 'graphic_bold_type' as const, templateKey: 'manifesto_min' as const, reason: '一句主张撑满画面' };
    assert.equal(isRecommendationConsistent(ok, { hasPortrait: false, premiumAvailable: false }), true);
    assert.equal(
      isRecommendationConsistent({ ...ok, directionKey: 'photo_character' }, { hasPortrait: false, premiumAvailable: true }),
      false, '方向档位与 tier 不匹配 → 不一致（schema 会 422）',
    );
    assert.equal(
      isRecommendationConsistent({ ...ok, directionKey: 'graphic_portrait' }, { hasPortrait: false, premiumAvailable: false }),
      false, 'requiresPortrait 方向没有本人照 → 不一致',
    );
    assert.equal(
      isRecommendationConsistent({ tier: 'premium', directionKey: 'photo_scene', templateKey: 'editorial', reason: '场景叙事' }, { hasPortrait: false, premiumAvailable: false }),
      false, 'premium 组合本身合法，但此刻高级档下不了单 → 不一致',
    );
    assert.equal(isRecommendationConsistent({ ...ok, reason: '' }, { hasPortrait: false, premiumAvailable: false }), false, '空理由不算一套可展示的推荐');
    assert.equal(isRecommendationConsistent({ ...ok, reason: '甲'.repeat(RECOMMEND_REASON_LIMIT + 1) }, { hasPortrait: false, premiumAvailable: false }), false, '超长理由不一致');
  });

  // 兜底的意义是「无论模型吐什么」都下得了单，所以这里穷举脏输入 × 场景 × 上下文，
  // 用同一个一致性函数复核 resolveRecommendation 的每一个产出。
  test('穷举脏输入：任何组合的产出都过一致性校验', () => {
    const dirty: Record<string, unknown>[] = [
      {}, { tier: null, directionKey: null, templateKey: null, reason: null },
      { tier: 'premium', directionKey: 'graphic_portrait', templateKey: 'person_hero', reason: 42 },
      { tier: 'PREMIUM', directionKey: 'photo_product', templateKey: 'editorial', reason: '  ' },
      { tier: 'standard', directionKey: 'photo_scene', templateKey: 'agenda_event', reason: '场景叙事' },
      { tier: 'premium', directionKey: { key: 'photo_character' }, templateKey: ['editorial'], reason: '甲'.repeat(300) },
    ];
    for (const scene of ['personal_brand', 'event', 'service', 'product'] as const) {
      for (const hasPortrait of [false, true]) {
        for (const premiumAvailable of [false, true]) {
          for (const raw of dirty) {
            const out = resolveRecommendation(raw, { scene, proofPointCount: 2, hasPortrait, premiumAvailable });
            assert.equal(
              isRecommendationConsistent(out, { hasPortrait, premiumAvailable }), true,
              `脏输入 ${JSON.stringify(raw)} 在 ${scene}/portrait=${hasPortrait}/premium=${premiumAvailable} 下产出了下不了单的组合：${JSON.stringify(out)}`,
            );
            assert.ok(POSTER_DIRECTIONS[out.directionKey], '方向必须是白名单里真实存在的一项');
          }
        }
      }
    }
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

  // aiMode 已从代码里退役，但**生产 payload 里可能还留着运营当年拉下的那把熔断锁**
  // （旧版 premiumTierAvailable 要求 aiMode !== 'graphic'，运营就是拿它停高级档的）。
  // 新版不读它 = 发版当天高级档静默重开，这条钉住迁移兼容。
  test('旧 aiMode=graphic 迁移兼容：视同图片供应商关闭 → 高级档不可用', async () => {
    await setPayload({
      aiMode: 'graphic',
      visual: { enabled: true, baseUrl: 'https://example.invalid/v1/images', model: 'demo-model' },
    });
    const locked = await getCreativeConfig({ fresh: true });
    assert.equal(locked.visual.enabled, false, '旧锁必须在归一后的 cfg 上生效，不是只在某个判断里特判');
    assert.equal(premiumTierAvailable(locked), false, '不认这把旧锁就是把运营停掉的档位悄悄开回来');
    assert.equal((await api('GET', '/api/admin/creative/config')).body.visual.enabled, false, '后台看到的也是关');

    // 运营下次保存创作配置时，新 payload 不含 aiMode → 本兼容分支自然失活
    const put = await api('PUT', '/api/admin/creative/config', { body: { visual: { enabled: true } } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    __clearFeatureCache();
    const stored = (await prisma.featureFlag.findUniqueOrThrow({ where: { id: CREATIVE_FLAG_ID } })).payload as Record<string, unknown>;
    assert.equal(stored.aiMode, undefined, '旧字段被 updateCreativeConfig 丢弃');
    assert.equal(premiumTierAvailable(await getCreativeConfig({ fresh: true })), true);
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

  // 版式池扩容（B 组）：新增 5 套必须与老三套走**同一条**白名单/停用/回退路径，
  // 不许有「新版式走了另一套判断」的分叉——那正是模板清单当年在两端对不上的成因。
  test('normalizePosterBrief：新增 5 套版式同样进白名单、同样受停用闸门管', () => {
    const added: TemplateKey[] = ['manifesto_min', 'quote_card', 'data_stat', 'info_list', 'agenda_event'];
    for (const key of added) {
      assert.equal(normalizePosterBrief(brief({ templateKey: key })).templateKey, key, `${key} 应被白名单接受`);
      // 显式请求被停用的新版式 → 422（与 editorial 同一口径，不静默换版）
      assert.throws(
        () => normalizePosterBrief(brief({ templateKey: key }), { [key]: false }),
        /版式暂时不可用/,
        `${key} 被停用时必须 422`,
      );
      // 停用新版式不影响「没指定 templateKey」的 scene 回退
      assert.equal(
        normalizePosterBrief(brief({ templateKey: undefined }), { [key]: false }).templateKey,
        'person_hero',
      );
    }
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

// ─────────────────────────────────────────────────────────────────────────
// designNote 抽取分支（打桩 provider）
//
// 上面所有 brief-draft 用例都在默认测试环境下跑（isAiTestMode()=true → structured() 恒回 null），
// 只覆盖得到「抽不出说明」这一侧。240 字截断、以及 DRAFT_SYS 加长后会不会把 structured() 的
// 输入撑爆/把结尾的 JSON 格式约定挤掉，这两条必须真的走到「AI 吐出了 designNote」这条分支才验证得到。
//
// 用 AI_ALLOW_REAL_PROVIDER=1 只放行 provider **代码路径**（isAiTestMode 短路判断），
// globalThis.fetch 仍打桩、绝不出网——与 test/structuredBilling.test.ts、test/gatewayProvider.test.ts
// 同一手法（该手法本身记在 src/env.ts 的 isAiTestMode 注释里，不是本次新发明）。
// structured() 内部走 getAiConfig() 读的是全局 'chat' purpose 路由（未传 purpose/agentKey），
// 与 gatewayProvider.test.ts 那种「配单个 agent 的 providerMode」不是同一层，
// 必须用 aiV2Admin.configurePurpose('chat', …) 才配得到 structured() 真正读取的那份配置。
describe('海报成品图 · brief-draft designNote 抽取分支（打桩 provider）', () => {
  const CHAT_URL = '/chat/completions';
  const realFetch = globalThis.fetch;

  /**
   * 打桩一次「合法 OpenAI 兼容响应」，content 是 DraftSchema 形状的 JSON。
   * onRequest 可读到本次真实发出的 system 文本与累计调用次数——
   * 用来验证 DRAFT_SYS 有没有被截断、以及是否只用了一轮（未触发校验失败后的回喂修复）。
   */
  function stubDraftJson(
    payload: Record<string, unknown>,
    onRequest?: (systemContent: string, callCount: number) => void,
  ): void {
    let calls = 0;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes(CHAT_URL)) throw new Error(`unexpected fetch: ${url}`);
      calls++;
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: { role?: string; content?: unknown }[] };
      const sys = body.messages?.find((m) => m.role === 'system')?.content;
      onRequest?.(typeof sys === 'string' ? sys : '', calls);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(payload) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  /** 造一个有真实对话内容的会话给抽取分支读（内容本身不重要——fetch 已打桩，模型响应由用例指定）。 */
  async function conversationSession(userId: string, tenantId: string): Promise<string> {
    const session = await prisma.session.create({
      data: { tenantId, userId, agentKey: 'poster', title: '打桩抽取会话' },
    });
    await prisma.message.create({
      data: { sessionId: session.id, role: 'user', contentJson: { text: '帮我做张招生海报，主打信任感' } },
    });
    await prisma.message.create({
      data: { sessionId: session.id, role: 'assistant', contentJson: { text: '好的，我们聊聊细节……' } },
    });
    return session.id;
  }

  before(async () => {
    process.env.AI_ALLOW_REAL_PROVIDER = '1'; // 只放行 provider 代码路径；fetch 仍打桩，不出网
    await __wipeAiV2();
    await configurePurpose('chat', {
      label: 'brief-draft 抽取打桩', provider: 'openai',
      baseUrl: 'http://mock.test/v1', model: 'mock-model', apiKey: 'sk-test-real-123',
    });
  });
  after(async () => {
    delete process.env.AI_ALLOW_REAL_PROVIDER;
    globalThis.fetch = realFetch;
    await __wipeAiV2(); // 恢复现场：不把打桩用的假路由留在库里给后面的文件添麻烦
  });
  beforeEach(async () => {
    await cleanBusiness();
    await seedBaseline();
    await enableCreative();
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  test('designNote 超 240 字被截断到 240（真实抽取分支，不是兜底空值）', async () => {
    const { token, tenantId } = await posterUser(100, '打桩截断用户');
    const sessionId = await conversationSession(token, tenantId);
    const longNote = 'A'.repeat(400);
    stubDraftJson({
      scene: 'personal_brand', goal: '测试目标', audience: '测试受众',
      headline: '标题', subheadline: '副标题', proofPoints: ['卖点一'],
      cta: '立即咨询', visualDirection: '深色背景', templateKey: 'person_hero',
      templateReason: '理由', designNote: longNote,
    });

    const r = await api('GET', `/api/creative/posters/brief-draft?sessionId=${sessionId}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok('designNote' in r.body, '真抽出来了就必须下发这个键');
    assert.equal(r.body.designNote.length, 240, '超过上限必须截断到 240，不是原样透传也不是清空');
    assert.equal(r.body.designNote, longNote.slice(0, 240), '截断取前 240 个字符，不做省略号处理');
  });

  test('designNote 未超 240 字原样下发，不做多余处理', async () => {
    const { token, tenantId } = await posterUser(100, '打桩正常用户');
    const sessionId = await conversationSession(token, tenantId);
    const shortNote = '这张海报主打信任感，主标题居中，配色克制，二维码放右下角。';
    stubDraftJson({ designNote: shortNote });

    const r = await api('GET', `/api/creative/posters/brief-draft?sessionId=${sessionId}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.designNote, shortNote, '未超限不截断、不改写');
  });

  // 任务点名担心的点：DRAFT_SYS 加了一整段「五条设计原则」后变长了，会不会把 structured() 的
  // 输入撑爆、或把结尾的「只输出 JSON」格式约定挤掉。用真实（未改写）的当前 DRAFT_SYS 走一次
  // 打桩抽取：①断言请求里确实带着完整的五条原则与格式约定发了出去（没被裁剪/顶掉）；
  // ②首轮就拿到结构化结果（未触发「校验失败 → 回喂一轮修复」），证明当前长度没有压垮这条链路。
  // 声明范围：这只验证「代码没有在长 system prompt 下自己出故障」（长度/解析/schema 都过关）；
  // 真实模型面对这么长的 system prompt 会不会分心、遵从度下降，这件事本身在打桩环境里
  // 无法验证——fetch 是我们自己接管的，模型从未真正读过这段提示词。
  test('DRAFT_SYS 变长后仍完整送达且首轮抽取成功——排查"是否把 structured() 输入撑爆"', async () => {
    const { token, tenantId } = await posterUser(100, '打桩长提示词用户');
    const sessionId = await conversationSession(token, tenantId);
    let capturedSystem = '';
    let callCount = 0;
    stubDraftJson(
      { scene: 'personal_brand', headline: '标题', designNote: '一段合法的设计说明。' },
      (sys, calls) => { capturedSystem = sys; callCount = calls; },
    );

    const r = await api('GET', `/api/creative/posters/brief-draft?sessionId=${sessionId}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // 五条设计原则一条不少地送到了模型面前（没有被任何截断逻辑吃掉中间一段）。
    for (const marker of ['对齐', '分组', '识别性', '颜色搭配', '风格统一']) {
      assert.ok(capturedSystem.includes(marker), `DRAFT_SYS 里的「${marker}」原则丢失或被截断`);
    }
    // 结尾的 JSON 格式约定仍在尾部完整在场（没被前面新增的大段文字挤出窗口）。
    assert.ok(capturedSystem.includes('只输出一个 JSON 对象'), 'JSON 输出格式约定被淹没/顶掉');
    // designNote 仍排在键名清单的最后一位（它是最容易被后加字段挤走的一项）。
    assert.ok(
      capturedSystem.includes('recommendReason, designNote'),
      'designNote 不在键名清单的末位——格式约定被改写',
    );
    // 2026-08-17：末尾**不许**再出现可以照抄的空值模板。给了空壳，模型会把它当答案原样交回来
    // （生产实测：返回闭合合法但 15 个字段全空的 JSON，zod 全过，确认页整张表单空着）。
    assert.ok(!capturedSystem.includes('"goal":""'), '又把值全为空的 JSON 壳写回提示词了——模型会照抄');
    assert.ok(capturedSystem.includes('不是答案模板'), '缺少「键名清单不是答案模板」这条明规则');
    // 首轮（1 次调用）就通过了 schema 校验；若为 2 说明触发了「回喂修复」轮，
    // 意味着模型首轮输出没通过 zod 校验——即便这里是打桩、必过 schema，也该恒为 1。
    assert.equal(callCount, 1, '首轮即应通过 schema 校验；为 2 则说明抽取分支已经不稳定（触发了修复轮）');
    assert.equal(r.body.brief.headline, '标题', '确认拿到的是真结构化结果，不是解析失败后的兜底空值');
  });

  // 2026-08-17 生产事故的回归钉：确认页「跟设计师聊完，进设计阶段整张表单是空的」。
  // 根因不在提示词、也不在归一，而在这一次调用的两个上限：
  //   ① 不给 maxTokens → 辅助档缺省 700 → 15 字段的中文 JSON 被拦腰截断 → structured() 返回 null
  //      → 每个字段回退成空。而 structured() 解析失败只返回 null 不抛，线上连一行 warn 都没有；
  //   ② maxChars 1200 < DRAFT_TEXT_LIMIT → structured() 内部 `slice(0, maxChars)` 取的是**头部**，
  //      把 loadConversationText 刚按「结论在末尾」保下来的结尾又切掉（实测 2176 字砍掉最后 976 字）。
  // 所以这条钉的不是返回值，而是**真实发出的那个请求**：预算给足、且结尾确实到了模型面前。
  test('抽取请求带足产出预算，且长对话的结尾不被外层截掉', async () => {
    const { token, tenantId } = await posterUser(100, '打桩预算用户');
    const session = await prisma.session.create({
      data: { tenantId, userId: token, agentKey: 'poster', title: '长对话' },
    });
    // 明显超过旧上限（1200 字）的一段对话，且结论只出现在最后一条。
    const filler = '我们先把背景说清楚：这次要推的是给中小商家做的短视频代运营服务。'.repeat(50);
    await prisma.message.create({
      data: { sessionId: session.id, role: 'user', contentJson: { text: filler }, createdAt: new Date('2026-08-17T01:00:00Z') },
    });
    await prisma.message.create({
      data: {
        sessionId: session.id, role: 'user',
        contentJson: { text: '最后定了：主标题就用「三条视频换一个新客」。' },
        createdAt: new Date('2026-08-17T01:05:00Z'),
      },
    });

    // 配一个**与主档不同 baseUrl** 的辅助档路由：抽取若落到 aux，请求就会打到这个地址上。
    // 线上 aux 是 deepseek-v4-flash，实测会把键名清单原样回吐成一份全空 JSON —— 这一步
    // 是用户正盯着确认页等的活，不许走后台小模型那条道。
    await configurePurpose('aux', {
      label: 'brief-draft 辅助档陷阱', provider: 'openai',
      baseUrl: 'http://aux-trap.test/v1', model: 'flash-trap', apiKey: 'sk-test-aux-123',
    });

    let sentBody: Record<string, unknown> = {};
    let sentUrl = '';
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes(CHAT_URL)) throw new Error(`unexpected fetch: ${url}`);
      sentUrl = String(url);
      sentBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ headline: '三条视频换一个新客' }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const r = await api('GET', `/api/creative/posters/brief-draft?sessionId=${session.id}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    assert.ok(
      !sentUrl.includes('aux-trap.test'),
      `抽取落到辅助档小模型了（${sentUrl}）：确认页是用户正等着的一步，不许走 aux 那条道`,
    );

    const maxTokens = Number(sentBody.max_tokens ?? 0);
    assert.ok(
      maxTokens >= 3000,
      `产出预算必须显式给足（实际 ${maxTokens}）：缺省 700 会把这份 15 字段的中文 JSON 截断，structured() 返回 null，确认页整张表单变空`,
    );

    const sent = (sentBody.messages as { role: string; content: string }[] | undefined)
      ?.find((m) => m.role === 'user')?.content ?? '';
    assert.ok(sent.length > 1200, `素材又被切在 1200 字（实际送出 ${sent.length}）——旧的 maxChars 上限回来了`);
    assert.ok(
      sent.includes('三条视频换一个新客'),
      '对话最后一句没送到模型面前：外层 slice 取了头部，把 loadConversationText 按「结论在末尾」保下来的结尾丢了',
    );
  });

  // 2026-08-16 军师推荐组合的**真实抽取分支**：上面纯函数用例验的是归一与兜底，
  // 这里验的是"抽取那一次调用真的把 tier/directionKey/recommendReason 带回来了"——
  // 两者缺一：只测纯函数，字段没接上链路也全绿；只测链路，脏输入的兜底又验不到。
  test('推荐组合：模型给的合法 premium 组合，在高级档可用时原样下发', async () => {
    const { token, tenantId } = await posterUser(100, '打桩推荐用户');
    const sessionId = await conversationSession(token, tenantId);
    // 高级档可下单的唯一条件就是图片供应商配齐并启用（premiumTierAvailable）。
    await setPayload({ visual: { enabled: true, baseUrl: 'https://example.invalid/v1/images', model: 'demo-model' } });
    assert.equal(premiumTierAvailable(await getCreativeConfig({ fresh: true })), true, '前提：这条用例里高级档确实可下单');

    stubDraftJson({
      scene: 'personal_brand', headline: '标题', proofPoints: ['卖点一'],
      templateKey: 'editorial',
      tier: 'premium', directionKey: 'photo_character', recommendReason: '这张要靠人物气场立住，用实拍质感出主视觉',
    });

    const r = await api('GET', `/api/creative/posters/brief-draft?sessionId=${sessionId}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.recommendation, {
      tier: 'premium', directionKey: 'photo_character', templateKey: 'editorial',
      reason: '这张要靠人物气场立住，用实拍质感出主视觉',
    }, '合法组合原样下发：模型读过整段对话，服务端没有理由改写它');
  });

  test('推荐组合：模型推 premium 但高级档不可用 → 降级 standard 并换理由', async () => {
    const { token, tenantId } = await posterUser(100, '打桩降级用户');
    const sessionId = await conversationSession(token, tenantId);
    // 本 describe 的 beforeEach 未配图片供应商 → premiumTierAvailable 为 false。
    assert.equal(premiumTierAvailable(await getCreativeConfig({ fresh: true })), false, '前提：这条用例里高级档下不了单');

    const aiReason = '这张要靠人物实拍质感立住';
    stubDraftJson({
      scene: 'personal_brand', headline: '标题',
      tier: 'premium', directionKey: 'photo_character', templateKey: 'editorial', recommendReason: aiReason,
    });

    const r = await api('GET', `/api/creative/posters/brief-draft?sessionId=${sessionId}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.recommendation.tier, 'standard', '高级档不可用时不许把 premium 推给用户');
    assert.equal(directionFor(r.body.recommendation.directionKey).tier, 'standard', '方向跟着降档');
    assert.notEqual(r.body.recommendation.reason, aiReason, '组合被改写，理由必须跟着改');
  });

  test('推荐组合：模型给非法值 → 服务端确定性合成，键仍恒在', async () => {
    const { token, tenantId } = await posterUser(100, '打桩非法值用户');
    const sessionId = await conversationSession(token, tenantId);
    stubDraftJson({
      scene: 'event', headline: '开业活动', proofPoints: ['卖点一', '卖点二'],
      tier: '豪华档', directionKey: 'photo_hero_x', templateKey: 'gone_template', recommendReason: '',
    });

    const r = await api('GET', `/api/creative/posters/brief-draft?sessionId=${sessionId}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rec = r.body.recommendation;
    assert.equal(rec.tier, 'standard');
    assert.equal(rec.templateKey, 'agenda_event', '活动场景 → dense 档');
    assert.ok(rec.reason.length > 0 && rec.reason.length <= RECOMMEND_REASON_LIMIT, '理由由服务端合成，非空且不超限');
    assert.equal(isRecommendationConsistent(rec, { hasPortrait: false, premiumAvailable: false }), true);
  });
});

/* ───────────────── 版式池：确定性排版（不起浏览器，只查产物结构） ───────────────── */
//
// 这一组和 creativeCanvas.test.ts 里那组「真实渲染量测」是**两件事，缺一不可**：
//   · 这里查的是**结构契约**——每套版式都必须自包含、带 AI 标识、带码位、文案缺失能降级。
//     它跑在常规 npm test 里，是回归的第一道网。
//   · 那边查的是**真实布局**——不越界、不压字、字号下限、二维码静区。它要 Chromium，默认跳过。
// 只有前者会漏掉压字，只有后者跑不进日常回归。
describe('海报成品图 · 版式池（确定性排版）', () => {
  /** 1×1 透明 PNG：素材本体不重要，重要的是「有没有这个素材」这条分支。 */
  const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';

  function html(key: TemplateKey, over: Record<string, unknown> = {}, assets: Record<string, string> = {}) {
    const nb = normalizePosterBrief(brief({ templateKey: key, ...over }));
    return renderPosterHtml({ brief: nb, philosophy: fallbackPhilosophy(nb), assets });
  }

  test('每套版式都产出自包含 HTML：AI 标识在位、无外链、无脚本', () => {
    for (const key of TEMPLATE_KEYS) {
      const out = html(key);
      const audit = auditPosterHtml(out);
      assert.equal(audit.ok, true, `${key} 自检未过：${audit.issues.join('；')}`);
      assert.ok(out.includes('class="poster"'), `${key} 缺画布根元素`);
      assert.ok(out.includes('增长顾问'), `${key} 没把主标题排上画面`);
      assert.ok(out.includes('扫码预约'), `${key} 没把 CTA 排上画面`);
    }
  });

  // ★ 贴码行动区：二维码在与不在，占的是**同一块面积**。
  // 「没传码就不画」会让「有码」与「无码」变成两套版面预算，而长文案下只有一套被验证过。
  test('每套版式都有码位：有 qrUrl 出真码，无 qrUrl 出贴码位（绝不画假二维码）', () => {
    for (const key of TEMPLATE_KEYS) {
      // 注意断言的是**角标标签**而不是「贴码位」三个字：公共 CSS 的注释里也写着这三个字，
      // 拿裸文本判会恒真（第一版就是这么写的，person_hero 立刻把它抓了出来）。
      const holdTag = `<span class="holdtag">${QR_HOLD_TEXT}</span>`;

      const withQr = html(key, {}, { qrUrl: PX });
      assert.ok(withQr.includes('data-role="qr"'), `${key} 有码时必须带 data-role="qr" 供量测可扫性`);
      assert.ok(!withQr.includes(holdTag), `${key} 有真码就不该再出贴码位角标`);

      const noQr = html(key);
      assert.ok(noQr.includes(holdTag), `${key} 无码时必须渲染贴码位（不是省略）`);
      assert.ok(!noQr.includes('data-role="qr"'), `${key} 无码时不许出现二维码元素`);
      assert.ok(noQr.includes('class="qr hold"'), `${key} 贴码位要用统一的浅色块样式`);
      // 绝不画假二维码：无码分支里不许出现任何图片元素冒充码
      assert.ok(!/<img[^>]*class="qr/.test(noQr), `${key} 贴码位里不许放图片冒充二维码`);
    }
  });

  // 密度高的版式必须处理文案缺失：不足 3 条时收缩，不留编号空行/空议程行。
  test('info_list / agenda_event 文案缺失降级：条目数跟着实际卖点走，不留空洞', () => {
    for (const [key, marker] of [['info_list', 'class="li"'], ['agenda_event', 'class="mrow"']] as const) {
      for (const n of [0, 1, 2, 3]) {
        const points = Array.from({ length: n }, (_, i) => `卖点第 ${i + 1} 条`);
        const out = html(key, { proofPoints: points });
        const rows = out.split(marker).length - 1;
        assert.equal(rows, n, `${key} 在 ${n} 条卖点时应渲染 ${n} 行，实际 ${rows} 行`);
        assert.equal(auditPosterHtml(out).ok, true, `${key} ${n} 条卖点时自检应通过`);
      }
    }
  });

  test('data_stat：卖点里有数字就抽成主数据，一个数字都没有就退成纯排印（不编数字）', () => {
    const withNum = html('data_stat', { proofPoints: ['平均降佣 9 个点'] });
    assert.ok(withNum.includes('class="statNum"'), '有数字时应有主数据大字');
    assert.ok(withNum.includes('>9<'), '大字取的是卖点里的那个数字');

    const noNum = html('data_stat', { proofPoints: ['降佣效果稳定可复用'] });
    assert.ok(!noNum.includes('class="statNum"'), '抽不到数字时整块数据区去掉，不留空数字位');
    assert.ok(noNum.includes('降佣效果稳定可复用'), '卖点本身仍照常排进画面');
    assert.equal(auditPosterHtml(noNum).ok, true);
  });

  test('extractStat：取第一条含数字的卖点，注释是整条原文（不把数字从句子中间抠掉）', () => {
    assert.deepEqual(
      extractStat(['服务过很多家', '平均降佣 9 个点', '45% 直客']),
      { value: '9', note: '平均降佣 9 个点' },
      '取第一条含数字的；注释保留整句，抠数字会得到「平均降佣点」',
    );
    assert.equal(extractStat(['45%的直客占比'])?.value, '45%', '百分号跟着数字一起进大字');
    assert.equal(extractStat(['服务 60 家单体酒店'])?.value, '60');
    assert.equal(extractStat(['降佣 3.5 倍'])?.value, '3.5倍', '小数与倍数单位都跟走');
    assert.equal(extractStat(['纯文字没有数字', '也没有']), null, '一个数字都没有 → null，不编造');
    assert.equal(extractStat([]), null);
  });

  test('metaRow：带分隔符拆成标签 + 内容两列，不带分隔符的整条进内容列（不替用户造标签）', () => {
    assert.deepEqual(metaRow('时间：8月20日 20:00'), { label: '时间', value: '8月20日 20:00' });
    assert.deepEqual(metaRow('地点: 杭州文三路'), { label: '地点', value: '杭州文三路' }, '半角冒号也认');
    assert.deepEqual(metaRow('地点|杭州文三路'), { label: '地点', value: '杭州文三路' }, '竖线也认');
    assert.deepEqual(
      metaRow('平均降佣九个点见效快'),
      { label: '', value: '平均降佣九个点见效快' },
      '没有分隔符时标签留空 —— 猜一个标签比没有标签更误导',
    );
    assert.deepEqual(
      metaRow('这是一段很长的没有分隔符的说明：内容'),
      { label: '', value: '这是一段很长的没有分隔符的说明：内容' },
      '冒号前超过 6 字不像标签，整条进内容列',
    );
    assert.deepEqual(metaRow('时间：'), { label: '', value: '时间：' }, '内容为空不算结构位');
  });

  // 高级档的溢价就是那张生成主视觉。任何一套版式把它排丢了，都是收了钱没交付。
  test('每套版式都会把 visualUrl 排进画面（高级档买的就是这张图）', () => {
    for (const key of TEMPLATE_KEYS) {
      const out = html(key, {}, { visualUrl: PX });
      assert.ok(out.includes(PX), `${key} 没有渲染 visualUrl`);
    }
  });

  test('未知 templateKey（模板下线后老任务被重试）→ 抛可读错误，不是裸 TypeError', () => {
    const nb = { ...normalizePosterBrief(brief()), templateKey: 'gone_template' as TemplateKey };
    assert.throws(
      () => renderPosterHtml({ brief: nb, philosophy: fallbackPhilosophy(nb), assets: {} }),
      /未知版式 gone_template/,
    );
  });
});
