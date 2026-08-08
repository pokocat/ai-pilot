const { api, isMock } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');

function money(fen) {
  if (Number(fen) < 0) return '面议';
  return `¥${(Number(fen || 0) / 100).toFixed(Number(fen || 0) % 100 ? 2 : 0)}`;
}

function clientRequestId() {
  return `plan-native-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function periodLabel(period) {
  return period === 'year' ? '年付' : '月付';
}

function dateLabel(value) {
  if (!value) return '长期有效';
  const date = new Date(value);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function dateTimeLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function isPlanExpired(value) {
  if (!value) return false;
  const expiresAt = new Date(value).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

/**
 * 折扣展示。**折扣率、立省金额、生效时间窗全部由服务端算好**（Plan.promotion）——
 * 端上再算一遍迟早出现「显示 1 折、下单扣原价」。这里只做文案拼装，且必须在 setData 前算完：
 * WXML 不能调函数，漏一个字段就只能在模板里堆三目运算，下次改文案必漏。
 * 没在优惠期返回 null，卡片上那几行连同角标一起不渲染。
 */
function promoView(plan) {
  const promo = plan && plan.promotion;
  if (!promo) return null;
  return {
    discountLabel: promo.discountLabel,
    // 运营没填活动名时给中性兜底，避免角标旁边空一块
    kickerText: String(promo.label || '').trim() || '限时优惠',
    listPriceText: money(promo.listPrice),
    saveText: `立省 ${money(promo.savedFen)}`,
    savedAmountText: money(promo.savedFen),
    // 长期有效不写「长期有效」，那是噪音不是紧迫感
    deadlineText: promo.endsAt ? `优惠 ${dateLabel(promo.endsAt)} 截止` : '',
  };
}

function normalizeOption(option, currentId) {
  const plan = option.plan || option;
  const action = option.action || (!currentId ? 'buy' : plan.id === currentId ? 'renew' : 'upgrade');
  const labels = {
    buy: '购买', renew: '续期', upgrade: '升级', change_billing: '转为此周期', billing_change: '转为此周期',
    continue_payment: '继续支付', wait_applied: '到账中', contact: '咨询', remind: '暂不可降档',
  };
  const pendingOrder = option.pendingOrder || null;
  return Object.assign({}, option, {
    plan,
    pendingOrder,
    // priceText 已经是「此刻的成交价」（服务端 withEffectivePrice 解析过），挂牌价只在 promo.listPriceText 里
    priceText: money(plan.price),
    priceUnitText: Number(plan.price) < 0 ? '' : `/ ${plan.period === 'year' ? '年' : '月'}`,
    promo: promoView(plan),
    periodText: periodLabel(plan.period),
    pendingText: pendingOrder && pendingOrder.payableUntil ? `可在 ${dateTimeLabel(pendingOrder.payableUntil)} 前继续支付` : '',
    expired: plan.id === currentId && isPlanExpired(option.expiresAt),
    expiresText: option.expiresAt ? dateLabel(option.expiresAt) : '',
    actionText: labels[action] || '选择',
    action,
    busyKey: action === 'continue_payment' && pendingOrder ? pendingOrder.outTradeNo : plan.id,
    canPurchase: option.canPurchase !== false && action !== 'wait_applied' && action !== 'remind',
  });
}

function normalizeSubscription(subscription) {
  if (!subscription || !['pending', 'active', 'cancel_pending'].includes(subscription.status)) return null;
  const statusTitle = subscription.status === 'active'
    ? '自动续费已开启'
    : subscription.status === 'cancel_pending' ? '自动续费关闭中' : '自动续费确认中';
  const statusNote = subscription.status === 'active' && subscription.nextBillingAt
    ? `预计 ${dateLabel(subscription.nextBillingAt)} 发起下周期续费`
    : subscription.status === 'pending' ? '以微信支付页的最终选择为准' : '当前周期仍可继续使用';
  return Object.assign({}, subscription, {
    statusTitle,
    statusNote,
    canCancel: subscription.status !== 'cancel_pending',
  });
}

function paymentToast(state, mocked, appliedTitle) {
  if (mocked) {
    return state === 'applied'
      ? { title: '模拟支付已到账（测试期，未实际付款）', icon: 'none' }
      : { title: '模拟支付已提交，权益待确认（测试期，未实际付款）', icon: 'none' };
  }
  if (state === 'applied') return { title: appliedTitle, icon: 'success' };
  if (state === 'failed') return { title: '订单状态待确认，请刷新后重新发起', icon: 'none' };
  return { title: '支付已受理，权益到账中，请稍后刷新', icon: 'none' };
}

Page({
  data: baseData({
    loading: true, showLogin: false, authed: false, period: 'month', current: null, usage: null,
    subscription: null, options: [], periodTabs: [], showPeriodSwitch: false,
    quote: null, purchaseMode: 'manual', busy: '',
  }),

  onLoad() {
    this._intent = '';
    this.load();
  },

  onShow() {
    this.setData({ themeClass: store.snapshot().themeClass, authed: store.isAuthed() });
  },

  back() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) });
  },

  closeLogin() {
    this.setData({ showLogin: false });
  },

  loggedIn() {
    this.setData({ showLogin: false, authed: true });
    this.load();
  },

  setPeriod(event) {
    this.setData({ period: event.currentTarget.dataset.period });
    this.applyFilter();
  },

  /**
   * 周期 tab 按**实际配出来的档**决定：运营只配了年付，就不该出现一个点进去空着的月付 tab。
   * 「有没有这个周期」直接用同一个 filter 判空，不另写一套规则——两套规则一旦漂移，
   * 就会出现 tab 点得进去、里面空着。只剩一种周期时整个切换器收起（选不动的二选一是纯噪音）。
   * tab 文案同样预计算：WXML 不能调函数。
   */
  applyFilter() {
    const all = this._options || [];
    const periods = ['month', 'year'].filter((period) => all.some((item) => item.plan.period === period));
    // 当前选中的周期没货就落到第一个有货的；一个都没有时保持原样，交给空态文案。
    const period = periods.length && periods.indexOf(this.data.period) < 0 ? periods[0] : this.data.period;
    this.setData({
      period,
      periodTabs: periods.map((value) => ({ value, label: periodLabel(value) })),
      showPeriodSwitch: periods.length > 1,
      options: all.filter((item) => item.plan.period === period),
    });
  },

  async load() {
    this.setData({ loading: true });
    try {
      if (store.isAuthed()) {
        const result = await api.planOptions();
        const all = (result.options || []).map((item) => normalizeOption(item, result.currentPlanId));
        this._options = all;
        const current = all.find((item) => item.plan.id === result.currentPlanId) || null;
        this.setData({
          current,
          usage: result.usage || null,
          subscription: normalizeSubscription(result.subscription),
          authed: true,
          loading: false,
        });
        this.applyFilter();
      } else {
        const plans = await api.plans();
        this._options = (plans || []).map((plan) => normalizeOption(plan, ''));
        this.setData({ current: null, usage: null, subscription: null, authed: false, loading: false });
        this.applyFilter();
      }
    } catch (error) {
      store.handleApiError(error, { silent: true });
      this.setData({ loading: false });
    }
  },

  async choose(event) {
    if (!store.isAuthed()) {
      this.setData({ showLogin: true });
      return;
    }
    const option = this.data.options[Number(event.currentTarget.dataset.index)];
    if (!option || this.data.busy) return;
    if (option.action === 'contact') {
      wx.showToast({ title: '顾问会与你确认范围和报价', icon: 'none' });
      return;
    }
    if (option.action === 'wait_applied') {
      wx.showToast({ title: '支付已完成，权益正在到账', icon: 'none' });
      return;
    }
    if (option.action === 'continue_payment') {
      if (option.pendingOrder) await this.continuePayment(option.pendingOrder);
      else wx.showToast({ title: option.reason || '待支付订单已失效，请刷新后重试', icon: 'none' });
      return;
    }
    if (!option.canPurchase) {
      wx.showToast({ title: option.reason || option.actionText, icon: 'none' });
      return;
    }
    this.setData({ busy: option.plan.id });
    try {
      const quote = await api.quotePlan(option.plan.id);
      quote.fullPriceText = money(quote.fullPrice);
      quote.remainingValueText = money(quote.remainingValue);
      quote.chargeText = money(quote.chargeAmount);
      quote.periodText = periodLabel(quote.targetPlan.period);
      quote.promo = promoView(quote.targetPlan);
      quote.currentName = quote.currentPlan && quote.currentPlan.name ? quote.currentPlan.name : '未开通';
      this._intent = clientRequestId();
      this.setData({ quote, purchaseMode: 'manual' });
    } catch (error) {
      wx.showToast({ title: error.message || '报价失败', icon: 'none' });
    } finally {
      this.setData({ busy: '' });
    }
  },

  stop() {},

  closeQuote() {
    if (!this.data.busy) {
      this._intent = '';
      this.setData({ quote: null, purchaseMode: 'manual' });
    }
  },

  chooseMode(event) {
    const mode = event.currentTarget.dataset.mode;
    if (mode === 'auto' && !(this.data.quote && this.data.quote.targetPlan.autoRenewAvailable)) return;
    this.setData({ purchaseMode: mode });
  },

  async payOrder(order) {
    if (order.mock) {
      await api.payMock(order.outTradeNo);
      return true;
    }
    if (!order.pay) throw Object.assign(new Error('缺少支付参数，请刷新后重试'), { code: 'ORDER_NOT_PAYABLE' });
    await new Promise((resolve, reject) => wx.requestPayment(Object.assign({}, order.pay, { success: resolve, fail: reject })));
    return false;
  },

  async continuePayment(pendingOrder) {
    if (!pendingOrder || this.data.busy) return;
    const outTradeNo = pendingOrder.outTradeNo;
    this.setData({ busy: outTradeNo });
    try {
      const params = await api.orderPayParams(outTradeNo);
      const mocked = await this.payOrder(Object.assign({ outTradeNo }, params));
      const state = await this.waitApplied(outTradeNo);
      await store.loadMe().catch(() => {});
      await this.load();
      wx.showToast(paymentToast(state, mocked, '支付成功，方案已更新'));
    } catch (error) {
      const cancelled = /cancel/i.test(String(error.errMsg || error.message || ''));
      wx.showToast({ title: cancelled ? '已取消支付' : (error.message || '支付没有完成'), icon: 'none' });
      const code = error.code || (error.data && error.data.code);
      if (code === 'ORDER_EXPIRED' || code === 'ORDER_NOT_PAYABLE') await this.load();
    } finally {
      this.setData({ busy: '' });
    }
  },

  async confirmPay() {
    const quote = this.data.quote;
    if (!quote || this.data.busy) return;
    this.setData({ busy: quote.targetPlan.id });
    try {
      if (isMock() || Number(quote.targetPlan.price) === 0) {
        await api.purchasePlan(quote.targetPlan.id);
        await store.loadMe().catch(() => {});
        this.setData({ quote: null, purchaseMode: 'manual' });
        this._intent = '';
        await this.load();
        wx.showToast({ title: '方案已更新', icon: 'success' });
        return;
      }
      const mode = this.data.purchaseMode === 'auto' && quote.targetPlan.autoRenewAvailable ? 'auto' : 'manual';
      const body = {
        clientRequestId: this._intent || clientRequestId(),
        quoteFingerprint: quote.quoteFingerprint,
        expectedChargeAmount: quote.chargeAmount,
      };
      const order = mode === 'auto'
        ? await api.createContractOrder(quote.targetPlan.id, body)
        : await api.createOrder(quote.targetPlan.id, body);
      const mocked = await this.payOrder(order);
      const state = await this.waitApplied(order.outTradeNo);
      await store.loadMe().catch(() => {});
      this.setData({ quote: null, purchaseMode: 'manual' });
      this._intent = '';
      await this.load();
      wx.showToast(paymentToast(state, mocked, '支付成功，方案已更新'));
    } catch (error) {
      const cancelled = /cancel/i.test(String(error.errMsg || error.message || ''));
      wx.showToast({ title: cancelled ? '已取消支付' : (error.message || '支付没有完成'), icon: 'none' });
      if (error.code === 'QUOTE_CHANGED' || (error.data && error.data.code === 'QUOTE_CHANGED')) {
        this._intent = '';
        this.setData({ quote: null });
      }
    } finally {
      this.setData({ busy: '' });
    }
  },

  async waitApplied(outTradeNo) {
    if (!outTradeNo) return 'pending';
    for (let index = 0; index < 5; index += 1) {
      try {
        const status = await api.paymentStatus(outTradeNo);
        if (status.appliedAt || status.status === 'applied') return 'applied';
        if (['failed', 'closed', 'refunded'].includes(status.status)) return 'failed';
      } catch (_) { /* 状态查询网络抖动时继续确认，超时后按 pending 提示。 */ }
      if (index < 4) await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return 'pending';
  },

  async cancelAutoRenew() {
    const subscription = this.data.subscription;
    if (!subscription || !subscription.canCancel || this.data.busy) return;
    const modal = await new Promise((resolve) => wx.showModal({
      title: '关闭自动续费',
      content: '关闭后当前已购周期仍可继续使用，到期后不会再自动扣款。',
      confirmText: '确认关闭',
      confirmColor: '#8C3B2E',
      success: resolve,
      fail: () => resolve({ confirm: false }),
    }));
    if (!modal.confirm) return;
    this.setData({ busy: subscription.id });
    try {
      const result = await api.cancelPlanSubscription(subscription.id);
      await this.load();
      const status = result && result.subscription && result.subscription.status;
      wx.showToast({
        title: status === 'cancelled' ? '已关闭自动续费' : '已提交关闭，请稍后确认',
        icon: status === 'cancelled' ? 'success' : 'none',
      });
    } catch (error) {
      wx.showToast({ title: error.message || '关闭自动续费失败，请重试', icon: 'none' });
    } finally {
      this.setData({ busy: '' });
    }
  },
});
