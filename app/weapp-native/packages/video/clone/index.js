// 屏 04 · 视频数字分身创建。按石榴官方契约组织为：上传视频 → 云端训练。
//
// speakerId 和 authId 都是 avatar/create 的可选项；单独声音采集只是后续增强，不得阻断形象创建。
const host = require('../host');
const api = require('../api');
const { POLL_INTERVAL_MS } = require('../config');
const model = require('../model');
const { mediaDimensions, formatResolution, cloneCostText, voiceChoices, cloneCostRows } = model;

const STEPS = [
  { no: 1, key: 'video', label: '上传视频' },
  { no: 2, key: 'training', label: '云端训练' },
];

/** 录音时页面保持可见，用户可以直接照读。 */
const READING_SCRIPT = '我一直认真做着自己的事，也愿意把真实的经验分享给你。以后，就让这个数字分身用我平时说话的声音，讲更多值得讲的故事。';
const FALLBACK_REQUIREMENTS = {
  authorizationVideoRequired: false,
  pollIntervalMs: POLL_INTERVAL_MS,
  avatar: { vendorMinDurationSec: 5, vendorMaxDurationSec: 300, minDurationSec: 5, recommendedMinDurationSec: 10, recommendedMaxDurationSec: 20, maxDurationSec: 300, vendorMaxBytes: 200 * 1024 * 1024, maxBytes: 100 * 1024 * 1024, vendorFormats: ['mp4', 'mov'], formats: ['mp4', 'mov'] },
  voice: { vendorMinDurationSec: 2, vendorMaxDurationSec: 0, minDurationSec: 3, recommendedMinDurationSec: 8, recommendedMaxDurationSec: 15, maxDurationSec: 120, vendorMaxBytes: 20 * 1024 * 1024, maxBytes: 20 * 1024 * 1024, vendorFormats: ['wav', 'mp3', 'ogg', 'm4a', 'aac', 'pcm'], formats: ['wav', 'mp3', 'ogg', 'm4a', 'aac'] },
};

function initialTraining(mode) {
  return {
    percent: 0,
    etaText: mode === 'voice' ? '专属声音会在云端继续训练' : '形象会在云端继续训练',
    imageDone: false,
    voiceDone: false,
    imageStateText: '读取中',
    voiceStateText: '读取中',
    hasFailure: false,
  };
}

