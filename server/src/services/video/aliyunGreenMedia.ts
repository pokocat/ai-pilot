import crypto from 'node:crypto';
import OSS from 'ali-oss';
import { env } from '../../env.js';

export type ClipMediaKind = 'image' | 'video' | 'audio';
export type ClipMediaRiskLevel = 'none' | 'low' | 'medium' | 'high';

export interface AliyunGreenConfig {
  provider: 'none' | 'aliyun-green';
  accessKeyId: string;
  accessKeySecret: string;
  endpoint: string;
  imageService: string;
  videoService: string;
  voiceService: string;
  timeoutMs: number;
  pollIntervalMs: number;
}

export interface ClipMediaModerationVerdict {
  provider: 'aliyun-green';
  kind: ClipMediaKind;
  pass: boolean;
  riskLevel: ClipMediaRiskLevel;
  labels: string[];
  requestId: string | null;
}

type GreenResponse = {
  RequestId?: unknown;
  Code?: unknown;
  Message?: unknown;
  Msg?: unknown;
  Data?: unknown;
};

type UploadToken = {
  AccessKeyId?: unknown;
  AccessKeySecret?: unknown;
  SecurityToken?: unknown;
  OssInternetEndPoint?: unknown;
  BucketName?: unknown;
  FileNamePrefix?: unknown;
  Expiration?: unknown;
};

export interface AliyunGreenDependencies {
  rpc?: (action: string, params: Record<string, string>, config: AliyunGreenConfig) => Promise<GreenResponse>;
  upload?: (input: Buffer, mimeType: string, config: AliyunGreenConfig) => Promise<{ bucketName: string; objectName: string }>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class AliyunGreenMediaError extends Error {
  statusCode: number;
  code: string;
  detailCode: number | null;

  constructor(message: string, detailCode: number | null = null, statusCode = 503, code = 'CLIP_MEDIA_MODERATION_UNAVAILABLE') {
    super(message);
    this.detailCode = detailCode;
    this.statusCode = statusCode;
    this.code = code;
  }
}

const asString = (value: unknown) => typeof value === 'string' ? value : '';

function positiveInt(value: number, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
}

export function aliyunGreenConfig(): AliyunGreenConfig {
  return {
    provider: env.clipMediaModerationProvider,
    accessKeyId: env.aliyunGreenAccessKeyId.trim(),
    accessKeySecret: env.aliyunGreenAccessKeySecret.trim(),
    endpoint: env.aliyunGreenEndpoint.trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    imageService: env.aliyunGreenImageService.trim(),
    videoService: env.aliyunGreenVideoService.trim(),
    voiceService: env.aliyunGreenVoiceService.trim(),
    timeoutMs: positiveInt(env.aliyunGreenTimeoutMs, 150_000, 5_000, 175_000),
    pollIntervalMs: positiveInt(env.aliyunGreenPollIntervalMs, 3_000, 500, 30_000),
  };
}

export function clipMediaKind(mimeType: string): ClipMediaKind | null {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return null;
}

export function isAliyunGreenConfigured(config = aliyunGreenConfig()): boolean {
  return config.provider === 'aliyun-green'
    && !!config.accessKeyId
    && !!config.accessKeySecret
    && !!config.endpoint
    && !!config.imageService
    && !!config.videoService
    && !!config.voiceService;
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params).sort().map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`).join('&');
}

async function rpcRequest(action: string, params: Record<string, string>, config: AliyunGreenConfig): Promise<GreenResponse> {
  const common: Record<string, string> = {
    ...params,
    Action: action,
    Version: '2022-03-02',
    Format: 'JSON',
    AccessKeyId: config.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  const query = canonicalQuery(common);
  const stringToSign = `POST&${percentEncode('/')}&${percentEncode(query)}`;
  const signature = crypto.createHmac('sha1', `${config.accessKeySecret}&`).update(stringToSign).digest('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(15_000, config.timeoutMs));
  try {
    const response = await fetch(`https://${config.endpoint}/?${query}&Signature=${percentEncode(signature)}`, {
      method: 'POST',
      signal: controller.signal,
      redirect: 'error',
    });
    const body = await response.json().catch(() => null) as GreenResponse | null;
    if (!response.ok || !body) throw new AliyunGreenMediaError('媒体审核服务请求失败');
    return body;
  } catch (error) {
    if (error instanceof AliyunGreenMediaError) throw error;
    if ((error as { name?: string }).name === 'AbortError') throw new AliyunGreenMediaError('媒体审核服务请求超时');
    throw new AliyunGreenMediaError('媒体审核服务连接失败');
  } finally {
    clearTimeout(timer);
  }
}

