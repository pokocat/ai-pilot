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

/** 声音采集的朗读稿。念满约 40 秒，够训练声纹。 */
const READING_SCRIPT = '我在这条街上开了十二年店。每天卷闸门一拉开，第一件事是把门口扫干净。来的都是熟客，谁家孩子上几年级我都知道。';
const CONSENT_SCRIPT = '本人自愿创建并使用本人的数字分身，仅用于本人授权的口播视频。';

Page({
  data: host.hostBaseData({
    steps: STEPS,
    step: 1,
    agreed: false,
    consentScript: CONSENT_SCRIPT,
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
        if (avatar) this.setData({ step, agreed: true });
      }).catch(() => {});
    }
    if (!host.isLoggedIn()) this.setData({ showLogin: true });
  },

  onShow() {
    if (this.data.step === 4 && !this.trainingTimer) this.startTrainingPolling();
  },
  onHide() { this.stopTrainingPolling(); },
  onUnload() { this.stopTrainingPolling(); this.stopRecordTimer(); this.stopRecorder(); },

  /* ── 第 1 步：授权核验 ── */

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
        this.setData({ submitting: true, consentFile: { path: file.tempFilePath, duration: file.duration || 0 } });
        host.loading('正在核验本人授权');
        api.startConsent({ filePath: file.tempFilePath, text: CONSENT_SCRIPT })
          .then((result) => {
            host.hideLoading();
            this.setData({ submitting: false });
            if (!result || (result.verified !== true && result.status !== 'verified')) {
              throw Object.assign(new Error('本人核验还未通过，请按提示完成后再试'), { code: 'CLIP_CONSENT_NOT_VERIFIED' });
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
      maxDuration: 30,
      camera: 'front',
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        this.setData({ faceFile: { path: file.tempFilePath, duration: file.duration || 0 } });
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
      this.setData({ recording: false, voiceFile: { path: res.tempFilePath, duration: Math.round((res.duration || 0) / 1000) } });
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
    manager.start({ duration: 120000, format: 'mp3', sampleRate: 44100, numberOfChannels: 1 });
    this.setData({ recording: true, recordSeconds: 0, voiceFile: null });
    this.recordTimer = setInterval(() => this.setData({ recordSeconds: this.data.recordSeconds + 1 }), 1000);
  },

  stopRecorder() { if (this.recorder && this.data.recording) this.recorder.stop(); },
  stopRecordTimer() { if (this.recordTimer) { clearInterval(this.recordTimer); this.recordTimer = null; } },

  retakeVoice() { this.setData({ voiceFile: null, recordSeconds: 0 }); },

  /* ── 提交训练 ── */

  submit() {
    if (!this.data.faceFile) { host.toast('先采集你的形象'); return; }
    if (!this.data.voiceFile) { host.toast('先录一段你的声音'); return; }
    if (this.data.submitting) return;
    this.setData({ submitting: true });

    Promise.all([
      api.startClone('avatar', { filePath: this.data.faceFile && this.data.faceFile.path }),
      api.startClone('voice', { filePath: this.data.voiceFile.path }),
    ]).then(() => {
      this.setData({
        submitting: false,
        step: 4,
        training: { percent: 0, etaText: '大约还要 18 分钟', imageDone: false, voiceDone: false },
      });
      this.startTrainingPolling();
    }).catch((error) => {
      this.setData({ submitting: false });
      host.toast(error && error.message ? error.message : '提交失败');
    });
  },

  pollTraining() {
    api.avatar()
      .then((avatar) => {
        const imageDone = avatar && avatar.imageStatus === 'ready';
        const voiceDone = avatar && avatar.voiceStatus === 'ready';
        this.setData({
          presetAvailable: Boolean(avatar && avatar.presetAvailable),
          training: Object.assign({}, this.data.training, {
            imageDone, voiceDone,
            percent: (imageDone ? 50 : 20) + (voiceDone ? 50 : 0),
          }),
        });
        if (imageDone && voiceDone) this.stopTrainingPolling();
      })
      .catch(() => {});
  },

  startTrainingPolling() {
    this.stopTrainingPolling();
    this.pollTraining();
    this.trainingTimer = setInterval(() => this.pollTraining(), POLL_INTERVAL_MS);
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

  back() {
    if (this.data.step > 1 && this.data.step < 4) { this.setData({ step: this.data.step - 1 }); return; }
    host.back();
  },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); },
});
