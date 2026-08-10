// 问策区 · 对话主工作区。
//
// 流式一律经 services/liveGen 单例，PC 不自己碰 SSE。原因不是「省事」：一轮生成的生命周期
// 必须比组件活得久——桌面端切到另一条线程再切回来，思考中的流不能丢。liveGen 已经把
// 「累计快照 + 断流对账 + 静默失败兜底 + 报告自动入库」全做完了，PC 另写一套只会分叉出第二套 bug。
// 组件在这里只是一个可插拔的观察者：卸载即 detach（快照照常累计），重进即 attach 重放。
//
// 本期只做「对话」：移动端的报告卡、引用面板、反问选项（asks）等形态不在 PC 一期范围内，
// 报告类消息按「标题 + 分段」并入军师气泡渲染（正文不丢），完整版仍走方案库。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api, type Agent, type Deliverable, type GenRequest, type Section, type SessionDetail } from '../../services/api';
import { asReply } from '../../services/chatReply';
import {
  attachLiveGenView, detachLiveGenView, dropLiveGen, peekLiveGen, startLiveGen, stopLiveGen,
  type LiveGenView,
} from '../../services/liveGen';
import { ADVISOR_ALIAS, CORE_SPECIALISTS } from '../../data/council';
import { DIAGNOSIS_ASKS, DIAGNOSIS_CHIPS } from '../../data/intents';
import { Empty } from '../Chrome';
import { requireAuth } from '../authBridge';
import type { PcState } from '../state';
import { chatKeyOf, parseChatKey } from './sessions';
import { portraitOf } from '../portraits';

/**
 * memText 存的是带 <b> 标记的富文本（运营后台里就那么录的），记忆条是纯文本节点，
 * 不剥标签会把 `<b>企业情况</b>` 原样印在条上。顺手把 null 收成空串——这一条在最顶部，
 * 渲染期抛错就是整块白屏。与移动端 chat 页的 stripTags 同义。
 */
function stripTags(html: string): string {
  return String(html ?? '').replace(/<[^>]+>/g, '');
}

/** 对话页只需要军师的这几个字段；来源可能是 SessionDetail.agent，也可能是 store.agents()。 */
interface ChatAgent {
  key: string;
  name: string;
  role: string;
  greet: string;
  memText: string;
  alias: string;
}

function agentOf(a: Agent | SessionDetail['agent'] | undefined): ChatAgent | null {
  if (!a) return null;
  return {
    key: a.key,
    // 与列表栏同一口径：总军师在目录里叫「总军师」，不是后台配置的那个名字。
    name: a.key === 'general' ? '总军师' : a.name,
    role: a.role || '',
    greet: a.greet || '',
    memText: stripTags(a.memText || ''),
    alias: ADVISOR_ALIAS[a.key] || '',
  };
}

interface Bubble {
  uid: string;
  role: 'user' | 'agent';
  text: string;
  points?: string[];
  /** 报告类消息（role='report'）：PC 一期不复刻报告卡，降级成「标题 + 分段」并入军师气泡。 */
  sections?: { h: string; b: string }[];
  streaming?: boolean;
  /** 失败气泡可重发的原文；无则不给重试（审核类错误重试必再被拦）。 */
  retryText?: string;
}

let uidSeq = 0;
const nextUid = () => `pc-${++uidSeq}`;

/**
 * 分段正文抽取。报告 V2 有 13 种 typed section，PC 一期不逐类渲染，
 * 只把带文字的字段拍平成一段——宁可样式朴素，也不能让正文在 PC 上凭空消失。
 */
function sectionBody(s: Section): string {
  const raw = s as unknown as Record<string, unknown>;
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);
  const out: string[] = [];
  if (typeof raw.b === 'string' && raw.b) out.push(raw.b);
  if (typeof raw.text === 'string' && raw.text) out.push(raw.text);
  out.push(...strs(raw.paras), ...strs(raw.list));
  return out.join('\n');
}

