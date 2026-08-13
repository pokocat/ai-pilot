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
  deleteAsset: (id) => (useMock()
    ? mock.deleteAsset(id)
    : call(`/assets/${q(id)}`, { method: 'DELETE' })),

  /* ── 作品 ── */
  works: () => (useMock() ? mock.works() : call('/works')),
  work: (id) => (useMock() ? mock.work(id) : call(`/works/${q(id)}`)),
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
  renameVoice: (id, name) => (useMock()
    ? Promise.resolve({ id, name })
    : call(`/voices/${q(id)}`, { method: 'PATCH', data: { name } })),
  avatarRequirements: () => (useMock() ? mock.avatarRequirements() : call('/avatar/requirements')),
  startConsent: (payload) => {
    if (useMock()) return mock.startConsent(payload);
    const filePath = payload && payload.filePath;
    const text = payload && payload.text;
    if (!filePath || !text) return Promise.reject(new Error('请先录制本人授权视频'));
    return host.httpUpload(`${config.BFF_PREFIX}/avatar/consent`, filePath, { text }, { timeout: 180000 });
  },
  startClone: (kind, payload) => {
    if (useMock()) return mock.startClone(kind, payload);
    const filePath = payload && payload.filePath;
    if (!filePath) return Promise.reject(Object.assign(new Error('缺少采集文件'), { code: 'CLIP_CLONE_FILE_REQUIRED' }));
    return host.httpUpload(`${config.BFF_PREFIX}/avatar/clone`, filePath, {
      kind,
      // 显式告诉服务端「用户选的是视频原声」，不能靠空 voiceId 猜 —— 猜的结果是回退旧声音。
      voiceSource: payload.voiceSource || '',
      avatarId: payload.avatarId || '',
      voiceId: payload.voiceId || '',
      name: payload.name || '',
    }, { timeout: 180000 });
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
