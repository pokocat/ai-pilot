const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');

function rows(view) {
  if (!view) return [];
  const row = (label, value) => value ? { label, value, chips: false } : null;
  const chips = (label, values) => values && values.length ? { label, values, chips: true } : null;
  return [
    { title: 'IP 人设', rows: [row('名称', view.persona.name), row('定位', view.persona.tagline), row('语气', view.persona.tone), row('来历', view.persona.story), chips('禁忌', view.persona.doNots)].filter(Boolean) },
    { title: '话术库', rows: [chips('钩子', view.voice.hooks), chips('开场', view.voice.openers), chips('号召', view.voice.ctas), chips('禁忌', view.voice.taboos)].filter(Boolean) },
    { title: '视觉调性', rows: [chips('关键词', view.theme.keywords), row('主色', view.theme.colorHint), chips('风格', view.theme.styleRefs)].filter(Boolean) },
  ];
}

Page({
  data: baseData({ brandKit: null, sections: [], busy: '', loading: true, showLogin: false }),
  onLoad() { if (!store.isAuthed()) this.setData({ loading: false, showLogin: true }); else this.load(); },
  back() { wx.navigateBack(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
  async load() {
    this.setData({ loading: true });
    try { const brandKit = await api.brandKit(); this.setData({ brandKit, sections: rows(brandKit), loading: false }); }
    catch (error) { const kind = store.handleApiError(error, { silent: true }); this.setData({ loading: false, showLogin: kind === 'unauthorized' }); }
  },
  async generate() {
    if (this.data.busy) return;
    this.setData({ busy: 'gen' });
    try { const brandKit = await api.generateBrandKit(); this.setData({ brandKit, sections: rows(brandKit) }); }
    catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '品牌资产生成失败' }); }
    finally { this.setData({ busy: '' }); }
  },
  async approve() {
    if (this.data.busy || !this.data.brandKit) return;
    this.setData({ busy: 'appr' });
    try { await api.approveBrandKit(); this.setData({ 'brandKit.approved': true }); }
    catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '确认失败' }); }
    finally { this.setData({ busy: '' }); }
  },
});
