import type { FastifyInstance, FastifyReply } from 'fastify';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { aidramaJson, aidramaUpload } from '../services/video/aidramaGateway.js';
import {
  attachVideoJob, refundStaleUnsubmittedVideoHolds, refundVideoHold, reserveVideoCredits, settleVideoJob,
} from '../services/video/credits.js';
import { assertVideoMediaModerationReady, assertVideoProjectContent, assertVideoRewriteOutput, assertVideoUploadContent } from '../services/video/moderation.js';
import { generateClipScriptTurn } from '../services/video/scriptChat.js';
import type {
  ClipAsset, ClipAvatarView, ClipCaptureRequirements, ClipConsentResult, ClipEstimate, ClipJobView, ClipProject,
  ClipRenderRequest, ClipRenderResult, ClipTemplate, ClipVoiceView, ClipWork,
} from '../../../shared/contracts';

type Identity = { userId: string; tenantId: string };

function sendErr(reply: FastifyReply, error: unknown, fallback = 400) {
  const e = error as { statusCode?: number; code?: string; message?: string };
  return reply.code(e.statusCode ?? fallback).send({ error: e.message ?? '操作失败', code: e.code });
}

const enc = (value: string) => encodeURIComponent(value);
const validId = (value: string) => /^[A-Za-z0-9_-]{3,100}$/.test(value);

function identityOf(user: { id: string; tenantId: string }): Identity {
  return { userId: user.id, tenantId: user.tenantId };
}

function assertId(id: string) {
  if (!validId(id)) throw Object.assign(new Error('资源标识非法'), { statusCode: 400, code: 'CLIP_ID_INVALID' });
}

function rewriteBody(body: unknown) {
  const row = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const scope = row.scope === 'all' ? 'all' : row.scope === 'segment' ? 'segment' : '';
  if (!scope) throw Object.assign(new Error('改写范围非法'), { statusCode: 422, code: 'CLIP_REWRITE_INVALID' });
  const text = typeof row.text === 'string' ? row.text.trim() : null;
  if (scope === 'segment' && !text) throw Object.assign(new Error('单句文案不能为空'), { statusCode: 422, code: 'CLIP_REWRITE_INVALID' });
  return { scope, no: typeof row.no === 'number' ? row.no : null, text };
}

const VIDEO_CAPTURE_MIMES = new Set(['video/mp4', 'video/quicktime']);
const VOICE_CAPTURE_MIMES = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/x-m4a']);

function assertCaptureUpload(kind: 'consent' | 'avatar' | 'voice', mimeType: string, bytes: number, truncated: boolean) {
  const voice = kind === 'voice';
  const maxBytes = voice ? 20 * 1024 * 1024 : 100 * 1024 * 1024;
  const allowed = voice ? VOICE_CAPTURE_MIMES : VIDEO_CAPTURE_MIMES;
  if (!allowed.has(String(mimeType || '').toLowerCase())) {
    throw Object.assign(new Error(voice ? '声音只支持 WAV、MP3、OGG、M4A 或 AAC' : '视频只支持 MP4 或 MOV'), { statusCode: 422, code: 'CLIP_CAPTURE_FORMAT_INVALID' });
  }
  if (truncated || bytes <= 0 || bytes > maxBytes) {
    throw Object.assign(new Error(voice ? '声音文件不能超过 20MB' : '视频文件不能超过 100MB'), { statusCode: 413, code: 'CLIP_CAPTURE_TOO_LARGE' });
  }
}

function captureFileName(kind: 'consent' | 'avatar' | 'voice', fileName: string | undefined, mimeType: string) {
  const supplied = String(fileName || '').trim();
  if (/\.[a-z0-9]{2,5}$/i.test(supplied)) return supplied;
  if (kind !== 'voice') return kind === 'consent' ? 'consent.mp4' : 'avatar.mp4';
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('wav')) return 'voice.wav';
  if (mime.includes('ogg')) return 'voice.ogg';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'voice.m4a';
  if (mime.includes('aac')) return 'voice.aac';
  return 'voice.mp3';
}

