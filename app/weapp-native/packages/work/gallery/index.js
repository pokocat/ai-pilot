const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { navTo } = require('../../../services/nav');
const { normalizeStatus, absoluteCreativeUrl, progressText, formatTime, isInFlight } = require('../poster/creative');

const PAGE_SIZE = 20;
const POLL_MS = 6000;

function normalizeItems(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    jobId: String(item.jobId || item.id || ''),
    status: item.status,
    inFlight: isInFlight(item.status),
    progressLabel: progressText(item.progress),
    imageUrl: absoluteCreativeUrl(item.poster && (item.poster.previewUrl || item.poster.downloadUrl)),
    headline: String(item.headline || item.title || '未命名海报'),
    timeText: formatTime(item.createdAt),
    parentJobId: String(item.parentJobId || ''),
  })).filter((item) => item.jobId);
}

Page({
  data: baseData({
    items: [], cursor: '', loading: true, failed: false, more: false,
    canCreate: false, showLogin: false,
  }),

  onLoad() {
    this._timer = null;
    this._paged = false;
    this._urlRetryAt = 0;
    this._loadingFirst = false;
    this._shown = false;
    if (!store.isAuthed()) { this.setData({ loading: false, showLogin: true }); return; }
    this.loadStatus();
    this.loadFirst();
  },
  onShow() {
    if (!this._shown) { this._shown = true; return; }
    if (store.isAuthed() && !this._loadingFirst) this.loadFirst({ silent: this.data.items.length > 0 });
  },
  onHide() { this.clearTimer(); },
  onUnload() { this.clearTimer(); },

  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/pouch/index' }) }); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.loadStatus(); this.loadFirst(); },

  clearTimer() { if (this._timer) clearTimeout(this._timer); this._timer = null; },
  schedulePoll(items) {
    this.clearTimer();
    if (this._paged || !items.some((item) => item.inFlight)) return;
    this._timer = setTimeout(() => this.loadFirst({ silent: true }), POLL_MS);
  },

  async loadStatus() {
    try { const status = normalizeStatus(await api.creativeStatus()); this.setData({ canCreate: status.enabled }); }
    catch (_) { this.setData({ canCreate: false }); }
  },

  async loadFirst(options) {
    const opts = options || {};
    if (this._loadingFirst) return;
    this._loadingFirst = true;
    if (!opts.silent) this.setData({ loading: true, failed: false });
    try {
      const result = await api.creativePosters('', PAGE_SIZE);
      const items = normalizeItems(result && result.items || result);
      this._paged = false;
      this.setData({ items, cursor: String(result && result.nextCursor || ''), loading: false, failed: false });
      this.schedulePoll(items);
    } catch (error) {
      this.setData({ loading: false, failed: true });
      store.handleApiError(error, { silent: true });
    } finally { this._loadingFirst = false; }
  },

  async loadMore() {
    if (this.data.more || !this.data.cursor) return;
    this.setData({ more: true });
    try {
      const result = await api.creativePosters(this.data.cursor, PAGE_SIZE);
      const incoming = normalizeItems(result && result.items || result);
      const seen = new Set(this.data.items.map((item) => item.jobId));
      const items = this.data.items.concat(incoming.filter((item) => !seen.has(item.jobId)));
      this._paged = true; this.clearTimer();
      this.setData({ items, cursor: String(result && result.nextCursor || '') });
    } catch (error) { store.handleApiError(error, { fallbackTitle: '没能加载更多，请重试' }); }
    finally { this.setData({ more: false }); }
  },

  imageError() {
    if (Date.now() - this._urlRetryAt < 30000) return;
    this._urlRetryAt = Date.now();
    this.loadFirst({ silent: true });
  },
  openJob(event) {
    const jobId = String(event.currentTarget.dataset.id || '');
    if (jobId) navTo(`/packages/work/posterJob/index?jobId=${encodeURIComponent(jobId)}`);
  },
  goLibrary() { navTo('/packages/work/library/index'); },
  /**
   * 空态 CTA。原先 `switchTab` 回锦囊 —— 而锦囊的海报格当时又指回本页，
   * 零作品的人在「锦囊 → 空作品库 → 去锦囊挑手艺 → 锦囊」里打转，全站没有一个按钮
   * 能把他带到真正开工的地方；空态**文案**还写着「在对话里让海报设计师出方案」，
   * 说的和按钮做的是两件事。现在直接进确认页（与锦囊海报格同一个落点）。
   */
  goPosterDesigner() { navTo('/packages/work/poster/index'); },
});
