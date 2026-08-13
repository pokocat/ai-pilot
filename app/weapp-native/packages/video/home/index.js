// 屏 02 · 快出片首页（分包入口页）。
//
// 与设计稿的差异（分包形态所致，见技术方案 §2.1）：
//   · 设计稿屏 01「登录页」不存在 —— 复用军师的登录浮层，本页对游客开放浏览。
//   · 设计稿的三项 tabBar 在分包里做不了，改为本页的入口卡 + 各自独立页面。
//
// 2026-08-12 第二轮：首页改回**落地页**，模板拆去 templates/ 专区。
//
// 上一版把唯一一套模板做成首页主卡，等于「模板 = 首页」：模板从 1 套变 2 套时首页就得重排，
// 而且首页没法承担「这是什么、值不值得做」的介绍职责。现在分工是：
//   home      → 宣传横幅 + 价值主张 + 一个主 CTA（去选模板）+ 状态与入口
//   templates → 模板专区，选哪一套在那里决定，后续加模板只加数据
// 顺序仍按意图强度：横幅 → 主 CTA → 继续上次 → 三步说明 → 分身门槛 → 次级入口。
const host = require('../host');
const api = require('../api');
const { ensureShots } = require('../model');

/**
 * 三步流程说明。落地页只讲流程，不讲参数。
 * 第三步点名「数字人开口」——落地页要让用户看懂片子是靠什么出来的（模板 + 数字人），
 * 只写「自动合成」等于把产品的核心机制藏起来了。
 */
const STEPS = [
  { key: 'script', name: '改文案', desc: '套模板改几句' },
  { key: 'shots', name: '配画面', desc: '拍或选素材' },
  { key: 'render', name: '出片', desc: '数字人开口' },
];

Page({
  data: host.hostBaseData({
    steps: STEPS,
    bannerFailed: false,
    ongoing: null,
    avatar: null,
    avatarCount: 0,
    avatarState: 'missing',
    guest: false,
    showLogin: false,
    loginReason: 'execute',
  }),

  onLoad() { this.load(); },

  onShow() {
    // 从采集/制作流程返回时刷新分身门槛与草稿，避免首页展示旧状态。
    this.refreshAccountState();
  },

  /**
   * 落地页不依赖模板接口 —— 横幅与三步说明都是静态内容，
   * 所以这里没有整页 loading 态：横幅立刻可见，状态行各自异步填。
   */
  load() {
    const loggedIn = host.isLoggedIn();
    this.setData({ guest: !loggedIn });
    if (!loggedIn) { this.setData({ avatar: null, avatarCount: 0, avatarState: 'missing', ongoing: null }); return; }
    this.refreshAccountState();
  },

  refreshAccountState() {
    if (!host.isLoggedIn()) return;
    Promise.all([
      // ⚠️ 不能 catch(() => [])：空数组会被渲染成「你还没有数字分身」并引导去创建，
      // 而用户可能明明有，只是这次没读到。读失败必须与空态分开。
      api.avatars().then((rows) => ({ rows })).catch(() => ({ failed: true })),
      api.ongoingProject().catch(() => null),
    ]).then(([avatarResult, ongoing]) => {
      this.setData({
        guest: false,
        ...this.resolveAvatarState(avatarResult),
        ongoing: ongoing ? this.decorateOngoing(ongoing) : null,
      });
    });
  },

  /**
   * 取当前"代表性"分身：优先 ready，其次训练中，再次任意一个。
   *
   * 四态必须分开，不能合并成「有/没有」：
   *   ready / training / missing（确实没有）/ failed（这次没读到，别说人家没有）
   */
  resolveAvatarState(result) {
    if (result && result.failed) {
      return { avatar: null, avatarCount: 0, avatarState: 'failed' };
    }
    const list = Array.isArray(result && result.rows) ? result.rows : [];
    const avatar = list.find((item) => item.imageStatus === 'ready')
      || list.find((item) => item.imageStatus === 'training')
      || list[0]
      || null;
    const status = avatar ? avatar.imageStatus : 'missing';
    return {
      avatar,
      avatarCount: list.length,
      avatarState: status === 'ready' ? 'ready' : (status === 'training' ? 'training' : 'missing'),
    };
  },

  /** 进度按视觉镜头算，不用文案句数冒充已配画面的完成度。 */
  decorateOngoing(project) {
    const segments = project.segments || [];
    const broll = ensureShots(segments, project.shots).filter((shot) => shot.role === 'broll');
    const filled = broll.filter((shot) => shot.assetId).length;
    const stepText = project.step === 2 ? '第 2 步 配画面' : (project.step === 3 ? '第 3 步 出片' : '第 1 步 改文案');
    return Object.assign({}, project, {
      stepText,
      progressText: broll.length ? `${broll.length} 个画面段，已配好 ${filled} 个` : '文案还在打磨',
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

  /** 落地页的唯一主行动：去模板专区选一套。 */
  openTemplates() { host.go('templates/index'); },

  /** 宣传图缺失/解码失败时退到 CSS 底纹，别让首页门面开天窗。 */
  onBannerError() { this.setData({ bannerFailed: true }); },

  openClone() {
    if (!host.requireLogin(this, 'execute')) return;
    host.go('clone/index');
  },

  openWorks() {
    if (!host.requireLogin(this, 'execute')) return;
    host.go('works/index');
  },

  openAssets() {
    if (!host.requireLogin(this, 'execute')) return;
    host.go('assets/index');
  },

  openAvatar() {
    if (!host.requireLogin(this, 'execute')) return;
    host.go('avatar/index');
  },

  /** 分身状态条：读失败重试，已创建看管理，未创建去创建。 */
  tapAvatarCard() {
    if (this.data.avatarState === 'failed') { this.refreshAccountState(); return; }
    if (this.data.avatar) { this.openAvatar(); return; }
    this.openClone();
  },

  back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
});
