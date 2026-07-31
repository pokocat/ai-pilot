// 作品库（历史成品图列表）：GET /creative/posters 的收录口径 / 倒序 / 游标分页 / 归属隔离。
//
// 为什么大部分行是直接写库造的：本接口是**纯读**，它的语义（收哪些、怎么排、翻页边界）与 worker
// 能不能真出图无关。走一遍真实出图链路只会把「列表口径」的回归用例绑到渲染器上，渲染一变全红。
// 唯一走真实接口建单的用例是「刚建的单立刻以制作中出现在作品库」——那条要的正是端到端连通性。
//
// 前提同 creative.test.ts：功能开关只有 FeatureFlag 行 'creative-poster'（行缺失=关），
// cleanBusiness() 每例都删行，故每个 beforeEach 都要 enableCreative() + 清缓存。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.js';
import { grantCredits } from '../src/services/credits.js';
import { setFeatureFlag, __clearFeatureCache } from '../src/services/featureFlag.js';
import { CREATIVE_FLAG_ID } from '../src/services/creative/config.js';
import { POSTER_LIST_DEFAULT_LIMIT, POSTER_LIST_MAX_LIMIT } from '../src/services/creative/jobs.js';
import type { CreativePosterListResult } from '../../shared/contracts';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

async function enableCreative(): Promise<void> {
  await setFeatureFlag(CREATIVE_FLAG_ID, true);
  __clearFeatureCache();
}

async function posterUser(name = '作品库用户'): Promise<{ token: string; tenantId: string }> {
  const token = await login(uniquePhone(), name);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { tenantId: true } });
  await prisma.userAgent.create({ data: { userId: token, agentKey: 'poster', source: 'admin_grant' } });
  await grantCredits(user.tenantId, token, 200, '测试充值');
  return { token, tenantId: user.tenantId };
}

let seq = 0;

/**
 * 直接落一条创作任务行（可选连带成品图资产）。
 * createdAt 显式给值：倒序与游标都按它排，同一毫秒内建的行会让「谁在前」变成运气。
 */
async function seedJob(opts: {
  token: string;
  tenantId: string;
  status: string;
  headline?: string;
  templateKey?: string;
  progress?: string | null;
  parentJobId?: string | null;
  /** true = 连带一条 poster_png 资产（succeeded 行的收录条件）。 */
  withPoster?: boolean;
  createdAt: Date;
}): Promise<string> {
  const job = await prisma.creativeJob.create({
    data: {
      tenantId: opts.tenantId,
      userId: opts.token,
      agentKey: 'poster',
      skillKey: 'canvas_design',
      kind: 'poster',
      status: opts.status,
      progress: opts.progress ?? null,
      parentJobId: opts.parentJobId ?? null,
      requestJson: {
        brief: {
          headline: opts.headline ?? '增长顾问',
          templateKey: opts.templateKey ?? 'person_hero',
        },
      },
      idempotencyKey: `seed-${Date.now()}-${seq++}`,
      creditCost: 10,
      createdAt: opts.createdAt,
      ...(opts.status === 'succeeded' ? { completedAt: opts.createdAt } : {}),
    },
    select: { id: true },
  });
  if (opts.withPoster) {
    await prisma.creativeAsset.create({
      data: {
        jobId: job.id,
        tenantId: opts.tenantId,
        userId: opts.token,
        kind: 'poster_png',
        ossKey: `creative/${opts.tenantId}/${job.id}/poster.png`,
        mimeType: 'image/png',
        width: 1080,
        height: 1440,
      },
    });
  }
  return job.id;
}

async function listPosters(token: string, qs = ''): Promise<{ status: number; body: CreativePosterListResult & { code?: string } }> {
  return api('GET', `/api/creative/posters${qs}`, { token });
}

/** 递增时间：第 n 条比第 n-1 条晚一分钟（倒序断言才有确定顺序）。 */
function at(minutes: number): Date {
  return new Date(Date.UTC(2026, 6, 1, 0, minutes, 0));
}

