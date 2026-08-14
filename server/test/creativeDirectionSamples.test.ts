// 海报创作方向样例：只能从真实成功成品复制，审核发布后才进入 C 端 status。
// 样例是全局运营物料，不复用带 userId/tenantId 归属的 CreativeAsset。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { prisma } from '../src/db.js';
import { api, cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.js';
import { CREATIVE_FLAG_ID } from '../src/services/creative/config.js';
import { __clearFeatureCache, setFeatureFlag } from '../src/services/featureFlag.js';
import { putCreativeObject } from '../src/services/creative/storage.js';
import {
  SAMPLE_URL_WINDOW_SEC, sampleUrlExpiresAt, __clearDirectionSampleCache,
} from '../src/services/creative/directionSamples.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

async function seedSucceededPoster(
  directionKey: string,
  tier: 'standard' | 'premium' = 'standard',
  // 默认灌一段假字节：缩略走不通时的兜底路径（存原图）也要被测到。
  imageBytes?: Buffer,
) {
  const token = await login(uniquePhone(), '方向样例来源');
  const { tenantId } = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { tenantId: true } });
  const job = await prisma.creativeJob.create({
    data: {
      tenantId,
      userId: token,
      agentKey: 'poster',
      skillKey: 'canvas_design',
      kind: 'poster',
      status: 'succeeded',
      requestJson: { brief: { tier, directionKey, headline: '真实成品样例' } },
      resultJson: { aiMode: tier === 'premium' ? 'photo' : 'graphic', directionKey },
      idempotencyKey: `direction-sample-${Date.now()}-${Math.random()}`,
      creditCost: tier === 'premium' ? 25 : 10,
      completedAt: new Date(),
    },
  });
  const ossKey = `test/creative/direction-samples/${job.id}.png`;
  const bytes = imageBytes ?? Buffer.from(`real-poster-${directionKey}`);
  await putCreativeObject(ossKey, bytes, 'image/png');
  await prisma.creativeAsset.create({
    data: {
      jobId: job.id,
      tenantId,
      userId: token,
      kind: 'poster_png',
      ossKey,
      mimeType: 'image/png',
      width: 1080,
      height: 1440,
      bytes: bytes.length,
    },
  });
  return { jobId: job.id, token, bytes };
}

