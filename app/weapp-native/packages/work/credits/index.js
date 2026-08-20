const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { navTo } = require('../../../services/nav');
const { withShare } = require('../../../services/share');

const ORDER_LABEL = { created: '待支付', paid: '已支付 · 权益发放中', applied: '已完成', failed: '支付失败', closed: '已关闭', refunded: '已退款' };
const REFUND_LABEL = { refund_requested: '退款已申请', refund_processing: '退款处理中', refund_closed: '退款已关闭', refund_abnormal: '退款异常', refunded: '已退款' };
const PACK_KINDS = ['credits', 'quota']; // 增购包：credits=钻石颗数，quota=算力 token 数
function fmtAt(iso) { const value = String(iso || ''); const match = value.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); return match ? `${match[2]}-${match[3]} ${match[4]}:${match[5]}` : value.slice(0, 16); }
// 大数展示（与 H5 算力明细同口径）：1 万起走「万」、1 亿起走「亿」，去掉无意义的 .0。
function fmtBig(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n >= 1e8) return `${(n / 1e8).toFixed(1).replace(/\.0$/, '')}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1).replace(/\.0$/, '')}万`;
  return String(Math.round(n));
}
function fmtFen(fen) { const value = Number(fen) || 0; return `¥${(value / 100).toFixed(value % 100 ? 2 : 0)}`; }
// 增购包行文案：运营没填 amount 时不编数字，只留价格。
function mapPack(sku) {
  const amount = Number(sku.amount || 0);
  const amountText = amount > 0 ? (sku.kind === 'credits' ? `+${amount} 钻石` : `+${fmtBig(amount)} 算力`) : '数量以运营配置为准';
  return Object.assign({}, sku, { amountText: sku.desc ? `${amountText} · ${sku.desc}` : amountText, priceText: fmtFen(sku.priceFen) });
}
function usageLabel(usage) { if (!usage) return '—'; return usage.unlimited ? '不限量' : `本月已用 ${Number(usage.usagePercent) || 0}%`; }
function mapOrder(order) {
  const refund = order.refundStatus && REFUND_LABEL[order.refundStatus]; const label = refund || ORDER_LABEL[order.status] || order.status;
  const mockText = order.mock ? ' · 测试期模拟支付' : ''; const timeText = fmtAt(order.paidAt || order.createdAt);
  const payableText = order.payable && order.payableUntil ? ` · 可支付至 ${fmtAt(order.payableUntil)}` : '';
  return Object.assign({}, order, { statusText: `${label}${mockText} · ${timeText} · 单号 …${String(order.outTradeNo || '').slice(-6)}${payableText}`, amountText: `¥${(Number(order.amount || 0) / 100).toFixed(2)}`, bad: order.status === 'refunded' || order.status === 'failed', actionText: order.mock ? '模拟支付' : '继续支付' });
}

