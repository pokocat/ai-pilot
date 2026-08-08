const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const {
  LIMITS, STAGES, progressText, absoluteCreativeUrl, posterAsset, isInFlight,
  normalizeJob, normalizeStatus, newIdempotencyKey, clearPosterPendingByJob, fetchPosterFile,
} = require('../poster/creative');

const POLL_FAST_MS = 1200;
const POLL_SLOW_MS = 3000;
const POLL_FAST_WINDOW_MS = 30000;
const POLL_MAX_MS = 10 * 60 * 1000;

function emptyProofs() {
  return [0, 1, 2].map((index) => ({ index, label: `卖点 ${index + 1}`, value: '', count: `0/${LIMITS.proofPoint}`, over: false, err: '' }));
}

function count(value, max) {
  const size = String(value || '').trim().length;
  return { text: `${size}/${max}`, over: size > max };
}

function wxAsync(name, options) {
  return new Promise((resolve, reject) => {
    const method = wx[name];
    if (typeof method !== 'function') { reject(new Error(`当前微信版本不支持 ${name}`)); return; }
    method(Object.assign({}, options || {}, { success: resolve, fail: reject }));
  });
}

Page({
  data: baseData({
    jobId: '', loading: true, loadErr: '', showLogin: false, job: null,
    inFlight: false, succeeded: false, failed: false, cancelled: false, timedOut: false,
    stageItems: [], progressLabel: '', assetUrl: '', assetMissingText: '', canCancel: false, canRevise: false, canRegenerate: false,
    price: null, templates: [], panel: '', headline: '', cta: '', visual: '', templateKey: '',
    headlineCount: `0/${LIMITS.headline}`, ctaCount: `0/${LIMITS.cta}`, visualCount: `0/${LIMITS.visualDirection}`,
    headlineOver: false, ctaOver: false, visualOver: false, proofs: emptyProofs(), errors: {}, busy: '',
  }),

  onLoad(options) {
    this._timer = null;
    this._pollSeq = 0;
    this._urlRetryAt = 0;
    this._reviseKey = '';
    this._styleKey = '';
    const jobId = String(options && (options.jobId || options.id) || '');
    this.setData({ jobId });
    if (!store.isAuthed()) { this.setData({ loading: false, showLogin: true }); return; }
    this.loadStatus();
    this.reload();
  },

  onShow() {
    if (this.data.job && store.isAuthed()) this.reload({ silent: true });
  },
  onHide() { this.stopPolling(); },
  onUnload() { this.stopPolling(); },
  back() { wx.navigateBack({ fail: () => wx.navigateTo({ url: '/packages/work/gallery/index' }) }); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.loadStatus(); this.reload(); },

  async loadStatus() {
    try {
      const status = normalizeStatus(await api.creativeStatus());
      this.setData({ price: status.pricePerPoster, templates: status.templates });
    } catch (_) { /* 状态失败不阻断任务回看 */ }
  },

  stopPolling() {
    this._pollSeq += 1;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  },

  applyJob(raw) {
    const job = normalizeJob(raw);
    const asset = posterAsset(job);
    const inFlight = isInFlight(job.status);
    if (!inFlight) clearPosterPendingByJob(job.id);
    this.setData({
      job, inFlight,
      succeeded: job.status === 'succeeded', failed: job.status === 'failed', cancelled: job.status === 'cancelled',
      progressLabel: progressText(job.progress),
      stageItems: STAGES.map((stage, index) => ({ stage, label: progressText(stage), active: index <= Math.max(0, STAGES.indexOf(job.progress)) })),
      assetUrl: absoluteCreativeUrl(asset && (asset.previewUrl || asset.downloadUrl)),
      assetMissingText: job.assets.length ? '成品图链接已过期，点重试获取新链接。' : '本地演示任务没有图片文件，连接服务端后可查看真实成品。',
      canCancel: job.actions.includes('cancel'), canRevise: job.actions.includes('revise'), canRegenerate: job.actions.includes('regenerate'),
    });
    return job;
  },

  startPolling() {
    this.stopPolling();
    const startedAt = Date.now();
    const seq = ++this._pollSeq;
    const poll = async () => {
      if (seq !== this._pollSeq) return;
      try {
        const job = this.applyJob(await api.creativeJob(this.data.jobId));
        if (!isInFlight(job.status)) { this.stopPolling(); return; }
      } catch (error) {
        if (seq !== this._pollSeq) return;
        if (String(error && error.code || '') === 'UNAUTHORIZED') { this.stopPolling(); return; }
        if (String(error && error.code || '') === 'NOT_FOUND') { this.stopPolling(); this.setData({ loadErr: '这条出图任务已经找不到了。' }); return; }
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= POLL_MAX_MS) { this.stopPolling(); this.setData({ timedOut: true }); return; }
      this._timer = setTimeout(poll, elapsed < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS);
    };
    this._timer = setTimeout(poll, POLL_FAST_MS);
  },

  async reload(options) {
    const opts = options || {};
    if (!opts.silent) this._urlRetryAt = 0;
    if (!this.data.jobId) { this.setData({ loading: false, loadErr: '缺少任务编号。' }); return; }
    if (!opts.silent) this.setData({ loading: true, loadErr: '' });
    try {
      const job = this.applyJob(await api.creativeJob(this.data.jobId));
      this.setData({ loading: false, loadErr: '', timedOut: false });
      if (isInFlight(job.status)) this.startPolling(); else this.stopPolling();
    } catch (error) {
      const code = String(error && error.code || '');
      this.setData({ loading: false, loadErr: code === 'NOT_FOUND' ? '这条出图任务已经找不到了。' : '没能取到出图进度，请重试。' });
      store.handleApiError(error, { silent: true });
    }
  },

  imageError() {
    if (Date.now() - this._urlRetryAt < 30000) return;
    this._urlRetryAt = Date.now();
    this.reload({ silent: true });
  },

  goJob(jobId, replace) {
    const method = replace === false ? 'navigateTo' : 'redirectTo';
    wx[method]({ url: `/packages/work/posterJob/index?jobId=${encodeURIComponent(jobId)}`, fail: () => wx.showToast({ title: '成品图页面加载失败，请重试', icon: 'none' }) });
  },

  openParent() { if (this.data.job && this.data.job.parentJobId) this.goJob(this.data.job.parentJobId, false); },

  async saveAlbum() {
    if (this.data.busy || !this.data.job) return;
    const asset = posterAsset(this.data.job);
    this.setData({ busy: 'save' }); wx.showLoading({ title: '保存中' });
    try {
      const path = await fetchPosterFile(asset && (asset.downloadUrl || asset.previewUrl));
      await wxAsync('saveImageToPhotosAlbum', { filePath: path });
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    } catch (error) {
      const message = String(error && (error.errMsg || error.message) || '');
      if (/auth|deny|permission/i.test(message)) {
        wx.showModal({ title: '需要相册权限', content: '保存成品图要用到相册权限，去设置里打开？', confirmText: '去设置', success: (result) => { if (result.confirm) wx.openSetting(); } });
      } else wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    } finally { wx.hideLoading(); this.setData({ busy: '' }); }
  },

  async shareFriend() {
    if (this.data.busy || !this.data.job) return;
    const asset = posterAsset(this.data.job);
    this.setData({ busy: 'share' }); wx.showLoading({ title: '准备中' });
    try {
      const path = await fetchPosterFile(asset && (asset.downloadUrl || asset.previewUrl));
      wx.hideLoading();
      await wxAsync('showShareImageMenu', { path });
    } catch (_) { wx.hideLoading(); wx.showToast({ title: '暂时打不开转发，可先存相册', icon: 'none' }); }
    finally { this.setData({ busy: '' }); }
  },

  openRevise() {
    this._reviseKey = newIdempotencyKey('revise');
    this.setData({ panel: 'revise', errors: {}, headline: '', cta: '', headlineCount: `0/${LIMITS.headline}`, ctaCount: `0/${LIMITS.cta}`, headlineOver: false, ctaOver: false, proofs: emptyProofs() });
  },
  openStyle() {
    this._styleKey = newIdempotencyKey('regen');
    this.setData({ panel: 'style', errors: {}, visual: '', templateKey: '', visualCount: `0/${LIMITS.visualDirection}`, visualOver: false });
  },
  closePanel() { this.setData({ panel: '', errors: {} }); },

  fieldInput(event) {
    const field = event.currentTarget.dataset.field;
    const value = event.detail.value;
    const max = field === 'visual' ? LIMITS.visualDirection : LIMITS[field];
    const state = count(value, max);
    this.setData({ [field]: value, [`${field}Count`]: state.text, [`${field}Over`]: state.over, [`errors.${field}`]: '', 'errors.form': '' });
  },
  proofInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const proofs = this.data.proofs.slice();
    if (!proofs[index]) return;
    const value = event.detail.value;
    const state = count(value, LIMITS.proofPoint);
    proofs[index] = Object.assign({}, proofs[index], { value, count: state.text, over: state.over, err: '' });
    this.setData({ proofs, 'errors.form': '' });
  },
  chooseTemplate(event) {
    const key = String(event.currentTarget.dataset.key || '');
    this.setData({ templateKey: key === this.data.templateKey ? '' : key });
  },

  async refreshTemplates() {
    try {
      const status = normalizeStatus(await api.creativeStatus());
      this.setData({ templates: status.templates, templateKey: status.templates.some((item) => item.key === this.data.templateKey) ? this.data.templateKey : '', price: status.pricePerPoster });
    } catch (_) { /* 当前错误已展示 */ }
  },

  async submitRevise() {
    if (this.data.busy || !this.data.job) return;
    const errors = {};
    if (this.data.headline.trim().length > LIMITS.headline) errors.headline = `主标题不超过 ${LIMITS.headline} 个字`;
    if (this.data.cta.trim().length > LIMITS.cta) errors.cta = `行动号召不超过 ${LIMITS.cta} 个字`;
    const proofs = this.data.proofs.map((proof, index) => Object.assign({}, proof, { err: proof.value.trim().length > LIMITS.proofPoint ? `第 ${index + 1} 条卖点不超过 ${LIMITS.proofPoint} 个字` : '' }));
    const filled = proofs.map((proof) => proof.value.trim()).filter(Boolean);
    if (!this.data.headline.trim() && !this.data.cta.trim() && !filled.length) errors.form = '改一处再提交（留空表示沿用上一版）。';
    this.setData({ errors, proofs });
    if (Object.keys(errors).length || proofs.some((proof) => proof.err)) return;
    this.setData({ busy: 'revise' });
    try {
      const body = { idempotencyKey: this._reviseKey || newIdempotencyKey('revise') };
      if (this.data.headline.trim()) body.headline = this.data.headline.trim();
      if (filled.length) body.proofPoints = filled;
      if (this.data.cta.trim()) body.cta = this.data.cta.trim();
      const result = await api.reviseJob(this.data.job.id, body);
      this.goJob(result.jobId);
    } catch (error) {
      const code = String(error && (error.code || error.data && error.data.code) || '');
      if (code === 'BRIEF_INVALID' || code === 'MODERATION_BLOCKED') this.setData({ 'errors.form': String(error.message || '文案没通过校验，改一下再试。') });
      else if (code === 'CREATIVE_DAILY_LIMIT') this.setData({ 'errors.form': '今日出图额度已满，明天再来。' });
      else store.handleApiError(error, { fallbackTitle: '改文字失败，请重试' });
    } finally { this.setData({ busy: '' }); }
  },

  async submitRegenerate(event) {
    if (this.data.busy || !this.data.job) return;
    const usePanel = Boolean(event && event.currentTarget.dataset.panel);
    if (usePanel && this.data.visual.trim().length > LIMITS.visualDirection) { this.setData({ 'errors.visual': `视觉方向不超过 ${LIMITS.visualDirection} 个字` }); return; }
    this.setData({ busy: 'regen', errors: {} });
    try {
      const body = { idempotencyKey: usePanel ? (this._styleKey || newIdempotencyKey('regen')) : newIdempotencyKey('regen') };
      if (usePanel && this.data.visual.trim()) body.visualDirection = this.data.visual.trim();
      if (usePanel && this.data.templateKey) body.templateKey = this.data.templateKey;
      const result = await api.regenerateJob(this.data.job.id, body);
      this.goJob(result.jobId);
    } catch (error) {
      const code = String(error && (error.code || error.data && error.data.code) || '');
      const message = String(error && error.message || '');
      if (code === 'INSUFFICIENT_CREDITS') { this.setData({ 'errors.form': '钻石不足，去「我的 · 权益额度」看看余额。' }); wx.showToast({ title: '钻石不足', icon: 'none' }); }
      else if (code === 'CREATIVE_DAILY_LIMIT') { this.setData({ 'errors.form': '今日出图额度已满，明天再来。' }); wx.showToast({ title: '今日额度已满', icon: 'none' }); }
      else if (code === 'BRIEF_INVALID' || code === 'MODERATION_BLOCKED') { this.setData({ 'errors.form': message || '没通过校验，改一下再试。' }); if (/版式/.test(message)) this.refreshTemplates(); }
      else store.handleApiError(error, { fallbackTitle: '换风格失败，请重试' });
    } finally { this.setData({ busy: '' }); }
  },

  cancel() {
    if (this.data.busy || !this.data.job) return;
    wx.showModal({
      title: '取消出图', content: '取消后这次出图不再继续，已扣的钻石会退回。',
      success: async (result) => {
        if (!result.confirm) return;
        this.setData({ busy: 'cancel' });
        try { this.applyJob(await api.cancelJob(this.data.job.id)); this.stopPolling(); }
        catch (error) { store.handleApiError(error, { fallbackTitle: '取消失败，请重试' }); }
        finally { this.setData({ busy: '' }); }
      },
    });
  },
});