describe('海报创作方向真实样例', () => {
  before(async () => { await getApp(); });
  after(async () => {
    // CreativeDirectionSample 是全局运营目录，生产 seed 不清；测试文件自己负责隔离。
    await prisma.creativeDirectionSample.deleteMany();
    await closeApp();
  });
  beforeEach(async () => {
    await prisma.creativeDirectionSample.deleteMany();
    await cleanBusiness();
    await seedBaseline();
    await setFeatureFlag(CREATIVE_FLAG_ID, true);
    __clearFeatureCache();
    // 已发布清单有 60s 进程内缓存：直删库不会通知它，测试之间必须显式清。
    __clearDirectionSampleCache();
  });

  test('草稿不对外；发布后 status 下发真实缩略图，文件内容来自成功任务', async () => {
    const source = await seedSucceededPoster('graphic_bold_type');
    const created = await api('POST', '/api/admin/creative/direction-samples', {
      body: { directionKey: 'graphic_bold_type', sourceJobId: source.jobId },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.status, 'draft');
    // id 必须是 schema 的 cuid，不是手搓的时间戳+短随机（那种能枚举，而公开取图路由只靠 id 不可猜）。
    assert.ok(!String(created.body.id).startsWith('pds_'), 'id 不得再手搓');
    assert.match(created.body.id, /^[a-z0-9]{20,}$/);

    const draftStatus = await api('GET', '/api/creative/status', { token: source.token });
    assert.equal(draftStatus.status, 200);
    const draftDirection = draftStatus.body.directions.find((item: { key: string }) => item.key === 'graphic_bold_type');
    assert.equal(draftDirection.previewUrl, undefined, '未审核草稿不得成为用户示例');

    const published = await api('POST', `/api/admin/creative/direction-samples/${created.body.id}/publish`);
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.status, 'published');

    const liveStatus = await api('GET', '/api/creative/status', { token: source.token });
    const liveDirection = liveStatus.body.directions.find((item: { key: string }) => item.key === 'graphic_bold_type');
    assert.match(liveDirection.previewUrl, /^\/api\/creative\/direction-samples\//);
    const file = await api('GET', liveDirection.previewUrl, { adminToken: false });
    assert.equal(file.status, 200);
    assert.equal(file.body, source.bytes.toString(), '对外样例必须是来源任务成品的真实复制件');
  });

  test('来源任务档位或方向不匹配时拒绝创建', async () => {
    const source = await seedSucceededPoster('graphic_symbol');
    const wrongTier = await api('POST', '/api/admin/creative/direction-samples', {
      body: { directionKey: 'photo_product', sourceJobId: source.jobId },
    });
    assert.equal(wrongTier.status, 422);
    assert.equal(wrongTier.body.code, 'SOURCE_TIER_MISMATCH');

    const wrongDirection = await api('POST', '/api/admin/creative/direction-samples', {
      body: { directionKey: 'graphic_bold_type', sourceJobId: source.jobId },
    });
    assert.equal(wrongDirection.status, 422);
    assert.equal(wrongDirection.body.code, 'SOURCE_DIRECTION_MISMATCH');
    assert.equal(await prisma.creativeDirectionSample.count(), 0);
  });

  test('公开取图只发已发布：草稿 404，后台预览走管理鉴权那条', async () => {
    const source = await seedSucceededPoster('graphic_bold_type');
    const created = await api('POST', '/api/admin/creative/direction-samples', {
      body: { directionKey: 'graphic_bold_type', sourceJobId: source.jobId },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.id as string;
    const publicPath = `/api/creative/direction-samples/${id}/file`;
    const adminPath = `/api/admin/creative/direction-samples/${id}/file`;

    // 草稿是未审核物料：无鉴权路由一律当不存在（形态与其它 404 一致）。
    const draftPublic = await api('GET', publicPath, { adminToken: false });
    assert.equal(draftPublic.status, 404);
    assert.equal(draftPublic.body.code, 'NOT_FOUND');

    // 后台审核动线看的就是草稿 → 管理鉴权那条要发得出来；没有管理凭证则 401。
    const draftAdmin = await api('GET', adminPath);
    assert.equal(draftAdmin.status, 200);
    const draftAnon = await api('GET', adminPath, { adminToken: false });
    assert.equal(draftAnon.status, 401);
    // 后台列表下发的 previewUrl 就指向这条（未配 OSS 时），admin 端不需要自己拼路径。
    const list = await api('GET', '/api/admin/creative/direction-samples');
    assert.equal(list.body[0].previewUrl, adminPath);

    const published = await api('POST', `/api/admin/creative/direction-samples/${id}/publish`);
    assert.equal(published.status, 200, JSON.stringify(published.body));
    const livePublic = await api('GET', publicPath, { adminToken: false });
    assert.equal(livePublic.status, 200);

    // 归档（被同方向新样例顶掉）后同样退出公开面。
    const next = await api('POST', '/api/admin/creative/direction-samples', {
      body: { directionKey: 'graphic_bold_type', sourceJobId: source.jobId },
    });
    await api('POST', `/api/admin/creative/direction-samples/${next.body.id}/publish`);
    const archivedPublic = await api('GET', publicPath, { adminToken: false });
    assert.equal(archivedPublic.status, 404, '归档样例不得继续从公开路由发出');
  });

  test('样例入库存缩略图：短边压到 360，不再存 1080×1440 原图', async () => {
    const origin = await sharp({
      create: { width: 1080, height: 1440, channels: 3, background: { r: 12, g: 34, b: 56 } },
    }).png().toBuffer();
    const source = await seedSucceededPoster('graphic_symbol', 'standard', origin);
    const created = await api('POST', '/api/admin/creative/direction-samples', {
      body: { directionKey: 'graphic_symbol', sourceJobId: source.jobId },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const row = await prisma.creativeDirectionSample.findUniqueOrThrow({ where: { id: created.body.id } });
    assert.equal(row.width, 360, '短边压到 360');
    assert.equal(row.height, 480, '3:4 比例保持');
    assert.ok((row.bytes ?? 0) < origin.length, '缩略必须比原图小');
  });

  test('已发布清单走 60s 进程内缓存，不是每次 status 都查库', async () => {
    const source = await seedSucceededPoster('graphic_bold_type');
    const created = await api('POST', '/api/admin/creative/direction-samples', {
      body: { directionKey: 'graphic_bold_type', sourceJobId: source.jobId },
    });
    await api('POST', `/api/admin/creative/direction-samples/${created.body.id}/publish`);

    const first = await api('GET', '/api/creative/status', { token: source.token });
    const pick = (r: { body: { directions: { key: string; previewUrl?: string }[] } }) =>
      r.body.directions.find((item) => item.key === 'graphic_bold_type');
    assert.ok(pick(first)?.previewUrl, '发布后应下发样例地址');

    // 绕开服务层直删库：清单若仍带样例地址，说明这一次没有再查库（命中缓存）。
    await prisma.creativeDirectionSample.deleteMany();
    const cached = await api('GET', '/api/creative/status', { token: source.token });
    assert.equal(pick(cached)?.previewUrl, pick(first)?.previewUrl, '同一 TTL 内应命中缓存');

    __clearDirectionSampleCache();
    const fresh = await api('GET', '/api/creative/status', { token: source.token });
    assert.equal(pick(fresh)?.previewUrl, undefined, '缓存失效后应回到库的真值');
  });

  test('签名 URL 按 10 分钟窗口对齐：同窗口内完全相同，客户端图片缓存才命中', async () => {
    const base = 1_770_000_000; // 任取一个窗口起点内的秒
    const start = Math.floor(base / SAMPLE_URL_WINDOW_SEC) * SAMPLE_URL_WINDOW_SEC;
    assert.equal(sampleUrlExpiresAt(start), sampleUrlExpiresAt(start + SAMPLE_URL_WINDOW_SEC - 1));
    assert.notEqual(sampleUrlExpiresAt(start), sampleUrlExpiresAt(start + SAMPLE_URL_WINDOW_SEC));
    // 窗口末尾签出的链接也至少还有一整个窗口可用（不会刚发出去就过期）。
    assert.ok(sampleUrlExpiresAt(start + SAMPLE_URL_WINDOW_SEC - 1) - (start + SAMPLE_URL_WINDOW_SEC - 1) > SAMPLE_URL_WINDOW_SEC);
  });
});
