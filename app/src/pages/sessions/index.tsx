import { useEffect, useState } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import Login from '../../components/Login';
import AsyncState from '../../components/AsyncState';
import { navTo, switchTo } from '../../services/nav';
import AdvisorAvatar from '../../components/AdvisorAvatar';
import AgentUnlock from '../../components/AgentUnlock';
import OnboardSheet from '../../components/OnboardSheet';
import { useStore } from '../../hooks/useStore';
import { diamondCost } from '../../services/format';
import { api, type Agent, type SessionItem, type SearchHit } from '../../services/api';
import { getToken } from '../../services/token';
import { ADVISOR_ALIAS, CORE_SPECIALISTS, MORE_SPECIALIST_KEYS } from '../../data/council';
import NextStepCard from '../../components/NextStepCard';
import './index.scss';

function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  const d = Math.floor(s / 86400);
  return d === 1 ? '昨天' : `${d} 天前`;
}

// 快捷补给（对齐设计稿 6 卡）：资料、数据、模块、报告 + 军令 / 执行动线。
const QUICK_CARDS = [
  { t: '上传经营资料', d: '企业、老板、产品、财务资料', url: '/packages/work/knowledge/index' },
  { t: '绑定数据源', d: '店铺、账号、企微、财务表', url: '/packages/work/bindings/index' },
  { t: '军师锦囊 / 模块', d: '免费初判、深度推演、高级模块', url: '/packages/work/market/index' },
  { t: '生成方案', d: '把这次对话炼成一份方案', url: '/packages/work/library/index' },
  { t: '转成军令', d: '认可即拆解为今日军令', tab: '/pages/studio/index' },
  { t: '今日执行', d: '军令、任务、打卡、复盘', tab: '/pages/studio/index' },
] as { t: string; d: string; url?: string; tab?: string }[];

// 跨域搜索结果分组（design §11：军师 / 会话 / 方案(report) / 资料(knowledge)）。
const SEARCH_GROUPS: { kind: SearchHit['kind']; label: string }[] = [
  { kind: 'agent', label: '军师' },
  { kind: 'session', label: '会话' },
  { kind: 'report', label: '方案' },
  { kind: 'knowledge', label: '资料' },
];

