const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { navTo } = require('../../../services/nav');
const ICONS = new Set(['home', 'grid', 'agent', 'user', 'chat', 'insight', 'mic', 'attach', 'send', 'arrow', 'up', 'plus', 'chevron', 'alert', 'trend', 'check', 'target', 'layers', 'doc', 'image', 'video', 'pen', 'spark', 'chart', 'clock', 'flow', 'bolt', 'shield', 'crown', 'flag', 'token', 'pouch', 'upload', 'lock', 'diamond', 'phone', 'wechat']);

function fmt(iso) {
  const date = new Date(iso);
  if (!date.getTime()) return '';
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

Page({
  data: baseData({ loading: true, errorText: '', items: [], showLogin: false }),
  onLoad() { this.load(); },
  onShow() { this.setData({ themeClass: store.snapshot().themeClass }); if (this._loaded) this.load(); },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) }); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
  async load() {
    if (!store.isAuthed()) { this.setData({ loading: false, showLogin: true }); return; }
    this.setData({ loading: true, errorText: '' });
    try {
      const rows = await api.library();
      this._items = rows || [];
      this._loaded = true;
      this.setData({ loading: false, items: this._items.map((item) => ({
        id: item.id, title: item.title || '未命名方案', agentName: item.agentName || '军师参谋部', atText: fmt(item.at),
        icon: ICONS.has(item.content && item.content.icon) ? item.content.icon : 'doc', hasVersion: Boolean(item.reportId && item.version), version: item.version || '',
      })) });
    } catch (error) {
      const kind = store.handleApiError(error, { silent: true });
      this.setData({ loading: false, errorText: kind === 'unauthorized' ? '' : (error.message || '方案库读取失败'), showLogin: kind === 'unauthorized' });
    }
  },
  retry() { this.load(); },
  open(event) {
    const item = this._items && this._items[Number(event.currentTarget.dataset.index)];
    if (!item) return;
    if (item.reportId) navTo(`/packages/work/report/index?id=${encodeURIComponent(item.reportId)}`);
    else if (item.sessionId) navTo(`/packages/main/chat/index?sessionId=${encodeURIComponent(item.sessionId)}`);
    else navTo(`/packages/main/chat/index?agentKey=${encodeURIComponent(item.agentKey || 'general')}&continue=1`);
  },
  goChat() { wx.switchTab({ url: '/pages/sessions/index' }); },
});
