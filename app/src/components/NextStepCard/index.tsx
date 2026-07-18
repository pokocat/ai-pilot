// WO-07：全 tab「下一步」卡。自取 api.journey()，只渲染服务端派生的 nextStep（前端不判断 stage）。
// route 约定：'chat'→对话页、'studio'→执行 tab、以 '/' 开头→分包页 navigateTo。无 nextStep 则不渲染。
import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import { api, type JourneyView } from '../../services/api';
import { navTo } from '../../services/nav';
import './index.scss';

export default function NextStepCard() {
  const [j, setJ] = useState<JourneyView | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { api.journey().then(setJ).catch(() => {}).finally(() => setLoaded(true)); }, []);
  const ns = j?.nextStep;

  // 首帧未加载完成：渲染等高骨架占位，避免数据回来后卡片「后弹入」挤动下方布局。
  if (!loaded) {
    return (
      <View className="nsc nsc-skeleton">
        <View className="nsc-main">
          <View className="nsc-sk nsc-sk-k" />
          <View className="nsc-sk nsc-sk-t" />
          <View className="nsc-sk nsc-sk-d" />
        </View>
      </View>
    );
  }
  if (!ns) return null;

  const go = () => {
    if (ns.route === 'chat') navTo('/packages/main/chat/index?agentKey=general&continue=1');
    else if (ns.route === 'studio') navTo('/pages/studio/index');
    else if (ns.route.startsWith('/')) navTo(ns.route);
  };

  return (
    <View className="nsc" onClick={go}>
      <View className="nsc-main">
        <Text className="nsc-kicker">下一步</Text>
        <Text className="nsc-title">{ns.title}</Text>
        <Text className="nsc-desc">{ns.desc}</Text>
      </View>
      <Text className="nsc-arrow">→</Text>
    </View>
  );
}
