import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import AgentUnlock from '../../components/AgentUnlock';
import { useStore } from '../../hooks/useStore';
import { diamondCost } from '../../services/format';
import type { Agent } from '../../services/api';
import './index.scss';

// 智库（出谋）：可用顾问 + 可按需启用的专项顾问，避免首屏售卖感。
export default function ThinkTank() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [buying, setBuying] = useState<Agent | null>(null);
  useDidShow(() => s.setTab(1));

  const consultants = s.agents().filter((a) => a.type === 'advisory');
  const giftCount = consultants.filter((a) => a.billing === 'free').length;
  const lockedCount = consultants.filter((a) => a.billing === 'unlock' && !a.owned).length;
  const open = (key: string) => Taro.navigateTo({ url: `/pages/chat/index?agentKey=${key}&continue=1` });

  // 卡片点击：未启用的专项顾问 → 启用弹层；其余 → 进入对话
  const tap = (a: Agent) => {
    if (a.billing === 'unlock' && !a.owned) setBuying(a);
    else open(a.key);
  };

  return (
    <Screen topInset>
      <View className="pad">
        <View className="agents-hero">
          <Text className="kicker">Think Tank · 你的智囊团</Text>
          <Text className="h1">你的 AI 智囊团</Text>
          <Text className="hero-p">这些顾问已在你的工作台中，可直接用于诊断、增长、融资和组织问题；专项能力按项目节奏启用。</Text>
        </View>

        <View className="zk-team">
          <View className="zt-h">
            <Text className="t serif">智囊团已就位</Text>
            <View className="tag" style={{ background: 'var(--accent-soft)' }}>
              <Icon name="crown" size={12} color={accent} /><Text style={{ color: 'var(--accent-ink)' }}> {giftCount} 位可直接用</Text>
            </View>
          </View>
          <View className="zt-stats">
            <View className="zt-s"><Text className="v serif" style={{ color: 'var(--accent-bright)' }}>{consultants.length}</Text><Text className="l">在岗顾问</Text></View>
            <View className="zt-s"><Text className="v serif" style={{ color: 'var(--accent-bright)' }}>{giftCount}</Text><Text className="l">可直接用</Text></View>
            <View className="zt-s"><Text className="v serif" style={{ color: 'var(--accent-bright)' }}>{lockedCount}</Text><Text className="l">专项能力</Text></View>
          </View>
        </View>

        <View className="gh">顾问目录 · 选择问题入口</View>
        <View className="agrid">
          {consultants.map((a) => {
            const locked = a.billing === 'unlock' && !a.owned;
            return (
              <View key={a.key} className={`acard card ${locked ? 'locked' : ''}`} onClick={() => tap(a)}>
                <Badge agent={a} accent={accent} />
                <View className="ai" style={{ background: 'var(--accent-soft)' }}><Icon name={a.icon} size={18} color={accent} /></View>
                <Text className="ah">{a.name}</Text>
                <Text className="ap">{a.role}</Text>
                {locked
                  ? <Text className="ameta lock" style={{ color: accent }}>{diamondCost(a.price)} ›</Text>
                  : a.deliverableKey && <Text className="ameta" style={{ color: accent }}>擅长 · {a.deliverableKey}</Text>}
              </View>
            );
          })}
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

      <AgentUnlock agent={buying} onClose={() => setBuying(null)} onUnlocked={(a) => { setBuying(null); open(a.key); }} />
    </Screen>
  );
}

// 智能体角标：可用 / 已启用 / 按需 / 锁
function Badge({ agent, accent }: { agent: Agent; accent: string }) {
  if (agent.billing === 'free') return <View className="gift" style={{ background: accent }}>可用</View>;
  if (agent.billing === 'metered') return <View className="gift metered" style={{ background: accent }}>按需</View>;
  if (agent.owned) return <View className="gift owned"><Icon name="check" size={9} color="#fff" /><Text> 已启用</Text></View>;
  return <View className="gift locked-badge"><Icon name="lock" size={9} color="#fff" /></View>;
}
