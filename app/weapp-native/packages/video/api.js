// 「快出片」API 客户端。
//
// mock / BFF 两种后端模式（config.js 的 BACKEND_MODE）在这里分流，**页面只认业务方法名**，
// 切模式时页面代码零改动。路径命名对齐方案 §7 的端点草案（/clip/*）。
const host = require('./host');
const config = require('./config');
const mock = require('./mock');
const catalog = require('./catalog');

const q = (value) => encodeURIComponent(value == null ? '' : String(value));
const useMock = () => config.BACKEND_MODE === 'mock' && host.shouldUseMock();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function captureFileMeta(kind, payload) {
  const filePath = String(payload.filePath || '');
  let fileName = filePath.split(/[\\/]/).pop() || `capture-${Date.now()}`;
  const defaults = kind === 'voice' ? { ext: 'mp3', mime: 'audio/mpeg' }
    : kind === 'avatarImage' ? { ext: 'jpg', mime: 'image/jpeg' }
      : { ext: 'mp4', mime: 'video/mp4' };
  if (!/\.[A-Za-z0-9]{2,6}$/.test(fileName)) fileName += `.${defaults.ext}`;
  const ext = (fileName.match(/\.([A-Za-z0-9]+)$/) || [])[1];
  const mime = ({ mov: 'video/quicktime', mp4: 'video/mp4', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac' })[String(ext || '').toLowerCase()] || defaults.mime;
  return { fileName, contentType: mime, sizeBytes: Number(payload.sizeBytes || 0) };
}

async function waitCloneAccepted(uploadId, onPhase) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const status = await call(`/avatar/uploads/${q(uploadId)}`);
    if (status.status === 'accepted') return status;
    if (status.status === 'failed') throw Object.assign(new Error(status.errorMessage || '训练受理失败，请重新提交'), { code: status.errorCode || 'CLIP_CLONE_SUBMIT_FAILED', statusCode: 422 });
    if (onPhase) onPhase('processing');
    await delay(1500);
  }
  throw Object.assign(new Error('素材已经上传，军师仍在受理，请不要重复提交，稍后到数字人管理查看。'), { code: 'CLIP_CLONE_ACCEPTING', statusCode: 409 });
}

/** 真实请求统一进入军师 BFF。 */
function call(path, options) {
  const opts = options || {};
  return host.httpRequest(`${config.BFF_PREFIX}${path}`, opts);
}

