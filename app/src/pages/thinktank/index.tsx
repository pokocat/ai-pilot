import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import { useStore } from '../../hooks/useStore';
import './index.scss';

// 智库（出谋）：入驻赠送的 8 位咨询顾问，开口即出成果。
export default function ThinkTank() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  useDidShow(() => s.setTab(1));

  const consultants = s.agents().filter((a) => a.type === 'advisory');
  const open = (key: string) => Taro.navigateTo({ url: `/pages/chat/index?agentKey=${key}&continue=1` });

  return (
    <Screen>
      <View className="statusbar"><Text>9:41</Text><Text>智库</Text></View>
      <View className="pad">
        <View className="agents-hero">
          <Text className="kicker">Think Tank · 入驻赠送</Text>
          <Text className="h1">你的 AI 智囊团</Text>
          <Text className="hero-p">入驻即赠 8 位商业顾问，开口即出成果——无需准备材料，点一下就有产出。</Text>
        </View>

        <View className="zk-team" style={{ background: '#1B1E22' }}>
          <View className="zt-h">
            <Text className="t serif">智囊团已就位</Text>
            <View className="tag" style={{ background: 'var(--accent-soft)' }}>
              <Icon name="crown" size={12} color={accent} /><Text style={{ color: 'var(--accent-ink)' }}> 入驻赠送</Text>
            </View>
          </View>
          <View className="zt-stats">
            <View className="zt-s"><Text className="v serif" style={{ color: 'var(--accent-bright)' }}>8</Text><Text className="l">在岗顾问</Text></View>
            <View className="zt-s"><Text className="v serif" style={{ color: 'var(--accent-bright)' }}>12</Text><Text className="l">本月已产出</Text></View>
            <View className="zt-s"><Text className="v serif" style={{ color: 'var(--accent-bright)' }}>3</Text><Text className="l">可编排工作流</Text></View>
          </View>
        </View>

        <View className="gh">内置顾问 · 点一下就出成果</View>
        <View className="agrid">
          {consultants.map((a) => (
            <View key={a.key} className="acard card" onClick={() => open(a.key)}>
              {a.gift && <View className="gift" style={{ background: accent }}>赠送</View>}
              <View className="ai" style={{ background: 'var(--accent-soft)' }}><Icon name={a.icon} size={18} color={accent} /></View>
              <Text className="ah">{a.name}</Text>
              <Text className="ap">{a.role}</Text>
              {a.deliverableKey && <Text className="ameta" style={{ color: accent }}>产出 · {a.deliverableKey}</Text>}
            </View>
          ))}
        </View>

        <View className="zk-opt card" onClick={() => Taro.switchTab({ url: '/pages/profile/index' })}>
          <View className="zo-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="attach" size={16} color={accent} /></View>
          <View className="zo-b">
            <Text className="zo-t">想让产出更贴合你？</Text>
            <Text className="zo-s">可选补充背景资料，顾问会更懂你的业务 · 非必填</Text>
          </View>
          <Text className="zo-go" style={{ color: accent }}>可选补充 ›</Text>
        </View>
      </View>
    </Screen>
  );
}
