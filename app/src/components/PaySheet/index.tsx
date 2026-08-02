import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Sheet from '../Sheet';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api, type ActivationSource } from '../../services/api';
import { awaitPaymentApplied, payAppliedToast, ensurePayableEnv, payOrder } from '../../services/pay';
import { requestWechatSubscribe } from '../../services/wechatSubscribe';
import { paymentErrorMessage } from '../../services/paymentFeedback';
import './index.scss';

export interface PaySheetProps {
  open: boolean;
  mode?: 'credits' | 'sku' | 'member' | 'quota';
  title?: string;
  desc?: string;
  costLabel?: string;   // 顶部 kicker（间隔字）；缺省按 mode 推导
  costValue?: string;   // 账本「本次消耗」
  balanceValue?: string; // 账本「当前余额」（.warn 金色行）
  afterValue?: string;  // 账本「扣后状态」
  result?: string;      // 账本下方结果说明（.pay-result）
  confirmText?: string;
  skuKey?: string;
  source?: ActivationSource; // D-1 开通来源归因（默认 SKU 下单路径带入；缺省 catalog）
  refId?: string;            // source=prescription 时的处方 id
  onConfirm?: () => void;
  onClose?: () => void;
}

// mode → kicker 默认文案（间隔字，见设计规格 §2.2）。costLabel 可覆盖。
const MODE_KICKER: Record<NonNullable<PaySheetProps['mode']>, string> = {
  credits: '扣 算 力 确 认',
  sku: '单 次 付 费',
  member: '会 员 权 益',
  quota: '本 月 额 度',
};

// V7-03 PaySheet：账本式付费确认弹层（本次消耗 / 当前余额 / 扣后状态）。
// mode='sku' 且给定 skuKey 且无 onConfirm 覆写时，默认走 SKU 下单 → 微信支付 → 重拉 /me 阶梯；
// 传入 onConfirm 则调用方自持效果（含关闭），本组件仅负责防抖与弹层协调。
export default function PaySheet({
  open, mode = 'credits', title, desc, costLabel, costValue, balanceValue, afterValue,
  result, confirmText, skuKey, source = 'catalog', refId, onConfirm, onClose,
}: PaySheetProps) {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [busy, setBusy] = useState(false);

  const kicker = costLabel || MODE_KICKER[mode] || '确 认 启 用';

  const confirm = async () => {
    if (busy) return;
    // 到账提醒索权（scene=payment）：微信要求订阅弹窗由点击手势直接唤起，故必须在本函数首个 await 之前发出
    // （模板配置已在登录后预热，缓存命中时同步唤起）。先等它落定再走支付，避免两个弹窗抢焦点；
    // 拒绝/失败一律不阻断支付。
    const subscribing = process.env.TARO_ENV === 'weapp'
      ? requestWechatSubscribe('payment').catch((e) => { console.warn('[subscribe] payment 授权失败', e); return false; })
      : Promise.resolve(false);
    setBusy(true);
    try {
      await subscribing;
      if (onConfirm) { await onConfirm(); return; } // 调用方自持效果

      // 默认：单次付费商品（SKU）下单 → 微信支付 → 到账确认（mock 返回 demo 已本地发放）。
      if (mode === 'sku' && skuKey) {
        if (!ensurePayableEnv()) return; // H5（server 模式）：下单前拦下
        const order = await api.createSkuOrder(skuKey, undefined, { source, refId });
        if (order.payParams) {
          // mock=true（服务端 PAY_MOCK_SUCCESS 测试期）→ 跳过 wx.requestPayment 走模拟到账。
          const mocked = await payOrder({ outTradeNo: order.orderId, pay: order.payParams, mock: order.mock });
          // —— 支付已成功（钱已扣）：后续刷新/查询失败只影响提示，绝不能再报「支付失败」。 ——
          const applied = await awaitPaymentApplied(order.orderId);
          await store.loadMe().catch(() => {});
          Taro.showToast(payAppliedToast(applied, '已开通，权益已更新', { mock: mocked }));
        } else {
          // mock/演示通道：下单即已本地发放
          await store.loadMe().catch(() => {});
          Taro.showToast({ title: '已开通，权益已更新', icon: 'success' });
        }
      }
      onClose?.();
    } catch (e) {
      Taro.showToast({ title: paymentErrorMessage(e, 'payment'), icon: 'none' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      visible={open}
      onClose={onClose}
      overlayKey="paysheet"
      footer={
        <View className="pay-actions">
          <View className="btn btn-ghost pay-secondary" onClick={onClose}><Text>先不了</Text></View>
          <View className={`btn btn-primary pay-primary ${busy ? 'disabled' : ''}`} style={{ background: accent }} onClick={confirm}>
            <Text>{busy ? '处理中…' : (confirmText || '确认')}</Text>
          </View>
        </View>
      }
    >
      <Text className="pay-k">{kicker}</Text>
      <Text className="pay-title serif">{title || '确认'}</Text>
      {!!desc && <Text className="pay-desc">{desc}</Text>}

      <View className="pay-ledger">
        <View className="pay-row"><Text className="pay-rk">本次消耗</Text><Text className="pay-rv">{costValue || '—'}</Text></View>
        <View className="pay-row warn"><Text className="pay-rk">当前余额</Text><Text className="pay-rv">{balanceValue || '—'}</Text></View>
        <View className="pay-row"><Text className="pay-rk">扣后状态</Text><Text className="pay-rv">{afterValue || '—'}</Text></View>
      </View>

      {!!result && <Text className="pay-result">{result}</Text>}
    </Sheet>
  );
}
