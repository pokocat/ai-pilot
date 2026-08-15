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
  createDirectionSampleFromJob, getDirectionSampleFile,
} from '../src/services/creative/directionSamples.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

async function seedSucceededPoster(
  directionKey: string,
  tier: 'standard' | 'premium' = 'standard',
  imageBytes?: Buffer,
  resultJson?: Record<string, unknown>,
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
      audience: 'internal',
      status: 'succeeded',
      requestJson: { brief: { tier, directionKey, headline: '真实成品样例' } },
      resultJson: resultJson ?? { aiMode: tier === 'premium' ? 'photo' : 'graphic', directionKey, degraded: false },
      idempotencyKey: `direction-sample-${Date.now()}-${Math.random()}`,
      creditCost: tier === 'premium' ? 25 : 10,
      completedAt: new Date(),
    },
  });
  const ossKey = `test/creative/direction-samples/${job.id}.png`;
  const bytes = imageBytes ?? await sharp({
    create: { width: 36, height: 48, channels: 3, background: { r: 12, g: 34, b: 56 } },
  }).png().toBuffer();
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
    const sourceJob = await prisma.creativeJob.findUniqueOrThrow({ where: { id: source.jobId }, select: { audience: true } });
    assert.equal(sourceJob.audience, 'internal', '方向样例只允许使用预先归类的内部任务');
    const adminJobs = await api('GET', '/api/admin/creative/jobs');
    const adminSource = adminJobs.body.items.find((item: { id: string }) => item.id === source.jobId);
    assert.equal(adminSource?.audience, 'internal');
    assert.equal(adminSource?.sampleSource, true, '任务台必须明确标出方向样例来源，且不提供恢复用户作品的误导动作');

    const sourceDetail = await api('GET', `/api/creative/jobs/${source.jobId}`, { token: source.token });
    assert.equal(sourceDetail.status, 404, '方向样例来源不得再从 C 端详情访问');
    const sourceGallery = await api('GET', '/api/creative/posters', { token: source.token });
    assert.equal(sourceGallery.body.items.some((item: { jobId: string }) => item.jobId === source.jobId), false);

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
    const stored = await getDirectionSampleFile(created.body.id);
    assert.ok(stored?.buffer.length, '公开路由与服务层都必须读到真实图片');
    const meta = await sharp(stored!.buffer).metadata();
    assert.deepEqual([meta.width, meta.height], [36, 48]);
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

  test('真实用户作品未先归为内部任务时拒绝拿去做公开样例', async () => {
    const source = await seedSucceededPoster('graphic_symbol');
    await prisma.creativeJob.update({ where: { id: source.jobId }, data: { audience: 'user' } });

    const created = await api('POST', '/api/admin/creative/direction-samples', {
      body: { directionKey: 'graphic_symbol', sourceJobId: source.jobId },
    });
    assert.equal(created.status, 422, JSON.stringify(created.body));
    assert.equal(created.body.code, 'SOURCE_JOB_NOT_INTERNAL');
    const sourceJob = await prisma.creativeJob.findUniqueOrThrow({ where: { id: source.jobId }, select: { audience: true } });
    assert.equal(sourceJob.audience, 'user', '拒绝创建时不得顺手隐藏真实用户作品');
    assert.equal(await prisma.creativeDirectionSample.count(), 0);
  });

  test('来源 brief 写 premium、实际却降级 graphic 时拒绝成为高级样例', async () => {
    const source = await seedSucceededPoster('photo_product', 'premium', undefined, {
      aiMode: 'graphic', directionKey: 'photo_product', degraded: true, visualAssetId: null,
    });
    const created = await api('POST', '/api/admin/creative/direction-samples', {
      body: { directionKey: 'photo_product', sourceJobId: source.jobId },
    });
    assert.equal(created.status, 422, JSON.stringify(created.body));
    assert.equal(created.body.code, 'SOURCE_ROUTE_MISMATCH');
    assert.equal(await prisma.creativeDirectionSample.count(), 0);
  });

  test('上传失败会补偿删除草稿，不留下 ossKey 为空的幽灵记录', async () => {
    const source = await seedSucceededPoster('graphic_symbol');
    await assert.rejects(
      createDirectionSampleFromJob(
        { directionKey: 'graphic_symbol', sourceJobId: source.jobId },
        { putObject: async () => { throw new Error('simulated upload failure'); } },
      ),
      /simulated upload failure/,
    );
    assert.equal(await prisma.creativeDirectionSample.count(), 0);
    const sourceJob = await prisma.creativeJob.findUniqueOrThrow({ where: { id: source.jobId }, select: { audience: true } });
    assert.equal(sourceJob.audience, 'internal', '复制失败不应篡改来源任务既有归类');
  });

  test('发布前校验 ossKey、对象存在性与图片可解码性，失败保持 draft', async () => {
    const source = await seedSucceededPoster('graphic_symbol');
    const sourceJob = await prisma.creativeJob.findUniqueOrThrow({ where: { id: source.jobId } });
    const empty = await prisma.creativeDirectionSample.create({
      data: {
        directionKey: 'graphic_symbol', tier: 'standard', status: 'draft', sourceJobId: source.jobId,
        ossKey: '', mimeType: 'image/png', bytes: 0,
      },
    });
    const missing = await api('POST', `/api/admin/creative/direction-samples/${empty.id}/publish`);
    assert.equal(missing.status, 422, JSON.stringify(missing.body));
    assert.equal(missing.body.code, 'DIRECTION_SAMPLE_FILE_MISSING');

    const corruptKey = `test/creative/direction-samples/corrupt-${sourceJob.id}.png`;
    await putCreativeObject(corruptKey, Buffer.from('not-an-image'), 'image/png');
    const corrupt = await prisma.creativeDirectionSample.create({
      data: {
        directionKey: 'graphic_symbol', tier: 'standard', status: 'draft', sourceJobId: source.jobId,
        ossKey: corruptKey, mimeType: 'image/png', bytes: 12,
      },
    });
    const invalid = await api('POST', `/api/admin/creative/direction-samples/${corrupt.id}/publish`);
    assert.equal(invalid.status, 422, JSON.stringify(invalid.body));
    assert.equal(invalid.body.code, 'DIRECTION_SAMPLE_FILE_INVALID');
    const rows = await prisma.creativeDirectionSample.findMany({ select: { status: true } });
    assert.deepEqual(rows.map((row) => row.status), ['draft', 'draft']);
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
