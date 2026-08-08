const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');

function normalizeReport(report) {
  if (!report) return null;
  return {
    ...report,
    sections: (report.sections || []).map((section) => ({
      ...section,
      blocks: (section.blocks || []).map((block, index) => ({
        ...block,
        key: `${section.key || section.no || 'section'}-${index}`,
        toneClass: `ds-hl-${block.tone || 'gold'}`,
        items: (block.items || []).map((item, itemIndex) => ({ ...item, key: `${index}-${itemIndex}` })),
      })),
    })),
  };
}

Page({
  data: baseData({ report: null, loading: false, ready: false, loadError: false, showLogin: false }),
  onLoad() {
    this._loading = false;
    if (!store.isAuthed()) { this.setData({ ready: true, showLogin: true }); return; }
    this.load();
  },
  onUnload() { this._dead = true; },
  back() { wx.navigateBack(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
  async load() {
    this.setData({ ready: false, loadError: false });
    try {
      const result = await api.dossier();
      if (this._dead) return;
      const report = normalizeReport(result && result.report);
      this.setData({ report, ready: true });
      if (!report) {
        const maturity = store.snapshot().me && store.snapshot().me.understanding && store.snapshot().me.understanding.maturity;
        if (maturity && maturity !== 'empty') this.generate(true);
      }
    } catch (error) {
      if (this._dead) return;
      const kind = store.handleApiError(error, { silent: true });
      this.setData({ ready: true, loadError: kind !== 'unauthorized', showLogin: kind === 'unauthorized' });
    }
  },
  async generate(allowBeforeReady) {
    if (this._loading || (!this.data.ready && !allowBeforeReady)) return;
    this._loading = true;
    this.setData({ loading: true, loadError: false });
    try {
      const result = await api.generateDossier();
      if (!this._dead) this.setData({ report: normalizeReport(result && result.report) });
    } catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '完整履历生成失败' }); }
    finally { this._loading = false; if (!this._dead) this.setData({ loading: false, ready: true }); }
  },
  primaryAction() {
    if (this.data.loadError) this.load();
    else this.generate(false);
  },
  regenerate() {
    if (this.data.loading) return;
    wx.showModal({ title: '刷新完整履历', content: '将重新执笔生成一份履历（会消耗一次额度），覆盖当前这份。确定刷新？', confirmText: '刷新', cancelText: '再想想', success: (result) => { if (result.confirm) this.generate(false); } });
  },
});
