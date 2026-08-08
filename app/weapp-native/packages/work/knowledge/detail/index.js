const { api } = require('../../../../services/api');
const store = require('../../../../services/store');
const { baseData } = require('../../../../services/page');
const { navTo } = require('../../../../services/nav');

const STATUS = { ready: '就绪', parsing: '解析中', embedding: '嵌入中', failed: '失败', pending: '排队' };
const POLL_DELAYS = [2000, 4000, 8000, 8000, 8000];
const isSettled = (status) => status === 'ready' || status === 'failed';
function fmtSize(bytes) { const value = Number(bytes) || 0; if (!value) return ''; if (value < 1024) return `${value}B`; if (value < 1048576) return `${Math.round(value / 1024)}KB`; return `${(value / 1048576).toFixed(1)}MB`; }
function cleanName(value) { const name = String(value || '').trim(); if (!name || /^(tmp_|wxfile:|file:|blob:|undefined$|null$)/i.test(name) || /^(上传资料(?:\s*\d+)?|未命名(?:文件|资料)?|待识别资料)$/i.test(name) || /^(founder|company|finance|content|growth|customer|proof|unknown)资料$/i.test(name)) return ''; return name; }

Page({
  data: baseData({ loading: true, failed: false, showLogin: false, detail: null, preview: '', expanded: false, longPreview: false, busy: false, pollHint: false }),
  onLoad(options) { this._id = options && options.id || ''; this._attempt = 0; this.load(); },
  onShow() { this.setData({ themeClass: store.snapshot().themeClass }); },
  onHide() { this.clearPoll(); }, onUnload() { this.clearPoll(); },
  onPullDownRefresh() { this._attempt = 0; this.setData({ pollHint: false }); this.load().finally(() => wx.stopPullDownRefresh()); },
  back() { wx.navigateBack({ fail: () => navTo('/packages/work/knowledge/index') }); },
  closeLogin() { this.setData({ showLogin: false }); }, loggedIn() { this.setData({ showLogin: false }); this.load(); },
  clearPoll() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } },
  async load() {
    if (!this._id) { this.setData({ loading: false, failed: true }); return; }
    if (!store.isAuthed()) { this.setData({ loading: false, showLogin: true }); return; }
    this.setData({ loading: !this.data.detail, failed: false });
    try {
      const raw = await api.knowledgeDetail(this._id); this._raw = raw;
      const title = cleanName(raw.fileName) || cleanName(raw.title) || '待识别资料';
      const meta = [STATUS[raw.status] || raw.status, `${(raw.chunks || []).length} 切片`, raw.fileType ? String(raw.fileType).toUpperCase() : '', raw.fileSize ? fmtSize(raw.fileSize) : '', raw.error || ''].filter(Boolean).join(' · ');
      const full = String(raw.textPreview || ''); const longPreview = full.length > 600;
      this.setData({ loading: false, detail: { id: raw.id, title, meta, status: raw.status, canAnalyze: Boolean(raw.canAnalyze), settled: isSettled(raw.status) }, fullPreview: full, longPreview, preview: longPreview && !this.data.expanded ? `${full.slice(0, 600)}…` : full });
      this.clearPoll();
      if (isSettled(raw.status)) { this._attempt = 0; this.setData({ pollHint: false }); return; }
      if (this._attempt >= POLL_DELAYS.length) { this.setData({ pollHint: true }); return; }
      this._timer = setTimeout(() => this.load(), POLL_DELAYS[this._attempt++]);
    } catch (error) {
      const kind = store.handleApiError(error, { silent: true });
      this.setData({ loading: false, failed: kind !== 'unauthorized', showLogin: kind === 'unauthorized' });
    }
  },
  retry() { this._attempt = 0; this.load(); },
  togglePreview() { const expanded = !this.data.expanded; const full = this.data.fullPreview || ''; this.setData({ expanded, preview: expanded ? full : `${full.slice(0, 600)}…` }); },
  async analyze() {
    if (this.data.busy || !this._raw) return;
    this.setData({ busy: true });
    try { const result = await api.analyzeKnowledge(this._raw.id); navTo(`/packages/work/report/index?id=${encodeURIComponent(result.reportId)}`); }
    catch (error) {
      const code = String(error.code || error.data && error.data.code || '');
      if (code === 'SKU_REQUIRED') { this.offerSku(); return; }
      if (code === 'RATE_LIMITED') { wx.showToast({ title: '今天的体检次数用完了（每日 3 次），明天再来', icon: 'none' }); return; }
      if (code === 'NOT_ANALYZABLE') { wx.showToast({ title: '这份资料看着不像财务表，换一份试试', icon: 'none' }); return; }
      store.handleApiError(error, { fallbackTitle: '经营体检暂时没跑成功，请稍后再试' });
    } finally { this.setData({ busy: false }); }
  },
  offerSku() {
    wx.showModal({ title: '开通经营体检', content: '开通后可反复让军师过账，逐月体检经营数字。是否继续查看微信支付确认？', confirmText: '继续开通', success: (result) => { if (result.confirm) this.buySku(); } });
  },
  async buySku() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const order = await api.createSkuOrder('fin-checkup', undefined, { source: 'catalog' });
      if (order.payParams && !order.mock) await new Promise((resolve, reject) => wx.requestPayment(Object.assign({}, order.payParams, { success: resolve, fail: reject })));
      if (order.mock && order.orderId && !order.appliedAt) await api.payMock(order.orderId);
      const state = order.appliedAt ? 'applied' : await this.waitPaymentApplied(order.orderId);
      if (state === 'applied') {
        await store.loadMe().catch(() => {});
        wx.showToast({ title: order.mock ? '经营体检已开通（测试期模拟支付）' : '经营体检已开通', icon: 'none' });
        this.setData({ busy: false });
        setTimeout(() => this.analyze(), 0);
      } else if (state === 'failed') {
        wx.showToast({ title: '订单未完成，请重新开通经营体检', icon: 'none' });
      } else {
        wx.showToast({ title: '支付结果待确认，权益到账后再试经营体检', icon: 'none' });
      }
    } catch (error) { if (!/cancel/i.test(String(error.errMsg || error.message || ''))) wx.showToast({ title: error.message || '支付没有完成', icon: 'none' }); }
    finally { this.setData({ busy: false }); }
  },
  async waitPaymentApplied(outTradeNo) {
    if (!outTradeNo) return 'pending';
    for (let index = 0; index < 5; index += 1) {
      try {
        const status = await api.paymentStatus(outTradeNo);
        if (status.appliedAt || status.status === 'applied') return 'applied';
        if (['failed', 'closed', 'refunded'].includes(status.status)) return 'failed';
      } catch (_) { /* 查询失败继续确认，最终按 pending 提示。 */ }
      if (index < 4) await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return 'pending';
  },
});
