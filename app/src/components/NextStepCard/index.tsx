// WO-07：全 tab「下一步」卡。自取 api.journey()，只渲染服务端派生的 nextStep（前端不判断 stage）。
// route 约定：'chat'→对话页、'studio'→执行 tab、以 '/' 开头→分包页 navigateTo。无 nextStep 则不渲染。
import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { api, type JourneyView } from '../../services/api';
import './index.scss';

export default function NextStepCard() {
  const [j, setJ] = useState<JourneyView | null>(null);
  useEffect(() => { api.journey().then(setJ).catch(() => {}); }, []);
  const ns = j?.nextStep;
  if (!ns) return null;

  const go = () => {
    if (ns.route === 'chat') Taro.navigateTo({ url: '/packages/main/chat/index?agentKey=general&continue=1' });
    else if (ns.route === 'studio') Taro.switchTab({ url: '/pages/studio/index' });
    else if (ns.route.startsWith('/')) Taro.navigateTo({ url: ns.route });
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
