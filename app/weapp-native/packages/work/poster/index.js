const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { navTo } = require('../../../services/nav');
const {
  LIMITS, normalizeStatus, newIdempotencyKey, posterScope, readPosterPending,
  markPosterPending, attachPosterJob,
} = require('./creative');

const ROLE_LABEL = { portrait: '人像', logo: 'Logo', qr: '二维码' };
const PORTRAIT_CONSENT = [
  '我拥有本人或被授权人的肖像使用权',
  '不冒用他人身份、不做误导性代言',
  '生成结果可能与本人存在差异',
];

function emptyProofs() {
  return [0, 1, 2].map((index) => ({ index, label: `第 ${index + 1} 条`, value: '', count: `0/${LIMITS.proofPoint}`, over: false, err: '' }));
}

function count(value, max) {
  const size = String(value || '').trim().length;
  return { text: `${size}/${max}`, over: size > max };
}

function pickImage() {
  return new Promise((resolve, reject) => {
    if (wx.chooseMedia) {
      wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'], sourceType: ['album', 'camera'], success: resolve, fail: reject });
      return;
    }
    wx.chooseImage({ count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'], success: resolve, fail: reject });
  });
}

function parsePicked(result) {
  const file = result && Array.isArray(result.tempFiles) ? result.tempFiles[0] : null;
  return { path: (file && (file.tempFilePath || file.path)) || (result && result.tempFilePaths && result.tempFilePaths[0]) || '', size: Number(file && file.size || 0) };
}

Page({
  data: baseData({
    loading: true, loadErr: '', disabled: false, showLogin: false, unlockAgent: null,
    sessionId: '', messageId: '', reason: '', price: null,
    scene: 'personal_brand', goal: '', audience: '', headline: '', subheadline: '', cta: '', visual: '',
    goalCount: `0/${LIMITS.goal}`, audienceCount: `0/${LIMITS.audience}`,
    headlineCount: `0/${LIMITS.headline}`, subheadlineCount: `0/${LIMITS.subheadline}`,
    ctaCount: `0/${LIMITS.cta}`, visualCount: `0/${LIMITS.visualDirection}`,
    goalOver: false, audienceOver: false, headlineOver: false, subheadlineOver: false, ctaOver: false, visualOver: false,
    proofs: emptyProofs(), templates: [], templateKey: '', brandKitVersion: null, negativePrompt: '',
    // 档位：premiumOn 为假时整块不渲染（供应商没配好时露出一个必然 422 的选项比不露更糟）。
    tier: 'standard', premiumPrice: 0, premiumOn: false,
    assets: [
      { role: 'portrait', label: ROLE_LABEL.portrait, assetId: '', path: '', uploading: false },
      { role: 'logo', label: ROLE_LABEL.logo, assetId: '', path: '', uploading: false },
      { role: 'qr', label: ROLE_LABEL.qr, assetId: '', path: '', uploading: false },
    ],
    consent: false, consentLines: PORTRAIT_CONSENT, errors: {}, submitErr: '', submitErrCredits: false, submitting: false,
  }),

  onLoad(options) {
    const sessionId = String(options && options.sessionId || '');
    const messageId = String(options && options.messageId || '');
    this._scope = posterScope(messageId, sessionId);
    this._idempotencyKey = '';
    this.setData({ sessionId, messageId });
    if (!store.isAuthed()) { this.setData({ loading: false, showLogin: true }); return; }
    this.load();
  },

  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/pouch/index' }) }); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
  closeUnlock() { this.setData({ unlockAgent: null }); },
  agentUnlocked() {
    this.setData({ unlockAgent: null, submitErr: '', submitErrCredits: false });
    wx.showToast({ title: '海报设计师已启用，请再次生成', icon: 'none' });
  },

  goJob(jobId) {
    wx.redirectTo({
      url: `/packages/work/posterJob/index?jobId=${encodeURIComponent(jobId)}`,
      fail: () => wx.showToast({ title: '成品图页面加载失败，请重试', icon: 'none' }),
    });
  },

  async load() {
    const pending = readPosterPending(this._scope);
    if (pending && pending.jobId) { this.goJob(pending.jobId); return; }
    this._idempotencyKey = (pending && pending.idempotencyKey) || newIdempotencyKey('poster');
    this.setData({ loading: true, loadErr: '' });
    const statusPromise = api.creativeStatus().then(normalizeStatus).catch((error) => {
      store.handleApiError(error, { silent: true });
      return null;
    });
    const draftPromise = api.posterBriefDraft(this.data.sessionId || undefined, this.data.messageId || undefined).catch((error) => {
      store.handleApiError(error, { silent: true });
      return null;
    });
    const [status, draft] = await Promise.all([statusPromise, draftPromise]);
    if (status && !status.enabled) { this.setData({ disabled: true, loading: false }); return; }
    const hasDraftBrief = Boolean(draft && draft.brief && typeof draft.brief === 'object');
    const brief = hasDraftBrief ? draft.brief : {};
    const templates = status ? status.templates : [];
    const recommended = String(brief.templateKey || '');
    const templateKey = templates.length ? (templates.some((item) => item.key === recommended) ? recommended : templates[0].key) : recommended;
    const proofs = emptyProofs();
    (brief.proofPoints || []).slice(0, 3).forEach((value, index) => {
      const state = count(value, LIMITS.proofPoint);
      proofs[index] = Object.assign({}, proofs[index], { value: String(value || ''), count: state.text, over: state.over });
    });
    const fields = {
      goal: String(brief.goal || ''), audience: String(brief.audience || ''), headline: String(brief.headline || ''),
      subheadline: String(brief.subheadline || ''), cta: String(brief.cta || ''), visual: String(brief.visualDirection || ''),
    };
    const updates = {
      loading: false, disabled: false,
      // 从锦囊直接开工时**没有** messageId（不是从对话成果卡进来的），服务端本来就会 422
      // MESSAGE_ID_REQUIRED —— 那是「没有可预填的东西」，不是「预填失败」。这种情况下弹一条
      // 报错横幅会把一次正常的冷启动说成故障。只有带着 messageId 却没拿到草稿才是真出了事。
      loadErr: hasDraftBrief || !this.data.messageId ? '' : '需求单预填没取到，可以直接手填后生成。',
      reason: String(draft && draft.templateReason || ''), price: status ? status.pricePerPoster : null,
      templates, templateKey,
      premiumPrice: status ? status.premiumPricePerPoster : 0,
      premiumOn: !!(status && status.premiumAvailable),
      scene: brief.scene || 'personal_brand', brandKitVersion: typeof brief.brandKitVersion === 'number' ? brief.brandKitVersion : null,
      negativePrompt: String(brief.negativePrompt || ''), proofs,
    };
    Object.keys(fields).forEach((field) => {
      const state = count(fields[field], LIMITS[field === 'visual' ? 'visualDirection' : field]);
      updates[field] = fields[field]; updates[`${field}Count`] = state.text; updates[`${field}Over`] = state.over;
    });
    this.setData(updates);
  },

  fieldInput(event) {
    const field = event.currentTarget.dataset.field;
    const value = event.detail.value;
    const key = field === 'visual' ? 'visualDirection' : field;
    const state = count(value, LIMITS[key]);
    this.setData({ [field]: value, [`${field}Count`]: state.text, [`${field}Over`]: state.over, [`errors.${field}`]: '' });
  },

  proofInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const proofs = this.data.proofs.slice();
    if (!proofs[index]) return;
    const value = event.detail.value;
    const state = count(value, LIMITS.proofPoint);
    proofs[index] = Object.assign({}, proofs[index], { value, count: state.text, over: state.over, err: '' });
    this.setData({ proofs });
  },

  chooseTemplate(event) { this.setData({ templateKey: String(event.currentTarget.dataset.key || '') }); },
  chooseTier(event) { this.setData({ tier: String(event.currentTarget.dataset.key || 'standard') }); },
  toggleConsent() { this.setData({ consent: !this.data.consent, 'errors.consent': '' }); },

  async pickAsset(event) {
    if (this.data.submitting || this.data.assets.some((item) => item.uploading)) return;
    const role = String(event.currentTarget.dataset.role || '');
    if (role === 'portrait' && !this.data.consent) {
      this.setData({ 'errors.consent': '请先确认肖像使用权' });
      wx.showToast({ title: '请先勾选肖像确认', icon: 'none' });
      return;
    }
    let picked;
    try { picked = parsePicked(await pickImage()); } catch (_) { return; }
    if (!picked.path) return;
    if (picked.size > 10 * 1024 * 1024) { wx.showToast({ title: '单张图片不超过 10MB', icon: 'none' }); return; }
    let assets = this.data.assets.map((item) => item.role === role ? Object.assign({}, item, { uploading: true }) : item);
    this.setData({ assets });
    try {
      const result = await api.uploadCreativeAsset(picked.path, role);
      const assetId = String(result && (result.assetId || result.id) || '');
      if (!assetId) throw new Error('素材上传没有返回编号');
      assets = this.data.assets.map((item) => item.role === role ? Object.assign({}, item, { uploading: false, assetId, path: picked.path }) : item);
      this.setData({ assets });
    } catch (error) {
      assets = this.data.assets.map((item) => item.role === role ? Object.assign({}, item, { uploading: false }) : item);
      this.setData({ assets });
      store.handleApiError(error, { fallbackTitle: '图片上传失败，请重试' });
    }
  },

  dropAsset(event) {
    const role = String(event.currentTarget.dataset.role || '');
    this.setData({ assets: this.data.assets.map((item) => item.role === role ? Object.assign({}, item, { assetId: '', path: '', uploading: false }) : item) });
  },

  validate() {
    const errors = {};
    const over = (field, max, label) => { if (String(this.data[field] || '').trim().length > max) errors[field] = `${label}不超过 ${max} 个字`; };
    over('goal', LIMITS.goal, '宣传什么'); over('audience', LIMITS.audience, '给谁看');
    if (!this.data.headline.trim()) errors.headline = '主标题不能为空'; else over('headline', LIMITS.headline, '主标题');
    over('subheadline', LIMITS.subheadline, '副标题');
    if (!this.data.cta.trim()) errors.cta = '行动号召不能为空'; else over('cta', LIMITS.cta, '行动号召');
    over('visual', LIMITS.visualDirection, '视觉方向');
    const proofs = this.data.proofs.map((proof, index) => Object.assign({}, proof, { err: proof.value.trim().length > LIMITS.proofPoint ? `第 ${index + 1} 条卖点不超过 ${LIMITS.proofPoint} 个字` : '' }));
    if (this.data.assets.some((item) => item.role === 'portrait' && item.assetId) && !this.data.consent) errors.consent = '请先确认肖像使用权';
    this.setData({ errors, proofs });
    if (Object.keys(errors).length || proofs.some((proof) => proof.err)) {
      wx.showToast({ title: '还有几处需要改一下', icon: 'none' });
      return false;
    }
    return true;
  },

  async refreshTemplates() {
    try {
      const status = normalizeStatus(await api.creativeStatus());
      const templateKey = status.templates.some((item) => item.key === this.data.templateKey) ? this.data.templateKey : (status.templates[0] && status.templates[0].key || '');
      this.setData({
        templates: status.templates, templateKey, price: status.pricePerPoster,
        premiumPrice: status.premiumPricePerPoster, premiumOn: !!status.premiumAvailable,
      });
    } catch (_) { /* 服务端原错误已经在提交区展示 */ }
  },

  async submit() {
    if (this.data.submitting || this.data.disabled || !this.validate()) return;
    const asset = (role) => this.data.assets.find((item) => item.role === role && item.assetId);
    const brief = {
      scene: this.data.scene,
      goal: this.data.goal.trim(), audience: this.data.audience.trim(), headline: this.data.headline.trim(),
      proofPoints: this.data.proofs.map((proof) => proof.value.trim()).filter(Boolean),
      cta: this.data.cta.trim(), visualDirection: this.data.visual.trim(), ratio: '3:4',
    };
    if (this.data.subheadline.trim()) brief.subheadline = this.data.subheadline.trim();
    if (this.data.negativePrompt.trim()) brief.negativePrompt = this.data.negativePrompt.trim();
    if (this.data.templateKey) brief.templateKey = this.data.templateKey;
    // 状态过期时（停在本页期间运营关了供应商）少发一次 premium，少一次白扣的风险。
    brief.tier = this.data.premiumOn ? this.data.tier : 'standard';
    if (asset('portrait')) brief.portraitAssetId = asset('portrait').assetId;
    if (asset('logo')) brief.logoAssetId = asset('logo').assetId;
    if (asset('qr')) brief.qrAssetId = asset('qr').assetId;
    if (this.data.brandKitVersion) brief.brandKitVersion = this.data.brandKitVersion;
    this.setData({ submitting: true, submitErr: '', submitErrCredits: false });
    markPosterPending(this._scope, this._idempotencyKey);
    try {
      const result = await api.createPosterJob({
        brief,
        sessionId: this.data.sessionId || undefined,
        messageId: this.data.messageId || undefined,
        idempotencyKey: this._idempotencyKey,
      });
      if (!result || !result.jobId) throw new Error('出图任务没有返回编号');
      attachPosterJob(this._scope, result.jobId);
      this.goJob(result.jobId);
    } catch (error) {
      const code = String(error && (error.code || error.data && error.data.code) || '');
      const message = String(error && error.message || '');
      if (code === 'CANVAS_DISABLED') this.setData({ disabled: true });
      else if (code === 'AGENT_LOCKED') {
        const [agents] = await Promise.all([store.loadAgents(), store.loadMe()]);
        const poster = (agents || []).find((agent) => agent.key === 'poster');
        if (poster && poster.billing === 'unlock' && !poster.owned) {
          this.setData({ unlockAgent: poster, submitErr: '', submitErrCredits: false });
        } else {
          this.setData({ submitErr: '海报设计师状态尚未同步，请稍后再次生成。', submitErrCredits: false });
        }
      } else if (code === 'INSUFFICIENT_CREDITS') this.setData({ submitErr: '钻石不足，去「我的 · 权益额度」看看余额。', submitErrCredits: true });
      else if (code === 'CREATIVE_DAILY_LIMIT') this.setData({ submitErr: '今日出图额度已满，明天再来。', submitErrCredits: false });
      else if (code === 'PLAN_EXPIRED') this.setData({ submitErr: '当前方案已到期，续期后可继续出图。', submitErrCredits: false });
      else if (code === 'PLAN_REQUIRED') { this.setData({ submitErr: '尚未开通方案，开通后即可出图。', submitErrCredits: false }); store.promptPlanRequired(); }
      else if (code === 'BRIEF_INVALID' || code === 'MODERATION_BLOCKED') {
        this.setData({ submitErr: message || '需求单没通过校验，改一下再试。', submitErrCredits: false });
        if (/版式/.test(message)) this.refreshTemplates();
      } else store.handleApiError(error, { fallbackTitle: '发起出图失败，请重试' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  goCredits() { navTo('/packages/work/credits/index'); },
});
