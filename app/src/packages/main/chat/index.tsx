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
import { api, reportPdfUrl, type Agent, type Deliverable, type Section, type ChatReplyT, type MessageRef, type ProjectItem, type ReportItem, type KnowledgeItemT, type MemoryCandidate } from '../../../services/api';
import { STREAM_CHAT } from '../../../services/config';
import { generateStream, type StreamControl } from '../../../services/streaming';
import { requestWechatSubscribe } from '../../../services/wechatSubscribe';
import { checkUpload } from '../../../services/uploadGuard';
import { sourceUploadName } from '../../../services/uploadName';
import { agentForText } from '../../../data/intents';
import { ADVISOR_ALIAS, CORE_SPECIALISTS, DISPATCH_SUGGESTIONS } from '../../../data/council';
import { CHAT_GUIDES } from '../../../data/operatingSystem';
import { acceptDeliverable } from '../../../services/dossier';
import { navTo } from '../../../services/nav';
import './index.scss';

type Msg =
  | { role: 'greet'; agent: Agent }
  | { role: 'user'; text: string; refs?: MessageRef[] }
  | { role: 'assistant'; reply: ChatReplyT; knowledgeUsed?: string[]; refNotices?: string[]; retryText?: string; streaming?: boolean }
  | { role: 'report'; deliverable: Deliverable; animate: boolean; saved?: boolean; messageId?: string; knowledgeUsed?: string[]; refNotices?: string[]; streaming?: boolean; retryText?: string }
  | { role: 'memory'; agentName: string };

// 报告 V2：把一个 section（含 9 种类型）降级成纯文本行。用 any 读取以容忍存量脏数据/未来类型。
function sectionToLines(sec: Section): string[] {
  const s = sec as any;
  const cell = (c: string | { text: string; trend?: 'up' | 'dn' }) => (typeof c === 'string' ? c : c?.text ?? '');
  const out: string[] = [];
  switch (s.type) {
    case 'hero':
      out.push(`【${s.h}】`);
      (s.paras ?? []).forEach((p: string) => out.push(p));
      break;
    case 'callout':
      out.push(`【${s.tone}】${s.h}`);
      if (s.b) out.push(s.b);
      break;
    case 'stats':
      if (s.h) out.push(`【${s.h}】`);
      (s.items ?? []).forEach((it: any) => out.push(`${it.num}${it.unit ?? ''} ${it.label}`));
      break;
    case 'roster':
      if (s.h) out.push(`【${s.h}】`);
      if (s.intro) out.push(s.intro);
      (s.people ?? []).forEach((p: any) => out.push(`· ${p.name}${p.role ? `（${p.role}）` : ''}：${p.desc}`));
      break;
    case 'table':
      if (s.h) out.push(`【${s.h}】`);
      out.push((s.headers ?? []).join(' | '));
      (s.rows ?? []).forEach((r: any[]) => out.push(r.map(cell).join(' | ')));
      break;
    case 'phases':
      if (s.h) out.push(`【${s.h}】`);
      (s.items ?? []).forEach((it: any) => {
        out.push(`〔${it.tab}〕${it.h}${it.when ? ` · ${it.when}` : ''}`);
        (it.actions ?? []).forEach((a: string) => out.push(`· ${a}`));
        if (it.kpi) out.push(`军令状：${it.kpi}`);
      });
      break;
    case 'timeline':
      if (s.h) out.push(`【${s.h}】`);
      (s.items ?? []).forEach((it: any) => out.push(`${it.when}　${it.h}${it.d ? `：${it.d}` : ''}`));
      break;
    case 'quote':
      out.push(`「${s.text}」`);
      break;
    case 'letter':
      if (s.salute) out.push(s.salute);
      (s.paras ?? []).forEach((p: string) => out.push(p));
      if (s.close) out.push(s.close);
      if (s.sign) out.push(s.sign);
      break;
    default:
      if (s.h) out.push(`【${s.h}】`);
      if (s.b) out.push(s.b);
      if (Array.isArray(s.list)) s.list.forEach((x: string) => out.push(`· ${x}`));
  }
  return out;
}

