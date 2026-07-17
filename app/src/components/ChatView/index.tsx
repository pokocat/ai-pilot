import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { View, Text, Textarea, ScrollView, Input, Picker } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '../Icon';
import Login from '../Login';
import MarkdownText from '../MarkdownText';
import ReportCard from '../ReportCard';
import SafeHeader from '../SafeHeader';
import AdvisorAvatar from '../AdvisorAvatar';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api, getUserId, type Agent, type Deliverable, type Section, type ChatReplyT, type MessageRef, type ProjectItem, type ReportItem, type KnowledgeItemT, type MemoryCandidate, type BaziBody, type OnboardingMsg, type OnboardingStage, type OnboardingAdvanceBody } from '../../services/api';
import { STREAM_CHAT } from '../../services/config';
import { generateStream } from '../../services/streaming';
import { requestWechatSubscribe } from '../../services/wechatSubscribe';
import { agentForText } from '../../data/intents';
import { ADVISOR_ALIAS, CORE_SPECIALISTS, DISPATCH_SUGGESTIONS } from '../../data/council';
import { CHAT_GUIDES } from '../../data/operatingSystem';
import { COLORS } from '../../data/colors';
import { acceptDeliverable } from '../../services/dossier';
import './index.scss';

// 选择笺 / 请缨帖数据结构（服务端 OnboardingMsg.choices 与 propose 事件同构）。
export type Choice = { label: string; value: string };
export type Proposal = { title: string; prompt: string; declinePrompt: string; readiness: number };

export type Msg =
  | { role: 'greet'; agent: Agent }
  | { role: 'user'; text: string; refs?: MessageRef[] }
  | { role: 'assistant'; reply: ChatReplyT; knowledgeUsed?: string[]; retryText?: string; streaming?: boolean; choices?: Choice[]; widget?: string; proposal?: Proposal }
  | { role: 'report'; deliverable: Deliverable; animate: boolean; saved?: boolean; messageId?: string; knowledgeUsed?: string[]; streaming?: boolean; proposal?: Proposal }
  | { role: 'memory'; agentName: string };

// 十二时辰（含「不确定」），值为代表小时；与 components/Picker 的 SHICHEN 同源，用于服务端排盘。
const SHICHEN: { label: string; hour: number | null }[] = [
  { label: '不确定', hour: null },
  { label: '子 23-1', hour: 0 }, { label: '丑 1-3', hour: 2 }, { label: '寅 3-5', hour: 4 },
  { label: '卯 5-7', hour: 6 }, { label: '辰 7-9', hour: 8 }, { label: '巳 9-11', hour: 10 },
  { label: '午 11-13', hour: 12 }, { label: '未 13-15', hour: 14 }, { label: '申 15-17', hour: 16 },
  { label: '酉 17-19', hour: 18 }, { label: '戌 19-21', hour: 20 }, { label: '亥 21-23', hour: 22 },
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ChatViewProps {
  agentKey?: string;
  sessionId?: string;
  /** 续接该顾问最近一次会话（对齐旧路由 continue=1） */
  continueThread?: boolean;
  /** 开新会话（对齐旧路由 fresh=1） */
  fresh?: boolean;
  /** 初始化后自动发送一条（对齐旧路由 send=） */
  prefillSend?: string;
  projectId?: string;
  /** 三势研判入口带来的势标签（认可存库写入报告 type，供战局卡反查） */
  forceTag?: string;
  /** 内嵌模式（问策 tab）：不渲染顾问身份头，底部为悬浮底栏留位 */
  embedded?: boolean;
  /** 当前顾问解析后回调（薄壳/宿主页可据此渲染标题等） */
  onAgentChange?: (agent: Agent | null) => void;
  /** 登录成功回调（宿主页可挂入帐引导等） */
  onLoggedIn?: (onboarded: boolean) => void;
  /** 入帐承接（仅问策 tab0）：未建档→入帐对话流；已建档→当日回帐一句 */
  onboarding?: boolean;
}

// 把结构化成果序列化为纯文本，复制到剪贴板（替代尚未实现的 PDF 导出）。
function deliverableToText(d: Deliverable): string {
  const lines: string[] = [d.title];
  if (d.meta) lines.push(d.meta);
  lines.push('');
  for (const sec of d.sections) {
    lines.push(`【${sec.h}】`);
    if (sec.b) lines.push(sec.b);
    if (sec.list) sec.list.forEach((x) => lines.push(`· ${x}`));
    lines.push('');
  }
  if (d.trust) lines.push(d.trust);
  return lines.join('\n').trim();
}
function copyDeliverable(d: Deliverable) {
  Taro.setClipboardData({
    data: deliverableToText(d),
    success: () => Taro.showToast({ title: '已复制全文', icon: 'success' }),
    fail: () => Taro.showToast({ title: '复制失败', icon: 'none' }),
  });
}

function copyText(text: string, title = '已复制') {
  const data = text.trim();
  if (!data) return;
  Taro.setClipboardData({
    data,
    success: () => Taro.showToast({ title, icon: 'success' }),
    fail: () => Taro.showToast({ title: '复制失败', icon: 'none' }),
  });
}

function replyToText(reply: ChatReplyT): string {
  return [reply.text, ...(reply.points ?? [])].filter(Boolean).join('\n\n');
}

function reportDraft(agent?: Agent | null, partial: Partial<Deliverable> = {}): Deliverable {
  return {
    title: partial.title || `${agent?.name || '军师'}正在出方案`,
    icon: partial.icon || agent?.icon || 'doc',
    meta: partial.meta || '正在梳理上下文与引用资料',
    sections: partial.sections || [],
    trust: partial.trust || '生成完成后会给出判断依据与下一步动作。',
    actions: partial.actions || ['save_to_library', 'export_pdf'],
    htmlUrl: partial.htmlUrl,
    cdnUrl: partial.cdnUrl,
    degraded: partial.degraded,
  };
}

function mergeReportSection(sections: Section[], section: Section & { index?: number }): Section[] {
  const next = sections.slice();
  const clean: Section = {
    h: section.h || `第 ${next.length + 1} 段`,
    b: section.b,
    list: Array.isArray(section.list) ? section.list : undefined,
  };
  if (typeof section.index === 'number' && section.index >= 0) next[section.index] = clean;
  else next.push(clean);
  return next.filter(Boolean);
}

type ChatStyle = CSSProperties & {
  '--keyboard-height'?: string;
};

const IS_WEAPP = process.env.TARO_ENV === 'weapp';
const UPLOAD_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'md', 'markdown', 'txt'];