describe('作品库 · 历史成品图列表', () => {
  before(async () => { await getApp(); await seedBaseline(); });
  after(async () => { await closeApp(); });
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); await enableCreative(); });

  test('未登录 → 401', async () => {
    const r = await api('GET', '/api/creative/posters');
    assert.equal(r.status, 401);
  });

  test('没出过图 → 空列表且不给 nextCursor（不是 404）', async () => {
    const u = await posterUser();
    const r = await listPosters(u.token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items, []);
    assert.equal(r.body.nextCursor, undefined, '空列表不该给游标，否则前端会一直翻');
  });

  test('收录口径：已完成（有成品图）与制作中收，失败/取消/无产物的不收', async () => {
    const u = await posterUser();
    const ok = await seedJob({ ...u, status: 'succeeded', withPoster: true, headline: '已完成的那张', createdAt: at(1) });
    const running = await seedJob({ ...u, status: 'running', progress: 'visual', headline: '正在做', createdAt: at(2) });
    const pending = await seedJob({ ...u, status: 'pending', progress: 'philosophy', createdAt: at(3) });
    const noAsset = await seedJob({ ...u, status: 'succeeded', createdAt: at(4) }); // 数据异常：成功却没产物
    const failed = await seedJob({ ...u, status: 'failed', createdAt: at(5) });
    const cancelled = await seedJob({ ...u, status: 'cancelled', createdAt: at(6) });

    const r = await listPosters(u.token);
    assert.equal(r.status, 200);
    const ids = r.body.items.map((i) => i.jobId);
    assert.deepEqual(ids, [pending, running, ok], 'createdAt 倒序，且只收 3 条');
    for (const dropped of [noAsset, failed, cancelled]) {
      assert.ok(!ids.includes(dropped), `不该收录 ${dropped}`);
    }

    const done = r.body.items.find((i) => i.jobId === ok)!;
    assert.equal(done.status, 'succeeded');
    assert.equal(done.headline, '已完成的那张', 'headline 取建单时定格的 brief');
    assert.equal(done.templateKey, 'person_hero');
    assert.ok(done.poster?.previewUrl, '已完成项必须带缩略预览 URL');
    assert.equal(done.poster?.kind, 'poster_png');
    assert.equal(done.progress, undefined, '终态项不该带 progress（看起来像还在跑）');
    assert.ok(done.completedAt, '已完成项带完成时间');

    const inFlight = r.body.items.find((i) => i.jobId === running)!;
    assert.equal(inFlight.status, 'running');
    assert.equal(inFlight.progress, 'visual', '制作中项带阶段，供前端显示「制作中」角标');
    assert.equal(inFlight.poster, undefined, '制作中项没有成品图');
  });

  test('版本链平铺：revise/regenerate 的每一版都单独成项，并带 parentJobId', async () => {
    const u = await posterUser();
    const v1 = await seedJob({ ...u, status: 'succeeded', withPoster: true, headline: '第一版', createdAt: at(1) });
    const v2 = await seedJob({ ...u, status: 'succeeded', withPoster: true, headline: '第二版', parentJobId: v1, createdAt: at(2) });

    const r = await listPosters(u.token);
    assert.deepEqual(r.body.items.map((i) => i.jobId), [v2, v1], '早期版本不该只能顺版本链往上翻');
    assert.equal(r.body.items[0].parentJobId, v1);
    assert.equal(r.body.items[1].parentJobId, undefined);
  });

  test('游标分页：倒序连续、不重不漏，翻到底不再给游标', async () => {
    const u = await posterUser();
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(await seedJob({ ...u, status: 'succeeded', withPoster: true, headline: `第 ${i} 张`, createdAt: at(i) }));
    }
    const expected = [...ids].reverse();

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await listPosters(u.token, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(r.status, 200);
      seen.push(...r.body.items.map((i) => i.jobId));
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    assert.equal(cursor, undefined, '最后一页不该再给游标');
    assert.deepEqual(seen, expected, '三页拼起来应等于全量倒序，且无重复');
  });

  test('limit：非法值回落默认、超上限被夹住', async () => {
    const u = await posterUser();
    const total = POSTER_LIST_MAX_LIMIT + 1;
    await prisma.creativeJob.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        tenantId: u.tenantId,
        userId: u.token,
        agentKey: 'poster',
        skillKey: 'canvas_design',
        kind: 'poster',
        status: 'pending',
        requestJson: { brief: { headline: `批量 ${i}` } },
        idempotencyKey: `bulk-${i}-${seq++}`,
        creditCost: 10,
        createdAt: at(i + 1),
      })),
    });

    const clamped = await listPosters(u.token, '?limit=999');
    assert.equal(clamped.body.items.length, POSTER_LIST_MAX_LIMIT, 'limit 必须夹到上限');
    assert.ok(clamped.body.nextCursor, '还有剩余就该给游标');

    const fallback = await listPosters(u.token, '?limit=abc');
    assert.equal(fallback.body.items.length, POSTER_LIST_DEFAULT_LIMIT, '非法 limit 回落默认页长');
  });

  test('游标非法 → 422 CURSOR_INVALID（不静默当第一页，否则客户端会无限翻）', async () => {
    const u = await posterUser();
    const r = await listPosters(u.token, '?cursor=not-a-cursor');
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'CURSOR_INVALID');
  });

  test('归属隔离：看不到别人的海报，拿别人的游标也翻不出来', async () => {
    const a = await posterUser('甲');
    const b = await posterUser('乙');
    const mine = await seedJob({ ...a, status: 'succeeded', withPoster: true, headline: '我的', createdAt: at(1) });
    const hers = await seedJob({ ...b, status: 'succeeded', withPoster: true, headline: '别人的', createdAt: at(2) });

    const ra = await listPosters(a.token);
    assert.deepEqual(ra.body.items.map((i) => i.jobId), [mine], '甲只看得到自己的');

    // 拿乙的任务 id 拼一个"看起来合法"的游标：仍只在甲自己的集合里做 keyset 比较，翻不出别人的行。
    const forged = `${at(3).getTime()}:${hers}`;
    const spoof = await listPosters(a.token, `?cursor=${encodeURIComponent(forged)}`);
    assert.equal(spoof.status, 200);
    assert.deepEqual(spoof.body.items.map((i) => i.jobId), [mine], '越权游标只影响时间坐标，不越过归属');

    // 详情页同口径：越权一律 404（不区分「不存在」与「不是你的」）。
    const detail = await api('GET', `/api/creative/jobs/${hers}`, { token: a.token });
    assert.equal(detail.status, 404);
  });

  test('端到端：刚建的单立刻以「制作中」出现在作品库', async () => {
    const u = await posterUser();
    const created = await api('POST', '/api/creative/posters', {
      token: u.token,
      body: {
        brief: {
          scene: 'personal_brand',
          goal: '拉到 20 个咨询线索',
          audience: '中小企业主',
          headline: '刚下的单',
          proofPoints: ['服务 200+ 客户'],
          cta: '扫码预约',
          visualDirection: '克制的深色背景，人物居中',
          ratio: '3:4',
        },
        idempotencyKey: `gallery-e2e-${Date.now()}`,
      },
    });
    assert.equal(created.status, 201, `建单应 201：${JSON.stringify(created.body)}`);

    const r = await listPosters(u.token);
    const item = r.body.items.find((i) => i.jobId === created.body.jobId);
    assert.ok(item, '新任务应立刻可在作品库里看到，不必等出图');
    assert.ok(item!.status === 'pending' || item!.status === 'running');
    assert.equal(item!.headline, '刚下的单');
  });
});
