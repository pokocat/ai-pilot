const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { navTo } = require('../../../services/nav');
const ICONS = new Set(['home', 'grid', 'agent', 'user', 'chat', 'insight', 'attach', 'trend', 'check', 'target', 'layers', 'doc', 'image', 'video', 'pen', 'spark', 'chart', 'clock', 'flow', 'bolt', 'shield', 'crown', 'flag', 'token', 'pouch', 'upload', 'lock', 'diamond']);

function fmt(iso) { const date = new Date(iso); return date.getTime() ? `${date.getMonth() + 1}月${date.getDate()}日` : ''; }
function kindLabel(kind) { return { insight: '洞察', document: '资料', decision: '决策', todo: '待办', report_ref: '方案' }[kind] || '资料'; }
function mapDetail(raw) {
  return Object.assign({}, raw, {
    counts: Object.assign({ sessions: 0, reports: 0, knowledge: 0 }, raw.counts || {}),
    sessions: (raw.sessions || []).map((item) => Object.assign({}, item, { icon: ICONS.has(item.agentIcon) ? item.agentIcon : 'chat' })),
    reports: (raw.reports || []).map((item) => Object.assign({}, item, { updatedText: fmt(item.updatedAt) })),
    knowledge: (raw.knowledge || []).map((item) => Object.assign({}, item, { kindText: kindLabel(item.kind) })),
  });
}

Page({
  data: baseData({ loading: true, failed: false, detail: null, tab: 'situation', knowledgeText: '', knowledgeBusy: false, showLogin: false }),
  onLoad(options) { this._id = options && options.id || ''; this.load(); },
  onShow() { this.setData({ themeClass: store.snapshot().themeClass }); if (this._loaded) this.load(); },
  back() { wx.navigateBack({ fail: () => navTo('/packages/work/projects/index') }); },
  closeLogin() { this.setData({ showLogin: false }); }, loggedIn() { this.setData({ showLogin: false }); this.load(); },
  async load() {
    if (!this._id) { this.setData({ loading: false, failed: true }); return; }
    if (!store.isAuthed()) { this.setData({ loading: false, showLogin: true }); return; }
    this.setData({ loading: !this._loaded, failed: false });
    try { const raw = await api.project(this._id); this._loaded = true; this.setData({ loading: false, failed: false, detail: mapDetail(raw) }); }
    catch (error) { const kind = store.handleApiError(error, { silent: true }); this.setData({ loading: false, failed: kind !== 'unauthorized', detail: null, showLogin: kind === 'unauthorized' }); }
  },
  retry() { this.load(); },
  setTab(event) { this.setData({ tab: event.currentTarget.dataset.tab }); },
  startChat() { navTo(`/packages/main/chat/index?projectId=${encodeURIComponent(this._id)}&fresh=1`); },
  goStudio() { wx.switchTab({ url: '/pages/studio/index' }); },
  openSession(event) { navTo(`/packages/main/chat/index?sessionId=${encodeURIComponent(event.currentTarget.dataset.id)}`); },
  openReport(event) { navTo(`/packages/work/report/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}`); },
  openKnowledge(event) { navTo(`/packages/work/knowledge/detail/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}`); },
  inputKnowledge(event) { this.setData({ knowledgeText: event.detail.value }); },
  async addKnowledge() {
    const text = String(this.data.knowledgeText || '').trim(); if (!text || this.data.knowledgeBusy) return;
    this.setData({ knowledgeBusy: true });
    try { await api.createKnowledge({ text, projectId: this._id, kind: 'document', sourceType: 'manual' }); this.setData({ knowledgeText: '' }); await this.load(); wx.showToast({ title: '已加入知识库', icon: 'none' }); }
    catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '知识保存失败' }); }
    finally { this.setData({ knowledgeBusy: false }); }
  },
});
