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

// 智能体工坊（出活）：创作类智能体产出品牌资产 + 配置专属助手。
export default function Studio() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [buying, setBuying] = useState<Agent | null>(null);
  useDidShow(() => s.setTab(3));

  const creative = s.agents().filter((a) => a.type === 'creative');
  const open = (key: string) => Taro.navigateTo({ url: `/pages/chat/index?agentKey=${key}&continue=1` });
  const tap = (a: Agent) => {
    if (a.billing === 'unlock' && !a.owned) setBuying(a);
    else open(a.key);
  };

  return (
    <Screen topInset>
      <View className="pad">
        <View className="agents-hero">
          <Text className="kicker">Agent Studio · 出活</Text>
          <Text className="h1">智能体工坊</Text>
          <Text className="hero-p">智库帮你「出谋」，工坊帮你「出活」：把战略落成 IP、宣传片、海报、短视频与文案。需要素材时直接调用，专项能力按项目节奏启用。</Text>
        </View>

        <View className="gh">创作助手 · 生成品牌资产</View>
        <View className="agrid">
          {creative.map((a) => {
            const locked = a.billing === 'unlock' && !a.owned;
            return (
              <View key={a.key} className={`acard card ${locked ? 'locked' : ''}`} onClick={() => tap(a)}>
                <Badge agent={a} accent={accent} />
                <View className="ai" style={{ background: 'var(--accent-soft)' }}><Icon name={a.icon} size={18} color={accent} /></View>
                <Text className="ah">{a.name}</Text>
                <Text className="ap">{a.role}</Text>
                {locked
                  ? <Text className="ameta lock" style={{ color: accent }}>{diamondCost(a.price)} ›</Text>
                  : a.billing === 'metered'
                    ? <Text className="ameta" style={{ color: accent }}>{diamondCost(a.price, true)} · {a.deliverableKey}</Text>
                    : a.deliverableKey && <Text className="ameta" style={{ color: accent }}>擅长 · {a.deliverableKey}</Text>}
              </View>
            );
          })}
        </View>

        <View className="gh">专属助手 · 沉淀你的业务语气</View>
        <View className="train-soon card">
          <View className="ts-top">
            <View className="ts-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="agent" size={18} color={accent} /></View>
            <View className="ts-badge" style={{ borderColor: accent }}><Text style={{ color: accent }}>即将开放</Text></View>
          </View>
          <Text className="ts-t serif">训练只懂你的专属助手</Text>
          <Text className="ts-d">用你的历史文案、客户资料与行业动态持续训练，产出风格只属于你。我们正在打磨，敬请期待。</Text>
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
