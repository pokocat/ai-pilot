import { useEffect, useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '../Icon';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api, type Plan } from '../../services/api';
import './index.scss';

interface Props {
  open: boolean;
  onClose: () => void;
}

function priceLabel(p: Plan): string {
  if (p.price < 0) return '面议';
  if (p.price === 0) return '免费';
  return `¥${(p.price / 100).toLocaleString()}/${p.period === 'year' ? '年' : '月'}`;
}

// 套餐与算力：购买/续费套餐即充值算力（解锁付费智能体、深度产出的通用货币）。
export default function Plans({ open, onClose }: Props) {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const me = s.me();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    store.setOverlay(open, 'plans-sheet');
    if (open) api.plans().then(setPlans).catch(() => {});
    return () => store.setOverlay(false, 'plans-sheet');
  }, [open]);

  if (!open) return null;
  const balance = me?.creditBalance ?? 0;

  const buy = async (p: Plan) => {
    if (busy) return;
    if (p.price < 0) {
      Taro.showToast({ title: '企业版请联系顾问，已记录意向', icon: 'none' });
      return;
    }
    setBusy(p.id);
    try {
      const r = await api.purchasePlan(p.id);
      await store.loadMe();
      Taro.showToast({ title: r.grantedCredits > 0 ? `已充值 ${r.grantedCredits} 算力` : '已开通', icon: 'success' });
    } catch {
      Taro.showToast({ title: '购买失败，请重试', icon: 'none' });
    } finally {
      setBusy('');
    }
  };

  return (
    <View className="plans-mask" onClick={onClose} catchMove>
      <View className="plans-sheet" onClick={(e) => e.stopPropagation()}>
        <View className="ps-grip" />
        <View className="ps-head">
          <Text className="ps-title">套餐与算力</Text>
          <Text className="ps-bal">当前算力 · <Text style={{ color: accent, fontWeight: 700 }}>{balance < 0 ? '不限量' : `${balance} 次`}</Text></Text>
        </View>
        <Text className="ps-sub">算力用于解锁付费智能体与深度产出。购买 / 续费套餐即充值算力。</Text>

        <ScrollView scrollY className="ps-list">
          {plans.map((p) => {
            const current = me?.plan?.name === p.name;
            return (
              <View key={p.id} className={`ps-plan ${p.highlighted ? 'feat' : ''}`}>
                <View className="pp-head">
                  <Text className="pp-name">{p.name}</Text>
                  {p.highlighted && <View className="pp-tag" style={{ background: 'var(--accent-soft)' }}><Text style={{ color: 'var(--accent-ink)' }}>最受欢迎</Text></View>}
                  {current && <View className="pp-tag cur"><Text>当前</Text></View>}
                  <Text className="pp-price serif" style={{ color: accent }}>{priceLabel(p)}</Text>
                </View>
                <Text className="pp-credit">{p.creditsPerMonth < 0 ? '不限量算力' : `${p.creditsPerMonth} 次算力 / 月`} · 含 {p.agentCount} 智能体</Text>
                <View className="pp-feats">
                  {p.featuresJson.map((f) => (
                    <View key={f} className="pp-feat"><Icon name="check" size={11} color={accent} /><Text> {f}</Text></View>
                  ))}
                </View>
                <View
                  className={`pp-btn ${busy === p.id ? 'busy' : ''}`}
                  style={{ background: p.price < 0 ? 'transparent' : accent, color: p.price < 0 ? accent : '#fff', borderColor: accent }}
                  onClick={() => buy(p)}
                >
                  <Text>{p.price < 0 ? '预约了解' : busy === p.id ? '处理中…' : current ? '续费充值' : '立即开通'}</Text>
                </View>
              </View>
            );
          })}
        </ScrollView>

        <View className="ps-close" onClick={onClose}><Text>关闭</Text></View>
      </View>
    </View>
  );
}