export async function videoRoutes(app: FastifyInstance) {
  // 扣费后尚未拿到上游 jobId 的崩溃窗口有界自动退款。
  void refundStaleUnsubmittedVideoHolds().catch(() => {});
  const sweepTimer = setInterval(() => { void refundStaleUnsubmittedVideoHolds().catch(() => {}); }, 5 * 60_000);
  sweepTimer.unref();
  app.addHook('onClose', async () => clearInterval(sweepTimer));

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
      if (holdId && ownsSubmission) await refundVideoHold(holdId, 'submit_failed').catch(() => {});
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

  app.post('/video/assets', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const data = await req.file();
      if (!data) return reply.code(400).send({ error: '未收到素材', code: 'CLIP_ASSET_REQUIRED' });
      await assertVideoMediaModerationReady(data.mimetype);
      const buffer = await data.toBuffer();
      if (data.file.truncated || buffer.length > 100 * 1024 * 1024) return reply.code(413).send({ error: '素材超过 100MB', code: 'CLIP_ASSET_TOO_LARGE' });
      await assertVideoUploadContent(buffer, data.mimetype, identityOf(user));
      const fields = Object.fromEntries(Object.entries(data.fields as Record<string, { value?: unknown }>).map(([key, value]) => [key, String(value?.value ?? '')]));
      return await aidramaUpload<ClipAsset>('/api/me/clip/assets', identityOf(user), { buffer, fileName: data.filename || 'asset', mimeType: data.mimetype }, fields);
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

  app.get('/video/works', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try { return await aidramaJson<ClipWork[]>('/api/me/clip/works', identityOf(user)); }
    catch (e) { return sendErr(reply, e, 502); }
  });
  app.get<{ Params: { id: string } }>('/video/works/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try { assertId(req.params.id); return await aidramaJson<ClipWork>(`/api/me/clip/works/${enc(req.params.id)}`, identityOf(user)); }
    catch (e) { return sendErr(reply, e, 404); }
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
    try { return await aidramaJson<ClipAvatarView | null>('/api/me/clip/avatar', identityOf(user)); }
    catch (e) { return sendErr(reply, e, 502); }
  });
  app.get('/video/avatars', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try { return await aidramaJson<ClipAvatarView[]>('/api/me/clip/avatars', identityOf(user)); }
    catch (e) { return sendErr(reply, e, 502); }
  });
  app.get('/video/voices', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try { return await aidramaJson<ClipVoiceView[]>('/api/me/clip/voices', identityOf(user)); }
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
      await assertVideoMediaModerationReady(data.mimetype);
      const buffer = await data.toBuffer();
      assertCaptureUpload('consent', data.mimetype, buffer.length, data.file.truncated);
      await assertVideoUploadContent(buffer, data.mimetype, identityOf(user));
      const rawText = (data.fields as Record<string, { value?: unknown }> | undefined)?.text?.value;
      const text = String(rawText ?? '').trim();
      if (!text || text.length > 300) throw Object.assign(new Error('授权口令无效'), { statusCode: 422, code: 'CLIP_CONSENT_TEXT_REQUIRED' });
      return await aidramaUpload<ClipConsentResult>('/api/me/clip/avatar/consent', identityOf(user),
        { buffer, fileName: captureFileName('consent', data.filename, data.mimetype), mimeType: data.mimetype }, { text });
    }
    catch (e) { return sendErr(reply, e, 422); }
  });
  app.post('/video/avatar/clone', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const data = await req.file();
      if (!data) return reply.code(400).send({ error: '未收到采集文件', code: 'CLIP_CLONE_FILE_REQUIRED' });
      const buffer = await data.toBuffer();
      const fields = data.fields as Record<string, { value?: unknown }> | undefined;
      const rawKind = fields?.kind?.value;
      const kind = String(rawKind ?? '');
      if (!['avatar', 'voice'].includes(kind)) throw Object.assign(new Error('采集类型非法'), { statusCode: 422, code: 'CLIP_CLONE_KIND_INVALID' });
      assertCaptureUpload(kind as 'avatar' | 'voice', data.mimetype, buffer.length, data.file.truncated);
      await assertVideoMediaModerationReady(data.mimetype);
      await assertVideoUploadContent(buffer, data.mimetype, identityOf(user));
      return await aidramaUpload('/api/me/clip/avatar/clone', identityOf(user), { buffer, fileName: captureFileName(kind as 'avatar' | 'voice', data.filename, data.mimetype), mimeType: data.mimetype }, {
        kind,
        avatarId: String(fields?.avatarId?.value ?? ''),
        voiceId: String(fields?.voiceId?.value ?? ''),
        name: String(fields?.name?.value ?? ''),
      });
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