function bubblesOf(messages: SessionDetail['messages']): Bubble[] {
  return messages.map((m) => {
    const uid = m.id || nextUid();
    if (m.role === 'user') {
      const c = (m.content || {}) as { text?: string };
      return { uid, role: 'user' as const, text: String(c.text || '') };
    }
    if (m.role === 'report') {
      const d = (m.content || {}) as Deliverable;
      return {
        uid,
        role: 'agent' as const,
        text: d.meta ? `《${d.title || '方案'}》 · ${d.meta}` : `《${d.title || '方案'}》`,
        sections: (Array.isArray(d.sections) ? d.sections : []).map((s) => ({ h: s.h || '', b: sectionBody(s) })),
      };
    }
    const r = asReply(m.content);
    return { uid, role: 'agent' as const, text: r.text, points: r.points };
  });
}

/**
 * 顶栏要显示当前军师，而顶栏由 App 渲染、拿不到本组件的 state。
 * `a:`/`n:` 两种 chatKey 能直接从军师目录同步解出；只有 `s:<sessionId>` 必须等详情到货，
 * 所以留一张会话→军师的小映射，由主区加载完后回填，顶栏订阅它重算。
 */
const SESSION_AGENT = new Map<string, ChatAgent>();
const headSubs = new Set<() => void>();

function publishSessionAgent(sessionId: string, agent: ChatAgent): void {
  if (!sessionId) return;
  if (SESSION_AGENT.get(sessionId)?.key === agent.key) return;
  SESSION_AGENT.set(sessionId, agent);
  headSubs.forEach((f) => f());
}

function agentFromDirectory(agentKey: string): ChatAgent | null {
  return agentOf(store.agents().find((a) => a.key === agentKey));
}

/** 问策区顶栏：当前军师名 + 在线状态 + 另起一炉。 */
export function useChatBar(st: PcState) {
  useStore(); // 军师目录晚于首帧到货，目录一变顶栏就得重算
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    headSubs.add(f);
    return () => { headSubs.delete(f); };
  }, []);

  const t = parseChatKey(st.chatKey);
  const agent = !t ? null : t.kind === 'session' ? SESSION_AGENT.get(t.sessionId) || null : agentFromDirectory(t.agentKey);
  if (!agent) return { title: '问策', sub: '选一位军师开始' };
  // 「在线」没有对应的后端字段（军师不是真人，也没有 presence 接口），是固定的可用性表达，不是实时状态。
  const sub = [agent.alias, '在线', agent.role].filter(Boolean).join(' · ');
  return {
    title: agent.name,
    sub,
    actions: [{
      t: '另起一炉',
      ghost: true,
      go: () => st.setChatKey(chatKeyOf({ kind: 'fresh', agentKey: agent.key })),
    }],
  };
}

function Avatar({ agentKey, name }: { agentKey: string; name: string }) {
  const src = portraitOf(agentKey);
  return (
    <span className="pc-chat-av">
      {src ? <span className="pc-chat-av-img" style={{ backgroundImage: `url(${src})` }} /> : name.slice(0, 1)}
    </span>
  );
}

// token 合批：一 token 一次 setState 会让整条消息流每帧重排，长回复下肉眼可见地卡。
// 攒够一行字或到点再落屏，视觉上仍是逐字流。
const TOKEN_FLUSH_CHARS = 48;
const TOKEN_FLUSH_MS = 110;
// 服务端仍在生成、但本地没有实时流可续（重进 / 断流对账交回）时的轮询兜底。
const POLL_GAP_MS = 2500;
const POLL_TRIES = 48;

