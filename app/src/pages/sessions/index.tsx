import { useEffect, useState } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import TabHeader from '../../components/TabHeader';
import Icon from '../../components/Icon';
import Login from '../../components/Login';
import AsyncState from '../../components/AsyncState';
import { navTo, switchTo } from '../../services/nav';
import { isChatPending } from '../../services/chatPending';
import AdvisorAvatar from '../../components/AdvisorAvatar';
import AgentUnlock from '../../components/AgentUnlock';
import { useStore } from '../../hooks/useStore';
import { diamondCost } from '../../services/format';
import { api, type Agent, type SessionItem, type SearchHit } from '../../services/api';
import type { AuthReason } from '../../services/authGate';
import { getToken } from '../../services/token';
import { ADVISOR_ALIAS, CORE_SPECIALISTS, dialogueDirectoryAgents } from '../../data/council';
import NextStepCard from '../../components/NextStepCard';
import CoachMarks from '../../components/CoachMarks'; // 保持 CoachMarks 全站最后（避免 common chunk CSS 顺序告警，AGENTS.md §7.2）
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
// 快捷补给（新设计稿 quick-card-strip）：原来的「绑定数据源」并入「账号与数据」（账号矩阵 + 授权 + 经营数据同一入口），
// 「军师锦囊 / 模块」这张卡按设计稿撤掉——锦囊本来就是底部 tab，不必在对话页再摆一遍。
const QUICK_CARDS = [
  { t: '上传经营资料', d: '企业、老板、产品、财务资料', url: '/packages/work/knowledge/index' },
  { t: '账号与数据', d: '账号矩阵、授权与经营数据', url: '/packages/work/bindings/index' },
  { t: '生成方案', d: '把这次对话炼成一份方案', url: '/packages/work/library/index' },
  { t: '转成军令', d: '方案定了，自动拆成今天要做的事', tab: '/pages/studio/index' },
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
  const [showLogin, setShowLogin] = useState(false);
  const [loginReason, setLoginReason] = useState<AuthReason>('chat');
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false); // 检索进行中（防抖 + 请求期间给「检索中」占位，避免空态误判）

  const presentSessions = (list: SessionItem[]) => list.map((it) => (
    it.generating || !isChatPending(it.id)
      ? it
      : { ...it, generating: true, snippet: '容我想想…' }
  ));

  // 会话列表加载（C2）：失败区分未授权（弹登录）与网络错误（错误态可重试），不再一律伪装成空态。
  const loadSessions = () => {
    api.sessions()
      .then((list) => {
        setSessions(presentSessions(list));
        s.syncUnreadFromSessions(list); // 列表已在手：就地同步底栏未读角标，免得同屏两处数字不一致
        setSessErr(false);
      })
      .catch((e) => {
        const kind = s.handleApiError(e, { silent: true });
        setSessions([]);
        if (kind === 'unauthorized') { setShowLogin(true); setSessErr(false); }
        else setSessErr(true);
      });
  };

  // 留在列表等待时也要自动从“正在思考”切到最终摘要/未读，不要求用户再切一次页面。
  useEffect(() => {
    if (!s.isAuthed() || !sessions.some((it) => it.generating)) return;
    const timer = setTimeout(() => {
      api.sessions()
        .then((list) => { setSessions(presentSessions(list)); setSessErr(false); })
        .catch((e) => { s.handleApiError(e, { silent: true }); });
    }, 1500);
    return () => clearTimeout(timer);
  }, [sessions]);

  useDidShow(() => {
    s.setTab(0);
    Taro.getCurrentInstance().page?.getTabBar?.();
    s.loadAgents();
    if (!s.isAuthed()) {
      setSessions([]);
      setSessErr(false);
      return;
    }
    loadSessions();
    void s.loadBadges({ skipSessions: true }); // 军令红点搭车刷新；未读由上面的 loadSessions 就地同步，不重复拉 /sessions
  });

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

  const requireLogin = (reason: AuthReason) => {
    if (s.isAuthed()) return true;
    setLoginReason(reason);
    setShowLogin(true);
    return false;
  };
  // 军师人设与开场白是公开内容；游客也能进入对话页浏览，真正发送时再登录。
  const continueWith = (key: string) => navTo(`/packages/main/chat/index?agentKey=${key}&continue=1`);
  const newWith = (key: string) => { if (requireLogin('chat')) navTo(`/packages/main/chat/index?agentKey=${key}&fresh=1`); };
  const openSession = (id: string) => { if (requireLogin('history')) navTo(`/packages/main/chat/index?sessionId=${id}`); };
  // 搜索结果跳转：智库为 tab 页用 switchTo，其余（/packages/... 含 chat 分包页）用 navTo。
  const openHit = (h: SearchHit) => {
    if (!requireLogin('search')) return;
    if (h.route.startsWith('/pages/thinktank')) switchTo(h.route.split('?')[0]);
    else navTo(h.route);
  };

  // 线程入口：未启用的专项军师先走启用弹层，其余续接最近线程
  const tapAdvisor = (a: Agent) => {
    if (!s.isAuthed()) continueWith(a.key);
    else if (a.billing === 'unlock' && !a.owned) setBuying(a);
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
  // 后台上架是用户目录的真源：除总军师/常驻顾问/创作型外，其余已上架顾问都动态进入
  // 「专业参谋」。不能再靠写死 key 白名单，否则运营新增或重新上架的顾问接口里有、页面却消失。
  const moreAgents = dialogueDirectoryAgents(s.agents());
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
    const locked = s.isAuthed() && a.billing === 'unlock' && !a.owned;
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
        {/* 页头（TabHeader）：小字用途 + 大字「问策」+ 背景「谋」，不挂按钮。
            「历史」下移到搜索行右侧——翻旧对话与搜索同属「找东西」，且它是旧线程的唯一入口。 */}
        <TabHeader title="问策" kicker="有事问军师" glyph="谋" />

        {/* WO-07：登录后才展示个人 journey；未登录不再额外解释浏览权限。 */}
        {s.isAuthed() ? <NextStepCard /> : null}

        {/* 搜索行（设计稿 search-pill：白底大圆角）+ 右侧「历史」切换最近会话 */}
        <View className="council-searchrow">
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
          <View className={`council-hist ${showHistory ? 'on' : ''}`} onClick={() => {
            if (requireLogin('history')) setShowHistory((v) => !v);
          }}>
            <Text>{showHistory ? '返回' : '历史'}</Text>
          </View>
        </View>

        {q ? !s.isAuthed() ? (
          <AsyncState
            empty
            emptyText="搜索个人内容"
            emptyAction={{ text: '登录', onClick: () => requireLogin('search') }}
          />
        ) : (
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
                  onClick={() => requireLogin(c.t.includes('资料') ? 'upload' : c.t.includes('方案') ? 'save' : 'execute') && (c.tab ? switchTo(c.tab) : navTo(c.url!))}
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
                <Text className="es">跟谁聊都留底，要紧的我会汇到主线判断里。</Text>
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
      <CoachMarks />
      <Login open={showLogin} reason={loginReason} onClose={() => setShowLogin(false)} onLoggedIn={() => {
        setShowLogin(false);
        loadSessions();
      }} />
    </Screen>
  );
}
