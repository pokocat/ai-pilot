const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { navTo } = require('../../../services/nav');

const ORDER_LABEL = { created: '待支付', paid: '已支付 · 权益发放中', applied: '已完成', failed: '支付失败', closed: '已关闭', refunded: '已退款' };
const REFUND_LABEL = { refund_requested: '退款已申请', refund_processing: '退款处理中', refund_closed: '退款已关闭', refund_abnormal: '退款异常', refunded: '已退款' };
function fmtAt(iso) { const value = String(iso || ''); const match = value.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); return match ? `${match[2]}-${match[3]} ${match[4]}:${match[5]}` : value.slice(0, 16); }
function usageLabel(usage) { if (!usage) return '—'; return usage.unlimited ? '不限量' : `本月已用 ${Number(usage.usagePercent) || 0}%`; }
function mapOrder(order) {
  const refund = order.refundStatus && REFUND_LABEL[order.refundStatus]; const label = refund || ORDER_LABEL[order.status] || order.status;
  const mockText = order.mock ? ' · 测试期模拟支付' : ''; const timeText = fmtAt(order.paidAt || order.createdAt);
  const payableText = order.payable && order.payableUntil ? ` · 可支付至 ${fmtAt(order.payableUntil)}` : '';
  return Object.assign({}, order, { statusText: `${label}${mockText} · ${timeText} · 单号 …${String(order.outTradeNo || '').slice(-6)}${payableText}`, amountText: `¥${(Number(order.amount || 0) / 100).toFixed(2)}`, bad: order.status === 'refunded' || order.status === 'failed', actionText: order.mock ? '模拟支付' : '继续支付' });
}

Page({
  data: baseData({ loading: true, creditBalance: '—', usageText: '—', usagePercent: 0, usageUnlimited: false, items: [], orders: [], repaying: '', errorText: '', showLogin: false }),
  onLoad() { this.load(); },
  onShow() { this.setData({ themeClass: store.snapshot().themeClass }); if (this._loaded) this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) }); },
  closeLogin() { this.setData({ showLogin: false }); }, loggedIn() { this.setData({ showLogin: false }); this.load(); },
  async load() {
    if (!store.isAuthed()) { this.setData({ loading: false, showLogin: true }); return; }
    if (!this._loaded) this.setData({ loading: true });
    try {
      const [credits, orderResult, me] = await Promise.all([api.credits(), api.orders().catch(() => ({ items: [] })), store.loadMe()]);
      // 余额与用量的唯一真源是 /me（creditBalance / usage）。这里曾兜底读 credits.balance 与
      // credits.usedPercent，但 /me/credits 只返回 { items }，这两个字段真服务端永远是 undefined：
      // store.loadMe() 内部吞掉请求错误直接返回 null，于是弱网下 /me 一失败，用量就被静默写成
      // 「本月已用 0%」——一个看起来正常的错数，比留空更误导。拿不到就不显示这行。
      const usage = me && me.usage; const balance = me && me.creditBalance != null ? me.creditBalance : null;
      this._loaded = true; this.setData({
        loading: false, errorText: '', creditBalance: Number(balance) < 0 ? '不限量' : String(balance == null ? '—' : balance),
        usageText: usage ? usageLabel(usage) : '', usagePercent: usage && usage.unlimited ? 100 : Number(usage && usage.usagePercent) || 0, usageUnlimited: Boolean(usage && usage.unlimited),
        items: (credits && credits.items || []).map((item) => Object.assign({}, item, { atText: fmtAt(item.at), deltaText: Number(item.delta) >= 0 ? `+${item.delta}` : String(item.delta), positive: Number(item.delta) >= 0 })),
        orders: (orderResult.items || orderResult || []).map(mapOrder),
      });
    } catch (error) { const kind = store.handleApiError(error, { silent: true }); this._loaded = true; this.setData({ loading: false, errorText: kind === 'unauthorized' ? '' : (error.message || '算力明细读取失败'), showLogin: kind === 'unauthorized' }); }
  },
  retry() { this.load(); },
  goPlans() { navTo('/packages/work/plans/index'); },
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
});
