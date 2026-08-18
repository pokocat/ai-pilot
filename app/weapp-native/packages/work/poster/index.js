const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { navTo } = require('../../../services/nav');
const {
  LIMITS, normalizeStatus, normalizeRecommendation, newIdempotencyKey, posterScope, readPosterPending,
  markPosterPending, attachPosterJob,
} = require('./creative');

const ROLE_LABEL = { portrait: '人像', logo: 'Logo', qr: '二维码' };
// 每个素材槽一句用途说明：说清「传了会被怎么用」，而不是只摆一个空框让人猜。
const ROLE_HINT = {
  portrait: '本人照片，用于「本人形象」方向',
  logo: '排在画面角落，做品牌落款',
  qr: '排在成品下方，扫码找到你',
};
const PORTRAIT_CONSENT = [
  '我拥有本人或被授权人的肖像使用权',
  '不冒用他人身份、不做误导性代言',
  '生成结果可能与本人存在差异',
];
// 版式密度（TemplateOption.density）→ 中文档位标签。运营扩到 8 套之后，一列平铺的卡片读不出
// 「这些是同一类」；按密度分组是唯一不需要用户先懂设计术语就能选的分法。
const DENSITY_LABEL = { airy: '留白', balanced: '均衡', dense: '信息量' };
// 「调整版式」一级分档的入口文案：说人话。「留白 / 均衡 / 信息量」是给方案卡摘要行用的短标签，
// 而让人现场做选择的那三个按钮得直接说清选完会怎样。
const DENSITY_TAB = { airy: '只说一句话', balanced: '均衡', dense: '信息全放上' };
const DENSITY_ORDER = ['airy', 'balanced', 'dense'];
// 两条路线各一句「差价买的是什么」。价格差由 status 实价算出来（premiumPrice - price），不写死。
const WAY_NAME = { standard: '创意排版', premium: '主视觉大片' };
const WAY_BUY = {
  standard: '军师用图形与排印现场作画',
  premium: 'AI 先出实拍质感主视觉，再排中文',
};

/**
 * 版式分组：**完全数据驱动**——status 下发什么就渲染什么，本地不补目录、不猜密度。
 * 一套都没带 density（老服务端）时退回单组平铺，不给用户凭空造出三个空档位标签。
 */
function groupTemplates(templates) {
  const list = Array.isArray(templates) ? templates : [];
  if (!list.length) return [];
  if (!list.some((item) => item && DENSITY_LABEL[item.density])) return [{ key: 'all', label: '', tab: '全部版式', items: list }];
  const groups = [];
  DENSITY_ORDER.forEach((density) => {
    const items = list.filter((item) => item && item.density === density);
    if (items.length) groups.push({ key: density, label: DENSITY_LABEL[density], tab: DENSITY_TAB[density], items });
  });
  const rest = list.filter((item) => !item || !DENSITY_LABEL[item.density]);
  if (rest.length) groups.push({ key: 'other', label: '其他', tab: '其他', items: rest });
  return groups;
}

function emptyProofs() {
  return [0, 1, 2].map((index) => ({ index, label: `第 ${index + 1} 条`, value: '', count: `0/${LIMITS.proofPoint}`, over: false, err: '' }));
}

