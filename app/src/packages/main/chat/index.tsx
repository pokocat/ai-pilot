import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { View, Text, Textarea, ScrollView } from '@tarojs/components';
import Taro, { useRouter, useDidHide } from '@tarojs/taro';
import Icon from '../../../components/Icon';
import Login from '../../../components/Login';
import MarkdownText from '../../../components/MarkdownText';
import ReportCard from '../../../components/ReportCard';
import SafeHeader from '../../../components/SafeHeader';
import AdvisorAvatar from '../../../components/AdvisorAvatar';
import { useStore } from '../../../hooks/useStore';
import { store } from '../../../services/store';
import { api, type Agent, type Deliverable, type Section, type ChatReplyT, type MessageRef, type ProjectItem, type ReportItem, type KnowledgeItemT, type MemoryCandidate } from '../../../services/api';
import { STREAM_CHAT } from '../../../services/config';
import { generateStream, type StreamControl } from '../../../services/streaming';
import { requestWechatSubscribe } from '../../../services/wechatSubscribe';
import { checkUpload } from '../../../services/uploadGuard';
import { agentForText } from '../../../data/intents';
import { ADVISOR_ALIAS, CORE_SPECIALISTS, DISPATCH_SUGGESTIONS } from '../../../data/council';
import { CHAT_GUIDES } from '../../../data/operatingSystem';
import { acceptDeliverable } from '../../../services/dossier';
import { navTo } from '../../../services/nav';
import './index.scss';

type Msg =
  | { role: 'greet'; agent: Agent }
  | { role: 'user'; text: string; refs?: MessageRef[] }
  | { role: 'assistant'; reply: ChatReplyT; knowledgeUsed?: string[]; retryText?: string; streaming?: boolean }
  | { role: 'report'; deliverable: Deliverable; animate: boolean; saved?: boolean; messageId?: string; knowledgeUsed?: string[]; streaming?: boolean; retryText?: string }
  | { role: 'memory'; agentName: string };

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
  '--jump-bottom'?: string;
};

type ChatScrollEvent = {
  detail?: {
    scrollTop?: number;
    scrollHeight?: number;
  };
};

// 模型选择：后端统一调度，前端暂固定展示一档（预留多模型切换入口）。
const FIXED_MODEL = '军师 · 标准';
const JUMP_LATEST_SHOW_DISTANCE = 420;
const JUMP_LATEST_HIDE_DISTANCE = 140;
// B1 贴底判定阈值：距底 ≤ 此值视为「贴底跟随」，用户上滑超过即暂停自动滚底。
const STICK_BOTTOM_DISTANCE = 120;
// B1 流式跟随节流间隔：onToken/onReportSection 高频触发，滚底最多每 ~300ms 一次。
const FOLLOW_THROTTLE_MS = 300;
// B6 输入计数：临近上限（>1800/2000）才显示字数，平时不打扰。
const INPUT_MAX = 2000;
const INPUT_COUNT_FROM = 1800;

const IS_WEAPP = process.env.TARO_ENV === 'weapp';
const UPLOAD_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'md', 'markdown', 'txt'];

// B3 草稿持久化 / B4 已入库标记：本地 Storage 键。
const draftKeyFor = (id?: string) => `chat-draft:${id || 'new'}`;
const SAVED_REPORTS_KEY = 'saved-report-ids';
const getSavedReportIds = (): string[] => {
  try { const v = Taro.getStorageSync(SAVED_REPORTS_KEY); return Array.isArray(v) ? v : []; } catch { return []; }
};
const isReportSaved = (id?: string) => !!id && getSavedReportIds().includes(id);
const markReportSaved = (id?: string) => {
  if (!id) return;
  try { const ids = getSavedReportIds(); if (!ids.includes(id)) Taro.setStorageSync(SAVED_REPORTS_KEY, [...ids, id]); } catch { /* noop */ }
};

