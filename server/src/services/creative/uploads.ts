// 源素材上传（人像 / Logo / 二维码）：MIME 白名单与 10MB 上限沿用 services/chatImage.ts 的口径
// （同一类资产不该有两套限制），落私有 OSS + CreativeAsset(kind='source', jobId=null, 带 userId/tenantId 归属)。
// 「先传后建任务」：此时还没有 jobId，故归属校验真源是 CreativeAsset.userId（brief 引用 assetId 时比对）。
import { prisma } from '../../db.js';
import { imageExtFromMime, MAX_IMAGE_BYTES } from '../chatImage.js';
import { checkImage } from './imageModeration.js';
import { creativeAssetKey, putCreativeObject, deleteCreativeObject } from './storage.js';
import type { CreativeUploadResult } from '../../../../shared/contracts';

/** 源素材用途（只作元信息，渲染时按 brief 的 xxxAssetId 取用，不依赖此字段）。 */
export const SOURCE_ROLES = ['portrait', 'logo', 'qr'] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];

export class UploadRejectedError extends Error {
  statusCode: number;
  code: string;
  constructor(message: string, code: string, statusCode = 422) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function normalizeSourceRole(v: unknown): SourceRole {
  return (SOURCE_ROLES as readonly string[]).includes(String(v)) ? (String(v) as SourceRole) : 'portrait';
}

/**
 * 摄取一张源素材。
 * @throws UploadRejectedError 类型/体积/审核不过（路由按 statusCode 回 415/413/422）。
 */
export async function ingestSourceAsset(opts: {
  tenantId: string;
  userId: string;
  mimeType: string;
  buf: Buffer;
  role?: unknown;
  fileName?: string | null;
}): Promise<CreativeUploadResult> {
  if (!imageExtFromMime(opts.mimeType)) {
    throw new UploadRejectedError('仅支持 JPG / PNG / GIF / WebP 图片', 'IMAGE_BAD_TYPE', 415);
  }
  if (!opts.buf?.length) throw new UploadRejectedError('空图片', 'IMAGE_EMPTY', 422);
  if (opts.buf.length > MAX_IMAGE_BYTES) {
    throw new UploadRejectedError('图片过大（单张上限 10MB）', 'IMAGE_TOO_LARGE', 413);
  }

  const role = normalizeSourceRole(opts.role);
  // 审核在**落库之前**：不过审就不该有资产行留在库里（否则要额外清理，还可能被 brief 引用）。
  const verdict = await checkImage(opts.buf, {
    tenantId: opts.tenantId, userId: opts.userId, scene: 'source',
  });
  if (!verdict.pass) {
    throw new UploadRejectedError('这张图片未通过内容审核，换一张再试', 'IMAGE_MODERATION_BLOCKED', 422);
  }

  // 先建行拿 cuid 作 key（key 不可猜），再上传；上传失败回滚该行，避免留下指向空对象的资产。
  const asset = await prisma.creativeAsset.create({
    data: {
      tenantId: opts.tenantId,
      userId: opts.userId,
      jobId: null,
      kind: 'source',
      ossKey: '',
      mimeType: opts.mimeType.toLowerCase(),
      bytes: opts.buf.length,
      metadataJson: {
        role,
        fileName: opts.fileName ?? null,
        moderation: { provider: verdict.provider, skipped: !!verdict.skipped },
      },
    },
    select: { id: true },
  });
  const ossKey = creativeAssetKey({ tenantId: opts.tenantId, jobId: null, assetId: asset.id, mimeType: opts.mimeType });
  try {
    await putCreativeObject(ossKey, opts.buf, opts.mimeType.toLowerCase());
    await prisma.creativeAsset.update({ where: { id: asset.id }, data: { ossKey } });
  } catch (e) {
    await prisma.creativeAsset.delete({ where: { id: asset.id } }).catch(() => {});
    await deleteCreativeObject(ossKey).catch(() => {});
    throw new UploadRejectedError(`素材保存失败：${(e as Error).message}`, 'ASSET_STORE_FAILED', 502);
  }
  return { assetId: asset.id };
}

/**
 * 校验 brief 引用的源素材：必须属本人、kind='source'、MIME 在白名单内。
 * 返回 id → { ossKey, mimeType } 映射；任一不满足抛 422（不静默丢弃引用——用户会以为图已用上）。
 */
export async function resolveBriefAssets(
  userId: string,
  ids: { portraitAssetId?: string; logoAssetId?: string; qrAssetId?: string },
): Promise<Map<string, { ossKey: string; mimeType: string }>> {
  const wanted = [ids.portraitAssetId, ids.logoAssetId, ids.qrAssetId].filter((v): v is string => !!v);
  const out = new Map<string, { ossKey: string; mimeType: string }>();
  if (!wanted.length) return out;
  const rows = await prisma.creativeAsset.findMany({
    where: { id: { in: [...new Set(wanted)] }, userId, kind: 'source' },
    select: { id: true, ossKey: true, mimeType: true },
  });
  const found = new Map(rows.map((r) => [r.id, r]));
  for (const id of wanted) {
    const row = found.get(id);
    // 越权引用（别人的素材）与不存在合并为同一条错误：不区分才不泄露「这个 id 存在但不是你的」。
    if (!row) throw new UploadRejectedError('引用的素材不存在或不属于你', 'ASSET_NOT_FOUND', 422);
    if (!imageExtFromMime(row.mimeType)) throw new UploadRejectedError('引用的素材类型不受支持', 'IMAGE_BAD_TYPE', 422);
    out.set(id, { ossKey: row.ossKey, mimeType: row.mimeType });
  }
  return out;
}
