// 阿里云 OSS 上传（报告网页版静态托管，不暴露后端域名）。用官方 ali-oss SDK——
// 签名/重试/endpoint/内网切换等细节交给 SDK，便于后续扩展(删除/签名URL/STS/图片产出存储)。
// 上传走 env.ossEndpoint(可填内网 endpoint，免公网流量、更快);分享链接走 env.ossBaseUrl(公网)。对象 public-read。
import OSS from 'ali-oss';
import { env } from '../env.js';

/** OSS 是否已配齐（缺任一项 → 调用方回退后端 /api/r/:id）。测试环境一律视为未配置，绝不打真实 OSS。 */
export function ossConfigured(): boolean {
  if (process.env.NODE_ENV === 'test') return false;
  return !!(env.ossBucket && env.ossAccessKeyId && env.ossAccessKeySecret && env.ossBaseUrl && (env.ossEndpoint || env.ossRegion));
}

let client: OSS | null = null;
function oss(): OSS {
  if (!client) {
    client = new OSS({
      accessKeyId: env.ossAccessKeyId,
      accessKeySecret: env.ossAccessKeySecret,
      bucket: env.ossBucket,
      // endpoint 优先(支持内网 oss-cn-xxx-internal);否则用 region。
      ...(env.ossEndpoint ? { endpoint: `https://${env.ossEndpoint}` } : { region: `oss-${env.ossRegion || 'cn-hangzhou'}` }),
      secure: true,
      timeout: env.ossTimeoutMs,
    });
  }
  return client;
}

/** 把 HTML 以 public-read 上传到 OSS `key`，返回公网可分享链接(env.ossBaseUrl + key)。失败抛出。 */
export async function ossPutHtml(key: string, html: string): Promise<string> {
  await oss().put(key, Buffer.from(html, 'utf8'), {
    mime: 'text/html',
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'x-oss-object-acl': 'public-read', 'Cache-Control': 'public, max-age=600' },
  });
  return `${env.ossBaseUrl}/${key}`;
}

/**
 * 上传任意二进制到 OSS `key`，以 **public-read** ACL 存，返回公网可访问链接（env.ossBaseUrl + key）。
 * 用于头像等可公开、需长期稳定访问的图片（小程序 <image> 直接展示，免签名 URL 过期）。失败抛出。
 */
export async function ossPutPublic(key: string, buf: Buffer, contentType: string): Promise<string> {
  await oss().put(key, buf, {
    mime: contentType,
    headers: { 'Content-Type': contentType, 'x-oss-object-acl': 'public-read', 'Cache-Control': 'public, max-age=31536000' },
  });
  return `${env.ossBaseUrl}/${key}`;
}

/**
 * 上传任意二进制到 OSS `key`，以 **private** ACL 存（用户上传的业务资料原件，不公开）。返回对象 key。
 * 预览/下载请用 ossSignedUrl() 取有时限的签名链接，避免裸链外泄。失败抛出。
 */
export async function ossPutBuffer(key: string, buf: Buffer, contentType: string): Promise<string> {
  await oss().put(key, buf, {
    mime: contentType,
    headers: { 'Content-Type': contentType, 'x-oss-object-acl': 'private', 'Cache-Control': 'private, max-age=0' },
  });
  return key;
}

/**
 * 为私有对象生成有时限的签名访问 URL。上传可能走内网 endpoint，签名 URL 的 host 强制换成公网
 * baseUrl —— V1 签名只覆盖 path + expires + 子资源，与 host 无关，换 host 不影响校验。
 */
export function ossSignedUrl(key: string, expiresSec = 600): string {
  const signed = oss().signatureUrl(key, { expires: expiresSec });
  if (!env.ossBaseUrl) return signed;
  const u = new URL(signed);
  return `${env.ossBaseUrl}${u.pathname}${u.search}`;
}

/** 删除 OSS 对象（OSS 未配置则 no-op）。best-effort：调用方按需 .catch 吞掉异常。 */
export async function ossDelete(key: string): Promise<void> {
  if (!ossConfigured()) return;
  await oss().delete(key);
}
