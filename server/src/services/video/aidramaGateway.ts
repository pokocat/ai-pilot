import { assertSafeUrl } from '../../llm/tools/httpTool.js';

export interface VideoGatewayIdentity { userId: string; tenantId: string }

export class VideoGatewayError extends Error {
  statusCode: number;
  code: string;
  constructor(message: string, statusCode = 502, code = 'CLIP_UPSTREAM_FAILED') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function config() {
  return {
    baseUrl: (process.env.AIDRAMA_CLIP_BASE_URL ?? '').trim().replace(/\/+$/, ''),
    serviceToken: (process.env.AIDRAMA_CLIP_SERVICE_TOKEN ?? '').trim(),
    timeoutMs: Math.max(1000, Number(process.env.AIDRAMA_CLIP_TIMEOUT_MS ?? 15000)),
    allowPrivate: (process.env.AIDRAMA_CLIP_ALLOW_PRIVATE_NET ?? 'false') === 'true',
  };
}

/** 只允许打固定配置的 aidrama origin；业务参数永远不能变成目标 URL。 */
export async function assertAidramaGatewayUrl(raw: string, allowPrivate = false): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new VideoGatewayError('视频底座地址配置非法', 503, 'CLIP_GATEWAY_NOT_CONFIGURED'); }
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) {
    throw new VideoGatewayError('视频底座地址配置非法', 503, 'CLIP_GATEWAY_NOT_CONFIGURED');
  }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new VideoGatewayError('生产视频底座必须使用 HTTPS', 503, 'CLIP_GATEWAY_NOT_CONFIGURED');
  }
  if (!allowPrivate && process.env.NODE_ENV !== 'test') {
    try { await assertSafeUrl(url.toString()); }
    catch { throw new VideoGatewayError('视频底座地址未通过出站安全校验', 503, 'CLIP_GATEWAY_NOT_CONFIGURED'); }
  }
  return url;
}

function upstreamPath(base: URL, path: string): URL {
  if (!path.startsWith('/') || path.includes('://') || path.startsWith('//')) {
    throw new VideoGatewayError('视频底座请求路径非法', 500, 'CLIP_GATEWAY_PATH_INVALID');
  }
  const url = new URL(path, `${base.origin}/`);
  if (url.origin !== base.origin) throw new VideoGatewayError('视频底座请求越界', 500, 'CLIP_GATEWAY_PATH_INVALID');
  return url;
}

async function responseBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return { ok: true };
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

function safeUpstreamError(status: number, body: unknown): VideoGatewayError {
  const row = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const nested = row.error && typeof row.error === 'object' ? row.error as Record<string, unknown> : {};
  const rawCode = typeof nested.code === 'string' ? nested.code : row.code;
  const rawMessage = typeof nested.message === 'string' ? nested.message : row.error;
  const code = typeof rawCode === 'string' && /^CLIP_[A-Z0-9_]+$/.test(rawCode) ? rawCode : 'CLIP_UPSTREAM_FAILED';
  const message = typeof rawMessage === 'string' && rawMessage.length <= 160 ? rawMessage : '视频服务暂时不可用，请稍后重试';
  const exposedStatus = status >= 400 && status < 500 ? status : 502;
  return new VideoGatewayError(message, exposedStatus, code);
}

function headers(identity: VideoGatewayIdentity, token: string, extra?: ConstructorParameters<typeof Headers>[0]): Headers {
  const result = new Headers(extra);
  result.set('Authorization', `Bearer ${token}`);
  result.set('X-Service-Caller', 'junshi');
  result.set('X-External-Owner-Id', identity.userId);
  result.set('X-External-Tenant-Id', identity.tenantId);
  result.set('Accept', 'application/json');
  return result;
}

/**
 * 单次调用的超时上限（毫秒）。不传就用全局 AIDRAMA_CLIP_TIMEOUT_MS（生产 60s）。
 * 用途：**读类快接口**（作品列表等）不该吃提交类请求的长预算——2026-08-12 起小程序作品页是
 * 一级 tab，每次进入都会打一次列表；上游慢时若按 60s 等，端上早已断开（默认 30s），
 * 服务端却还在等，在途槽位不释放。给这类调用一个短上限，让服务端先于端上放手。
 */
async function gatewayFetch(path: string, identity: VideoGatewayIdentity, init: RequestInit, timeoutCapMs?: number): Promise<unknown> {
  const cfg = config();
  if (!cfg.baseUrl || !cfg.serviceToken) {
    throw new VideoGatewayError('视频服务尚未配置', 503, 'CLIP_GATEWAY_NOT_CONFIGURED');
  }
  const base = await assertAidramaGatewayUrl(cfg.baseUrl, cfg.allowPrivate);
  const url = upstreamPath(base, path);
  const ctrl = new AbortController();
  const budget = timeoutCapMs ? Math.min(cfg.timeoutMs, Math.max(1000, timeoutCapMs)) : cfg.timeoutMs;
  const timer = setTimeout(() => ctrl.abort(), budget);
  try {
    const res = await fetch(url, {
      ...init,
      headers: headers(identity, cfg.serviceToken, init.headers),
      signal: ctrl.signal,
      redirect: 'error',
    });
    const body = await responseBody(res);
    if (!res.ok) throw safeUpstreamError(res.status, body);
    // AIStarEcosystem 的统一成功体为 {success:true,data}; BFF 对小程序保持扁平业务契约。
    if (body && typeof body === 'object' && (body as Record<string, unknown>).success === true && 'data' in (body as Record<string, unknown>)) {
      return (body as Record<string, unknown>).data;
    }
    return body;
  } catch (error) {
    if (error instanceof VideoGatewayError) throw error;
    if (/abort/i.test((error as Error).message)) throw new VideoGatewayError('视频服务响应超时', 504, 'CLIP_UPSTREAM_TIMEOUT');
    throw new VideoGatewayError('视频服务连接失败', 502, 'CLIP_UPSTREAM_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}

export async function aidramaJson<T>(
  path: string,
  identity: VideoGatewayIdentity,
  opts: { method?: string; body?: unknown; timeoutCapMs?: number } = {},
): Promise<T> {
  const hasBody = opts.body !== undefined;
  return gatewayFetch(path, identity, {
    method: opts.method ?? 'GET',
    ...(hasBody ? { body: JSON.stringify(opts.body), headers: { 'Content-Type': 'application/json' } } : {}),
  }, opts.timeoutCapMs) as Promise<T>;
}

/** 账号注销：让下游按外部 owner 清除全部数字人、声音、素材、项目与作品。 */
export async function aidramaDeleteOwnerData(identity: VideoGatewayIdentity): Promise<void> {
  await gatewayFetch('/api/me/clip/account', identity, { method: 'DELETE' });
}

export async function aidramaUpload<T>(
  path: string,
  identity: VideoGatewayIdentity,
  file: { buffer: Buffer; fileName: string; mimeType: string },
  fields: Record<string, string>,
): Promise<T> {
  const form = new FormData();
  form.append('file', new Blob([file.buffer], { type: file.mimeType }), file.fileName);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return gatewayFetch(path, identity, { method: 'POST', body: form }) as Promise<T>;
}
