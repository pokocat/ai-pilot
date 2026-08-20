// 我的邀请（静态传播链入口）。
//
// 这一页解决的是转发通道到不了的场景：把码印在名片、门店台卡、提案封底、展会物料上。
// 所以主动作是**存图**而不是转发——存下来的图要能直接进 PPT、发给设计做物料。
//
// 降级口径（服务端 dataUri 可能为 null：凭据未配 / 微信限流 / 测试环境）：
// 不给裂图，改成「邀请码大字 + 说明可手输」。这条链是增强，不该因为外部依赖让页面变废。
const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { withShare } = require('../../../services/share');
const canvas = require('../gift/canvas');
const paint = require('./paint');

// 物料位：与服务端 QR_SLOTS 一致（scene 受微信 32 字符限制，位标识只用短码）。
// 文案是给老板看的「这张码贴哪」，不是技术名。
const SLOTS = [
  { key: 'default', label: '通用' },
  { key: 'card', label: '名片' },
  { key: 'store', label: '门店' },
  { key: 'deck', label: '提案' },
  { key: 'event', label: '活动' },
];


/**
 * 物料投放埋点（`qr_provision`，静态传播链的第一段）。
 *
 * **它不是「曝光」**：二维码的曝光在端外发生（名片被看到、台卡被扫），小程序里没有任何时机
 * 能捕获，硬凑一个只会让漏斗分母失真。这里记的是端上真实可捕获的**投放意图**：
 * 用户看了码 / 出了图 / 存了相册。取数时与 `share_expose` **不可相加**——
 * 一次投放会带来 N 次线下扫码，量级不同。
 *
 * fire-and-forget、整个调用包在 try 里——埋点绝不能让页面变慢或报错。
 *
 * **直接用顶层的 `api`，不做懒 require**（2026-08-20 codex 指出，成立）：
 * share.js 那边懒 require 是因为它被 54 个页面在模块顶层引入、怕加载链成环；
 * 这一页顶层已经 `require` 了同一个 api 模块，再懒加载一次不减少任何依赖环，
 * 只是让实现更绕、也让测试没法注入。
 */
function trackProvision(slot, act) {
  try {
    api.track('qr_provision', { slot, act });
  } catch (_) { /* 埋点不可用：页面照常 */ }
}

