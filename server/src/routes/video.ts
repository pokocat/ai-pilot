import type { FastifyInstance, FastifyReply } from 'fastify';
import { Readable, Transform } from 'node:stream';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { aidramaJson, aidramaUpload, VideoGatewayError } from '../services/video/aidramaGateway.js';
import {
  attachVideoJob, markVideoSubmissionUnknown, refundVideoHold, reserveVideoCredits, settleVideoJob,
} from '../services/video/credits.js';
import {
  applyCloneSettlements, assertCloneAffordable, attachCloneTargets, cloneChargeItems, cloneChargeTotal,
  cloneHoldsForRequest, pendingCloneHolds, refundCloneHold,
  reserveCloneCredits, resolveCloneSettlements,
} from '../services/video/cloneCredits.js';
import { videoSubmissionProbe } from '../services/video/maintenance.js';
import { assertVideoMediaModerationReady, assertVideoProjectContent, assertVideoRewriteOutput, assertVideoUploadContent, assertVideoUploadedContent } from '../services/video/moderation.js';
import { generateClipScriptTurn } from '../services/video/scriptChat.js';
import { clonePricing, clonePricingView } from '../services/video/pricing.js';
import { buyStoragePack, purchasedPackCount, purchasedStorageBytes, storagePlan } from '../services/video/storagePlan.js';
import type {
  ClipAsset, ClipAssetStorage, ClipAvatarView, ClipCaptureRequirements, ClipCloneUploadRequest, ClipCloneUploadStatus, ClipCloneUploadTicket, ClipConsentResult, ClipEstimate, ClipJobView, ClipProject,
  ClipRenderRequest, ClipRenderResult, ClipTemplate, ClipVoicePreview, ClipVoiceView, ClipWork, ClipWorkDeleteResult,
} from '../../../shared/contracts';
import { assertSafeUrl } from '../llm/tools/httpTool.js';

type Identity = { userId: string; tenantId: string };
type UpstreamCloneUploadStatus = ClipCloneUploadStatus & { reviewUrl?: string | null };

function sendErr(reply: FastifyReply, error: unknown, fallback = 400) {
  const e = error as { statusCode?: number; code?: string; message?: string };
  return reply.code(e.statusCode ?? fallback).send({ error: e.message ?? '操作失败', code: e.code });
}

const enc = (value: string) => encodeURIComponent(value);
const validId = (value: string) => /^[A-Za-z0-9_-]{3,100}$/.test(value);
/** 石榴声音训练模型版本；仅声音相关的 clone 请求携带，照片分身不创建声音。 */
const CLIP_VOICE_MODEL = '2.0';

function identityOf(user: { id: string; tenantId: string }): Identity {
  return { userId: user.id, tenantId: user.tenantId };
}

function assertId(id: string) {
  if (!validId(id)) throw Object.assign(new Error('资源标识非法'), { statusCode: 400, code: 'CLIP_ID_INVALID' });
}

function directCloneInput(body: unknown): ClipCloneUploadRequest {
  const row = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const kind = String(row.kind ?? '') as ClipCloneUploadRequest['kind'];
  const clientRequestId = String(row.clientRequestId ?? '').trim();
  const fileName = String(row.fileName ?? '').trim();
  const contentType = String(row.contentType ?? '').trim().toLowerCase();
  const sizeBytes = Number(row.sizeBytes);
  const expectedCredits = Number(row.expectedCredits);
  if (!['avatar', 'voice', 'avatarImage'].includes(kind)) throw Object.assign(new Error('采集类型非法'), { statusCode: 422, code: 'CLIP_CLONE_KIND_INVALID' });
  if (!/^[A-Za-z0-9:_-]{8,100}$/.test(clientRequestId)) throw Object.assign(new Error('请求信息已失效，请重新提交'), { statusCode: 422, code: 'CLIENT_REQUEST_ID_REQUIRED' });
  if (!fileName || fileName.length > 255 || /[\\/\r\n]/.test(fileName)) throw Object.assign(new Error('文件名无效，请重新选择'), { statusCode: 422, code: 'CLIP_UPLOAD_FILENAME_INVALID' });
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) throw Object.assign(new Error('文件大小无效，请重新选择'), { statusCode: 422, code: 'CLIP_UPLOAD_SIZE_INVALID' });
  if (!Number.isSafeInteger(expectedCredits) || expectedCredits < 0) throw Object.assign(new Error('训练报价无效，请返回重新确认'), { statusCode: 422, code: 'CLIP_CLONE_CLIENT_OUTDATED' });
  const mimeAllowed = kind === 'voice' ? VOICE_CAPTURE_MIMES : kind === 'avatarImage' ? IMAGE_CAPTURE_MIMES : VIDEO_CAPTURE_MIMES;
  if (!mimeAllowed.has(contentType)) throw Object.assign(new Error(kind === 'voice' ? '声音格式暂不支持' : kind === 'avatarImage' ? '照片只支持 JPG 或 PNG' : '视频只支持 MP4 或 MOV'), { statusCode: 415, code: 'CLIP_CAPTURE_FORMAT_INVALID' });
  const max = kind === 'voice' ? 20 * 1024 * 1024 : kind === 'avatarImage' ? 10 * 1024 * 1024 : 100 * 1024 * 1024;
  if (sizeBytes > max) throw Object.assign(new Error(kind === 'voice' ? '声音文件不能超过 20MB' : kind === 'avatarImage' ? '照片不能超过 10MB' : '形象视频超过 100MB，请压缩或缩短后重新上传'), { statusCode: 413, code: 'CLIP_CAPTURE_TOO_LARGE' });
  return {
    kind, clientRequestId, expectedCredits, fileName, contentType, sizeBytes,
    avatarId: String(row.avatarId ?? ''), voiceId: String(row.voiceId ?? ''),
    name: String(row.name ?? ''), voiceSource: String(row.voiceSource ?? ''),
  };
}

function publicUploadStatus(status: UpstreamCloneUploadStatus): ClipCloneUploadStatus {
  const { reviewUrl: _privateReviewUrl, ...safe } = status;
  return safe;
}

function rewriteBody(body: unknown) {
  const row = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const scope = row.scope === 'all' ? 'all' : row.scope === 'segment' ? 'segment' : '';
  if (!scope) throw Object.assign(new Error('改写范围非法'), { statusCode: 422, code: 'CLIP_REWRITE_INVALID' });
  const text = typeof row.text === 'string' ? row.text.trim() : null;
  if (scope === 'segment' && !text) throw Object.assign(new Error('单句文案不能为空'), { statusCode: 422, code: 'CLIP_REWRITE_INVALID' });
  return { scope, no: typeof row.no === 'number' ? row.no : null, text };
}

/** 采集类型。avatarImage = 用照片训数字人（与 AIStar 侧 kind 同名），白名单与视频那两类完全不同。 */
type CaptureKind = 'consent' | 'avatar' | 'voice' | 'avatarImage';

