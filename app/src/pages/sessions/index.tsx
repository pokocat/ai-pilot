import { useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import { useStore } from '../../hooks/useStore';
import { api, type SessionItem } from '../../services/api';
import './index.scss';

function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  const d = Math.floor(s / 86400);
  return d === 1 ? '昨天' : `${d} 天前`;
}

// 会话列表（可回溯）。顶部顾问横滑入口 + 新对话。
export default function Sessions() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [sessions, setSessions] = useState<SessionItem[]>([]);

  useDidShow(() => {
    s.setTab(2);
    api.sessions().then(setSessions).catch((e) => { s.handleApiError(e); setSessions([]); });
  });

  const order = ['general', 'strat', 'growth', 'intel', 'fund', 'model', 'org', 'brand', 'ops'];
  const strip = order.map((k) => s.agents().find((a) => a.key === k)).filter(Boolean) as any[];

  const openSession = (id: string) => Taro.navigateTo({ url: `/pages/chat/index?sessionId=${id}` });
  const newWith = (key: string) => Taro.navigateTo({ url: `/pages/chat/index?agentKey=${key}&fresh=1` });

  return (
    <Screen topInset>
      <View className="pad">
        <View className="sess-hero">
          <View>
            <Text className="kicker">Conversations</Text>
            <Text className="h1">对话</Text>
          </View>
          <View className="sess-new" style={{ background: accent }} onClick={() => newWith('general')}>
            <Icon name="chat" size={15} color="#fff" /><Text> 新对话</Text>
          </View>
        </View>

        {/* 顾问横滑入口 */}
        <ScrollView scrollX className="agent-strip" enhanced showScrollbar={false}>
          {strip.map((a) => (
            <View key={a.key} className={`agent-chip ${a.key === 'general' ? 'general' : ''}`} onClick={() => newWith(a.key)}>
              <View className="ac-ic" style={{ background: a.key === 'general' ? accent : 'var(--accent-soft)' }}>
                <Icon name={a.icon} size={15} color={a.key === 'general' ? '#fff' : accent} />
              </View>
              <Text className="ac-n">{a.name}</Text>
            </View>
          ))}
        </ScrollView>

        <View className="sl">最近会话</View>
        {sessions.length === 0 ? (
          <View className="sess-empty">
            <View className="e-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="chat" size={22} color={accent} /></View>
            <Text className="et">还没有会话</Text>
            <Text className="es">点上方任一顾问开始——每位顾问的对话各自独立、可随时回溯。</Text>
            <Text className="es-link" style={{ color: accent }} onClick={() => newWith('general')}>＋ 发起新对话</Text>
          </View>
        ) : (
          <View className="sess-list">
            {sessions.map((it) => (
              <View key={it.id} className="sess-item card" onClick={() => openSession(it.id)}>
                <View className="si-ic" style={{ background: 'var(--accent-soft)' }}><Icon name={it.agentIcon} size={18} color={accent} /></View>
                <View className="si-b">
                  <View className="si-top">
                    <Text className="si-agent">{it.agentName}</Text>
                    <Text className="si-time">{relTime(it.updatedAt)}</Text>
                  </View>
                  <Text className="si-t">{it.title}</Text>
                  <Text className="si-snip">{it.snippet}</Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </View>
    </Screen>
  );
}
