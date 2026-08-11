import { moderate } from '../moderation.js';
import { checkImage, resolveImageModerator } from '../creative/imageModeration.js';

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

/** 图片可复用现有审核接口，但 provider=none/skipped 时也必须阻断；视频审核未接入前同样 fail-closed。 */
export async function assertVideoUploadContent(
  input: Buffer,
  mimeType: string,
  identity: { tenantId: string; userId: string },
) {
  if (!mimeType.startsWith('image/')) throw new VideoMediaModerationUnavailableError();
  const verdict = await checkImage(input, { ...identity, scene: 'source' });
  if (verdict.skipped || verdict.provider === 'none') throw new VideoMediaModerationUnavailableError();
  if (!verdict.pass) throw new VideoContentBlockedError();
}

/** 在读取大文件前先确认审核 provider 真存在；避免“明知会拒绝”仍把 100MB 读进内存。 */
export async function assertVideoMediaModerationReady(mimeType: string) {
  if (!mimeType.startsWith('image/')) throw new VideoMediaModerationUnavailableError();
  const moderator = await resolveImageModerator();
  if (moderator.provider === 'none') throw new VideoMediaModerationUnavailableError();
}