// 把结构化成果序列化为纯文本，复制到剪贴板（替代尚未实现的 PDF 导出）。
function deliverableToText(d: Deliverable): string {
  const lines: string[] = [d.title];
  if (d.meta) lines.push(d.meta);
  lines.push('');
  for (const sec of d.sections) {
    for (const l of sectionToLines(sec)) lines.push(l);
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

// 军师反问选项：流式期间隐藏正文尾部的 ```ask 结构块（含尚未流完的半截围栏），
// 完整回复（onChat）到达后由服务端剥离过的正文 + 结构化 asks 权威替换。
function visibleStreamText(text: string): string {
  const cut = text.indexOf('```ask');
  const t = cut >= 0 ? text.slice(0, cut) : text;
  return t.replace(/`{1,3}(?:a(?:s(?:k)?)?)?$/, '');
}

// 「其他」选项哨兵值（非用户可见文案，避免与真实选项撞车）。
const ASK_OTHER = '__ask_other__';

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
  // 报告 V2：整段替换/追加完整 section 对象（保留 typed 判别字段），只剥掉传输用的 index。
  // 不再压成 {h,b,list} 子集——cardSection 已能渲染全部 9 种类型，流式期与定格后正文都完整。
  const { index, ...rest } = section;
  const clean = { ...rest, h: rest.h || `第 ${next.length + 1} 段` } as Section;
  if (typeof index === 'number' && index >= 0) next[index] = clean;
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
// 记债项10：报告流失败/降级统一话术——只此一句 + ↻ 重试入口，不再另出「保底草案」提示。
const REPORT_INTERRUPTED_TRUST = '生成中断——已生成部分已保留，可点击重试补全';
const JUMP_LATEST_SHOW_DISTANCE = 420;
const JUMP_LATEST_HIDE_DISTANCE = 140;
// B1 贴底判定阈值：距底 ≤ 此值视为「贴底跟随」，用户上滑超过即暂停自动滚底。
const STICK_BOTTOM_DISTANCE = 120;
// B1 流式跟随节流间隔：onToken/onReportSection 高频触发，滚底最多每 ~300ms 一次。
const FOLLOW_THROTTLE_MS = 300;
// B6 输入计数：临近上限（>1800/2000）才显示字数，平时不打扰。
const INPUT_MAX = 2000;
const INPUT_COUNT_FROM = 1800;
// 粘贴转附卷：单次输入暴增 ≥ 此值且越过 INPUT_MAX，判为「长文粘贴」→ 自动归卷。
const PASTE_DELTA_MIN = 500;
// 粘贴防抖合并窗口：微信 textarea 一次粘贴会连发多个 onInput（devtools 按行拆发），
// 用一个 ~250ms 定时器把这串事件合并成「一次结算」，避免各建一份 knowledge 撞满九份。
const PASTE_SETTLE_MS = 250;
// absorbPasteToFile 去重窗口：10s 内完全相同的 pasted 文本（长度 + 首尾片段指纹）直接跳过，不建第二份。
const PASTE_DEDUP_MS = 10_000;

// 单次插入下，用公共前缀 + 公共后缀 diff 出这回粘进来的文本段。
// prefix：prev 与 v 的公共前缀长；suffix：剩余部分的公共后缀长（上限 = prev.length - prefix，防前后缀重叠）。
function diffPasted(prev: string, v: string): { pasted: string; kept: string } {
  const n = prev.length;
  let prefix = 0;
  while (prefix < n && prev[prefix] === v[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = n - prefix;
  while (suffix < maxSuffix && prev[n - 1 - suffix] === v[v.length - 1 - suffix]) suffix++;
  const pasted = v.slice(prefix, v.length - suffix);
  const kept = v.slice(0, prefix) + v.slice(v.length - suffix);
  return { pasted, kept };
}

const IS_WEAPP = process.env.TARO_ENV === 'weapp';
const UPLOAD_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'md', 'markdown', 'txt'];
// 一次至多带几份：与 server retrieval.MAX_REFS(9) 对齐——选得进来就带得上，不在服务端悄悄丢。
const UPLOAD_COUNT_MAX = 9;
// 一批总量上限。单份 20MB 是 MAX_UPLOAD_BYTES（对齐服务端 multipart 上限），但 9 份 × 20MB = 180MB
// 一批就能吃掉本月 200MB 免费额度的九成——真传上去也是逐份 402，不如在选完就说清楚。
const MAX_BATCH_UPLOAD_BYTES = 60 * 1024 * 1024; // 60MB/批

// 每份上传的账：真进度 + 真取消都按份记，批次只是这些份的集合。
type UploadStatus = 'waiting' | 'uploading' | 'done' | 'failed' | 'cancelled';
interface UploadEntry { id: string; name: string; size: number; path: string; pct: number; status: UploadStatus; }

const UPLOAD_STATUS_TEXT: Record<UploadStatus, string> = {
  waiting: '候着', uploading: '呈送中', done: '已呈上', failed: '未送达', cancelled: '已撤回',
};

// 引用签的类型称谓（军师文风）：与 @引用选择器分组标题保持一致，附卷=归卷后的知识。
const REF_KIND_LABEL: Record<MessageRef['kind'], string> = {
  project: '案卷', report: '方案', knowledge: '附卷', memory: '军师印象',
};
const REF_KIND_ICON: Record<MessageRef['kind'], string> = {
  project: 'layers', report: 'doc', knowledge: 'doc', memory: 'spark',
};
// 把引用签拆成文件卡：标题行 + 元信息行。label 里「·」分隔的字数等信息拆到元信息行，末尾缀类型名。
function refCardParts(r: MessageRef): { icon: string; title: string; meta: string } {
  const kindName = REF_KIND_LABEL[r.kind] ?? '资料';
  const segs = String(r.label ?? '').split('·').map((s) => s.trim()).filter(Boolean);
  const title = segs[0] || r.label || kindName;
  const extra = segs.slice(1).join(' · ');
  return { icon: REF_KIND_ICON[r.kind] ?? 'doc', title, meta: extra ? `${extra} · ${kindName}` : kindName };
}

/**
 * 引用未尽之处（服务端 refNotices）：超过 9 份被丢下的、仍在拆读的、读不出的——都在气泡下明说。
 * 静默丢弃是最钝的刀：客户以为军师读了那 12 份，其实只读了 9 份。
 */
function RefNotices({ notices }: { notices?: string[] }) {
  if (!notices?.length) return null;
  return (
    <View className="ref-notices">
      {notices.map((n, i) => <Text key={i} className="rn-line">※ {n}</Text>)}
    </View>
  );
}

function fmtBytes(b: number): string {
  if (!b) return '—';
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

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
  // 粘贴合并：同步追踪输入框最新值（React state 在同步事件串里是陈旧的，不能当 prev 用）。
  // 所有给 setInput 赋值处都要同步维护此 ref，否则粘贴增量判定会错。
  const lastValueRef = useRef('');
  // 粘贴 burst：命中一次长文暴增即记 baseline（暴增前的输入），burst 期间每个 onInput 都重置结算定时器。
  const pasteBurstRef = useRef<{ baseline: string } | null>(null);
  const pasteSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 粘贴去重：记上次已归卷 pasted 的指纹（长度 + 首尾片段）与时间戳，窗口内完全相同的直接跳过。
  const recentPasteRef = useRef<{ sig: string; at: number } | null>(null);
  // 粘贴转附卷：在途份数（await createKnowledge 期间计数），与 refs 合并判九份上限、防并发超挂。
  const pasteInflightRef = useRef(0);
  const sessionIdRef = useRef('');
  sessionIdRef.current = sessionId;
  // B5 上传：非模态进度条，接 UploadTask 透出真实百分比；取消调 task.abort() 真中止。
  // 多份上传后按「份」记账（不退化成整批一个进度条）：每份各有真进度、各能单独取消/重试。
  const [uploads, setUploads] = useState<Record<string, UploadEntry>>({});
  const uploadCancelledRef = useRef<Record<string, boolean>>({});
  const uploadTasksRef = useRef<Record<string, Taro.UploadTask | null>>({});
  const uploadList = Object.values(uploads);
  const uploading = uploadList.some((u) => u.status === 'waiting' || u.status === 'uploading');
  // 刚传上来的资料还在后台拆读（解析异步），此刻发问军师未必读得到正文——引用签上标「拆读中」明示。
  // 不轮询：签只从「挂上引用」活到「发出这一轮」；发出后由服务端 refNotices 据实回话（谁没读完、谁读不出）。
  const [parsingRefIds, setParsingRefIds] = useState<string[]>([]);
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
        winHeightRef.current = Number(Taro.getWindowInfo().windowHeight || 0);
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

  useEffect(() => () => {
    if (pasteSettleTimerRef.current) clearTimeout(pasteSettleTimerRef.current);
    store.setOverlay(false, 'ref-picker');
  }, []);

  // B3 草稿持久化：按 sessionId 维度存/取；发送成功后清除。
  const loadDraft = (id?: string) => {
    try { const d = Taro.getStorageSync(draftKeyFor(id)); if (d && typeof d === 'string') { setInput(d); lastValueRef.current = d; } } catch { /* noop */ }
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
    let lastUserText = '';
    messages.forEach((m) => {
      if (m.role === 'user') { lastUserText = m.content?.text || ''; out.push({ role: 'user', text: m.content.text, refs: m.refs }); }
      // B4：已入库真值——优先取服务端字段（若有），否则回落到本地保存记录，避免已入库方案重复显示「存入方案库」。
      else if (m.role === 'report') {
        const deliverable = m.content as Deliverable;
        // 记债项10：还原历史里的降级/中断报告——统一中断话术 + ↻ 重试入口（与实时失败一致）。
        const degraded = !!deliverable?.degraded;
        out.push({
          role: 'report',
          deliverable: degraded ? { ...deliverable, trust: REPORT_INTERRUPTED_TRUST } : deliverable,
          animate: false, messageId: m.id,
          saved: !!((m as { saved?: boolean }).saved || (deliverable as { saved?: boolean })?.saved || isReportSaved(m.id)),
          retryText: degraded && lastUserText ? lastUserText : undefined,
        });
      }
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
      // 报告 / 聊天分流完全由后端 SSE meta 事件决定，前端不再检查消息文本。
      // 后端 send('meta',{kind}) 必先于 begin/token 到达，且后端本就按自己的判定（含 on-demand 侧的
      // 服务端正则）决定本轮 kind——前端再用正则猜只会与之错配。故删除 wantsDeliverableRequest：
      // 是否走流式仅取决于配置（STREAM_CHAT 开关 + 有 agent），骨架形态由 meta 回调决定
      // （kind=report → onReportStart 建报告骨架；kind=chat → onChatStart 建聊天气泡）。
      // 路由带 send= 自动发送时，React state 里的 agent 可能还没刷新；必须按本次 agentKey 重新取配置。
      const sendingAgent = findAgent(agentKey) || agent;
      const body = { text, sessionId: sid || undefined, agentKey, projectId: activeProjectId || undefined, refs: sendRefs.length ? sendRefs : undefined };
      const canStream = STREAM_CHAT && !!sendingAgent;

      const showMemoryLearned = (agentName: string, delay: number) => {
        setTimeout(() => {
          setMsgs((m) => [...m, { role: 'memory', agentName }]);
          scrollToEnd();
        }, delay);
      };
      const renderGenerateResult = (res: Awaited<ReturnType<typeof api.generate>>, replaceStreamingAssistant = false) => {
        if (res.sessionId && !sid) setSessionId(res.sessionId);
        if (res.kind === 'report' && res.deliverable) {
          // 记债项10：降级（保底）草案与流式中断统一话术——挂 ↻ 重试、trust 行合一，不再另出「保底草案」提示。
          const degraded = !!res.deliverable.degraded;
          const reportMsg: Extract<Msg, { role: 'report' }> = {
            role: 'report',
            deliverable: degraded ? { ...res.deliverable, trust: REPORT_INTERRUPTED_TRUST } : res.deliverable,
            animate: true,
            messageId: res.messageId,
            knowledgeUsed: res.knowledgeUsed,
            refNotices: res.refNotices,
            retryText: degraded ? text : undefined,
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
                copy[i] = { role: 'assistant', reply: res.reply!, knowledgeUsed: res.knowledgeUsed, refNotices: res.refNotices };
                return copy;
              }
            }
            return [...m, { role: 'assistant', reply: res.reply!, knowledgeUsed: res.knowledgeUsed, refNotices: res.refNotices }];
          });
        }
      };

      if (canStream) {
        // 统一流式入口：一条流同时挂 report 与 chat 两套回调，走哪种骨架由后端 meta 事件决定
        // （meta kind=report → onReportStart 建报告骨架；kind=chat → onChatStart 建聊天气泡）。
        // 二者仅是 UI 形态差异、共用同一 /generate SSE 接口，故合并为一条路径，不再按消息内容前置分流。
        let reportStarted = false;
        let chatStarted = false;
        let streamErrored = false; // onError 是否已就地渲染过错误——避免静默失败兜底时二次补发
        let learnedAgentName = '';
        // meta 先于 begin/token 到达，此刻气泡还没建；先攒着，收尾时一并挂到气泡上。
        let pendingRefNotices: string[] = [];
        const patchReport = (
          fn: (d: Deliverable) => Deliverable,
          extra: Partial<Extract<Msg, { role: 'report' }>> = {},
          // 收尾语义开关：appendIfMissing=false 时，仅当存在「末条且仍 streaming 的报告卡」才原地更新，
          // 否则 no-op——绝不追加新卡。用于 onDone/finally 这类「置 streaming:false」的收尾调用，
          // 避免收尾时守卫不命中而落到 append 分支、追加一张不落库的幽灵骨架卡。
          opts: { appendIfMissing?: boolean } = {},
        ) => {
          const { appendIfMissing = true } = opts;
          setMsgs((m) => {
            const i = m.length - 1;
            if (i >= 0 && m[i].role === 'report' && (m[i] as { streaming?: boolean }).streaming) {
              const copy = m.slice();
              const cur = copy[i] as Extract<Msg, { role: 'report' }>;
              copy[i] = { ...cur, ...extra, deliverable: fn(cur.deliverable) };
              return copy;
            }
            if (!appendIfMissing) return m;
            return [...m, { role: 'report', deliverable: fn(reportDraft(sendingAgent)), animate: false, streaming: true, ...extra }];
          });
        };
        const startReport = () => {
          if (reportStarted) return;
          reportStarted = true;
          patchReport((d) => d);
          setTimeout(scrollToEnd, 30);
        };
        // kind=chat 路径：后端本轮判为普通聊天（meta kind=chat 或直接来 token/chat），走聊天气泡而非报告卡。
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
          // meta kind=chat：先建聊天气泡（think-dots），避免 LLM 首字延迟期只剩全局 busy 无反馈。
          onChatStart: startChat,
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
          onRefNotices: (ns) => { pendingRefNotices = ns; },
          onMemory: (data) => {
            if (data.learned && data.agentName) learnedAgentName = data.agentName;
          },
          onDone: (messageId) => {
            const refNotices = pendingRefNotices.length ? pendingRefNotices : undefined;
            if (reportStarted) {
              // 收尾时从更新器内抓完整 deliverable 引用（避免陈旧闭包/state），随后微任务里静默自动存入。
              let doneDeliverable: Deliverable | undefined;
              patchReport((d) => { doneDeliverable = d; return d; }, { streaming: false, messageId, refNotices }, { appendIfMissing: false });
              // 自动存入仅对本次新生成完成的报告触发（历史加载走 restore、不经 onDone）；成功静默点亮 saved，失败留「存入」兜底。
              if (messageId) {
                Promise.resolve().then(() => {
                  const dl = doneDeliverable
                    ?? ([...logRef.current].reverse().find((x) => x.role === 'report') as Extract<Msg, { role: 'report' }> | undefined)?.deliverable;
                  if (dl) saveDeliverable(dl, messageId, { auto: true });
                });
              }
            } else if (chatStarted) {
              patchChat((msg) => ({ ...msg, streaming: false, refNotices }));
            }
            if (learnedAgentName) showMemoryLearned(learnedAgentName, 600);
            followBottom(true);
          },
          onError: (em) => {
            streamErrored = true;
            const retry = isModerationErr(em) ? undefined : text;
            if (reportStarted) {
              // 记债项10：报告流失败语义收敛为单一话术。审核类错误不给重试（重试必再被拦）。
              setMsgs((m) => {
                const i = m.length - 1;
                if (!(i >= 0 && m[i].role === 'report' && (m[i] as { streaming?: boolean }).streaming)) return m;
                const cur = m[i] as Extract<Msg, { role: 'report' }>;
                const copy = m.slice();
                if (cur.deliverable.sections.length > 0) {
                  // 有部分内容：保留已流出分段，trust 行统一为中断话术 + ↻ 重试；
                  // degraded 仅留作状态位（供后端/埋点、免扣额度），UI 不再另出「保底草案」提示。
                  copy[i] = {
                    ...cur,
                    streaming: false,
                    retryText: retry,
                    deliverable: { ...cur.deliverable, trust: REPORT_INTERRUPTED_TRUST, degraded: true },
                  };
                } else {
                  // 完全无内容：不留半空报告卡，改普通错误气泡 + 重试（对齐聊天气泡）。
                  copy[i] = { role: 'assistant', reply: { text: em || '生成失败' }, retryText: retry };
                }
                return copy;
              });
            } else if (chatStarted) {
              patchChat((msg) => ({ ...msg, reply: { text: em || '生成失败' }, retryText: retry, streaming: false }));
            } else {
              // 错误早于任何 meta（如 HTTP 层直接失败）：既无报告卡也无聊天气泡可就地更新，补一条错误气泡 + 重试。
              setMsgs((m) => [...m, { role: 'assistant', reply: { text: em || '生成失败' }, retryText: retry }]);
            }
          },
        }, control);
        // B2：主动停止时不兜底重发。report 卡由 finally 收尾；chat 气泡就地收干净——
        // 还没吐出任何字的空占位（onChatStart 已抢先建好）直接移除，避免留下空壳。
        if (abortedRef.current) {
          if (chatStarted) {
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
          }
        } else if (!streamOk && !reportStarted && !streamErrored) {
          // 静默失败（流未正常收尾、onError 从未触发、且未进 report 分支）：同步补发一次。
          // replaceStreamingAssistant=true——若 onChatStart 已建了空聊天占位，用真实结果替换它而非再追加一条；
          // 若连占位都没建（error 早于 meta 那条已由 onError 落气泡、不会走到这里），则自然追加。
          // report 分支的静默失败由下方 finally 收尾（把报告卡 streaming 置 false），不在此重发。
          const res = await api.generate(body);
          renderGenerateResult(res, true);
        }
        } finally {
          // P0-5 双保险：报告流无论 promise 结果（含中途抛错/主动停止），最终强制把报告卡 streaming 置 false，
          // 避免流正常收尾却未触发 onDone/onError 时报告卡永久停在「产出中」。
          // patchReport 仅改「末条且仍 streaming」的报告卡，onDone 已收尾时此处为幂等 no-op。
          // appendIfMissing:false——onDone 已把报告卡置 streaming:false 后守卫不再命中，
          // 此处若仍走 append 会追加一张不落库的幽灵骨架卡（老 bug：先后两张卡 + 重进少一张）。
          if (reportStarted) patchReport((d) => d, { streaming: false }, { appendIfMissing: false });
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

  // —— 军师反问选项（ChatReply.asks）——
  // 只在「最后一条实质消息」是带 asks 的军师回复时激活（其后一旦出现用户消息/报告即自然失效，无需记答题状态）。
  let activeAskIdx = -1;
  if (!busy) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const mm = msgs[i];
      if (mm.role === 'memory' || mm.role === 'greet') continue;
      if (mm.role === 'assistant' && !mm.streaming && mm.reply.asks?.length) activeAskIdx = i;
      break;
    }
  }
  const activeAsks = activeAskIdx >= 0 ? (msgs[activeAskIdx] as Extract<Msg, { role: 'assistant' }>).reply.asks! : [];
  // 选择草稿按消息索引挂靠：换了一条新的提问消息即自动作废旧草稿。
  const [askDraft, setAskDraft] = useState<{ idx: number; sel: Record<number, string>; other: Record<number, string> }>({ idx: -1, sel: {}, other: {} });
  const [askComposerTarget, setAskComposerTarget] = useState<{ idx: number; qi: number } | null>(null);
  const askSel = askDraft.idx === activeAskIdx ? askDraft.sel : {};
  const askOther = askDraft.idx === activeAskIdx ? askDraft.other : {};
  const activeAskComposer = askComposerTarget?.idx === activeAskIdx ? askComposerTarget : null;
  const clearAskComposer = () => {
    setAskComposerTarget(null);
    setKeyboardHeight(0);
  };
  const openAskComposer = (qi: number) => {
    setAskDraft((d) => {
      const sel = d.idx === activeAskIdx ? d.sel : {};
      const other = d.idx === activeAskIdx ? d.other : {};
      return { idx: activeAskIdx, sel: { ...sel, [qi]: ASK_OTHER }, other };
    });
    setInputFocus(false);
    setAskComposerTarget({ idx: activeAskIdx, qi });
    setTimeout(scrollToEnd, 40);
  };
  const pickAskOption = (qi: number, val: string) => {
    if (busy) return;
    if (val === ASK_OTHER) {
      openAskComposer(qi);
      return;
    }
    if (activeAskComposer?.qi === qi) clearAskComposer();
    // 单问题：点普通选项即发送（对齐开场白 chips 的直觉）。
    if (activeAsks.length === 1) {
      doSend(val, sessionId, agent?.key ?? '');
      return;
    }
    // 函数式更新：快速连点多题时避免闭包旧值互相覆盖。
    setAskDraft((d) => {
      const sel = d.idx === activeAskIdx ? d.sel : {};
      const other = d.idx === activeAskIdx ? d.other : {};
      return { idx: activeAskIdx, sel: { ...sel, [qi]: sel[qi] === val ? '' : val }, other };
    });
  };
  const setAskOtherText = (qi: number, text: string) =>
    setAskDraft((d) => {
      const sel = d.idx === activeAskIdx ? d.sel : {};
      const other = d.idx === activeAskIdx ? d.other : {};
      return { idx: activeAskIdx, sel: { ...sel, [qi]: ASK_OTHER }, other: { ...other, [qi]: text } };
    });
  const finishAskOther = (qi: number, raw: string) => {
    const value = raw.trim();
    clearAskComposer();
    if (activeAsks.length === 1 && value && agent) doSend(value, sessionId, agent.key);
  };
  const askAnswerOf = (qi: number): string =>
    askSel[qi] === ASK_OTHER ? (askOther[qi] ?? '').trim() : (askSel[qi] ?? '');
  const askAnsweredCount = activeAsks.filter((_, qi) => !!askAnswerOf(qi)).length;
  const askReady = activeAsks.length > 1 && askAnsweredCount === activeAsks.length;
  const sendAskAnswers = () => {
    if (!askReady || busy) return;
    setAskComposerTarget(null);
    const lines = activeAsks.map((a, qi) => `${a.q} ${askAnswerOf(qi)}`);
    doSend(lines.join('\n'), sessionId, agent?.key ?? '');
  };

  // pasted 指纹：长度 + 首尾片段，够区分「同一段粘贴」而无需存整段。
  const pasteSig = (pasted: string) => `${pasted.length}:${pasted.slice(0, 32)}:${pasted.slice(-32)}`;

  // 长文粘贴 → 归为附卷：异步建知识，成功挂引用签；期间不卡输入。fullValue = 粘贴后完整文本，供满卷/失败时回填。
  const absorbPasteToFile = async (pasted: string, fullValue: string) => {
    // 保险丝：10s 内完全相同的 pasted 直接跳过，绝不建第二份（防同一次粘贴被结算两次）。
    const sig = pasteSig(pasted);
    const now = Date.now();
    if (recentPasteRef.current && recentPasteRef.current.sig === sig && now - recentPasteRef.current.at < PASTE_DEDUP_MS) return;
    recentPasteRef.current = { sig, at: now };
    // 满卷判断已上提至结算处；此处仅做成功 setter 里的二次核验防并发越挂。
    const title = `粘贴长文·${pasted.length}字`;
    pasteInflightRef.current += 1;
    Taro.showToast({ title: '长文归卷中…', icon: 'none' });
    try {
      const { id } = await api.createKnowledge({ kind: 'document', title, text: pasted, sourceType: 'paste' });
      // ready 状态，无需标「拆读中」；再核一次上限，防并发越挂。
      setRefs((cur) => (cur.length >= UPLOAD_COUNT_MAX || cur.some((x) => x.kind === 'knowledge' && x.id === id))
        ? cur : [...cur, { kind: 'knowledge', id, label: title }]);
    } catch {
      setInput(fullValue); lastValueRef.current = fullValue; // 归卷未成：长文塞回输入框，不丢字
      Taro.showToast({ title: '长文归卷未成，稍后再试', icon: 'none' });
    } finally {
      pasteInflightRef.current -= 1;
    }
  };

  // 粘贴 burst 结算：定时器到点后统一算一次账。以 lastValueRef 为准（同步、非陈旧），
  // 与 baseline 对比确认确为长文暴增，才 diff 出 pasted、只调一次 absorbPasteToFile。
  const settlePaste = () => {
    pasteSettleTimerRef.current = null;
    const burst = pasteBurstRef.current;
    pasteBurstRef.current = null;
    if (!burst) return;
    const baseline = burst.baseline;
    const final = lastValueRef.current;
    if (!(final.length > INPUT_MAX && final.length - baseline.length >= PASTE_DELTA_MIN)) return;
    const { pasted, kept } = diffPasted(baseline, final);
    if (!pasted) return;
    // 附卷已满九份：不转，完整粘贴内容留在输入框，容主公自行取舍。
    if (refs.length + pasteInflightRef.current >= UPLOAD_COUNT_MAX) {
      Taro.showToast({ title: `附卷已满${UPLOAD_COUNT_MAX}份，容后再呈`, icon: 'none' });
      return;
    }
    void absorbPasteToFile(pasted, final);
    setInput(kept); lastValueRef.current = kept;
  };

  const handleInput = (e: { detail: { value: string } }) => {
    if (busy) return input;
    const v = e.detail.value;
    const prevSync = lastValueRef.current;
    lastValueRef.current = v;
    // burst 期间照常上屏（允许输入框暂时显示超长文本），归卷与否交由结算定时器统一裁决——
    // 单次粘贴在微信里会连发多个 onInput，用同步 ref 当 prev + 防抖合并，避免各自判定各建一份。
    setInput(v);
    if (v.length - prevSync.length >= PASTE_DELTA_MIN && !pasteBurstRef.current) {
      pasteBurstRef.current = { baseline: prevSync };
    }
    if (pasteBurstRef.current) {
      if (pasteSettleTimerRef.current) clearTimeout(pasteSettleTimerRef.current);
      pasteSettleTimerRef.current = setTimeout(settlePaste, PASTE_SETTLE_MS);
    }
    return v;
  };

  const onSend = (raw?: string) => {
    if (busy) return;
    const v = (typeof raw === 'string' ? raw : input).trim();
    if (!v || !agent) return;
    // 软限制守卫：手动堆出的超长（非粘贴）在此拦下——粘贴早已转附卷，不会走到这。
    if (v.length > INPUT_MAX) {
      Taro.showToast({ title: '言过两千，可精简或粘贴成附卷', icon: 'none' });
      return;
    }
    setInput('');
    lastValueRef.current = '';
    // 发送即作废在途的粘贴结算，免得定时器到点后把已清空/新输入误判成粘贴。
    if (pasteSettleTimerRef.current) { clearTimeout(pasteSettleTimerRef.current); pasteSettleTimerRef.current = null; }
    pasteBurstRef.current = null;
    setInputFocus(false);
    const sending = refs;
    setRefs([]);
    setParsingRefIds([]); // 引用签已随本轮发出；之后谁没读完由服务端 refNotices 据实说
    doSend(v, sessionId, agent.key, sending);
  };

  const onKeyboardHeightChange = (e: { detail?: { height?: number } }) => {
    const next = Math.max(0, Number(e.detail?.height || 0));
    setKeyboardHeight(next);
    if (next > 0) setTimeout(scrollToEnd, 40);
  };

  // 卡片 saved 态点亮：把该 messageId 的报告消息标记 saved（供 ReportCard saved prop 同步、历史 restore 一致）。
  const markMsgSaved = (messageId?: string) => {
    if (!messageId) return;
    setMsgs((m) => m.map((x) => (x.role === 'report' && x.messageId === messageId ? { ...x, saved: true } : x)));
  };

  // 存入方案库。opts.auto=true：报告收尾后静默自动入库——失败不弹错、留「存入」兜底；成功也不弹 toast（用户没点按钮）。
  const saveDeliverable = async (d: Deliverable, messageId?: string, opts: { auto?: boolean } = {}) => {
    if (!agent) return;
    const body = {
      // 三势研判入口进来的，type 打成「{势}研判」（如 市势研判），战局卡按 type 可靠反查
      title: d.title, type: forceTag ? `${forceTag}研判` : (agent.deliverableKey || d.title), agentKey: agent.key,
      sessionId: sessionId || undefined, content: d as any, projectId: projectId || undefined,
      ...(opts.auto ? { auto: true } : {}),
    };
    if (opts.auto) {
      const ok = await api.saveToLibrary(body).then(() => true).catch(() => false);
      if (!ok) return; // 静默失败：不打扰，卡片保留「存入」兜底
      markReportSaved(messageId);
      markMsgSaved(messageId);
      return;
    }
    // 手动路径：保留原有乐观行为 + toast
    await api.saveToLibrary(body).catch(() => {});
    // B4：本地记下已入库的报告 messageId，历史 restore 时回填 saved 真值，避免重复显示「存入方案库」。
    markReportSaved(messageId);
    markMsgSaved(messageId);
    Taro.showToast({ title: '已存入方案库', icon: 'none' });
  };

  // 认可方案：存入方案库（桥接一版报告）+ 服务端生成案卷军令 → 去执行页承接打卡与回填
  // 点击即出 loading + 防连点（2026-07-22 事故教训：接口一慢用户连点 8 次还以为按钮坏了）
  const acceptingRef = useRef(false);
  const acceptPlan = async (d: Deliverable, messageId?: string) => {
    if (acceptingRef.current) return;
    acceptingRef.current = true;
    Taro.showLoading({ title: '军令拟定中…', mask: true });
    try {
      const r = await acceptDeliverable(d, agent?.name || '军师', forceTag || undefined).catch(() => null);
      Taro.hideLoading();
      if (!r) { Taro.showToast({ title: '案卷生成未成，稍后再试', icon: 'none' }); return; }
      if (!r.newOrders && r.skippedOrders) {
        Taro.showToast({ title: '这份方案已转成军令，不重复添加', icon: 'none' });
        return;
      }
      await saveDeliverable(d, messageId);
      Taro.showToast({ title: r.newOrders ? `已生成案卷 · ${r.newOrders} 条军令待执行` : '已生成案卷', icon: 'none' });
      setTimeout(() => Taro.switchTab({ url: '/pages/studio/index' }), 620);
    } finally {
      acceptingRef.current = false;
    }
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

  // 公共段：确保网页版已生成（拿到 /api/r/:id）→ 推导 PDF 链接 → weapp downloadFile 落沙盒。
  // 返回 { filePath, fileName } 供「查看/保存」与「发给好友」两个 PDF 项复用；失败返回 null（已 toast + hideLoading）。
  const downloadReportPdfLocal = async (messageId?: string, title?: string): Promise<{ filePath: string; fileName: string } | null> => {
    if (!sessionId || !messageId) { Taro.showToast({ title: '请先产出方案', icon: 'none' }); return null; }
    Taro.showLoading({ title: '军师装订中…' });
    try {
      const r = await api.renderReport(sessionId, messageId);
      const pdfUrl = reportPdfUrl(r.htmlUrl);
      if (!pdfUrl) { Taro.hideLoading(); Taro.showToast({ title: '本地预览模式无 PDF', icon: 'none' }); return null; }
      const safe = (title || '战略报告').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || '战略报告';
      const fileName = `${safe}·军师参谋部.pdf`;
      const filePath = `${Taro.env.USER_DATA_PATH}/${fileName}`;
      const dl = await Taro.downloadFile({ url: pdfUrl, filePath });
      Taro.hideLoading();
      if (dl.statusCode !== 200) { Taro.showToast({ title: '生成失败，请重试', icon: 'none' }); return null; }
      return { filePath: dl.filePath || filePath, fileName };
    } catch {
      Taro.hideLoading();
      Taro.showToast({ title: '生成失败，请重试', icon: 'none' });
      return null;
    }
  };

  // 查看 / 保存 PDF：weapp 下沙盒 → openDocument（可再转发/存本地）；H5：开新窗直接下载。
  const downloadReportPdf = async (messageId?: string, title?: string) => {
    if (IS_WEAPP) {
      const f = await downloadReportPdfLocal(messageId, title);
      if (!f) return;
      await Taro.openDocument({ filePath: f.filePath, fileType: 'pdf', showMenu: true });
      return;
    }
    // H5：无沙盒/openDocument，直接开新窗下载。
    if (!sessionId || !messageId) { Taro.showToast({ title: '请先产出方案', icon: 'none' }); return; }
    Taro.showLoading({ title: '军师装订中…' });
    try {
      const r = await api.renderReport(sessionId, messageId);
      const pdfUrl = reportPdfUrl(r.htmlUrl);
      Taro.hideLoading();
      if (!pdfUrl) { Taro.showToast({ title: '本地预览模式无 PDF', icon: 'none' }); return; }
      if (typeof window !== 'undefined' && window.open) window.open(pdfUrl, '_blank');
      else Taro.showToast({ title: '请在小程序内下载 PDF', icon: 'none' });
    } catch {
      Taro.hideLoading();
      Taro.showToast({ title: '生成失败，请重试', icon: 'none' });
    }
  };

  // PDF 发给好友：下沙盒 → shareFileMessage（基础库 2.16.1+）；失败降级 openDocument + 提示从右上角转发。
  const sharePdfToFriend = async (messageId?: string, title?: string) => {
    const f = await downloadReportPdfLocal(messageId, title);
    if (!f) return;
    try {
      await Taro.shareFileMessage({ filePath: f.filePath, fileName: f.fileName });
    } catch {
      Taro.showToast({ title: '点右上角「···」即可转发这份文件', icon: 'none' });
      Taro.openDocument({ filePath: f.filePath, fileType: 'pdf', showMenu: true }).catch(() => {});
    }
  };

  // 成果卡「分享」选单里由父级承接的三项（图片两项在 ReportCard 内自持出图）。
  const onReportShareMenu = (kind: 'pdfFriend' | 'pdfView' | 'copy', d: Deliverable, messageId?: string) => {
    if (kind === 'copy') { copyDeliverable(d); return; }
    if (kind === 'pdfFriend') { sharePdfToFriend(messageId, d?.title); return; }
    downloadReportPdf(messageId, d?.title); // pdfView
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
  // 多份：先全量校验（任一不合规就整批不传，免得传到一半才发现），再串行逐份呈送，
  // 每份传完立刻挂引用——客户看得见资料一份份进来，不必干等整批。
  const uploadMaterial = async () => {
    if (!IS_WEAPP) { Taro.showToast({ title: '请在微信小程序内上传文件', icon: 'none' }); return; }
    const guide = await Taro.showModal({
      title: '从微信聊天选择文件',
      content: `微信只允许小程序选取「聊天里的文件」。请先把资料发给「文件传输助手」（电脑端微信也能发），下一步选它即可。这不是转发，是选文件。一次最多 ${UPLOAD_COUNT_MAX} 份。`,
      confirmText: '去选择',
      cancelText: '取消',
    });
    if (!guide.confirm) return;
    let chosen: Taro.chooseMessageFile.SuccessCallbackResult;
    try {
      chosen = await Taro.chooseMessageFile({ count: UPLOAD_COUNT_MAX, type: 'file', extension: UPLOAD_EXT });
    } catch (e) {
      const msg = String((e as { errMsg?: string })?.errMsg || '');
      if (!/cancel/i.test(msg)) Taro.showToast({ title: '没能打开文件选择，请重试', icon: 'none' });
      return; // 用户取消则静默
    }
    const files = chosen.tempFiles || [];
    if (!files.length) return;

    // —— 全量前置校验：一份不合规即整批不发，并把选择器重开一次让客户改了再来 ——
    const retry = (title: string, content: string) => {
      Taro.showModal({ title, content, confirmText: '重选', cancelText: '算了' }).then((r) => { if (r.confirm) uploadMaterial(); });
    };
    for (const f of files) {
      const ext = (f.name?.split('.').pop() || '').toLowerCase();
      if (!UPLOAD_EXT.includes(ext)) {
        retry('这份资料递不进来', `「${f.name}」是 .${ext}，军中只认 PDF／Word／Excel／MD／TXT。`);
        return;
      }
      // 单份体积上限（与 server multipart 20MB 对齐），避免放行后被服务端 413 拒绝、
      // 只留一句无信息量的「HTTP 413」。
      const chk = checkUpload({ name: f.name, size: f.size });
      if (!chk.ok) {
        retry(chk.title || '这份资料递不进来', chk.desc || `「${f.name}」不合上传之规。`);
        return;
      }
    }
    const totalBytes = files.reduce((n, f) => n + (f.size || 0), 0);
    if (totalBytes > MAX_BATCH_UPLOAD_BYTES) {
      retry('这一批太重了', `${files.length} 份共 ${fmtBytes(totalBytes)}，一次至多 ${fmtBytes(MAX_BATCH_UPLOAD_BYTES)}。分几批递上来即可。`);
      return;
    }

    // —— 逐份建账 → 串行呈送 ——
    const batch: UploadEntry[] = files.map((f, i) => ({
      id: `up-${Date.now()}-${i}`,
      name: sourceUploadName(f.name) || '待识别资料',
      size: f.size || 0,
      path: f.path,
      pct: 0,
      status: 'waiting' as UploadStatus,
    }));
    setUploads((cur) => ({ ...cur, ...Object.fromEntries(batch.map((u) => [u.id, u])) }));
    for (const u of batch) await runUpload(u); // 串行：一份一份来，不抢带宽也不乱了进度
    // 收摊：成功/撤回的行退场（成功的已化作引用签，不必再占地方），只留没送到的候客户重递或删掉。
    setUploads((cur) => {
      const next = { ...cur };
      let ok = 0;
      for (const u of batch) {
        const st = next[u.id]?.status;
        if (st === 'done') ok++;
        if (st === 'done' || st === 'cancelled') delete next[u.id];
      }
      if (ok) Taro.showToast({ title: `${ok} 份已呈上，拆读中…可直接发问`, icon: 'none' });
      return next;
    });
  };

  // 单份呈送：真进度（onProgress）+ 真取消（UploadTask.abort）都按份记账。
  const patchUpload = (id: string, patch: Partial<UploadEntry>) =>
    setUploads((cur) => (cur[id] ? { ...cur, [id]: { ...cur[id], ...patch } } : cur));

  const runUpload = async (u: UploadEntry) => {
    uploadCancelledRef.current[u.id] = false;
    patchUpload(u.id, { status: 'uploading', pct: 0 });
    try {
      const { id } = await api.uploadKnowledge(u.path, projectId || undefined, undefined, undefined, u.name, {
        onProgress: (p) => patchUpload(u.id, { pct: p }),
        onTask: (t) => { uploadTasksRef.current[u.id] = t; },
      });
      if (uploadCancelledRef.current[u.id]) return; // 已撤回：结果不挂引用
      patchUpload(u.id, { status: 'done', pct: 100 });
      // 传完就挂——不等整批，客户能一份份看着资料进来。挂上时正文多半还在拆读，先给引用签标上。
      setRefs((cur) => cur.some((x) => x.kind === 'knowledge' && x.id === id) ? cur : [...cur, { kind: 'knowledge', id, label: u.name }]);
      setParsingRefIds((cur) => cur.includes(id) ? cur : [...cur, id]);
    } catch (e) {
      if (uploadCancelledRef.current[u.id]) return; // 撤回引发的失败静默
      patchUpload(u.id, { status: 'failed' });
      Taro.showToast({ title: (e as Error).message || `「${u.name}」没能呈上`, icon: 'none' });
    } finally {
      uploadTasksRef.current[u.id] = null;
    }
  };

  // 撤回单份：真中止传输，不空等；已挂上的引用一并摘掉。
  const cancelUpload = (id: string) => {
    uploadCancelledRef.current[id] = true;
    uploadTasksRef.current[id]?.abort();
    uploadTasksRef.current[id] = null;
    patchUpload(id, { status: 'cancelled' });
  };
  const cancelAllUploads = () => {
    for (const u of uploadList) if (u.status === 'waiting' || u.status === 'uploading') cancelUpload(u.id);
    Taro.showToast({ title: '已全数撤回', icon: 'none' });
  };
  const dropUpload = (id: string) => setUploads((cur) => { const next = { ...cur }; delete next[id]; return next; });
  // 单份重递：递到了就同批次一样退场（已化作引用签），没递到仍留在清单里候着。
  const retryUpload = async (id: string) => {
    const u = uploads[id];
    if (!u) return;
    await runUpload(u);
    setUploads((cur) => {
      if (cur[id]?.status !== 'done') return cur;
      const next = { ...cur };
      delete next[id];
      Taro.showToast({ title: `「${u.name}」已呈上，拆读中`, icon: 'none' });
      return next;
    });
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
            <View className="council-scroll-inner">
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
            </View>
          </ScrollView>
        </View>
      ) : null}

      {/* 对话流 */}
      <ScrollView scrollY className="chat-log" scrollTop={scrollTop} scrollWithAnimation enhanced showScrollbar={false} onScroll={handleLogScroll}>
        <View className="chat-log-inner">
        {/* 合规：AI 生成内容显式标识（《标识办法》2025-09-01 强制） */}
        <View className="chat-ai-note"><Text>内容由 AI 生成，仅供参考</Text></View>
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
                  <View className="uref">
                    {m.refs.map((r, j) => {
                      const c = refCardParts(r);
                      return (
                        <View key={j} className="uref-card">
                          <View className="uref-ic"><Icon name={c.icon} size={15} color={accent} /></View>
                          <View className="uref-tx">
                            <Text className="uref-t">{c.title}</Text>
                            <Text className="uref-m">{c.meta}</Text>
                          </View>
                        </View>
                      );
                    })}
                  </View>
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
                    <MarkdownText text={m.streaming ? visibleStreamText(m.reply.text) : m.reply.text} selectable />
                  )}
                  {m.reply.points && (
                    <View className="points">
                      {m.reply.points.map((p, j) => <View key={j} className="pt"><View className="pd" style={{ background: accent }} /><MarkdownText text={p} className="pt-t" selectable /></View>)}
                    </View>
                  )}
                </View>
                <RefNotices notices={m.refNotices} />
                {/* 军师反问选项卡：保留卡片内填写；可见文字用 View 渲染，键盘由 ScrollView 外的 Textarea 承接。 */}
                {i === activeAskIdx && activeAsks.length ? (
                  <View className="ask-card">
                    <View className="ask-head">
                      <Icon name="pen" size={13} color={accent} />
                      <Text className="ask-head-t">
                        {activeAsks.length > 1 ? '逐题点选，答完一起发给军师' : '点一项直接回复，也可选「其他」自己填'}
                      </Text>
                      {activeAsks.length > 1 ? (
                        <Text className="ask-head-c" style={askAnsweredCount ? { color: accent } : {}}>
                          {askAnsweredCount}/{activeAsks.length}
                        </Text>
                      ) : null}
                    </View>
                    <View className="ask-body">
                      {activeAsks.map((a, qi) => (
                        <View key={qi} className="ask-item">
                          <View className="ask-q">
                            {activeAsks.length > 1 ? (
                              <Text className="ask-qn serif" style={{ color: accent }}>{qi + 1}</Text>
                            ) : null}
                            <Text className="ask-qt">{a.q}</Text>
                          </View>
                          <View className="ask-opts">
                            {a.options.map((op) => (
                              <View
                                key={op}
                                className={`ask-chip ${askSel[qi] === op ? 'on' : ''}`}
                                style={askSel[qi] === op ? { background: accent, borderColor: accent } : {}}
                                onClick={() => pickAskOption(qi, op)}
                              >
                                <Text>{op}</Text>
                              </View>
                            ))}
                            <View
                              className={`ask-chip other ${askSel[qi] === ASK_OTHER ? 'on' : ''}`}
                              style={askSel[qi] === ASK_OTHER ? { background: accent, borderColor: accent } : {}}
                              onClick={() => pickAskOption(qi, ASK_OTHER)}
                            >
                              <Text>其他…</Text>
                            </View>
                          </View>
                          {askSel[qi] === ASK_OTHER ? (
                            <View
                              className={`ask-other-input ${activeAskComposer?.qi === qi ? 'focus' : ''}`}
                              onClick={() => openAskComposer(qi)}
                            >
                              <Text className={askOther[qi] ? 'ask-other-value' : 'ask-other-placeholder'}>
                                {askOther[qi] || '输入你的答案…'}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                      ))}
                    </View>
                    {activeAsks.length > 1 ? (
                      <View className="ask-foot">
                        <View
                          className={`ask-send ${askReady ? '' : 'off'}`}
                          style={askReady ? { background: accent } : {}}
                          onClick={sendAskAnswers}
                        >
                          {askReady ? <Icon name="up" size={14} color="#fff" /> : null}
                          <Text>{askReady ? '发送回答' : `还差 ${activeAsks.length - askAnsweredCount} 题`}</Text>
                        </View>
                      </View>
                    ) : null}
                  </View>
                ) : null}
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
                  onView={m.streaming ? undefined : () => shareReport(m.messageId)}
                  onSave={m.streaming ? undefined : () => saveDeliverable(m.deliverable, m.messageId)}
                  onShareMenu={m.streaming ? undefined : (kind) => onReportShareMenu(kind, m.deliverable, m.messageId)}
                />
              </View>
              {/* 记债项10：报告流失败/降级——单一话术（trust 行「生成中断——已生成部分已保留，可点击重试补全」）+ ↻ 重试入口。
                  原「保底草案，已免扣额度」独立提示已并入 trust 行，degraded 仅留作状态位。 */}
              {!m.streaming && m.retryText ? (
                <Text style={{ marginTop: '6px', color: accent, fontSize: '13px' }} onClick={() => doSend(m.retryText!, sessionId, agent?.key ?? '', [], false)}>↻ 重试</Text>
              ) : null}
              {m.knowledgeUsed && m.knowledgeUsed.length ? (
                <View style={{ marginTop: '6px', fontSize: '12px', opacity: 0.6 }}>
                  <Text>参考了 {m.knowledgeUsed.length} 份资料：{m.knowledgeUsed.join('、')}</Text>
                </View>
              ) : null}
              <RefNotices notices={m.refNotices} />
              {/* 认可方案 → 沉淀报告并进入执行承接（对齐「认可后拆成军令/复盘」动线）。
                  中断/降级报告（retryText 或 degraded）不开放认可，先重试补全再认可。 */}
              {!m.streaming && !m.deliverable.degraded && !m.retryText ? (
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
        </View>
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
        {/* B5：非模态上传清单（逐份真进度 / 逐份可撤回；失败可单独重递或删掉） */}
        {uploadList.length ? (
          <View className="upload-bar">
            <View className="ub-head">
              <Text className="ub-t">
                {uploading
                  ? `呈送资料 ${uploadList.filter((u) => u.status === 'done').length}/${uploadList.length}`
                  : `${uploadList.filter((u) => u.status === 'failed').length} 份未送达`}
              </Text>
              {uploading ? <Text className="ub-cancel" style={{ color: accent }} onClick={cancelAllUploads}>全部撤回</Text> : null}
            </View>
            {uploadList.map((u) => (
              <View key={u.id} className={`up-row ${u.status === 'failed' ? 'bad' : ''}`}>
                <View className="up-b">
                  <Text className="up-name">{u.name}</Text>
                  <Text className="up-meta">{fmtBytes(u.size)}{u.status === 'uploading' ? ` · ${u.pct}%` : ''}</Text>
                </View>
                <Text className={`up-badge ${u.status}`}>{UPLOAD_STATUS_TEXT[u.status]}</Text>
                {u.status === 'uploading' || u.status === 'waiting' ? (
                  <Text className="up-act" style={{ color: accent }} onClick={() => cancelUpload(u.id)}>撤回</Text>
                ) : null}
                {u.status === 'failed' ? (
                  <>
                    <Text className="up-act" style={{ color: accent }} onClick={() => retryUpload(u.id)}>重递</Text>
                    <Text className="up-act up-del" onClick={() => dropUpload(u.id)}>删</Text>
                  </>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        {/* 已选引用（刚传上来的标「拆读中」：正文还没拆完，此刻发问军师未必读得到） */}
        {refs.length ? (
          <View className="ref-row">
            {refs.map((r, j) => (
              <View key={j} className="ref-chip" style={{ borderColor: accent }} onClick={() => toggleRef(r)}>
                <Icon name={refCardParts(r).icon} size={12} color={accent} />
                <Text className="ref-chip-l" style={{ color: accent }}>{refCardParts(r).title}</Text>
                {r.kind === 'knowledge' && parsingRefIds.includes(r.id) ? <Text className="ref-parsing">拆读中</Text> : null}
                <Text className="ref-x">✕</Text>
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
              maxlength={-1}
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
              <Text className={`cinput-count ${input.length > INPUT_MAX ? 'over' : ''}`}>{input.length}/{INPUT_MAX}</Text>
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

      {/* 反问卡「其他」的键盘捕获器放在聊天 ScrollView 外；卡片内只渲染 WebView 文本，避免 Android 原生文字层漂移。 */}
      {activeAskComposer ? (
        <Textarea
          className="ask-keyboard-capture"
          value={askOther[activeAskComposer.qi] ?? ''}
          focus
          adjustPosition={false}
          cursorSpacing={24}
          maxlength={-1}
          showConfirmBar={false}
          confirmType="done"
          onInput={(e) => {
            setAskOtherText(activeAskComposer.qi, e.detail.value);
            return e.detail.value;
          }}
          onConfirm={(e) => finishAskOther(activeAskComposer.qi, e.detail.value)}
          onBlur={clearAskComposer}
          onKeyboardHeightChange={(e) => {
            const next = Math.max(0, Number(e.detail?.height || 0));
            setKeyboardHeight(next);
            if (next > 0) setTimeout(scrollToEnd, 40);
          }}
        />
      ) : null}

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
