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

/**
 * 测试期显式旁路。production 必须同时打开二次确认开关，避免单个历史配置误带上线。
 * 旁路仍只跳过外部机审，不跳过 MIME/大小校验，并为每次素材写独立审计。
 */
export function clipMediaModerationBypassEnabled(): boolean {
  if (process.env.CLIP_MEDIA_MODERATION_BYPASS !== 'true') return false;
  return process.env.NODE_ENV !== 'production'
    || process.env.CLIP_MEDIA_MODERATION_ALLOW_PRODUCTION === 'true';
}

/** 导出仅为单测：机审送检文本的组装口径必须能被直接断言，不用起一整条 render 链路。 */
export function projectText(project: unknown): string {
  const p = project && typeof project === 'object' ? project as Record<string, unknown> : {};
  const segments = Array.isArray(p.segments)
    ? p.segments
    : (p.payloadJson && typeof p.payloadJson === 'object' && Array.isArray((p.payloadJson as Record<string, unknown>).segments)
      ? (p.payloadJson as Record<string, unknown>).segments as unknown[]
      : []);
  const lines = segments.map((segment) => {
    const row = segment && typeof segment === 'object' ? segment as Record<string, unknown> : {};
    return row.role === 'tail' ? '' : String(row.text ?? '');
  });
  return [...lines, ...coverText(p)].filter(Boolean).join('\n');
}

/**
 * 封面上的四个文本槽位同样会被烧进成片第一帧、随作品发布出去，
 * 所以它必须和口播文案一起过机审 —— 只审 segments 会留下一条「图上写什么都行」的绕过路径。
 */
function coverText(project: Record<string, unknown>): string[] {
  const payload = project.payloadJson && typeof project.payloadJson === 'object'
    ? project.payloadJson as Record<string, unknown>
    : {};
  const raw = project.cover ?? payload.cover;
  const cover = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (!cover) return [];
  const slogan = Array.isArray(cover.sloganLines) ? cover.sloganLines.map((line) => String(line ?? '')) : [];
  return [String(cover.keyword ?? ''), String(cover.handle ?? ''), ...slogan, String(cover.signature ?? '')];
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
      payload: {
        provider: process.env.NODE_ENV === 'production' ? 'operator-bypass' : 'test-bypass',
        mimeType,
        bytes: input.length,
        pass: true,
      },
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
