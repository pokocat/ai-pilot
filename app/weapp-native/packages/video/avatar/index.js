// 屏 12 · 分身管理。
//
// 与设计稿的差异：设计稿这一屏还含「积分钱包 + 充值套餐」。分包形态下**积分归军师主包**
// （军师已有 packages/work/credits 与 plans 两页，且线上定价只以运营后台为准），
// 这里只留一个跳转入口，不重复实现充值。见技术方案 §2.1。
//
// 合规（方案 §9.4）：「可删除权」必须在 UI 上明示，且删除要连带要求上游（石榴）删除。
const host = require('../host');
const api = require('../api');

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

Page({
  data: host.hostBaseData({
    loading: true,
    avatars: [],
    me: null,
    showLogin: false,
  }),

  onLoad() { this.load(); },
  onShow() { if (!this.data.loading) this.load(); },
  onHide() { this.stopPolling(); },
  onUnload() { this.stopPolling(); },

  load() {
    this.stopPolling();
    if (!host.isLoggedIn()) { this.setData({ loading: false }); return; }
    api.avatars()
      .then((avatars) => {
        const decorated = (Array.isArray(avatars) ? avatars : []).map(decorateAvatar);
        this.setData({ loading: false, avatars: decorated, me: host.currentUser() });
        this.schedulePolling(decorated);
      })
      .catch(() => this.setData({ loading: false }));
  },

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
    if (!host.requireLogin(this, 'execute')) return;
    if (kind === 'voice' && avatar && avatar.voiceStatus === 'training') {
      host.toast(`专属声音正在训练 ${avatar.voiceProgress || 0}%`);
      return;
    }
    host.go(`clone/index?mode=${kind === 'voice' ? 'voice' : 'avatar'}&recapture=1&avatarId=${encodeURIComponent(avatarId)}`);
  },

  startClone() {
    if (!host.requireLogin(this, 'execute')) return;
    host.go('clone/index');
  },

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

  back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
});