let cachedUploadToken: { cacheKey: string; data: UploadToken; expiresAt: number } | null = null;

function expiryMs(value: unknown): number {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
    const number = Number(value);
    return number > 10_000_000_000 ? number : number * 1000;
  }
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function requiredTokenString(token: UploadToken, key: keyof UploadToken): string {
  const value = asString(token[key]);
  if (!value) throw new AliyunGreenMediaError('媒体审核临时上传凭证不完整');
  return value;
}

function extensionForMime(mimeType: string): string {
  const known: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac',
  };
  return known[mimeType.toLowerCase()] ?? 'bin';
}

async function uploadForModeration(input: Buffer, mimeType: string, config: AliyunGreenConfig): Promise<{ bucketName: string; objectName: string }> {
  const cacheKey = `${config.endpoint}:${config.accessKeyId}`;
  const now = Date.now();
  if (!cachedUploadToken || cachedUploadToken.cacheKey !== cacheKey || cachedUploadToken.expiresAt <= now + 60_000) {
    const response = await rpcRequest('DescribeUploadToken', {}, config);
    if (Number(response.Code) !== 200 || !response.Data || typeof response.Data !== 'object') {
      throw new AliyunGreenMediaError('媒体审核临时上传凭证获取失败', Number(response.Code) || null);
    }
    const data = response.Data as UploadToken;
    cachedUploadToken = { cacheKey, data, expiresAt: expiryMs(data.Expiration) };
  }
  const token = cachedUploadToken.data;
  const bucketName = requiredTokenString(token, 'BucketName');
  const objectName = `${requiredTokenString(token, 'FileNamePrefix')}${crypto.randomUUID()}.${extensionForMime(mimeType)}`;
  const client = new OSS({
    accessKeyId: requiredTokenString(token, 'AccessKeyId'),
    accessKeySecret: requiredTokenString(token, 'AccessKeySecret'),
    stsToken: requiredTokenString(token, 'SecurityToken'),
    endpoint: requiredTokenString(token, 'OssInternetEndPoint'),
    bucket: bucketName,
    timeout: Math.min(30_000, config.timeoutMs),
  });
  try {
    await client.put(objectName, input, { headers: { 'Content-Type': mimeType } });
  } catch {
    cachedUploadToken = null;
    throw new AliyunGreenMediaError('媒体审核临时文件上传失败');
  }
  return { bucketName, objectName };
}

function responseCode(response: GreenResponse): number {
  const code = Number(response.Code);
  return Number.isFinite(code) ? code : 0;
}

function assertResponseOk(response: GreenResponse, action: string): void {
  const code = responseCode(response);
  if (code === 200) return;
  throw new AliyunGreenMediaError(`媒体审核${action}失败`, code || null);
}

function riskLevelOf(response: GreenResponse): ClipMediaRiskLevel | null {
  const data = response.Data && typeof response.Data === 'object' ? response.Data as Record<string, unknown> : null;
  const riskLevel = data && typeof data.RiskLevel === 'string' ? data.RiskLevel.toLowerCase() : '';
  return ['none', 'low', 'medium', 'high'].includes(riskLevel) ? riskLevel as ClipMediaRiskLevel : null;
}

