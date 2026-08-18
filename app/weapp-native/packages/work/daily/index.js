const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { gotoExecution } = require('../../../services/nav');

function today() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function dateLabel(value) { const parts = String(value || today()).split('-'); return `${Number(parts[1]) || 1}月${Number(parts[2]) || 1}日`; }
function normalize(raw) {
  const orders = (raw.orders || (raw.actions || []).map((text, index) => ({ id: `action-${index}`, text, done: false, aligned: null }))).map((item) => Object.assign({}, item, { showAligned: item.aligned !== null && item.aligned !== undefined }));
  const done = raw.done == null ? orders.filter((item) => item.done).length : Number(raw.done);
  const total = raw.total == null ? orders.length : Number(raw.total);
  return Object.assign({}, raw, { dateText: dateLabel(raw.date), rank: raw.rank || '初入局', streak: Number(raw.streak) || 0, done, total, alignText: raw.alignRate == null ? '—' : `${raw.alignRate}%`, backfillText: raw.backfill ? '已回填' : '未回填', orders, quote: raw.quote || raw.judgement || '先把最重要的一件事做深，再让数据修正明天的判断。' });
}

Page({
  data: baseData({ loading: true, errorText: '', report: null, showLogin: false }),
  onLoad() { this.load(); },
  onShow() { this.setData({ themeClass: store.snapshot().themeClass }); },
  back() { wx.navigateBack({ fail: () => gotoExecution('today') }); },
  closeLogin() { this.setData({ showLogin: false }); }, loggedIn() { this.setData({ showLogin: false }); this.load(); },
  async load() {
    if (!store.isAuthed()) { this.setData({ loading: false, showLogin: true }); return; }
    this.setData({ loading: true, errorText: '' });
    try { const raw = await api.dailyBattleReport(); this.setData({ loading: false, report: normalize(raw) }); }
    catch (error) { const kind = store.handleApiError(error, { silent: true }); this.setData({ loading: false, errorText: kind === 'unauthorized' ? '' : (error.message || '每日战报读取失败'), showLogin: kind === 'unauthorized' }); }
  },
  retry() { this.load(); },
});
