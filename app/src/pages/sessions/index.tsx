import { useState } from 'react';
import { View, Text, Input } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import Login from '../../components/Login';
import SafeHeader from '../../components/SafeHeader';
import AdvisorAvatar from '../../components/AdvisorAvatar';
import { useStore } from '../../hooks/useStore';
import { api, type SessionItem } from '../../services/api';
import { ADVISOR_ALIAS } from '../../data/council';
import './index.scss';

function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  const d = Math.floor(s / 86400);
  return d === 1 ? '昨天' : `${d} 天前`;
}

// 往来（navigateTo 次级页）—— 历史会话陈列：搜索 + 线程列表（长按删）。
// 军师名录职能已移交军情·麾下与点将堂；本页只管「聊过什么」。
export default function Sessions() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [query, setQuery] = useState('');
  const [showLogin, setShowLogin] = useState(() => !s.isAuthed());

  useDidShow(() => {
    if (!s.isAuthed()) {
      setShowLogin(true);
      setSessions([]);
      return;
    }
    api.sessions().then(setSessions).catch((e) => {
      const kind = s.handleApiError(e, { silent: true });
      if (kind === 'unauthorized') setShowLogin(true);
      setSessions([]);
    });
  });

  const aliasOf = (key: string) => ADVISOR_ALIAS[key] || '';
  const openSession = (id: string) => Taro.navigateTo({ url: `/pages/chat/index?sessionId=${id}` });
  const newWithGeneral = () => Taro.navigateTo({ url: '/pages/chat/index?agentKey=general&fresh=1' });

  // 长按会话 → 删除（接口已支持，乐观更新）
  const confirmDelete = (it: SessionItem) =>
    Taro.showModal({ title: '删除会话', content: `删除「${it.title}」后不可恢复，确定删除？`, confirmText: '删除', confirmColor: '#c0392b' })
      .then(async (r) => {
        if (!r.confirm) return;
        setSessions((list) => list.filter((x) => x.id !== it.id));
        await api.deleteSession(it.id).catch((e) => { s.handleApiError(e, { fallbackTitle: '删除失败' }); });
      })
      .catch(() => {});

  const q = query.trim().toLowerCase();
  const filtered = sessions.filter((it) => !q || `${it.agentName}${it.title}${it.snippet}`.toLowerCase().includes(q));

  return (
    <Screen tab={false} topInset={false} className="council">
      <SafeHeader title="往来" subtitle="各线独立留档，脉络可溯" />
      <View className="pad">
        {/* 搜索 */}
        <View className="council-search">
          <Icon name="target" size={14} color="#969BA1" />
          <Input
            className="cs-input"
            value={query}
            placeholder="搜索军师或会话"
            onInput={(e) => setQuery(e.detail.value)}
          />
          {query ? <Text className="cs-clear" onClick={() => setQuery('')}>✕</Text> : null}
        </View>

        {/* 历史会话 */}
        <View className="wx-section"><Text>最近会话{filtered.length ? ' · 长按可删除' : ''}</Text></View>
        {filtered.length === 0 ? (
          <View className="sess-empty">
            <View className="e-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="chat" size={22} color={accent} /></View>
            <Text className="et">{q ? '没有匹配的会话' : '还没有会话'}</Text>
            <Text className="es">不拘总军师还是专业军师——各线独立留档，要害汇入主线判断。</Text>
            <Text className="es-link" style={{ color: accent }} onClick={newWithGeneral}>＋ 发起新对话</Text>
          </View>
        ) : (
          <View className="wx-list">
            {filtered.map((it) => (
              <View key={it.id} className="wx-item" onClick={() => openSession(it.id)} onLongPress={() => confirmDelete(it)}>
                <AdvisorAvatar agentKey={it.agentKey} size={50} />
                <View className="wx-main">
                  <View className="wx-top">
                    <View className="wx-id">
                      <Text className="wx-name">{it.agentName}</Text>
                      {aliasOf(it.agentKey) ? <Text className="wx-alias">{aliasOf(it.agentKey)}</Text> : null}
                    </View>
                    <Text className="wx-time">{relTime(it.updatedAt)}</Text>
                  </View>
                  <Text className="wx-preview">{it.title} · {it.snippet}</Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </View>

      <Login open={showLogin} onLoggedIn={() => { setShowLogin(false); api.sessions().then(setSessions).catch(() => setSessions([])); }} />
    </Screen>
  );
}
