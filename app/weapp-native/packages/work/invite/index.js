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
 * 实现口径抄 share.js：懒 require（避开 api→invite→store 的加载链成环）、
 * fire-and-forget、整个调用包在 try 里——埋点绝不能让页面变慢或报错。
 */
function trackProvision(slot, act) {
  try {
    require('../../../services/api').api.track('qr_provision', { slot, act });
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
    if (!store.isAuthed()) { this.setData({ showLogin: false, loading: false }); }
    this.load();
  },

  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },

  async load() {
    if (!store.isAuthed()) { this.setData({ loading: false }); return; }
    this.setData({ loading: true, qrFailed: false });
    // 两个请求各自成败：码取不到不该连人数一起没了，反之亦然。
    const [qrRes, meRes] = await Promise.all([
      api.inviteQrcode(this.data.slot).catch(() => null),
      api.me().catch(() => null),
    ]);
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
    // 否则漏斗里会混进一批根本没法贴出去的「投放」。
    if (dataUri) trackProvision(this.data.slot, 'view');
  },

  async pickSlot(event) {
    const slot = event.currentTarget.dataset.slot;
    if (!slot || slot === this.data.slot) return;
    // 换位就是换一张码，旧的出图要作废，否则用户会把「通用」的图当成「名片」的存走。
    this.setData({ slot, imgPath: '' });
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
      trackProvision(this.data.slot, 'image');
    } catch (_) {
      wx.showToast({ title: '出图失败，请重试', icon: 'none' });
    } finally {
      this.setData({ busy: false });
    }
  },

  saveImage() {
    if (!this.data.imgPath) return;
    // 存相册是这条链里最强的投放信号——图存下来才可能进 PPT / 交给设计做物料。
    trackProvision(this.data.slot, 'save');
    canvas.save(this.data.imgPath);
  },
  shareImage() { canvas.share(this.data.imgPath); },

  copyCode() {
    if (!this.data.inviteCode) return;
    wx.setClipboardData({ data: this.data.inviteCode, success: () => wx.showToast({ title: '邀请码已复制', icon: 'none' }) });
  },

  retry() { this.load(); },
  back() { wx.navigateBack(); },
}));
