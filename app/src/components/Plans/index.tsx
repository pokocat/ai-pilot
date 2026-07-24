import { useEffect, useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '../Icon';
import Sheet from '../Sheet';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api, type Plan } from '../../services/api';
import { awaitPaymentApplied, payAppliedToast, ensurePayableEnv, requestWechatPayment } from '../../services/pay';
import './index.scss';

interface Props {
  open: boolean;
  onClose: () => void;
}

function priceLabel(p: Plan): string {
  if (p.price < 0) return '面议';
  if (p.price === 0) return `¥0/${p.period === 'year' ? '年' : '月'}`;
  return `¥${(p.price / 100).toLocaleString()}/${p.period === 'year' ? '年' : '月'}`;
}

// 方案与权益点：产出与启用专项顾问统一消耗「权益点」，以钻石标识。
export default function Plans({ open, onClose }: Props) {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const me = s.me();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [busy, setBusy] = useState('');

  // 开合时拉取方案列表；底栏协调（setOverlay）已收敛至 Sheet 基座。
  useEffect(() => {
    if (open) api.plans().then(setPlans).catch((e) => s.handleApiError(e));
  }, [open]);

  const balance = me?.creditBalance ?? 0;

  // 演示发放（免费套餐 / 演示环境回退）：不经支付直接更新方案。
  // 生产付费套餐支付未开通时后端会回 PAYMENT_COMING_SOON（不再免费发放）→ 友好提示，不报错。
  const demoGrant = async (p: Plan) => {
    try {
      const r = await api.purchasePlan(p.id);
      await store.loadMe();
      Taro.showToast({ title: r.grantedCredits > 0 ? `已到账 ${r.grantedCredits} 点` : '方案已更新', icon: 'success' });
    } catch (e: any) {
      if ((e?.code || e?.data?.code) === 'PAYMENT_COMING_SOON') {
        Taro.showToast({ title: '支付即将开通，敬请期待', icon: 'none' });
        return;
      }
      throw e;
    }
  };

  const buy = async (p: Plan) => {
    if (busy) return;
    if (p.price < 0) {
      Taro.showToast({ title: '已记录企业版意向', icon: 'none' });
      return;
    }
    setBusy(p.id);
    try {
      if (p.price === 0) { await demoGrant(p); return; } // 免费层无需支付
      if (!ensurePayableEnv()) return; // H5（server 模式）：requestPayment 不可用，下单前拦下

      // 付费套餐：先向后端下单（月→年自动折算实付）
      let order;
      try {
        order = await api.createOrder(p.id);
      } catch (e: any) {
        const code = e?.code || e?.data?.code;
        if (code === 'PAYMENT_NOT_CONFIGURED' || code === 'PLAN_FREE') { await demoGrant(p); return; } // 演示环境回退
        if (code === 'PAYMENT_COMING_SOON') { Taro.showToast({ title: '支付即将开通，敬请期待', icon: 'none' }); return; }
        throw e;
      }

      // 月→年折算：付款前明确披露实付与抵扣（此前只在支付成功后 toast，实扣 ≠ 列表价却无事前确认）。
      if (order.proration?.applies) {
        const pr = order.proration;
        const modal = await Taro.showModal({
          title: '升级折算确认',
          content: `年付原价 ¥${(pr.fullPrice / 100).toFixed(2)}，抵扣当前月付剩余价值 ¥${(pr.remainingValue / 100).toFixed(2)}（剩 ${pr.remainingDays} 天），本次实付 ¥${(order.amount / 100).toFixed(2)}。`,
          confirmText: '确认支付',
          cancelText: '再想想',
        });
        if (!modal.confirm) { Taro.showToast({ title: '已取消支付', icon: 'none' }); return; } // 未付订单由服务端对账任务自动关闭
      }

      // 调起微信支付（小程序 JSAPI）
      await requestWechatPayment(order.pay);
      // —— 到这里支付已成功（钱已扣）：后续任何查询/刷新失败都只影响提示文案，绝不能再报「支付失败」。 ——
      // 到账确认：轮询订单状态（服务端未发放时会主动查单补账），appliedAt 有值才如实报成功。
      const applied = await awaitPaymentApplied(order.outTradeNo);
      await store.loadMe().catch(() => {}); // 刷新失败不改变支付结果，下次进页自然更新
      if (order.proration?.applies && applied === 'applied') {
        Taro.showToast({ title: `方案已更新，已抵扣 ¥${Math.round(order.proration.remainingValue / 100)}`, icon: 'none' });
      } else {
        Taro.showToast(payAppliedToast(applied, '支付成功，方案已更新'));
      }
    } catch (e: any) {
      if (e?.errMsg && /cancel/i.test(e.errMsg)) Taro.showToast({ title: '已取消支付', icon: 'none' });
      else s.handleApiError(e, { fallbackTitle: '支付失败，请重试' });
    } finally {
      setBusy('');
    }
  };

  return (
    <Sheet
      visible={open}
      onClose={onClose}
      overlayKey="plans-sheet"
      align="center"
      maxHeight="92vh"
      panelClassName="plans-pad"
    >
      <View className="ps-head">
        <Text className="ps-title">方案与权益点</Text>
        <View className="ps-head-actions">
          <View className="ps-bal">
            <Icon name="diamond" size={13} color={accent} />
            <Text style={{ color: accent, fontWeight: 700 }}> {balance < 0 ? '不限量' : `${balance} 点`}</Text>
          </View>
          <View className="ps-dismiss" onClick={onClose}>
            <Text>✕</Text>
          </View>
        </View>
      </View>
      <Text className="ps-sub">权益点用于深度方案与启用专项顾问。选择方案后，本月权益点会同步更新。</Text>
      {me?.planStatus?.expired && (
        <Text className="ps-sub" style={{ color: 'var(--danger)' }}>当前套餐已到期：内容只读、AI 交互暂停，续费后立即恢复。</Text>
      )}

      <ScrollView scrollY enhanced showScrollbar={false} className="ps-list">
        {plans.map((p) => {
          const current = me?.plan?.name === p.name;
          return (
            <View key={p.id} className={`ps-plan ${p.highlighted ? 'feat' : ''}`}>
              <View className="pp-head">
                <Text className="pp-name">{p.name}</Text>
                {p.highlighted && <View className="pp-tag" style={{ background: 'var(--accent-soft)' }}><Text style={{ color: 'var(--accent-ink)' }}>常用配置</Text></View>}
                {current && <View className="pp-tag cur"><Text>当前</Text></View>}
                <Text className="pp-price serif" style={{ color: accent }}>{priceLabel(p)}</Text>
              </View>
              <Text className="pp-credit">{p.creditsPerMonth < 0 ? '不限量权益点' : `${p.creditsPerMonth} 点 / 月`} · 含 {p.agentCount} 个助手</Text>
              <View className="pp-feats">
                {p.featuresJson.map((f) => (
                  <View key={f} className="pp-feat"><Icon name="check" size={11} color={accent} /><Text> {f}</Text></View>
                ))}
              </View>
              <View
                className={`btn pp-btn ${busy === p.id ? 'disabled' : ''}`}
                style={{ background: p.price < 0 ? 'transparent' : accent, color: p.price < 0 ? accent : '#fff', borderColor: accent }}
                onClick={() => buy(p)}
              >
                <Text>{p.price < 0 ? '联系顾问' : busy === p.id ? '处理中…' : current ? '延续此方案' : '选择此方案'}</Text>
              </View>
            </View>
          );
        })}
        <View className="ps-list-end" />
      </ScrollView>
    </Sheet>
  );
}
