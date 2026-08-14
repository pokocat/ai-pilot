import sharp from 'sharp';
import { prisma } from '../../db.js';
import { ossConfigured, ossSignedUrl } from '../ossUpload.js';
import {
  creativeDirectionSampleKey,
  getCreativeObject,
  putCreativeObject,
} from './storage.js';
import {
  directionFor,
  directionOptions,
  isPosterDirectionKey,
} from './directions.js';
import type {
  AdminCreativeDirectionSample,
  PosterDirectionKey,
  PosterDirectionOption,
  PosterTier,
} from '../../../../shared/contracts';

export class DirectionSampleError extends Error {
  statusCode: number;
  code: string;
  constructor(message: string, code = 'DIRECTION_SAMPLE_INVALID', statusCode = 422) {
    super(message); this.code = code; this.statusCode = statusCode;
  }
}

type SampleRow = {
  id: string; directionKey: string; tier: string; status: string; sourceJobId: string;
  ossKey: string; mimeType: string; createdAt: Date; updatedAt: Date;
};

/**
 * 签名 URL 的时间窗（秒）。**URL 稳定性是给客户端图片缓存用的**：每次现签，绝对 Expires 逐秒变，
 * 小程序 <image> 只按 URL 认图 → 同一张样例每次进页都算新图重下，缓存 100% miss。
 * 把过期时刻对齐到窗口后，同一窗口内签出的 URL 逐字节相同，缓存才可能命中。
 * 代价：链接最长可用两个窗口（20 分钟），仍属短时效。
 */
export const SAMPLE_URL_WINDOW_SEC = 600;

/** 窗口对齐后的绝对过期秒（同窗口内恒定 → URL 恒定；有效期 = 窗口剩余 + 一个完整窗口）。 */
export function sampleUrlExpiresAt(nowSec: number): number {
  return (Math.floor(nowSec / SAMPLE_URL_WINDOW_SEC) + 2) * SAMPLE_URL_WINDOW_SEC;
}

/**
 * 样例取图地址。配了 OSS 走窗口对齐的签名 URL；未配 OSS（测试/本地）回退到自有取图路由。
 * 回退路由分两条：C 端那条无鉴权、只发已发布样例，后台预览（含草稿）必须走管理鉴权那条。
 */
export function directionSampleUrl(row: Pick<SampleRow, 'id' | 'ossKey'>, scope: 'public' | 'admin' = 'public'): string {
  if (ossConfigured()) {
    // 用 Date.now() 而不是 clock.now()：过期时刻最终由 OSS SDK 按系统时钟算，两边必须同一口径，
    // 否则窗口对齐会错位（测试时钟偏移会把签名 URL 的有效期算歪）。
    const nowSec = Math.floor(Date.now() / 1000);
    return ossSignedUrl(row.ossKey, sampleUrlExpiresAt(nowSec) - nowSec);
  }
  return scope === 'admin'
    ? `/api/admin/creative/direction-samples/${row.id}/file`
    : `/api/creative/direction-samples/${row.id}/file`;
}

