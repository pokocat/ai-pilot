const mock = require('./mock');
const { request, upload } = require('./request');
const { getImpersonationBaseUrl, useMockApi } = require('./runtime-mode');

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
  session: (id) => isMock() ? mock.session(id) : request(`/sessions/${query(id)}`),
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
    return isMock() ? mock.posterBriefDraft(sessionId, messageId) : request(`/creative/posters/brief-draft${qs.length ? `?${qs.join('&')}` : ''}`);
  },
  uploadCreativeAsset: (filePath, role) => isMock() ? Promise.resolve({ id: `mock-asset-${Date.now()}`, role }) : upload(`/creative/uploads?role=${query(role)}`, filePath, {}, { name: 'file' }),
  createPosterJob: (body) => isMock() ? mock.createPosterJob(body) : request('/creative/posters', { method: 'POST', data: body }),
  creativeJob: (id) => isMock() ? mock.creativeJob(id) : request(`/creative/jobs/${query(id)}`),
  reviseJob: (id, body) => isMock() ? mock.reviseJob(id, body) : request(`/creative/jobs/${query(id)}/revise`, { method: 'POST', data: body }),
  regenerateJob: (id, body) => isMock() ? mock.regenerateJob(id, body) : request(`/creative/jobs/${query(id)}/regenerate`, { method: 'POST', data: body }),
  cancelJob: (id) => isMock() ? mock.cancelJob(id) : request(`/creative/jobs/${query(id)}/cancel`, { method: 'POST', data: {} }),
  creativePosters: (cursor, limit) => isMock() ? mock.creativePosters(cursor, limit) : request(`/creative/posters?limit=${limit || 20}${cursor ? `&cursor=${query(cursor)}` : ''}`),
  casefile: () => isMock() ? mock.casefile() : request('/casefile'),
  addOrder: (text) => isMock() ? mock.addOrder(text) : request('/casefile/orders', { method: 'POST', data: { text } }),
  toggleOrder: (id) => isMock() ? mock.toggleOrder(id) : request(`/casefile/orders/${query(id)}`, { method: 'PATCH', data: {} }),
  setOrderResult: (id, resultNote) => isMock() ? mock.toggleOrder(id, { resultNote }) : request(`/casefile/orders/${query(id)}`, { method: 'PATCH', data: { resultNote } }),
  removeOrder: (id) => isMock() ? mock.removeOrder(id) : request(`/casefile/orders/${query(id)}`, { method: 'DELETE' }),
  saveBackfill: (values) => isMock() ? mock.saveBackfill(values) : request('/casefile/backfill', { method: 'PUT', data: values }),
  saveGoals: (patch) => isMock() ? mock.saveGoals(patch) : request('/casefile/goals', { method: 'PUT', data: patch }),
  reviewCasefile: (layer) => isMock() ? mock.reviewCasefile(layer) : request('/casefile/review', { method: 'POST', data: { layer } }),
};

module.exports = { api, isMock };
