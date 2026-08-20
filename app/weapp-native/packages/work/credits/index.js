const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { navTo } = require('../../../services/nav');
const { withShare } = require('../../../services/share');
const packsService = require('../../../services/packs');

const ORDER_LABEL = { created: '待支付', paid: '已支付 · 权益发放中', applied: '已完成', failed: '支付失败', closed: '已关闭', refunded: '已退款' };
const REFUND_LABEL = { refund_requested: '退款已申请', refund_processing: '退款处理中', refund_closed: '退款已关闭', refund_abnormal: '退款异常', refunded: '已退款' };
// 「算力快见底」阈值：明细页是账本，不是货架——只有真快用完时才把增购摆出来，
// 其余时候靠页尾「查看方案与权益」导流（增购常驻入口在方案页）。
// 钻石余额为 0 同样算见底：启用顾问/出图当场就会被挡住，此时不给买等于把人卡死。
const RUNNING_LOW_PERCENT = 80;
function fmtAt(iso) { const value = String(iso || ''); const match = value.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); return match ? `${match[2]}-${match[3]} ${match[4]}:${match[5]}` : value.slice(0, 16); }
function fmtFen(fen) { const value = Number(fen) || 0; return `¥${(value / 100).toFixed(value % 100 ? 2 : 0)}`; }
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
  data: baseData({ loading: true, creditBalance: '—', usageText: '—', usagePercent: 0, usageUnlimited: false, packRemainingText: '', items: [], orders: [], packs: [], packState: 'loading', showPacks: false, packHint: '算力包永久有效，用完为止 · 钻石包到账即可启用顾问', purchasing: '', repaying: '', errorText: '', showLogin: false }),
  onLoad() { this.load(); },
  onShow() { this.setData({ themeClass: store.snapshot().themeClass }); if (this._loaded) this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) }); },
  closeLogin() { this.setData({ showLogin: false }); }, loggedIn() { this.setData({ showLogin: false }); this.load(); },
  // 增购包目录：服务端 /skus 已按 sort 排序（返回结构不含 sort），端上保持返回顺序不重排。
  loadPacks() {
    if (this.data.packState === 'failed') this.setData({ packState: 'loading' });
    return packsService.fetchPacks()
      .then((packs) => { this._packs = packs; this.applyPacks('ready'); })
      .catch(() => this.setData({ packState: 'failed' }));
  },
  // 钻石不限量（企业版哨兵 creditBalance<0）买钻石包没有意义，服务端下单口直接 409 CREDITS_UNLIMITED，
  // 所以端上先隐藏这类包；算力包不受影响。目录与 /me 是两条请求，谁先到都要重算一次。
  applyPacks(state) {
    // 明细页是账本不是货架：没见底就整块不渲染（增购常驻入口在方案页，页尾有导流）。
    const packs = this._runningLow ? packsService.visiblePacks(this._packs, this._creditsUnlimited) : [];
    const packHint = this._creditsUnlimited ? '算力包永久有效，用完为止' : '算力包永久有效，用完为止 · 钻石包到账即可启用顾问';
    // 没见底时连加载/失败态都不出：整块不存在，就别用骨架屏占一块地方。
    const next = Object.assign({ packs, packHint, showPacks: !!this._runningLow }, state ? { packState: state } : {});
    this.setData(next);
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
      // 见底判定。算力：非不限量且已用 ≥80%，但手上还有没用完的增购算力就不催（那是已经买过的）。
      // 钻石：余额为 0 时启用顾问/出图当场被挡，此时不摆增购等于把人卡死。
      // /me 没读到（弱网）时一律按「没见底」处理：宁可不推销，也不拿错数吓人。
      const quotaLow = !!usage && !usage.unlimited && Number(usage.usagePercent) >= RUNNING_LOW_PERCENT && !(packRemaining > 0);
      const creditsLow = balance != null && Number(balance) === 0;
      this._runningLow = quotaLow || creditsLow;
      this.applyPacks();
      this._loaded = true; this.setData({
        loading: false, errorText: '', creditBalance: Number(balance) < 0 ? '不限量' : String(balance == null ? '—' : balance),
        // 余量同样不报数：它就是刚买那笔的量级，写出来等于把包的 token 数贴脸上。
        packRemainingText: packRemaining > 0 ? '仍有余量' : '',
        usageText: usage ? usageLabel(usage) : '', usagePercent: usage && usage.unlimited ? 100 : Number(usage && usage.usagePercent) || 0, usageUnlimited: Boolean(usage && usage.unlimited),
        items: (credits && credits.items || []).map((item) => Object.assign({}, item, { atText: fmtAt(item.at), deltaText: Number(item.delta) >= 0 ? `+${item.delta}` : String(item.delta), positive: Number(item.delta) >= 0 })),
        orders: (orderResult.items || orderResult || []).map(mapOrder),
      });
    } catch (error) { const kind = store.handleApiError(error, { silent: true }); this._loaded = true; this.setData({ loading: false, errorText: kind === 'unauthorized' ? '' : (error.message || '算力明细读取失败'), showLogin: kind === 'unauthorized' }); }
  },
  retry() { this.load(); },
  goPlans() { navTo('/packages/work/plans/index'); },
  // 增购下单：与方案页同一条阶梯（services/packs 里那一份，别再各写各的）。
  async buyPack(event) {
    const key = event.currentTarget.dataset.key;
    const pack = this.data.packs.find((item) => item.key === key);
    if (!pack || this.data.purchasing) return;
    if (!store.isAuthed()) { this.setData({ showLogin: true }); return; }
    this.setData({ purchasing: key });
    try {
      const { state, mock } = await packsService.purchasePack(pack);
      if (state === 'cancelled') return;
      // —— 支付已成功（钱已扣）：后续刷新/查询失败只影响提示，绝不能再报「支付失败」。 ——
      await store.loadMe().catch(() => {});
      await this.load();
      wx.showToast(packsService.purchaseToast(state, mock));
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
  waitApplied(outTradeNo) { return packsService.waitApplied(outTradeNo); },
}));
