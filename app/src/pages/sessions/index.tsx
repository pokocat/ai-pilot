import { useState } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import AdvisorAvatar from '../../components/AdvisorAvatar';
import AgentUnlock from '../../components/AgentUnlock';
import { useStore } from '../../hooks/useStore';
import { diamondCost } from '../../services/format';
import { api, type Agent, type SessionItem } from '../../services/api';
import { ADVISOR_ALIAS, CORE_SPECIALISTS, MORE_SPECIALIST_KEYS } from '../../data/council';
import './index.scss';

function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  const d = Math.floor(s / 86400);
  return d === 1 ? '昨天' : `${d} 天前`;
}

// 快捷补给：把军师判断所需的资料、数据、模块、报告带进对话动线。
const QUICK_CARDS = [
  { t: '上传知识库', d: '企业、老板、产品、财务资料', url: '/packages/work/knowledge/index' },
  { t: '绑定数据源', d: '店铺、账号、企微、财务表', url: '/packages/work/bindings/index' },
  { t: '模块市场', d: '目标、任务、IP、增长模块', url: '/packages/work/market/index' },
  { t: '报告库', d: '诊断、复盘、方案沉淀', url: '/packages/work/library/index' },
];

// 军师消息（对话页，第一入口）：微信式列表——总军师置顶 + 专业军师线程，
// 每位军师有拟人立绘与花名；最近消息一律取真实会话，无会话则显示职责。
export default function Sessions() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [buying, setBuying] = useState<Agent | null>(null);
  const [query, setQuery] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  useDidShow(() => {
    s.setTab(0);
    Taro.getCurrentInstance().page?.getTabBar?.();
    api.sessions().then(setSessions).catch((e) => { s.handleApiError(e); setSessions([]); });
  });

  const findAgent = (key: string) => s.agents().find((a) => a.key === key);
  const latestOf = (agentKey: string) => sessions.find((x) => x.agentKey === agentKey);
  const aliasOf = (key: string) => ADVISOR_ALIAS[key] || '';

  const continueWith = (key: string) => Taro.navigateTo({ url: `/pages/chat/index?agentKey=${key}&continue=1` });
  const newWith = (key: string) => Taro.navigateTo({ url: `/pages/chat/index?agentKey=${key}&fresh=1` });
  const openSession = (id: string) => Taro.navigateTo({ url: `/pages/chat/index?sessionId=${id}` });

  // 线程入口：未启用的专项军师先走启用弹层，其余续接最近线程
  const tapAdvisor = (a: Agent) => {
    if (a.billing === 'unlock' && !a.owned) setBuying(a);
    else continueWith(a.key);
  };

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
  const matchAgent = (a: Agent, duty?: string) =>
    !q || `${a.name}${aliasOf(a.key)}${a.role}${duty || ''}`.toLowerCase().includes(q);
  const matchSession = (it: SessionItem) =>
    !q || `${it.agentName}${it.title}${it.snippet}`.toLowerCase().includes(q);

  const master = findAgent('general');
  const masterLast = latestOf('general');
  const moreAgents = MORE_SPECIALIST_KEYS.map(findAgent).filter(Boolean) as Agent[];
  const filteredSessions = sessions.filter(matchSession);

  // 微信式军师线程行
  const advisorRow = (a: Agent, duty: string, syncDesc: string, online = false) => {
    const last = latestOf(a.key);
    const locked = a.billing === 'unlock' && !a.owned;
    return (
      <View key={a.key} className="wx-item" onClick={() => tapAdvisor(a)}>
        <AdvisorAvatar agentKey={a.key} size={50} online={online} />
        <View className="wx-main">
          <View className="wx-top">
            <View className="wx-id">
              <Text className="wx-name">{a.name}</Text>
              {aliasOf(a.key) ? <Text className="wx-alias">{aliasOf(a.key)}</Text> : null}
            </View>
            <Text className="wx-time" style={locked ? { color: accent } : {}}>
              {locked ? diamondCost(a.price) : last ? relTime(last.updatedAt) : ''}
            </Text>
          </View>
          <Text className="wx-preview">{last?.snippet || `${duty} · ${syncDesc}`}</Text>
        </View>
        {locked ? <Icon name="lock" size={13} color="#969BA1" /> : null}
      </View>
    );
  };

  return (
    <Screen topInset>
      <View className="pad council">
        {/* 顶栏：历史 · 军师消息 · 新对话 */}
        <View className="council-nav">
          <Text className={`cn-side ${showHistory ? 'on' : ''}`} style={showHistory ? { color: accent } : {}} onClick={() => setShowHistory((v) => !v)}>历史</Text>
          <Text className="cn-title serif">军师消息</Text>
          <View className="cn-new" style={{ background: accent }} onClick={() => newWith('general')}>
            <Icon name="chat" size={14} color="#FBFAF6" />
          </View>
        </View>

        {/* 搜索 */}
        <View className="council-search">
          <Icon name="target" size={14} color="#969BA1" />
          <Input
            className="cs-input"
            value={query}
            placeholder="搜索军师、会话、报告或资料"
            onInput={(e) => setQuery(e.detail.value)}
          />
          {query ? <Text className="cs-clear" onClick={() => setQuery('')}>✕</Text> : null}
        </View>

        {!showHistory ? (
          <>
            {/* 快捷补给 */}
            <ScrollView scrollX className="quick-row" enhanced showScrollbar={false}>
              {QUICK_CARDS.map((c) => (
                <View key={c.t} className="quick-card card" onClick={() => Taro.navigateTo({ url: c.url })}>
                  <Text className="qt">{c.t}</Text>
                  <Text className="qd">{c.d}</Text>
                </View>
              ))}
            </ScrollView>

            {/* 总军师 + 常驻军师线程 */}
            <View className="wx-list card">
              {master && matchAgent(master, '统筹判断') ? (
                <View className="wx-item" onClick={() => continueWith('general')}>
                  <AdvisorAvatar agentKey="general" size={50} online />
                  <View className="wx-main">
                    <View className="wx-top">
                      <View className="wx-id">
                        <Text className="wx-name">总军师</Text>
                        <Text className="wx-alias">{aliasOf('general')}</Text>
                      </View>
                      <Text className="wx-time">{masterLast ? relTime(masterLast.updatedAt) : '在线'}</Text>
                    </View>
                    <Text className="wx-preview">
                      {masterLast?.snippet || master.greet || '说说你的处境，我先判断主要矛盾，再调度专业军师。'}
                    </Text>
                  </View>
                </View>
              ) : null}
              {CORE_SPECIALISTS.map((sp) => {
                const a = findAgent(sp.agentKey);
                if (!a || !matchAgent(a, sp.duty)) return null;
                return advisorRow(a, sp.duty, sp.syncDesc);
              })}
            </View>

            {/* 专业参谋 */}
            {moreAgents.some((a) => matchAgent(a)) ? (
              <>
                <View className="wx-section"><Text>专业参谋</Text></View>
                <View className="wx-list card">
                  {moreAgents.filter((a) => matchAgent(a)).map((a) => advisorRow(a, a.role, '结论回流总军师主线'))}
                </View>
              </>
            ) : null}
          </>
        ) : (
          <>
            {/* 历史会话 */}
            <View className="wx-section"><Text>最近会话{filteredSessions.length ? ' · 长按可删除' : ''}</Text></View>
            {filteredSessions.length === 0 ? (
              <View className="sess-empty">
                <View className="e-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="chat" size={22} color={accent} /></View>
                <Text className="et">{q ? '没有匹配的会话' : '还没有会话'}</Text>
                <Text className="es">从总军师或任一专业军师开始——每条线程独立、可随时回溯，关键结论回流主线。</Text>
                <Text className="es-link" style={{ color: accent }} onClick={() => newWith('general')}>＋ 发起新对话</Text>
              </View>
            ) : (
              <View className="wx-list card">
                {filteredSessions.map((it) => (
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
          </>
        )}
      </View>

      <AgentUnlock agent={buying} onClose={() => setBuying(null)} onUnlocked={(a) => { setBuying(null); continueWith(a.key); }} />
    </Screen>
  );
}