// 生辰笺（widget: bazi-form）：行内小表单卡——历法切换 + 日期 Picker + 十二时辰笺阵 + 性别 + 出生城市 + 「不看这层」。
// 视觉走新设计语言（纸底细线、宋体），字段与提交格式对齐 components/Picker 的 saveBazi 入参。
function BaziForm({ accent, busy, onSubmit, onSkip }: { accent: string; busy: boolean; onSubmit: (b: BaziBody) => void; onSkip: () => void }) {
  const today = new Date();
  const [calendar, setCalendar] = useState<'solar' | 'lunar'>('solar');
  const [date, setDate] = useState('');
  const [hourIdx, setHourIdx] = useState(0);
  const [gender, setGender] = useState<'male' | 'female' | ''>('');
  const [place, setPlace] = useState('');
  const dateEnd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const submit = () => {
    if (busy) return;
    const [y, m, dd] = date.split('-').map((x) => parseInt(x, 10));
    if (!y || !m || !dd) { Taro.showToast({ title: '先选个生日，或点「不看这层」', icon: 'none' }); return; }
    if (!gender) { Taro.showToast({ title: '排盘需先选性别', icon: 'none' }); return; }
    onSubmit({ calendar, year: y, month: m, day: dd, hour: SHICHEN[hourIdx].hour, gender, birthPlace: place.trim() || undefined });
  };

  return (
    <View className="bazi-laze ink-in">
      <View className="bz-row">
        <Text className="bz-lb">历法</Text>
        <View className="bz-segs">
          {(['solar', 'lunar'] as const).map((cal) => (
            <Text key={cal} className={`laze-chip ${calendar === cal ? 'on' : ''}`} style={calendar === cal ? { background: accent, borderColor: accent } : {}} onClick={() => setCalendar(cal)}>{cal === 'solar' ? '阳历' : '阴历'}</Text>
          ))}
        </View>
      </View>
      <View className="bz-row">
        <Text className="bz-lb">生日</Text>
        <Picker mode="date" start="1930-01-01" end={dateEnd} value={date || '1990-06-18'} onChange={(e) => setDate(String(e.detail.value))}>
          <View className="bz-date-field">{date ? <Text className="bz-date-v">{date}</Text> : <Text className="bz-date-ph">选择出生日期</Text>}</View>
        </Picker>
      </View>
      <View className="bz-row col">
        <Text className="bz-lb">时辰</Text>
        <View className="bz-grid">
          {SHICHEN.map((t, i) => (
            <Text key={t.label} className={`laze-chip ${hourIdx === i ? 'on' : ''}`} style={hourIdx === i ? { background: accent, borderColor: accent } : {}} onClick={() => setHourIdx(i)}>{t.label}</Text>
          ))}
        </View>
      </View>
      <View className="bz-row">
        <Text className="bz-lb">性别</Text>
        <View className="bz-segs">
          {([['male', '男'], ['female', '女']] as const).map(([g, label]) => (
            <Text key={g} className={`laze-chip ${gender === g ? 'on' : ''}`} style={gender === g ? { background: accent, borderColor: accent } : {}} onClick={() => setGender(g)}>{label}</Text>
          ))}
        </View>
      </View>
      <View className="bz-row">
        <Text className="bz-lb">出生城市</Text>
        <Input className="bz-input" value={place} maxlength={20} placeholder="选填，用于真太阳时校正" onInput={(e) => setPlace(e.detail.value)} />
      </View>
      <View className="bz-acts">
        <Text className="laze-skip" onClick={() => !busy && onSkip()}>不看这层</Text>
        <View className="laze-submit" style={{ background: accent, opacity: busy ? 0.6 : 1 }} onClick={submit}>
          <Text>{busy ? '排盘中…' : '留下生辰'}</Text>
        </View>
      </View>
    </View>
  );
}

