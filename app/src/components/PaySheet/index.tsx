import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api, type ActivationSource } from '../../services/api';
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

  useEffect(() => {
    store.setOverlay(open, 'paysheet');
    return () => store.setOverlay(false, 'paysheet');
  }, [open]);

  if (!open) return null;
  const kicker = costLabel || MODE_KICKER[mode] || '确 认 启 用';

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (onConfirm) { await onConfirm(); return; } // 调用方自持效果

      // 默认：单次付费商品（SKU）下单 → 微信支付 → 重拉 /me（mock 返回 demo 已本地发放）。
      if (mode === 'sku' && skuKey) {
        const order = await api.createSkuOrder(skuKey, undefined, { source, refId });
        if (order.payParams) {
          await Taro.requestPayment({
            timeStamp: order.payParams.timeStamp,
            nonceStr: order.payParams.nonceStr,
            package: order.payParams.package,
            signType: order.payParams.signType as 'RSA',
            paySign: order.payParams.paySign,
          });
        }
        // 支付成功 → 权益异步发放，轻量重试刷新 /me。
        await store.loadMe();
        await new Promise((r) => setTimeout(r, 1500));
        await store.loadMe();
        Taro.showToast({ title: '已开通，权益已更新', icon: 'success' });
      }
      onClose?.();
    } catch (e: any) {
      const code = e?.code || e?.data?.code;
      if (e?.errMsg && /cancel/i.test(e.errMsg)) Taro.showToast({ title: '已取消支付', icon: 'none' });
      else if (code === 'PAYMENT_NOT_CONFIGURED' || code === 'PAYMENT_COMING_SOON') Taro.showToast({ title: '支付即将开通，敬请期待', icon: 'none' });
      else s.handleApiError(e, { fallbackTitle: '支付失败，请重试' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="pay-mask" onClick={onClose} catchMove>
      <View className="pay-panel" onClick={(e) => e.stopPropagation()}>
        <View className="pay-grip" />
        <Text className="pay-k">{kicker}</Text>
        <Text className="pay-title serif">{title || '确认启用'}</Text>
        {!!desc && <Text className="pay-desc">{desc}</Text>}

        <View className="pay-ledger">
          <View className="pay-row"><Text className="pay-rk">本次消耗</Text><Text className="pay-rv">{costValue || '—'}</Text></View>
          <View className="pay-row warn"><Text className="pay-rk">当前余额</Text><Text className="pay-rv">{balanceValue || '—'}</Text></View>
          <View className="pay-row"><Text className="pay-rk">扣后状态</Text><Text className="pay-rv">{afterValue || '—'}</Text></View>
        </View>

        {!!result && <Text className="pay-result">{result}</Text>}

        <View className="pay-actions">
          <View className="btn btn-ghost pay-secondary" onClick={onClose}><Text>先不启用</Text></View>
          <View className={`btn btn-primary pay-primary ${busy ? 'disabled' : ''}`} style={{ background: accent }} onClick={confirm}>
            <Text>{busy ? '处理中…' : (confirmText || '确认启用')}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}
