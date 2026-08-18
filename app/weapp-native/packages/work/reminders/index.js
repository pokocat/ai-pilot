const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { gotoExecution } = require('../../../services/nav');
const { withShare } = require('../../../services/share');

Page(withShare({
  data: baseData({ loading: true, errorText: '', items: [], busy: '', showLogin: false }),
  onLoad() { this.load(); },
  onShow() { this.setData({ themeClass: store.snapshot().themeClass }); if (this._loaded) this.load(); },
  back() { wx.navigateBack({ fail: () => gotoExecution('today') }); },
  closeLogin() { this.setData({ showLogin: false }); }, loggedIn() { this.setData({ showLogin: false }); this.load(); },
  async load() {
    if (!store.isAuthed()) { this.setData({ loading: false, showLogin: true }); return; }
    if (!this._loaded) this.setData({ loading: true });
    try {
      const [view, templates] = await Promise.all([api.reminders(), api.wechatSubscribeTemplates().catch(() => ({ scenes: [] }))]);
      this._templates = templates.scenes || []; this._items = view.items || []; this._loaded = true;
      this.setData({ loading: false, errorText: '', items: this._items.map((item) => Object.assign({}, item, { actionText: item.subscribed ? '已订阅' : item.canSubscribe ? '订阅' : '暂不可订阅', stateClass: item.subscribed ? 'done' : item.canSubscribe ? 'action' : 'muted' })) });
    } catch (error) { const kind = store.handleApiError(error, { silent: true }); this._loaded = true; this.setData({ loading: false, errorText: kind === 'unauthorized' ? '' : (error.message || '提醒读取失败'), showLogin: kind === 'unauthorized' }); }
  },
  retry() { this.load(); },
  subscribe(event) {
    const key = event.currentTarget.dataset.key; const item = (this._items || []).find((entry) => entry.key === key); if (!item || this.data.busy) return;
    if (item.subscribed) { wx.showToast({ title: '已订阅一次提醒', icon: 'none' }); return; }
    if (!item.canSubscribe) { wx.showToast({ title: '提醒模板尚未配置', icon: 'none' }); return; }
    const template = (this._templates || []).find((entry) => entry.scene === item.scene);
    if (!template || !template.templateId) { wx.showToast({ title: '模板刚刚补热，请再点一次', icon: 'none' }); this.load(); return; }
    this.setData({ busy: key });
    wx.requestSubscribeMessage({ tmplIds: [template.templateId], success: async (result) => {
      const status = result[template.templateId] || 'reject';
      try { await api.recordWechatSubscription([{ scene: item.scene, templateId: template.templateId, status }]); wx.showToast({ title: status === 'accept' ? '已订阅一次提醒' : '未订阅提醒', icon: 'none' }); await this.load(); }
      catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '订阅记录失败' }); }
      finally { this.setData({ busy: '' }); }
    }, fail: () => { this.setData({ busy: '' }); wx.showToast({ title: '订阅没有完成', icon: 'none' }); } });
  },
}));
