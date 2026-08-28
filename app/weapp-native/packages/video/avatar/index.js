// 屏 12 · 分身管理。
//
// 与设计稿的差异：设计稿这一屏还含「积分钱包 + 充值套餐」。分包形态下**积分归军师主包**
// （军师已有 packages/work/credits 与 plans 两页，且线上定价只以运营后台为准），
// 这里只留一个跳转入口，不重复实现充值。见技术方案 §2.1。
//
// 合规（方案 §9.4）：「可删除权」必须在 UI 上明示，且删除要连带要求上游（石榴）删除。
const host = require('../host');
const api = require('../api');
const { withShare } = require('../../../services/share');

function formatCompletedAt(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())} 完成`;
}

function decorateAvatar(avatar) {
  if (!avatar) return null;
  const statusText = (status, progress, ready, failed) => {
    if (status === 'ready') return ready;
    if (status === 'training') return `训练 ${Math.max(0, Number(progress) || 0)}%`;
    if (status === 'failed') return failed;
    return '未采集';
  };
  const dedicatedVoice = avatar.voiceSource === 'dedicated';
  const voiceStatus = avatar.voiceStatus || 'none';
  const voiceProgress = Math.max(0, Math.min(100, Number(avatar.voiceProgress) || 0));
  const voiceBadgeText = voiceStatus === 'training'
    ? `训练 ${voiceProgress}%`
    : voiceStatus === 'failed'
      ? '需重录'
      : voiceStatus === 'ready'
        ? (dedicatedVoice ? '已增强' : '视频原声')
        : '未采集';
  const voiceDesc = voiceStatus === 'training'
    ? (dedicatedVoice ? '专属声音正在云端训练，完成后会自动更新' : '正在从形象视频生成基础声音，完成后会自动更新')
    : voiceStatus === 'failed'
      ? '这次录音训练失败，可以重新录制'
      : voiceStatus === 'ready' && dedicatedVoice
        ? '专属声音已完成，后续口播会优先使用这版音色'
        : voiceStatus === 'ready'
          ? '当前使用视频原声，补录后音色会更稳定'
          : '不影响形象创建；补录后口播会更像你';
  return Object.assign({}, avatar, {
    imageStatusText: statusText(avatar.imageStatus, avatar.imageProgress, '已就绪', '需重拍'),
    voiceStatusText: statusText(avatar.voiceStatus, avatar.voiceProgress, '已增强', '可重录'),
    voiceProgress,
    voiceBadgeText,
    voiceDesc,
    voiceActionText: voiceStatus === 'training'
      ? '训练中'
      : (dedicatedVoice || voiceStatus === 'failed') ? '重新录制' : voiceStatus === 'ready' ? '提升' : '去录制',
    voiceCompletedText: dedicatedVoice && voiceStatus === 'ready' ? formatCompletedAt(avatar.voiceTrainedText) : '',
  });
}

Page(withShare({
  data: host.hostBaseData({
    loading: true,
    /**
     * 读失败 ≠ 没有分身。合成一个空态，会把「这次没读到」说成「你还没有数字分身」，
     * 并引导用户重新采集 —— 而重新采集是要扣钻石的。首页 refreshAccountState 早就把
     * 四态分开了（ready / training / missing / failed），这一屏必须同口径。
     */
    loadFailed: false,
    avatars: [],
    loggedIn: false,
    me: null,
    /* 试听（V01）：每个分身都能当场听它关联的那条声音，
       不必先去建项目 —— 「像不像我」要在出片扣钻石之前回答。 */
    voicePreviewOpen: false,
    voicePreviewId: '',
    voicePreviewName: '',
    showLogin: false,
  }),

  onLoad() { this.load(); },
  onShow() { if (!this.data.loading) this.load(); },
  // 页面切走/销毁时要关掉试听：音频还在响、overlay 计数也会漏掉一层。
  onHide() {
    this.stopPolling();
    if (this.data.voicePreviewOpen) this.closeVoicePreview();
    if (this.data.demoVideoOpen) this.closeDemoVideo();
  },
  onUnload() {
    this.stopPolling();
    if (this.data.voicePreviewOpen) host.setOverlay(false, 'video-voice-preview');
    if (this.data.demoVideoOpen) host.setOverlay(false, 'video-demo-video');
  },

  load() {
    this.stopPolling();
    // 游客可以浏览这一屏（不前置登录门），但「没登录」不是「没有分身」，各说各的。
    if (!host.isLoggedIn()) {
      this.setData({ loading: false, loadFailed: false, loggedIn: false, avatars: [] });
      return;
    }
    // 并发闸：onShow 与轮询可能同时触发，晚回来的那次不许覆盖新结果。
    const token = (this._loadToken || 0) + 1;
    this._loadToken = token;
    api.avatars()
      .then((avatars) => {
        if (this._loadToken !== token) return;
        const decorated = (Array.isArray(avatars) ? avatars : []).map(decorateAvatar);
        this.setData({ loading: false, loadFailed: false, loggedIn: true, avatars: decorated, me: host.currentUser() });
        this.schedulePolling(decorated);
      })
      .catch(() => {
        if (this._loadToken !== token) return;
        // 保留上一次读到的 avatars：读失败时把已经显示出来的分身抹掉毫无必要。
        this.setData({ loading: false, loadFailed: true, loggedIn: true });
        // 轮询必须接着跑。否则训练中撞上一次网络抖动，进度就永远停在失败前的那一帧，
        // 而用户看到的是「卡住了」——又一个「其实早就好了，只是端上不知道」。
        this.schedulePolling(this.data.avatars);
      });
  },

  retry() { this.setData({ loading: true, loadFailed: false }); this.load(); },

  schedulePolling(avatars) {
    if (!(avatars || []).some((avatar) => avatar.imageStatus === 'training' || avatar.voiceStatus === 'training')) return;
    this._avatarPollTimer = setTimeout(() => this.load(), 5000);
  },

  stopPolling() {
    if (!this._avatarPollTimer) return;
    clearTimeout(this._avatarPollTimer);
    this._avatarPollTimer = null;
  },

  recapture(event) {
    const kind = String(event.currentTarget.dataset.kind || '');
    const avatarId = String(event.currentTarget.dataset.id || '');
    const avatar = this.data.avatars.find((item) => item.id === avatarId);
    if (!host.requireLogin(this, 'video')) return;
    if (kind === 'voice' && avatar && avatar.voiceStatus === 'training') {
      host.toast(`专属声音正在训练 ${avatar.voiceProgress || 0}%`);
      return;
    }
    // 重录已有声音时把那条声音的 id 带过去 —— 服务端据此走「重训」而不是「新建」：
    // 供应商每条 speaker 给 4 次免费重训且不消耗克隆权益，我方也按更低的重训档计价。
    // 少了这个参数，每次「重新录制」都会新建一条 speaker，克隆权益很快被烧光（2026-08-13 实测归零即由此而来）。
    const retrainVoiceId = kind === 'voice' && avatar ? String(avatar.linkedVoiceId || '') : '';
    const query = retrainVoiceId ? `&voiceId=${encodeURIComponent(retrainVoiceId)}` : '';
    host.go(`clone/index?mode=${kind === 'voice' ? 'voice' : 'avatar'}&recapture=1&avatarId=${encodeURIComponent(avatarId)}${query}`);
  },

  startClone() {
    if (!host.requireLogin(this, 'video')) return;
    host.go('clone/index');
  },

  openVoices() { host.go('voices/index'); },

  openCredits() { host.goHost('/packages/work/credits/index'); },

  openConsentLog() { this.openLog('授权记录', api.consentLogs); },
  openUsageLog() { this.openLog('使用记录', api.usageLogs); },

  openLog(title, loader) {
    host.loading('正在读取');
    loader()
      .then((rows) => {
        host.hideLoading();
        const content = (rows || []).slice(0, 8).map((item) => [item.createdText || item.createdAt || '', item.scope || item.action || '', item.status || ''].filter(Boolean).join(' · ')).join('\n');
        return host.alert({ title, content: content || '暂无记录' });
      })
      .catch((error) => {
        host.hideLoading();
        host.toast(error && error.message ? error.message : '读取失败');
      });
  },

  /** 删除分身：合规要求的「可删除权」。二次确认 + 明确后果。 */
  removeAvatar(event) {
    const avatarId = String(event.currentTarget.dataset.id || '');
    const target = this.data.avatars.find((item) => item.id === avatarId);
    host.confirm({
      title: `删除${target ? `「${target.name}」` : '这个数字分身'}`,
      content: '删除后形象和声音立即停用，已出的片子不受影响。要重新用就得再采集一次。',
      confirmText: '删除',
    }).then((ok) => {
      if (!ok) return;
      host.loading('正在删除');
      api.deleteAvatarById(avatarId)
        .then(() => {
          host.hideLoading();
          this.stopPolling();
          this.setData({ avatars: this.data.avatars.filter((item) => item.id !== avatarId) });
          host.toast('数字分身已删除', 'success');
        })
        .catch((error) => {
          host.hideLoading();
          host.toast(error && error.message ? error.message : '删除失败');
        });
    });
  },

  /**
   * 看数字人的真实出镜效果。
   *
   * 这是砍掉「按需试镜」之后，用户在扣钻石前唯一能验证口型和构图的地方 ——
   * 形象预览帧只能证明「是我」，证明不了「说起话来自不自然」。
   * 片子在训练完成时就固化好了，这里只是播它，不产生任何供应商调用。
   */
  openDemoVideo(event) {
    const id = String(event.currentTarget.dataset.id || '');
    const avatar = (this.data.avatars || []).find((item) => item.id === id);
    if (!avatar || !avatar.demoVideoUrl) { host.toast('样例还在生成，稍后再来看'); return; }
    host.setOverlay(true, 'video-demo-video');
    this.setData({
      demoVideoOpen: true,
      demoVideoUrl: avatar.demoVideoUrl,
      demoVideoName: avatar.name || '这个分身',
    });
  },

  closeDemoVideo() {
    host.setOverlay(false, 'video-demo-video');
    this.setData({ demoVideoOpen: false, demoVideoUrl: '' });
  },

  openVoicePreview(event) {
    const id = String(event.currentTarget.dataset.id || '');
    const avatar = (this.data.avatars || []).find((item) => item.id === id);
    if (!host.requireLogin(this, 'video')) return;
    if (!avatar || !avatar.linkedVoiceId) { host.toast('这个分身还没关联声音'); return; }
    host.setOverlay(true, 'video-voice-preview');
    this.setData({
      voicePreviewOpen: true,
      voicePreviewId: avatar.linkedVoiceId,
      voicePreviewName: avatar.linkedVoiceName || avatar.name || '这条声音',
      voicePreviewDemoUrl: avatar.demoAudioUrl || '',
    });
  },

  closeVoicePreview() {
    host.setOverlay(false, 'video-voice-preview');
    this.setData({ voicePreviewOpen: false, voicePreviewId: '' });
  },

  back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
}));
