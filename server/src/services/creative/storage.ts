// 创作资产存储：私有 OSS + 未配 OSS 时进程内内存回退（测试/本地零配置可跑，参考 chatImage.ts 的 memStore）。
// key 规范：creative/{tenantId}/{jobId|_loose}/{cuid}.{ext}——cuid 不可猜，jobId 为空的源素材归到 _loose。
// 全部对象 private，对外只发 ossSignedUrl 短签（不给永久公开链接：人像与企业物料属敏感资产，方案 §12）。
import { env } from '../../env.js';
import { ossConfigured, ossPutBuffer, ossGetBuffer, ossSignedUrl, ossDelete } from '../ossUpload.js';
import { IMAGE_MIME_EXT } from '../chatImage.js';

const memStore = new Map<string, Buffer>();

/** 对象 key 前缀（沿用全局 OSS key prefix，便于按前缀配生命周期规则）。 */
function prefix(): string {
  return env.ossKeyPrefix ? `${env.ossKeyPrefix}/` : '';
}

/** 拼一个不可猜的资产 key。assetId 用 CreativeAsset 的 cuid。 */
export function creativeAssetKey(opts: { tenantId: string; jobId?: string | null; assetId: string; mimeType: string }): string {
  const ext = IMAGE_MIME_EXT[opts.mimeType.toLowerCase()] ?? 'png';
  return `${prefix()}creative/${opts.tenantId}/${opts.jobId ?? '_loose'}/${opts.assetId}.${ext}`;
}

/** 存一份资产字节（OSS 私有 or 内存回退）。 */
export async function putCreativeObject(key: string, buf: Buffer, mimeType: string): Promise<void> {
  if (ossConfigured()) {
    await ossPutBuffer(key, buf, mimeType);
    return;
  }
  memStore.set(key, buf);
}

/** 读回资产字节；不存在返回 null。 */
export async function getCreativeObject(key: string): Promise<Buffer | null> {
  if (ossConfigured()) return ossGetBuffer(key);
  return memStore.get(key) ?? null;
}

/** 删除资产（best-effort；内存回退同样删）。 */
export async function deleteCreativeObject(key: string): Promise<void> {
  if (ossConfigured()) {
    await ossDelete(key).catch(() => {});
    return;
  }
  memStore.delete(key);
}

/** 存储是否就绪（生产未配 OSS → 路由回 503，不让用户以为传上去了）。 */
export function creativeStorageReady(): boolean {
  return ossConfigured();
}

/**
 * 短时签名 URL。未配 OSS（测试/本地）时回退到自有鉴权路由 `/api/creative/assets/:id/file`，
 * 保证两种模式下前端拿到的都是「能打开的地址」，口径一致。
 */
export function creativeAssetUrl(assetId: string, ossKey: string, expiresSec = 600): string {
  if (ossConfigured()) return ossSignedUrl(ossKey, expiresSec);
  return `/api/creative/assets/${assetId}/file`;
}