const VIDEO_CAPTURE_MIMES = new Set(['video/mp4', 'video/quicktime']);
const IMAGE_CAPTURE_MIMES = new Set(['image/jpeg', 'image/png']);
const VOICE_CAPTURE_MIMES = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/x-m4a']);

/**
 * 按魔数判采集文件的真实容器格式。
 *
 * 为什么不能信 multipart 声明的 MIME：`wx.uploadFile` **不允许调用方设置 part 的 Content-Type**，
 * 微信按临时文件扩展名自己推断，而录音管理器产出的 `wxfile://tmp_xxx` 常常没有可识别扩展名，
 * 于是整包被标成 `application/octet-stream` —— 白名单直接拒，用户看到「声音只支持 WAV、MP3…」，
 * 但文件本身完全合法。这就是预发上「上传音频提示报错」的成因。
 *
 * 口径与 services/creative/visualProvider.ts 的 sniffImageMime 一致：不信上游 content-type，按魔数判。
 * 真正的深度校验（H.264、采样率、真实时长）在 AIStar 侧 ffprobe 做，这一层只负责别误杀。
 */
export function sniffCaptureMime(buf: Buffer): string | null {
  if (!buf || buf.length < 12) return null;
  const ascii = (start: number, end: number) => buf.toString('latin1', start, end);

  // ID3 标签头 或 MPEG 帧同步（11 个 1）→ MP3
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    // ADTS AAC 的同步字是 0xFFF1 / 0xFFF9，其余 0xFFEx/0xFFFx 归 MP3
    if (buf[1] === 0xf1 || buf[1] === 0xf9) return 'audio/aac';
    return 'audio/mpeg';
  }
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';

  // 图片（b-roll 素材可以是图）
  if (buf[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';

  // ISO BMFF（MP4 家族）：第 4 字节起是 'ftyp'，紧跟 4 字节 major brand
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12).trim().toLowerCase();
    if (brand.startsWith('qt')) return 'video/quicktime';
    if (brand.startsWith('m4a') || brand.startsWith('m4b')) return 'audio/mp4';
    // isom / mp42 / avc1 / iso5 等既可能是视频也可能是纯音频 MP4，
    // 交给调用方按 kind 决定，这里返回中性标记
    return 'application/mp4';
  }
  return null;
}

/**
 * b-roll 素材的 MIME 纠正。素材可以是图或视频，没有固定白名单（真正的门在 AIStar 侧），
 * 这里只解决「声明成 octet-stream 导致 clipMediaKind() 返回 null、审核层直接判媒体类型不支持」。
 */
function resolveAssetMime(declared: string, buf: Buffer): string {
  const lower = String(declared || '').toLowerCase();
  if (/^(image|video|audio)\//.test(lower)) return lower;
  const sniffed = sniffCaptureMime(buf);
  if (!sniffed) return lower;
  return sniffed === 'application/mp4' ? 'video/mp4' : sniffed;
}

function captureMimeWhitelist(kind: CaptureKind): Set<string> {
  if (kind === 'voice') return VOICE_CAPTURE_MIMES;
  if (kind === 'avatarImage') return IMAGE_CAPTURE_MIMES;
  return VIDEO_CAPTURE_MIMES;
}

/** 声明 MIME 不可信时（缺失 / octet-stream / 与魔数矛盾），以魔数为准。 */
function resolveCaptureMime(kind: CaptureKind, declared: string, buf: Buffer): string {
  const voice = kind === 'voice';
  const allowed = captureMimeWhitelist(kind);
  const lower = String(declared || '').toLowerCase();
  if (allowed.has(lower)) return lower;

  const sniffed = sniffCaptureMime(buf);
  if (!sniffed) return lower;
  // ftyp 的中性结果按 kind 落位：语音归 audio/mp4（m4a），视频归 video/mp4
  if (sniffed === 'application/mp4') return voice ? 'audio/mp4' : 'video/mp4';
  return sniffed;
}

function assertCaptureUpload(kind: CaptureKind, mimeType: string, bytes: number, truncated: boolean) {
  const voice = kind === 'voice';
  const image = kind === 'avatarImage';
  const maxBytes = voice ? 20 * 1024 * 1024 : image ? 10 * 1024 * 1024 : 100 * 1024 * 1024;
  const formatError = voice ? '声音只支持 WAV、MP3、OGG、M4A 或 AAC' : image ? '照片只支持 JPG 或 PNG' : '视频只支持 MP4 或 MOV';
  const sizeError = voice ? '声音文件不能超过 20MB' : image ? '照片不能超过 10MB' : '视频文件不能超过 100MB';
  if (!captureMimeWhitelist(kind).has(String(mimeType || '').toLowerCase())) {
    throw Object.assign(new Error(formatError), { statusCode: 422, code: 'CLIP_CAPTURE_FORMAT_INVALID' });
  }
  if (truncated || bytes <= 0 || bytes > maxBytes) {
    throw Object.assign(new Error(sizeError), { statusCode: 413, code: 'CLIP_CAPTURE_TOO_LARGE' });
  }
}

function captureFileName(kind: CaptureKind, fileName: string | undefined, mimeType: string) {
  const supplied = String(fileName || '').trim();
  if (/\.[a-z0-9]{2,5}$/i.test(supplied)) return supplied;
  if (kind === 'avatarImage') return String(mimeType || '').includes('png') ? 'avatar.png' : 'avatar.jpg';
  if (kind !== 'voice') return kind === 'consent' ? 'consent.mp4' : 'avatar.mp4';
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('wav')) return 'voice.wav';
  if (mime.includes('ogg')) return 'voice.ogg';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'voice.m4a';
  if (mime.includes('aac')) return 'voice.aac';
  return 'voice.mp3';
}

/**
 * 顺手结算在途的克隆预扣。挂在「端上本来就会轮询的状态接口」上，理由同 GET /video/jobs/:id：
 * 训练结果只有上游知道，而上游没有回调，所以谁先看到终态谁就负责把账结掉。
 *
 * 形象视图里带着它关联声音的状态 —— 训练页只轮询形象一个接口，声音那一档也必须能在这里结清，
 * 否则用户训完就离开、声音的预扣会一直挂到超时清扫器才退。
 */
async function settleCloneHolds(
  userId: string,
  sources: { avatars?: (ClipAvatarView | null)[]; voices?: (ClipVoiceView | null)[] },
): Promise<void> {
  const holds = await pendingCloneHolds(userId);
  if (!holds.length) return;
  const avatarStatus = new Map<string, string>();
  const voiceStatus = new Map<string, string>();
  for (const view of sources.avatars ?? []) {
    if (!view) continue;
    avatarStatus.set(view.id, view.imageStatus);
    if (view.linkedVoiceId) voiceStatus.set(view.linkedVoiceId, view.voiceStatus);
  }
  for (const view of sources.voices ?? []) if (view) voiceStatus.set(view.id, view.status);
  await applyCloneSettlements(resolveCloneSettlements(
    holds,
    (kind, id) => (kind === 'avatar' ? avatarStatus : voiceStatus).get(id) ?? null,
  ));
}

