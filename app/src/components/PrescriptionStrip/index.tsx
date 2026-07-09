// WO-12：处方条——军令页展示「军师为某问题配了工具」。点击 = clicked 埋点 + 跳 market 落地页（带 from=prescription&pid）。
// 处方是唯一销售位：只在军令/执行语境出现，不逛货架。无处方则不渲染。
import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { api, type PrescriptionView } from '../../services/api';
import './index.scss';

export default function PrescriptionStrip() {
  const [items, setItems] = useState<PrescriptionView[]>([]);
  useEffect(() => { api.prescriptions().then((r) => setItems(r.items)).catch(() => {}); }, []);
  const active = items.filter((p) => p.status !== 'dismissed' && p.status !== 'activated');
  if (!active.length) return null;

  const open = (p: PrescriptionView) => {
    api.prescriptionAction(p.id, 'clicked').catch(() => {});
    Taro.navigateTo({ url: `/packages/work/market/index?from=prescription&pid=${p.id}` });
  };

  return (
    <View className="rx-strip">
      {active.map((p) => (
        <View key={p.id} className="rx-item" onClick={() => open(p)}>
          <View className="rx-main">
            <Text className="rx-for">为「{p.problem}」</Text>
            <Text className="rx-play">{p.playbook}</Text>
          </View>
          <Text className="rx-cta">⚡ 军师配了工具 →</Text>
        </View>
      ))}
    </View>
  );
}
