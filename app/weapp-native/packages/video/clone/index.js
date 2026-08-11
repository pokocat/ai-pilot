// 屏 04 · 视频数字分身创建。按石榴官方契约组织为：上传视频 → 云端训练。
//
// speakerId 和 authId 都是 avatar/create 的可选项；单独声音采集只是后续增强，不得阻断形象创建。
const host = require('../host');
const api = require('../api');
const { POLL_INTERVAL_MS } = require('../config');

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
    selectedVoiceId: '',
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
      recaptureKind: String(opts.recapture || '') === '1' ? mode : null,
      training: step === 2 ? initialTraining(mode) : null,
    });
    if (!host.isLoggedIn()) this.setData({ showLogin: true });
    this.loadRequirements();
    this.loadVoices();
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

  loadVoices() {
    if (!host.isLoggedIn()) return;
    api.voices().then((voices) => this.setData({ voices: (Array.isArray(voices) ? voices : []).filter((item) => item.status === 'ready') })).catch(() => {});
  },

  changeAvatarName(event) { this.setData({ avatarName: String(event.detail.value || '').slice(0, 20) }); },
  chooseExistingVoice(event) { this.setData({ selectedVoiceId: String(event.currentTarget.dataset.id || '') }); },

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

  startRecorder() {
    const manager = wx.getRecorderManager();
    this.recorder = manager;
    this.setData({ startingRecord: true });
    if (typeof manager.offStart === 'function') manager.offStart();
    if (typeof manager.offStop === 'function') manager.offStop();
    if (typeof manager.offError === 'function') manager.offError();
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
      if (/auth|deny|permission/i.test(message)) {
        this.openRecordSettings();
        return;
      }
      host.toast(message ? `录音失败：${message.slice(0, 40)}` : '录音失败，请重试');
    });
    this.stopRecordStartTimer();
    this.recordStartTimer = setTimeout(() => {
      if (!this.data.startingRecord) return;
      this.setData({ startingRecord: false, recording: false });
      host.toast('麦克风启动超时，请检查权限后重试');
    }, 5000);
    try {
      manager.start({ duration: Math.min(120, this.captureRule('voice').maxDurationSec) * 1000, format: 'mp3', sampleRate: 44100, numberOfChannels: 1 });
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

  submitVoice() {
    if (!this.data.voiceFile) { host.toast('先录一段声音或上传音频'); return; }
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    api.startClone('voice', { filePath: this.data.voiceFile.path, avatarId: this.data.avatarId })
      .then(() => this.enterTraining())
      .catch((error) => {
        this.setData({ submitting: false });
        host.toast(error && error.message ? error.message : '声音提交失败');
      });
  },

  /* ── 第 1 步：一段视频创建数字人 ── */

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
    api.startClone('avatar', { filePath: this.data.faceFile.path, avatarId: this.data.avatarId, voiceId: this.data.selectedVoiceId, name: this.data.avatarName })
      .then((result) => { if (result && result.avatarId) this.setData({ avatarId: result.avatarId }); this.enterTraining(); })
      .catch((error) => {
        this.setData({ submitting: false });
        host.toast(error && error.message ? error.message : '形象提交失败');
      });
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