Page(withShare({
  data: baseData({
    slots: SLOTS,
    slot: 'default',
    inviteCode: '',
    qr: '',           // data URI；空 = 降级为大字
    qrFailed: false,  // 与「还没加载」区分开：失败要显式说明，不能一直转圈
    loading: true,
    summary: null,    // 直邀数 / 已开通数，取不到显示「—」而不是 0
    imgPath: '',
    busy: false,
    showLogin: false,
  }),

  onLoad() {
    this._gen = 0;   // 请求代次，见 load() 注释
    if (!store.isAuthed()) { this.setData({ showLogin: false, loading: false }); }
    this.load();
  },

  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },

  /**
   * 取码 + 读数。
   *
   * **请求代次（`_gen`）是必须的**（2026-08-20 codex 审出的阻断）：切物料位会立刻发新请求，
   * 而旧请求还在飞。没有代次时，default 的响应会晚于 card 的切换落地，把 default 的二维码
   * 写进已经显示「名片」的状态里——**用户出的图会是「名片」文案配通用码，印出去归因就错了**；
   * 而且还会按 `this.data.slot`（此刻已是 card）误报一次 view。
   * 快速连点多个位时，最后返回的那个旧请求甚至能永久盖住当前码。
   *
   * 代次的判断依据：只有「我发起时的代次 === 当前代次」才允许落地与上报，否则整个响应丢弃。
   * slot 也从**发起时**的闭包里取，不读 this.data（读了就还是会串）。
   */
  async load() {
    if (!store.isAuthed()) { this.setData({ loading: false }); return; }
    const gen = ++this._gen;
    const slot = this.data.slot;   // 钉住发起时的位，不在回调里读 this.data
    // 切位时先清掉旧码：否则新码还没回来的那段时间，屏上显示的是上一位的二维码，
    // 用户此刻点「生成邀请卡」就会拿到错配的图。
    this.setData({ loading: true, qrFailed: false, qr: '', imgPath: '' });
    // 两个请求各自成败：码取不到不该连人数一起没了，反之亦然。
    const [qrRes, meRes] = await Promise.all([
      api.inviteQrcode(slot).catch(() => null),
      api.me().catch(() => null),
    ]);
    if (gen !== this._gen) return;  // 已被更新的请求取代：整份响应丢弃，不落地也不上报
    const dataUri = (qrRes && qrRes.dataUri) || '';
    this.setData({
      loading: false,
      inviteCode: (qrRes && qrRes.inviteCode) || (meRes && meRes.inviteCode) || '',
      qr: dataUri,
      // 请求成功但 dataUri 为空 = 服务端降级；请求本身失败也算失败态。
      qrFailed: !qrRes || !qrRes.dataUri,
      summary: (meRes && meRes.referral) || null,
    });
    // 只有真拿到码才算一次可用的投放：降级态（没码、只能手输）不报，
    // 否则漏斗里会混进一批根本没法贴出去的「投放」。用发起时的 slot，不用 this.data.slot。
    if (dataUri) trackProvision(slot, 'view');
  },

  async pickSlot(event) {
    const slot = event.currentTarget.dataset.slot;
    if (!slot || slot === this.data.slot) return;
    // 换位就是换一张码：旧出图与旧二维码都要立刻作废（load 里会清），
    // 否则用户会把「通用」的图当成「名片」的存走。
    this.setData({ slot });
    await this.load();
  },

  async makeImage() {
    if (this.data.busy) return;
    if (!this.data.inviteCode) { wx.showToast({ title: '邀请码还没拿到，请稍后重试', icon: 'none' }); return; }
    this.setData({ busy: true });
    try {
      const slotLabel = (SLOTS.find((s) => s.key === this.data.slot) || {}).label || '通用';
      const imgPath = await canvas.render(this, 'inviteCanvas', 750, 1000, (ctx, w, h) => paint.card(ctx, w, h, {
        code: this.data.inviteCode,
        qr: this.data.qr,
        slotLabel,
      }));
      this.setData({ imgPath });
      // 与 view 同一口径：**只有真拿到码才算投放**。降级卡（大字邀请码、没有二维码）
      // 也能出图，但它不是可扫的物料，报上去会让漏斗混进贴不出去的东西。
      if (this.data.qr) trackProvision(this.data.slot, 'image');
    } catch (_) {
      wx.showToast({ title: '出图失败，请重试', icon: 'none' });
    } finally {
      this.setData({ busy: false });
    }
  },

  saveImage() {
    if (!this.data.imgPath) return;
    // 存相册是这条链里最强的投放信号——图存下来才可能进 PPT / 交给设计做物料。
    //
    // **必须等相册回调成功才报**（2026-08-20 codex 审出的阻断）：早先在调用前就报，
    // 于是用户点了「取消」或拒了相册权限也被记成「已存相册」——契约里 save 的定义是
    // 「存了相册」，那样就是造假。这里不复用 canvas.save（它只 toast 不回状态），
    // 直接调 wx，成功分支里才上报；无码的降级卡同样不报。
    const slot = this.data.slot;
    const hasQr = Boolean(this.data.qr);
    wx.saveImageToPhotosAlbum({
      filePath: this.data.imgPath,
      success: () => {
        wx.showToast({ title: '已保存到相册', icon: 'none' });
        if (hasQr) trackProvision(slot, 'save');
      },
      fail: (error) => {
        // 用户主动取消不算失败，不打扰；拒权限才提示怎么开。
        if (!/cancel/i.test(String(error && error.errMsg))) {
          wx.showToast({ title: '保存失败，请在设置中允许相册权限', icon: 'none' });
        }
      },
    });
  },
  shareImage() { canvas.share(this.data.imgPath); },

  copyCode() {
    if (!this.data.inviteCode) return;
    wx.setClipboardData({ data: this.data.inviteCode, success: () => wx.showToast({ title: '邀请码已复制', icon: 'none' }) });
  },

  retry() { this.load(); },
  back() { wx.navigateBack(); },
}));
