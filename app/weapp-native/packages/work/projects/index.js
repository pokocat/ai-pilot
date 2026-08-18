const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { navTo } = require('../../../services/nav');
const { withShare } = require('../../../services/share');
const ICONS = new Set(['home', 'grid', 'agent', 'user', 'chat', 'insight', 'attach', 'trend', 'check', 'target', 'layers', 'doc', 'image', 'video', 'pen', 'spark', 'chart', 'clock', 'flow', 'bolt', 'shield', 'crown', 'flag', 'token', 'pouch', 'upload', 'lock', 'diamond']);

Page(withShare({
  data: baseData({ loading: true, items: [], creating: false, newName: '', busy: false, errorText: '', showLogin: false }),
  onLoad() { this.load(); },
  onShow() { this.setData({ themeClass: store.snapshot().themeClass }); if (this._loaded) this.load(); },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) }); },
  closeLogin() { this.setData({ showLogin: false }); }, loggedIn() { this.setData({ showLogin: false }); this.load(); },
  toggleCreate() { this.setData({ creating: !this.data.creating }); },
  inputName(event) { this.setData({ newName: event.detail.value }); },
  async load() {
    if (!store.isAuthed()) { this.setData({ loading: false, showLogin: true }); return; }
    if (!this._loaded) this.setData({ loading: true });
    try { const items = await api.projects(); this._loaded = true; this.setData({ loading: false, errorText: '', items: (items || []).map((item) => Object.assign({}, item, { icon: ICONS.has(item.icon) ? item.icon : 'layers', counts: Object.assign({ sessions: 0, reports: 0, knowledge: 0 }, item.counts || {}) })) }); }
    catch (error) { const kind = store.handleApiError(error, { silent: true }); this._loaded = true; this.setData({ loading: false, errorText: kind === 'unauthorized' ? '' : (error.message || '案卷读取失败'), showLogin: kind === 'unauthorized' }); }
  },
  retry() { this.load(); },
  open(event) { navTo(`/packages/work/project/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}`); },
  async create() {
    const name = String(this.data.newName || '').trim(); if (!name || this.data.busy) return;
    this.setData({ busy: true });
    try { const result = await api.createProject({ name }); this.setData({ newName: '', creating: false }); await this.load(); navTo(`/packages/work/project/index?id=${encodeURIComponent(result.id)}`); }
    catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '创建案卷失败' }); }
    finally { this.setData({ busy: false }); }
  },
}));
