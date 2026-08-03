import { useState } from 'react';
import { ScrollView, Text, View } from '@tarojs/components';
import Taro, { useDidShow, usePullDownRefresh } from '@tarojs/taro';
import SafeHeader from '../../../components/SafeHeader';
import Icon from '../../../components/Icon';
import AsyncState from '../../../components/AsyncState';
import { api, type PayOrderListItem, type PlanOption, type PlanOptionsResult, type PlanQuote } from '../../../services/api';
import { useStore } from '../../../hooks/useStore';
import { store } from '../../../services/store';
import { awaitPaymentApplied, ensurePayableEnv, payAppliedToast, payOrder } from '../../../services/pay';
import { requestWechatSubscribe } from '../../../services/wechatSubscribe';
import { paymentErrorMessage } from '../../../services/paymentFeedback';
import { useMockApi } from '../../../services/runtimeMode';
import { ACTION_LABEL, DEFAULT_PURCHASE_MODE, STATUS_LABEL, canStartPurchase, currentPlanOption, effectivePurchaseMode, isPlanExpired, publicFeatures, type PurchaseMode, visiblePlanOptions } from './model';
import './index.scss';

function money(fen: number) { return `¥${(fen / 100).toLocaleString(undefined, { minimumFractionDigits: fen % 100 ? 2 : 0 })}`; }
function dateLabel(value?: string | null) {
  if (!value) return '长期有效';
  const d = new Date(value);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
function dateTimeLabel(value: string) {
  const d = new Date(value);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function expiresSoon(value?: string | null) {
  if (!value) return false;
  const days = (new Date(value).getTime() - Date.now()) / 86400000;
  return days >= 0 && days <= 7;
}
function clientRequestId() { return `plan-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
export default function PlanManagement() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [data, setData] = useState<PlanOptionsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<'month' | 'year'>('month');
  const [quote, setQuote] = useState<PlanQuote | null>(null);
  const [purchaseIntentId, setPurchaseIntentId] = useState('');
  const [purchaseMode, setPurchaseMode] = useState<PurchaseMode>(DEFAULT_PURCHASE_MODE);
  const [busy, setBusy] = useState('');

  const track = (event: Parameters<typeof api.planEvent>[0]['event'], extra: Omit<Parameters<typeof api.planEvent>[0], 'event'> = {}) => {
    void api.planEvent({ event, ...extra }).catch((e) => console.warn('[plan-event]', event, e));
  };

  const load = (done?: () => void) => api.planOptions().then((result) => {
    setData(result);
    if (result.currentPlanId) track('current_view', { planId: result.currentPlanId });
    for (const option of result.options) if (option.pendingOrder) track('order_view', { planId: option.plan.id, orderNo: option.pendingOrder.outTradeNo });
  }).catch((e) => s.handleApiError(e)).finally(() => { setLoading(false); done?.(); });
  useDidShow(() => { track('page_open'); load(); });
  usePullDownRefresh(() => load(() => Taro.stopPullDownRefresh()));

  const current = currentPlanOption(data);
  const currentExpired = isPlanExpired(current?.expiresAt);
  const options = visiblePlanOptions(data, period);

  const continuePayment = async (order: PayOrderListItem) => {
    if (busy || (!order.mock && !ensurePayableEnv())) return;
    setBusy(order.outTradeNo);
    track('order_continue', { planId: order.planId, orderNo: order.outTradeNo });
    try {
      const params = await api.orderPayParams(order.outTradeNo);
      const mocked = await payOrder({ outTradeNo: order.outTradeNo, pay: params.pay, mock: params.mock });
      const applied = await awaitPaymentApplied(order.outTradeNo);
      track(applied === 'applied' ? 'entitlement_applied' : 'payment_pending', { planId: order.planId, orderNo: order.outTradeNo });
      await store.loadMe().catch(() => {});
      Taro.showToast(payAppliedToast(applied, '支付成功，方案已更新', { mock: mocked }));
      load();
    } catch (e) { track(isCancel(e) ? 'payment_cancel' : 'payment_failure', { planId: order.planId, orderNo: order.outTradeNo, code: errorCode(e) }); Taro.showToast({ title: paymentErrorMessage(e, 'payment'), icon: 'none' }); }
    finally { setBusy(''); }
  };

  const choose = async (option: PlanOption) => {
    if (option.action === 'renew') track('renew_click', { planId: option.plan.id, relation: option.relation });
    else if (option.action === 'upgrade') track('upgrade_click', { planId: option.plan.id, relation: option.relation });
    else if (option.action === 'change_billing') track('billing_change_click', { planId: option.plan.id, relation: option.relation });
    else if (option.action === 'remind') track('downgrade_remind_click', { planId: option.plan.id, relation: option.relation });
    if (option.action === 'contact') return Taro.showToast({ title: '顾问会与您确认范围和报价', icon: 'none' });
    if (!canStartPurchase(option)) return Taro.showToast({ title: option.reason || ACTION_LABEL[option.action], icon: 'none' });
    if (option.action === 'wait_applied') return Taro.showToast({ title: '支付已完成，权益正在到账', icon: 'none' });
    if (option.action === 'continue_payment' && option.pendingOrder) return continuePayment(option.pendingOrder);
    setBusy(option.plan.id);
    try {
      setQuote(await api.quotePlan(option.plan.id));
      setPurchaseMode(DEFAULT_PURCHASE_MODE); // 官方要求自动续费不能默认勾选；每次报价都从单次购买开始。
      track('quote_success', { planId: option.plan.id, relation: option.relation });
      setPurchaseIntentId(clientRequestId());
    }
    catch (e) { track('quote_failure', { planId: option.plan.id, relation: option.relation, code: errorCode(e) }); Taro.showToast({ title: paymentErrorMessage(e, 'quote'), icon: 'none' }); }
    finally { setBusy(''); }
  };

  const confirmPay = async () => {
    if (!quote || busy) return;
    track('quote_confirm', { planId: quote.targetPlan.id, relation: quote.relation });
    if (useMockApi() || quote.targetPlan.price === 0) {
      setBusy(quote.targetPlan.id);
      try {
        await api.purchasePlan(quote.targetPlan.id);
        await store.loadMe().catch(() => {});
        setQuote(null); setPurchaseIntentId(''); load();
        Taro.showToast({ title: '方案已更新', icon: 'success' });
      } catch (e) { Taro.showToast({ title: paymentErrorMessage(e, 'payment'), icon: 'none' }); }
      finally { setBusy(''); }
      return;
    }
    if (!ensurePayableEnv()) return;
    const subscribing = process.env.TARO_ENV === 'weapp' ? requestWechatSubscribe('payment').catch(() => false) : Promise.resolve(false);
    setBusy(quote.targetPlan.id);
    try {
      await subscribing;
      const mode = effectivePurchaseMode(purchaseMode, quote.targetPlan.autoRenewAvailable);
      const order = mode === 'auto'
        ? await api.createContractOrder(quote.targetPlan.id, {
          clientRequestId: purchaseIntentId || clientRequestId(), quoteFingerprint: quote.quoteFingerprint, expectedChargeAmount: quote.chargeAmount,
        })
        : await api.createOrder(quote.targetPlan.id, {
        clientRequestId: purchaseIntentId || clientRequestId(), quoteFingerprint: quote.quoteFingerprint, expectedChargeAmount: quote.chargeAmount,
        });
      const mocked = await payOrder({ outTradeNo: order.outTradeNo, pay: order.pay, mock: order.mock });
      track('payment_success', { planId: quote.targetPlan.id, orderNo: order.outTradeNo });
      const applied = await awaitPaymentApplied(order.outTradeNo);
      track(applied === 'applied' ? 'entitlement_applied' : 'payment_pending', { planId: quote.targetPlan.id, orderNo: order.outTradeNo });
      await store.loadMe().catch(() => {});
      setQuote(null); setPurchaseIntentId(''); load();
      Taro.showToast(payAppliedToast(applied, '支付成功，方案已更新', { mock: mocked }));
    } catch (e) {
      track(isCancel(e) ? 'payment_cancel' : 'payment_failure', { planId: quote.targetPlan.id, code: errorCode(e) });
      const message = paymentErrorMessage(e, 'payment');
      Taro.showToast({ title: message, icon: 'none' });
      if ((e as { code?: string })?.code === 'QUOTE_CHANGED') { setQuote(null); setPurchaseIntentId(''); }
    } finally { setBusy(''); }
  };

  const cancelAutoRenew = async () => {
    const subscription = data?.subscription;
    if (!subscription || busy) return;
    const modal = await Taro.showModal({ title: '关闭自动续费', content: '关闭后当前已购周期仍可继续使用，到期后不会再自动扣款。', confirmText: '确认关闭', confirmColor: '#8C3B2E' });
    if (!modal.confirm) return;
    setBusy(subscription.id);
    try {
      const result = await api.cancelPlanSubscription(subscription.id);
      track('auto_renew_cancel', { planId: subscription.planId });
      await load();
      Taro.showToast({ title: result.subscription.status === 'cancelled' ? '已关闭自动续费' : '已提交关闭，请稍后确认', icon: 'success' });
    } catch (e) { Taro.showToast({ title: paymentErrorMessage(e, 'payment'), icon: 'none' }); }
    finally { setBusy(''); }
  };

  return (
    <View className={`page plan-page ${s.themeClass()}`}>
      <SafeHeader title="方案与权益" onBack={() => Taro.navigateBack()} />
      {loading && !data ? <View className="plan-pad"><AsyncState loading skeletonRows={4} /></View> : (
        <ScrollView scrollY enhanced showScrollbar={false} className="plan-scroll">
          <View className="plan-pad">
            {current ? (
              <View className="current-plan">
                <View className="current-top"><Text className="current-k">我的方案</Text><Text className="state-pill">{currentExpired ? '已到期' : '使用中'}</Text></View>
                <Text className="current-name">{current.plan.name}</Text>
                <Text className="usage-level">{current.plan.usageLabel}</Text>
                {!currentExpired && <View className="usage-row"><Text>{STATUS_LABEL[data!.usage.usageStatus]}</Text><Text>{data!.usage.unlimited ? '专属配置' : `${data!.usage.usagePercent}%`}</Text></View>}
                {!currentExpired && !data!.usage.unlimited && <View className="usage-track"><View className="usage-fill" style={{ width: `${data!.usage.usagePercent}%`, background: accent }} /></View>}
                <Text className="current-meta">{currentExpired ? `已于 ${dateLabel(current.expiresAt)} 到期` : `有效期至 ${dateLabel(current.expiresAt)}，本周期将于 ${dateLabel(data!.usage.resetsAt)} 恢复`}</Text>
                {data!.subscription && ['pending', 'active', 'cancel_pending'].includes(data!.subscription.status)
                  ? <View className="subscription-row"><View><Text className="subscription-title">{data!.subscription.status === 'active' ? '自动续费已开启' : data!.subscription.status === 'cancel_pending' ? '自动续费关闭中' : '自动续费确认中'}</Text><Text className="manual-note">{data!.subscription.status === 'active' && data!.subscription.nextBillingAt ? `预计 ${dateLabel(data!.subscription.nextBillingAt)} 发起下周期续费` : data!.subscription.status === 'pending' ? '以微信支付页的最终选择为准' : '当前周期仍可继续使用'}</Text></View>{data!.subscription.status !== 'cancel_pending' && <Text className="subscription-cancel" onClick={cancelAutoRenew}>{busy === data!.subscription.id ? '处理中…' : '关闭'}</Text>}</View>
                  : <Text className="manual-note">当前未开启自动续费</Text>}
                {expiresSoon(current.expiresAt) && <Text className="expiry-note">方案即将到期，建议提前续期，避免工作中断</Text>}
                <View className="current-actions">
                  <View className="primary-action" style={{ background: accent }} onClick={() => choose(current)}><Text>{busy === current.plan.id ? '处理中…' : currentExpired ? '重新开通' : `续期 1 ${current.plan.period === 'year' ? '年' : '个月'}`}</Text></View>
                  <View className="secondary-action" onClick={() => Taro.navigateTo({ url: '/packages/work/credits/index' })}><Text>查看订单</Text></View>
                </View>
              </View>
            ) : <View className="no-plan"><Text className="current-k">我的方案</Text><Text className="current-name">尚未开通</Text><Text className="current-meta">选择适合当前经营节奏的方案</Text></View>}

            <View className="section-head"><Text className="section-title">选择下一步</Text><View className="period-switch"><View className={period === 'month' ? 'active' : ''} onClick={() => setPeriod('month')}><Text>月付</Text></View><View className={period === 'year' ? 'active' : ''} onClick={() => setPeriod('year')}><Text>年付</Text></View></View></View>
            {options.map((option) => (
              <View key={option.plan.id} className={`option-row ${option.canPurchase ? '' : 'disabled'}`}>
                <View className="option-main"><View className="option-title-row"><Text className="option-name">{option.plan.name}{option.recommended ? ' · 推荐' : ''}</Text><Text className="option-price">{option.plan.price < 0 ? '面议' : money(option.plan.price)}</Text></View>
                  <Text className="option-level">{option.plan.usageLabel}</Text>
                  {option.pendingOrder?.payableUntil && <Text className="option-expiry">可在 {dateTimeLabel(option.pendingOrder.payableUntil)} 前继续支付</Text>}
                  <View className="feature-list">{publicFeatures(option.plan.featuresJson).map((feature) => <View key={feature}><Icon name="check" size={11} color={accent} /><Text>{feature}</Text></View>)}</View>
                </View>
                <View className={`option-action ${option.canPurchase ? 'enabled' : ''}`} style={option.canPurchase ? { color: accent, borderColor: accent } : undefined} onClick={() => choose(option)}><Text>{busy === option.plan.id ? '处理中…' : ACTION_LABEL[option.action]}</Text></View>
              </View>
            ))}
            <View className="plan-bottom" />
          </View>
        </ScrollView>
      )}

      {quote && <View className="quote-layer" onClick={() => { setQuote(null); setPurchaseIntentId(''); }}><View className="quote-panel" onClick={(e) => e.stopPropagation()}>
        <View className="quote-head"><Text className="quote-title">确认方案</Text><Text className="quote-close" onClick={() => { setQuote(null); setPurchaseIntentId(''); }}>×</Text></View>
        <View className="quote-route"><Text>{quote.currentPlan?.name || '未开通'}</Text><Text>→</Text><Text>{quote.targetPlan.name}</Text></View>
        <View className="quote-line"><Text>方案价格</Text><Text>{money(quote.fullPrice)}</Text></View>
        {quote.remainingValue > 0 && <View className="quote-line"><Text>当前剩余价值抵扣</Text><Text>-{money(quote.remainingValue)}</Text></View>}
        <View className="quote-total"><Text>本次实付</Text><Text>{money(quote.chargeAmount)}</Text></View>
        {quote.targetPlan.autoRenewAvailable && <View className="purchase-modes">
          <View className={`purchase-mode ${purchaseMode === 'manual' ? 'selected' : ''}`} onClick={() => setPurchaseMode('manual')}><View className="mode-radio">{purchaseMode === 'manual' ? '●' : '○'}</View><View><Text className="mode-title">单次购买</Text><Text className="mode-desc">只购买当前周期，到期后由你决定是否续费</Text></View></View>
          <View className={`purchase-mode ${purchaseMode === 'auto' ? 'selected' : ''}`} onClick={() => { setPurchaseMode('auto'); track('auto_renew_select', { planId: quote.targetPlan.id }); }}><View className="mode-radio">{purchaseMode === 'auto' ? '●' : '○'}</View><View><Text className="mode-title">自动续费</Text><Text className="mode-desc">本次 {money(quote.chargeAmount)}，之后每{quote.targetPlan.period === 'year' ? '年' : '月'} {money(quote.fullPrice)}；可随时关闭</Text></View></View>
        </View>}
        <Text className="quote-note">支付后立即生效，有效期至 {dateLabel(quote.newExpiresAt)}。{purchaseMode === 'auto' && quote.targetPlan.autoRenewAvailable ? `你将在微信支付页主动确认自动续费授权；后续每${quote.targetPlan.period === 'year' ? '年' : '月'}续费。` : '本次为单次购买，不会自动续费。'}{quote.relation === 'renew' || quote.relation === 'billing_change' ? '当前月用量不会因续期或转年付重置。' : '升级后的方案权益将立即生效。'}</Text>
        <View className="quote-confirm" style={{ background: accent }} onClick={confirmPay}><Text>{busy ? '处理中…' : '确认并支付'}</Text></View>
      </View></View>}
    </View>
  );
}

function errorCode(error: unknown): string {
  const e = error as { code?: string; data?: { code?: string } };
  return e?.code || e?.data?.code || '';
}
function isCancel(error: unknown): boolean {
  return /cancel/i.test((error as { errMsg?: string })?.errMsg || '');
}