// 对话核心组件：消息流渲染 + SSE 流式 + 报告卡 + 引用选择器 + 上传 + 参谋室导轨 + 军师印象条 + 入帐对话流。
// 问策 tab（内嵌）与 chat 页（专业军师/历史会话）共用；props 驱动，行为与原 chat 页一比一。
export default function ChatView(props: ChatViewProps) {
  const { embedded = false, forceTag = '', onAgentChange, onLoggedIn } = props;
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [agent, setAgent] = useState<Agent | null>(null);
  const [sessionId, setSessionId] = useState<string>(props.sessionId || '');
  const [projectId, setProjectId] = useState<string>(props.projectId || '');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [inputFocus, setInputFocus] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [refs, setRefs] = useState<MessageRef[]>([]);
  const [showLogin, setShowLogin] = useState(() => !store.isAuthed());
  const [picker, setPicker] = useState(false);
  const [pick, setPick] = useState<{ projects: ProjectItem[]; reports: ReportItem[]; knowledge: KnowledgeItemT[]; memories: MemoryCandidate[] }>({ projects: [], reports: [], knowledge: [], memories: [] });
  // 入帐对话流状态：obActive 期间隐藏印象条/导轨，选择笺/生辰笺/择色笺只在当前问句可点。
  const [obActive, setObActive] = useState(false);
  const [obStage, setObStage] = useState<OnboardingStage | ''>('');
  const [obBusy, setObBusy] = useState(false);
  // 请缨帖已答态（按 prompt 去重，避免流式替换后丢失）
  const [proposalDone, setProposalDone] = useState<Record<string, true>>({});
  const logRef = useRef<Msg[]>([]);
  logRef.current = msgs;
  const obBusyRef = useRef(false);
  obBusyRef.current = obBusy;
  // 本次会话已取到的「回帐一句」缓存：initChat 因登录重挂载而重放历史时，据此重新 append，不被覆盖吞掉。
  const openingRef = useRef<{ text: string; chips?: string[] } | null>(null);

  useEffect(() => { onAgentChange?.(agent); }, [agent]);

  const findAgent = (key: string): Agent | undefined => s.agents().find((a) => a.key === key);

  const scrollToEnd = () => setScrollTop((t) => t + 100000);

  useEffect(() => {
    if (busy) setTimeout(scrollToEnd, 40);
  }, [busy]);

  useEffect(() => () => store.setOverlay(false, 'ref-picker'), []);

  const isUnauthorized = (e: unknown) =>
    (e as any)?.code === 'UNAUTHORIZED' || String((e as any)?.message || '').includes('未登录');

  const errorReply = (e: unknown): string => {
    if (isUnauthorized(e)) return '登录态已失效，请重新登录后再发送。';
    if ((e as any)?.data?.code === 'AGENT_LOCKED') return '该专项军师尚未启用，请到「点将堂」启用后再议。';
    if ((e as any)?.data?.code === 'INSUFFICIENT_QUOTA') return '本月 token 额度已用尽，请在「主公」升级套餐或下月再用。';
    if ((e as any)?.data?.code === 'INSUFFICIENT_CREDITS') return '钻石不足，请在「主公」充值或解锁后再继续。';
    const msg = String((e as any)?.message || '');
    if (msg && msg !== 'undefined') return msg;
    return '抱歉，产出失败了，请稍后再试。';
  };

  // 审核类错误（输入/输出未通过内容审核）：重试同样内容必再次被拦，故不提供「重试」，也避免叠出重复气泡。
  const isModerationErr = (msg?: string) => !!msg && /审核/.test(msg);

  const wantsDeliverableRequest = (text: string) =>
    /(生成|输出|整理|做一份|出一份|给我一份|形成).{0,8}(方案|报告|成果|卡片|纪要|计划|军令|文案|脚本|海报)|(?:重新)?出.{0,4}(方案|报告|成果|卡片|纪要|计划|军令|文案|脚本|海报)|战略体检|转成军令|生成纪要/.test(text);

  const promptLogin = (title = '请先登录后再开始对话') => {
    setShowLogin(true);
    Taro.showToast({ title, icon: 'none' });
  };

  async function primeGuestThread() {
    let agents = s.agents(); // 已含离线兜底，基本不为空
    if (!agents.length) {
      await s.loadAgents();
      agents = s.agents();
    }
    if (props.projectId) setProjectId(props.projectId);
    const key = props.agentKey || (props.prefillSend ? agentForText(props.prefillSend) : 'general');
    const fallbackAgent = agents.find((a) => a.key === key) || agents.find((a) => a.key === 'general') || agents[0];
    if (fallbackAgent) {
      setAgent(fallbackAgent);
      setMsgs([{ role: 'greet', agent: fallbackAgent }]);
    }
    return fallbackAgent;
  }

  // —— 入帐对话流（WO-A2）——
  // 逐条墨染浮现：军师消息约 400ms 间隔一条推入。
  async function revealOnboarding(list: OnboardingMsg[]) {
    for (let i = 0; i < list.length; i++) {
      await sleep(i === 0 ? 220 : 400);
      const o = list[i];
      setMsgs((m) => [...m, { role: 'assistant', reply: { text: o.text }, choices: o.choices, widget: o.widget }]);
      setTimeout(scrollToEnd, 30);
    }
  }

  function enterOnboarding(stage: OnboardingStage, list: OnboardingMsg[], ag: Agent) {
    setAgent(ag);
    setMsgs([]);
    setObActive(true);
    setObStage(stage);
    revealOnboarding(list);
  }

  // 推进状态机：先回显用户所选/所填，再落下一问；到 FORGE 起轮询。
  async function advanceOnboarding(body: OnboardingAdvanceBody, echoText?: string) {
    if (obBusyRef.current) return;
    setObBusy(true);
    if (echoText) { setMsgs((m) => [...m, { role: 'user', text: echoText }]); setTimeout(scrollToEnd, 30); }
    try {
      const res = await api.onboardingAdvance(body);
      setObStage(res.stage);
      await revealOnboarding(res.messages);
      if (res.stage === 'FORGE') pollForge();
    } catch (e) {
      if (isUnauthorized(e)) promptLogin('登录态已失效，请重新登录');
      else Taro.showToast({ title: errorReply(e), icon: 'none' });
    } finally {
      setObBusy(false);
    }
  }

  // FORGE 后轮询《初见断语》生成结果（2s 间隔，上限 90s）。
  function pollForge() {
    let tries = 0;
    const tick = async () => {
      tries += 1;
      try {
        const r = await api.onboardingResult();
        if (r.ready) { await finishOnboarding(); return; }
      } catch { /* 瞬态失败继续轮询 */ }
      if (tries * 2 < 90) setTimeout(tick, 2000);
      else Taro.showToast({ title: '断语生成较慢，稍后可在锦囊查看', icon: 'none' });
    };
    setTimeout(tick, 1500);
  }

  // ready：收束入帐，刷新会话让《初见断语》报告卡 + DONE 收束句出现，并亮锦囊朱砂点。
  async function finishOnboarding() {
    setObActive(false);
    setObStage('DONE');
    store.completeOnboarding();
    await store.loadMe().catch(() => {});
    store.setSatchelDot(true);
    try {
      const list = await api.sessions();
      const gen = list.find((x) => x.agentKey === 'general');
      const ag = s.agents().find((a) => a.key === 'general') || agent;
      if (gen && ag) {
        const detail = await api.session(gen.id);
        setAgent(ag);
        setSessionId(gen.id);
        restore(ag, detail.messages);
      }
    } catch { /* 刷新失败不阻断：DONE 文案已在对话里 */ }
    onLoggedIn?.(true);
  }

  // 回帐一句（老用户当日首开）：把 opening.text 作为一条本地军师消息 + chips 选择笺（不落库）。
  // opening 是本地不落库消息：initChat() 若因登录重挂载（Login.onLoggedIn → initChat()）再次
  // 拉服务端历史，initNormalThread() 会整体替换 msgs 把这条本地消息覆盖掉。用 openingRef 缓存
  // 本次会话已取到的 opening，每次 initChat 完成路径都重放一次未消费的 opening，保证不会被吞；
  // 当日节流 flag 只在 opening 真正 append 进消息列表之后才写入，避免「已标记完成但用户其实没看到」。
  function maybeGreetReturning() {
    if (!store.isOnboarded()) return;
    const day = new Date().toISOString().slice(0, 10);
    const key = `junshi.opening.${getUserId()}.${day}`;
    const applyOpening = (op: { text: string; chips?: string[] }) => {
      setMsgs((m) => [...m, { role: 'assistant', reply: { text: op.text }, choices: (op.chips || []).map((c) => ({ label: c, value: c })) }]);
      setTimeout(scrollToEnd, 40);
      safeStorageSet(key, '1');
    };
    // 本次会话已经取到过 opening（可能是被后续 initChat 重挂载覆盖掉了消息列表）→ 直接重放，不再打网络请求。
    if (openingRef.current) { applyOpening(openingRef.current); return; }
    if (safeStorageGet(key)) return; // 今日已在更早的挂载里成功展示过，不再重试
    api.counselOpening().then((op) => {
      if (!op?.text) { safeStorageSet(key, '1'); return; } // 无话可说：当日不再重试
      openingRef.current = { text: op.text, chips: op.chips };
      applyOpening(openingRef.current);
    }).catch(() => {});
  }

  // 初始化：根据 props 还原会话 / 打开顾问线程 / 新会话（含入帐 / 回帐承接）
  async function initChat() {
    let agents = s.agents(); // 已含离线兜底，基本不为空
    if (!agents.length) {
      await s.loadAgents();
      agents = s.agents();
    }
    const { agentKey, prefillSend: send, projectId: pid } = props;
    if (pid) setProjectId(pid);
    const key = agentKey || (send ? agentForText(send) : 'general');
    const fallbackAgent = agents.find((a) => a.key === key) || agents.find((a) => a.key === 'general') || agents[0];

    if (!store.isAuthed()) {
      if (fallbackAgent) {
        setAgent(fallbackAgent);
        setMsgs([{ role: 'greet', agent: fallbackAgent }]);
      } else {
        await primeGuestThread();
      }
      promptLogin();
      return;
    }

    // 入帐承接（仅问策 tab）：未建档 → 入帐对话流并接管本页；已建档 → 走普通线程后补一句回帐。
    if (props.onboarding && fallbackAgent) {
      try {
        const st = await api.onboardingState();
        if (st.stage !== 'DONE') { enterOnboarding(st.stage, st.messages, fallbackAgent); return; }
        if (!store.isOnboarded()) store.completeOnboarding();
      } catch (e) {
        if (isUnauthorized(e)) { promptLogin('登录态已失效，请重新登录'); return; }
        // 状态接口失败：退回普通线程，不阻断使用
      }
    }

    await initNormalThread(agents, fallbackAgent);
    if (props.onboarding) maybeGreetReturning();
  }

  // 普通对话线程还原（会话回放 / 续接最近 / 新会话问候），与入帐/回帐解耦。
  async function initNormalThread(agents: Agent[], fallbackAgent: Agent) {
    const { sessionId: sid, prefillSend: send, fresh, projectId: pid } = props;
    try {
      if (sid) {
        const detail = await api.session(sid);
        const ag = agents.find((a) => a.key === detail.agentKey) || (detail.agent as any) || fallbackAgent;
        setAgent(ag);
        setSessionId(sid);
        if (detail.projectId) setProjectId(detail.projectId);
        restore(ag, detail.messages);
        return;
      }

      setAgent(fallbackAgent);

      // continue：找该顾问最近会话续聊；fresh/new：开新
      if (!fresh) {
        const list = await api.sessions().catch((e) => {
          if (isUnauthorized(e)) throw e;
          return [];
        });
        const latest = list.find((x) => x.agentKey === fallbackAgent.key);
        if (latest) {
          const detail = await api.session(latest.id);
          setSessionId(latest.id);
          if (detail.projectId) setProjectId(detail.projectId);
          restore(fallbackAgent, detail.messages);
          if (send) setTimeout(() => doSend(send, latest.id, fallbackAgent.key, [], true, detail.projectId || pid || ''), 300);
          return;
        }
      }
      // 全新会话：仅渲染问候（不落库），首条消息时后端创建
      setMsgs([{ role: 'greet', agent: fallbackAgent }]);
      if (send) setTimeout(() => doSend(send, '', fallbackAgent.key, [], true, pid || ''), 350);
    } catch (e) {
      if (isUnauthorized(e)) promptLogin('登录态已失效，请重新登录');
      // 任何拉取失败都不让对话页空白：至少给出问候
      if (fallbackAgent) {
        setAgent(fallbackAgent);
        setMsgs([{ role: 'greet', agent: fallbackAgent }]);
      }
    }
  }

  useEffect(() => {
    initChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function restore(ag: Agent, messages: { id: string; role: string; content: any; refs?: MessageRef[] }[]) {
    const out: Msg[] = [{ role: 'greet', agent: ag }];
    messages.forEach((m) => {
      const c = m.content || {};
      if (m.role === 'user') out.push({ role: 'user', text: c.text, refs: m.refs });
      else if (m.role === 'report') out.push({ role: 'report', deliverable: m.content, animate: false, saved: false, messageId: m.id });
      else {
        // 入帐历史消息（带 onbStage）作纯手书回放，不再渲染可点选择笺/生辰笺；请缨帖始终回放。
        const isOnb = !!c.onbStage;
        out.push({ role: 'assistant', reply: c, proposal: c.proposal, choices: isOnb ? undefined : c.choices, widget: isOnb ? undefined : c.widget });
      }
    });
    setMsgs(out);
    setTimeout(scrollToEnd, 60);
  }

  // 选择笺点选：__free__ 聚焦输入框；入帐期走 advance；普通对话直接发送。
  function onChoice(choice: Choice) {
    if (busy || obBusy) return;
    if (choice.value === '__free__') { setInputFocus(true); return; }
    if (obActive) {
      if (choice.value === '__skip__') advanceOnboarding({ skip: true }, '（这层先不看）');
      else advanceOnboarding({ answer: choice.label }, choice.label);
    } else if (agent) {
      doSend(choice.label, sessionId, agent.key);
    }
  }

  // 生辰笺提交 / 跳过（入帐 ASK_BAZI）
  const onBaziSubmit = (b: BaziBody) => advanceOnboarding({ bazi: b }, '（已留生辰）');
  const onBaziSkip = () => advanceOnboarding({ skip: true }, '（这层先不看）');

  // 择色笺点选：即时全局换主题预览 + 持久化，随后 advance。
  function onColorPick(colorKey: string) {
    if (obBusy) return;
    store.setColor(colorKey, true);
    const short = COLORS.find((c) => c.key === colorKey)?.short || colorKey;
    advanceOnboarding({ color: colorKey }, `帅旗定为${short}`);
  }

  // 请缨帖点选（§4.2）：即刻出策发 prompt / 再答两问发 declinePrompt；点后该帖变为已答态。
  function onProposalPick(p: Proposal, accept: boolean) {
    if (busy || proposalDone[p.prompt]) return;
    setProposalDone((s2) => ({ ...s2, [p.prompt]: true }));
    if (agent) doSend(accept ? p.prompt : p.declinePrompt, sessionId, agent.key);
  }

  async function doSend(text: string, sid: string, agentKey: string, sendRefs: MessageRef[] = [], echo = true, activeProjectId = projectId) {
    if (busy) return;
    if (!store.isAuthed()) {
      promptLogin();
      setMsgs((m) => [...m, { role: 'assistant', reply: { text: '请先登录后再继续对话。' } }]);
      setTimeout(scrollToEnd, 30);
      return;
    }
    // 过期只读锁定（D4）：到期后前端即拦 AI 交互，提示续费（后端 PLAN_EXPIRED 403 为兜底硬保证）。
    if (s.me()?.planStatus?.expired) {
      Taro.showToast({ title: '套餐已到期，续费后可继续对话', icon: 'none' });
      return;
    }
    setBusy(true);
    // P2-15：重试（echo=false）不重复回显用户气泡（用户消息已在首次尝试时显示）。
    if (echo) setMsgs((m) => [...m, { role: 'user', text, refs: sendRefs.length ? sendRefs : undefined }]);
    setTimeout(scrollToEnd, 30);
    try {
      // P1-B3：普通聊天默认真流式；总军师 on-demand 仅在明确要成果/报告时回同步成果路径。
      // 路由带 send= 自动发送时，React state 里的 agent 可能还没刷新；必须按本次 agentKey 重新取配置。
      const sendingAgent = findAgent(agentKey) || agent;
      const deliverableRequested = wantsDeliverableRequest(text);
      const body = { text, sessionId: sid || undefined, agentKey, projectId: activeProjectId || undefined, refs: sendRefs.length ? sendRefs : undefined };
      const canStreamChat = STREAM_CHAT && !!sendingAgent && (!sendingAgent.deliverableKey || (sendingAgent.key === 'general' && !deliverableRequested));
      const canStreamReport = STREAM_CHAT && !!sendingAgent && (!!sendingAgent.deliverableKey || deliverableRequested) && (sendingAgent.key !== 'general' || deliverableRequested);

      const showMemoryLearned = (agentName: string, delay: number) => {
        setTimeout(() => {
          setMsgs((m) => [...m, { role: 'memory', agentName }]);
          scrollToEnd();
        }, delay);
      };
      const renderGenerateResult = (res: Awaited<ReturnType<typeof api.generate>>, replaceStreamingAssistant = false) => {
        if (res.sessionId && !sid) setSessionId(res.sessionId);
        if (res.kind === 'report' && res.deliverable) {
          const reportMsg: Extract<Msg, { role: 'report' }> = {
            role: 'report',
            deliverable: res.deliverable,
            animate: true,
            messageId: res.messageId,
            knowledgeUsed: res.knowledgeUsed,
          };
          setMsgs((m) => {
            if (replaceStreamingAssistant) {
              const i = m.length - 1;
              if (i >= 0 && m[i].role === 'assistant' && (m[i] as { streaming?: boolean }).streaming) {
                const copy = m.slice();
                copy[i] = reportMsg;
                return copy;
              }
            }
            return [...m, reportMsg];
          });
          store.setSatchelDot(true); // 报告落库 → 亮锦囊朱砂点
          if (res.memory?.learned) showMemoryLearned(res.memory.agentName, data_delay(res.deliverable));
        } else if (res.reply) {
          setMsgs((m) => {
            if (replaceStreamingAssistant) {
              const i = m.length - 1;
              if (i >= 0 && m[i].role === 'assistant' && (m[i] as { streaming?: boolean }).streaming) {
                const copy = m.slice();
                copy[i] = { role: 'assistant', reply: res.reply!, knowledgeUsed: res.knowledgeUsed };
                return copy;
              }
            }
            return [...m, { role: 'assistant', reply: res.reply!, knowledgeUsed: res.knowledgeUsed }];
          });
        }
      };

      if (canStreamChat) {
        const patch = (fn: (msg: Extract<Msg, { role: 'assistant' }>) => Extract<Msg, { role: 'assistant' }>) =>
          setMsgs((m) => {
            const i = m.length - 1;
            if (i >= 0 && m[i].role === 'assistant' && (m[i] as { streaming?: boolean }).streaming) {
              const copy = m.slice(); copy[i] = fn(copy[i] as Extract<Msg, { role: 'assistant' }>); return copy;
            }
            return m;
        });
        setMsgs((m) => [...m, { role: 'assistant', reply: { text: '' }, streaming: true }]);
        const streamOk = await generateStream(
          body,
          {
            onSession: (id) => { if (id && !sid) setSessionId(id); },
            onToken: (t) => patch((msg) => ({ ...msg, reply: { ...msg.reply, text: (msg.reply.text || '') + t } })),
            onChat: (reply) => patch((msg) => ({ ...msg, reply })), // 完整回复权威兜底：token 渲染即便有偏差，最终内容仍正确
            onPropose: (p) => patch((msg) => ({ ...msg, proposal: p })), // 出策请缨：把请缨帖挂到本条军师消息下
            onDone: () => patch((msg) => ({ ...msg, streaming: false })),
            onError: (em) => patch((msg) => ({ ...msg, reply: { text: em || '生成失败' }, retryText: isModerationErr(em) ? undefined : text, streaming: false })),
          },
        );
        if (!streamOk) {
          const res = await api.generate(body);
          renderGenerateResult(res, true);
        }
        setTimeout(scrollToEnd, 80);
      } else if (canStreamReport) {
        let reportStarted = false;
        let chatStarted = false;
        let learnedAgentName = '';
        const patchReport = (
          fn: (d: Deliverable) => Deliverable,
          extra: Partial<Extract<Msg, { role: 'report' }>> = {},
        ) => {
          setMsgs((m) => {
            const i = m.length - 1;
            if (i >= 0 && m[i].role === 'report' && (m[i] as { streaming?: boolean }).streaming) {
              const copy = m.slice();
              const cur = copy[i] as Extract<Msg, { role: 'report' }>;
              copy[i] = { ...cur, ...extra, deliverable: fn(cur.deliverable) };
              return copy;
            }
            return [...m, { role: 'report', deliverable: fn(reportDraft(sendingAgent)), animate: false, streaming: true, ...extra }];
          });
        };
        const startReport = () => {
          if (reportStarted) return;
          reportStarted = true;
          patchReport((d) => d);
          setTimeout(scrollToEnd, 30);
        };
        // 兜底：部分请求（如问局势判断而非明确要报告）后端会按普通聊天回，
        // 而非 report 分段事件；此时不能沿用报告卡骨架（会永久卡在「产出中」），改走普通气泡渲染。
        const patchChat = (fn: (msg: Extract<Msg, { role: 'assistant' }>) => Extract<Msg, { role: 'assistant' }>) =>
          setMsgs((m) => {
            const i = m.length - 1;
            if (i >= 0 && m[i].role === 'assistant' && (m[i] as { streaming?: boolean }).streaming) {
              const copy = m.slice(); copy[i] = fn(copy[i] as Extract<Msg, { role: 'assistant' }>); return copy;
            }
            return m;
          });
        const startChat = () => {
          if (reportStarted || chatStarted) return;
          chatStarted = true;
          setMsgs((m) => [...m, { role: 'assistant', reply: { text: '' }, streaming: true }]);
          setTimeout(scrollToEnd, 30);
        };
        const streamOk = await generateStream(body, {
          onSession: (id) => { if (id && !sid) setSessionId(id); },
          onReportStart: startReport,
          onReportBegin: (data) => {
            startReport();
            patchReport((d) => ({
              ...d,
              title: data.title || d.title,
              icon: data.icon || d.icon,
              meta: data.meta || d.meta,
            }));
          },
          onReportSection: (section) => {
            startReport();
            patchReport((d) => ({ ...d, sections: mergeReportSection(d.sections, section) }));
            setTimeout(scrollToEnd, 40);
          },
          onReportFooter: (data) => {
            startReport();
            patchReport((d) => ({
              ...d,
              trust: data.trust || d.trust,
              actions: data.actions?.length ? data.actions : d.actions,
            }));
          },
          onToken: (t) => {
            if (reportStarted) return;
            startChat();
            patchChat((msg) => ({ ...msg, reply: { ...msg.reply, text: (msg.reply.text || '') + t } }));
          },
          onChat: (reply) => {
            if (reportStarted) return;
            startChat();
            patchChat((msg) => ({ ...msg, reply }));
          },
          onMemory: (data) => {
            if (data.learned && data.agentName) learnedAgentName = data.agentName;
          },
          onPropose: (p) => {
            if (reportStarted) patchReport((d) => d, { proposal: p });
            else { startChat(); patchChat((msg) => ({ ...msg, proposal: p })); }
          },
          onDone: (messageId) => {
            if (reportStarted) {
              patchReport((d) => d, { streaming: false, messageId });
              store.setSatchelDot(true); // 报告落库 → 亮锦囊朱砂点
            } else if (chatStarted) {
              patchChat((msg) => ({ ...msg, streaming: false }));
            }
            if (learnedAgentName) showMemoryLearned(learnedAgentName, 600);
            setTimeout(scrollToEnd, 80);
          },
          onError: (em) => {
            if (reportStarted) {
              patchReport((d) => ({ ...d, trust: em || '生成中断，请重试', degraded: true }), { streaming: false });
            } else if (chatStarted) {
              patchChat((msg) => ({ ...msg, reply: { text: em || '生成失败' }, retryText: isModerationErr(em) ? undefined : text, streaming: false }));
            }
          },
        });
        if (!streamOk && !reportStarted && !chatStarted) {
          const res = await api.generate(body);
          renderGenerateResult(res);
        }
        setTimeout(scrollToEnd, 80);
      } else {
        const res = await api.generate(body);
        renderGenerateResult(res);
        setTimeout(scrollToEnd, 80);
      }
    } catch (e) {
      if (isUnauthorized(e)) promptLogin('登录态已失效，请重新登录');
      const reply = errorReply(e);
      // P2-15：保留原文供重试；但审核类错误不给重试（重试必再被拦）。
      setMsgs((m) => [...m, { role: 'assistant', reply: { text: reply }, retryText: isModerationErr(reply) ? undefined : text }]);
    } finally {
      setBusy(false);
    }
  }

  const handleInput = (e: { detail: { value: string } }) => {
    if (busy) return input;
    const v = e.detail.value;
    setInput(v);
    return v;
  };

  const onSend = (raw?: string) => {
    if (busy) return;
    const v = (typeof raw === 'string' ? raw : input).trim();
    if (!v || !agent) return;
    // 入帐期用户直接打字：把文本作为 answer 提交 advance（免打字原则的兜底，不走 /generate）。
    if (obActive) {
      if (obBusy) return;
      setInput('');
      setInputFocus(false);
      if (obStage === 'ASK_BAZI') { advanceOnboarding({ answer: v }, v); return; }
      if (obStage === 'ASK_COLOR') { Taro.showToast({ title: '请在下方择一色作帅旗', icon: 'none' }); return; }
      advanceOnboarding({ answer: v }, v);
      return;
    }
    setInput('');
    setInputFocus(false);
    const sending = refs;
    setRefs([]);
    doSend(v, sessionId, agent.key, sending);
  };

  const onKeyboardHeightChange = (e: { detail?: { height?: number } }) => {
    const next = Math.max(0, Number(e.detail?.height || 0));
    setKeyboardHeight(next);
    if (next > 0) setTimeout(scrollToEnd, 40);
  };

  const saveDeliverable = async (d: Deliverable) => {
    if (!agent) return;
    await api.saveToLibrary({
      // 三势研判入口进来的，type 打成「{势}研判」（如 市势研判），战局卡按 type 可靠反查
      title: d.title, type: forceTag ? `${forceTag}研判` : (agent.deliverableKey || d.title), agentKey: agent.key,
      sessionId: sessionId || undefined, content: d as any, projectId: projectId || undefined,
    }).catch(() => {});
    Taro.showToast({ title: '已存入锦囊', icon: 'none' });
  };

  // 认可方案：存入锦囊（桥接一版报告）+ 服务端生成案卷军令 → 去执行页承接打卡与回填
  const acceptPlan = async (d: Deliverable) => {
    const r = await acceptDeliverable(d, agent?.name || '军师', forceTag || undefined).catch(() => null);
    if (!r) { Taro.showToast({ title: '案卷生成失败，请重试', icon: 'none' }); return; }
    if (!r.newOrders && r.skippedOrders) {
      Taro.showToast({ title: '这份方案已转成军令，不重复添加', icon: 'none' });
      return;
    }
    await saveDeliverable(d);
    Taro.showToast({ title: r.newOrders ? `已生成案卷 · ${r.newOrders} 条军令待执行` : '已生成案卷', icon: 'none' });
    // studio 已从 tab 摘出，改为 navigateTo 承接执行
    setTimeout(() => Taro.navigateTo({ url: '/pages/studio/index' }), 620);
  };

  // 转成军令：把本轮最新的结构化成果转为今日军令（无成果则引导先产出）
  const turnIntoOrders = () => {
    const lastReport = [...logRef.current].reverse().find((m) => m.role === 'report') as Extract<Msg, { role: 'report' }> | undefined;
    if (!lastReport) {
      Taro.showToast({ title: '先让军师产出一份方案，认可后即可转成军令', icon: 'none' });
      return;
    }
    acceptPlan(lastReport.deliverable);
  };

  // 切换军师线程（派单 / 回总军师）：redirectTo 保持页面栈扁平，带 prompt 时直接开场
  const openThread = (agentKey: string, prompt?: string) => {
    const url = `/pages/chat/index?agentKey=${agentKey}&fresh=1${prompt ? `&send=${encodeURIComponent(prompt)}` : ''}`;
    Taro.redirectTo({ url });
  };
  const openGuide = (url: string) => Taro.navigateTo({ url });

  // 生成网页版报告（render_report → 自有域名 /api/r/:id，接口幂等）→ 直接打开：weapp 走内置 web-view 页，H5 开新窗口。
  const shareReport = async (messageId?: string) => {
    if (!sessionId || !messageId) { Taro.showToast({ title: '请先产出方案', icon: 'none' }); return; }
    Taro.showLoading({ title: '生成网页版…' });
    try {
      await requestWechatSubscribe('report').catch(() => {});
      const r = await api.renderReport(sessionId, messageId);
      Taro.hideLoading();
      if (!r.htmlUrl) { Taro.showToast({ title: '本地预览模式无网页版', icon: 'none' }); return; }
      if (IS_WEAPP) {
        Taro.navigateTo({
          url: `/packages/work/webview/index?url=${encodeURIComponent(r.htmlUrl)}`,
          fail: () => Taro.showToast({ title: '网页打开失败，请稍后重试', icon: 'none' }),
        });
      } else if (typeof window !== 'undefined' && window.open) {
        window.open(r.htmlUrl, '_blank');
      } else {
        Taro.setClipboardData({ data: r.htmlUrl, success: () => Taro.showToast({ title: '网页版链接已复制', icon: 'none' }) });
      }
    } catch {
      Taro.hideLoading();
      Taro.showToast({ title: '生成失败，请重试', icon: 'none' });
    }
  };

  // 生成对话纪要 → 版本化报告 + 沉淀知识库
  const onSummarize = async () => {
    if (!sessionId) { Taro.showToast({ title: '先开始对话再生成纪要', icon: 'none' }); return; }
    Taro.showLoading({ title: '正在生成纪要…' });
    try {
      const r = await api.summarize(sessionId);
      Taro.hideLoading();
      Taro.showToast({ title: `已生成《${r.title}》v${r.version}`, icon: 'none' });
      setTimeout(() => Taro.navigateTo({ url: `/packages/work/report/index?id=${r.reportId}` }), 700);
    } catch {
      Taro.hideLoading();
      Taro.showToast({ title: '生成纪要失败', icon: 'none' });
    }
  };

  // 点加号：上传资料（真实走微信文件选择 + OSS）或引用已有资料
  const onPlus = () => {
    if (busy) return;
    setInputFocus(false);
    if (!store.isAuthed()) {
      setShowLogin(true);
      Taro.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    Taro.showActionSheet({
      itemList: ['上传资料（PDF/Word/Excel…）', '引用已有案卷 / 方案 / 资料'],
      success: (r) => {
        if (r.tapIndex === 0) uploadMaterial();
        else if (r.tapIndex === 1) openPicker();
      },
    });
  };

  // 上传资料：微信只能选「聊天里的文件」→ 上传解析 → 自动挂为本轮引用
  const uploadMaterial = async () => {
    if (!IS_WEAPP) { Taro.showToast({ title: '请在微信小程序内上传文件', icon: 'none' }); return; }
    const guide = await Taro.showModal({
      title: '从微信聊天选择文件',
      content: '微信只允许小程序选取「聊天里的文件」。请先把资料发给「文件传输助手」（电脑端微信也能发），下一步选它即可。这不是转发，是选文件。',
      confirmText: '去选择',
      cancelText: '取消',
    });
    if (!guide.confirm) return;
    let chosen: Taro.chooseMessageFile.SuccessCallbackResult;
    try {
      chosen = await Taro.chooseMessageFile({ count: 1, type: 'file', extension: UPLOAD_EXT });
    } catch (e) {
      const msg = String((e as { errMsg?: string })?.errMsg || '');
      if (!/cancel/i.test(msg)) Taro.showToast({ title: '没能打开文件选择，请重试', icon: 'none' });
      return; // 用户取消则静默
    }
    const f = chosen.tempFiles?.[0];
    if (!f) return;
    const ext = (f.name?.split('.').pop() || '').toLowerCase();
    if (!UPLOAD_EXT.includes(ext)) {
      Taro.showToast({ title: `不支持的格式 .${ext}（支持 PDF/Word/Excel/MD/TXT）`, icon: 'none' });
      return;
    }
    Taro.showLoading({ title: '上传中…' });
    try {
      const { id } = await api.uploadKnowledge(f.path, projectId || undefined);
      Taro.hideLoading();
      const label = f.name || '上传资料';
      setRefs((cur) => cur.some((x) => x.kind === 'knowledge' && x.id === id) ? cur : [...cur, { kind: 'knowledge', id, label }]);
      Taro.showToast({ title: '已上传，解析中…可直接发送提问', icon: 'none' });
    } catch (e) {
      Taro.hideLoading();
      Taro.showToast({ title: (e as Error).message || '上传失败', icon: 'none' });
    }
  };

  // 打开 @引用选择器：拉取可引用的 案卷/方案/资料
  const openPicker = async () => {
    setInputFocus(false);
    if (!store.isAuthed()) {
      setShowLogin(true);
      Taro.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    setPicker(true);
    store.setOverlay(true, 'ref-picker');
    const [projects, reports, knowledge, memories] = await Promise.all([
      api.projects().catch(() => []),
      api.reports(projectId || undefined).catch(() => []),
      api.knowledge(projectId || undefined).catch(() => []),
      api.memories(agent?.key || undefined).catch(() => []),
    ]);
    setPick({ projects, reports, knowledge, memories });
  };
  const closePicker = () => { setPicker(false); store.setOverlay(false, 'ref-picker'); };
  const toggleRef = (r: MessageRef) => {
    setRefs((cur) => cur.some((x) => x.kind === r.kind && x.id === r.id) ? cur.filter((x) => !(x.kind === r.kind && x.id === r.id)) : [...cur, r]);
  };
  const hasRef = (kind: string, id: string) => refs.some((x) => x.kind === kind && x.id === id);
  const renderGroup = (title: string, items: { kind: MessageRef['kind']; id: string; label: string; sub?: string; version?: number }[]) => {
    if (!items.length) return null;
    return (
      <View className="ref-group">
        <Text className="ref-gt">{title}</Text>
        {items.map((it) => {
          const on = hasRef(it.kind, it.id);
          return (
            <View key={it.kind + it.id} className={`ref-item ${on ? 'on' : ''}`} style={on ? { borderColor: accent } : {}} onClick={() => toggleRef({ kind: it.kind, id: it.id, label: it.label, version: it.version })}>
              <View className="ref-ib"><Text className="ref-il">{it.label}</Text>{it.sub ? <Text className="ref-is">{it.sub}</Text> : null}</View>
              <View className="ref-ck" style={on ? { background: accent, borderColor: accent } : {}}>{on ? <Icon name="check" size={12} color="#fff" /> : null}</View>
            </View>
          );
        })}
      </View>
    );
  };

  const goBack = () => {
    if (Taro.getCurrentPages().length > 1) Taro.navigateBack();
    else Taro.switchTab({ url: '/pages/counsel/index' });
  };

  // 内嵌（问策 tab）：键盘收起时给悬浮底栏留位；键盘弹起时让位给键盘。
  const rootPad = embedded
    ? (keyboardHeight > 0 ? `${keyboardHeight}px` : 'calc(90px + env(safe-area-inset-bottom))')
    : `${keyboardHeight}px`;

  // 手书体：军师小像 + 「军师」签只在一段军师话的开头出现（首条 / 前一条是用户消息）。
  const showSign = (i: number) => i === 0 || msgs[i - 1]?.role === 'user';

  // 选择笺（choices）：纸底细线描边 chips；入帐历史问句的笺不再可点。
  const renderChoices = (choices: Choice[] | undefined, i: number) => {
    if (!choices?.length) return null;
    if (obActive && i !== msgs.length - 1) return null;
    return (
      <View className="choice-laze">
        {choices.map((c) => (
          <View key={c.value + c.label} className="laze" onClick={() => onChoice(c)}><Text>{c.label}</Text></View>
        ))}
      </View>
    );
  };

  // 请缨帖（proposal）：居中窄卡 · 题眉「请缨」+ 帖文 + 两枚选择笺 + 收尾小印；点过任一笺后变已答态。
  const renderProposal = (p?: Proposal) => {
    if (!p?.prompt) return null;
    const done = !!proposalDone[p.prompt];
    const fen = Math.max(1, Math.min(9, Math.round((p.readiness || 0) * 10)));
    const body = `这几轮问答下来，火候到了${fen}分。我可即刻为你立一道《${p.title || '成果'}》；或再答我两问，凑到十分再出。`;
    return (
      <View className={`proposal ink-in ${done ? 'answered' : ''}`}>
        <Text className="t-kicker prop-kicker">请　缨</Text>
        <Text className="prop-body">{body}</Text>
        <View className="prop-acts">
          <View className="laze prop-laze" onClick={() => onProposalPick(p, true)}><Text>即刻出策</Text></View>
          <View className="laze prop-laze ghost" onClick={() => onProposalPick(p, false)}><Text>再答两问</Text></View>
        </View>
        <View className="seal-dot prop-seal" />
      </View>
    );
  };

  // 生辰笺 / 择色笺（widget）：仅入帐当前问句可交互。
  const renderWidget = (widget: string | undefined, i: number) => {
    if (!widget || !obActive || i !== msgs.length - 1) return null;
    if (widget === 'bazi-form') return <BaziForm accent={accent} busy={obBusy} onSubmit={onBaziSubmit} onSkip={onBaziSkip} />;
    if (widget === 'color-pick') {
      return (
        <View className="color-laze ink-in">
          {COLORS.map((c) => (
            <View key={c.key} className="color-seal" onClick={() => onColorPick(c.key)}>
              <View className="cs-disc" style={{ background: c.vars['--accent'] }}><Text className="serif">{c.seal}</Text></View>
              <Text className="cs-cn">{c.short}</Text>
            </View>
          ))}
        </View>
      );
    }
    return null;
  };

  return (
    <View className={`chatview ${embedded ? 'embedded' : ''}`} style={{ '--keyboard-height': `${keyboardHeight}px`, paddingBottom: rootPad } as ChatStyle}>
      {/* 顾问身份头（内嵌模式由宿主页提供页头，这里不渲染） */}
      {!embedded && (
        <SafeHeader
          className="chat-head"
          rightReserve={false}
          left={<View className="safe-hbtn" onClick={goBack}><Icon name="chevron" size={19} color="#565C63" /></View>}
        >
          <View className="chat-id">
            <AdvisorAvatar agentKey={agent?.key ?? 'general'} size={34} online />
            <View className="chat-id-copy">
              <View className="chat-id-name">
                <Text className="cn">{agent?.name ?? '军师'}</Text>
                {ADVISOR_ALIAS[agent?.key ?? ''] ? <Text className="calias serif">{ADVISOR_ALIAS[agent?.key ?? '']}</Text> : null}
              </View>
              <Text className="cr">{agent?.role ?? '通用商业军师'}</Text>
            </View>
          </View>
        </SafeHeader>
      )}

      {/* 军师印象条：降噪为一行细字（入帐期隐藏，让军师的话独占纸面） */}
      {agent && !obActive && (
        <View className="mem-bar">
          <Text className="mt">军师印象 · {stripTags(agent.memText)}</Text>
        </View>
      )}

      {/* 案卷作用域 + 生成纪要（入帐期隐藏） */}
      {!obActive && (
        <View className="chat-tools">
          {projectId ? (
            <View className="ct-proj" style={{ background: 'var(--accent-soft)' }} onClick={() => Taro.navigateTo({ url: `/packages/work/project/index?id=${projectId}` })}>
              <Icon name="layers" size={12} color={accent} /><Text style={{ color: accent }}>案卷内对话</Text>
            </View>
          ) : <View className="ct-spacer" />}
          <View className="ct-sum" onClick={onSummarize}><Icon name="doc" size={13} color="#565C63" /><Text>生成纪要</Text></View>
        </View>
      )}

      {/* 参谋室协同导轨：总军师可派单给专业军师，专业军师可回总军师；随后是补充上下文入口（入帐期隐藏） */}
      {agent && !obActive ? (
        <View className="council-rail">
          <ScrollView scrollX enhanced showScrollbar={false} className="council-scroll">
            {agent.key === 'general' ? (
              DISPATCH_SUGGESTIONS.map((it) => (
                <View key={it.agentKey} className="council-chip" onClick={() => openThread(it.agentKey, it.prompt)}>
                  <View className="council-ic" style={{ background: 'var(--accent-soft)' }}><Icon name={it.icon} size={13} color={accent} /></View>
                  <Text>{it.name}</Text>
                </View>
              ))
            ) : (
              <>
                <View className="council-chip master" onClick={() => openThread('general', `我在${agent.name}线程里聊到的关键结论，请你汇总进主线判断，并告诉我下一步。`)}>
                  <View className="council-ic" style={{ background: accent }}><Icon name="spark" size={13} color="#fff" /></View>
                  <Text>回到总军师</Text>
                </View>
                {CORE_SPECIALISTS.filter((t) => t.agentKey !== agent.key).map((t) => {
                  const a = findAgent(t.agentKey);
                  if (!a) return null;
                  return (
                    <View key={t.agentKey} className="council-chip" onClick={() => openThread(t.agentKey)}>
                      <View className="council-ic" style={{ background: 'var(--accent-soft)' }}><Icon name={a.icon} size={13} color={accent} /></View>
                      <Text>{a.name}</Text>
                    </View>
                  );
                })}
              </>
            )}
            <View className="council-chip guide" onClick={turnIntoOrders}>
              <View className="council-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="check" size={13} color={accent} /></View>
              <Text>转成军令</Text>
            </View>
            {CHAT_GUIDES.map((g) => (
              <View key={g.label} className="council-chip guide" onClick={() => openGuide(g.url)}>
                <View className="council-ic" style={{ background: 'var(--surface-2)' }}><Icon name={g.icon} size={13} color="#565C63" /></View>
                <Text>{g.label}</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* 对话流 */}
      <ScrollView scrollY className="chat-log" scrollTop={scrollTop} scrollWithAnimation enhanced showScrollbar={false}>
        {msgs.map((m, i) => {
          if (m.role === 'greet') {
            return (
              <View key={i} className="msg a ink-in">
                <View className="who first"><AdvisorAvatar agentKey={m.agent.key} size={22} /><Text className="who-sign serif">军师</Text></View>
                <View className="ai-text t-advisor" onLongPress={() => copyText(m.agent.greet)}>
                  <Text>{m.agent.greet}</Text>
                </View>
                <View className="choice-laze">
                  {m.agent.chips.map(([, label]) => (
                    <View key={label} className="laze" onClick={() => doSend(label, sessionId, m.agent.key)}><Text>{label}</Text></View>
                  ))}
                </View>
              </View>
            );
          }
          if (m.role === 'user') {
            return (
              <View key={i} className="msg u ink-in">
                <View className="ubub" onLongPress={() => copyText(m.text)}><Text>{m.text}</Text></View>
                {m.refs?.length ? (
                  <View className="uref">{m.refs.map((r, j) => <Text key={j} className="uref-chip">@{r.label}</Text>)}</View>
                ) : null}
              </View>
            );
          }
          if (m.role === 'assistant') {
            return (
              <View key={i} className="msg a ink-in">
                {showSign(i) ? <View className="who first"><AdvisorAvatar agentKey={agent?.key ?? 'general'} size={22} /><Text className="who-sign serif">军师</Text></View> : null}
                <View className="ai-text t-advisor" onLongPress={() => copyText(replyToText(m.reply))}>
                  {m.streaming && !m.reply.text ? (
                    <View className="penning">
                      <View className="think-dots">
                        <View className="think-dot" style={{ background: accent }} />
                        <View className="think-dot d2" style={{ background: accent }} />
                        <View className="think-dot d3" style={{ background: accent }} />
                      </View>
                      <Text className="penning-t">军师执笔…</Text>
                    </View>
                  ) : (
                    <MarkdownText text={m.reply.text} selectable />
                  )}
                  {m.reply.points && (
                    <View className="points">
                      {m.reply.points.map((p, j) => <View key={j} className="pt"><View className="pd" style={{ background: accent }} /><MarkdownText text={p} className="pt-t" selectable /></View>)}
                    </View>
                  )}
                </View>
                {renderChoices(m.choices, i)}
                {renderWidget(m.widget, i)}
                {renderProposal(m.proposal)}
                {m.retryText ? (
                  <Text className="retry-link" style={{ color: accent }} onClick={() => doSend(m.retryText!, sessionId, agent?.key ?? '', [], false)}>↻ 重试</Text>
                ) : null}
              </View>
            );
          }
          if (m.role === 'memory') {
            return (
              <View key={i} className="mem-learned" onLongPress={() => copyText(`军师印象已更新：${m.agentName} 已校准本次对话里的业务偏好和判断口径，后续产出会更贴合。`)}>
                <Icon name="spark" size={13} color={accent} />
                <Text>军师印象已更新：{m.agentName} 已校准本次对话里的业务偏好和判断口径，后续产出会更贴合。</Text>
              </View>
            );
          }
          // report
          return (
            // P2-14：报告气泡用 messageId 作稳定 key，避免「延迟插入记忆」导致索引位移、ReportCard 渐显动画状态错位。
            <View key={m.messageId ?? `r-${i}`} className="msg a ink-in">
              <View onLongPress={() => copyDeliverable(m.deliverable)}>
                <ReportCard
                  data={m.deliverable}
                  animate={m.animate}
                  streaming={m.streaming}
                  onSave={m.streaming ? undefined : () => saveDeliverable(m.deliverable)}
                  onExport={m.streaming ? undefined : () => copyDeliverable(m.deliverable)}
                  onShare={m.streaming ? undefined : () => shareReport(m.messageId)}
                />
              </View>
              {!m.streaming && m.deliverable.degraded ? (
                <View style={{ marginTop: '8px', fontSize: '12px', opacity: 0.7 }}>
                  <Text>这版是保底草案，已免扣额度。你可以补充要求后再生成一版。</Text>
                </View>
              ) : null}
              {m.knowledgeUsed && m.knowledgeUsed.length ? (
                <View style={{ marginTop: '6px', fontSize: '12px', opacity: 0.6 }}>
                  <Text>参考了 {m.knowledgeUsed.length} 份资料：{m.knowledgeUsed.join('、')}</Text>
                </View>
              ) : null}
              {/* 认可方案 → 沉淀报告并进入执行承接（对齐「认可后拆成军令/复盘」动线） */}
              {!m.streaming && !m.deliverable.degraded ? (
                <View className="accept-card">
                  <View className="accept-b">
                    <Text className="accept-t">认可这份方案？</Text>
                    <Text className="accept-d">存入锦囊沉淀为一版方案，执行页承接军令与复盘。</Text>
                  </View>
                  <View className="accept-btn" style={{ background: accent }} onClick={() => acceptPlan(m.deliverable)}>
                    <Icon name="check" size={13} color="#fff" />
                    <Text>认可 · 去执行</Text>
                  </View>
                </View>
              ) : null}
              {renderProposal(m.proposal)}
            </View>
          );
        })}
        {/* 流式进行中：气泡内已自带「转圈→逐句填字」，不再叠加全局 thinking 指示器（否则出现两条响应）。 */}
        {busy && agent && !(msgs.length > 0 && (msgs[msgs.length - 1] as { role: string; streaming?: boolean }).streaming) ? (
          <View className="msg a thinking ink-in">
            <View className="penning">
              <View className="think-dots">
                <View className="think-dot" style={{ background: accent }} />
                <View className="think-dot d2" style={{ background: accent }} />
                <View className="think-dot d3" style={{ background: accent }} />
              </View>
              <Text className="penning-t">军师执笔…</Text>
            </View>
          </View>
        ) : null}
        <View style={{ height: '20px' }} />
      </ScrollView>

      {/* 已选引用 */}
      {refs.length ? (
        <View className="ref-row">
          {refs.map((r, j) => (
            <View key={j} className="ref-chip" style={{ borderColor: accent }} onClick={() => toggleRef(r)}>
              <Text style={{ color: accent }}>@{r.label}</Text><Text className="ref-x">✕</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* 输入区：高度自适应卡片，底排为 加号(资料) / 选模型 / 语音·发送 */}
      <View className={`composer ${busy ? 'busy' : ''}`}>
        <View className="box" onClick={() => { if (!busy) setInputFocus(true); }}>
          <Textarea
            className="cinput"
            value={input}
            focus={inputFocus}
            disabled={busy}
            maxlength={2000}
            cursorSpacing={24}
            adjustPosition={false}
            autoHeight
            showConfirmBar={false}
            placeholder={obActive ? '也可直接与军师说…' : '向军师提问…'}
            confirmType="send"
            onFocus={() => { if (!busy) setInputFocus(true); }}
            onBlur={() => { setInputFocus(false); setKeyboardHeight(0); }}
            onInput={handleInput}
            onConfirm={(e) => onSend(e.detail.value)}
            onKeyboardHeightChange={onKeyboardHeightChange}
          />
          <View className="cbar">
            <View className="cbar-l">
              <View className="cbtn plus" onClick={(e) => { e.stopPropagation?.(); onPlus(); }}>
                <Icon name="plus" size={19} color={refs.length ? accent : '#565C63'} />
              </View>
            </View>
            <View className="cbar-r">
              <View
                className={`csend ${busy || !input.trim() ? 'off' : ''}`}
                role="button"
                aria-label="发送"
                style={{ background: input.trim() && !busy ? accent : undefined }}
                onClick={(e) => { e.stopPropagation?.(); onSend(); }}
              >
                <Icon name="up" size={18} color="#fff" />
              </View>
            </View>
          </View>
        </View>
      </View>

      {/* @引用选择器 */}
      {picker && (
        <View className="ref-sheet">
          <View className="ref-mask" onClick={closePicker} />
          <View className="ref-panel">
            <View className="ref-ph">
              <Text className="ref-pt">引用资料</Text>
              <Text className="ref-done" style={{ color: accent }} onClick={closePicker}>完成{refs.length ? ` (${refs.length})` : ''}</Text>
            </View>
            <ScrollView scrollY className="ref-body" enhanced showScrollbar={false}>
              {renderGroup('案卷', pick.projects.map((p) => ({ kind: 'project' as const, id: p.id, label: p.name, sub: `${p.counts.reports} 方案 · ${p.counts.knowledge} 资料` })))}
              {renderGroup('方案', pick.reports.map((r) => ({ kind: 'report' as const, id: r.id, label: `${r.title} v${r.currentVersion}`, version: r.currentVersion, sub: r.type })))}
              {renderGroup('资料', pick.knowledge.map((k) => ({ kind: 'knowledge' as const, id: k.id, label: k.title || k.text.slice(0, 14), sub: k.text.slice(0, 24) })))}
              {renderGroup('军师印象', pick.memories.map((m) => ({ kind: 'memory' as const, id: m.id, label: m.text.slice(0, 18), sub: m.agentName || m.kind })))}
              {(!pick.projects.length && !pick.reports.length && !pick.knowledge.length && !pick.memories.length) ? (
                <Text className="ref-empty">还没有可引用的案卷/方案/资料。先建案卷、产出方案或记录资料，这里就能 @ 它们。</Text>
              ) : null}
              <View style={{ height: '12px' }} />
            </ScrollView>
          </View>
        </View>
      )}

      <Login
        open={showLogin}
        onLoggedIn={(onboarded) => {
          setShowLogin(false);
          initChat();
          onLoggedIn?.(onboarded);
        }}
      />
    </View>
  );
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}
function safeStorageGet(k: string): string {
  try { return Taro.getStorageSync(k) || ''; } catch { return ''; }
}
function safeStorageSet(k: string, v: string) {
  try { Taro.setStorageSync(k, v); } catch { /* noop */ }
}
function data_delay(d: Deliverable): number {
  return 900 + d.sections.length * 640 + 500;
}
