import { moderate } from '../moderation.js';
import { recordAudit } from '../audit.js';
import { aliyunGreenConfig, clipMediaKind, isAliyunGreenConfigured, moderateClipMedia } from './aliyunGreenMedia.js';

export class VideoContentBlockedError extends Error {
  statusCode = 422;
  code = 'CLIP_CONTENT_BLOCKED';
  constructor() { super('文案含有当前不能用于公开成片的内容，请修改后再试'); }
}

export class VideoMediaModerationUnavailableError extends Error {
  statusCode = 503;
  code = 'CLIP_MEDIA_MODERATION_NOT_CONFIGURED';
  constructor() { super('视频素材审核能力尚未完成配置'); }
}

export class VideoMediaTypeUnsupportedError extends Error {
  statusCode = 415;
  code = 'CLIP_MEDIA_TYPE_UNSUPPORTED';
  constructor() { super('暂不支持该素材格式'); }
}

/** 测试期显式旁路：只允许 test/development，production 即使误配也永远返回 false。 */
export function clipMediaModerationBypassEnabled(): boolean {
  return process.env.CLIP_MEDIA_MODERATION_BYPASS === 'true' && process.env.NODE_ENV !== 'production';
}

function projectText(project: unknown): string {
  const p = project && typeof project === 'object' ? project as Record<string, unknown> : {};
  const segments = Array.isArray(p.segments)
    ? p.segments
    : (p.payloadJson && typeof p.payloadJson === 'object' && Array.isArray((p.payloadJson as Record<string, unknown>).segments)
      ? (p.payloadJson as Record<string, unknown>).segments as unknown[]
      : []);
  return segments.map((segment) => {
    const row = segment && typeof segment === 'object' ? segment as Record<string, unknown> : {};
    return row.role === 'tail' ? '' : String(row.text ?? '');
  }).filter(Boolean).join('\n');
}

export async function assertVideoProjectContent(project: unknown, identity: { tenantId: string; userId: string }) {
  const text = projectText(project);
  if (!text) return;
  const pass = await moderate('input', text, { ...identity, failClosed: true });
  if (!pass) throw new VideoContentBlockedError();
}

export async function assertVideoRewriteOutput(result: unknown, identity: { tenantId: string; userId: string }) {
  const row = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const text = typeof row.text === 'string' ? row.text : projectText({ segments: row.segments });
  if (!text) return;
  const pass = await moderate('output', text, { ...identity, failClosed: true });
  if (!pass) throw new VideoContentBlockedError();
}

/** 图片/视频/语音统一走阿里云内容安全；medium 无人工复核队列，和 high 一样失败关闭。 */
export async function assertVideoUploadContent(
  input: Buffer,
  mimeType: string,
  identity: { tenantId: string; userId: string },
) {
  if (!clipMediaKind(mimeType)) throw new VideoMediaTypeUnsupportedError();
  if (clipMediaModerationBypassEnabled()) {
    await recordAudit({
      ...identity,
      action: 'user.video.media.moderation.bypassed',
      payload: { provider: 'test-bypass', mimeType, bytes: input.length, pass: true },
    });
    return;
  }
  let verdict;
  try {
    verdict = await moderateClipMedia(input, mimeType);
  } catch (error) {
    await recordAudit({
      ...identity,
      action: 'user.video.media.moderation.failed',
      payload: { provider: 'aliyun-green', mimeType, bytes: input.length, code: (error as { code?: string }).code ?? 'UNKNOWN' },
    });
    throw error;
  }
  await recordAudit({
    ...identity,
    action: 'user.video.media.moderation',
    payload: {
      provider: verdict.provider,
      kind: verdict.kind,
      mimeType,
      bytes: input.length,
      pass: verdict.pass,
      riskLevel: verdict.riskLevel,
      labels: verdict.labels,
      requestId: verdict.requestId,
    },
  });
  if (!verdict.pass) throw new VideoContentBlockedError();
}

/** 在读取大文件前先确认审核 provider 真存在；避免“明知会拒绝”仍把 100MB 读进内存。 */
export async function assertVideoMediaModerationReady(mimeType: string) {
  if (!clipMediaKind(mimeType)) throw new VideoMediaTypeUnsupportedError();
  if (clipMediaModerationBypassEnabled()) return;
  if (!isAliyunGreenConfigured(aliyunGreenConfig())) throw new VideoMediaModerationUnavailableError();
}
