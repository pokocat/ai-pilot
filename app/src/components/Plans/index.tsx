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
  if (p.price === 0) return `¥0/${p.period === 'year' ? '年' : '月'}`;
  return `¥${(p.price / 100).toLocaleString()}/${p.period === 'year' ? '年' : '月'}`;
}

// 方案与产出额度：前台用“额度/方案”表达，避免把工作台写成促销货架。
export default function Plans({ open, onClose }: Props) {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const me = s.me();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    store.setOverlay(open, 'plans-sheet');
    if (open) api.plans().then(setPlans).catch((e) => s.handleApiError(e));
    return () => store.setOverlay(false, 'plans-sheet');
  }, [open]);

  if (!open) return null;
  const balance = me?.creditBalance ?? 0;

  const buy = async (p: Plan) => {
    if (busy) return;
    if (p.price < 0) {
      Taro.showToast({ title: '已记录企业版意向', icon: 'none' });
      return;
    }
    setBusy(p.id);
    try {
      const r = await api.purchasePlan(p.id);
      await store.loadMe();
      Taro.showToast({ title: r.grantedCredits > 0 ? `本月额度已更新：${r.grantedCredits} 次` : '方案已更新', icon: 'success' });
    } catch (e) {
      s.handleApiError(e, { fallbackTitle: '方案更新失败，请重试' });
    } finally {
      setBusy('');
    }
  };

  return (
    <View className="plans-mask" onClick={onClose} catchMove>
      <View className="plans-sheet" onClick={(e) => e.stopPropagation()}>
        <View className="ps-grip" />
        <View className="ps-head">
          <Text className="ps-title">方案与产出额度</Text>
          <Text className="ps-bal">当前额度 · <Text style={{ color: accent, fontWeight: 700 }}>{balance < 0 ? '不限量' : `${balance} 次`}</Text></Text>
        </View>
        <Text className="ps-sub">产出额度用于深度报告和专项顾问。选择方案后，本月额度会同步更新。</Text>

        <ScrollView scrollY className="ps-list">
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
                <Text className="pp-credit">{p.creditsPerMonth < 0 ? '不限量产出额度' : `${p.creditsPerMonth} 次产出额度 / 月`} · 含 {p.agentCount} 个助手</Text>
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
                  <Text>{p.price < 0 ? '联系顾问' : busy === p.id ? '处理中…' : current ? '延续此方案' : '选择此方案'}</Text>
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
