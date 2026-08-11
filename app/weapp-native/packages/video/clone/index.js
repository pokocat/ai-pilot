// 屏 04 · 数字分身克隆向导。四步在一页内切：授权核验 → 形象采集 → 声音采集 → 训练中。
//
// ⚠️ 这是全产品**法律风险最高**的一条链路（方案 §9.3）。三条硬规矩：
//   1. 授权核验是硬闸 —— 没过不许进形象采集。拿他人照片/声音克隆是本产品最大风险点。
//   2. 我们自己要另留一份 consent 快照，**不能只依赖上游**（石榴的 Create Authorization Video）。
//   3. 「可随时删除」必须在这一屏就告诉用户，不能等到分身管理页才提。
//
// 采集能力（wx.chooseMedia 录像 / 录音管理器）都是军师主包从未用过的新增面，真机两端各验一次。
const host = require('../host');
const api = require('../api');
const { POLL_INTERVAL_MS } = require('../config');

const STEPS = [
  { no: 1, key: 'consent', label: '授权' },
  { no: 2, key: 'face', label: '形象' },
  { no: 3, key: 'voice', label: '声音' },
  { no: 4, key: 'training', label: '训练' },
];

/** 约 10 秒的自然朗读稿；石榴硬限制是 >2 秒，较长时长只作质量建议。 */
const READING_SCRIPT = '我一直认真做着自己的事，也愿意把真实的经验分享给你。以后，就让这个数字分身用我平时说话的声音，讲更多值得讲的故事。';
const CONSENT_SCRIPT = '我是本次出镜者本人，特此声明，我授权军师参谋部使用我提交的视频和声音资料，为我的账号创建数字分身，并仅在我的账号中使用它。';
const FALLBACK_REQUIREMENTS = {
  consentText: CONSENT_SCRIPT, pollIntervalMs: POLL_INTERVAL_MS,
  consent: { vendorMinDurationSec: 5, vendorMaxDurationSec: 300, minDurationSec: 5, recommendedMinDurationSec: 8, recommendedMaxDurationSec: 20, maxDurationSec: 30, vendorMaxBytes: 200 * 1024 * 1024, maxBytes: 100 * 1024 * 1024, vendorFormats: ['mp4', 'mov'], formats: ['mp4', 'mov'] },
  avatar: { vendorMinDurationSec: 5, vendorMaxDurationSec: 300, minDurationSec: 5, recommendedMinDurationSec: 10, recommendedMaxDurationSec: 20, maxDurationSec: 300, vendorMaxBytes: 200 * 1024 * 1024, maxBytes: 100 * 1024 * 1024, vendorFormats: ['mp4', 'mov'], formats: ['mp4', 'mov'] },
  voice: { vendorMinDurationSec: 2, vendorMaxDurationSec: 0, minDurationSec: 3, recommendedMinDurationSec: 8, recommendedMaxDurationSec: 15, maxDurationSec: 120, vendorMaxBytes: 20 * 1024 * 1024, maxBytes: 20 * 1024 * 1024, vendorFormats: ['wav', 'mp3', 'ogg', 'm4a', 'aac', 'pcm'], formats: ['wav', 'mp3', 'ogg', 'm4a', 'aac'] },
};