export default function Main({ st }: { st: PcState }) {
  const s = useStore();
  const authed = s.isAuthed();
  const target = useMemo(() => parseChatKey(st.chatKey), [st.chatKey]);

  const [agent, setAgent] = useState<ChatAgent | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [msgs, setMsgs] = useState<Bubble[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');

  const sessionIdRef = useRef('');
  const agentRef = useRef<ChatAgent | null>(null);
  const liveKeyRef = useRef('');
  const liveViewRef = useRef<LiveGenView | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);
  const tokenBufRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const pollSeqRef = useRef(0);
  /** 本轮新建的会话 id：等这一轮收尾后才写回地址栏（chatKey 一变就重载，不能在流中途做）。 */
  const newSessionRef = useRef('');

  sessionIdRef.current = sessionId;
  agentRef.current = agent;

  // —— 滚动跟随：只在用户仍贴底时跟，上滚翻旧消息时不许把人拽回来 ——
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  }, []);
  const follow = useCallback((force = false) => {
    const el = scrollRef.current;
    if (!el || (!force && !stickRef.current)) return;
    el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(() => { follow(); }, [msgs, follow]);

  // —— 气泡补丁：流式期间只改「最后一条正在流的军师气泡」 ——
  const patchLive = useCallback((fn: (b: Bubble) => Bubble) => {
    setMsgs((m) => {
      const i = m.length - 1;
      if (i < 0 || m[i].role !== 'agent' || !m[i].streaming) return m;
      const copy = m.slice();
      copy[i] = fn(copy[i]);
      return copy;
    });
  }, []);

  const resetTokenBuf = useCallback(() => {
    clearTimeout(flushTimerRef.current);
    flushTimerRef.current = undefined;
    tokenBufRef.current = '';
  }, []);
  const flushTokenBuf = useCallback(() => {
    clearTimeout(flushTimerRef.current);
    flushTimerRef.current = undefined;
    const buf = tokenBufRef.current;
    if (!buf) return;
    tokenBufRef.current = '';
    patchLive((b) => ({ ...b, text: b.text + buf }));
  }, [patchLive]);

  const restore = useCallback((detail: SessionDetail) => {
    resetTokenBuf();
    setSessionId(detail.id);
    setMsgs(bubblesOf(detail.messages));
  }, [resetTokenBuf]);

  // 服务端仍在生成、但本地没有实时流：按会话详情轮询，等本轮 assistant 落库后整体重绘。
  // 与 liveGen 的实时续流互斥——两条路径同时改同一串气泡就会互相盖写。
  const pollUntilStored = useCallback(async (sid: string) => {
    const seq = ++pollSeqRef.current;
    setBusy(true);
    for (let i = 0; i < POLL_TRIES; i++) {
      await new Promise<void>((r) => setTimeout(r, POLL_GAP_MS));
      if (seq !== pollSeqRef.current || sessionIdRef.current !== sid) return;
      const detail = await api.session(sid).catch(() => null);
      if (seq !== pollSeqRef.current || sessionIdRef.current !== sid) return;
      if (!detail) continue;
      const last = detail.messages[detail.messages.length - 1];
      if (!detail.generating && last && last.role !== 'user') { restore(detail); break; }
      if (!detail.generating && i > 2) break; // 服务端已不在生成又没落库：别无限等
    }
    if (seq === pollSeqRef.current) setBusy(false);
  }, [restore]);

  const buildView = useCallback((viewAgent: ChatAgent): LiveGenView => ({
    onSession: (id) => {
      if (!id || sessionIdRef.current) return;
      setSessionId(id);
      publishSessionAgent(id, viewAgent);
      // 地址栏改写推迟到本轮收尾（见下方 useEffect）：现在换 chatKey 会把正在流的这一轮重载掉。
      newSessionRef.current = id;
    },
    onGeneration: () => { /* PC 一期不展示 generation 阶段/图片进度，只保留 busy 一态 */ },
    startChat: () => {
      resetTokenBuf();
      setMsgs((m) => [...m, { uid: nextUid(), role: 'agent', text: '', streaming: true }]);
      follow(true);
    },
    appendToken: (t) => {
      tokenBufRef.current += t;
      if (tokenBufRef.current.length >= TOKEN_FLUSH_CHARS) { flushTokenBuf(); return; }
      if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flushTokenBuf, TOKEN_FLUSH_MS);
    },
    replaceToken: (text) => { resetTokenBuf(); patchLive((b) => ({ ...b, text })); },
    setChat: (reply) => {
      resetTokenBuf();
      const r = asReply(reply);
      patchLive((b) => ({ ...b, text: r.text, points: r.points }));
    },
    startReport: () => {
      resetTokenBuf();
      setMsgs((m) => [...m, { uid: nextUid(), role: 'agent', text: `《${viewAgent.name}正在出方案》`, sections: [], streaming: true }]);
      follow(true);
    },
    reportBegin: (data) => patchLive((b) => ({ ...b, text: data.meta ? `《${data.title}》 · ${data.meta}` : `《${data.title}》` })),
    reportSection: (section) => {
      const row = { h: section.h || '未命名段落', b: sectionBody(section) };
      patchLive((b) => {
        const list = (b.sections || []).slice();
        if (typeof section.index === 'number' && section.index >= 0) list[section.index] = row;
        else list.push(row);
        return { ...b, sections: list.filter(Boolean) };
      });
      follow();
    },
    reportFooter: () => { /* PC 一期不渲染报告页脚（trust / actions），完整版在方案库里看 */ },
    finishChat: () => { flushTokenBuf(); patchLive((b) => ({ ...b, streaming: false })); follow(true); },
    finishReport: () => { patchLive((b) => ({ ...b, streaming: false })); follow(true); },
    error: (_kind, message, retry) => {
      flushTokenBuf();
      setMsgs((m) => {
        const i = m.length - 1;
        const bubble: Bubble = { uid: nextUid(), role: 'agent', text: message || '生成失败', retryText: retry };
        // 没吐出任何内容的空占位就地换成错误气泡；已有内容则另起一条，别把流出来的字抹掉。
        if (i >= 0 && m[i].role === 'agent' && m[i].streaming && !m[i].text && !(m[i].sections || []).length) {
          const copy = m.slice();
          copy[i] = { ...bubble, uid: m[i].uid };
          return copy;
        }
        const copy = m.slice();
        if (i >= 0 && copy[i].streaming) copy[i] = { ...copy[i], streaming: false };
        return [...copy, bubble];
      });
      follow(true);
    },
    fallbackDone: (res, retryText) => {
      // 非流式兜底（流静默失败后 liveGen 同步补发一次）：结果一次性到齐，直接替换占位。
      resetTokenBuf();
      if (res.sessionId && !sessionIdRef.current) {
        setSessionId(res.sessionId);
        publishSessionAgent(res.sessionId, viewAgent);
        newSessionRef.current = res.sessionId;
      }
      const done: Bubble = res.kind === 'report' && res.deliverable
        ? {
          uid: nextUid(),
          role: 'agent',
          text: res.deliverable.meta ? `《${res.deliverable.title}》 · ${res.deliverable.meta}` : `《${res.deliverable.title}》`,
          sections: (res.deliverable.sections || []).map((x) => ({ h: x.h || '', b: sectionBody(x) })),
        }
        : (() => { const r = asReply(res.reply); return { uid: nextUid(), role: 'agent' as const, text: r.text || '军师暂时没有接上，请重试', points: r.points, retryText: r.text ? undefined : retryText }; })();
      setMsgs((m) => {
        const i = m.length - 1;
        if (i >= 0 && m[i].role === 'agent' && m[i].streaming) {
          const copy = m.slice();
          copy[i] = { ...done, uid: m[i].uid };
          return copy;
        }
        return [...m, done];
      });
      follow(true);
    },
    restoreServerTruth: (detail) => { pollSeqRef.current += 1; restore(detail); follow(true); },
    resumeServerPolling: (sid) => { void pollUntilStored(sid); },
    memoryLearned: (agentName) => st.say(`${agentName}记住了这条`),
    abortedChat: () => {
      flushTokenBuf();
      setMsgs((m) => {
        const i = m.length - 1;
        if (i < 0 || m[i].role !== 'agent' || !m[i].streaming) return m;
        const copy = m.slice();
        if (!copy[i].text && !(copy[i].sections || []).length) { copy.splice(i, 1); return copy; }
        copy[i] = { ...copy[i], streaming: false };
        return copy;
      });
    },
    clearBusy: () => setBusy(false),
  }), [flushTokenBuf, follow, patchLive, pollUntilStored, resetTokenBuf, restore, st]);

  // —— 进场：解析 chatKey → 定位会话 → 载入消息 → 接管在途生成 ——
  useEffect(() => {
    let alive = true;
    pollSeqRef.current += 1;
    resetTokenBuf();
    setBusy(false);
    setMsgs([]);
    setSessionId('');
    stickRef.current = true;

    newSessionRef.current = '';

    if (!target) { setAgent(null); setLoading(false); return () => { alive = false; }; }

    // 目录里能同步解出的先摆上，避免「军师名先空一帧再跳出来」。
    const fromDirectory = target.kind === 'session' ? null : agentFromDirectory(target.agentKey);
    setAgent(fromDirectory);

    void (async () => {
      setLoading(true);
      try {
        let sid = '';
        if (target.kind === 'session') sid = target.sessionId;
        else if (target.kind === 'agent' && store.isAuthed()) {
          // 「续接最近线程」：列表里点的是军师，得先问一遍他最近那条会话是哪个。
          const list = await api.sessions().catch(() => []);
          if (!alive) return;
          sid = [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).find((x) => x.agentKey === target.agentKey)?.id || '';
        }

        const detail = sid ? await api.session(sid).catch((e) => { s.handleApiError(e); return null; }) : null;
        if (!alive || !detail) return;

        const resolved = agentOf(detail.agent) || fromDirectory;
        if (!resolved) return;
        setAgent(resolved);
        publishSessionAgent(detail.id, resolved);
        restore(detail);
        follow(true);

        // 本轮可能还在天上飞：liveGen 有实时流就续流，否则服务端 generating 交轮询兜底。两条互斥。
        const last = detail.messages[detail.messages.length - 1];
        const peek = peekLiveGen(detail.id);
        if (peek?.active && last?.role === 'user') {
          const view = buildView(resolved);
          liveViewRef.current = view;
          liveKeyRef.current = detail.id;
          setBusy(true);
          attachLiveGenView(detail.id, view); // 重放累计快照：重建气泡，后续 token 实时续入本页
        } else {
          if (peek) dropLiveGen(detail.id);
          if (detail.generating) void pollUntilStored(detail.id);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
      // 切走只解绑观察者，绝不停流——回来还要靠 liveGen 的快照把思考中的流接上。
      if (liveKeyRef.current && liveViewRef.current) detachLiveGenView(liveKeyRef.current, liveViewRef.current);
      liveViewRef.current = null;
      liveKeyRef.current = '';
      clearTimeout(flushTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.chatKey, authed]);

  // 新会话收尾后把 chatKey 换成 `s:<id>`：地址栏从此指向这条真实线程，刷新/转发都还在原地，
  // 列表栏的选中高亮也跟着对上。必须等 busy 落下——流中途换 key 会把这一轮重载掉。
  useEffect(() => {
    if (busy || !newSessionRef.current) return;
    const id = newSessionRef.current;
    newSessionRef.current = '';
    st.setChatKey(chatKeyOf({ kind: 'session', sessionId: id }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  // —— 发送 ——
  const growTextarea = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(180, Math.max(46, el.scrollHeight))}px`;
  }, []);

  const send = useCallback((raw: string) => {
    const text = raw.trim();
    const ag = agentRef.current;
    if (!text || busy || !ag) return;
    if (!requireAuth('chat')) return;
    const plan = s.me()?.planStatus;
    // 到期/未开通在前端就拦：后端的 403 是兜底，别让人写完一整段话才被打回来。
    if (plan?.expired) { st.say('套餐已到期，续费后可继续对话'); return; }
    if (plan?.none) { st.say('尚未开通方案，开通后即可对话'); return; }

    setBusy(true);
    setDraft('');
    if (taRef.current) taRef.current.style.height = '46px';
    setMsgs((m) => [...m, { uid: nextUid(), role: 'user', text }]);
    stickRef.current = true;

    const sid = sessionIdRef.current;
    // 同一次点击一个稳定 clientRequestId：同轮的补发/兜底复用它，服务端据此幂等，不会重复落消息。
    const clientRequestId = `pc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const body: GenRequest = { text, sessionId: sid || undefined, agentKey: ag.key, clientRequestId };
    const view = buildView(ag);
    liveViewRef.current = view;
    liveKeyRef.current = startLiveGen({
      key: sid || `new:${ag.key}:${Date.now()}`,
      sessionId: sid,
      agentKey: ag.key,
      userText: text,
      body,
      view,
      buildDeliverable: (begin, sections, footer) => ({
        title: begin?.title || `${ag.name}的方案`,
        icon: begin?.icon || 'doc',
        meta: begin?.meta || '',
        sections,
        trust: footer?.trust || '',
        actions: footer?.actions?.length ? footer.actions : ['save_to_library'],
      }),
      // 报告收尾静默入库，与移动端同一行为：桌面出的方案也得在方案库里找得到。
      // type 优先取军师的 deliverableKey（方案库按它反查归类），缺配置才退回标题。
      autoSave: (d) => {
        const type = store.agents().find((a) => a.key === ag.key)?.deliverableKey || d.title;
        void api.saveToLibrary({
          title: d.title, type, agentKey: ag.key,
          sessionId: sessionIdRef.current || undefined, content: d, auto: true,
        }).catch(() => { /* 静默：入库失败不打扰对话，方案仍在消息里 */ });
      },
    });
  }, [buildView, busy, s, st]);

  const stop = useCallback(() => {
    if (!busy) return;
    if (liveKeyRef.current && peekLiveGen(liveKeyRef.current)?.active) { stopLiveGen(liveKeyRef.current); return; }
    setBusy(false);
  }, [busy]);

  // —— 派给：常驻军师一排 chip，点了换当前军师（续接他的最近线程） ——
  const directory = s.agents();
  const dispatch = useMemo(() => {
    const keys = ['general', ...CORE_SPECIALISTS.map((x) => x.agentKey)];
    return keys
      .map((k) => directory.find((a) => a.key === k))
      .filter((a): a is Agent => !!a)
      .map((a) => ({ key: a.key, name: a.key === 'general' ? '总军师' : a.name }));
  }, [directory]);

  if (!target) {
    return <Empty glyph="策" title="选一位军师" sub="左侧挑一条线程开始，或右键某位军师另起一炉" />;
  }
  if (!agent) {
    return <Empty glyph="策" title={loading ? '正在接通军师…' : '这条线程打不开'} sub={loading ? undefined : '会话可能已被删除，回左侧另选一条'} />;
  }

  // 空会话才摆诊断卡：已经聊起来了再摆一遍四问就是噪音。
  const showDiagnosis = msgs.length === 0;
  const greet = agent.greet || '说说你的处境，我先判断主要矛盾。';

  return (
    <div className="pc-chat">
      <div className="pc-chat-mem">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M12 3v2M12 19v2M3 12h2M19 12h2" />
          <circle cx="12" cy="12" r="3.4" />
        </svg>
        <span className="pc-chat-mem-t">{agent.memText || '你说过的事我都记着，做判断时会用上。'}</span>
        <span className="pc-chat-mem-on"><i />记着呢</span>
      </div>

      <div className="pc-chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="pc-chat-flow">
          <div className="pc-chat-disclaim">内容由 AI 生成，仅供参考</div>

          {msgs.length === 0 && (
            <div className="pc-chat-msg pc-a">
              <div className="pc-chat-agent">
                <div className="pc-chat-who">
                  <Avatar agentKey={agent.key} name={agent.name} />
                  <span className="pc-chat-name">{agent.name}</span>
                </div>
                <div className="pc-chat-body">{greet}</div>
              </div>
            </div>
          )}

          {msgs.map((m) => (
            <div className={`pc-chat-msg${m.role === 'user' ? ' pc-u' : ' pc-a'}`} key={m.uid}>
              {m.role === 'user' ? (
                <div className="pc-chat-bubble">{m.text}</div>
              ) : (
                <div className="pc-chat-agent">
                  <div className="pc-chat-who">
                    <Avatar agentKey={agent.key} name={agent.name} />
                    <span className="pc-chat-name">{agent.name}</span>
                  </div>
                  <div className="pc-chat-body">
                    {m.text}
                    {m.streaming && <span className="pc-chat-caret" />}
                  </div>
                  {!!m.points?.length && (
                    <div className="pc-chat-points">
                      {m.points.map((p, i) => (
                        <div className="pc-chat-point" key={`${m.uid}-p${i}`}><span className="pc-chat-pdot" /><span>{p}</span></div>
                      ))}
                    </div>
                  )}
                  {!!m.sections?.length && (
                    <div className="pc-chat-secs">
                      {m.sections.map((sec, i) => (
                        <div className="pc-chat-sec" key={`${m.uid}-s${i}`}>
                          {sec.h && <div className="pc-chat-sec-h">{sec.h}</div>}
                          {sec.b && <div className="pc-chat-sec-b">{sec.b}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                  {m.retryText && (
                    <div className="pc-chat-retry">
                      <button type="button" onClick={() => send(m.retryText!)}>重试这一问</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {showDiagnosis && (
            <div className="pc-chat-diag">
              <div className="pc-chat-diag-t">今天先把案卷跑通</div>
              <div className="pc-chat-diag-s">你可以先按这 4 件事讲，讲不全也没关系，我会继续问。</div>
              <div className="pc-chat-diag-list">
                {DIAGNOSIS_ASKS.map(([k, q], i) => (
                  <div className="pc-chat-diag-row" key={k}>
                    <span className="pc-chat-diag-no">{i + 1}</span>
                    <span className="pc-chat-diag-q"><b>{k}</b>：{q}</span>
                  </div>
                ))}
              </div>
              <div className="pc-chat-diag-chips">
                {DIAGNOSIS_CHIPS.map((c) => (
                  // chip 上是短词，发出去的是 c.text——短词发过去军师拿不到上下文。
                  <button type="button" key={c.label} onClick={() => send(c.text)}>{c.label}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="pc-chat-composer">
        <div className="pc-chat-composer-in">
          <div className="pc-chat-dispatch">
            <span className="pc-chat-dispatch-l">派给</span>
            {dispatch.map((d) => (
              <button
                type="button"
                key={d.key}
                className={d.key === agent.key ? 'pc-on' : ''}
                onClick={() => st.setChatKey(chatKeyOf({ kind: 'agent', agentKey: d.key }))}
              >
                {d.name}
              </button>
            ))}
          </div>

          <div className="pc-chat-box">
            <textarea
              ref={taRef}
              className="pc-chat-ta"
              value={draft}
              rows={2}
              placeholder="向军师提问…"
              onChange={(e) => { setDraft(e.target.value); growTextarea(); }}
              onKeyDown={(e) => {
                // 中文输入法选词时的 Enter 是「上屏」，不是「发送」——不看 isComposing 会把半截拼音发出去。
                if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
                e.preventDefault();
                send(draft);
              }}
            />
            <div className="pc-chat-tools">
              <button
                type="button"
                className="pc-chat-attach"
                title="附加资料"
                onClick={() => st.say('附件上传随锦囊一起落地，这一版先用文字描述')}
              >
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <path d="M20 11.5l-7.6 7.6a4 4 0 0 1-5.7-5.7l7.6-7.6a2.6 2.6 0 0 1 3.7 3.7l-7.5 7.5a1.2 1.2 0 0 1-1.7-1.7l6.9-6.9" />
                </svg>
              </button>
              <span className="pc-chat-hint">{busy ? '军师正在推演…' : 'Enter 发送 · Shift+Enter 换行'}</span>
              {busy
                ? <button type="button" className="pc-chat-send pc-stop" onClick={stop}>停止</button>
                : <button type="button" className="pc-chat-send" onClick={() => send(draft)}>发送</button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