function view(row: SampleRow): AdminCreativeDirectionSample {
  const direction = directionFor(row.directionKey as PosterDirectionKey);
  return {
    id: row.id,
    directionKey: direction.key,
    directionName: direction.name,
    tier: direction.tier,
    status: row.status as AdminCreativeDirectionSample['status'],
    sourceJobId: row.sourceJobId,
    // 后台列表要预览未发布草稿 → 取图地址指向管理鉴权那条路由。
    previewUrl: directionSampleUrl(row, 'admin'),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 已发布样例清单的进程内缓存（口径同 featureFlag / getCreativeConfig：60s TTL + 写时失效）。
 * `GET /creative/status` 是成果卡高频调用，此前每次都全表 findMany 一遍全部已发布样例。
 * 按 includePremium 分 key：两种口径捞的行不同（premium 不可用时根本不该捞 premium 行）。
 */
const optionsCache = new Map<string, { v: PosterDirectionOption[]; t: number }>();
const OPTIONS_TTL_MS = 60_000;

/** 发布 / 归档 / 新建样例后立即失效：缓存不许成为「哪些样例对外」的第二处真源。 */
function invalidateDirectionOptions(): void {
  optionsCache.clear();
}

/** 清缓存（测试用；同 featureFlag 的 __clearFeatureCache）。 */
export function __clearDirectionSampleCache(): void {
  optionsCache.clear();
}

export async function publishedDirectionOptions(includePremium: boolean): Promise<PosterDirectionOption[]> {
  const cacheKey = includePremium ? 'premium' : 'standard';
  const hit = optionsCache.get(cacheKey);
  // 缓存的是拼好的清单（含签名 URL）：URL 已按窗口对齐，最长 60s 的缓存期内不会过期。
  if (hit && Date.now() - hit.t < OPTIONS_TTL_MS) return hit.v;
  const rows = await prisma.creativeDirectionSample.findMany({
    // tier 过滤下推到 where：premium 不可用时那些行捞回来也只会被丢掉。
    where: { status: 'published', ...(includePremium ? {} : { tier: 'standard' }) },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, ossKey: true, directionKey: true },
  });
  const latest = new Map(rows.map((row) => [row.directionKey, row]));
  const options = directionOptions()
    .filter((item) => item.tier === 'standard' || includePremium)
    .map((item) => {
      const sample = latest.get(item.key);
      return sample ? { ...item, previewUrl: directionSampleUrl(sample) } : item;
    });
  optionsCache.set(cacheKey, { v: options, t: Date.now() });
  return options;
}

export async function listDirectionSamples(): Promise<AdminCreativeDirectionSample[]> {
  const rows = await prisma.creativeDirectionSample.findMany({ orderBy: { updatedAt: 'desc' } });
  return rows.filter((row) => isPosterDirectionKey(row.directionKey)).map(view);
}

/** 样例缩略图短边上限。样例只当选择器缩略图用，前端没有看原图的入口。 */
const SAMPLE_THUMB_SHORT_EDGE = 360;

/**
 * 把成品原图压成样例缩略图（短边 ≤ 360）。原图 1080×1440 通常 1~3MB，六个方向一起下发是
 * 小程序进出图页最重的一笔流量，而选择器只需要看清版式气质。
 * 解码失败（非图片字节 / 异常格式）退回原图：样例宁可大一点，也不能因为压不动就建不出来。
 */
async function sampleThumbnail(
  buffer: Buffer,
  mimeType: string,
  fallback: { width: number | null; height: number | null },
): Promise<{ buffer: Buffer; mimeType: string; width: number | null; height: number | null }> {
  const normalized = mimeType.toLowerCase();
  try {
    const resized = sharp(buffer, { animated: false, failOn: 'error' })
      .rotate()
      // fit:'outside' 保证**短边**落在 360（inside 会让短边小于 360）。
      .resize({ width: SAMPLE_THUMB_SHORT_EDGE, height: SAMPLE_THUMB_SHORT_EDGE, fit: 'outside', withoutEnlargement: true });
    const outMime = normalized === 'image/png' ? 'image/png' : normalized === 'image/webp' ? 'image/webp' : 'image/jpeg';
    const pipeline = outMime === 'image/png'
      ? resized.png({ compressionLevel: 9 })
      : outMime === 'image/webp' ? resized.webp({ quality: 82 }) : resized.jpeg({ quality: 82, mozjpeg: true });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return { buffer: data, mimeType: outMime, width: info.width, height: info.height };
  } catch {
    return { buffer, mimeType, width: fallback.width, height: fallback.height };
  }
}

export async function createDirectionSampleFromJob(input: {
  directionKey: PosterDirectionKey;
  sourceJobId: string;
  createdBy?: string | null;
}): Promise<AdminCreativeDirectionSample> {
  if (!isPosterDirectionKey(input.directionKey)) throw new DirectionSampleError('未知创作方向');
  const job = await prisma.creativeJob.findUnique({ where: { id: input.sourceJobId } });
  if (!job || job.status !== 'succeeded') throw new DirectionSampleError('只能从已成功的海报任务生成样例', 'SOURCE_JOB_INVALID');
  const request = job.requestJson && typeof job.requestJson === 'object' && !Array.isArray(job.requestJson)
    ? job.requestJson as Record<string, unknown> : {};
  const brief = request.brief && typeof request.brief === 'object' && !Array.isArray(request.brief)
    ? request.brief as Record<string, unknown> : {};
  const direction = directionFor(input.directionKey);
  const jobTier: PosterTier = brief.tier === 'premium' ? 'premium' : 'standard';
  if (jobTier !== direction.tier) throw new DirectionSampleError('来源任务的创作路线与样例方向不匹配', 'SOURCE_TIER_MISMATCH');
  if (brief.directionKey && brief.directionKey !== input.directionKey) {
    throw new DirectionSampleError('来源任务记录的创作方向不匹配', 'SOURCE_DIRECTION_MISMATCH');
  }
  const asset = await prisma.creativeAsset.findFirst({
    where: { jobId: job.id, kind: 'poster_png' },
    orderBy: { createdAt: 'desc' },
  });
  if (!asset) throw new DirectionSampleError('来源任务没有可用成品图', 'SOURCE_ASSET_MISSING');
  const buffer = await getCreativeObject(asset.ossKey);
  if (!buffer?.length) throw new DirectionSampleError('来源成品文件已不可用', 'SOURCE_ASSET_MISSING');

  const thumb = await sampleThumbnail(buffer, asset.mimeType, { width: asset.width, height: asset.height });

  // 先建行拿 cuid，再用 cuid 拼 ossKey（同 worker.ts 的 saveAsset）。
  // **id 不显式传**：手搓的时间戳+8 位随机 id 可枚举，而「id 不可猜」是公开取图路由的唯一门禁。
  const created = await prisma.creativeDirectionSample.create({
    data: {
      directionKey: direction.key,
      tier: direction.tier,
      status: 'draft',
      sourceJobId: job.id,
      ossKey: '',
      mimeType: thumb.mimeType,
      width: thumb.width,
      height: thumb.height,
      bytes: thumb.buffer.length,
      createdBy: input.createdBy ?? null,
    },
    select: { id: true },
  });
  const ossKey = creativeDirectionSampleKey({ sampleId: created.id, mimeType: thumb.mimeType });
  await putCreativeObject(ossKey, thumb.buffer, thumb.mimeType);
  const row = await prisma.creativeDirectionSample.update({ where: { id: created.id }, data: { ossKey } });
  invalidateDirectionOptions();
  return view(row);
}

export async function publishDirectionSample(id: string): Promise<AdminCreativeDirectionSample> {
  const source = await prisma.creativeDirectionSample.findUnique({ where: { id } });
  if (!source || source.status === 'archived') throw new DirectionSampleError('样例不存在', 'DIRECTION_SAMPLE_NOT_FOUND', 404);
  // ⚠️ 归档只改状态，**不删 OSS 对象**：已发出的签名 URL 在窗口内仍能打开旧样例（最长 20 分钟），
  // 之后也只是「无人引用但仍在桶里」。删不删涉及产品取舍（发布回滚 / 留证 vs 物料清理），是待决项。
  const row = await prisma.$transaction(async (tx) => {
    await tx.creativeDirectionSample.updateMany({
      where: { directionKey: source.directionKey, status: 'published', id: { not: id } },
      data: { status: 'archived' },
    });
    return tx.creativeDirectionSample.update({ where: { id }, data: { status: 'published' } });
  });
  invalidateDirectionOptions();
  return view(row);
}

async function loadSampleFile(where: { id: string; status?: string }): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const row = await prisma.creativeDirectionSample.findFirst({ where, select: { ossKey: true, mimeType: true } });
  if (!row?.ossKey) return null;
  const buffer = await getCreativeObject(row.ossKey);
  return buffer?.length ? { buffer, mimeType: row.mimeType } : null;
}

/**
 * 公开取图（无鉴权路由用）：**只发已发布样例**，草稿与归档一律当不存在。
 * 未审核物料不该被一条无鉴权路由送出去，cuid 不可猜只是第二道。
 */
export async function getDirectionSampleFile(id: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  return loadSampleFile({ id, status: 'published' });
}

/** 后台预览取图：任意状态（含草稿）。调用方必须在管理鉴权之后。 */
export async function getDirectionSampleFileForAdmin(id: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  return loadSampleFile({ id });
}