Page({
  data: host.hostBaseData({
    steps: STEPS,
    step: 1,
    agreed: false,
    consentScript: CONSENT_SCRIPT,
    requirements: FALLBACK_REQUIREMENTS,
    requirementsReady: false,
    consentFile: null,
    /** 形象采集结果 */
    faceFile: null,
    /** 声音采集 */
    readingScript: READING_SCRIPT,
    recording: false,
    recordSeconds: 0,
    voiceFile: null,
    /** 训练态 */
    training: null,
    recaptureKind: null,
    presetAvailable: api.isMock(),
    submitting: false,
    showLogin: false,
  }),

  onLoad(options) {
    const opts = options || {};
    const step = Number(opts.step || 1);
    // 只有已存在分身的「重新采集」才能跳过首次授权页；普通路由参数不能绕过本人核验。
    if (String(opts.recapture || '') === '1' && (step === 2 || step === 3) && host.isLoggedIn()) {
      api.avatar().then((avatar) => {
        if (avatar) this.setData({ step, agreed: true, recaptureKind: step === 2 ? 'avatar' : 'voice' });
      }).catch(() => {});
    }
    if (!host.isLoggedIn()) this.setData({ showLogin: true });
    this.loadRequirements();
  },

  onShow() {
    if (this.data.step === 4 && !this.trainingTimer) this.startTrainingPolling();
  },
  onHide() { this.stopTrainingPolling(); },
  onUnload() { this.stopTrainingPolling(); this.stopRecordTimer(); this.stopRecorder(); },

  /* ── 第 1 步：授权核验 ── */

  loadRequirements() {
    api.avatarRequirements()
      .then((requirements) => {
        if (!requirements || !requirements.consentText) return;
        this.setData({ requirements, requirementsReady: true, consentScript: requirements.consentText });
      })
      .catch(() => this.setData({ requirementsReady: true }));
  },

  captureRule(kind) { return (this.data.requirements && this.data.requirements[kind]) || FALLBACK_REQUIREMENTS[kind]; },

  validateCapture(kind, file) {
    const rule = this.captureRule(kind);
    const duration = Number(file && file.duration) || 0;
    const size = Number(file && (file.size || file.fileSize)) || 0;
    const label = kind === 'voice' ? '录音' : (kind === 'consent' ? '授权视频' : '形象视频');
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

  toggleAgree() { this.setData({ agreed: !this.data.agreed }); },

  openConsentDoc() {
    host.alert({
      title: '数字分身本人授权书',
      content: '你授权军师参谋部仅为你本人创建、训练和使用数字分身；系统会记录授权时间、用途与撤回状态。你可随时在分身管理中删除，删除后停止新的生成与发布。',
    });
  },

  startFaceVerify() {
    if (!this.data.agreed) { host.toast('请先阅读并同意授权书'); return; }
    if (!host.requireLogin(this, 'execute')) return;
    if (this.data.submitting) return;
    host.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['camera'],
      maxDuration: 20,
      camera: 'front',
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        if (!this.validateCapture('consent', file)) return;
        this.setData({ submitting: true, consentFile: { path: file.tempFilePath, duration: file.duration || 0, size: file.size || 0 } });
        host.loading('正在核验本人授权');
        api.startConsent({ filePath: file.tempFilePath, text: this.data.consentScript })
          .then((result) => {
            host.hideLoading();
            this.setData({ submitting: false });
            if (!result || (result.accepted !== true && result.verified !== true && !['submitted', 'verified'].includes(result.status))) {
              throw Object.assign(new Error('授权视频未被受理，请按提示重新录制'), { code: 'CLIP_CONSENT_NOT_ACCEPTED' });
            }
            this.setData({ step: 2 });
          })
          .catch((error) => {
            host.hideLoading();
            this.setData({ submitting: false });
            host.toast(error && error.message ? error.message : '本人核验失败');
          });
      },
      fail: (error) => {
        if (String(error && error.errMsg || '').indexOf('cancel') >= 0) return;
        host.toast('打开相机失败');
      },
    });
  },

  /* ── 第 2 步：形象采集 ── */

  recordFace() { this.chooseFace('camera'); },
  pickFace() { this.chooseFace('album'); },

  chooseFace(sourceType) {
    host.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: [sourceType],
      maxDuration: Math.min(60, this.captureRule('avatar').maxDurationSec),
      camera: 'front',
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        if (!this.validateCapture('avatar', file)) return;
        this.setData({ faceFile: { path: file.tempFilePath, duration: file.duration || 0, size: file.size || 0 } });
      },
      fail: (error) => {
        if (String(error && error.errMsg || '').indexOf('cancel') >= 0) return;
        host.toast('打开相机失败');
      },
    });
  },

  retakeFace() { this.setData({ faceFile: null }); },
  nextFromFace() {
    if (!this.data.faceFile) { host.toast('先录一段或从相册选一个'); return; }
    if (this.data.recaptureKind === 'avatar') { this.submitOne('avatar'); return; }
    this.setData({ step: 3 });
  },

  /* ── 第 3 步：声音采集 ── */

  toggleRecord() {
    if (this.data.recording) { this.stopRecorder(); return; }
    this.startRecorder();
  },

  startRecorder() {
    const manager = wx.getRecorderManager();
    this.recorder = manager;
    manager.onStop((res) => {
      this.stopRecordTimer();
      const file = { path: res.tempFilePath, duration: (res.duration || 0) / 1000, size: res.fileSize || 0 };
      if (!this.validateCapture('voice', file)) { this.setData({ recording: false, voiceFile: null }); return; }
      this.setData({ recording: false, voiceFile: file });
    });
    manager.onError((error) => {
      this.stopRecordTimer();
      this.setData({ recording: false });
      const message = String(error && (error.errMsg || error.message) || '');
      if (/auth|deny|permission/i.test(message)) {
        host.confirm({ title: '需要麦克风权限', content: '去设置里打开麦克风权限后，就能录制你的声音。', confirmText: '去设置' })
          .then((ok) => { if (ok) wx.openSetting({}); });
        return;
      }
      host.toast('录音失败');
    });
    manager.start({ duration: Math.min(120, this.captureRule('voice').maxDurationSec) * 1000, format: 'mp3', sampleRate: 44100, numberOfChannels: 1 });
    this.setData({ recording: true, recordSeconds: 0, voiceFile: null });
    this.recordTimer = setInterval(() => this.setData({ recordSeconds: this.data.recordSeconds + 1 }), 1000);
  },

  stopRecorder() { if (this.recorder && this.data.recording) this.recorder.stop(); },
  stopRecordTimer() { if (this.recordTimer) { clearInterval(this.recordTimer); this.recordTimer = null; } },

  retakeVoice() { this.setData({ voiceFile: null, recordSeconds: 0 }); },

  /* ── 提交训练 ── */

  submit() {
    if (!this.data.voiceFile) { host.toast('先录一段你的声音'); return; }
    if (this.data.recaptureKind === 'voice') { this.submitOne('voice'); return; }
    if (!this.data.faceFile) { host.toast('先采集你的形象'); return; }
    if (this.data.submitting) return;
    this.setData({ submitting: true });

    api.startClone('voice', { filePath: this.data.voiceFile.path })
      .then(() => api.startClone('avatar', { filePath: this.data.faceFile && this.data.faceFile.path }))
      .then(() => this.enterTraining())
      .catch((error) => {
      this.setData({ submitting: false });
      host.toast(error && error.message ? error.message : '提交失败');
    });
  },

  submitOne(kind) {
    if (this.data.submitting) return;
    const file = kind === 'avatar' ? this.data.faceFile : this.data.voiceFile;
    if (!file || !file.path) { host.toast(kind === 'avatar' ? '先拍一段形象视频' : '先录一段你的声音'); return; }
    this.setData({ submitting: true });
    api.startClone(kind, { filePath: file.path })
      .then(() => this.enterTraining())
      .catch((error) => {
        this.setData({ submitting: false });
        host.toast(error && error.message ? error.message : '提交失败');
      });
  },

  enterTraining() {
    this.setData({
      submitting: false,
      step: 4,
      training: { percent: 0, etaText: '训练在云端继续，完成后可以直接出片', imageDone: false, voiceDone: false, imageStateText: '读取中', voiceStateText: '读取中', hasFailure: false },
    });
    this.startTrainingPolling();
  },

  pollTraining() {
    api.avatar()
      .then((avatar) => {
        const imageDone = avatar && avatar.imageStatus === 'ready';
        const voiceDone = avatar && avatar.voiceStatus === 'ready';
        const imageFailed = avatar && avatar.imageStatus === 'failed';
        const voiceFailed = avatar && avatar.voiceStatus === 'failed';
        const imageProgress = imageDone ? 100 : Math.max(0, Number(avatar && avatar.imageProgress) || 0);
        const voiceProgress = voiceDone ? 100 : Math.max(0, Number(avatar && avatar.voiceProgress) || 0);
        this.setData({
          presetAvailable: Boolean(avatar && avatar.presetAvailable),
          training: Object.assign({}, this.data.training, {
            imageDone, voiceDone,
            percent: Math.round((imageProgress + voiceProgress) / 2),
            imageStateText: imageDone ? '完成' : (imageFailed ? (avatar.imageMessage || '需要重新采集') : `${imageProgress}%`),
            voiceStateText: voiceDone ? '完成' : (voiceFailed ? (avatar.voiceMessage || '需要重新录制') : `${voiceProgress}%`),
            imageFailed, voiceFailed, hasFailure: Boolean(imageFailed || voiceFailed),
          }),
        });
        if ((imageDone && voiceDone) || imageFailed || voiceFailed) this.stopTrainingPolling();
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

  /* ── 训练中的两个出口 ── */

  usePreset() {
    host.toast('先用平台预置形象出片');
    host.go('home/index');
  },

  leaveTraining() { host.go('home/index'); },
  retryImage() { this.setData({ step: 2, recaptureKind: 'avatar', faceFile: null, training: null }); },
  retryVoice() { this.setData({ step: 3, recaptureKind: 'voice', voiceFile: null, recordSeconds: 0, training: null }); },

  back() {
    if (this.data.step > 1 && this.data.step < 4) { this.setData({ step: this.data.step - 1 }); return; }
    host.back();
  },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); },
});