Page({
  data: host.hostBaseData({
    steps: STEPS,
    mode: 'avatar',
    step: 1,
    agreed: false,
    requirements: FALLBACK_REQUIREMENTS,
    requirementsReady: false,
    readingScript: READING_SCRIPT,
    recording: false,
    startingRecord: false,
    recordSeconds: 0,
    voiceFile: null,
    voiceSubmitted: false,
    faceFile: null,
    avatarId: '',
    avatarName: '',
    voices: [],
    /** 关联声音候选项（含扣费文案）。由 model.voiceChoices 预算好，wxml 不碰价格算术。 */
    voiceOptions: [],
    hasReusableVoice: false,
    /**
     * 空串 = 「视频原声」（新训练一条）。
     * 有可用声音时 loadVoices 会把它改成第一条已有声音 —— **默认复用，花钱要主动选**。
     */
    selectedVoiceId: '',
    /**
     * voice 模式下要重训的那条已有声音。非空 = 走 voiceRetrain（便宜的一档，且供应商侧每条有 4 次
     * 免费重训、不消耗新的克隆权益）。由分身管理页「重新录制 / 提升」带进来。
     * 空 = 新建一条声音，走 voiceCreate。
     */
    retrainVoiceId: '',
    /** 克隆各档单价；null = 还没读到，界面据此不显示价格而不是显示 0。 */
    pricing: null,
    /** 本次提交的合计报价；null = 价格还没读到，此时不许提交（提交要带确认报价）。 */
    expectedCredits: null,
    /**
     * 服务端**还没有**克隆计费这一版（/clone-pricing 回 404）。
     * 此时后端既不收钱也不要求确认报价，所以不能把用户挡在提交之外。
     * 与「价格没读到」是两件事，见 loadPricing。
     */
    pricingUnavailable: false,
    /** 「还剩几次免费重训」；空串 = 不适用或还没读到，界面据此不渲染这一行。 */
    retrainQuotaText: '',
    /** 这条声音重训不了（额度用尽 / 无引擎记录）。true 时挡住提交，请用户显式改成新建。 */
    retrainBlocked: false,
    /** 本次动作的扣费文案（形象/声音各一档），JS 预算好给 wxml 直接渲染。 */
    avatarCostText: '',
    voiceCostText: '',
    /** 扣费明细行；空数组 = 价格没读到，整块不渲染（不显示 0 钻石的假账单）。 */
    costRows: [],
    voiceNoteText: '',
    training: null,
    recaptureKind: null,
    presetAvailable: api.isMock(),
    submitting: false,
    notificationTemplate: null,
    notificationRequesting: false,
    showLogin: false,
  }),

  onLoad(options) {
    const opts = options || {};
    const legacyStep = Number(opts.step || 1);
    const requestedMode = String(opts.mode || '');
    const hasExplicitMode = requestedMode === 'voice' || requestedMode === 'avatar';
    // 新路由显式 mode 优先；只有没有 mode 的旧链接才用 step=1 推断为声音。
    // 否则 mode=avatar&recapture=1 会被 legacyStep 默认值 1 错判成声音页。
    const mode = hasExplicitMode
      ? requestedMode
      : (String(opts.recapture || '') === '1' && legacyStep === 1 ? 'voice' : 'avatar');
    const step = legacyStep >= 2 && String(opts.recapture || '') !== '1' ? 2 : 1;
    this.setData({
      mode,
      step,
      avatarId: String(opts.avatarId || ''),
      // 只有声音模式认这个参数：形象模式下的 voiceId 是「关联哪条已有声音」，不是「重训哪条」。
      retrainVoiceId: mode === 'voice' ? String(opts.voiceId || '') : '',
      recaptureKind: String(opts.recapture || '') === '1' ? mode : null,
      training: step === 2 ? initialTraining(mode) : null,
    });
    if (!host.isLoggedIn()) this.setData({ showLogin: true });
    this.loadRequirements();
    this.loadVoices();
    // 价格不设登录门：用户在决定要不要做之前就该看见成本（浏览类信息不拦登录）。
    this.loadPricing();
    this.loadRetrainQuota();
    // 先按「还没有可用声音」的形状把选项排出来，避免首屏空一块；voices/pricing 到了再重算。
    this.applyVoiceChoices();
    if (host.isLoggedIn()) this.loadNotificationTemplate();
  },

  onShow() {
    if (this.data.step === 2 && !this.trainingTimer) this.startTrainingPolling();
  },
  onHide() { this.stopTrainingPolling(); },
  onUnload() { this.stopTrainingPolling(); this.stopRecordStartTimer(); this.stopRecordTimer(); this.stopRecorder(); },

  loadRequirements() {
    api.avatarRequirements()
      .then((requirements) => {
        if (!requirements || !requirements.avatar || !requirements.voice) return;
        this.setData({ requirements, requirementsReady: true });
      })
      .catch(() => this.setData({ requirementsReady: true }));
  },

  /**
   * 本次提交的账单 —— 明细行与要提交的确认报价**必须出自同一次计算**，
   * 否则又会出现「界面显示一个价、实际按另一个价扣」。
   */
  chargeState(selectedVoiceId) {
    const { mode, pricing, retrainVoiceId } = this.data;
    const items = model.cloneChargeItems(mode, pricing, selectedVoiceId, retrainVoiceId);
    return {
      costRows: cloneCostRows(mode, pricing, selectedVoiceId, retrainVoiceId),
      // pricing 没读到时 items 为空 → null（而不是 0）。0 是「免费」，null 是「还不知道」，不许混。
      expectedCredits: items.length ? model.cloneChargeTotal(items) : null,
    };
  },

  /**
   * 价格与可用声音都会影响「关联声音」这一栏，两者到达顺序不定（各自独立请求），
   * 所以统一收口到这里重算一次，谁后到都能补齐文案。
   */
  applyVoiceChoices() {
    const { options, defaultVoiceId, hasReusable } = voiceChoices(this.data.voices, this.data.pricing);
    // 只在用户还没动过选择时才落默认值：用户主动选了「视频原声」之后，
    // 价格接口姗姗来迟不能把他的选择改回复用。
    const selectedVoiceId = this.voiceTouched ? this.data.selectedVoiceId : defaultVoiceId;
    this.setData(Object.assign({
      voiceOptions: options,
      hasReusableVoice: hasReusable,
      selectedVoiceId,
      avatarCostText: cloneCostText(this.data.pricing, 'avatarVideo'),
      voiceCostText: cloneCostText(this.data.pricing, 'voiceCreate'),
      voiceNoteText: hasReusable
        ? '已默认复用你现有的声音，复用不额外扣费。只有主动选「视频原声」才会新训练一条并扣费。'
        : '还没有可复用的声音，这段视频会用来训练一条新的声音。',
    }, this.chargeState(selectedVoiceId)));
  },

  loadVoices() {
    if (!host.isLoggedIn()) return;
    api.voices()
      .then((voices) => {
        this.setData({ voices: (Array.isArray(voices) ? voices : []).filter((item) => item.status === 'ready') });
        this.applyVoiceChoices();
      })
      .catch(() => {});
  },

  /**
   * 读四档单价。**两种失败必须分开**，否则发版顺序上会踩空：
   *
   * - 404 = 服务端还没上计费这一版。小程序要过审、服务端是脚本发布，两者无法同时到位，
   *   所以只能「小程序先发、服务端后发」。这段时间里后端根本不收钱、也不校验确认报价——
   *   把用户挡在提交之外会让这个唯一可行的发版顺序变成「克隆全挂」。
   * - 其它失败（网络 / 5xx）= 服务端可能是要收钱的，只是这次没读到。必须挡住：
   *   不知道要扣多少就提交，等于回到「界面没说、系统照扣」。
   *
   * 两种情况下 pricing 都保持 null，界面一律不显示价格，而不是显示 0 或编一个数字。
   */
  loadPricing() {
    api.clonePricing()
      .then((pricing) => {
        this.setData({ pricing: pricing || null, pricingUnavailable: false });
        this.applyVoiceChoices();
      })
      .catch((error) => this.setData({ pricingUnavailable: !!(error && error.statusCode === 404) }));
  },

  /**
   * 免费重训余额。读失败就保持空串、整行不渲染 —— 不许退化成一个编出来的默认数字，
   * 那会让用户以为自己还有免费额度。
   */
  loadRetrainQuota() {
    if (!this.data.retrainVoiceId || !host.isLoggedIn()) return;
    api.retrainQuota(this.data.retrainVoiceId)
      .then((quota) => {
        const state = model.retrainQuotaState(quota);
        this.setData({ retrainQuotaText: state.text, retrainBlocked: state.blocked });
      })
      .catch(() => {});
  },

  /**
   * 显式改成「新建一条声音」。
   *
   * ★ 绝不自动改：重训 60、新建 200，价格差三倍多，替用户切等于替他花钱。
   *   额度用尽时只挡住提交并把原因说清，改不改由他按这个按钮决定。
   */
  switchToNewVoice() {
    this.setData(Object.assign(
      { retrainVoiceId: '', retrainBlocked: false, retrainQuotaText: '' },
      this.chargeState(this.data.selectedVoiceId),
    ));
    host.toast('已改为新建一条声音');
  },

  changeAvatarName(event) { this.setData({ avatarName: String(event.detail.value || '').slice(0, 20) }); },
  /**
   * 选关联声音。一旦用户自己点过，就不再让后到的默认值覆盖他的选择（见 applyVoiceChoices）。
   * 主动选「视频原声」= 主动选择新训练一条，这里明确提示要扣多少 —— 花钱的路径不许静默发生。
   */
  chooseExistingVoice(event) {
    const id = String(event.currentTarget.dataset.id || '');
    this.voiceTouched = true;
    // ★ 账单必须跟着选择走。少了这一步，用户从「复用」切到「视频原声」之后，
    //   明细还写着「关联已有声音 · 不额外扣费」——正是这次要消灭的那种不透明。
    //   （同类回归见 d70e1bb：结算按钮价格没跟着档位走。）
    //   这里显式用新的 id 算，不依赖 setData 之后 this.data 是否已经刷新。
    this.setData(Object.assign({ selectedVoiceId: id }, this.chargeState(id)));
    if (!id && this.data.hasReusableVoice) {
      const cost = this.data.voiceCostText;
      host.toast(cost ? `会新训练一条声音，扣 ${cost}` : '会新训练一条声音');
    }
  },

  loadNotificationTemplate() {
    if (api.isMock()) return;
    api.subscribeTemplates()
      .then((result) => {
        const scenes = result && Array.isArray(result.scenes) ? result.scenes : [];
        const template = scenes.find((item) => item && item.scene === 'avatar') || null;
        this.setData({ notificationTemplate: template });
      })
      .catch(() => {});
  },

  captureRule(kind) { return (this.data.requirements && this.data.requirements[kind]) || FALLBACK_REQUIREMENTS[kind]; },

  validateCapture(kind, file) {
    const rule = this.captureRule(kind);
    const duration = Number(file && file.duration) || 0;
    const size = Number(file && (file.size || file.fileSize)) || 0;
    const label = kind === 'voice' ? '录音' : '形象视频';
    if (duration > 0 && duration < rule.minDurationSec) {
      host.toast(`${label}至少要 ${rule.minDurationSec} 秒`); return false;
    }
    if (duration > rule.maxDurationSec) {
      host.toast(`${label}不能超过 ${rule.maxDurationSec} 秒`); return false;
    }
    if (size > 0 && size > rule.maxBytes) {
      host.toast(`${label}文件太大，请降低清晰度后重录`); return false;
    }
    return true;
  },

  /* ── 可选增强：单独采集专属声音 ── */

  toggleRecord() {
    if (this.data.recording) { this.stopRecorder(); return; }
    if (this.data.startingRecord) return;
    this.requestRecordPermission();
  },

  requestRecordPermission() {
    const begin = () => this.startRecorder();
    if (typeof wx.getSetting !== 'function' || typeof wx.authorize !== 'function') { begin(); return; }
    // 微信隐私新规：scope.record 属于隐私接口。小程序后台配了「用户隐私保护指引」之后，
    // 未先过 requirePrivacyAuthorize 就调 authorize/录音，在部分基础库上会直接失败且不弹窗
    // —— 表现就是「点了没反应」。本方法在旧基础库上不存在，必须特性检测后再调。
    const afterPrivacy = () => {
      wx.getSetting({
        success: (result) => {
          const state = result && result.authSetting && result.authSetting['scope.record'];
          if (state === true) { begin(); return; }
          if (state === false) { this.openRecordSettings(); return; }
          wx.authorize({
            scope: 'scope.record',
            success: begin,
            fail: () => this.openRecordSettings(),
          });
        },
        fail: () => host.toast('无法读取麦克风权限，请稍后重试'),
      });
    };
    if (typeof wx.requirePrivacyAuthorize !== 'function') { afterPrivacy(); return; }
    wx.requirePrivacyAuthorize({
      success: afterPrivacy,
      // 用户拒绝隐私协议：不是错误，静默回到未录音态即可
      fail: () => host.toast('需要同意隐私协议后才能录音'),
    });
  },

  openRecordSettings() {
    host.confirm({ title: '需要麦克风权限', content: '打开麦克风权限后，才能录制并克隆你的声音。', confirmText: '去设置' })
      .then((ok) => {
        if (!ok) return;
        wx.openSetting({
          success: (result) => {
            if (result && result.authSetting && result.authSetting['scope.record']) {
              host.toast('麦克风已开启，请再点一次开始录制', 'success');
            }
          },
        });
      });
  },

  /**
   * 绑定录音回调。**只绑一次**。
   *
   * `wx.getRecorderManager()` 返回全局单例，且 RecorderManager **没有 offStart/offStop/offError**
   * （文档里只有 on* 系列）。原先每次 startRecorder 都 on 一遍，等于不断往同一个单例上叠监听器：
   * 录第二段时 onStop 会触发两次，第三段三次，后面的回调拿着过期的 this.data 互相覆盖。
   * 改成绑一次 + 通过实例字段分发。
   */
  ensureRecorderBound() {
    if (this.recorder) return this.recorder;
    const manager = wx.getRecorderManager();
    this.recorder = manager;
    manager.onStart(() => {
      this.stopRecordStartTimer();
      this.setData({ startingRecord: false, recording: true, recordSeconds: 0, voiceFile: null, voiceSubmitted: false });
      this.stopRecordTimer();
      this.recordTimer = setInterval(() => this.setData({ recordSeconds: this.data.recordSeconds + 1 }), 1000);
    });
    manager.onStop((res) => {
      this.stopRecordStartTimer();
      this.stopRecordTimer();
      const file = { path: res.tempFilePath, duration: (res.duration || 0) / 1000, size: res.fileSize || 0, source: 'record' };
      if (!this.validateCapture('voice', file)) { this.setData({ recording: false, voiceFile: null }); return; }
      this.setData({ recording: false, voiceFile: file, voiceSubmitted: false });
    });
    manager.onError((error) => {
      this.stopRecordStartTimer();
      this.stopRecordTimer();
      this.setData({ startingRecord: false, recording: false });
      const message = String(error && (error.errMsg || error.message) || '');
      if (/auth|deny|permission|privacy/i.test(message)) { this.openRecordSettings(); return; }
      host.toast(message ? `录音失败：${message.slice(0, 40)}` : '录音失败，请重试');
    });
    // 来电/切后台会中断录音，不处理的话 UI 会一直停在「正在录」
    if (typeof manager.onInterruptionBegin === 'function') {
      manager.onInterruptionBegin(() => {
        this.stopRecordTimer();
        this.setData({ startingRecord: false, recording: false });
        host.toast('录音被系统打断了，请重新录一段');
      });
    }
    return manager;
  },

  startRecorder() {
    const manager = this.ensureRecorderBound();
    this.setData({ startingRecord: true });
    this.stopRecordStartTimer();
    this.recordStartTimer = setTimeout(() => {
      if (!this.data.startingRecord) return;
      this.setData({ startingRecord: false, recording: false });
      host.toast('麦克风启动超时，请检查权限后重试');
    }, 5000);
    try {
      manager.start({
        duration: Math.min(120, this.captureRule('voice').maxDurationSec) * 1000,
        // aac 是 RecorderManager 的默认且各端最稳的格式；mp3 在部分 iOS 基础库上录不出东西。
        // 服务端白名单已含 audio/aac 与 audio/mp4(m4a)，且改为按魔数判型，不依赖扩展名。
        format: 'aac',
        sampleRate: 44100,
        numberOfChannels: 1,
        // 必须显式给码率。微信的合法 encodeBitRate 区间**由 sampleRate 决定**，
        // 44100 对应 64000–320000；而不传时的默认值是 48000，低于下限 —— 直接
        // 报 `invalid encodeBitRate "48000"`，录音根本起不来（预发实测到的就是这条）。
        encodeBitRate: 96000,
      });
    } catch (error) {
      this.stopRecordStartTimer();
      this.setData({ startingRecord: false, recording: false });
      host.toast(error && error.message ? error.message : '录音启动失败');
    }
  },

  stopRecorder() { if (this.recorder && this.data.recording) this.recorder.stop(); },
  stopRecordStartTimer() { if (this.recordStartTimer) { clearTimeout(this.recordStartTimer); this.recordStartTimer = null; } },
  stopRecordTimer() { if (this.recordTimer) { clearInterval(this.recordTimer); this.recordTimer = null; } },

  pickVoice() {
    if (this.data.recording) this.stopRecorder();
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['mp3', 'wav', 'm4a', 'aac', 'ogg'],
      success: (res) => {
        const item = res.tempFiles && res.tempFiles[0];
        if (!item) return;
        const file = { path: item.path || item.tempFilePath, duration: 0, size: item.size || 0, name: item.name || '已选音频', source: 'file' };
        if (!this.validateCapture('voice', file)) return;
        this.setData({ voiceFile: file, voiceSubmitted: false, recordSeconds: 0 });
      },
      fail: (error) => {
        if (String(error && error.errMsg || '').indexOf('cancel') >= 0) return;
        host.toast('选择音频失败');
      },
    });
  },

  retakeVoice() { this.setData({ voiceFile: null, voiceSubmitted: false, recordSeconds: 0 }); },

  /**
   * 本次提交的幂等标识。训练要预扣钻石，所以「同一次提交重试」和「换一单重来」必须能区分：
   * 前者复用同一个 id（服务端据此不重复扣），后者必须换新 id。
   *
   * ★ 标识由「素材路径 + 报价」派生，而不是在各个素材变更处手动清空 —— 那种写法漏掉任何一处，
   *   都会让新录的素材复用旧标识，于是服务端把上一单的结果幂等地原样返回：用户以为新素材训好了，
   *   其实压根没提交。报价也计入，是因为用户改了「复用/新训」选择后价格会变，
   *   沿用旧标识只会撞上 409 报价冲突，而他其实是想重新下一单。
   */
  ensureCloneRequestId(filePath) {
    const key = `${filePath || ''}|${this.data.expectedCredits}`;
    if (this.cloneRequestKey !== key) { this.cloneRequestKey = key; this.cloneRequestId = ''; }
    if (!this.cloneRequestId) {
      this.cloneRequestId = `clip-clone:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    }
    return this.cloneRequestId;
  },

  /** 价格没读到就不许提交 —— 服务端要求带确认报价，硬编个 0 上去只会换来一个看不懂的 409。 */
  assertQuoteReady() {
    // 服务端没有计费这一版：它不收钱、也不要求确认报价，不该拦。
    if (this.data.pricingUnavailable) return true;
    if (this.data.expectedCredits == null) {
      host.toast('还没拿到训练价格，请稍后重试');
      this.loadPricing();
      return false;
    }
    return true;
  },

  /**
   * 提交失败的统一收尾。
   * - 余额不足（402）：直接引到充值，而不是甩一句「提交失败」。
   * - 服务端给了明确判决（有 statusCode）：这个请求标识作废，下次点是新的一单。
   * - 纯网络失败（没有 statusCode）：保留标识，重试才能被服务端识别为同一次提交、不重复扣费。
   */
  handleCloneError(error, fallbackMessage) {
    this.setData({ submitting: false });
    if (error && error.statusCode) this.cloneRequestId = '';
    if (error && error.code === 'INSUFFICIENT_CREDITS') {
      host.confirm({
        title: '钻石不够',
        content: `这次训练需要 ${this.data.expectedCredits} 钻石。去充值吗？`,
        confirmText: '去充值',
      }).then((ok) => { if (ok) host.goHost('/packages/work/credits/index'); });
      return;
    }
    host.toast(error && error.message ? error.message : fallbackMessage);
  },

  submitVoice() {
    if (!this.data.voiceFile) { host.toast('先录一段声音或上传音频'); return; }
    if (this.data.submitting) return;
    // 上游重训额度用尽会直接报错（不再回落成新建），所以这里提前挡住，别让用户白等一次上传。
    if (this.data.retrainBlocked) { host.toast(this.data.retrainQuotaText || '这条声音无法重新训练'); return; }
    if (!this.assertQuoteReady()) return;
    this.setData({ submitting: true });
    api.startClone('voice', {
      filePath: this.data.voiceFile.path,
      avatarId: this.data.avatarId,
      // 非空 = 重训这一条已有声音：供应商每条给 4 次免费重训，且不消耗新的克隆权益。
      // 少了这个字段，每次「重新录制」都会新建一条 speaker，把账户的克隆权益烧光。
      voiceId: this.data.retrainVoiceId,
      clientRequestId: this.ensureCloneRequestId(this.data.voiceFile.path),
      expectedCredits: this.data.expectedCredits,
    })
      .then(() => this.enterTraining())
      .catch((error) => this.handleCloneError(error, '声音提交失败'));
  },

  /* ── 第 1 步：一段视频创建数字人 ── */

  recordFace() { this.chooseFace('camera'); },
  pickFace() { this.chooseFace('album'); },

  chooseFace(sourceType) {
    host.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: [sourceType],
      // ★ 上传分辨率 = 成片分辨率（石榴技术 2026-08-13 明确）。不写 sizeType 时微信默认
      //   ['original','compressed'] 并**实际取压缩版**，等于在源头把成片画质砍掉。
      //   sizeType 对视频是否生效：**生效**。依据是官方 API 定义（本仓库 vendored 的
      //   miniprogram-api-typings@3.12.3，由官方文档生成）对 ChooseMediaOption.sizeType 的原文：
      //   「是否压缩所选文件，基础库 2.25.0 前仅对 mediaType 为 image 时有效，2.25.0 及以后对全量
      //   mediaType 有效」。本项目 project.config.json 的 libVersion 是 3.16.2，远高于 2.25.0，
      //   所以这里对 mediaType:['video'] 是有效参数，不是只对图片生效的摆设。
      //   注意它只是「别再压一道」，拿不到比用户源文件更高的分辨率；真实宽高以回调里的
      //   width/height 为准（下面带上去给服务端），不要靠这个参数反推画质。
      sizeType: ['original'],
      maxDuration: Math.min(60, this.captureRule('avatar').maxDurationSec),
      camera: 'front',
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        if (!this.validateCapture('avatar', file)) return;
        this.setData({
          faceFile: Object.assign(
            { path: file.tempFilePath, duration: file.duration || 0, size: file.size || 0 },
            mediaDimensions(file),
          ),
        });
      },
      fail: (error) => {
        if (String(error && error.errMsg || '').indexOf('cancel') >= 0) return;
        host.toast(sourceType === 'camera' ? '打开相机失败' : '选择视频失败');
      },
    });
  },

  retakeFace() { this.setData({ faceFile: null }); },
  toggleAgree() { this.setData({ agreed: !this.data.agreed }); },

  openUsageDoc() {
    host.alert({
      title: '数字分身素材使用说明',
      content: '请只上传你本人或已经获得合法使用权的声音和视频。素材仅用于你的账号创建、训练和使用数字分身；你可以在分身管理中随时删除，删除后停止新的生成。',
    });
  },

  submitAvatar() {
    if (!this.data.faceFile) { host.toast('先录一段或从相册选一个视频'); return; }
    if (!this.data.agreed) { host.toast('请先确认素材使用权'); return; }
    if (this.data.submitting) return;
    if (!this.assertQuoteReady()) return;
    this.setData({ submitting: true });
    api.startClone('avatar', {
      filePath: this.data.faceFile.path,
      avatarId: this.data.avatarId,
      voiceId: this.data.selectedVoiceId,
      // 没选已有声音 = 用户选的是「视频原声」。显式传，服务端才不会回退到该形象原先关联的声音。
      voiceSource: this.data.selectedVoiceId ? 'existing' : 'video',
      name: this.data.avatarName,
      clientRequestId: this.ensureCloneRequestId(this.data.faceFile.path),
      expectedCredits: this.data.expectedCredits,
    })
      .then((result) => {
        if (result && result.avatarId) this.setData({ avatarId: result.avatarId });
        this.enterTraining();
      })
      .catch((error) => this.handleCloneError(error, '形象提交失败'));
  },

  /* ── 第 2 步：训练 ── */

  enterTraining() {
    this.setData({
      submitting: false,
      step: 2,
      training: initialTraining(this.data.mode),
    });
    this.loadNotificationTemplate();
    this.startTrainingPolling();
  },

  pollTraining() {
    (this.data.avatarId ? api.avatarById(this.data.avatarId) : api.avatar())
      .then((avatar) => {
        const imageDone = avatar && avatar.imageStatus === 'ready';
        const voiceDone = avatar && avatar.voiceStatus === 'ready';
        const imageFailed = avatar && avatar.imageStatus === 'failed';
        const voiceFailed = avatar && avatar.voiceStatus === 'failed';
        const imageProgress = imageDone ? 100 : Math.max(0, Number(avatar && avatar.imageProgress) || 0);
        const voiceProgress = voiceDone ? 100 : Math.max(0, Number(avatar && avatar.voiceProgress) || 0);
        const voiceOnly = this.data.mode === 'voice';
        const mainProgress = voiceOnly ? voiceProgress : imageProgress;
        const mainFailed = voiceOnly ? voiceFailed : imageFailed;
        const mainDone = voiceOnly ? voiceDone : imageDone;
        this.setData({
          presetAvailable: Boolean(avatar && avatar.presetAvailable),
          training: Object.assign({}, this.data.training, {
            imageDone, voiceDone,
            percent: mainProgress,
            imageStateText: imageDone ? '完成' : (imageFailed ? (avatar.imageMessage || '需要重新采集') : `${imageProgress}%`),
            voiceStateText: voiceDone ? '完成' : (voiceFailed ? (avatar.voiceMessage || '需要重新录制') : `${voiceProgress}%`),
            imageFailed, voiceFailed, hasFailure: Boolean(mainFailed),
          }),
        });
        if (mainDone || mainFailed) this.stopTrainingPolling();
      })
      .catch(() => {});
  },

  startTrainingPolling() {
    this.stopTrainingPolling();
    this.pollTraining();
    const interval = Math.max(3000, Math.min(15000, Number(this.data.requirements && this.data.requirements.pollIntervalMs) || POLL_INTERVAL_MS));
    this.trainingTimer = setInterval(() => this.pollTraining(), interval);
  },

  stopTrainingPolling() {
    if (this.trainingTimer) { clearInterval(this.trainingTimer); this.trainingTimer = null; }
  },

  usePreset() { host.toast('先用平台预置形象出片'); host.go('home/index'); },
  leaveTraining() {
    if (this.data.notificationRequesting) return;
    if (this.data.mode === 'voice') {
      host.toast('声音会在后台继续训练');
      setTimeout(() => host.go('avatar/index'), 500);
      return;
    }
    if (api.isMock()) {
      host.toast('训练会在后台继续');
      setTimeout(() => host.go('home/index'), 500);
      return;
    }
    const template = this.data.notificationTemplate;
    if (!template || !template.templateId) {
      this.loadNotificationTemplate();
      host.toast('通知服务正在准备，请稍后再点');
      return;
    }
    this.setData({ notificationRequesting: true });
    wx.requestSubscribeMessage({
      tmplIds: [template.templateId],
      success: (result) => {
        const raw = result && result[template.templateId];
        const status = ['accept', 'reject', 'ban', 'filter'].includes(raw) ? raw : 'reject';
        api.recordSubscribeChoice({ scene: 'avatar', templateId: template.templateId, status })
          .catch(() => null)
          .then(() => {
            this.setData({ notificationRequesting: false });
            host.toast(status === 'accept' ? '训练好会用微信通知你' : '训练会继续，本次不发微信通知');
            setTimeout(() => host.go('home/index'), 700);
          });
      },
      fail: () => {
        this.setData({ notificationRequesting: false });
        host.toast('未开启微信通知，训练会继续');
        setTimeout(() => host.go('home/index'), 700);
      },
    });
  },
  retryImage() { this.setData({ mode: 'avatar', step: 1, recaptureKind: 'avatar', faceFile: null, agreed: false, training: null }); },
  retryVoice() { this.setData({ mode: 'voice', step: 1, recaptureKind: 'voice', voiceFile: null, voiceSubmitted: false, recordSeconds: 0, training: null }); },

  back() {
    host.back();
  },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.loadNotificationTemplate(); this.loadVoices(); },
});
