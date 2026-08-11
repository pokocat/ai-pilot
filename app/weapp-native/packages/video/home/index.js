// 屏 02 · 快出片首页（分包入口页）。
//
// 与设计稿的差异（分包形态所致，见技术方案 §2.1）：
//   · 设计稿屏 01「登录页」在这里不存在 —— 复用军师的登录浮层，且本页对游客开放浏览。
//   · 设计稿的三项 tabBar（首页/我的作品/我的）在分包里做不了（分包不能有 tabBar），
//     改为本页底部的三个入口行 + 各自的独立页面。
const host = require('../host');
const api = require('../api');
const { formatDuration } = require('../model');

Page({
  data: host.hostBaseData({
    loading: true,
    ongoing: null,
    avatar: null,
    templates: [],
    showLogin: false,
    loginReason: 'execute',
  }),

  onLoad() { this.load(); },

  onShow() {
    // 从制作流程返回时刷新「继续上次」的进度
    if (!this.data.loading) this.loadOngoing();
  },

  load() {
    this.setData({ loading: true });
    const builtIns = api.builtInTemplates();
    Promise.all([
      api.templates().catch(() => builtIns),
      host.isLoggedIn() ? api.avatar().catch(() => null) : Promise.resolve(null),
      host.isLoggedIn() ? api.ongoingProject().catch(() => null) : Promise.resolve(null),
    ]).then(([templates, avatar, ongoing]) => {
      const availableTemplates = Array.isArray(templates) && templates.length ? templates : builtIns;
      this.setData({
        loading: false,
        templates: availableTemplates.map((item) => Object.assign({}, item, {
          durationText: formatDuration(item.estDurationSec),
        })),
        avatar,
        ongoing: ongoing ? this.decorateOngoing(ongoing) : null,
      });
    });
  },

  loadOngoing() {
    if (!host.isLoggedIn()) return;
    api.ongoingProject()
      .then((ongoing) => this.setData({ ongoing: ongoing ? this.decorateOngoing(ongoing) : null }))
      .catch(() => {});
  },

  /** 「14 句里已配好 6 句」这类进度文案在端上算，避免多一次接口。 */
  decorateOngoing(project) {
    const segments = project.segments || [];
    const broll = segments.filter((s) => s.role === 'broll');
    const filled = broll.filter((s) => s.assetId).length;
    const stepText = project.step === 2 ? '第 2 步 配画面' : (project.step === 3 ? '第 3 步 出片' : '第 1 步 改文案');
    return Object.assign({}, project, {
      stepText,
      progressText: `${segments.length} 句里已配好 ${filled} 句`,
      percent: broll.length ? Math.round((filled / broll.length) * 100) : 0,
    });
  },

  /* ── 交互 ── */

  resume() {
    const ongoing = this.data.ongoing;
    if (!ongoing) return;
    const step = ongoing.step === 3 ? 'confirm' : (ongoing.step === 2 ? 'shots' : 'script');
    host.go(`${step}/index?projectId=${encodeURIComponent(ongoing.id)}`);
  },

  openTemplate(event) {
    const id = String(event.currentTarget.dataset.id || '');
    if (id) host.go(`template/index?templateId=${encodeURIComponent(id)}`);
  },

  openClone() {
    if (!host.requireLogin(this, 'execute')) return;
    host.go('clone/index');
  },

  openWorks() { host.go('works/index'); },
  openAssets() {
    if (!host.requireLogin(this, 'execute')) return;
    host.go('assets/index');
  },
  openAvatar() {
    if (!host.requireLogin(this, 'execute')) return;
    host.go('avatar/index');
  },

  tapAvatarCard() {
    if (this.data.avatar) { this.openAvatar(); return; }
    this.openClone();
  },

  back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
});
