// 问策区 · 列表栏（军师线程列表）。
//
// 两种视图共用一套行渲染：「全部军师」按常驻/专业分组铺 store.agents()，
// 「最近会话」铺 api.sessions()。分两个视图而不是合并成一条列表，是因为
// 军师是**固定入口**（没聊过也得能进），会话是**流水**（按时间倒序、可删）——
// 两者排序规则天然冲突，合流只会让「找人」和「翻旧账」互相打架。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../hooks/useStore';
import { api, type Agent, type SessionItem } from '../../services/api';
import { platform } from '../../services/platform';
import { ADVISOR_ALIAS, CORE_SPECIALISTS, dialogueDirectoryAgents } from '../../data/council';
import { portraitOf } from '../portraits';
import type { CtxItem, PcState } from '../state';

/**
 * chatKey 编码。一个字符串要同时表达三种进场，因为它会写进地址栏（?k=）被刷新、被转发：
 * 续接某位军师的最近线程 / 打开指定会话 / 对某位军师另起一炉。
 * 三个前缀与移动端 chat 页的 `continue=1` / `sessionId` / `fresh=1` 一一对应，
 * 对话主区解析后走同一套加载逻辑，两端不必各自发明一套。
 */
export type ChatTarget =
  | { kind: 'agent'; agentKey: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'fresh'; agentKey: string };

export function chatKeyOf(t: ChatTarget): string {
  if (t.kind === 'session') return `s:${t.sessionId}`;
  return `${t.kind === 'fresh' ? 'n' : 'a'}:${t.agentKey}`;
}

export function parseChatKey(k: string): ChatTarget | null {
  const body = k.slice(2);
  if (!body) return null;
  if (k.startsWith('s:')) return { kind: 'session', sessionId: body };
  if (k.startsWith('n:')) return { kind: 'fresh', agentKey: body };
  if (k.startsWith('a:')) return { kind: 'agent', agentKey: body };
  return null;
}

function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  const d = Math.floor(s / 86400);
  return d === 1 ? '昨天' : `${d} 天前`;
}

interface Row {
  id: string;
  chatKey: string;
  agentKey: string;
  /** 该行背后的会话；军师行有历史时也带上，右键才能标已读/删除 */
  sessionId?: string;
  menuLabel: string;
  name: string;
  alias: string;
  time: string;
  timeAccent: boolean;
  preview: string;
  unread: number;
  hasUnread: boolean;
  locked: boolean;
  online: boolean;
}

function Avatar({ agentKey, name, online }: { agentKey: string; name: string; online: boolean }) {
  const src = portraitOf(agentKey);
  return (
    <span className="pc-thread-av">
      {src
        ? <span className="pc-thread-av-img" style={{ backgroundImage: `url(${src})` }} />
        : name.slice(0, 1)}
      {online && <span className="pc-thread-av-dot" />}
    </span>
  );
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2, 3].map((i) => (
        <div className="pc-thread-skel" key={i}>
          <span className="pc-thread-skel-av" />
          <span className="pc-thread-skel-main">
            <span className="pc-thread-skel-l" style={{ width: '42%' }} />
            <span className="pc-thread-skel-l" style={{ width: '78%' }} />
          </span>
        </div>
      ))}
    </>
  );
}

