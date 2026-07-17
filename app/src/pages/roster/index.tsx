import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import SafeHeader from '../../components/SafeHeader';
import AdvisorAvatar from '../../components/AdvisorAvatar';
import AgentUnlock from '../../components/AgentUnlock';
import { useStore } from '../../hooks/useStore';
import { diamondCost } from '../../services/format';
import { api, type Agent, type SessionItem } from '../../services/api';
import { ADVISOR_ALIAS, CORE_SPECIALISTS, MORE_SPECIALIST_KEYS } from '../../data/council';
import { CAPABILITIES } from '../../data/capabilities';
import './index.scss';

function relTime(iso: string): string {
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec < 3600) return '刚刚';
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  const d = Math.floor(sec / 86400);
  return d === 1 ? '昨天' : `${d} 天前`;
}

// 点将堂（navigateTo 次级页，非 tab）—— 十三将一览与生态位。
// 统帅卡 + 出谋八将 + 出活五将（生态印），一种行样式；数据沿用 council.ts + agents，不新造。
export default function Roster() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [buying, setBuying] = useState<Agent | null>(null);

  useDidShow(() => {
    s.loadAgents();
    if (s.isAuthed()) api.sessions().then(setSessions).catch(() => setSessions([]));
  });

  const findAgent = (key: string) => s.agents().find((a) => a.key === key);
  const latestOf = (agentKey: string) => sessions.find((x) => x.agentKey === agentKey);

  const openThread = (key: string) => Taro.navigateTo({ url: `/pages/chat/index?agentKey=${key}&continue=1` });
  const tapAdvisor = (a: Agent) => {
    if (a.billing === 'unlock' && !a.owned) setBuying(a);
    else openThread(a.key);
  };

  // 出谋八将：常驻四将 + 其余顾问型
  const advisoryKeys = [...CORE_SPECIALISTS.map((x) => x.agentKey), ...MORE_SPECIALIST_KEYS].filter((k, i, arr) => arr.indexOf(k) === i);
  const advisors = advisoryKeys.map(findAgent).filter((a): a is Agent => !!a && a.type !== 'creative');
  // 出活五将：创作型（生态位），按能力映射排序
  const creatives = CAPABILITIES.map((c) => ({ cap: c, agent: findAgent(c.agentKey) })).filter((x): x is { cap: typeof CAPABILITIES[number]; agent: Agent } => !!x.agent);

  const advisorRow = (a: Agent, sub: string, eco?: string, delay = 0) => {
    const last = latestOf(a.key);
    const locked = a.billing === 'unlock' && !a.owned;
    return (
      <View key={a.key} className={`roster-row ink-in ink-in-${Math.min(delay, 5)}`} onClick={() => tapAdvisor(a)}>
        <AdvisorAvatar agentKey={a.key} size={40} />
        <View className="rr-b">
          <View className="rr-top">
            <Text className="rr-name serif">{ADVISOR_ALIAS[a.key] || a.name}</Text>
            <Text className="rr-role">{a.name}</Text>
            {eco ? <Text className="pill em" style={{ background: accent, borderColor: accent }}>生态</Text> : null}
          </View>
          <Text className="rr-sub">{eco || sub}</Text>
        </View>
        <Text className="rr-state t-mark">{locked ? diamondCost(a.price) : last ? relTime(last.updatedAt) : ''}</Text>
      </View>
    );
  };

  return (
    <Screen tab={false} topInset={false} className="roster">
      <SafeHeader title="点将堂" subtitle="十三将，各领一线" />
      <View className="pad">
        {/* 统帅卡 */}
        <View className="marshal-card card ink-in" onClick={() => Taro.switchTab({ url: '/pages/counsel/index' })}>
          <AdvisorAvatar agentKey="general" size={46} online />
          <View className="mc-b">
            <Text className="mc-name serif">总军师 · {ADVISOR_ALIAS.general}</Text>
            <Text className="mc-say t-body">你只管提出问题，我决定叫谁上阵。</Text>
          </View>
          <Text className="mc-go">问策 ›</Text>
        </View>

        {/* 出谋 · 顾问型 */}
        <View className="chapter">
          <View className="chapter-head">
            <Text className="t-kicker">出 谋 · 顾 问</Text>
            <View className="rule" />
          </View>
          {advisors.map((a, i) => advisorRow(a, a.role, undefined, i + 1))}
        </View>

        {/* 出活 · 创作型（生态位） */}
        <View className="chapter">
          <View className="chapter-head">
            <Text className="t-kicker">出 活 · 创 作</Text>
            <View className="rule" />
          </View>
          {creatives.map(({ cap, agent }, i) => advisorRow(agent, agent.role, cap.label, i + 1))}
        </View>

        {/* 页脚：添置锦囊模块（market 正典入口） */}
        <View className="roster-foot" onClick={() => Taro.navigateTo({ url: '/packages/work/market/index' })}>
          <Icon name="grid" size={13} color="#969BA1" />
          <Text className="rf-t">添置锦囊模块 ›</Text>
        </View>
      </View>

      <AgentUnlock agent={buying} onClose={() => setBuying(null)} onUnlocked={(a) => { setBuying(null); openThread(a.key); }} />
    </Screen>
  );
}