Page(withShare({
  // packState：loading / ready / failed —— 增购目录是公开数据、与个人流水成败无关，
  // 拉失败必须显式说「没取到 + 重试」，不能退化成「暂无增购包」（那是运营没配的意思）。
  data: baseData({ loading: true, creditBalance: '—', usageText: '—', usagePercent: 0, usageUnlimited: false, packRemainingText: '', items: [], orders: [], packs: [], packState: 'loading', packHint: '算力包永久有效，用完为止 · 钻石包到账即可启用顾问', purchasing: '', repaying: '', errorText: '', showLogin: false }),
  onLoad() { this.load(); },
  onShow() { this.setData({ themeClass: store.snapshot().themeClass }); if (this._loaded) this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) }); },
  closeLogin() { this.setData({ showLogin: false }); }, loggedIn() { this.setData({ showLogin: false }); this.load(); },
  // 增购包目录：服务端 /skus 已按 sort 排序（返回结构不含 sort），端上保持返回顺序不重排。
  loadPacks() {
    if (this.data.packState === 'failed') this.setData({ packState: 'loading' });
    return api.skus()
      .then((list) => { this._packs = (Array.isArray(list) ? list : []).filter((sku) => PACK_KINDS.includes(sku.kind)).map(mapPack); this.applyPacks('ready'); })
      .catch(() => this.setData({ packState: 'failed' }));
  },
  // 钻石不限量（企业版哨兵 creditBalance<0）买钻石包没有意义，服务端下单口直接 409 CREDITS_UNLIMITED，
  // 所以端上先隐藏这类包；算力包不受影响。目录与 /me 是两条请求，谁先到都要重算一次。
  applyPacks(state) {
    const packs = (this._packs || []).filter((sku) => !(this._creditsUnlimited && sku.kind === 'credits'));
    const packHint = this._creditsUnlimited ? '算力包永久有效，用完为止' : '算力包永久有效，用完为止 · 钻石包到账即可启用顾问';
    this.setData(Object.assign({ packs, packHint }, state ? { packState: state } : {}));
  },
  retryPacks() { this.loadPacks(); },
  async load() {
    // 增购目录是公开接口，游客也要拉：留在登录判断之后会让增购区块永远停在骨架屏。
    // 游客点购买行时 buyPack 自带登录门，这里只管展示。
    this.loadPacks();
    if (!store.isAuthed()) { this.setData({ loading: false, showLogin: true }); return; }
    if (!this._loaded) this.setData({ loading: true });
    try {
      const [credits, orderResult, me] = await Promise.all([api.credits(), api.orders().catch(() => ({ items: [] })), store.loadMe()]);
      // 余额与用量的唯一真源是 /me（creditBalance / usage）。这里曾兜底读 credits.balance 与
      // credits.usedPercent，但 /me/credits 只返回 { items }，这两个字段真服务端永远是 undefined：
      // store.loadMe() 内部吞掉请求错误直接返回 null，于是弱网下 /me 一失败，用量就被静默写成
      // 「本月已用 0%」——一个看起来正常的错数，比留空更误导。拿不到就不显示这行。
      const usage = me && me.usage; const balance = me && me.creditBalance != null ? me.creditBalance : null;
      // 增购算力剩余：usage 与 tokenQuota 同义（旧服务端两处都缺 → 0 → 不显示这一行）。
      // /me 读失败时不写 0，跟用量同一条规矩：没取到就不显示，别拿一个像样的错数骗人。
      const packRemaining = me ? Number((usage && usage.packRemaining) || (me.tokenQuota && me.tokenQuota.packRemaining) || 0) : 0;
      this._creditsUnlimited = Number(balance) < 0;
      this.applyPacks();
      this._loaded = true; this.setData({
        loading: false, errorText: '', creditBalance: Number(balance) < 0 ? '不限量' : String(balance == null ? '—' : balance),
        packRemainingText: packRemaining > 0 ? fmtBig(packRemaining) : '',
        usageText: usage ? usageLabel(usage) : '', usagePercent: usage && usage.unlimited ? 100 : Number(usage && usage.usagePercent) || 0, usageUnlimited: Boolean(usage && usage.unlimited),
        items: (credits && credits.items || []).map((item) => Object.assign({}, item, { atText: fmtAt(item.at), deltaText: Number(item.delta) >= 0 ? `+${item.delta}` : String(item.delta), positive: Number(item.delta) >= 0 })),
        orders: (orderResult.items || orderResult || []).map(mapOrder),
      });
    } catch (error) { const kind = store.handleApiError(error, { silent: true }); this._loaded = true; this.setData({ loading: false, errorText: kind === 'unauthorized' ? '' : (error.message || '算力明细读取失败'), showLogin: kind === 'unauthorized' }); }
  },
  retry() { this.load(); },
  goPlans() { navTo('/packages/work/plans/index'); },
  // 增购下单：与锦囊页 SKU 开通同一条阶梯（确认 → 下单 → 模拟支付/微信支付 → 轮询到账 → 重拉）。
  async buyPack(event) {
    const key = event.currentTarget.dataset.key;
    const pack = this.data.packs.find((item) => item.key === key);
    if (!pack || this.data.purchasing) return;
    if (!store.isAuthed()) { this.setData({ showLogin: true }); return; }
    const confirmed = await new Promise((resolve) => wx.showModal({
      title: pack.name,
      content: `${pack.amountText}\n支付 ${pack.priceText}，到账后立即可用。`,
      confirmText: `支付 ${pack.priceText}`,
      success: (result) => resolve(!!result.confirm),
      fail: () => resolve(false),
    }));
    if (!confirmed) return;
    this.setData({ purchasing: key });
    try {
      const order = await api.createSkuOrder(key, undefined, { source: 'catalog' });
      const outTradeNo = order.orderId || order.outTradeNo;
      if (order.mock && !order.appliedAt && outTradeNo) await api.payMock(outTradeNo);
      else if (order.payParams || order.pay) await new Promise((resolve, reject) => wx.requestPayment(Object.assign({}, order.payParams || order.pay, { success: resolve, fail: reject })));
      const state = order.appliedAt ? 'applied' : await this.waitApplied(outTradeNo);
      // —— 支付已成功（钱已扣）：后续刷新/查询失败只影响提示，绝不能再报「支付失败」。 ——
      await store.loadMe().catch(() => {});
      await this.load();
      if (state === 'applied') wx.showToast({ title: order.mock ? '已到账（测试期模拟支付）' : '已到账，权益已更新', icon: order.mock ? 'none' : 'success' });
      else if (state === 'failed') wx.showToast({ title: '订单未完成，请重新发起购买', icon: 'none' });
      else wx.showToast({ title: '支付结果待确认，到账后可下拉刷新查看', icon: 'none' });
    } catch (error) {
      const cancelled = /cancel/i.test(String(error.errMsg || error.message || ''));
      if (!cancelled) store.handleApiError(error, { fallbackTitle: error.message || '购买没有完成，可稍后重试' });
    } finally {
      this.setData({ purchasing: '' });
    }
  },
  async repay(event) {
    const outTradeNo = event.currentTarget.dataset.id;
    const order = this.data.orders.find((item) => item.outTradeNo === outTradeNo);
    if (!order || this.data.repaying) return;
    this.setData({ repaying: outTradeNo });
    try {
      const result = await api.orderPayParams(outTradeNo);
      if (result.mock) {
        await api.payMock(outTradeNo);
      } else {
        if (!result.pay) throw Object.assign(new Error('缺少支付参数，请刷新后重试'), { code: 'ORDER_NOT_PAYABLE' });
        await new Promise((resolve, reject) => wx.requestPayment(Object.assign({}, result.pay, { success: resolve, fail: reject })));
      }
      const state = await this.waitApplied(outTradeNo);
      await store.loadMe().catch(() => {});
      await this.load();
      if (state === 'applied') {
        wx.showToast({
          title: result.mock ? '模拟支付已到账（测试期，未实际付款）' : '支付成功，权益已更新',
          icon: result.mock ? 'none' : 'success',
        });
      } else if (state === 'failed') {
        wx.showToast({ title: '订单未完成，请刷新后重新发起支付', icon: 'none' });
      } else {
        wx.showToast({
          title: result.mock ? '模拟支付已提交，权益待确认（测试期，未实际付款）' : '支付结果待确认，请稍后刷新订单状态',
          icon: 'none',
        });
      }
    } catch (error) {
      const cancelled = /cancel/i.test(String(error.errMsg || error.message || ''));
      if (!cancelled) wx.showToast({ title: error.message || '支付没有完成，可稍后重试', icon: 'none' });
      const code = error.code || (error.data && error.data.code);
      if (code === 'ORDER_EXPIRED' || code === 'ORDER_NOT_PAYABLE') await this.load();
    } finally {
      this.setData({ repaying: '' });
    }
  },
  async waitApplied(outTradeNo) {
    if (!outTradeNo) return 'pending';
    for (let index = 0; index < 5; index += 1) {
      try {
        const status = await api.paymentStatus(outTradeNo);
        if (status.appliedAt || status.status === 'applied') return 'applied';
        if (['failed', 'closed', 'refunded'].includes(status.status)) return 'failed';
      } catch (_) { /* 网络抖动不冒充失败；重试完仍未知则返回 pending。 */ }
      if (index < 4) await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return 'pending';
  },
}));
