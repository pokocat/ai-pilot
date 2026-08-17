const mock = require('./mock');
const { request, upload } = require('./request');
const { getToken } = require('./token');
const { getApiBaseUrl, getImpersonationBaseUrl, useMockApi } = require('./runtime-mode');

const isMock = () => useMockApi();
const query = (value) => encodeURIComponent(value == null ? '' : String(value));

const api = {
  raw: (path, method, data, options) => isMock()
    ? mock.raw(path, method || 'GET', data)
    : request(path, Object.assign({ method: method || 'GET', data }, options || {})),
  agents: () => isMock() ? mock.agents() : request('/agents'),
  purchaseAgent: (key, attribution) => isMock()
    ? mock.purchaseAgent(key, attribution)
    : request(`/agents/${query(key)}/purchase`, { method: 'POST', data: Object.assign({}, attribution || {}) }),
  sessions: () => isMock() ? mock.sessions() : request('/sessions'),
  // 问策入口：提示词池与进场主动消息。两条都对游客开放（hints 无鉴权；proactive 需登录，
  // 端上只在已登录分支调用），失败一律由调用方静默降级，不得阻塞进场。
  wenceHints: () => isMock() ? mock.wenceHints() : request('/wence/hints'),
  proactiveSession: () => isMock() ? mock.proactiveSession() : request('/sessions/proactive', { method: 'POST', data: {} }),
  session: (id, before) => isMock()
    ? mock.session(id, before)
    : request(`/sessions/${query(id)}${before ? `?before=${query(before)}` : ''}`),
  deleteSession: (id) => isMock() ? mock.deleteSession(id) : request(`/sessions/${query(id)}`, { method: 'DELETE' }),
  search: (q) => isMock() ? mock.search(q) : request(`/search?q=${query(q)}`),
  sendSmsCode: (phone, scene) => isMock() ? mock.sendSmsCode(phone, scene) : request('/auth/sms/send', { method: 'POST', data: { phone, scene } }),
  login: (phone, code) => isMock() ? mock.login(phone) : request('/auth/login', { method: 'POST', data: { phone, code } }),
  wechatLogin: (code) => isMock() ? mock.wechatLogin(code) : request('/auth/wechat-login', { method: 'POST', data: { code } }),
  wechatPhoneLogin: (phoneCode, loginCode) => isMock()
    ? mock.wechatPhoneLogin(phoneCode)
    : request('/auth/wechat-phone', { method: 'POST', data: { phoneCode, loginCode } }),
  me: () => isMock() ? mock.me() : request('/me'),
  verifyImpersonation: (token) => request('/me', {
    token,
    isolatedAuth: true,
    baseUrl: getImpersonationBaseUrl(),
  }),
  getProfile: () => isMock() ? mock.getProfile() : request('/profile'),
  updateIdentity: (body) => isMock() ? mock.updateIdentity(body) : request('/me', { method: 'PUT', data: body }),
  deleteAccount: () => isMock() ? mock.deleteAccount() : request('/me', { method: 'DELETE' }),
  bindPhone: (phone, code) => isMock() ? mock.bindPhone(phone) : request('/auth/bind-phone', { method: 'POST', data: { phone, code } }),
  bindPhoneByWechat: (phoneCode) => isMock() ? mock.bindPhone(undefined, undefined, phoneCode) : request('/auth/bind-phone', { method: 'POST', data: { phoneCode } }),
  setColor: (color) => isMock() ? mock.setColor(color) : request('/me/color', { method: 'PUT', data: { color } }),
  uploadAvatar: (filePath) => isMock() ? mock.uploadAvatar(filePath) : upload('/me/avatar', filePath, {}),
  survey: () => isMock() ? Promise.resolve([{ key: 'industry', title: '你做什么行业？', options: ['企业服务','消费零售','内容/IP','其他'] }, { key: 'stage', title: '目前走到哪一步？', options: ['刚起步','验证中','增长中','稳定经营'] }, { key: 'pain', title: '眼下最痛的一件事？', options: ['方向不清','增长卡住','团队问题','现金流压力'] }]) : request('/survey'),
  saveProfile: (body) => isMock() ? mock.saveProfile(body) : request('/profile', { method: 'PUT', data: body }),
  quickScan: (body) => isMock() ? mock.quickScan(body) : request('/quickscan', { method: 'POST', data: body, timeout: 180000 }),
  generate: (body) => isMock() ? mock.generate(body) : request('/generate-sync', { method: 'POST', data: body, timeout: 180000 }),
  generation: (id) => isMock() ? Promise.resolve({ id, status: 'completed' }) : request(`/generations/${query(id)}`),
  nextDeliveryStage: (id) => isMock()
    ? Promise.reject(new Error('本地演示暂不生成后续阶段'))
    : request(`/generations/${query(id)}/next-stage`, { method: 'POST', data: {} }),
  confirmFact: (id, body) => isMock()
    ? Promise.resolve({ fact: { id, valueText: body && body.valueText || '', status: body && body.action === 'session_only' ? 'rejected' : 'confirmed' }, resolution: body && body.action === 'edit' ? 'edited' : body && body.action === 'session_only' ? 'session_only' : 'confirmed' })
    : request(`/facts/${query(id)}/confirm`, { method: 'POST', data: body || {} }),
  cancelGeneration: (id) => isMock() ? Promise.resolve({ id, status: 'cancelled' }) : request(`/generations/${query(id)}/cancel`, { method: 'POST', data: {} }),
  reviews: () => isMock() ? mock.reviews() : request('/reviews'),
  todaySaying: () => isMock() ? Promise.resolve({ text: '谋定而后动，先把主要矛盾看清。', date: '' }) : request('/sayings/today'),
  journey: () => isMock() ? mock.journey() : request('/journey'),
  decisions: () => isMock() ? mock.decisions() : request('/decisions'),
  progress: () => isMock() ? mock.progress() : request('/progress'),
  workbench: () => isMock() ? mock.workbench() : request('/me/workbench'),
  reminders: () => isMock() ? Promise.resolve({ items: [], subscribeReady: false }) : request('/reminders'),
  wechatSubscribeTemplates: () => isMock() ? Promise.resolve({ scenes: [] }) : request('/wechat/subscribe/templates'),
  recordWechatSubscription: (choices) => isMock() ? Promise.resolve({ ok: true, accepted: 0 }) : request('/wechat/subscribe', { method: 'POST', data: { choices } }),
  knowledgePipeline: () => isMock() ? mock.knowledgePipeline() : request('/knowledge/pipeline'),
  organizeBatch: (batchId) => isMock() ? mock.organizeBatch(batchId) : request('/knowledge/organize', { method: 'POST', data: { batchId }, timeout: 180000 }),
  deepOrganize: (batchId) => isMock() ? mock.organizeBatch(batchId) : request('/knowledge/deep-organize', { method: 'POST', data: { batchId }, timeout: 180000 }),
  confirmKnowledge: (body) => isMock() ? mock.confirmKnowledge(body) : request('/knowledge/confirm', { method: 'POST', data: body, timeout: 180000 }),
  dataSources: () => isMock() ? mock.dataSources() : request('/data-sources'),
  modules: () => isMock() ? mock.modules() : request('/modules'),
  reports: (projectId) => isMock() ? mock.reports(projectId) : request(`/reports${projectId ? `?projectId=${query(projectId)}` : ''}`),
  library: () => isMock() ? mock.library() : request('/library'),
  projects: () => isMock() ? mock.projects() : request('/projects'),
  plans: () => isMock() ? mock.plans() : request('/plans'),
  planOptions: () => isMock() ? mock.planOptions() : request('/plans/options'),
  quotePlan: (id) => isMock() ? mock.quotePlan(id) : request(`/plans/${query(id)}/quote`, { method: 'POST', data: {} }),
  purchasePlan: (id) => isMock() ? mock.purchasePlan(id) : request(`/plans/${query(id)}/purchase`, { method: 'POST', data: {} }),
  createOrder: (id, body) => request(`/plans/${query(id)}/order`, { method: 'POST', data: body }),
  createContractOrder: (id, body) => request(`/plans/${query(id)}/contract-order`, { method: 'POST', data: body }),
  paymentStatus: (outTradeNo) => isMock() ? Promise.resolve({ outTradeNo, status: 'applied', appliedAt: new Date().toISOString() }) : request(`/pay/orders/${query(outTradeNo)}`),
  payOrderStatus: (outTradeNo) => isMock() ? Promise.resolve({ outTradeNo, status: 'applied', appliedAt: new Date().toISOString() }) : request(`/pay/orders/${query(outTradeNo)}`),
  payMock: (outTradeNo) => isMock() ? Promise.resolve({ ok: true, outTradeNo }) : request('/pay/mock/pay', { method: 'POST', data: { outTradeNo } }),
  orders: () => isMock() ? Promise.resolve({ items: [] }) : request('/pay/orders'),
  myOrders: () => isMock() ? Promise.resolve({ items: [] }) : request('/pay/orders'),
  orderPayParams: (outTradeNo) => request(`/pay/orders/${query(outTradeNo)}/pay-params`, { method: 'POST', data: {} }),
  cancelPlanSubscription: (id) => request(`/plans/subscriptions/${query(id)}/cancel`, { method: 'POST', data: {} }),
  planEvent: (body) => isMock() ? Promise.resolve({ ok: true }) : request('/plans/events', { method: 'POST', data: body }),
  skus: () => isMock() ? mock.skus() : request('/skus'),
  createSkuOrder: (key, openid, attribution) => isMock()
    ? mock.createSkuOrder(key, openid, attribution)
    : request(`/skus/${query(key)}/order`, { method: 'POST', data: Object.assign({}, openid ? { openid } : {}, attribution || {}) }),
  refreshForces: () => isMock() ? mock.refreshForces() : request('/forces/refresh', { method: 'POST', data: {} }),
  battleCommit: () => isMock() ? mock.battleCommit() : request('/battle/commit', { method: 'POST', data: {} }),
  acceptDeliverable: (deliverable, agentName, force) => isMock()
    ? mock.acceptDeliverable(deliverable, agentName, force)
    : request('/casefile/accept', { method: 'POST', data: { deliverable, agentName, force } }),
  enableModule: (key) => isMock() ? mock.enableModule(key) : request(`/modules/${query(key)}/enable`, { method: 'POST', data: {} }),
  patchModule: (key, body) => isMock() ? mock.patchModule(key, body) : request(`/modules/${query(key)}`, { method: 'PATCH', data: body }),
  requestDataSourceAuth: (key) => isMock() ? mock.requestDataSourceAuth(key) : request(`/data-sources/${query(key)}/request-auth`, { method: 'POST', data: {} }),
  uploadDataSource: (key, knowledgeId) => isMock() ? mock.uploadDataSource(key, knowledgeId) : request(`/data-sources/${query(key)}/upload`, { method: 'POST', data: knowledgeId ? { knowledgeId } : {} }),
  uploadKnowledge: (filePath, fields, hooks) => {
    const opts = fields || {};
    const qs = [];
    if (opts.projectId) qs.push(`projectId=${query(opts.projectId)}`);
    if (opts.staged) qs.push('staged=true');
    if (opts.batchId) qs.push(`batchId=${query(opts.batchId)}`);
    return isMock()
      ? mock.uploadKnowledge(opts.originalName, opts)
      : upload(`/knowledge/upload${qs.length ? `?${qs.join('&')}` : ''}`, filePath, opts.originalName ? { originalName: opts.originalName } : {}, hooks);
  },
  uploadChatImage: (filePath, projectId, originalName, hooks) => isMock()
    ? Promise.resolve({ id: `mock-image-${Date.now()}` })
    : upload(`/chat/image-upload${projectId ? `?projectId=${query(projectId)}` : ''}`, filePath, originalName ? { originalName } : {}, hooks),
  chatImageUrl: (id) => isMock() ? Promise.resolve({ url: '' }) : request(`/knowledge/${query(id)}/preview`),
  knowledgeDocs: (projectId) => isMock() ? mock.knowledgeDocs(projectId) : request(`/knowledge/docs${projectId ? `?projectId=${query(projectId)}` : ''}`),
  knowledge: (projectId, kind) => {
    const parts = [];
    if (projectId) parts.push(`projectId=${query(projectId)}`);
    if (kind) parts.push(`kind=${query(kind)}`);
    return isMock() ? mock.knowledge(projectId, kind) : request(`/knowledge${parts.length ? `?${parts.join('&')}` : ''}`);
  },
  knowledgeDetail: (id) => isMock() ? mock.knowledgeDetail(id) : request(`/knowledge/${query(id)}`),
  analyzeKnowledge: (id) => isMock() ? Promise.resolve({ reportId: `mock-report-${id}` }) : request(`/knowledge/${query(id)}/analyze`, { method: 'POST', data: {} }),
  createKnowledge: (body) => isMock() ? mock.createKnowledge(body) : request('/knowledge', { method: 'POST', data: body }),
  deleteKnowledge: (id) => isMock() ? mock.deleteKnowledge(id) : request(`/knowledge/${query(id)}`, { method: 'DELETE' }),
  project: (id) => isMock() ? mock.project(id) : request(`/projects/${query(id)}`),
  createProject: (body) => isMock() ? mock.createProject(body) : request('/projects', { method: 'POST', data: body }),
  updateProject: (id, body) => isMock() ? mock.updateProject(id, body) : request(`/projects/${query(id)}`, { method: 'PUT', data: body }),
  deleteProject: (id) => isMock() ? mock.deleteProject(id) : request(`/projects/${query(id)}`, { method: 'DELETE' }),
  report: (id) => isMock() ? mock.report(id) : request(`/reports/${query(id)}`),
  reportVersion: (id, version) => isMock() ? mock.reportVersion(id, version) : request(`/reports/${query(id)}/version${version ? `?v=${query(version)}` : ''}`),
  reportDiff: (id, from, to) => isMock() ? Promise.resolve({ from, to, sections: [] }) : request(`/reports/${query(id)}/diff?from=${query(from)}&to=${query(to)}`),
  saveToLibrary: (body) => isMock() ? mock.saveToLibrary(body) : request('/library', { method: 'POST', data: body }),
  summarize: (sessionId) => isMock() ? mock.summarize(sessionId) : request(`/sessions/${query(sessionId)}/summarize`, { method: 'POST', data: {} }),
  renderReport: (sessionId, messageId) => isMock() ? Promise.resolve({}) : request(`/sessions/${query(sessionId)}/messages/${query(messageId)}/report`, { method: 'POST', data: {} }),
  credits: () => isMock() ? mock.credits() : request('/me/credits'),
  myCredits: () => isMock() ? mock.credits() : request('/me/credits'),
  prescriptions: () => isMock() ? mock.prescriptions() : request('/prescriptions'),
  prescriptionAction: (id, action) => isMock() ? mock.prescriptionAction(id, action) : request(`/prescriptions/${query(id)}/${query(action)}`, { method: 'POST', data: {} }),
  chart: () => isMock() ? mock.chart() : request('/profile/chart'),
  myChart: () => isMock() ? mock.chart() : request('/profile/chart'),
  saveBazi: (body) => isMock() ? mock.saveBazi(body) : request('/profile/bazi', { method: 'PUT', data: body }),
  chartReport: () => isMock() ? mock.chartReport() : request('/profile/chart/report'),
  myChartReport: () => isMock() ? mock.chartReport() : request('/profile/chart/report'),
  strategicProfile: () => isMock() ? Promise.resolve({ strategic: null }) : request('/profile/strategic'),
  memories: (agentKey, q) => {
    const parts = [];
    if (agentKey) parts.push(`agentKey=${query(agentKey)}`);
    if (q) parts.push(`q=${query(q)}`);
    return isMock() ? Promise.resolve([]) : request(`/memories${parts.length ? `?${parts.join('&')}` : ''}`);
  },
  memoryLibrary: () => isMock() ? Promise.resolve({ sections: [] }) : request('/me/memory-library'),
  deleteMemory: (id) => isMock() ? Promise.resolve({ ok: true }) : request(`/memories/${query(id)}`, { method: 'DELETE' }),
  updateMemory: (id, text) => isMock() ? Promise.resolve({ ok: true }) : request(`/memories/${query(id)}`, { method: 'PATCH', data: { text } }),
  dossier: () => isMock() ? mock.dossier() : request('/me/dossier'),
  generateDossier: () => isMock() ? mock.generateDossier() : request('/me/dossier/generate', { method: 'POST', data: {}, timeout: 180000 }),
  prophecies: () => isMock() ? mock.prophecies() : request('/prophecies'),
  verifyDecision: (id, outcome, note) => isMock() ? mock.verifyDecision(id, outcome, note) : request(`/decisions/${query(id)}/verify`, { method: 'POST', data: { outcome, note } }),
  verifyProphecy: (id, outcome, note) => isMock() ? mock.verifyProphecy(id, outcome, note) : request(`/prophecies/${query(id)}/verify`, { method: 'POST', data: { outcome, note } }),
  disputeDecision: (id, dispute) => isMock() ? mock.disputeDecision(id, dispute) : request(`/decisions/${query(id)}`, { method: 'PATCH', data: { dispute } }),
  disputeProphecy: (id, dispute) => isMock() ? mock.disputeProphecy(id, dispute) : request(`/prophecies/${query(id)}`, { method: 'PATCH', data: { dispute } }),
  bizMetricTemplate: () => isMock() ? mock.bizMetricTemplate() : request('/biz-metrics/template'),
  bizMetricSeries: (weeks) => isMock() ? mock.bizMetricSeries(weeks) : request(`/biz-metrics?weeks=${query(weeks || 8)}`),
  saveBizMetrics: (weekStart, metrics) => isMock() ? mock.saveBizMetrics(weekStart, metrics) : request(`/biz-metrics/${query(weekStart)}`, { method: 'PUT', data: { metrics } }),
  brandKit: () => isMock() ? mock.brandKit() : request('/brand-kit'),
  generateBrandKit: () => isMock() ? mock.generateBrandKit() : request('/brand-kit/generate', { method: 'POST', data: {}, timeout: 180000 }),
  approveBrandKit: () => isMock() ? Promise.resolve({ ok: true }) : request('/brand-kit/approve', { method: 'POST', data: {} }),
  fateCardPreview: (body) => isMock() ? mock.fateCardPreview(body) : request('/cards/fate/preview', { method: 'POST', data: body, timeout: 180000 }),
  dailyBattleReport: () => isMock() ? mock.dailyBattleReport() : request('/cards/daily'),
  creativeStatus: () => isMock() ? mock.creativeStatus() : request('/creative/status'),
  posterBriefDraft: (sessionId, messageId) => {
    const qs = [];
    if (sessionId) qs.push(`sessionId=${query(sessionId)}`);
    if (messageId) qs.push(`messageId=${query(messageId)}`);
    // 180s：这条是「等模型」的接口，不是普通读接口。服务端 structured() 最多跑两轮
    // （首轮 + 校验失败后的纠错轮），每轮吃满 OPENAI_TIMEOUT_MS(60s) 就是 120s 才回落到
    // 确定性预填。默认的 30s 会让端上先放手 —— 用户看到「军师响应超时」，而服务端其实
    // 再等一会儿就会给出一份填好的需求单（2026-08-17 生产实测：典型 24s，偶发超 60s）。
    // 长时间转圈不算问题：这一页本来就有「正在整理需求单 / 通常要几秒」的说明态。
    return isMock() ? mock.posterBriefDraft(sessionId, messageId) : request(`/creative/posters/brief-draft${qs.length ? `?${qs.join('&')}` : ''}`, { timeout: 180000 });
  },
  uploadCreativeAsset: (filePath, role) => isMock() ? Promise.resolve({ id: `mock-asset-${Date.now()}`, role }) : upload(`/creative/uploads?role=${query(role)}`, filePath, {}, { name: 'file' }),
  createPosterJob: (body) => isMock() ? mock.createPosterJob(body) : request('/creative/posters', { method: 'POST', data: body }),
  creativeJob: (id) => isMock() ? mock.creativeJob(id) : request(`/creative/jobs/${query(id)}`),
  reviseJob: (id, body) => isMock() ? mock.reviseJob(id, body) : request(`/creative/jobs/${query(id)}/revise`, { method: 'POST', data: body }),
  regenerateJob: (id, body) => isMock() ? mock.regenerateJob(id, body) : request(`/creative/jobs/${query(id)}/regenerate`, { method: 'POST', data: body }),
  cancelJob: (id) => isMock() ? mock.cancelJob(id) : request(`/creative/jobs/${query(id)}/cancel`, { method: 'POST', data: {} }),
  creativePosters: (cursor, limit) => isMock() ? mock.creativePosters(cursor, limit) : request(`/creative/posters?limit=${limit || 20}${cursor ? `&cursor=${query(cursor)}` : ''}`),
  // 成片作品索引（GET /video/works → ClipWork[]，**裸数组不是 {items}**，见 server/src/routes/video.ts）。
  // 锦囊作品页要跨来源混排，需要一条与主包 api 同层的通道；快出片分包自己那份 api（packages/video/api.js）
  // 走 host.js 的独立请求栈，主包页面不该反向依赖分包代码，故在此单独登记一条。
  // 12s：服务端对这条的上游预算是 10s（见 routes/video.ts），端上略长一点兜住网络抖动，
  // 但绝不用默认的 30s——作品页是一级 tab，等 30s 等于把这一格挂在那里。
  videoWorks: () => isMock() ? mock.videoWorks() : request('/video/works', { timeout: 12000 }),
  casefile: () => isMock() ? mock.casefile() : request('/casefile'),
  addOrder: (text) => isMock() ? mock.addOrder(text) : request('/casefile/orders', { method: 'POST', data: { text } }),
  toggleOrder: (id) => isMock() ? mock.toggleOrder(id) : request(`/casefile/orders/${query(id)}`, { method: 'PATCH', data: {} }),
  setOrderResult: (id, resultNote) => isMock() ? mock.toggleOrder(id, { resultNote }) : request(`/casefile/orders/${query(id)}`, { method: 'PATCH', data: { resultNote } }),
  removeOrder: (id) => isMock() ? mock.removeOrder(id) : request(`/casefile/orders/${query(id)}`, { method: 'DELETE' }),
  saveBackfill: (values) => isMock() ? mock.saveBackfill(values) : request('/casefile/backfill', { method: 'PUT', data: values }),
  saveGoals: (patch) => isMock() ? mock.saveGoals(patch) : request('/casefile/goals', { method: 'PUT', data: patch }),
  reviewCasefile: (layer) => isMock() ? mock.reviewCasefile(layer) : request('/casefile/review', { method: 'POST', data: { layer } }),

  /**
   * 客户端埋点（POST /events）：fire-and-forget，失败**完全静默**——不 toast、不 reject、不阻塞主流程。
   *
   * ★ 刻意不走 request()：那条路径上「带 token 的 401」会 clearToken + 触发全局 onAuthLost
   * （清登录态 + 「登录态已失效」提示 + reLaunch 回问策）。埋点是背景动作，绝不能因为一条统计请求
   * 把用户从正在打字的对话里踢出去；token 失效时宁可丢事件，也不许打断用户。
   * 游客照发（服务端 userId 为空），这是漏斗分母的来源。
   */
  track: (name, props) => {
    try {
      if (!name) return;
      if (isMock()) { mock.track(name, props); return; }
      const token = getToken();
      wx.request({
        url: `${getApiBaseUrl()}/events`,
        method: 'POST',
        data: { name, props: props || {} },
        header: Object.assign({ 'content-type': 'application/json' }, token ? { 'x-user-id': token } : {}),
        timeout: 8000,
        success() { /* 埋点没有回执可用 */ },
        fail() { /* 静默：断网/超时都不该被用户看见 */ },
      });
    } catch (_) { /* 连 wx.request 都抛了也不许冒泡 */ }
  },
};

module.exports = { api, isMock };
