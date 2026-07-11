// WO-12：处方条——军令页展示「军师为某问题配了工具」。点击 = clicked 埋点 + 落地：
//   toolType='external'（生态工具/EcoTool）→ navigateToMiniProgram 跳目标小程序；
//   其余（内部 agent 处方）→ market 落地页（带 from=prescription&pid）。无处方则不渲染。
import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { api, type PrescriptionView } from '../../services/api';
import './index.scss';

const IS_WEAPP = process.env.TARO_ENV === 'weapp';

export default function PrescriptionStrip() {
  const [items, setItems] = useState<PrescriptionView[]>([]);
  useEffect(() => { api.prescriptions().then((r) => setItems(r.items)).catch(() => {}); }, []);
  const active = items.filter((p) => p.status !== 'dismissed' && p.status !== 'activated');
  if (!active.length) return null;

  const open = (p: PrescriptionView) => {
    // 埋点照旧走 clicked，跳转成败不影响漏斗计数。
    api.prescriptionAction(p.id, 'clicked').catch(() => {});
    // D-3-7：生态工具处方 → 直接跳目标小程序；appId 缺失（EcoTool 已删/未关联）或非 weapp 环境 → 降级提示。
    if (p.toolType === 'external') {
      if (!IS_WEAPP || !p.appId) {
        Taro.showToast({ title: '外部工具暂未接通，容后取用', icon: 'none' });
        return;
      }
      Taro.navigateToMiniProgram({
        appId: p.appId,
        path: p.path || '',
        fail: () => Taro.showToast({ title: '外部工具未能开启，容后再试', icon: 'none' }),
      });
      return;
    }
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
