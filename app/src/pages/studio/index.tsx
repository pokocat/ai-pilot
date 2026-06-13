import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import AgentUnlock from '../../components/AgentUnlock';
import { useStore } from '../../hooks/useStore';
import type { Agent } from '../../services/api';
import './index.scss';

const TRAIN = [
  { ic: 'pen', n: '品牌文案官', d: '学习你的语气与调性，产出风格统一的对外文案。', tag: '约 3 分钟 · 从历史文案学习' },
  { ic: 'chart', n: '赛道研究员', d: '持续追踪你所在行业的动态、政策与对手变化。', tag: '设定赛道关键词即可' },
  { ic: 'user', n: '客户洞察官', d: '沉淀你的客户画像与高频问题，越用越懂客户。', tag: '从对话与资料学习' },
];

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
  const train = (name: string) => Taro.showToast({ title: `开始配置「${name}」`, icon: 'none' });

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
                  ? <Text className="ameta lock" style={{ color: accent }}>需 {a.price} 次额度启用 ›</Text>
                  : a.billing === 'metered'
                    ? <Text className="ameta" style={{ color: accent }}>每次 {a.price} 次额度 · {a.deliverableKey}</Text>
                    : a.deliverableKey && <Text className="ameta" style={{ color: accent }}>擅长 · {a.deliverableKey}</Text>}
              </View>
            );
          })}
        </View>

        <View className="gh">专属助手 · 沉淀你的业务语气</View>
        {TRAIN.map((t) => (
          <View key={t.n} className="train-card card">
            <View className="tc-top">
              <View className="tc-ic" style={{ background: 'var(--accent-soft)' }}><Icon name={t.ic} size={17} color={accent} /></View>
              <View className="tc-b"><Text className="tc-n">{t.n}</Text><Text className="tc-d">{t.d}</Text></View>
            </View>
            <View className="tc-foot">
              <View className="tc-btn" style={{ background: accent }} onClick={() => train(t.n)}>
                <Icon name="spark" size={13} color="#fff" /><Text> 开始配置</Text>
              </View>
              <Text className="tc-tag">{t.tag}</Text>
            </View>
          </View>
        ))}

        <View className="train-card card mine">
          <View className="tc-top">
            <View className="tc-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="agent" size={17} color={accent} /></View>
            <View className="tc-b"><Text className="tc-n">招商话术官 · 配置中</Text><Text className="tc-d">已学习你的招商资料，正在打磨话术风格。</Text></View>
          </View>
          <View className="progress"><View className="bar" style={{ width: '72%', background: accent }} /></View>
          <Text className="tc-tag" style={{ marginTop: '8px' }}>配置进度 72%</Text>
        </View>

        <View className="from-zero card" onClick={() => Taro.showToast({ title: '新建专属助手', icon: 'none' })}>
          <Icon name="spark" size={16} color={accent} /><Text style={{ color: accent }}> 新建专属助手</Text>
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