export default function ListBody({ st }: { st: PcState }) {
  const s = useStore();
  const authed = s.isAuthed();

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState(false);

  const load = useCallback(async () => {
    if (!s.isAuthed()) { setSessions([]); setLoaded(true); return; }
    setLoading(true);
    try {
      const list = await api.sessions();
      setSessions(list);
      s.syncUnreadFromSessions(list); // 列表已在手，就地对齐轨道角标，免得同屏两处数字打架
    } catch (e) {
      s.handleApiError(e);
      setSessions([]);
      // 会话拉不到就退回军师视图：store.agents() 有离线兜底，永远铺得满，
      // 总比留个空壳让人以为「我的会话没了」强。
      setHistory(false);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [s]);

  useEffect(() => { void load(); }, [load, authed]);

  const agents = s.agents();
  // 自己排一次序，不赖后端返回的顺序：军师行取「最近一条」和会话视图的倒序，都指望这个不变量。
  const recent = useMemo(
    () => [...sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    [sessions],
  );
  const latestOf = useCallback(
    (agentKey: string) => recent.find((x) => x.agentKey === agentKey),
    [recent],
  );

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (r: Row) => !q || `${r.name}${r.alias}${r.preview}`.toLowerCase().includes(q);

    if (history) {
      const rows: Row[] = recent
        .map((it) => ({
          id: it.id,
          chatKey: chatKeyOf({ kind: 'session', sessionId: it.id }),
          agentKey: it.agentKey,
          sessionId: it.id,
          menuLabel: it.title || it.agentName,
          name: it.agentName,
          alias: ADVISOR_ALIAS[it.agentKey] || '',
          time: relTime(it.updatedAt),
          timeAccent: false,
          preview: it.title ? `${it.title} · ${it.snippet}` : it.snippet,
          unread: it.unreadCount ?? 0,
          hasUnread: !!it.hasUnread,
          locked: false,
          online: false,
        }))
        .filter(hit);
      return [{ label: `最近会话${rows.length ? ' · 右键可删除' : ''}`, rows }];
    }

    const rowOf = (a: Agent, duty: string, online = false): Row => {
      const last = latestOf(a.key);
      // 未登录时不摆锁：游客本来就该能翻军师人设，锁只对「已登录但没开通」有意义。
      const locked = authed && a.billing === 'unlock' && !a.owned;
      const name = a.key === 'general' ? '总军师' : a.name;
      return {
        id: a.key,
        chatKey: chatKeyOf({ kind: 'agent', agentKey: a.key }),
        agentKey: a.key,
        sessionId: last?.id,
        menuLabel: name,
        name,
        alias: ADVISOR_ALIAS[a.key] || '',
        // 2026-08「确认即启用」：启用不收费，锁态只说「需启用」，不给启用动作标价。
        time: locked ? '需启用' : last ? relTime(last.updatedAt) : online ? '在线' : '',
        timeAccent: locked,
        preview: last?.snippet || duty,
        unread: last?.unreadCount ?? 0,
        hasUnread: !!last?.hasUnread,
        locked,
        online,
      };
    };

    const core: Row[] = [];
    const master = agents.find((a) => a.key === 'general');
    if (master) core.push(rowOf(master, master.greet || '说说你的处境，我先判断主要矛盾，再调度专业军师。', true));
    CORE_SPECIALISTS.forEach((sp) => {
      const a = agents.find((x) => x.key === sp.agentKey);
      if (a) core.push(rowOf(a, `${sp.duty} · ${sp.syncDesc}`));
    });

    const more = dialogueDirectoryAgents(agents).map((a) => rowOf(a, `${a.role} · 结论直通总军师主线`));

    return [
      { label: '常驻军师', rows: core.filter(hit) },
      { label: '专业参谋', rows: more.filter(hit) },
    ].filter((g) => g.rows.length > 0);
  }, [agents, authed, history, latestOf, query, recent]);

  const openRow = (r: Row) => {
    st.setChatKey(r.chatKey);
    if (r.locked) st.say(`「${r.name}」还没启用，去锦囊里启用即可`);
  };

  const markRead = async (id: string) => {
    try {
      // 服务端没有独立的已读接口：lastReadAt 只在读取会话详情（GET /sessions/:id 首页）时写，
      // 所以「标记为已读」就是替用户读一次，再把列表拉回来让角标归零。
      await api.session(id);
      await load();
      st.say('已标记为已读');
    } catch (e) { s.handleApiError(e, { fallbackTitle: '标记失败' }); }
  };

  const removeSession = async (id: string, label: string) => {
    const ok = await platform.confirm({
      title: '删除会话',
      content: `删除「${label}」后不可恢复，确定删除？`,
      confirmText: '删除',
    });
    if (!ok) return;
    try {
      await api.deleteSession(id);
      await load();
      st.say('已删除会话');
    } catch (e) { s.handleApiError(e, { fallbackTitle: '删除失败' }); }
  };

  const menuFor = (r: Row): CtxItem[] => {
    const items: CtxItem[] = [
      { t: '继续这条线程', k: 'Enter', go: () => openRow(r) },
      { t: '发起新对话', k: '⌘N', go: () => st.setChatKey(chatKeyOf({ kind: 'fresh', agentKey: r.agentKey })) },
    ];
    if (r.sessionId) {
      const id = r.sessionId;
      items.push({ t: '标记为已读', go: () => { void markRead(id); } });
      items.push({ t: '删除会话', k: '⌫', danger: true, go: () => { void removeSession(id, r.menuLabel); } });
    }
    return items;
  };

  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <>
      <div className="pc-thread-search">
        <label className="pc-thread-field">
          <svg className="pc-thread-ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <circle cx="12" cy="12" r="8" />
            <circle cx="12" cy="12" r="4" />
          </svg>
          <input
            className="pc-thread-input"
            value={query}
            placeholder="搜索军师、案卷、方案或资料"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          type="button"
          className={`pc-thread-toggle${history ? ' pc-on' : ''}`}
          onClick={() => setHistory((v) => !v)}
        >
          {history ? '全部军师' : '最近会话'}
        </button>
      </div>

      <div className="pc-thread-scroll">
        {loading && !loaded ? <SkeletonRows /> : total === 0 ? (
          <div className="pc-thread-empty">
            {query.trim()
              ? '没有匹配的军师或会话，换个词试试。'
              : history
                ? (authed ? '还没有会话。挑一位军师问一句，问过的都留底。' : '登录后才看得到自己的会话。')
                : '军师目录还没加载出来，稍后再看看。'}
          </div>
        ) : groups.map((g) => (
          <div className="pc-thread-group" key={g.label}>
            <div className="pc-thread-group-label">{g.label}</div>
            {g.rows.map((r) => (
              <button
                type="button"
                key={r.id}
                className={`pc-thread-row${st.chatKey === r.chatKey ? ' pc-on' : ''}`}
                onClick={() => openRow(r)}
                onContextMenu={(e) => st.openCtx(e, r.menuLabel, menuFor(r))}
              >
                <Avatar agentKey={r.agentKey} name={r.name} online={r.online} />
                <span className="pc-thread-main">
                  <span className="pc-thread-top">
                    <span className="pc-thread-id">
                      <span className="pc-thread-name">{r.name}</span>
                      {r.alias && <span className="pc-thread-alias">{r.alias}</span>}
                      {r.unread > 0
                        ? <span className="pc-thread-unread">{r.unread > 99 ? '99+' : r.unread}</span>
                        : r.hasUnread ? <span className="pc-thread-dot" /> : null}
                    </span>
                    {r.time && <span className={`pc-thread-time${r.timeAccent ? ' pc-accent' : ''}`}>{r.time}</span>}
                  </span>
                  <span className="pc-thread-preview">{r.preview}</span>
                </span>
                {r.locked && (
                  <svg className="pc-thread-lock" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                    <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" />
                    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