export async function videoRoutes(app: FastifyInstance) {
  app.get('/video/templates', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try { return await aidramaJson<ClipTemplate[]>('/api/me/clip/templates', identityOf(user)); }
    catch (e) { return sendErr(reply, e, 502); }
  });

  app.get<{ Params: { id: string } }>('/video/templates/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try { assertId(req.params.id); return await aidramaJson<ClipTemplate>(`/api/me/clip/templates/${enc(req.params.id)}`, identityOf(user)); }
    catch (e) { return sendErr(reply, e, 404); }
  });

  app.post<{ Body: { templateId?: string } }>('/video/projects', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const templateId = String(req.body?.templateId ?? ''); assertId(templateId);
      const result = await aidramaJson<ClipProject>('/api/me/clip/projects', identityOf(user), { method: 'POST', body: { templateId } });
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.video.project.create', payload: { projectId: result.id, templateId } });
      return reply.code(201).send(result);
    } catch (e) { return sendErr(reply, e, 422); }
  });

  app.get('/video/projects/ongoing', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try { return await aidramaJson<ClipProject | null>('/api/me/clip/projects/ongoing', identityOf(user)); }
    catch (e) { return sendErr(reply, e, 502); }
  });

  app.get<{ Params: { id: string } }>('/video/projects/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try { assertId(req.params.id); return await aidramaJson<ClipProject>(`/api/me/clip/projects/${enc(req.params.id)}`, identityOf(user)); }
    catch (e) { return sendErr(reply, e, 404); }
  });

  app.put<{ Params: { id: string }; Body: Partial<ClipProject> }>('/video/projects/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      assertId(req.params.id);
      const body = req.body ?? {};
      if (body.segments && !Array.isArray(body.segments)) throw Object.assign(new Error('segments 必须是数组'), { statusCode: 422, code: 'CLIP_PROJECT_INVALID' });
      if (body.shots && !Array.isArray(body.shots)) throw Object.assign(new Error('shots 必须是数组'), { statusCode: 422, code: 'CLIP_PROJECT_INVALID' });
      if (body.scriptChat && !Array.isArray(body.scriptChat)) throw Object.assign(new Error('scriptChat 必须是数组'), { statusCode: 422, code: 'CLIP_PROJECT_INVALID' });
      return await aidramaJson<ClipProject>(`/api/me/clip/projects/${enc(req.params.id)}`, identityOf(user), { method: 'PUT', body });
    } catch (e) { return sendErr(reply, e, 422); }
  });

  app.post<{ Params: { id: string } }>('/video/projects/:id/script/reset', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try { assertId(req.params.id); return await aidramaJson(`/api/me/clip/projects/${enc(req.params.id)}/script/reset`, identityOf(user), { method: 'POST', body: {} }); }
    catch (e) { return sendErr(reply, e, 422); }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/video/projects/:id/script/ai-rewrite', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      assertId(req.params.id);
      const body = rewriteBody(req.body);
      if (body.text) await assertVideoProjectContent({ segments: [{ role: 'broll', text: body.text }] }, identityOf(user));
      const result = await aidramaJson(`/api/me/clip/projects/${enc(req.params.id)}/script/ai-rewrite`, identityOf(user), { method: 'POST', body });
      await assertVideoRewriteOutput(result, identityOf(user));
      return result;
    } catch (e) { return sendErr(reply, e, 422); }
  });

  app.post<{ Params: { id: string }; Body: { message?: string } }>('/video/projects/:id/script/chat', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      assertId(req.params.id);
      const message = String(req.body?.message ?? '').trim();
      if (!message || message.length > 600) throw Object.assign(new Error('请用 600 字以内说说你想怎么写'), { statusCode: 422, code: 'CLIP_SCRIPT_CHAT_INVALID' });
      const identity = identityOf(user);
      await assertVideoProjectContent({ segments: [{ role: 'broll', text: message }] }, identity);
      const project = await aidramaJson<ClipProject>(`/api/me/clip/projects/${enc(req.params.id)}`, identity);
      const turn = await generateClipScriptTurn(project, message);
      await assertVideoRewriteOutput({ segments: turn.segments }, identity);
      await assertVideoRewriteOutput({ text: turn.reply }, identity);
      const saved = await aidramaJson<ClipProject>(`/api/me/clip/projects/${enc(req.params.id)}`, identity, {
        method: 'PUT', body: { segments: turn.segments, shots: turn.shots, scriptChat: turn.scriptChat, step: 1 },
      });
      await recordAudit({
        tenantId: user.tenantId, userId: user.id, action: 'user.video.script.chat',
        payload: { projectId: req.params.id, applied: turn.applied, segmentCount: turn.segments.length, shotCount: turn.shots.length },
      });
      return { reply: turn.reply, applied: turn.applied, project: saved };
    } catch (e) { return sendErr(reply, e, 422); }
  });

  for (const action of ['preview-voice', 'estimate'] as const) {
    app.post<{ Params: { id: string }; Body: unknown }>(`/video/projects/:id/${action}`, async (req, reply) => {
      const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
      try {
        assertId(req.params.id);
        return await aidramaJson(`/api/me/clip/projects/${enc(req.params.id)}/${action}`, identityOf(user), { method: 'POST', body: req.body ?? {} });
      } catch (e) { return sendErr(reply, e, 422); }
    });
  }

  app.post<{ Params: { id: string }; Body: ClipRenderRequest }>('/video/projects/:id/render', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    let holdId: string | null = null;
    let ownsSubmission = false;
    try {
      assertId(req.params.id);
      const clientRequestId = String(req.body?.clientRequestId ?? '').trim();
      if (!/^[A-Za-z0-9:_-]{8,100}$/.test(clientRequestId)) {
        return reply.code(422).send({ error: '缺少合法的 clientRequestId', code: 'CLIENT_REQUEST_ID_REQUIRED' });
      }
      const expectedCredits = Number(req.body?.expectedCredits);
      if (!Number.isSafeInteger(expectedCredits) || expectedCredits < 0 || expectedCredits > 1_000_000) {
        return reply.code(422).send({ error: '缺少合法的确认报价', code: 'CLIP_EXPECTED_CREDITS_REQUIRED' });
      }
      const identity = identityOf(user);
      const project = await aidramaJson<ClipProject>(`/api/me/clip/projects/${enc(req.params.id)}`, identity);
      await assertVideoProjectContent(project, identity);
      const estimate = await aidramaJson<ClipEstimate>(`/api/me/clip/projects/${enc(req.params.id)}/estimate`, identity, { method: 'POST', body: { segments: project.segments, shots: project.shots } });
      if (!Number.isSafeInteger(estimate.total) || estimate.total < 0 || estimate.total > 1_000_000) {
        throw Object.assign(new Error('视频服务返回的报价无效'), { statusCode: 502, code: 'CLIP_ESTIMATE_INVALID' });
      }
      if (expectedCredits !== estimate.total) {
        throw Object.assign(new Error('出片报价已变化，请重新确认'), { statusCode: 409, code: 'CLIP_QUOTE_CHANGED' });
      }
      const reservation = await reserveVideoCredits({ tenantId: user.tenantId, userId: user.id, projectId: req.params.id, clientRequestId, credits: estimate.total });
      holdId = reservation.hold.id;
      if (reservation.hold.upstreamJobId) {
        return { jobId: reservation.hold.upstreamJobId, projectId: req.params.id, status: reservation.hold.lastJobStatus ?? 'queued', creditsHeld: reservation.hold.credits, reused: true } satisfies ClipRenderResult;
      }
      if (reservation.hold.status === 'refunded') {
        throw Object.assign(new Error('该出片请求已经结束，请重新提交'), { statusCode: 409, code: 'CLIP_RENDER_REQUEST_CLOSED' });
      }
      if (reservation.reused && reservation.hold.status === 'unknown') {
        const recovered = await videoSubmissionProbe(reservation.hold);
        if (recovered.outcome === 'accepted') {
          await attachVideoJob(reservation.hold.id, recovered.jobId);
          if (recovered.status && recovered.status !== 'queued') await settleVideoJob(recovered.jobId, recovered.status);
          return {
            jobId: recovered.jobId, projectId: req.params.id, status: recovered.status ?? 'queued',
            creditsHeld: reservation.hold.credits, reused: true,
          } satisfies ClipRenderResult;
        }
        if (recovered.outcome === 'rejected') {
          await refundVideoHold(reservation.hold.id, recovered.reason ?? 'submit_rejected');
          throw Object.assign(new Error('该出片请求未被视频服务受理，请重新提交'), { statusCode: 409, code: 'CLIP_RENDER_REQUEST_CLOSED' });
        }
      }
      if (reservation.reused) {
        throw Object.assign(new Error('该出片请求正在创建，请稍后查询或重试'), { statusCode: 409, code: 'CLIP_RENDER_CREATING' });
      }
      ownsSubmission = true;
      const upstream = await aidramaJson<{ jobId: string; projectId?: string; status?: string }>(`/api/me/clip/projects/${enc(req.params.id)}/render`, identity, {
        method: 'POST', body: { clientRequestId, externalCreditsHeld: estimate.total },
      });
      assertId(upstream.jobId);
      await attachVideoJob(holdId, upstream.jobId);
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.video.render', payload: { projectId: req.params.id, jobId: upstream.jobId, credits: estimate.total } });
      return { jobId: upstream.jobId, projectId: req.params.id, status: upstream.status ?? 'queued', creditsHeld: estimate.total, reused: reservation.reused } satisfies ClipRenderResult;
    } catch (e) {
      // 只有成功创建预扣的请求拥有退款权；并发复用者不得把首个请求的预扣退掉。
      if (holdId && ownsSubmission) {
        // 409 可能是同一 request 已受理但本次只撞到项目/幂等冲突，仍需查单，不能当明确拒绝退款。
        const definitive = e instanceof VideoGatewayError && [400, 401, 403, 404, 422].includes(e.statusCode);
        if (definitive) await refundVideoHold(holdId, 'submit_rejected').catch(() => {});
        else {
          await markVideoSubmissionUnknown(holdId, (e as Error).message).catch(() => {});
          return reply.code(409).send({ error: '出片请求正在确认，请稍后查询或用原请求重试', code: 'CLIP_RENDER_CREATING' });
        }
      }
      return sendErr(reply, e, 422);
    }
  });

  app.get<{ Params: { id: string } }>('/video/jobs/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      assertId(req.params.id);
      const job = await aidramaJson<ClipJobView>(`/api/me/clip/jobs/${enc(req.params.id)}`, identityOf(user));
      await settleVideoJob(job.id, job.status);
      return job;
    } catch (e) { return sendErr(reply, e, 404); }
  });

  app.post<{ Params: { id: string } }>('/video/jobs/:id/cancel', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      assertId(req.params.id);
      const result = await aidramaJson<{ status?: string }>(`/api/me/clip/jobs/${enc(req.params.id)}/cancel`, identityOf(user), { method: 'POST', body: {} });
      await settleVideoJob(req.params.id, result.status ?? 'cancelled');
      return result;
    } catch (e) { return sendErr(reply, e, 422); }
  });

  app.get('/video/assets', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try { return await aidramaJson<ClipAsset[]>('/api/me/clip/assets', identityOf(user)); }
    catch (e) { return sendErr(reply, e, 502); }
  });

  // 素材库容量：端上据此显示容量条，并在满之前就提示，而不是等上传被拒。
  /**
   * 存储视图 = AIStar 的真实占用 + 军师这边的扩容权益。
   *
   * 有效额度必须由军师算好后**传给 AIStar**：默认额度在那边，扩容权益（钻石）在这边。
   * 两边各算各的就会出现「军师说还能传、AIStar 说满了」——用户无从解释的状态。
   */
  app.get('/video/assets/storage', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const [plan, purchased, packs] = await Promise.all([
        storagePlan(), purchasedStorageBytes(user.id), purchasedPackCount(user.id),
      ]);
      // 传增量，AIStar 自己加上默认额度后回一个已经算好的 limitBytes。
      const view = await aidramaJson<ClipAssetStorage>(
        `/api/me/clip/assets/storage?extraQuotaBytes=${purchased}`, identityOf(user));
      return {
        ...view,
        baseBytes: view.limitBytes - purchased,
        purchasedBytes: purchased,
        packs,
        maxPacks: plan.maxPacks,
        packBytes: plan.packBytes,
        packCredits: plan.packCredits,
        configured: plan.configured,
      };
    } catch (e) { return sendErr(reply, e, 502); }
  });

  app.post<{ Body: { clientRequestId?: string } }>('/video/assets/storage/expand',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
      const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
      try {
        const clientRequestId = String(req.body?.clientRequestId ?? '').trim();
        if (!/^[A-Za-z0-9:_-]{8,100}$/.test(clientRequestId)) {
          return reply.code(422).send({ error: '缺少合法的 clientRequestId', code: 'CLIENT_REQUEST_ID_REQUIRED' });
        }
        const result = await buyStoragePack({ tenantId: user.tenantId, userId: user.id, clientRequestId });
        await recordAudit({
          tenantId: user.tenantId, userId: user.id, action: 'user.video.storage.expand',
          payload: { ...result.pack, clientRequestId, reused: result.reused },
        });
        return { ok: true, ...result.pack, reused: result.reused };
      } catch (e) { return sendErr(reply, e, 422); }
    });

  app.post('/video/assets', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const data = await req.file();
      if (!data) return reply.code(400).send({ error: '未收到素材', code: 'CLIP_ASSET_REQUIRED' });
      const buffer = await data.toBuffer();
      // 必须先读完 buffer 才能按魔数判型，所以审核就绪检查挪到取 buffer 之后。
      const mimeType = resolveAssetMime(data.mimetype, buffer);
      await assertVideoMediaModerationReady(mimeType);
      if (data.file.truncated || buffer.length > 100 * 1024 * 1024) return reply.code(413).send({ error: '素材超过 100MB', code: 'CLIP_ASSET_TOO_LARGE' });
      await assertVideoUploadContent(buffer, mimeType, identityOf(user));
      const fields = Object.fromEntries(Object.entries(data.fields as Record<string, { value?: unknown }>).map(([key, value]) => [key, String(value?.value ?? '')]));
      // 扩容权益在军师这边，上传闸在 AIStar 那边：把增量带上，两边才用同一个额度判断。
      // 少了这一行，买过扩容的用户仍然会在默认额度上被拦住 —— 花了钱没拿到东西。
      fields.extraQuotaBytes = String(await purchasedStorageBytes(user.id));
      return await aidramaUpload<ClipAsset>('/api/me/clip/assets', identityOf(user), { buffer, fileName: data.filename || 'asset', mimeType }, fields);
    } catch (e) { return sendErr(reply, e, 422); }
  });

  app.patch<{ Params: { id: string }; Body: { label?: string; tag?: string } }>('/video/assets/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try { assertId(req.params.id); return await aidramaJson<ClipAsset>(`/api/me/clip/assets/${enc(req.params.id)}`, identityOf(user), { method: 'PATCH', body: req.body ?? {} }); }
    catch (e) { return sendErr(reply, e, 422); }
  });

  app.delete<{ Params: { id: string } }>('/video/assets/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try { assertId(req.params.id); return await aidramaJson(`/api/me/clip/assets/${enc(req.params.id)}`, identityOf(user), { method: 'DELETE' }); }
    catch (e) { return sendErr(reply, e, 404); }
  });

  // 作品列表是读类快接口，且小程序作品页（锦囊）是一级 tab、每次进入都会打一次。
  // 上限 10s：端上默认 30s 断开，服务端必须先于端上放手，否则槽位一直被占（见 aidramaGateway 注释）。
  const WORKS_TIMEOUT_CAP_MS = 10000;
  app.get('/video/works', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try { return await aidramaJson<ClipWork[]>('/api/me/clip/works', identityOf(user), { timeoutCapMs: WORKS_TIMEOUT_CAP_MS }); }
    catch (e) { return sendErr(reply, e, 502); }
  });
  app.get<{ Params: { id: string } }>('/video/works/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try { assertId(req.params.id); return await aidramaJson<ClipWork>(`/api/me/clip/works/${enc(req.params.id)}`, identityOf(user)); }
    catch (e) { return sendErr(reply, e, 404); }
  });
  /** 同源保存入口：刷新上游短签名并流式转发，避免 OSS downloadFile 合法域名/签名过期导致相册保存失败。 */
  app.get<{ Params: { id: string } }>('/video/works/:id/file', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const controller = new AbortController();
    const timeoutMs = Math.min(10 * 60_000, Math.max(10_000, Number(process.env.VIDEO_DOWNLOAD_PROXY_TIMEOUT_MS ?? 120_000)));
    const maxBytes = Math.min(2 * 1024 ** 3, Math.max(10 * 1024 ** 2, Number(process.env.VIDEO_DOWNLOAD_PROXY_MAX_BYTES ?? 500 * 1024 ** 2)));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const abortOnDisconnect = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.once('close', abortOnDisconnect);
    let streamStarted = false;
    const cleanup = () => {
      clearTimeout(timer);
      reply.raw.off('close', abortOnDisconnect);
    };
    try {
      assertId(req.params.id);
      const work = await aidramaJson<ClipWork>(`/api/me/clip/works/${enc(req.params.id)}`, identityOf(user), { timeoutCapMs: 15_000 });
      if (!work?.videoUrl) throw Object.assign(new Error('成片还没有准备好'), { statusCode: 409, code: 'CLIP_WORK_NOT_READY' });
      await assertSafeUrl(work.videoUrl);
      const response = await fetch(work.videoUrl, { redirect: 'error', signal: controller.signal });
      if (!response.ok || !response.body) throw Object.assign(new Error('成片下载暂时不可用'), { statusCode: 502, code: 'CLIP_WORK_DOWNLOAD_FAILED' });
      const contentLength = response.headers.get('content-length');
      const declaredBytes = contentLength ? Number(contentLength) : null;
      if (declaredBytes != null && (!Number.isFinite(declaredBytes) || declaredBytes < 0 || declaredBytes > maxBytes)) {
        controller.abort();
        throw Object.assign(new Error('成片文件超过下载代理上限'), { statusCode: 413, code: 'CLIP_WORK_FILE_TOO_LARGE' });
      }
      reply.header('Content-Type', response.headers.get('content-type') || 'video/mp4');
      if (declaredBytes != null) reply.header('Content-Length', String(declaredBytes));
      reply.header('Content-Disposition', `attachment; filename="junshi-${req.params.id}.mp4"`);
      reply.header('Cache-Control', 'private, no-store');
      let streamedBytes = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          streamedBytes += chunk.length;
          if (streamedBytes > maxBytes) {
            controller.abort();
            callback(Object.assign(new Error('成片文件超过下载代理上限'), { code: 'CLIP_WORK_FILE_TOO_LARGE' }));
            return;
          }
          callback(null, chunk);
        },
      });
      const stream = Readable.fromWeb(response.body as never).pipe(limiter);
      streamStarted = true;
      stream.once('end', cleanup).once('close', cleanup).once('error', cleanup);
      return reply.send(stream);
    } catch (e) {
      if (controller.signal.aborted && !(e as { code?: string }).code) {
        return sendErr(reply, Object.assign(new Error('成片下载超时或已取消'), { statusCode: 504, code: 'CLIP_WORK_DOWNLOAD_TIMEOUT' }), 504);
      }
      return sendErr(reply, e, 502);
    } finally {
      if (!streamStarted) cleanup();
    }
  });
  app.delete<{ Params: { id: string } }>('/video/works/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      assertId(req.params.id);
      const result = await aidramaJson<ClipWorkDeleteResult>(`/api/me/clip/works/${enc(req.params.id)}`, identityOf(user), { method: 'DELETE' });
      const cancelledJobIds = Array.isArray(result.cancelledJobIds) ? result.cancelledJobIds.filter(validId) : [];
      for (const jobId of cancelledJobIds) await settleVideoJob(jobId, 'cancelled');
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.video.work.delete', payload: { projectId: req.params.id, cancelledJobIds } });
      return result;
    }
    catch (e) { return sendErr(reply, e, 500); }
  });
  app.post<{ Params: { id: string }; Body: { platform?: string } }>('/video/works/:id/publish', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      assertId(req.params.id);
      const platform = String(req.body?.platform ?? '');
      if (!['douyin', 'kuaishou', 'xiaohongshu', 'shipinhao'].includes(platform)) throw Object.assign(new Error('暂不支持该发布平台'), { statusCode: 422, code: 'CLIP_PUBLISH_PLATFORM_UNSUPPORTED' });
      return await aidramaJson(`/api/me/clip/works/${enc(req.params.id)}/publish`, identityOf(user), { method: 'POST', body: { platform } });
    } catch (e) { return sendErr(reply, e, 422); }
  });

  app.get('/video/avatar', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const view = await aidramaJson<ClipAvatarView | null>('/api/me/clip/avatar', identityOf(user));
      await settleCloneHolds(user.id, { avatars: view ? [view] : [] });
      return view;
    } catch (e) { return sendErr(reply, e, 502); }
  });
  app.get('/video/avatars', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const views = await aidramaJson<ClipAvatarView[]>('/api/me/clip/avatars', identityOf(user));
      await settleCloneHolds(user.id, { avatars: views });
      return views;
    } catch (e) { return sendErr(reply, e, 502); }
  });
  // 训练页轮询的就是这个（api.avatarById）。此前 BFF 少了这条透传，新建形象后每次轮询都 404，
  // 训练进度只能靠用户自己退出重进列表页才看得到。
  app.get<{ Params: { id: string } }>('/video/avatars/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      assertId(req.params.id);
      const view = await aidramaJson<ClipAvatarView>(`/api/me/clip/avatars/${enc(req.params.id)}`, identityOf(user));
      await settleCloneHolds(user.id, { avatars: view ? [view] : [] });
      return view;
    } catch (e) { return sendErr(reply, e, 404); }
  });
  app.get('/video/voices', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const views = await aidramaJson<ClipVoiceView[]>('/api/me/clip/voices', identityOf(user));
      await settleCloneHolds(user.id, { voices: views });
      return views;
    } catch (e) { return sendErr(reply, e, 502); }
  });
  // 单条声音。声音训练页轮询这条 —— 只训声音不建形象时，形象接口根本没有这条记录可轮。
  app.get<{ Params: { id: string } }>('/video/voices/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      assertId(req.params.id);
      const view = await aidramaJson<ClipVoiceView>(`/api/me/clip/voices/${enc(req.params.id)}`, identityOf(user));
      await settleCloneHolds(user.id, { voices: view ? [view] : [] });
      return view;
    } catch (e) { return sendErr(reply, e, 404); }
  });
  // 克隆定价：端上在克隆入口明示要扣多少钻石。价格由运营在后台配（FeatureFlag
  // `video-clone-pricing`），代码只给保守兜底 —— 对外定价数据不进代码常量。
  app.get('/video/clone-pricing', async (req, reply) => {
    await resolveUser(req.headers['x-user-id'] as string | undefined);
    try { return clonePricingView(await clonePricing()); }
    catch (e) { return sendErr(reply, e, 502); }
  });

  app.get('/video/avatar/requirements', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try { return await aidramaJson<ClipCaptureRequirements>('/api/me/clip/avatar/requirements', identityOf(user)); }
    catch (e) { return sendErr(reply, e, 502); }
  });
  app.post('/video/avatar/consent', { config: { rateLimit: { max: 6, timeWindow: '1 hour' } } }, async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const data = await req.file();
      if (!data) return reply.code(400).send({ error: '未收到本人授权视频', code: 'CLIP_CONSENT_VIDEO_REQUIRED' });
      const buffer = await data.toBuffer();
      // 先按魔数定真实类型，再拿它去做审核与白名单校验：wx.uploadFile 声明的 MIME 不可信。
      const mimeType = resolveCaptureMime('consent', data.mimetype, buffer);
      await assertVideoMediaModerationReady(mimeType);
      assertCaptureUpload('consent', mimeType, buffer.length, data.file.truncated);
      await assertVideoUploadContent(buffer, mimeType, identityOf(user));
      const rawText = (data.fields as Record<string, { value?: unknown }> | undefined)?.text?.value;
      const text = String(rawText ?? '').trim();
      if (!text || text.length > 300) throw Object.assign(new Error('授权口令无效'), { statusCode: 422, code: 'CLIP_CONSENT_TEXT_REQUIRED' });
      return await aidramaUpload<ClipConsentResult>('/api/me/clip/avatar/consent', identityOf(user),
        { buffer, fileName: captureFileName('consent', data.filename, mimeType), mimeType }, { text });
    }
    catch (e) { return sendErr(reply, e, 422); }
  });

  /**
   * 本人素材新链路：军师只签发/核价，客户端凭短时 policy 一次直传 AIStar OSS。
   * 长期密钥与 service token 都不下发；真正扣费在 complete 后、机审通过且异步受理前。
   */
  app.post<{ Body: ClipCloneUploadRequest }>('/video/avatar/uploads', { config: { rateLimit: { max: 12, timeWindow: '1 hour' } } }, async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const input = directCloneInput(req.body);
      const pricing = await clonePricing();
      const items = cloneChargeItems(input, pricing);
      const total = cloneChargeTotal(items);
      if (input.expectedCredits !== total) throw Object.assign(new Error('训练报价已变化，请返回重新确认'), { statusCode: 409, code: 'CLIP_CLONE_QUOTE_CHANGED' });
      await assertCloneAffordable(user.id, total);
      await assertVideoMediaModerationReady(input.contentType);
      const ticket = await aidramaJson<ClipCloneUploadTicket>('/api/me/clip/avatar/uploads', identityOf(user), {
        method: 'POST',
        body: {
          kind: input.kind, clientRequestId: input.clientRequestId, fileName: input.fileName,
          contentType: input.contentType, sizeBytes: input.sizeBytes,
        },
      });
      return ticket;
    } catch (e) { return sendErr(reply, e, 422); }
  });

  app.post<{ Params: { id: string }; Body: ClipCloneUploadRequest }>('/video/avatar/uploads/:id/complete', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    let holds: Awaited<ReturnType<typeof reserveCloneCredits>>['holds'] = [];
    try {
      assertId(req.params.id);
      const input = directCloneInput(req.body);
      const completed = await aidramaJson<UpstreamCloneUploadStatus>(`/api/me/clip/avatar/uploads/${enc(req.params.id)}/complete`, identityOf(user), { method: 'POST', body: {} });
      if (completed.clientRequestId !== input.clientRequestId || completed.kind !== input.kind) {
        throw Object.assign(new Error('上传受理号与本次请求不一致'), { statusCode: 409, code: 'CLIP_UPLOAD_REQUEST_CONFLICT' });
      }
      if (completed.status === 'failed') return reply.code(422).send({ error: completed.errorMessage ?? '上传校验失败', code: completed.errorCode ?? 'CLIP_UPLOAD_VERIFY_FAILED' });
      if (completed.status === 'accepted' || completed.status === 'processing') return publicUploadStatus(completed);
      if (completed.status !== 'uploaded' || !completed.reviewUrl) throw Object.assign(new Error('文件还没有上传完成'), { statusCode: 409, code: 'CLIP_UPLOAD_NOT_COMPLETED' });

      const pricing = await clonePricing();
      const items = cloneChargeItems(input, pricing);
      const total = cloneChargeTotal(items);
      if (input.expectedCredits !== total) throw Object.assign(new Error('训练报价已变化，请返回重新确认'), { statusCode: 409, code: 'CLIP_CLONE_QUOTE_CHANGED' });
      await assertCloneAffordable(user.id, total);
      await assertVideoUploadedContent(completed.reviewUrl, input.contentType, input.sizeBytes, identityOf(user));

      const reservation = await reserveCloneCredits({ tenantId: user.tenantId, userId: user.id, clientRequestId: input.clientRequestId, items });
      holds = reservation.holds;
      if (holds.some((hold) => hold.status === 'refunded')) throw Object.assign(new Error('这次训练已经结束，请重新提交'), { statusCode: 409, code: 'CLIP_CLONE_REQUEST_CLOSED' });
      const alreadyAttached = holds.filter((hold) => hold.targetId);
      if (alreadyAttached.length) {
        return {
          uploadId: completed.uploadId, clientRequestId: input.clientRequestId, kind: input.kind, status: 'accepted',
          avatarId: alreadyAttached.find((hold) => hold.targetKind === 'avatar')?.targetId ?? undefined,
          voiceId: alreadyAttached.find((hold) => hold.targetKind === 'voice')?.targetId ?? undefined,
        } satisfies ClipCloneUploadStatus;
      }
      const submitted = await aidramaJson<UpstreamCloneUploadStatus>(`/api/me/clip/avatar/uploads/${enc(req.params.id)}/submit`, identityOf(user), {
        method: 'POST', body: {
          clientRequestId: input.clientRequestId, avatarId: input.avatarId, voiceId: input.voiceId,
          name: input.name, voiceSource: input.voiceSource,
          ...(input.kind !== 'avatarImage' ? { model: CLIP_VOICE_MODEL } : {}),
        },
      });
      if (submitted.status === 'failed') {
        for (const hold of holds) await refundCloneHold(hold.id, 'submit_failed').catch(() => {});
      } else if (submitted.status === 'accepted') {
        holds = await attachCloneTargets(holds, submitted);
      }
      await recordAudit({
        tenantId: user.tenantId, userId: user.id, action: 'user.video.clone.direct-upload.accepted',
        payload: { kind: input.kind, uploadId: submitted.uploadId, clientRequestId: input.clientRequestId, credits: total, status: submitted.status },
      });
      return publicUploadStatus(submitted);
    } catch (e) {
      // 连接超时不在这里猜「上游没受理」：同 uploadId 状态可恢复，立即退款反而会造成已开工却没扣费。
      return sendErr(reply, e, 422);
    }
  });

  app.get<{ Params: { id: string } }>('/video/avatar/uploads/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      assertId(req.params.id);
      const status = await aidramaJson<UpstreamCloneUploadStatus>(`/api/me/clip/avatar/uploads/${enc(req.params.id)}`, identityOf(user), { timeoutCapMs: 15_000 });
      const holds = await cloneHoldsForRequest(user.id, status.clientRequestId);
      if (status.status === 'accepted') await attachCloneTargets(holds, status);
      else if (status.status === 'failed') for (const hold of holds) await refundCloneHold(hold.id, 'submit_failed').catch(() => {});
      return publicUploadStatus(status);
    } catch (e) { return sendErr(reply, e, 404); }
  });

  app.post('/video/avatar/clone', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    // 预扣成功后但凡后面任一步失败，都要把这批 hold 退回；ownsSubmission 保证并发复用者无退款权。
    let holds: Awaited<ReturnType<typeof reserveCloneCredits>>['holds'] = [];
    let ownsSubmission = false;
    try {
      const data = await req.file();
      if (!data) return reply.code(400).send({ error: '未收到采集文件', code: 'CLIP_CLONE_FILE_REQUIRED' });
      const buffer = await data.toBuffer();
      const fields = data.fields as Record<string, { value?: unknown }> | undefined;
      const rawKind = fields?.kind?.value;
      const kind = String(rawKind ?? '');
      if (!['avatar', 'voice', 'avatarImage'].includes(kind)) throw Object.assign(new Error('采集类型非法'), { statusCode: 422, code: 'CLIP_CLONE_KIND_INVALID' });
      // 这两个字段只有带计费的那版小程序才会发。老版本发不出来 —— 它们在界面上也没给用户看过价，
      // 那就绝不能替它静默扣钱；只能明确请用户更新，文案要让用户看得懂该干什么，
      // 而不是甩一句「缺少合法的 clientRequestId」。
      const clientRequestId = String(fields?.clientRequestId?.value ?? '').trim();
      if (!/^[A-Za-z0-9:_-]{8,100}$/.test(clientRequestId)) {
        return reply.code(422).send({ error: '请把小程序更新到最新版本后再创建数字分身', code: 'CLIP_CLONE_CLIENT_OUTDATED' });
      }
      const voiceId = String(fields?.voiceId?.value ?? '');
      const voiceSource = String(fields?.voiceSource?.value ?? '');

      // 计价先行：端上展示的是哪几档、服务端就按哪几档收，且档位由服务端自己判定（见 cloneChargeItems）。
      const pricing = await clonePricing();
      const items = cloneChargeItems({ kind, voiceId, voiceSource }, pricing);
      const total = cloneChargeTotal(items);
      const expectedCredits = Number(fields?.expectedCredits?.value);
      if (!Number.isSafeInteger(expectedCredits) || expectedCredits < 0) {
        return reply.code(422).send({ error: '请把小程序更新到最新版本后再创建数字分身', code: 'CLIP_CLONE_CLIENT_OUTDATED' });
      }
      // 端上看到的价 ≠ 服务端要收的价 → 停下来重新确认。运营改价后正在填表的人不该被静默按新价扣。
      if (expectedCredits !== total) {
        throw Object.assign(new Error('训练报价已变化，请返回重新确认'), { statusCode: 409, code: 'CLIP_CLONE_QUOTE_CHANGED' });
      }
      // 余额闸提前到内容审核之前：别让用户等审完大文件才被告知钱不够。真正扣费仍在调上游前。
      await assertCloneAffordable(user.id, total);

      // 同 consent：录音临时文件常被 wx.uploadFile 标成 octet-stream，必须按魔数纠正后再校验。
      const mimeType = resolveCaptureMime(kind as CaptureKind, data.mimetype, buffer);
      assertCaptureUpload(kind as CaptureKind, mimeType, buffer.length, data.file.truncated);
      await assertVideoMediaModerationReady(mimeType);
      await assertVideoUploadContent(buffer, mimeType, identityOf(user));

      const reservation = await reserveCloneCredits({ tenantId: user.tenantId, userId: user.id, clientRequestId, items });
      holds = reservation.holds;
      if (reservation.reused) {
        // 同一次提交的重试。已退款 = 上一次已经失败并退干净了，必须换一个请求标识重来，
        // 否则会卡在「复用一笔已经结束的 hold」上，既不扣费也不建单。
        if (holds.some((hold) => hold.status === 'refunded')) {
          throw Object.assign(new Error('这次训练已经结束，请重新提交'), { statusCode: 409, code: 'CLIP_CLONE_REQUEST_CLOSED' });
        }
        // 已建单的按原结果幂等返回，未建单的说明首个请求还在跑，让端上稍后再查。
        const attached = holds.filter((hold) => hold.targetId);
        if (!attached.length) {
          throw Object.assign(new Error('这次训练正在提交，请稍后在分身管理里查看'), { statusCode: 409, code: 'CLIP_CLONE_CREATING' });
        }
        return {
          ok: true, kind, status: 'training', reused: true,
          avatarId: attached.find((hold) => hold.targetKind === 'avatar')?.targetId ?? undefined,
          voiceId: attached.find((hold) => hold.targetKind === 'voice')?.targetId ?? undefined,
        };
      }
      ownsSubmission = true;

      const result = await aidramaUpload<{ avatarId?: string; voiceId?: string }>('/api/me/clip/avatar/clone', identityOf(user), { buffer, fileName: captureFileName(kind as CaptureKind, data.filename, mimeType), mimeType }, {
        kind,
        ...(kind !== 'avatarImage' ? { model: CLIP_VOICE_MODEL } : {}),
        // 声音来源的显式意图：'video' = 只从本次视频提取，服务端据此禁止回退到旧声音。
        voiceSource,
        avatarId: String(fields?.avatarId?.value ?? ''),
        voiceId,
        name: String(fields?.name?.value ?? ''),
        clientRequestId,
      });
      // 没产出对应对象的那一档在这里就退（典型：选了「视频原声」但视频里提不出可用音色）。
      holds = await attachCloneTargets(holds, result);

      // 重训只会「成功」或「报错」，不会变成新建（上游 retrainVoice 已去掉回落）。
      // 万一上游回了另一条 id，那是契约被破坏，不能当正常情况吞掉。
      if (items.some((item) => item.action === 'voiceRetrain') && result?.voiceId && result.voiceId !== voiceId) {
        req.log.error({ userId: user.id, requestedVoiceId: voiceId, createdVoiceId: result.voiceId },
          '[video-clone] 重训返回了另一条声音，上游契约被破坏');
      }
      await recordAudit({
        tenantId: user.tenantId, userId: user.id, action: 'user.video.clone',
        payload: {
          kind, clientRequestId, credits: total,
          items: items.map((item) => ({ action: item.action, credits: item.credits })),
          avatarId: result?.avatarId, voiceId: result?.voiceId,
        },
      });
      return { ok: true, kind, status: 'training', ...result, creditsHeld: total };
    } catch (e) {
      if (ownsSubmission) for (const hold of holds) await refundCloneHold(hold.id, 'submit_failed').catch(() => {});
      return sendErr(reply, e, 422);
    }
  });
  // 这条声音还剩几次免费重训。只在重训页调一次 —— 它会打到供应商，不能塞进声音列表接口。
  app.get<{ Params: { id: string } }>('/video/voices/:id/retrain-quota', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      assertId(req.params.id);
      return await aidramaJson(`/api/me/clip/voices/${enc(req.params.id)}/retrain-quota`, identityOf(user));
    } catch (e) { return sendErr(reply, e, 404); }
  });
  /**
   * 声音试听：给一段文字，让这条声音念出来。
   *
   * 石榴官方就有这个能力（POST /speaker/tts，同步返回音频），军师也早就在用 ——
   * 但此前唯一的入口是 `/video/projects/:id/preview-voice`，**必须先有一个 project**，
   * 声音是从 project 的 payload 里解析出来的。结果是用户想听刚训好的声音，得先挑模板、
   * 建项目、进文案页、点开某一句才听得到，而且听到的还是那个项目绑定的声音。
   * 用户原话：「训练出来的数字人声音效果不确定…先听一下，免得做成片效果不好，浪费钻石。」
   *
   * 这条路由不扣钻石（同 preview-voice，纯透传、无 hold/settle），成本落在石榴的 validPoint 上，
   * 由我们承担。所以必须有限流：试听是免费的，但不能变成免费 TTS 接口。
   *
   * 首版额度按「够judge像不像、不够当工具用」来定：5 次 / 5 分钟 + 80 字。
   * 判断一条声音像不像本人，一两句就够；给到 20 次 × 200 字等于每 5 分钟能薅走
   * 十几分钟的合成音频，那是把接口当免费 TTS。
   */
  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    '/video/voices/:id/preview',
    { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } },
    async (req, reply) => {
      const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
      try {
        assertId(req.params.id);
        const text = String(req.body?.text ?? '').trim();
        // 上限对齐石榴的 requiredText(text, 10_000)，但试听没有必要放那么长：
        // 一两句就够判断像不像，太长只会白烧供应商点数、也让用户等。
        if (!text) throw Object.assign(new Error('先写一句想听的话'), { statusCode: 422, code: 'CLIP_PREVIEW_TEXT_REQUIRED' });
        if (text.length > 80) throw Object.assign(new Error('试听最多 80 字'), { statusCode: 422, code: 'CLIP_PREVIEW_TEXT_TOO_LONG' });
        return await aidramaJson<ClipVoicePreview>(
          `/api/me/clip/voices/${enc(req.params.id)}/preview`,
          identityOf(user),
          { method: 'POST', body: { text }, timeoutCapMs: 60000 },
        );
      } catch (e) { return sendErr(reply, e, 422); }
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string } }>('/video/voices/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      assertId(req.params.id);
      return await aidramaJson(`/api/me/clip/voices/${enc(req.params.id)}`, identityOf(user), { method: 'PATCH', body: { name: req.body?.name ?? '' } });
    } catch (e) { return sendErr(reply, e, 422); }
  });

  app.get('/video/avatar/consents', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try { return await aidramaJson('/api/me/clip/avatar/consents', identityOf(user)); }
    catch (e) { return sendErr(reply, e, 502); }
  });
  app.get('/video/avatar/usages', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try { return await aidramaJson('/api/me/clip/avatar/usages', identityOf(user)); }
    catch (e) { return sendErr(reply, e, 502); }
  });
  app.delete('/video/avatar', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const result = await aidramaJson('/api/me/clip/avatar', identityOf(user), { method: 'DELETE' });
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.video.avatar.delete', payload: { upstreamDeleted: true } });
      return result;
    } catch (e) { return sendErr(reply, e, 422); }
  });
  app.delete<{ Params: { id: string } }>('/video/avatars/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      assertId(req.params.id);
      const result = await aidramaJson(`/api/me/clip/avatars/${enc(req.params.id)}`, identityOf(user), { method: 'DELETE' });
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.video.avatar.delete_one', payload: { avatarId: req.params.id, upstreamDeleted: true } });
      return result;
    } catch (e) { return sendErr(reply, e, 422); }
  });
}