// 军师消息（对话页，第一入口）：微信式列表——总军师置顶 + 专业军师线程，
// 每位军师有拟人立绘与花名；最近消息一律取真实会话，无会话则显示职责。
export default function Sessions() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sessErr, setSessErr] = useState(false); // 会话列表加载失败（区分「出错可重试」与「真空态」，不再伪装成空）
  const [buying, setBuying] = useState<Agent | null>(null);
  const [query, setQuery] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [showLogin, setShowLogin] = useState(() => !s.isAuthed());
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false); // 检索进行中（防抖 + 请求期间给「检索中」占位，避免空态误判）
  const [showOnboard, setShowOnboard] = useState(false);

  // 会话列表加载（C2）：失败区分未授权（弹登录）与网络错误（错误态可重试），不再一律伪装成空态。
  const loadSessions = () => {
    api.sessions()
      .then((list) => { setSessions(list); setSessErr(false); })
      .catch((e) => {
        const kind = s.handleApiError(e, { silent: true });
        setSessions([]);
        if (kind === 'unauthorized') { setShowLogin(true); setSessErr(false); }
        else setSessErr(true);
      });
  };

  useDidShow(() => {
    s.setTab(0);
    Taro.getCurrentInstance().page?.getTabBar?.();
    s.loadAgents();
    if (!s.isAuthed()) {
      setShowLogin(true);
      setSessions([]);
      setSessErr(false);
      return;
    }
    loadSessions();
  });

  // V7-03 首登引导：已登录 + 已建档 + 本账号未看过 → 只展示一次 4 步引导（storage 落 junshi.onboard.v7.<token>）。
  const onboardKey = () => `junshi.onboard.v7.${getToken()}`;
  const dismissOnboard = () => {
    try { Taro.setStorageSync(onboardKey(), '1'); } catch { /* noop */ }
    setShowOnboard(false);
  };
  const maybeShowOnboard = () => {
    if (!s.isAuthed() || !s.isOnboarded()) return;
    let seen = true;
    try { seen = !!Taro.getStorageSync(onboardKey()); } catch { seen = true; }
    if (!seen) setShowOnboard(true);
  };
  // 首登入局仪式（择色 → 立案卷 → 首判）。防重复：页栈已有 onboarding 就不再跳（navTo 另有 800ms 防连点锁）。
  const goOnboarding = () => {
    const pages = (Taro.getCurrentPages?.() || []) as { route?: string }[];
    if (pages.some((p) => (p.route || '').includes('packages/main/onboarding'))) return;
    navTo('/packages/main/onboarding/index');
  };
  // 已登录但未建档 → 进入全屏入局仪式；已建档 → 视情况弹一次 4 步引导。
  const gateOnboarding = () => {
    if (s.isAuthed() && !s.isOnboarded()) { goOnboarding(); return; }
    maybeShowOnboard();
  };
  useEffect(() => { gateOnboarding(); }, []);

  // V7-14 跨域搜索：输入 300ms 防抖 → api.search（mock 亦返回本地匹配，同一路径）；空 q 隐藏结果。
  useEffect(() => {
    const term = query.trim();
    if (!term || !s.isAuthed()) { setSearchHits([]); setSearching(false); return; }
    // 防抖期间即置「检索中」，结果回来（成功/失败）再落定；保留上次结果做 stale-while-revalidate，避免闪空。
    setSearching(true);
    const timer = setTimeout(() => {
      api.search(term)
        .then((r) => { setSearchHits(r.hits); setSearching(false); })
        .catch((e) => { s.handleApiError(e, { silent: true }); setSearchHits([]); setSearching(false); });
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const findAgent = (key: string) => s.agents().find((a) => a.key === key);
  const latestOf = (agentKey: string) => sessions.find((x) => x.agentKey === agentKey);
  const aliasOf = (key: string) => ADVISOR_ALIAS[key] || '';

  const requireLogin = () => {
    if (s.isAuthed()) return true;
    setShowLogin(true);
    return false;
  };
  const continueWith = (key: string) => { if (requireLogin()) navTo(`/packages/main/chat/index?agentKey=${key}&continue=1`); };
  const newWith = (key: string) => { if (requireLogin()) navTo(`/packages/main/chat/index?agentKey=${key}&fresh=1`); };
  const openSession = (id: string) => { if (requireLogin()) navTo(`/packages/main/chat/index?sessionId=${id}`); };
  // 搜索结果跳转：智库为 tab 页用 switchTo，其余（/packages/... 含 chat 分包页）用 navTo。
  const openHit = (h: SearchHit) => {
    if (!requireLogin()) return;
    if (h.route.startsWith('/pages/thinktank')) switchTo(h.route.split('?')[0]);
    else navTo(h.route);
  };

  // 线程入口：未启用的专项军师先走启用弹层，其余续接最近线程
  const tapAdvisor = (a: Agent) => {
    if (a.billing === 'unlock' && !a.owned) setBuying(a);
    else continueWith(a.key);
  };

  // 长按会话 → 删除（接口已支持，乐观更新）
  const confirmDelete = (it: SessionItem) =>
    Taro.showModal({ title: '删除会话', content: `删除「${it.title}」后不可恢复，确定删除？`, confirmText: '删除', confirmColor: '#9C4A38' /* = var(--danger)，showModal 仅接受 hex */ })
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

  // V7-15 未读徽章：unreadCount>0 → 数字徽章（>99 记 99+）；缺省则回退旧版 hasUnread 红点。
  const unreadBadge = (it?: SessionItem) => {
    const n = it?.unreadCount ?? 0;
    if (n > 0) return <View className="unread"><Text>{n > 99 ? '99+' : n}</Text></View>;
    if (it?.hasUnread) return <View className="unread-dot" />;
    return null;
  };

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
              {unreadBadge(last)}
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
        {/* 顶栏（对齐设计稿 messages-head）：大标题「问策」+ 副题，右侧 历史 */}
        <View className="messages-head tab-page-head">
          <View className="mh-titles">
            <Text className="mh-t">问策</Text>
            <Text className="mh-s">军师参谋室 · 分线督办，脉络可溯</Text>
          </View>
          <View className="mh-tools">
            <View className={`mh-btn ${showHistory ? 'on' : ''}`} onClick={() => setShowHistory((v) => !v)}>
              <Text style={showHistory ? { color: accent } : {}}>{showHistory ? '返回' : '历史'}</Text>
            </View>
          </View>
        </View>

        {/* WO-07：全 tab「下一步」卡（服务端 journey 派生） */}
        <NextStepCard />

        {/* 搜索（设计稿 search-pill：白底大圆角） */}
        <View className="council-search">
          <Icon name="target" size={14} color="#969BA1" />
          <Input
            className="cs-input"
            value={query}
            placeholder="搜索军师、案卷、方案或资料"
            onInput={(e) => setQuery(e.detail.value)}
          />
          {query ? <Text className="cs-clear" onClick={() => setQuery('')}>✕</Text> : null}
        </View>

        {q ? (
          /* V7-14 跨域搜索结果：按 军师 / 会话 / 方案 / 资料 分组，点按走 hit.route */
          <View className="search-results">
            {searchHits.length ? (
              SEARCH_GROUPS.map((g) => {
                const rows = searchHits.filter((h) => h.kind === g.kind);
                if (!rows.length) return null;
                return (
                  <View key={g.kind}>
                    <View className="wx-section"><Text>{g.label}</Text></View>
                    <View className="wx-list">
                      {rows.map((h) => (
                        <View key={`${h.kind}-${h.id}`} className="sr-item" onClick={() => openHit(h)}>
                          <View className="sr-main">
                            <Text className="sr-title">{h.title}</Text>
                            {h.snippet ? <Text className="sr-snippet">{h.snippet}</Text> : null}
                          </View>
                          <Text className="sr-arrow">›</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                );
              })
            ) : searching ? (
              <View className="sr-hint"><Text>正在检索…</Text></View>
            ) : (
              <View className="sess-empty">
                <View className="e-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="target" size={22} color={accent} /></View>
                <Text className="et">没有匹配的结果</Text>
                <Text className="es">换个关键词，或用下方快捷入口补充军师、案卷、方案与资料。</Text>
              </View>
            )}
          </View>
        ) : !showHistory ? (
          <>
            {/* 快捷补给（设计稿 quick-card-strip：6 卡横滑） */}
            <ScrollView scrollX className="quick-row" enhanced showScrollbar={false}>
              {QUICK_CARDS.map((c) => (
                <View
                  key={c.t}
                  className="quick-card card"
                  onClick={() => requireLogin() && (c.tab ? switchTo(c.tab) : navTo(c.url!))}
                >
                  <Text className="qt">{c.t}</Text>
                  <Text className="qd">{c.d}</Text>
                </View>
              ))}
            </ScrollView>

            {/* 总军师 + 常驻军师线程 */}
            <View className="wx-list">
              {master && matchAgent(master, '统筹判断') ? (
                <View className="wx-item" onClick={() => continueWith('general')}>
                  <AdvisorAvatar agentKey="general" size={50} online />
                  <View className="wx-main">
                    <View className="wx-top">
                      <View className="wx-id">
                        <Text className="wx-name">总军师</Text>
                        <Text className="wx-alias">{aliasOf('general')}</Text>
                        {unreadBadge(masterLast)}
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
                <View className="wx-list">
                  {moreAgents.filter((a) => matchAgent(a)).map((a) => advisorRow(a, a.role, '结论直通总军师主线'))}
                </View>
              </>
            ) : null}
          </>
        ) : (
          <>
            {/* 历史会话 */}
            <View className="wx-section"><Text>最近会话{filteredSessions.length ? ' · 长按可删除' : ''}</Text></View>
            {sessErr ? (
              <AsyncState error onRetry={loadSessions} />
            ) : filteredSessions.length === 0 ? (
              <View className="sess-empty">
                <View className="e-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="chat" size={22} color={accent} /></View>
                <Text className="et">{q ? '没有匹配的会话' : '还没有会话'}</Text>
                <Text className="es">不拘总军师还是专业军师——各线独立留档，要害汇入主线判断。</Text>
                <Text className="es-link" style={{ color: accent }} onClick={() => newWith('general')}>＋ 发起新对话</Text>
              </View>
            ) : (
              <View className="wx-list">
                {filteredSessions.map((it) => (
                  <View key={it.id} className="wx-item" onClick={() => openSession(it.id)} onLongPress={() => confirmDelete(it)}>
                    <AdvisorAvatar agentKey={it.agentKey} size={50} />
                    <View className="wx-main">
                      <View className="wx-top">
                        <View className="wx-id">
                          <Text className="wx-name">{it.agentName}</Text>
                          {aliasOf(it.agentKey) ? <Text className="wx-alias">{aliasOf(it.agentKey)}</Text> : null}
                          {unreadBadge(it)}
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
      <OnboardSheet open={showOnboard} onClose={dismissOnboard} onStart={() => { dismissOnboard(); switchTo('/pages/thinktank/index'); }} />
      <Login open={showLogin} onLoggedIn={(onboarded) => {
        setShowLogin(false);
        loadSessions();
        // 新用户（未建档）登录后进入全屏入局仪式；已建档则走 4 步引导。
        if (!onboarded) goOnboarding();
        else maybeShowOnboard();
      }} />
    </Screen>
  );
}