/** 摘要行的初值：草稿回来之前也得有三行「未填」，不能先空一格再跳出来。 */
function emptySummary() {
  return [
    { key: 'headline', label: '主标题', value: '未填', empty: true },
    { key: 'proofs', label: '卖点', value: '未填', empty: true },
    { key: 'cta', label: '行动号召', value: '未填', empty: true },
  ];
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
    proofs: emptyProofs(), templates: [], templateGroups: [], templateKey: '', brandKitVersion: null, negativePrompt: '',
    // 两条创作路线 + 路线内方向；真实缩略图由 status 下发，不进小程序代码包。
    tier: 'standard', premiumPrice: 0, premiumOn: false,
    directions: [], activeDirections: [], directionKey: '',
    // 设计说明：服务端从整段对话抽出来的「这张海报会长什么样」，是本页主视图。
    designNote: '',
    // ── 军师方案卡（2026-08-16 重排）──
    // 服务端下发 recommendation（方式 / 方向 / 版式 + 一句理由）时，这三项已经替用户定好了：
    // 页面主视图是一张方案卡（说明 + 理由 + 组合摘要 + 价格），三处修改收进低调入口，点开才出现。
    // 没有 recommendation（老服务端 / 抽取失败）时 hasReco=false，三个选择器回退成常驻展开。
    // panel 默认 'way'：确认页一进来就把两档出图方式摊开对比（2026-08-17 产品决定）。
    // 高级档不可用时那块面板整体不渲染，此时这个默认值等于「三块都收着」，与旧行为一致。
    hasReco: false, recoReason: '', panel: 'way',
    plan: { way: '', direction: '', template: '', density: '', price: null },
    // 「换方式」两档各配一张该档下的真实样例缩略图（取自 status.directions，不进代码包）。
    wayStd: { previewUrl: '', name: '' }, wayPro: { previewUrl: '', name: '' },
    wayBuyStd: WAY_BUY.standard, wayBuyPro: WAY_BUY.premium, premiumDelta: 0,
    // 「调整版式」：一级密度分档 + 二级该档下的版式横滑。
    densityKey: '', densityItems: [],
    // 「编辑内容」分组默认收起成摘要行（2026-08-15 重排）：入口是动词「编辑」，
    // 不是此前那句「这些细节要改吗」——问句会让人以为不点开就漏了什么。
    showEdit: false, summaryRows: emptySummary(),
    assets: [
      { role: 'portrait', label: ROLE_LABEL.portrait, hint: ROLE_HINT.portrait, assetId: '', path: '', uploading: false, disabled: false },
      { role: 'logo', label: ROLE_LABEL.logo, hint: ROLE_HINT.logo, assetId: '', path: '', uploading: false, disabled: false },
      { role: 'qr', label: ROLE_LABEL.qr, hint: ROLE_HINT.qr, assetId: '', path: '', uploading: false, disabled: false },
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

  back() { wx.navigateBack({ fail: () => navTo('/pages/pouch/index') }); },
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
    if (status) this._statusAt = Date.now();
    if (status && !status.enabled) { this.setData({ disabled: true, loading: false }); return; }
    const hasDraftBrief = Boolean(draft && draft.brief && typeof draft.brief === 'object');
    const draftNote = String((draft && draft.designNote) || '').trim();
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
      designNote: draftNote,
      // 抽不出设计说明 = 没有可确认的东西，直接把「编辑内容」摊开，否则页面上少了主视图又没东西可看。
      showEdit: !draftNote,
      // 从锦囊直接开工时**没有** messageId（不是从对话成果卡进来的），服务端本来就会 422
      // MESSAGE_ID_REQUIRED —— 那是「没有可预填的东西」，不是「预填失败」。这种情况下弹一条
      // 报错横幅会把一次正常的冷启动说成故障。只有带着 messageId 却没拿到草稿才是真出了事。
      loadErr: hasDraftBrief || !this.data.messageId ? '' : '需求单预填没取到，可以直接手填后生成。',
      reason: String(draft && draft.templateReason || ''), price: status ? status.pricePerPoster : null,
      templates, templateGroups: groupTemplates(templates), templateKey,
      premiumPrice: status ? status.premiumPricePerPoster : 0,
      premiumOn: !!(status && status.premiumAvailable),
      directions: status ? status.directions : [],
      scene: brief.scene || 'personal_brand', brandKitVersion: typeof brief.brandKitVersion === 'number' ? brief.brandKitVersion : null,
      negativePrompt: String(brief.negativePrompt || ''), proofs,
    };
    Object.keys(fields).forEach((field) => {
      const state = count(fields[field], LIMITS[field === 'visual' ? 'visualDirection' : field]);
      updates[field] = fields[field]; updates[`${field}Count`] = state.text; updates[`${field}Over`] = state.over;
    });
    const directionTier = brief.tier === 'premium' && updates.premiumOn ? 'premium' : 'standard';
    const activeDirections = updates.directions.filter((item) => item.tier === directionTier);
    const requestedDirection = String(brief.directionKey || '');
    updates.tier = directionTier;
    updates.activeDirections = activeDirections;
    updates.directionKey = activeDirections.some((item) => item.key === requestedDirection)
      ? requestedDirection : String(activeDirections[0] && activeDirections[0].key || '');
    updates.assets = this.assetsForTier(directionTier);
    // ── 军师方案：三项一次定死，用户默认只需要点头 ──
    // 推荐组合优先于 brief 里的零散字段（brief.templateKey / tier / directionKey 是草稿的旧口径，
    // recommendation 才是军师对「这三项怎么配」的完整答复）。任一项在当前清单里对不上就整条作废，
    // 页面退回现行为：按现逻辑预选 + 把选择器摊开（判据见 creative.js 的 normalizeRecommendation）。
    const reco = normalizeRecommendation(draft && draft.recommendation, {
      directions: updates.directions, templates, premiumAvailable: updates.premiumOn,
    });
    if (reco) {
      updates.tier = reco.tier;
      updates.activeDirections = updates.directions.filter((item) => item.tier === reco.tier);
      updates.directionKey = reco.directionKey;
      updates.templateKey = reco.templateKey;
      updates.assets = this.assetsForTier(reco.tier);
    }
    updates.hasReco = !!reco;
    updates.recoReason = reco ? reco.reason : '';
    updates.panel = '';
    // 版式一级分档跟着推荐版式落在它所属的那一档上（用户点开「调整版式」就看到自己那档是高亮的）。
    updates.densityKey = String((updates.templateGroups.find((group) => group.items
      .some((item) => item && item.key === updates.templateKey)) || updates.templateGroups[0] || {}).key || '');
    this.setData(updates);
    this.refreshSummary();
    this.refreshPlan();
  },

  /**
   * 方案卡的组合摘要 + 三个面板的派生数据。改方式 / 改方向 / 改版式之后都要重算 ——
   * 摘要行与价格是用户点「生成」前唯一还会再看一眼的东西，慢一拍就等于在扣费那一刻说假话。
   *
   * ⚠️ 这里**只读当前选择**，永不回头读 recommendation：推荐只在首屏落一次，
   * 用户改过之后再被推荐值盖回去，等于告诉他「你的选择不算数」。
   */
  refreshPlan() {
    const tier = this.data.tier;
    const price = tier === 'premium' && this.data.premiumOn ? this.data.premiumPrice : this.data.price;
    const direction = (this.data.directions || []).find((item) => item && item.key === this.data.directionKey);
    const template = (this.data.templates || []).find((item) => item && item.key === this.data.templateKey);
    const groups = this.data.templateGroups || [];
    // 用户点过密度档就留住他那一档；没点过（或那一档没了）才跟着当前版式走。
    const densityKey = groups.some((group) => group.key === this.data.densityKey)
      ? this.data.densityKey
      : String((groups.find((group) => group.items.some((item) => item && item.key === this.data.templateKey)) || groups[0] || {}).key || '');
    const active = groups.find((group) => group.key === densityKey);
    this.setData({
      densityKey,
      densityItems: active ? active.items : (this.data.templates || []),
      premiumDelta: Math.max(0, Number(this.data.premiumPrice || 0) - Number(this.data.price || 0)),
      wayStd: this.waySample('standard'),
      wayPro: this.waySample('premium'),
      plan: {
        way: WAY_NAME[tier] || WAY_NAME.standard,
        direction: String(direction && direction.name || ''),
        template: String(template && template.name || ''),
        density: template && DENSITY_LABEL[template.density] ? DENSITY_LABEL[template.density] : '',
        price: Number.isFinite(Number(price)) ? Number(price) : null,
      },
    });
  },

  /**
   * 「换方式」两档各配一张**真实**样例：优先当前选中的方向那张，其次该档第一张有图的。
   * 刻意不拿 requiresPortrait 的方向当门面 —— 那张图是用户自己的脸排出来的效果，
   * 拿它代表整条路线会让人以为不传照片就出不了图。
   */
  waySample(tier) {
    const list = (this.data.directions || []).filter((item) => item && item.tier === tier);
    const current = list.find((item) => item.key === this.data.directionKey);
    const pick = (current && current.previewUrl ? current : null)
      || list.find((item) => item.previewUrl && !item.requiresPortrait)
      || list.find((item) => item.previewUrl)
      || list[0] || null;
    return { previewUrl: String(pick && pick.previewUrl || ''), name: String(pick && pick.name || '') };
  },

  /**
   * 样例图的地址是 OSS **签名 URL，窗口只有 10–20 分钟**（见服务端 SAMPLE_URL_WINDOW_SEC），
   * 而本页的 status 只在进场拉一次。`<image>` 渲染过一次就留着位图，所以早就画出来的标准档三张
   * 一直在，而 premium 那几张是**点开「出图方式」或切档时才第一次渲染**的——那时签名早过期，
   * 于是只有它们空着（2026-08-17 报障：主视觉大片与人物意象没缩略图，服务端数据其实完好）。
   *
   * 所以在「即将第一次渲染那些卡」的两个入口上做陈旧检查：超过 5 分钟（小于签名窗口）就静默
   * 重拉一次。走既有的 refreshTemplates()——它明确不碰 recommendation，不会把用户已做的选择盖回去。
   */
  refreshStatusIfStale() {
    if (this._statusAt && Date.now() - this._statusAt < 300000) return;
    this.refreshTemplates();
  },

  /** 三个低调入口：点开一个、再点收起。没有推荐时三块本来就常驻展开，这个开关也就不渲染。 */
  openPanel(event) {
    const key = String(event.currentTarget.dataset.panel || '');
    this.setData({ panel: this.data.panel === key ? '' : key });
    this.refreshStatusIfStale();
  },

  chooseDensity(event) {
    this.setData({ densityKey: String(event.currentTarget.dataset.key || '') });
    this.refreshPlan();
  },

  /**
   * 「编辑内容」收起时的摘要行。只摘用户最在意的三项（主标题 / 卖点 / 行动号召）——
   * 摘要要能一眼扫完，把七个字段全铺上去就又变回一张表了。
   */
  refreshSummary() {
    const proofs = this.data.proofs.map((proof) => String(proof.value || '').trim()).filter(Boolean);
    const row = (key, label, value) => ({ key, label, value: value || '未填', empty: !value });
    this.setData({
      summaryRows: [
        row('headline', '主标题', String(this.data.headline || '').trim()),
        row('proofs', '卖点', proofs.join(' · ')),
        row('cta', '行动号召', String(this.data.cta || '').trim()),
      ],
    });
  },

  /** 人像槽在主视觉大片下**置灰而不是消失**：消失了用户只会以为「这功能没了」。 */
  assetsForTier(tier) {
    return this.data.assets.map((item) => (item.role === 'portrait'
      ? Object.assign({}, item, { disabled: tier === 'premium' })
      : item));
  },

  fieldInput(event) {
    const field = event.currentTarget.dataset.field;
    const value = event.detail.value;
    const key = field === 'visual' ? 'visualDirection' : field;
    const state = count(value, LIMITS[key]);
    this.setData({ [field]: value, [`${field}Count`]: state.text, [`${field}Over`]: state.over, [`errors.${field}`]: '' });
    this.refreshSummary();
  },

  proofInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const proofs = this.data.proofs.slice();
    if (!proofs[index]) return;
    const value = event.detail.value;
    const state = count(value, LIMITS.proofPoint);
    proofs[index] = Object.assign({}, proofs[index], { value, count: state.text, over: state.over, err: '' });
    this.setData({ proofs });
    this.refreshSummary();
  },

  chooseTemplate(event) {
    this.setData({ templateKey: String(event.currentTarget.dataset.key || '') });
    this.refreshPlan();
  },
  toggleEdit() { this.setData({ showEdit: !this.data.showEdit }); },
  chooseTier(event) {
    const tier = String(event.currentTarget.dataset.key || 'standard');
    const activeDirections = this.data.directions.filter((item) => item.tier === tier);
    this.setData({
      tier,
      activeDirections,
      directionKey: String(activeDirections[0] && activeDirections[0].key || ''),
      assets: this.assetsForTier(tier),
      'errors.direction': '',
    });
    this.refreshPlan();
    this.refreshStatusIfStale();
  },
  chooseDirection(event) {
    this.setData({ directionKey: String(event.currentTarget.dataset.key || ''), 'errors.direction': '' });
    this.refreshPlan();
  },
  toggleConsent() { this.setData({ consent: !this.data.consent, 'errors.consent': '' }); },

  /**
   * 本人照片刚选定 / 刚清除的那一刻，把方向拨到与之自洽的一项。
   *
   * 只在这两个时刻动，**不在每次渲染里强制**：传了照片之后又手动改选别的方向，那是用户的决定，得留住。
   * 传了照片却停在「强标题视觉」，art direction（视觉主角必须是主标题本身）和那张脸会在同一张
   * 画面里互相打架；服务端的 hasPortrait 默认分支本来就想选「本人形象」，是确认页恒钉第一项把它废了。
   * 该路线没有 requiresPortrait 的方向（高级档）时：不切也不提示。
   */
  syncDirectionForPortrait(hasPortrait) {
    const list = this.data.activeDirections || [];
    const current = list.find((item) => item.key === this.data.directionKey);
    if (hasPortrait) {
      if (current && current.requiresPortrait) return;
      const portraitOne = list.find((item) => item.requiresPortrait);
      if (!portraitOne) return;
      this.setData({ directionKey: portraitOne.key, 'errors.direction': '' });
      this.refreshPlan();
      wx.showToast({ title: `已切换到「${portraitOne.name || '本人形象'}」方向`, icon: 'none' });
      return;
    }
    if (!current || !current.requiresPortrait) return;
    this.setData({ directionKey: String(list[0] && list[0].key || ''), 'errors.direction': '' });
    this.refreshPlan();
  },

  async pickAsset(event) {
    if (this.data.submitting || this.data.assets.some((item) => item.uploading)) return;
    const role = String(event.currentTarget.dataset.role || '');
    // 置灰槽点得动，只是点了给解释：一个不响应的灰框跟坏掉的按钮长得一模一样。
    if (this.data.assets.some((item) => item.role === role && item.disabled)) {
      wx.showModal({
        title: '主视觉大片不用本人照片',
        content: '这一档由 AI 整幅创作主视觉，人物方向是 AI 演绎、并非本人。想让本人出镜，请切回「创意排版」。',
        showCancel: false, confirmText: '知道了',
      });
      return;
    }
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
      if (role === 'portrait') this.syncDirectionForPortrait(true);
    } catch (error) {
      assets = this.data.assets.map((item) => item.role === role ? Object.assign({}, item, { uploading: false }) : item);
      this.setData({ assets });
      store.handleApiError(error, { fallbackTitle: '图片上传失败，请重试' });
    }
  },

  dropAsset(event) {
    const role = String(event.currentTarget.dataset.role || '');
    this.setData({ assets: this.data.assets.map((item) => item.role === role ? Object.assign({}, item, { assetId: '', path: '', uploading: false }) : item) });
    if (role === 'portrait') this.syncDirectionForPortrait(false);
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
    const hasPortrait = this.data.assets.some((item) => item.role === 'portrait' && item.assetId);
    if (hasPortrait && !this.data.consent) errors.consent = '请先确认肖像使用权';
    if (this.data.directionKey === 'graphic_portrait' && !hasPortrait) errors.direction = '「本人形象」需要先上传本人照片';
    if (this.data.tier === 'premium' && hasPortrait) errors.direction = '「主视觉大片」不使用本人照片，请移除照片或选择「创意排版」';
    this.setData({ errors, proofs });
    // 方向/路线的错误躺在收起的面板里：不点开就等于让用户对着一句「还有几处要改」
    // 找一个他根本看不见的选项。互斥（传了照片却选了主视觉大片）要开「换方式」，其余开「换方向」。
    if (errors.direction) {
      this.setData({ panel: this.data.tier === 'premium' && hasPortrait ? 'way' : 'direction' });
    }
    if (Object.keys(errors).length || proofs.some((proof) => proof.err)) {
      // 报错的字段大多躺在收起的「编辑内容」里：不摊开就等于让用户对着一句「还有几处要改」
      // 找一个他根本看不见的输入框。
      const inEdit = proofs.some((proof) => proof.err)
        || ['goal', 'audience', 'headline', 'subheadline', 'cta', 'visual'].some((field) => errors[field]);
      if (inEdit && !this.data.showEdit) this.setData({ showEdit: true });
      wx.showToast({ title: '还有几处需要改一下', icon: 'none' });
      return false;
    }
    return true;
  },

  /**
   * 重取启用中的清单（后台停用某套版式 / 关掉高级路线后，本页缓存会过期）。
   * ⚠️ 这里**不碰 recommendation**：推荐只在首屏落一次。用户此刻的选择是他自己做的决定，
   * 借一次刷新把推荐值盖回去，就是当着他的面把选择改掉。
   */
  async refreshTemplates() {
    try {
      const status = normalizeStatus(await api.creativeStatus());
      this._statusAt = Date.now();
      const templateKey = status.templates.some((item) => item.key === this.data.templateKey) ? this.data.templateKey : (status.templates[0] && status.templates[0].key || '');
      const tier = this.data.tier === 'premium' && status.premiumAvailable ? 'premium' : 'standard';
      const activeDirections = status.directions.filter((item) => item.tier === tier);
      const directionKey = activeDirections.some((item) => item.key === this.data.directionKey)
        ? this.data.directionKey : String(activeDirections[0] && activeDirections[0].key || '');
      this.setData({
        templates: status.templates, templateGroups: groupTemplates(status.templates), templateKey, price: status.pricePerPoster,
        premiumPrice: status.premiumPricePerPoster, premiumOn: !!status.premiumAvailable,
        directions: status.directions, activeDirections, directionKey, tier,
        assets: this.assetsForTier(tier),
      });
      this.refreshPlan();
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
      directionKey: this.data.directionKey,
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