export default function Chat() {
  const router = useRouter();
  // 三势研判入口带来的势标签（市势/人势）：认可存库时写入报告 type，供战局卡可靠反查
  const forceTag = decodeURIComponent((router.params as Record<string, string>).force || '');
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [agent, setAgent] = useState<Agent | null>(null);
  const [sessionId, setSessionId] = useState<string>('');
  const [projectId, setProjectId] = useState<string>('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [inputFocus, setInputFocus] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  const [refs, setRefs] = useState<MessageRef[]>([]);
  const [showLogin, setShowLogin] = useState(() => !store.isAuthed());
  const [picker, setPicker] = useState(false);
  const [pick, setPick] = useState<{ projects: ProjectItem[]; reports: ReportItem[]; knowledge: KnowledgeItemT[]; memories: MemoryCandidate[] }>({ projects: [], reports: [], knowledge: [], memories: [] });
  const logHeightRef = useRef(0);
  const logRef = useRef<Msg[]>([]);
  logRef.current = msgs;

  // B1 贴底跟随：atBottom 记录用户是否停留在底部；上滑离开即暂停自动跟随。
  const atBottomRef = useRef(true);
  const lastFollowRef = useRef(0);
  const followTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // B2 停止生成：当前流的中断句柄 + 是否被用户主动停止。
  const controlRef = useRef<StreamControl | null>(null);
  const abortedRef = useRef(false);
  // B3 草稿：用 ref 取最新值，供 onBlur / useDidHide 闭包读取。
  const inputRef = useRef('');
  inputRef.current = input;
  const sessionIdRef = useRef('');
  sessionIdRef.current = sessionId;
  // B5 上传：可取消的非模态进度（scope 限制未透出 uploadFile task，故 cancel 为「放弃等待/不挂引用」）。
  const [uploading, setUploading] = useState(false);
  const uploadCancelledRef = useRef(false);
  // B6 jump-latest 与 composer 高度联动：测量输入区顶部到屏底的距离，驱动 --jump-bottom。
  const [jumpBottom, setJumpBottom] = useState(0);
  const winHeightRef = useRef(0);

  const findAgent = (key: string): Agent | undefined => s.agents().find((a) => a.key === key);

  const measureChatLog = () => {
    Taro.createSelectorQuery()
      .select('.chat-log')
      .boundingClientRect((rect) => {
        const height = Number((rect as { height?: number } | null)?.height || 0);
        if (height > 0) logHeightRef.current = height;
      })
      .exec();
  };

  // B1：用户主动/事件触发的「回到最新」——强制滚底并恢复跟随。
  const scrollToEnd = () => {
    atBottomRef.current = true;
    if (followTimerRef.current) { clearTimeout(followTimerRef.current); followTimerRef.current = null; }
    lastFollowRef.current = Date.now();
    setShowJumpLatest(false);
    setScrollTop((t) => t + 100000);
  };

  // B1：流式期间的跟随——仅当用户仍贴底时滚底，且节流到 ~300ms 一次，尊重上滑。
  const followBottom = (immediate = false) => {
    if (!atBottomRef.current) return;
    if (immediate) {
      if (followTimerRef.current) { clearTimeout(followTimerRef.current); followTimerRef.current = null; }
      lastFollowRef.current = Date.now();
      setScrollTop((t) => t + 100000);
      return;
    }
    const now = Date.now();
    const since = now - lastFollowRef.current;
    if (since >= FOLLOW_THROTTLE_MS) {
      lastFollowRef.current = now;
      setScrollTop((t) => t + 100000);
    } else if (!followTimerRef.current) {
      followTimerRef.current = setTimeout(() => {
        followTimerRef.current = null;
        if (!atBottomRef.current) return;
        lastFollowRef.current = Date.now();
        setScrollTop((t) => t + 100000);
      }, FOLLOW_THROTTLE_MS - since);
    }
  };

  const handleLogScroll = (e: ChatScrollEvent) => {
    const height = logHeightRef.current;
    const top = Number(e.detail?.scrollTop || 0);
    const scrollHeight = Number(e.detail?.scrollHeight || 0);
    if (!height || !scrollHeight) {
      measureChatLog();
      return;
    }
    const distanceToBottom = scrollHeight - top - height;
    // B1：单一「贴底」判定，驱动流式跟随开关。
    atBottomRef.current = distanceToBottom <= STICK_BOTTOM_DISTANCE;
    setShowJumpLatest((visible) => {
      if (visible) return distanceToBottom > JUMP_LATEST_HIDE_DISTANCE;
      return distanceToBottom > JUMP_LATEST_SHOW_DISTANCE;
    });
  };

  useEffect(() => {
    if (busy) setTimeout(scrollToEnd, 40);
  }, [busy]);

  // B6：测量输入区顶部到屏底距离（含多行增高 / 引用行 / 键盘 / 安全区），驱动 jump-latest 定位。
  const measureDock = () => {
    if (!winHeightRef.current) {
      try {
        const info = (Taro as unknown as { getWindowInfo?: () => { windowHeight?: number } }).getWindowInfo?.()
          || Taro.getSystemInfoSync?.();
        winHeightRef.current = Number((info as { windowHeight?: number })?.windowHeight || 0);
      } catch { /* noop */ }
    }
    const winH = winHeightRef.current;
    if (!winH) return;
    Taro.createSelectorQuery()
      .select('.composer-dock')
      .boundingClientRect((rect) => {
        const top = Number((rect as { top?: number } | null)?.top || 0);
        if (top > 0) setJumpBottom(Math.max(0, winH - top));
      })
      .exec();
  };

  useEffect(() => {
    setTimeout(measureChatLog, 80);
    setTimeout(measureDock, 80);
  }, [keyboardHeight, refs.length, msgs.length, input, uploading]);

  useEffect(() => () => store.setOverlay(false, 'ref-picker'), []);

  // B3 草稿持久化：按 sessionId 维度存/取；发送成功后清除。
  const loadDraft = (id?: string) => {
    try { const d = Taro.getStorageSync(draftKeyFor(id)); if (d && typeof d === 'string') setInput(d); } catch { /* noop */ }
  };
  const saveDraft = () => {
    try {
      const k = draftKeyFor(sessionIdRef.current);
      const v = inputRef.current.trim();
      if (v) Taro.setStorageSync(k, inputRef.current);
      else Taro.removeStorageSync(k);
    } catch { /* noop */ }
  };
  const clearDraft = (id?: string) => {
    try { Taro.removeStorageSync(draftKeyFor(id ?? sessionIdRef.current)); } catch { /* noop */ }
  };
  // 切后台/离开页面时落草稿，避免误触返回丢失长输入。
  useDidHide(() => { saveDraft(); });

  const isUnauthorized = (e: unknown) =>
    (e as any)?.code === 'UNAUTHORIZED' || String((e as any)?.message || '').includes('未登录');

  const errorReply = (e: unknown): string => {
    if (isUnauthorized(e)) return '登录态已失效，请重新登录后再发送。';
    if ((e as any)?.data?.code === 'AGENT_LOCKED') return '该专项顾问尚未启用，请到「智库 / 工坊」查看可用方案。';
    if ((e as any)?.data?.code === 'INSUFFICIENT_QUOTA') return '本月 token 额度已用尽，请在「我的」升级套餐或下月再用。';
    if ((e as any)?.data?.code === 'INSUFFICIENT_CREDITS') return '算力不足，请在「我的」充值或解锁后再继续。';
    const msg = String((e as any)?.message || '');
    if (msg && msg !== 'undefined') return msg;
    return '抱歉，产出失败了，请稍后再试。';
  };

  // 审核类错误（输入/输出未通过内容审核）：重试同样内容必再次被拦，故不提供「重试」，也避免叠出重复气泡。
  const isModerationErr = (s?: string) => !!s && /审核/.test(s);

  const wantsDeliverableRequest = (s: string) =>
    /(生成|输出|整理|做一份|出一份|给我一份|形成).{0,8}(方案|报告|成果|卡片|纪要|计划|军令|文案|脚本|海报)|(?:重新)?出.{0,4}(方案|报告|成果|卡片|纪要|计划|军令|文案|脚本|海报)|战略体检|转成军令|生成纪要/.test(s);

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
    const { agentKey, send, projectId: pid } = router.params as Record<string, string>;
    if (pid) setProjectId(pid);
    const key = agentKey || (send ? agentForText(decodeURIComponent(send)) : 'general');
    const fallbackAgent = agents.find((a) => a.key === key) || agents.find((a) => a.key === 'general') || agents[0];
    if (fallbackAgent) {
      setAgent(fallbackAgent);
      setMsgs([{ role: 'greet', agent: fallbackAgent }]);
    }
    return fallbackAgent;
  }

  // 初始化：根据路由参数还原会话 / 打开顾问线程 / 新会话
  async function initChat() {
    let agents = s.agents(); // 已含离线兜底，基本不为空
    if (!agents.length) {
      await s.loadAgents();
      agents = s.agents();
    }
    const { sessionId: sid, agentKey, send, fresh, projectId: pid } = router.params as Record<string, string>;
    if (pid) setProjectId(pid);
    const key = agentKey || (send ? agentForText(decodeURIComponent(send)) : 'general');
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

    try {
      if (sid) {
        const detail = await api.session(sid);
        const ag = agents.find((a) => a.key === detail.agentKey) || (detail.agent as any) || fallbackAgent;
        setAgent(ag);
        setSessionId(sid);
        if (detail.projectId) setProjectId(detail.projectId);
        restore(ag, detail.messages);
        loadDraft(sid);
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
          loadDraft(latest.id);
          if (send) setTimeout(() => doSend(decodeURIComponent(send), latest.id, fallbackAgent.key, [], true, detail.projectId || pid || ''), 300);
          return;
        }
      }
      // 全新会话：仅渲染问候（不落库），首条消息时后端创建
      setMsgs([{ role: 'greet', agent: fallbackAgent }]);
      loadDraft('');
      if (send) setTimeout(() => doSend(decodeURIComponent(send), '', fallbackAgent.key, [], true, pid || ''), 350);
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
  }, []);

  function restore(ag: Agent, messages: { id: string; role: string; content: any; refs?: MessageRef[] }[]) {
    const out: Msg[] = [{ role: 'greet', agent: ag }];
    messages.forEach((m) => {
      if (m.role === 'user') out.push({ role: 'user', text: m.content.text, refs: m.refs });
      // B4：已入库真值——优先取服务端字段（若有），否则回落到本地保存记录，避免已入库方案重复显示「存入方案库」。
      else if (m.role === 'report') out.push({
        role: 'report', deliverable: m.content, animate: false, messageId: m.id,
        saved: !!((m as { saved?: boolean }).saved || (m.content as { saved?: boolean })?.saved || isReportSaved(m.id)),
      });
      else out.push({ role: 'assistant', reply: m.content });
    });
    setMsgs(out);
    setTimeout(scrollToEnd, 60);
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
    abortedRef.current = false;
    // B3：发送即清掉本会话草稿（输入已上屏；失败可用气泡「重试」重发，无需草稿）。
    clearDraft();
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
        const control: StreamControl = { abort: () => {} };
        controlRef.current = control;
        const streamOk = await generateStream(
          body,
          {
            onSession: (id) => { if (id && !sid) setSessionId(id); },
            onToken: (t) => { patch((msg) => ({ ...msg, reply: { ...msg.reply, text: (msg.reply.text || '') + t } })); followBottom(); },
            onChat: (reply) => patch((msg) => ({ ...msg, reply })), // 完整回复权威兜底：token 渲染即便有偏差，最终内容仍正确
            onDone: () => patch((msg) => ({ ...msg, streaming: false })),
            onError: (em) => patch((msg) => ({ ...msg, reply: { text: em || '生成失败' }, retryText: isModerationErr(em) ? undefined : text, streaming: false })),
          },
          control,
        );
        // B2：被用户主动停止时，静默收尾（清掉「生成中」态、不再兜底重发一遍）；
        // 若还没吐出任何字，直接移除空气泡，避免留下空壳。
        if (abortedRef.current) {
          setMsgs((m) => {
            const i = m.length - 1;
            if (i >= 0 && m[i].role === 'assistant' && (m[i] as { streaming?: boolean }).streaming) {
              const cur = m[i] as Extract<Msg, { role: 'assistant' }>;
              const copy = m.slice();
              if (!cur.reply.text) { copy.splice(i, 1); return copy; }
              copy[i] = { ...cur, streaming: false };
              return copy;
            }
            return m;
          });
        } else if (!streamOk) {
          const res = await api.generate(body);
          renderGenerateResult(res, true);
        }
        followBottom(true);
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
        const control: StreamControl = { abort: () => {} };
        controlRef.current = control;
        try {
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
            followBottom(); // B1：仅当用户仍贴底才跟随，尊重上滑
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
            followBottom();
          },
          onChat: (reply) => {
            if (reportStarted) return;
            startChat();
            patchChat((msg) => ({ ...msg, reply }));
          },
          onMemory: (data) => {
            if (data.learned && data.agentName) learnedAgentName = data.agentName;
          },
          onDone: (messageId) => {
            if (reportStarted) {
              patchReport((d) => d, { streaming: false, messageId });
            } else if (chatStarted) {
              patchChat((msg) => ({ ...msg, streaming: false }));
            }
            if (learnedAgentName) showMemoryLearned(learnedAgentName, 600);
            followBottom(true);
          },
          onError: (em) => {
            if (reportStarted) {
              // B4：报告流失败挂上「重试」原文，卡片下方给 ↻ 入口（审核类错误不给重试）。
              patchReport((d) => ({ ...d, trust: em || '生成中断，请重试', degraded: true }), { streaming: false, retryText: isModerationErr(em) ? undefined : text });
            } else if (chatStarted) {
              patchChat((msg) => ({ ...msg, reply: { text: em || '生成失败' }, retryText: isModerationErr(em) ? undefined : text, streaming: false }));
            }
          },
        }, control);
        // B2：主动停止时不兜底重发；仅确保 chat 分支的「生成中」态被收干净（report 分支在 finally 收尾）。
        if (abortedRef.current) {
          if (chatStarted) patchChat((msg) => ({ ...msg, streaming: false }));
        } else if (!streamOk && !reportStarted && !chatStarted) {
          const res = await api.generate(body);
          renderGenerateResult(res);
        }
        } finally {
          // P0-5 双保险：报告流无论 promise 结果（含中途抛错/主动停止），最终强制把报告卡 streaming 置 false，
          // 避免流正常收尾却未触发 onDone/onError 时报告卡永久停在「产出中」。
          // patchReport 仅改「末条且仍 streaming」的报告卡，onDone 已收尾时此处为幂等 no-op。
          if (reportStarted) patchReport((d) => d, { streaming: false });
        }
        followBottom(true);
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
      controlRef.current = null;
    }
  }

  // B2 停止生成：中断当前流；abortedRef 让 doSend 跳过兜底重发并收干净「生成中」态。
  const stopGeneration = () => {
    if (!busy) return;
    abortedRef.current = true;
    controlRef.current?.abort();
  };

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

  const saveDeliverable = async (d: Deliverable, messageId?: string) => {
    if (!agent) return;
    await api.saveToLibrary({
      // 三势研判入口进来的，type 打成「{势}研判」（如 市势研判），战局卡按 type 可靠反查
      title: d.title, type: forceTag ? `${forceTag}研判` : (agent.deliverableKey || d.title), agentKey: agent.key,
      sessionId: sessionId || undefined, content: d as any, projectId: projectId || undefined,
    }).catch(() => {});
    // B4：本地记下已入库的报告 messageId，历史 restore 时回填 saved 真值，避免重复显示「存入方案库」。
    markReportSaved(messageId);
    Taro.showToast({ title: '已存入方案库', icon: 'none' });
  };

  // 认可方案：存入方案库（桥接一版报告）+ 服务端生成案卷军令 → 去执行页承接打卡与回填
  const acceptPlan = async (d: Deliverable, messageId?: string) => {
    const r = await acceptDeliverable(d, agent?.name || '军师', forceTag || undefined).catch(() => null);
    if (!r) { Taro.showToast({ title: '案卷生成失败，请重试', icon: 'none' }); return; }
    if (!r.newOrders && r.skippedOrders) {
      Taro.showToast({ title: '这份方案已转成军令，不重复添加', icon: 'none' });
      return;
    }
    await saveDeliverable(d, messageId);
    Taro.showToast({ title: r.newOrders ? `已生成案卷 · ${r.newOrders} 条军令待执行` : '已生成案卷', icon: 'none' });
    setTimeout(() => Taro.switchTab({ url: '/pages/studio/index' }), 620);
  };

  // 转成军令：把本轮最新的结构化成果转为今日军令（无成果则引导先产出）
  const turnIntoOrders = () => {
    const lastReport = [...logRef.current].reverse().find((m) => m.role === 'report') as Extract<Msg, { role: 'report' }> | undefined;
    if (!lastReport) {
      Taro.showToast({ title: '先让军师产出一份方案，认可后即可转成军令', icon: 'none' });
      return;
    }
    acceptPlan(lastReport.deliverable, lastReport.messageId);
  };

  // 切换军师线程（派单 / 回总军师）：redirectTo 保持页面栈扁平，带 prompt 时直接开场
  const openThread = (agentKey: string, prompt?: string) => {
    const url = `/packages/main/chat/index?agentKey=${agentKey}&fresh=1${prompt ? `&send=${encodeURIComponent(prompt)}` : ''}`;
    Taro.redirectTo({ url });
  };
  const openGuide = (url: string) => navTo(url);

  // 生成网页版报告（render_report → 自有域名 /api/r/:id，接口幂等）→ 直接打开：weapp 走内置 web-view 页，H5 开新窗口。
  const shareReport = async (messageId?: string) => {
    if (!sessionId || !messageId) { Taro.showToast({ title: '请先产出方案', icon: 'none' }); return; }
    Taro.showLoading({ title: '生成网页版…' });
    try {
      await requestWechatSubscribe('report').catch(() => {});
      const r = await api.renderReport(sessionId, messageId);
      Taro.hideLoading();
      if (!r.htmlUrl) { Taro.showToast({ title: '本地预览模式无网页版', icon: 'none' }); return; }
      // D-3-4：网页版仅本人自用（web-view 打开查看）；不再提供「复制链接」对外分享入口。
      if (IS_WEAPP) {
        navTo(`/packages/work/webview/index?url=${encodeURIComponent(r.htmlUrl)}`, {
          fail: () => Taro.showToast({ title: '网页打开失败，请稍后重试', icon: 'none' }),
        });
      } else if (typeof window !== 'undefined' && window.open) {
        window.open(r.htmlUrl, '_blank');
      } else {
        Taro.showToast({ title: '请在小程序内查看网页版', icon: 'none' });
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
      setTimeout(() => navTo(`/packages/work/report/index?id=${r.reportId}`), 700);
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
    // 上传前置校验体积上限（与 server multipart 20MB 限制对齐），避免放行后被服务端 413 拒绝、
    // 只留一句无信息量的「HTTP 413」（thinktank / knowledge 两页已有此校验，本页此前遗漏）。
    const chk = checkUpload({ name: f.name, size: f.size });
    if (!chk.ok) {
      Taro.showToast({ title: chk.desc || '文件不符合上传要求', icon: 'none' });
      return;
    }
    // B5：非模态可取消上传（替代阻塞式 showLoading）。scope 未透出 uploadFile task，
    // 取消 = 放弃等待、不挂引用；后端仍会完成解析，无副作用。
    uploadCancelledRef.current = false;
    setUploading(true);
    try {
      const { id } = await api.uploadKnowledge(f.path, projectId || undefined);
      if (uploadCancelledRef.current) return; // 已取消：结果不挂引用
      const label = f.name || '上传资料';
      setRefs((cur) => cur.some((x) => x.kind === 'knowledge' && x.id === id) ? cur : [...cur, { kind: 'knowledge', id, label }]);
      Taro.showToast({ title: '已上传，解析中…可直接发送提问', icon: 'none' });
    } catch (e) {
      if (uploadCancelledRef.current) return; // 取消引发的失败静默
      Taro.showToast({ title: (e as Error).message || '上传失败', icon: 'none' });
    } finally {
      setUploading(false);
    }
  };

  const cancelUpload = () => {
    uploadCancelledRef.current = true;
    setUploading(false);
    Taro.showToast({ title: '已取消上传', icon: 'none' });
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

  return (
    <View className={`page chat ${s.themeClass()}`} style={{ '--keyboard-height': `${keyboardHeight}px`, '--jump-bottom': `${jumpBottom}px` } as ChatStyle}>
      {/* 顾问身份头 */}
      <SafeHeader
        className="chat-head"
        rightReserve={false}
        left={<View className="safe-hbtn" onClick={() => Taro.switchTab({ url: '/pages/sessions/index' })}><Icon name="chat" size={19} color="#565C63" /></View>}
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

      {/* 军师印象条（Agent Memory 用户可见包装） */}
      {agent && (
        <View className="mem-bar">
          <Icon name="layers" size={14} color={accent} />
          <Text className="mt">军师印象：{stripTags(agent.memText)}</Text>
          <View className="mlearn"><View className="dot" style={{ background: accent }} /><Text>{agent.learnText}</Text></View>
        </View>
      )}

      {/* 案卷作用域 + 生成纪要 */}
      <View className="chat-tools">
        {projectId ? (
          <View className="ct-proj" style={{ background: 'var(--accent-soft)' }} onClick={() => navTo(`/packages/work/project/index?id=${projectId}`)}>
            <Icon name="layers" size={12} color={accent} /><Text style={{ color: accent }}>案卷内对话</Text>
          </View>
        ) : <View className="ct-spacer" />}
        <View className="ct-sum" onClick={onSummarize}><Icon name="doc" size={13} color="#565C63" /><Text>生成纪要</Text></View>
      </View>

      {/* 参谋室协同导轨：总军师可派单给专业军师，专业军师可回总军师；随后是补充上下文入口 */}
      {agent ? (
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
      <ScrollView scrollY className="chat-log" scrollTop={scrollTop} scrollWithAnimation enhanced showScrollbar={false} onScroll={handleLogScroll}>
        {msgs.map((m, i) => {
          if (m.role === 'greet') {
            return (
              <View key={i} className="msg a">
                <View className="who"><AdvisorAvatar agentKey={m.agent.key} size={24} /><Text>{m.agent.name}</Text></View>
                <View className="bubble" onLongPress={() => copyText(m.agent.greet)}>
                  <Text>{m.agent.greet}</Text>
                  <View className="memory-disclosure">
                    <View className="md-h">
                      <Icon name="layers" size={13} color={accent} />
                      <Text style={{ color: accent }}>军师印象</Text>
                    </View>
                    <Text className="md-copy">我会参考你在本账号沉淀的企业档案、历史偏好和本次引用资料，让建议保持同一套业务口径。</Text>
                    <View className="md-tags">
                      <Text>企业档案</Text>
                      <Text>对话偏好</Text>
                      <Text>引用资料</Text>
                    </View>
                  </View>
                  <View className="acts">
                    {m.agent.chips.map(([ic, label]) => (
                      <View key={label} className="act-chip" onClick={() => doSend(label, sessionId, m.agent.key)}>
                        <Icon name={ic} size={13} color={accent} /><Text>{label}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              </View>
            );
          }
          if (m.role === 'user') {
            return (
              <View key={i} className="msg u">
                <View className="ubub" style={{ background: accent }} onLongPress={() => copyText(m.text)}><Text>{m.text}</Text></View>
                {m.refs?.length ? (
                  <View className="uref">{m.refs.map((r, j) => <Text key={j} className="uref-chip">@{r.label}</Text>)}</View>
                ) : null}
              </View>
            );
          }
          if (m.role === 'assistant') {
            return (
              <View key={i} className="msg a">
                <View className="who"><AdvisorAvatar agentKey={agent?.key ?? 'general'} size={24} /><Text>{agent?.name}</Text></View>
                <View className="ai-text" onLongPress={() => copyText(replyToText(m.reply))}>
                  {m.streaming && !m.reply.text ? (
                    <View className="think-dots">
                      <View className="think-dot" style={{ background: accent }} />
                      <View className="think-dot d2" style={{ background: accent }} />
                      <View className="think-dot d3" style={{ background: accent }} />
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
                {m.retryText ? (
                  <Text style={{ marginTop: '6px', color: accent, fontSize: '13px' }} onClick={() => doSend(m.retryText!, sessionId, agent?.key ?? '', [], false)}>↻ 重试</Text>
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
            <View key={m.messageId ?? `r-${i}`} className="msg a">
              <View className="who"><AdvisorAvatar agentKey={agent?.key ?? 'general'} size={24} /><Text>{agent?.name}</Text></View>
              <View onLongPress={() => copyDeliverable(m.deliverable)}>
                <ReportCard
                  data={m.deliverable}
                  animate={m.animate}
                  streaming={m.streaming}
                  saved={m.saved}
                  onSave={m.streaming ? undefined : () => saveDeliverable(m.deliverable, m.messageId)}
                  onExport={m.streaming ? undefined : () => copyDeliverable(m.deliverable)}
                  onShare={m.streaming ? undefined : () => shareReport(m.messageId)}
                />
              </View>
              {/* B4：报告流失败重试入口（复用聊天气泡 ↻ 模式） */}
              {!m.streaming && m.retryText ? (
                <Text style={{ marginTop: '6px', color: accent, fontSize: '13px' }} onClick={() => doSend(m.retryText!, sessionId, agent?.key ?? '', [], false)}>↻ 重试</Text>
              ) : null}
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
                    <Text className="accept-d">存入方案库沉淀为一版方案，执行页承接军令与复盘。</Text>
                  </View>
                  <View className="accept-btn" style={{ background: accent }} onClick={() => acceptPlan(m.deliverable)}>
                    <Icon name="check" size={13} color="#fff" />
                    <Text>认可 · 去执行</Text>
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}
        {/* 流式进行中：气泡内已自带「转圈→逐句填字」，不再叠加全局 thinking 指示器（否则出现两条响应）。 */}
        {busy && agent && !(msgs.length > 0 && (msgs[msgs.length - 1] as { role: string; streaming?: boolean }).streaming) ? (
          <View className="msg a thinking">
            <View className="who"><AdvisorAvatar agentKey={agent.key} size={24} /><Text>{agent.name}</Text></View>
            <View className="bubble think-bubble">
              <View className="think-dots">
                <View className="think-dot" style={{ background: accent }} />
                <View className="think-dot d2" style={{ background: accent }} />
                <View className="think-dot d3" style={{ background: accent }} />
              </View>
              <Text className="think-text">正在梳理上下文</Text>
            </View>
          </View>
        ) : null}
        <View style={{ height: '20px' }} />
      </ScrollView>

      {showJumpLatest ? (
        <View
          className="jump-latest"
          style={{ borderColor: accent }}
          onClick={scrollToEnd}
        >
          <Text style={{ color: accent }}>回到最新</Text>
          <Icon name="chevron" size={14} color={accent} />
        </View>
      ) : null}

      {/* B6：引用行 + 上传条 + 输入区打包成 dock，统一测量高度驱动 jump-latest 定位 */}
      <View className="composer-dock">
        {/* B5：非模态上传进度（可取消） */}
        {uploading ? (
          <View className="upload-bar">
            <View className="ub-spin" style={{ borderTopColor: accent }} />
            <Text className="ub-t">资料上传中…</Text>
            <Text className="ub-cancel" style={{ color: accent }} onClick={cancelUpload}>取消</Text>
          </View>
        ) : null}

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
              maxlength={INPUT_MAX}
              cursorSpacing={24}
              adjustPosition={false}
              autoHeight
              showConfirmBar={false}
              placeholder="向军师提问…"
              confirmType="send"
              onFocus={() => { if (!busy) setInputFocus(true); }}
              onBlur={() => { setInputFocus(false); setKeyboardHeight(0); saveDraft(); }}
              onInput={handleInput}
              onConfirm={(e) => onSend(e.detail.value)}
              onKeyboardHeightChange={onKeyboardHeightChange}
            />
            {/* B6：临近上限才显示字数，平时不打扰 */}
            {input.length > INPUT_COUNT_FROM ? (
              <Text className="cinput-count">{input.length}/{INPUT_MAX}</Text>
            ) : null}
            <View className="cbar">
              <View className="cbar-l">
                <View className="cbtn plus" onClick={(e) => { e.stopPropagation?.(); onPlus(); }}>
                  <Icon name="plus" size={19} color={refs.length ? accent : '#565C63'} />
                </View>
                {/* B6：模型单档——去掉 chevron 与死点击，纯展示标签 */}
                <View className="cmodel static">
                  <Text className="cmodel-name">{FIXED_MODEL}</Text>
                </View>
              </View>
              <View className="cbar-r">
                {busy ? (
                  // B2：生成中 → 停止键
                  <View
                    className="csend stop"
                    role="button"
                    aria-label="停止生成"
                    style={{ background: accent }}
                    onClick={(e) => { e.stopPropagation?.(); stopGeneration(); }}
                  >
                    <View className="stop-sq" />
                  </View>
                ) : (
                  <View
                    className={`csend ${!input.trim() ? 'off' : ''}`}
                    role="button"
                    aria-label="发送"
                    style={input.trim() ? { background: accent } : {}}
                    onClick={(e) => { e.stopPropagation?.(); onSend(); }}
                  >
                    <Icon name="up" size={18} color="#fff" />
                  </View>
                )}
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
        onLoggedIn={() => {
          setShowLogin(false);
          initChat();
        }}
      />
    </View>
  );
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}
function data_delay(d: Deliverable): number {
  return 900 + d.sections.length * 640 + 500;
}
