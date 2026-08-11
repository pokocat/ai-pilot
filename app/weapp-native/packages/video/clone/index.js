// 屏 04 · 视频数字分身创建。按石榴真实能力组织为：声音克隆 → 形象视频 → 云端训练。
//
// 石榴 avatar/create 的 authId 是可选校验项，不再把“另录一段授权视频”做成创建硬闸。
// 用户只需确认自己对上传的声音和视频有合法使用权，并且始终可以删除分身。
const host = require('../host');
const api = require('../api');
const { POLL_INTERVAL_MS } = require('../config');

const STEPS = [
  { no: 1, key: 'voice', label: '声音' },
  { no: 2, key: 'avatar', label: '形象' },
  { no: 3, key: 'training', label: '训练' },
];

/** 录音时页面保持可见，用户可以直接照读。 */
const READING_SCRIPT = '我一直认真做着自己的事，也愿意把真实的经验分享给你。以后，就让这个数字分身用我平时说话的声音，讲更多值得讲的故事。';
const FALLBACK_REQUIREMENTS = {
  authorizationVideoRequired: false,
  pollIntervalMs: POLL_INTERVAL_MS,
  avatar: { vendorMinDurationSec: 5, vendorMaxDurationSec: 300, minDurationSec: 5, recommendedMinDurationSec: 10, recommendedMaxDurationSec: 20, maxDurationSec: 300, vendorMaxBytes: 200 * 1024 * 1024, maxBytes: 100 * 1024 * 1024, vendorFormats: ['mp4', 'mov'], formats: ['mp4', 'mov'] },
  voice: { vendorMinDurationSec: 2, vendorMaxDurationSec: 0, minDurationSec: 3, recommendedMinDurationSec: 8, recommendedMaxDurationSec: 15, maxDurationSec: 120, vendorMaxBytes: 20 * 1024 * 1024, maxBytes: 20 * 1024 * 1024, vendorFormats: ['wav', 'mp3', 'ogg', 'm4a', 'aac', 'pcm'], formats: ['wav', 'mp3', 'ogg', 'm4a', 'aac'] },
};

Page({
  data: host.hostBaseData({
    steps: STEPS,
    step: 1,
    agreed: false,
    requirements: FALLBACK_REQUIREMENTS,
    requirementsReady: false,
    readingScript: READING_SCRIPT,
    recording: false,
    recordSeconds: 0,
    voiceFile: null,
    voiceSubmitted: false,
    faceFile: null,
    training: null,
    recaptureKind: null,
    presetAvailable: api.isMock(),
    submitting: false,
    showLogin: false,
  }),

  onLoad(options) {
    const opts = options || {};
    const step = Number(opts.step || 1);
    if (String(opts.recapture || '') === '1' && (step === 1 || step === 2) && host.isLoggedIn()) {
      api.avatar().then((avatar) => {
        if (avatar) this.setData({ step, recaptureKind: step === 1 ? 'voice' : 'avatar' });
      }).catch(() => {});
    }
    if (!host.isLoggedIn()) this.setData({ showLogin: true });
    this.loadRequirements();
  },

  onShow() {
    if (this.data.step === 3 && !this.trainingTimer) this.startTrainingPolling();
  },
  onHide() { this.stopTrainingPolling(); },
  onUnload() { this.stopTrainingPolling(); this.stopRecordTimer(); this.stopRecorder(); },

  loadRequirements() {
    api.avatarRequirements()
      .then((requirements) => {
        if (!requirements || !requirements.avatar || !requirements.voice) return;
        this.setData({ requirements, requirementsReady: true });
      })
      .catch(() => this.setData({ requirementsReady: true }));
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

  /* ── 第 1 步：声音克隆 ── */

  toggleRecord() {
    if (this.data.recording) { this.stopRecorder(); return; }
    this.startRecorder();
  },

  startRecorder() {
    const manager = wx.getRecorderManager();
    this.recorder = manager;
    if (typeof manager.offStop === 'function') manager.offStop();
    if (typeof manager.offError === 'function') manager.offError();
    manager.onStop((res) => {
      this.stopRecordTimer();
      const file = { path: res.tempFilePath, duration: (res.duration || 0) / 1000, size: res.fileSize || 0, source: 'record' };
      if (!this.validateCapture('voice', file)) { this.setData({ recording: false, voiceFile: null }); return; }
      this.setData({ recording: false, voiceFile: file, voiceSubmitted: false });
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
    this.setData({ recording: true, recordSeconds: 0, voiceFile: null, voiceSubmitted: false });
    this.recordTimer = setInterval(() => this.setData({ recordSeconds: this.data.recordSeconds + 1 }), 1000);
  },

  stopRecorder() { if (this.recorder && this.data.recording) this.recorder.stop(); },
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

  submitVoice() {
    if (!this.data.voiceFile) { host.toast('先录一段声音或上传音频'); return; }
    if (this.data.submitting) return;
    if (this.data.voiceSubmitted && this.data.recaptureKind !== 'voice') { this.setData({ step: 2 }); return; }
    this.setData({ submitting: true });
    api.startClone('voice', { filePath: this.data.voiceFile.path })
      .then(() => {
        if (this.data.recaptureKind === 'voice') this.enterTraining();
        else this.setData({ submitting: false, voiceSubmitted: true, step: 2 });
      })
      .catch((error) => {
        this.setData({ submitting: false });
        host.toast(error && error.message ? error.message : '声音提交失败');
      });
  },

  /* ── 第 2 步：形象视频 ── */

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
    this.setData({ submitting: true });
    api.startClone('avatar', { filePath: this.data.faceFile.path })
      .then(() => this.enterTraining())
      .catch((error) => {
        this.setData({ submitting: false });
        host.toast(error && error.message ? error.message : '形象提交失败');
      });
  },

  /* ── 第 3 步：训练 ── */

  enterTraining() {
    this.setData({
      submitting: false,
      step: 3,
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

  usePreset() { host.toast('先用平台预置形象出片'); host.go('home/index'); },
  leaveTraining() { host.go('home/index'); },
  retryImage() { this.setData({ step: 2, recaptureKind: 'avatar', faceFile: null, agreed: false, training: null }); },
  retryVoice() { this.setData({ step: 1, recaptureKind: 'voice', voiceFile: null, voiceSubmitted: false, recordSeconds: 0, training: null }); },

  back() {
    if (this.data.step === 2) { this.setData({ step: 1 }); return; }
    host.back();
  },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); },
});