const api = {
  /** 只供纯 mock 会话展示/打通扣费前交互；附身 JWT 与 server 模式返回 null。 */
  mockCreditBalance: () => (useMock() ? mock.creditBalance() : null),

  /* ── 模板 ── */
  templates: () => (useMock() ? mock.templates() : call('/templates')),
  template: (id) => (useMock() ? mock.template(id) : call(`/templates/${q(id)}`)),
  builtInTemplates: () => catalog.listBuiltInTemplates(),
  builtInTemplate: (id) => catalog.getBuiltInTemplate(id),

  /* ── 项目（草稿）── */
  createProject: (templateId) => (useMock()
    ? mock.createProject(templateId)
    : call('/projects', { method: 'POST', data: { templateId } })),
  project: (id) => (useMock() ? mock.project(id) : call(`/projects/${q(id)}`)),
  /** 防抖自动保存。payload 是整个 { variables, segments, ... }。 */
  saveProject: (id, payload) => (useMock()
    ? mock.saveProject(id, payload)
    : call(`/projects/${q(id)}`, { method: 'PUT', data: payload })),
  /** 首页「继续上次」：最近一个未完成的草稿。无则返回 null。 */
  ongoingProject: () => (useMock() ? mock.ongoingProject() : call('/projects/ongoing')),

  /* ── 文案 ── */
  /** scope: 'all' 整段改写 | 'segment' 单句改写 */
  aiRewrite: (id, scope, no, text) => (useMock()
    ? mock.aiRewrite(id, scope, no, text)
    : call(`/projects/${q(id)}/script/ai-rewrite`, { method: 'POST', data: { scope, no, text }, timeout: 120000 })),
  scriptChat: (id, message) => (useMock()
    ? mock.scriptChat(id, message)
    : call(`/projects/${q(id)}/script/chat`, { method: 'POST', data: { message }, timeout: 120000 })),
  resetScript: (id) => (useMock()
    ? mock.resetScript(id)
    : call(`/projects/${q(id)}/script/reset`, { method: 'POST', data: {} })),
  /** 单句试听，回填真实 TTS 时长。 */
  previewVoice: (id, no, text) => (useMock()
    ? mock.previewVoice(id, no, text)
    : call(`/projects/${q(id)}/preview-voice`, { method: 'POST', data: { no, text }, timeout: 60000 })),

  /* ── 出片 ── */
  /** 服务端报价。端上 model.estimateCredits 只是预估，**扣费以本接口为准**。 */
  estimate: (id, segments, shots) => (useMock()
    ? mock.estimate(segments, shots)
    : call(`/projects/${q(id)}/estimate`, { method: 'POST', data: { segments, shots } })),
  render: (id, clientRequestId, expectedCredits) => (useMock()
    ? mock.render(id)
    : call(`/projects/${q(id)}/render`, { method: 'POST', data: { clientRequestId, expectedCredits }, timeout: 60000 })),
  job: (jobId) => (useMock() ? mock.job(jobId) : call(`/jobs/${q(jobId)}`)),
  cancelJob: (jobId) => (useMock()
    ? Promise.resolve({ ok: true })
    : call(`/jobs/${q(jobId)}/cancel`, { method: 'POST', data: {} })),

  /* ── 素材 ── */
  assets: () => (useMock() ? mock.assets() : call('/assets')),
  uploadAsset: (filePath, meta) => (useMock()
    ? mock.uploadAsset(filePath, meta)
    : host.httpUpload(`${config.BFF_PREFIX}/assets`, filePath, meta || {})),
  updateAsset: (id, patch) => (useMock()
    ? mock.updateAsset(id, patch)
    : call(`/assets/${q(id)}`, { method: 'PATCH', data: patch || {} })),
  assetStorage: () => (useMock() ? mock.assetStorage() : call('/assets/storage')),
  /** 买一个存储扩容包。带幂等标识：连点两下 / 重试不能扣两次钻石。 */
  expandStorage: (clientRequestId) => (useMock()
    ? mock.expandStorage()
    : call('/assets/storage/expand', { method: 'POST', data: { clientRequestId } })),
  deleteAsset: (id) => (useMock()
    ? mock.deleteAsset(id)
    : call(`/assets/${q(id)}`, { method: 'DELETE' })),

  /* ── 作品 ── */
  works: () => (useMock() ? mock.works() : call('/works')),
  work: (id) => (useMock() ? mock.work(id) : call(`/works/${q(id)}`)),
  workDownloadUrl: (id) => host.httpUrl(`${config.BFF_PREFIX}/works/${q(id)}/file`),
  deleteWork: (id) => (useMock()
    ? mock.deleteWork(id)
    : call(`/works/${q(id)}`, { method: 'DELETE' })),
  publish: (id, platform) => (useMock()
    ? mock.publish(id, platform)
    : call(`/works/${q(id)}/publish`, { method: 'POST', data: { platform } })),

  /* ── 分身（走 aidrama 的 dap 域扩展，见方案 §6.5）── */
  avatar: () => (useMock() ? mock.avatar() : call('/avatar')),
  avatars: () => (useMock() ? mock.avatars() : call('/avatars')),
  avatarById: (id) => (useMock() ? mock.avatars().then((rows) => rows.find((item) => item.id === id) || null) : call(`/avatars/${q(id)}`)),
  voices: () => (useMock() ? mock.voices() : call('/voices')),
  /**
   * 单条声音。声音训练页靠它轮询 —— 只训声音不建形象时，形象接口里根本没有这条记录，
   * 拿形象轮声音会永远停在「训练中」（2026-08-15 事故即此）。
   */
  voiceById: (id) => (useMock() ? mock.voiceById(id) : call(`/voices/${q(id)}`)),
  /**
   * 试听某一条声音。**不需要 project** —— 训练完当场就要能听。
   *
   * 与 previewVoice 的区别：那条要先有项目、声音是从项目 payload 里解析的；这条直接按 voiceId 走。
   * 两条底下都是石榴的 POST /speaker/tts，都不扣用户钻石。
   */
  previewVoiceById: (id, text) => (useMock()
    ? mock.previewVoiceById(id, text)
    : call(`/voices/${q(id)}/preview`, { method: 'POST', data: { text }, timeout: 60000 })),
  renameVoice: (id, name) => (useMock()
    ? Promise.resolve({ id, name })
    : call(`/voices/${q(id)}`, { method: 'PATCH', data: { name } })),
  avatarRequirements: () => (useMock() ? mock.avatarRequirements() : call('/avatar/requirements')),
  /** 这条声音还剩几次免费重训。只在重训页调 —— 它会打到供应商，不能进列表接口。 */
  retrainQuota: (id) => (useMock() ? mock.retrainQuota(id) : call(`/voices/${q(id)}/retrain-quota`)),
  /** 克隆各档单价（运营后台可配）。端上只显示，不参与计算，更不自带常量。 */
  clonePricing: () => (useMock() ? mock.clonePricing() : call('/clone-pricing')),
  startConsent: (payload) => {
    if (useMock()) return mock.startConsent(payload);
    const filePath = payload && payload.filePath;
    const text = payload && payload.text;
    if (!filePath || !text) return Promise.reject(new Error('请先录制本人授权视频'));
    return host.httpUpload(`${config.BFF_PREFIX}/avatar/consent`, filePath, { text }, { timeout: 180000 });
  },
  startClone: async (kind, payload) => {
    if (useMock()) return mock.startClone(kind, payload);
    const filePath = payload && payload.filePath;
    if (!filePath) return Promise.reject(Object.assign(new Error('缺少采集文件'), { code: 'CLIP_CLONE_FILE_REQUIRED' }));
    const meta = captureFileMeta(kind, payload || {});
    const request = Object.assign({}, meta, {
      kind,
      voiceSource: payload.voiceSource || '', avatarId: payload.avatarId || '', voiceId: payload.voiceId || '', name: payload.name || '',
      clientRequestId: payload.clientRequestId || '', expectedCredits: payload.expectedCredits,
    });
    if (payload.onPhase) payload.onPhase('preparing');
    const ticket = await call('/avatar/uploads', { method: 'POST', data: request, timeout: 30000 });
    if (ticket.status === 'issued') {
      if (!ticket.uploadUrl) throw Object.assign(new Error('上传服务没有返回地址'), { code: 'CLIP_DIRECT_UPLOAD_NOT_CONFIGURED' });
      if (payload.onPhase) payload.onPhase('uploading');
      try {
        await host.directFileUpload(ticket.uploadUrl, filePath, ticket.formData || {}, { timeout: 360000, onProgress: payload.onProgress });
      } catch (error) {
        // 首次直传其实已写入 OSS、但成功响应在弱网中丢失时，同一受理号重试会被
        // forbid-overwrite 以 409 拒绝。此时继续 complete 做 HEAD 精确核验，不能换 ID 再传一份。
        if (error && error.statusCode === 409) {
          if (payload.onPhase) payload.onPhase('verifying');
        }
        // 域名白名单没生效时文件确定没有离开手机，安全回退旧 BFF；其它网络错误可能已写入 OSS，不能盲传第二份。
        else if (error && error.reason === 'domain') {
          if (payload.onPhase) payload.onPhase('uploading');
          return host.httpUpload(`${config.BFF_PREFIX}/avatar/clone`, filePath, {
            kind, voiceSource: request.voiceSource, avatarId: request.avatarId, voiceId: request.voiceId, name: request.name,
            clientRequestId: request.clientRequestId, expectedCredits: String(request.expectedCredits),
          }, { timeout: 360000, onProgress: payload.onProgress });
        }
        else throw error;
      }
    }
    if (payload.onPhase) payload.onPhase('verifying');
    const submitted = await call(`/avatar/uploads/${q(ticket.uploadId)}/complete`, { method: 'POST', data: request, timeout: 120000 });
    if (submitted.status === 'accepted') return submitted;
    if (submitted.status === 'failed') throw Object.assign(new Error(submitted.errorMessage || '上传校验失败'), { code: submitted.errorCode || 'CLIP_UPLOAD_VERIFY_FAILED', statusCode: 422 });
    return waitCloneAccepted(ticket.uploadId, payload.onPhase);
  },
  consentLogs: () => (useMock() ? mock.consentLogs() : call('/avatar/consents')),
  usageLogs: () => (useMock() ? mock.usageLogs() : call('/avatar/usages')),
  deleteAvatar: () => (useMock()
    ? mock.deleteAvatar()
    : call('/avatar', { method: 'DELETE' })),
  deleteAvatarById: (id) => (useMock()
    ? mock.deleteAvatarById(id)
    : call(`/avatars/${q(id)}`, { method: 'DELETE' })),

  /* ── 微信订阅消息：走宿主 BFF 通用端点，不挂 /video 前缀 ── */
  subscribeTemplates: () => (useMock()
    ? Promise.resolve({ scenes: [] })
    : host.httpRequest('/wechat/subscribe/templates')),
  recordSubscribeChoice: (choice) => (useMock()
    ? Promise.resolve({ ok: true, accepted: 0 })
    : host.httpRequest('/wechat/subscribe', { method: 'POST', data: { choices: [choice] } })),

  isMock: useMock,
};

module.exports = api;