function labelsOf(response: GreenResponse): string[] {
  const labels = new Set<string>();
  const walk = (value: unknown, depth = 0) => {
    if (depth > 6 || labels.size >= 20 || value == null) return;
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    if (typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if ((key === 'Label' || key === 'Labels') && typeof item === 'string') {
        for (const label of item.split(',').map((part) => part.trim()).filter(Boolean)) {
          if (label !== 'nonLabel') labels.add(label.slice(0, 80));
        }
      } else if (!['Text', 'RiskWords', 'Url', 'TempUrl'].includes(key)) walk(item, depth + 1);
    }
  };
  walk(response.Data);
  return [...labels];
}

function verdict(response: GreenResponse, kind: ClipMediaKind): ClipMediaModerationVerdict {
  const riskLevel = riskLevelOf(response);
  if (!riskLevel) throw new AliyunGreenMediaError('媒体审核返回结果不完整');
  return {
    provider: 'aliyun-green',
    kind,
    // medium 需要人工复核；当前链路没有人工复核队列，因此同 high 一样失败关闭。low 按官方建议放行。
    pass: riskLevel === 'none' || riskLevel === 'low',
    riskLevel,
    labels: labelsOf(response),
    requestId: asString(response.RequestId) || null,
  };
}

export async function moderateClipMedia(
  input: Buffer,
  mimeType: string,
  config = aliyunGreenConfig(),
  dependencies: AliyunGreenDependencies = {},
): Promise<ClipMediaModerationVerdict> {
  const kind = clipMediaKind(mimeType);
  if (!kind) throw new AliyunGreenMediaError('暂不支持该素材格式', null, 415, 'CLIP_MEDIA_TYPE_UNSUPPORTED');
  if (!isAliyunGreenConfigured(config)) throw new AliyunGreenMediaError('媒体审核能力尚未完成配置');
  if (kind === 'image' && input.length > 20 * 1024 * 1024) {
    throw new AliyunGreenMediaError('图片超过审核服务 20MB 限制', null, 413, 'CLIP_ASSET_TOO_LARGE');
  }

  const rpc = dependencies.rpc ?? rpcRequest;
  const upload = dependencies.upload ?? uploadForModeration;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now ?? Date.now;
  const uploaded = await upload(input, mimeType, config);
  const dataId = crypto.randomUUID();

  if (kind === 'image') {
    const response = await rpc('ImageBatchModeration', {
      Service: config.imageService,
      ServiceParameters: JSON.stringify({ ossBucketName: uploaded.bucketName, ossObjectName: uploaded.objectName, dataId }),
    }, config);
    assertResponseOk(response, '图片检测');
    return verdict(response, kind);
  }

  const service = kind === 'video' ? config.videoService : config.voiceService;
  const submitAction = kind === 'video' ? 'VideoModeration' : 'VoiceModeration';
  const resultAction = kind === 'video' ? 'VideoModerationResult' : 'VoiceModerationResult';
  const submitted = await rpc(submitAction, {
    Service: service,
    ServiceParameters: JSON.stringify({ ossBucketName: uploaded.bucketName, ossObjectName: uploaded.objectName, dataId }),
  }, config);
  assertResponseOk(submitted, '任务提交');
  const submittedData = submitted.Data && typeof submitted.Data === 'object' ? submitted.Data as Record<string, unknown> : {};
  const taskId = asString(submittedData.TaskId);
  if (!taskId) throw new AliyunGreenMediaError('媒体审核任务标识缺失');

  const deadline = now() + config.timeoutMs;
  while (now() < deadline) {
    await sleep(Math.min(config.pollIntervalMs, Math.max(0, deadline - now())));
    const response = await rpc(resultAction, {
      Service: service,
      ServiceParameters: JSON.stringify({ taskId }),
    }, config);
    const code = responseCode(response);
    if (code === 280 || code === 288) continue;
    assertResponseOk(response, '结果查询');
    return verdict(response, kind);
  }
  throw new AliyunGreenMediaError('媒体审核等待结果超时');
}
