// 屏 12 · 分身管理。
//
// 与设计稿的差异：设计稿这一屏还含「积分钱包 + 充值套餐」。分包形态下**积分归军师主包**
// （军师已有 packages/work/credits 与 plans 两页，且线上定价只以运营后台为准），
// 这里只留一个跳转入口，不重复实现充值。见技术方案 §2.1。
//
// 合规（方案 §9.4）：「可删除权」必须在 UI 上明示，且删除要连带要求上游（石榴）删除。
const host = require('../host');
const api = require('../api');

function decorateAvatar(avatar) {
  if (!avatar) return null;
  const statusText = (status, progress, ready, failed) => {
    if (status === 'ready') return ready;
    if (status === 'training') return `训练 ${Math.max(0, Number(progress) || 0)}%`;
    if (status === 'failed') return failed;
    return '未采集';
  };
  return Object.assign({}, avatar, {
    imageStatusText: statusText(avatar.imageStatus, avatar.imageProgress, '可用', '需重拍'),
    voiceStatusText: statusText(avatar.voiceStatus, avatar.voiceProgress, '可用', '需重录'),
  });
}

Page({
  data: host.hostBaseData({
    loading: true,
    avatar: null,
    me: null,
    showLogin: false,
  }),

  onLoad() { this.load(); },
  onShow() { if (!this.data.loading) this.load(); },

  load() {
    if (!host.isLoggedIn()) { this.setData({ loading: false }); return; }
    api.avatar()
      .then((avatar) => this.setData({ loading: false, avatar: decorateAvatar(avatar), me: host.currentUser() }))
      .catch(() => this.setData({ loading: false }));
  },

  recapture(event) {
    const kind = String(event.currentTarget.dataset.kind || '');
    if (!host.requireLogin(this, 'execute')) return;
    host.go(`clone/index?step=${kind === 'voice' ? '3' : '2'}&recapture=1`);
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
  removeAvatar() {
    host.confirm({
      title: '删除我的数字分身',
      content: '删除后形象和声音立即停用，已出的片子不受影响。要重新用就得再采集一次。',
      confirmText: '删除',
    }).then((ok) => {
      if (!ok) return;
      host.loading('正在删除');
      api.deleteAvatar()
        .then(() => {
          host.hideLoading();
          this.setData({ avatar: null });
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
