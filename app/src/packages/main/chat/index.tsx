import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { View, Text, Textarea, ScrollView, Image } from '@tarojs/components';
import Taro, { useRouter, useDidHide, useDidShow } from '@tarojs/taro';
import Icon from '../../../components/Icon';
import Login from '../../../components/Login';
import MarkdownText from '../../../components/MarkdownText';
import ReportCard from '../../../components/ReportCard';
import SafeHeader from '../../../components/SafeHeader';
import AdvisorAvatar from '../../../components/AdvisorAvatar';
import { useStore } from '../../../hooks/useStore';
import { store } from '../../../services/store';
import { api, reportPdfUrl, type Agent, type Deliverable, type Section, type ChatReplyT, type MessageRef, type ProjectItem, type ReportItem, type KnowledgeItemT, type MemoryCandidate, type SessionDetail, type CreativeStatusResult } from '../../../services/api';
import { STREAM_CHAT } from '../../../services/config';
import { asReply, replyToText } from '../../../services/chatReply';
import { diffPasted, pasteExcerpt, isSamePaste } from '../../../services/pasteAbsorb';
import {
  startLiveGen, attachLiveGenView, detachLiveGenView, peekLiveGen, stopLiveGen, dropLiveGen, storedReplyFor,
  type LiveGenView,
} from '../../../services/liveGen';
import { requestWechatSubscribe } from '../../../services/wechatSubscribe';
import { checkUpload, checkImageUpload } from '../../../services/uploadGuard';
import { sourceUploadName } from '../../../services/uploadName';
import { nativeWriteStep } from '../../../services/nativeInputWrite';
import { agentForText, DIAGNOSIS_ASKS, DIAGNOSIS_CHIPS } from '../../../data/intents';
import { ADVISOR_ALIAS, CORE_SPECIALISTS, DISPATCH_SUGGESTIONS } from '../../../data/council';
import { CHAT_GUIDES } from '../../../data/operatingSystem';
import { acceptDeliverable } from '../../../services/dossier';
import { navTo } from '../../../services/nav';
import { chatPendingAge, clearChatPending, isChatPending, markChatPending } from '../../../services/chatPending';
import { getCreativeStatus, peekCreativeStatus } from '../../../services/creative';
import type { AuthReason } from '../../../services/authGate';
import './index.scss';

// uid：每条消息的稳定 key（服务端消息用其 id，本地临时消息造递增 uid），供列表渲染 key 用。
// 历史窗口化会向列表顶部插入更早的消息，索引 key 会令整列重挂——稳定 uid 是其正确性前置。
type Msg =
  | { role: 'greet'; agent: Agent; uid?: string }
  | { role: 'user'; text: string; refs?: MessageRef[]; uid?: string }
  | { role: 'assistant'; reply: ChatReplyT; knowledgeUsed?: string[]; refNotices?: string[]; retryText?: string; streaming?: boolean; uid?: string }
  | { role: 'report'; deliverable: Deliverable; animate: boolean; saved?: boolean; messageId?: string; knowledgeUsed?: string[]; refNotices?: string[]; streaming?: boolean; retryText?: string; uid?: string }
  | { role: 'memory'; agentName: string; uid?: string };

// 本地临时消息的稳定 uid：模块级单调计数，跨渲染/实例不重复。仅在事件处理/副作用里调用（非渲染期）。
let msgUidSeq = 0;
const nextMsgUid = () => `m${++msgUidSeq}`;

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

// 把结构化成果序列化为纯文本，复制到剪贴板（供粘贴进自己的文档；PDF 导出另有入口）。
// sections 按类型必填，但存量脏数据里可能整字段缺失（见 ReportCard 的 secs 注释），这里同样兜一层。
function deliverableToText(d: Deliverable): string {
  const lines: string[] = [String(d?.title ?? '')];
  if (d?.meta) lines.push(d.meta);
  lines.push('');
  for (const sec of Array.isArray(d?.sections) ? d.sections : []) {
    for (const l of sectionToLines(sec)) lines.push(l);
    lines.push('');
  }
  if (d?.trust) lines.push(d.trust);
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

// 军师反问选项：流式期间隐藏正文尾部的 ```ask 结构块（含尚未流完的半截围栏），
// 完整回复（onChat）到达后由服务端剥离过的正文 + 结构化 asks 权威替换。
function visibleStreamText(text?: string): string {
  const src = String(text ?? '');
  const cut = src.indexOf('```ask');
  const t = cut >= 0 ? src.slice(0, cut) : src;
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
const REPORT_INTERRUPTED_TRUST = '中断了——已出的部分留着，点重试继续补全';
// 「继续写完」发出的正文。服务端已把未写完的那条 assistant 消息落库，模型在历史里能看到断点，
// 所以这里不需要复述断点内容，一句自然话就够；它会照常作为一条用户消息落库，
// 因此必须是**用户看着也合理**的文案（退出重进会原样显示），不能写成系统指令腔。
const CONTINUE_REQUEST_TEXT = '接着上面继续写完';
const JUMP_LATEST_SHOW_DISTANCE = 420;
const JUMP_LATEST_HIDE_DISTANCE = 140;
// B1 贴底判定阈值：距底 ≤ 此值视为「贴底跟随」，用户上滑超过即暂停自动滚底。
const STICK_BOTTOM_DISTANCE = 120;
// B1 流式跟随节流间隔：onToken/onReportSection 高频触发，滚底最多每 ~300ms 一次。
const FOLLOW_THROTTLE_MS = 300;
// 流式 token 合批：SSE 每 token 直接 setState 会在长回复里雪崩式重渲染 + 重解析（O(n²)）。
// 先积到缓冲，满 64 字或每 ~120ms flush 一次；流收尾/切页/卸载立即 flush 残余，一字不丢。
const TOKEN_FLUSH_MS = 120;
const TOKEN_FLUSH_CHARS = 64;
// 历史窗口化：restore 全量存 ref，初始只渲染最近 30 条，顶部「阅早前问对」每次向前补 30 条。
const HISTORY_WINDOW = 30;
// 离开聊天页后，服务端生成仍会继续。重进同一会话时按服务端 generating 真值刷新，
// 前 30 秒密一点让回复尽快落屏，长思考则降频，避免一直高频请求。
const REATTACH_POLL_FAST_MS = 1200;
const REATTACH_POLL_SLOW_MS = 3000;
const REATTACH_POLL_FAST_WINDOW_MS = 30_000;
const REATTACH_POLL_MAX_MS = 10 * 60_000;
// 服务端收到生成请求并登记 generating 前的网络交接宽限；超过后若服务端已不在生成且仍无回复，按中断处理。
const LOCAL_PENDING_HANDOFF_MS = 5000;
// B6 输入计数：临近上限（>1800/2000）才显示字数，平时不打扰。
const INPUT_MAX = 2000;
const INPUT_COUNT_FROM = 1800;
// 粘贴转附卷：单次输入暴增 ≥ 此值且越过 INPUT_MAX，判为「长文粘贴」→ 自动归卷。
const PASTE_DELTA_MIN = 500;
// 粘贴防抖合并窗口：微信 textarea 一次粘贴会连发多个 onInput（devtools 按行拆发），
// 用一个 ~250ms 定时器把这串事件合并成「一次结算」，避免各建一份 knowledge 撞满九份。
const PASTE_SETTLE_MS = 250;
// 重复粘贴时已有卡片的高亮时长：够看见，又不至于一直闪。
const PASTE_DUP_FLASH_MS = 1800;
// 程序性写入原生输入框的等待：Stencil 首帧渲染是异步的，就绪前写 value 会在其 watchValue 里抛错
// （见 services/nativeInputWrite 注释）。每 ~32ms 探一次、最多 ~0.5s；等不到就放弃——
// 值仍在 input state 里（字数/发送键/草稿判定都准），只是原生框这一次没同步上。
const NATIVE_WRITE_RETRY_MS = 32;
const NATIVE_WRITE_MAX_TRIES = 15;

// 引用签是不是「粘贴长文」归的卷：卡面要露字数 + 摘要 + 可点开看全文，与上传的文件卡区别开。
function isPasteRef(r: MessageRef): boolean {
  return r.kind === 'knowledge' && String(r.label ?? '').startsWith('粘贴长文');
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
type PastePending = {
  key: string;
  chars: number;
  excerpt: string;
  text: string;
  status: 'uploading' | 'failed';
};
interface UploadEntry { id: string; name: string; size: number; path: string; pct: number; status: UploadStatus; }

const UPLOAD_STATUS_TEXT: Record<UploadStatus, string> = {
  waiting: '排队中', uploading: '发送中', done: '已送达', failed: '发送失败', cancelled: '已撤回',
};

// 引用签的类型称谓（军师文风）：与 @引用选择器分组标题保持一致，附卷=归卷后的知识。
const REF_KIND_LABEL: Record<MessageRef['kind'], string> = {
  project: '案卷', report: '方案', knowledge: '附卷', memory: '军师印象', image: '图片',
};
const REF_KIND_ICON: Record<MessageRef['kind'], string> = {
  project: 'layers', report: 'doc', knowledge: 'doc', memory: 'spark', image: 'image',
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
// 「长文自动归卷」这件事只解释一次：第一次撞见时在卡下说明白，之后不再打扰。
const PASTE_HINTED_KEY = 'chat-paste-hinted';
const isPasteHinted = (): boolean => {
  try { return Taro.getStorageSync(PASTE_HINTED_KEY) === 1; } catch { return false; }
};
const markPasteHinted = () => {
  try { Taro.setStorageSync(PASTE_HINTED_KEY, 1); } catch { /* noop */ }
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
  // true 表示 busy 来自“重进后恢复”；停止动作改走持久 generationId，不依赖原请求句柄。
  const [reattachedBusy, setReattachedBusy] = useState(false);
  const [activeGenerationId, setActiveGenerationId] = useState('');
  const [activeGenerationPhase, setActiveGenerationPhase] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  const [refs, setRefs] = useState<MessageRef[]>([]);
  const [showLogin, setShowLogin] = useState(false);
  const [loginReason, setLoginReason] = useState<AuthReason>('chat');
  const [picker, setPicker] = useState(false);
  // 海报成品图能力：仅海报设计师会话需要，null = 未知/不可用 → 成果卡不露出出图入口（方案 §16 降级口径）。
  const [creativeStatus, setCreativeStatus] = useState<CreativeStatusResult | null>(() => peekCreativeStatus());
  const [pick, setPick] = useState<{ projects: ProjectItem[]; reports: ReportItem[]; knowledge: KnowledgeItemT[]; memories: MemoryCandidate[] }>({ projects: [], reports: [], knowledge: [], memories: [] });
  const logHeightRef = useRef(0);
  const logRef = useRef<Msg[]>([]);
  logRef.current = msgs;
  // 流式 token 合批缓冲：onToken 先积到 ref，定时/满量 flush 一次到 setState，降流式期重渲染频率。
  const tokenBufRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 历史窗口化：完整消息列表存 ref（restore 全量落此），msgs 只保留当前窗口；histShown 记已展开条数。
  const fullMsgsRef = useRef<Msg[]>([]);
  const [histShown, setHistShown] = useState(0);

  // B1 贴底跟随：atBottom 记录用户是否停留在底部；上滑离开即暂停自动跟随。
  const atBottomRef = useRef(true);
  const lastFollowRef = useRef(0);
  const followTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A 侧重进轮询兜底：aliveRef 标记页面存活、reattachTimerRef 持轮询定时器。
  const reattachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);
  // 轮询代号：每次 resumeGeneration 自增，poll 闭包只认自己那一代。回前台对账重启轮询时，
  // 上一代那个正 await 在半路的 poll 醒来即自行退场，不会与新一代各排一串定时器（互斥铁律）。
  const pollSeqRef = useRef(0);
  // liveGen 托管：当前挂着的 view 实例 + 用于 stop/detach 的 entry key。
  // 停止生成、卸载解绑、重进对账都经这两个 ref 定位到模块级单例里的这一轮生成。
  const liveViewRef = useRef<LiveGenView | null>(null);
  const liveKeyRef = useRef<string>('');
  const activeGenerationIdRef = useRef<string>('');
  const activeGenerationPhaseRef = useRef<string>('');
  // B3 草稿：用 ref 取最新值，供 onBlur / useDidHide 闭包读取。
  const inputRef = useRef('');
  inputRef.current = input;
  // 粘贴合并：同步追踪输入框最新值（React state 在同步事件串里是陈旧的，不能当 prev 用）。
  // 所有给 setInput 赋值处都要同步维护此 ref，否则粘贴增量判定会错。
  const lastValueRef = useRef('');
  // 输入框非受控：Textarea 不绑 value（避免 React 重渲染把陈旧值断言回原生 → 语音重复上屏、中间删字光标跳末尾）。
  // 程序性写入统一走 writeInput，经此 ref 直写 FormElement.value（weapp）/ Stencil value（h5）驱动原生同步。
  const taRef = useRef<any>(null);
  // 等 Stencil 首帧渲染出原生节点再写 value 的重试定时器（见 writeInputNative）。
  const nativeWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 粘贴 burst：命中一次长文暴增即记 baseline（暴增前的输入），burst 期间每个 onInput 都重置结算定时器。
  const pasteBurstRef = useRef<{ baseline: string } | null>(null);
  const pasteSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 本轮粘贴长文的全文（引用签 id → 原文）：预览、复制、去重都读它，零网络、点开即有。
  // 作用域 = 当前这一轮 composer：发出这一轮或撤掉卡片即忘。
  const pasteTextRef = useRef<Map<string, string>>(new Map());
  const pasteSeqRef = useRef(0);
  const pasteDupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 在途占位卡的 key（与 pastePendings 同步增删的 ref 版）：去重判定要在定时器回调里同步问「这份还在屏上吗」，
  // 读 state 会慢一拍。
  const pastePendingKeysRef = useRef<Set<string>>(new Set());
  // 粘贴转附卷：在途份数（await createKnowledge 期间计数），与 refs 合并判九份上限、防并发超挂。
  const pasteInflightRef = useRef(0);
  const sessionIdRef = useRef('');
  sessionIdRef.current = sessionId;
  const pendingSessionIdRef = useRef('');
  // 回前台对账要读的最新值（useDidShow 回调里取闭包会拿到陈旧渲染的值，一律走 ref）。
  const busyRef = useRef(false);
  busyRef.current = busy;
  const agentRef = useRef<Agent | null>(null);
  agentRef.current = agent;
  // 本轮提问原文：本页发出的，或从落库历史里恢复出的末条待答用户消息。对账时据此确认服务端落的是不是本轮。
  const lastSentTextRef = useRef('');
  // 断流失败态记账：liveGen 对账后仍判失败（链路断的）才置位，回前台时据此再兜一次底；对上账即清。
  const streamBrokenRef = useRef(false);
  // 首次 onShow 归加载路径（initChat）管，此处只标记「已进过一次」。
  const shownRef = useRef(false);
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
  // 粘贴归卷的乐观占位卡：清空输入框与卡片出现是同一帧，网络再慢也不出现「字没了、卡还没来」的空窗。
  const [pastePendings, setPastePendings] = useState<PastePending[]>([]);
  // 粘贴长文预览浮层（点卡片打开）：看全文 / 复制 / 移除。refId 为空表示看的是还在归卷的占位卡。
  const [pastePreview, setPastePreview] = useState<{ refId: string; chars: number; text: string } | null>(null);
  // 重复粘贴时短暂高亮已在的那张卡：不新建第二份，而是把主公的视线引到它上面。
  const [pasteDupId, setPasteDupId] = useState('');
  // 首次自动归卷时在卡下解释一次（toast 1.5 秒就没了，教不会人）：看过即不再出现。
  const [pasteHint, setPasteHint] = useState(false);
  // 图片引用的签名预览 URL 缓存（按需取、进程内缓存）：签名 URL 有时效，重进/失效时按需重取。
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const imageUrlFetching = useRef<Record<string, boolean>>({});
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

  // 流式 token 合批：把缓冲一次性追加到最后一条流式聊天气泡（保持 patchChat 语义：只改 reply.text）。
  // 幂等：无缓冲即 no-op；无流式气泡（已收尾/被替换）时按现有 patchChat 一样安全丢弃。
  const flushTokenBuf = () => {
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    const chunk = tokenBufRef.current;
    if (!chunk) return;
    tokenBufRef.current = '';
    setMsgs((m) => {
      const i = m.length - 1;
      if (i >= 0 && m[i].role === 'assistant' && (m[i] as { streaming?: boolean }).streaming) {
        const copy = m.slice();
        const cur = copy[i] as Extract<Msg, { role: 'assistant' }>;
        copy[i] = { ...cur, reply: { ...cur.reply, text: (cur.reply.text || '') + chunk } };
        return copy;
      }
      return m;
    });
    followBottom();
  };
  // 丢弃缓冲（不落屏）：新一轮气泡起手 / 权威回复整体替换前用，避免残余 token 追加到错误目标。
  const resetTokenBuf = () => {
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    tokenBufRef.current = '';
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

  // 图片引用签名预览 URL：按需取（历史消息里的图 + 当前引用），进程内缓存；签名有时效，缺了就补取。
  const ensureImageUrl = (id: string) => {
    if (!id || imageUrls[id] || imageUrlFetching.current[id]) return;
    imageUrlFetching.current[id] = true;
    api.chatImageUrl(id)
      .then((r) => { if (r?.url) setImageUrls((cur) => ({ ...cur, [id]: r.url })); })
      .catch(() => { /* 取不到就留占位图标 */ })
      .finally(() => { imageUrlFetching.current[id] = false; });
  };
  useEffect(() => {
    const ids = new Set<string>();
    for (const m of msgs) if (m.role === 'user' && m.refs) for (const r of m.refs) if (r.kind === 'image') ids.add(r.id);
    for (const r of refs) if (r.kind === 'image') ids.add(r.id);
    ids.forEach(ensureImageUrl);
  }, [msgs, refs]);
  // 点缩略图看大图。
  const previewImageRef = (id: string) => {
    const url = imageUrls[id];
    if (url) Taro.previewImage({ current: url, urls: [url] });
    else ensureImageUrl(id);
  };

  useEffect(() => () => {
    aliveRef.current = false;
    if (reattachTimerRef.current) clearTimeout(reattachTimerRef.current);
    if (pasteSettleTimerRef.current) clearTimeout(pasteSettleTimerRef.current);
    if (pasteDupTimerRef.current) clearTimeout(pasteDupTimerRef.current);
    if (nativeWriteTimerRef.current) clearTimeout(nativeWriteTimerRef.current);
    // 卸载前把 token 缓冲同步 flush 掉、清定时器：不丢字（累计文本仍在 liveGen 快照里，重进会重放），也不留悬空定时器。
    flushTokenBuf();
    store.setOverlay(false, 'ref-picker');
    store.setOverlay(false, 'paste-preview');
    // 页面真卸载（返回列表 / redirect）时解绑 view：停止对已死组件的 UI 副作用，但不终止流——
    // liveGen 快照照常累计，重进本会话即 attach 重放，thinking/逐字流无缝续上。
    if (liveKeyRef.current && liveViewRef.current) detachLiveGenView(liveKeyRef.current, liveViewRef.current);
  }, []);

  // B3 草稿持久化：按 sessionId 维度存/取；发送成功后清除。
  const loadDraft = (id?: string) => {
    try { const d = Taro.getStorageSync(draftKeyFor(id)); if (d && typeof d === 'string') { writeInput(d); } } catch { /* noop */ }
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
  // 切后台/离开页面时落草稿，避免误触返回丢失长输入；同时把 token 缓冲 flush 掉，切页也不丢字。
  useDidHide(() => { flushTokenBuf(); saveDraft(); });

  const isUnauthorized = (e: unknown) =>
    (e as any)?.code === 'UNAUTHORIZED' || String((e as any)?.message || '').includes('未登录');

  const errorReply = (e: unknown): string => {
    if (isUnauthorized(e)) return '登录态已失效，请重新登录后再发送。';
    if ((e as any)?.data?.code === 'AGENT_LOCKED') return '这位军师还没启用，去锦囊里看看。';
    if ((e as any)?.data?.code === 'INSUFFICIENT_QUOTA') return '本月额度已用尽，可在「我的」升级套餐，或下月再用。';
    if ((e as any)?.data?.code === 'INSUFFICIENT_CREDITS') return '算力不足，可在「我的」充值后继续。';
    const msg = String((e as any)?.message || '');
    if (msg && msg !== 'undefined') return msg;
    return '没出来，再试一次？还是不行就换个说法。';
  };

  // 审核类错误（输入/输出未通过内容审核）：重试同样内容必再次被拦，故不提供「重试」，也避免叠出重复气泡。
  const isModerationErr = (s?: string) => !!s && /审核/.test(s);

  const promptLogin = (title = '请先登录后再开始对话', reason: AuthReason = 'chat') => {
    setLoginReason(reason);
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
      setMsgs([{ role: 'greet', agent: fallbackAgent, uid: 'greet' }]);
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
        setMsgs([{ role: 'greet', agent: fallbackAgent, uid: 'greet' }]);
      } else {
        await primeGuestThread();
      }
      if (send) writeInput(decodeURIComponent(send));
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
        takeOverGeneration(ag, sid, detail);
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
          // 同上：liveGen 续流 / 轮询兜底 / 自动发送三者互斥，无人接管本轮才轮到自动发送。
          if (!takeOverGeneration(fallbackAgent, latest.id, detail) && send) {
            setTimeout(() => doSend(decodeURIComponent(send), latest.id, fallbackAgent.key, [], true, detail.projectId || pid || ''), 300);
          }
          return;
        }
      }
      // 全新会话：仅渲染问候（不落库），首条消息时后端创建
      setMsgs([{ role: 'greet', agent: fallbackAgent, uid: 'greet' }]);
      loadDraft('');
      if (send) setTimeout(() => doSend(decodeURIComponent(send), '', fallbackAgent.key, [], true, pid || ''), 350);
    } catch (e) {
      if (isUnauthorized(e)) promptLogin('登录态已失效，请重新登录');
      // 任何拉取失败都不让对话页空白：至少给出问候
      if (fallbackAgent) {
        setAgent(fallbackAgent);
        setMsgs([{ role: 'greet', agent: fallbackAgent, uid: 'greet' }]);
      }
    }
  }

  useEffect(() => {
    initChat();
  }, []);

  function restore(ag: Agent, messages: { id: string; role: string; content: any; refs?: MessageRef[] }[]) {
    const out: Msg[] = [{ role: 'greet', agent: ag, uid: 'greet' }];
    let lastUserText = '';
    messages.forEach((m) => {
      // 稳定 key：服务端消息一律用其 id 作 uid（重复 restore/轮询不换 key，避免整列重挂）。
      // 三个分支的 content 一律按「可能缺/可能不是对象」处理：restore 本身在 initChat 的 try 里
      // （抛错只会退化成「只剩问候」），但残缺 Msg 会带着进渲染期，那里抛错就是整页白屏。
      if (m.role === 'user') { lastUserText = String(m.content?.text ?? ''); out.push({ role: 'user', text: lastUserText, refs: m.refs, uid: m.id }); }
      // B4：已入库真值——优先取服务端字段（若有），否则回落到本地保存记录，避免已入库方案重复显示「存入方案库」。
      else if (m.role === 'report') {
        const deliverable = (m.content ?? {}) as Deliverable;
        // 记债项10：还原历史里的降级/中断报告——统一中断话术 + ↻ 重试入口（与实时失败一致）。
        const degraded = !!deliverable?.degraded;
        out.push({
          role: 'report',
          deliverable: degraded ? { ...deliverable, trust: REPORT_INTERRUPTED_TRUST } : deliverable,
          animate: false, messageId: m.id, uid: m.id,
          saved: !!((m as { saved?: boolean }).saved || (deliverable as { saved?: boolean })?.saved || isReportSaved(m.id)),
          retryText: degraded && lastUserText ? lastUserText : undefined,
        });
      }
      // assistant / system：contentJson 正常是 { text, points?, asks? }；缺 text 或整个不是对象时
      // 补成 { text: '' }，否则渲染期 m.reply.text / m.reply.asks 会抛错。
      else out.push({ role: 'assistant', reply: asReply(m.content), uid: m.id });
    });
    // 末条仍是用户消息 = 有一轮问对尚未落回复：记下原文，回前台对账据此认领本轮。
    const tail = messages[messages.length - 1];
    if (tail?.role === 'user') lastSentTextRef.current = String(tail.content?.text || '');
    // 历史窗口化：完整列表存 ref，初始只渲染最近 HISTORY_WINDOW 条；顶部「阅早前问对」按需向前补。
    fullMsgsRef.current = out;
    const shown = Math.min(out.length, HISTORY_WINDOW);
    setHistShown(shown);
    setMsgs(out.slice(out.length - shown));
    setTimeout(scrollToEnd, 60);
  }

  // 阅早前问对：向列表顶部补一窗更早的历史（稳定 uid 令已在屏的消息不重挂）。
  // 补入后不强制滚动——微信 ScrollView 顶部插入的轻微跳动可接受，不做额外锚定工程。
  const expandEarlier = () => {
    const full = fullMsgsRef.current;
    const cur = histShown;
    const next = Math.min(full.length, cur + HISTORY_WINDOW);
    if (next <= cur) return;
    const add = full.slice(full.length - next, full.length - cur);
    setHistShown(next);
    setMsgs((m) => [...add, ...m]);
  };

  // 页面退出不会中断 GenerationJob。重新进入后：
  // 1) 立即恢复“正在思考”；2) 轮询任务权威全文快照，继续显示已生成正文；
  // 3) 服务端落库并清 generating 后，用完整历史替换页面。
  // 若请求异常结束且没有军师回复，则明确给出可重试气泡，不让用户面对一条悬空的提问。
  function resumeGeneration(sid: string, ag: Agent, initialGenerationId?: string) {
    if (reattachTimerRef.current) clearTimeout(reattachTimerRef.current);
    const startedAt = Date.now();
    const seq = ++pollSeqRef.current; // 本代轮询的代号，见 pollSeqRef
    setBusy(true);
    setReattachedBusy(true);

    const finish = () => {
      setBusy(false);
      setReattachedBusy(false);
      activeGenerationIdRef.current = '';
      activeGenerationPhaseRef.current = '';
      setActiveGenerationId('');
      setActiveGenerationPhase('');
      reattachTimerRef.current = null;
    };
    const poll = async () => {
      if (!aliveRef.current || seq !== pollSeqRef.current) return;
      try {
        const detail = await api.session(sid);
        if (!aliveRef.current || seq !== pollSeqRef.current) return;
        const activeGenerationId = detail.activeGeneration?.id || initialGenerationId;
        activeGenerationIdRef.current = activeGenerationId || '';
        activeGenerationPhaseRef.current = detail.activeGeneration?.phase || '';
        setActiveGenerationId(activeGenerationId || '');
        setActiveGenerationPhase(detail.activeGeneration?.phase || '');
        if (activeGenerationId && detail.activeGeneration?.kind !== 'report') {
          const snapshot = await api.generation(activeGenerationId).catch(() => null);
          if (!aliveRef.current || seq !== pollSeqRef.current) return;
          if (snapshot?.partialText) {
            setMsgs((current) => {
              const next = current.slice();
              const tail = next[next.length - 1];
              if (tail?.role === 'assistant' && tail.streaming) {
                next[next.length - 1] = { ...tail, reply: { ...(tail.reply || { text: '' }), text: snapshot.partialText } };
              } else {
                next.push({ role: 'assistant', reply: { text: snapshot.partialText }, streaming: true, uid: `generation:${activeGenerationId}` });
              }
              return next;
            });
            followBottom();
          }
        }
        const last = detail.messages[detail.messages.length - 1];
        const localAge = chatPendingAge(sid);
        const locallyHandingOff = localAge !== null && localAge < LOCAL_PENDING_HANDOFF_MS;
        // 回复已落库时不用等旧页面 finally 清本地标记；否则服务端不再生成后，最多给网络交接 5 秒宽限。
        const replyStored = !!last && last.role !== 'user';
        // 主正文会先于推荐选项补生成落库；只要 active job 仍在 finalize，就继续锁住输入。
        // 否则重进用户会提前获得发送能力，下一问又被服务端 409 拒绝。
        if (!detail.generating && (replyStored || !locallyHandingOff)) {
          clearChatPending(sid);
          restore(ag, detail.messages);
          if (last?.role === 'user') {
            const retryText = String(last.content?.text || '').trim();
            setMsgs((m) => [...m, {
              role: 'assistant',
              reply: { text: '刚才的思考中断了，你可以重新发送这条问题。' },
              retryText: retryText || undefined,
              uid: nextMsgUid(),
            }]);
          }
          finish();
          return;
        }
      } catch (e) {
        if (isUnauthorized(e)) {
          finish();
          promptLogin('登录态已失效，请重新登录');
          return;
        }
        // 短暂网络波动不撤掉思考态；统一请求层已经记录了技术原因，下一轮继续确认服务端真值。
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= REATTACH_POLL_MAX_MS) {
        clearChatPending(sid);
        finish();
        // 轮询到顶仍无定论：残留的流式报告卡收成中断态（trust 行说明 + degraded 状态位），
        // 不能让它永远转圈，也不能装「已生成」——真结果若随后落库，重进会话即以服务端为准重绘。
        setMsgs((m) => {
          const i = m.length - 1;
          let out = m;
          if (i >= 0 && m[i].role === 'report' && (m[i] as { streaming?: boolean }).streaming) {
            const cur = m[i] as Extract<Msg, { role: 'report' }>;
            out = m.slice();
            out[i] = { ...cur, streaming: false, deliverable: { ...cur.deliverable, trust: REPORT_INTERRUPTED_TRUST, degraded: true } };
          }
          return [...out, {
            role: 'assistant',
            reply: { text: '这次思考时间有点久，结果完成后仍会保存在本会话，请稍后回来查看。' },
            uid: nextMsgUid(),
          }];
        });
        return;
      }
      const delay = elapsed < REATTACH_POLL_FAST_WINDOW_MS ? REATTACH_POLL_FAST_MS : REATTACH_POLL_SLOW_MS;
      reattachTimerRef.current = setTimeout(poll, delay);
    };

    reattachTimerRef.current = setTimeout(poll, REATTACH_POLL_FAST_MS);
  }

  const showMemoryLearned = (agentName: string, delay: number) => {
    setTimeout(() => {
      setMsgs((m) => [...m, { role: 'memory', agentName, uid: nextMsgUid() }]);
      scrollToEnd();
    }, delay);
  };

  // 同步兜底（非流式 / 静默失败补发）产出的落地：与流式收尾同一套 setMsgs 语义。
  // degradedRetryText = 本轮用户原文，仅在报告降级时挂到 ↻ 重试（非流式路径由 doSend 传入，兜底路径由 liveGen 透传 userText）。
  const renderGenerateResult = (res: Awaited<ReturnType<typeof api.generate>>, replaceStreamingAssistant = false, degradedRetryText?: string) => {
    if (res.sessionId && !sessionIdRef.current) setSessionId(res.sessionId);
    if (res.kind === 'report' && res.deliverable) {
      // 记债项10：降级（保底）草案与流式中断统一话术——挂 ↻ 重试、trust 行合一，不再另出「保底草案」提示。
      const degraded = !!res.deliverable.degraded;
      const reportUid = nextMsgUid();
      const reportMsg: Extract<Msg, { role: 'report' }> = {
        role: 'report',
        deliverable: degraded ? { ...res.deliverable, trust: REPORT_INTERRUPTED_TRUST } : res.deliverable,
        animate: true,
        messageId: res.messageId,
        knowledgeUsed: res.knowledgeUsed,
        refNotices: res.refNotices,
        retryText: degraded ? degradedRetryText : undefined,
        uid: reportUid,
      };
      setMsgs((m) => {
        if (replaceStreamingAssistant) {
          const i = m.length - 1;
          if (i >= 0 && m[i].role === 'assistant' && (m[i] as { streaming?: boolean }).streaming) {
            const copy = m.slice();
            // 就地替换流式占位：沿用其 uid，key 稳定不重挂（渐显动画状态不错位）。
            copy[i] = { ...reportMsg, uid: (m[i] as { uid?: string }).uid ?? reportUid };
            return copy;
          }
        }
        return [...m, reportMsg];
      });
      if (res.memory?.learned) showMemoryLearned(res.memory.agentName, data_delay(res.deliverable));
    } else if (res.reply) {
      const replyUid = nextMsgUid();
      setMsgs((m) => {
        if (replaceStreamingAssistant) {
          const i = m.length - 1;
          if (i >= 0 && m[i].role === 'assistant' && (m[i] as { streaming?: boolean }).streaming) {
            const copy = m.slice();
            // 就地替换流式占位：沿用其 uid，key 稳定。
            copy[i] = { role: 'assistant', reply: res.reply!, knowledgeUsed: res.knowledgeUsed, refNotices: res.refNotices, uid: (m[i] as { uid?: string }).uid ?? replyUid };
            return copy;
          }
        }
        return [...m, { role: 'assistant', reply: res.reply!, knowledgeUsed: res.knowledgeUsed, refNotices: res.refNotices, uid: replyUid }];
      });
    }
  };

  // 构造一个可插拔的 liveGen 观察者：把「流事件 → UI 副作用」抽成方法集，令一轮生成的 UI
  // 既能实时更新当前页，又能在重进时由 liveGen 重放快照重建。这些方法即旧内联 handlers 的搬迁，
  // report/chat 分流、首启守卫、静默失败兜底等控制流已上收到 liveGen，本处只管 setMsgs/滚动/busy。
  const buildLiveView = (viewAgent: Agent | null): LiveGenView => {
    const patchReport = (
      fn: (d: Deliverable) => Deliverable,
      extra: Partial<Extract<Msg, { role: 'report' }>> = {},
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
        return [...m, { role: 'report', deliverable: fn(reportDraft(viewAgent)), animate: false, streaming: true, uid: nextMsgUid(), ...extra }];
      });
    };
    const patchChat = (fn: (msg: Extract<Msg, { role: 'assistant' }>) => Extract<Msg, { role: 'assistant' }>) =>
      setMsgs((m) => {
        const i = m.length - 1;
        if (i >= 0 && m[i].role === 'assistant' && (m[i] as { streaming?: boolean }).streaming) {
          const copy = m.slice(); copy[i] = fn(copy[i] as Extract<Msg, { role: 'assistant' }>); return copy;
        }
        return m;
      });
    return {
      onSession: (id) => { if (id && !sessionIdRef.current) setSessionId(id); },
      onGeneration: (data) => {
        activeGenerationIdRef.current = data.generationId;
        activeGenerationPhaseRef.current = data.phase || '';
        setActiveGenerationId(data.generationId);
        setActiveGenerationPhase(data.phase || '');
      },
      startReport: () => { patchReport((d) => d); setTimeout(scrollToEnd, 30); },
      // meta kind=chat：先建聊天气泡（think-dots），避免 LLM 首字延迟期只剩全局 busy 无反馈。
      startChat: () => { resetTokenBuf(); setMsgs((m) => [...m, { role: 'assistant', reply: { text: '' }, streaming: true, uid: nextMsgUid() }]); setTimeout(scrollToEnd, 30); },
      reportBegin: (data) => patchReport((d) => ({ ...d, title: data.title || d.title, icon: data.icon || d.icon, meta: data.meta || d.meta })),
      reportSection: (section) => {
        patchReport((d) => ({ ...d, sections: mergeReportSection(d.sections, section) }));
        followBottom(); // B1：仅当用户仍贴底才跟随，尊重上滑
      },
      reportFooter: (data) => patchReport((d) => ({ ...d, trust: data.trust || d.trust, actions: data.actions?.length ? data.actions : d.actions })),
      appendToken: (t) => {
        // 合批：token 先积到缓冲，满量立即 flush，否则起一个 ~120ms 定时器；不再每 token 一次 setState。
        // 重进续流的整串重放（replay 传入全量累计文本）走同一路径：多半 ≥64 字，立即落屏。
        tokenBufRef.current += t;
        if (tokenBufRef.current.length >= TOKEN_FLUSH_CHARS) { flushTokenBuf(); return; }
        if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flushTokenBuf, TOKEN_FLUSH_MS);
      },
      replaceToken: (text) => {
        resetTokenBuf();
        patchChat((msg) => ({ ...msg, reply: { ...(msg.reply || { text: '' }), text } }));
        followBottom();
      },
      // 权威完整回复整体替换 reply：先把缓冲清掉（其内容已被 reply 覆盖），避免残余 token 事后重复追加。
      // SSE 的 chat 事件在「provider 流没吐出最终结果」时会带 null（服务端 send('chat', reply2) 的
      // reply2 可为 null）——直接塞进 msg.reply 会让下一帧 m.reply.text 抛错、整页白屏。过 asReply 收口。
      setChat: (reply) => { resetTokenBuf(); patchChat((msg) => ({ ...msg, reply: asReply(reply) })); },
      finishReport: (messageId, refNotices) => {
        // 自动存入由 liveGen 侧统一触发（保证退页面后台完成也入库），此处只收 streaming 态。
        patchReport((d) => d, { streaming: false, messageId, refNotices }, { appendIfMissing: false });
        followBottom(true);
      },
      finishChat: (messageId, refNotices) => {
        flushTokenBuf(); // 收尾先把残余 token 落屏，再置 streaming=false（否则末尾几十字会随定时器丢失）
        patchChat((msg) => ({ ...msg, streaming: false, refNotices }));
        followBottom(true);
      },
      // 断流对账「已落库」：本轮结果以服务端为准整体重绘，与加载路径同一套 restore，不留半截中断卡。
      restoreServerTruth: (detail) => {
        const ag = viewAgent || agentRef.current;
        if (!ag) return;
        resetTokenBuf(); // 残余 token 已被落库正文覆盖，不能再追加到重绘后的列表上
        if (reattachTimerRef.current) { clearTimeout(reattachTimerRef.current); reattachTimerRef.current = null; }
        pollSeqRef.current += 1; // 作废在途轮询：本轮已有定论，两条恢复路径不并存
        streamBrokenRef.current = false;
        restore(ag, detail.messages);
      },
      // 断流对账「服务端仍在生成」：交回本页的 generating 轮询。liveGen 已退出本轮，仍是单方接管。
      resumeServerPolling: (sid) => {
        const ag = viewAgent || agentRef.current;
        if (!ag || !sid) return;
        streamBrokenRef.current = false;
        resumeGeneration(sid, ag);
      },
      error: (kind, message, retry, broken) => {
        flushTokenBuf(); // 报错前先把已流出的 token 落屏，保留部分内容
        // 断链判死（对账也没能问出结果）：多半是切后台被杀请求。记一笔，回前台时再兜一次底。
        if (broken) streamBrokenRef.current = true;
        if (kind === 'report') {
          // 记债项10：报告流失败语义收敛为单一话术。审核类错误不给重试（retry 由 liveGen 判定后传入）。
          setMsgs((m) => {
            const i = m.length - 1;
            if (!(i >= 0 && m[i].role === 'report' && (m[i] as { streaming?: boolean }).streaming)) return m;
            const cur = m[i] as Extract<Msg, { role: 'report' }>;
            const copy = m.slice();
            if ((Array.isArray(cur.deliverable?.sections) ? cur.deliverable.sections.length : 0) > 0) {
              // 有部分内容：保留已流出分段，trust 行统一为中断话术 + ↻ 重试；degraded 仅留作状态位。
              copy[i] = {
                ...cur,
                streaming: false,
                retryText: retry,
                deliverable: { ...cur.deliverable, trust: REPORT_INTERRUPTED_TRUST, degraded: true },
              };
            } else {
              // 完全无内容：不留半空报告卡，改普通错误气泡 + 重试（对齐聊天气泡）。保留原 uid，key 稳定。
              copy[i] = { role: 'assistant', reply: { text: message || '生成失败' }, retryText: retry, uid: cur.uid };
            }
            return copy;
          });
        } else if (kind === 'chat') {
          patchChat((msg) => ({ ...msg, reply: { text: message || '生成失败' }, retryText: retry, streaming: false }));
        } else {
          // 错误早于任何 meta（如 HTTP 层直接失败）：既无报告卡也无聊天气泡可就地更新，补一条错误气泡 + 重试。
          setMsgs((m) => [...m, { role: 'assistant', reply: { text: message || '生成失败' }, retryText: retry, uid: nextMsgUid() }]);
        }
      },
      fallbackDone: (res, retryText) => { renderGenerateResult(res, true, retryText); setTimeout(scrollToEnd, 80); },
      memoryLearned: (agentName) => showMemoryLearned(agentName, 600),
      abortedChat: () => {
        flushTokenBuf(); // 主动停止前先落屏残余 token，据「是否有字」正确决定移除空壳还是收干净
        // 主动停止：还没吐出任何字的空占位直接移除，避免留下空壳；已有字则收干净为非流式。
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
      },
      clearBusy: () => {
        activeGenerationIdRef.current = '';
        activeGenerationPhaseRef.current = '';
        setActiveGenerationId('');
        setActiveGenerationPhase('');
        setBusy(false);
      },
    };
  };

  // 重进对话页：若该会话仍在推演（liveGen 有进行中条目），挂上新 view 续流并置 busy，返回 true（已接管，
  // 调用方不再启动轮询兜底）；否则（无 liveGen 条目 / 已收尾 / 本轮 assistant 已落库）返回 false，
  // 交由调用方按 A 的 resumeGeneration 轮询兜底 或 restore 的落库消息处理。两条重进路径互斥。
  const reattachLive = (ag: Agent, sid: string, messages: { role: string }[]): boolean => {
    const peek = peekLiveGen(sid);
    if (!peek) return false;
    const lastRole = messages.length ? messages[messages.length - 1].role : '';
    // 仍在推演 且 末条仍是用户消息（本轮 assistant 尚未落库）→ 续流；否则一律以落库为准。
    if (peek.active && lastRole === 'user') {
      setBusy(true);
      // liveGen 实时续流：停止按钮有效（stopLiveGen 跨页面命中同一 entry），非「被动等待」。
      setReattachedBusy(false);
      const view = buildLiveView(ag);
      liveViewRef.current = view;
      liveKeyRef.current = sid;
      attachLiveGenView(sid, view); // 重放当前累计快照：重建气泡，后续 token 实时续入本页
      return true;
    }
    dropLiveGen(sid);
    return false;
  };

  // 恢复接管的唯一入口（页面加载 / 回前台共用）：liveGen 实时续流优先，未接管且服务端仍 generating
  // （或本地刚发出、服务端尚未登记）才启轮询兜底。返回是否已有一方接管——两条路径永远互斥，
  // 调用方据此决定后续（加载路径的自动发送、回前台路径的收干净 busy）。
  const takeOverGeneration = (ag: Agent, sid: string, detail: SessionDetail): boolean => {
    if (reattachLive(ag, sid, detail.messages)) return true;
    if (detail.generating || isChatPending(sid)) { resumeGeneration(sid, ag, detail.activeGeneration?.id); return true; }
    return false;
  };

  // 回前台对账。小程序整体退后台会杀掉在途请求，liveGen 侧的对账请求本身也可能一起被杀（那时页面就
  // 停在「网络连接中断」的失败态，而服务端早已算完落库）——回到前台才是唯一确定的补救时机。
  // 只在「仍显思考态」或「刚判过断链」时才动手，正常浏览不被重绘打断。
  const reconcileOnShow = async (sid: string) => {
    const ag = agentRef.current;
    if (!ag) return;
    const detail = await api.session(sid).catch(() => null);
    if (!detail || !aliveRef.current || sessionIdRef.current !== sid) return;
    // 拉详情这段空档里若已开出新一轮（回前台即点选项发问），让位给 liveGen，别把新气泡重绘掉。
    if (peekLiveGen(sid)?.active) return;
    // 接过话事权：作废在途轮询（含正 await 在半路、醒来还想续排的那一代），下面由统一入口重新裁决接管方。
    if (reattachTimerRef.current) { clearTimeout(reattachTimerRef.current); reattachTimerRef.current = null; }
    pollSeqRef.current += 1;
    // 本轮已落库 → 以服务端为准重绘；否则不动页面现状（失败气泡与用户提问都留着，可点重试）。
    if (storedReplyFor(detail.messages, lastSentTextRef.current)) restore(ag, detail.messages);
    streamBrokenRef.current = false;
    if (!takeOverGeneration(ag, sid, detail)) { setBusy(false); setReattachedBusy(false); }
  };

  useDidShow(() => {
    // 首次 onShow 与 initChat 是同一条加载路径，交给它即可，此处只管此后每次回前台/回到本页。
    if (!shownRef.current) { shownRef.current = true; return; }
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (!busyRef.current && !streamBrokenRef.current) return;
    if (pendingSessionIdRef.current) return; // 非流式兜底路径正在途，收尾归它，别插手
    if (peekLiveGen(sid)?.active) return;    // liveGen 仍在实时推演：它才是接管方
    void reconcileOnShow(sid);
  });

  async function doSend(text: string, sid: string, agentKey: string, sendRefs: MessageRef[] = [], echo = true, activeProjectId = projectId) {
    if (busy) return;
    if (!store.isAuthed()) {
      promptLogin('登录后即可发送，刚才写的内容会为你保留', 'chat');
      return;
    }
    // 过期只读锁定（D4）：到期后前端即拦 AI 交互，提示续费（后端 PLAN_EXPIRED 403 为兜底硬保证）。
    if (s.me()?.planStatus?.expired) {
      Taro.showToast({ title: '套餐已到期，续费后可继续对话', icon: 'none' });
      return;
    }
    setBusy(true);
    // 本页主动发起 → 非「重进被动等待」，停止键有效。
    setReattachedBusy(false);
    // 本轮原文：断流对账认领本轮全靠它（重试 echo=false 也要更新，那同样是新一轮）。
    lastSentTextRef.current = text;
    streamBrokenRef.current = false;
    // B3：发送即清掉本会话草稿（输入已上屏；失败可用气泡「重试」重发，无需草稿）。
    clearDraft();
    // P2-15：重试（echo=false）不重复回显用户气泡（用户消息已在首次尝试时显示）。
    if (echo) setMsgs((m) => [...m, { role: 'user', text, refs: sendRefs.length ? sendRefs : undefined, uid: nextMsgUid() }]);
    setTimeout(scrollToEnd, 30);

    // 报告 / 聊天分流完全由后端 SSE meta 事件决定，前端不再检查消息文本。
    // 路由带 send= 自动发送时，React state 里的 agent 可能还没刷新；必须按本次 agentKey 重新取配置。
    const sendingAgent = findAgent(agentKey) || agent;
    // 一次点击生成一个稳定 clientRequestId；同一轮的断网补发/同步兜底复用这份 body，
    // 服务端只会 attach 原 GenerationJob，不会重复落用户消息或重复调用模型。
    const clientRequestId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const body = { text, sessionId: sid || undefined, agentKey, projectId: activeProjectId || undefined, refs: sendRefs.length ? sendRefs : undefined, clientRequestId };
    const canStream = STREAM_CHAT && !!sendingAgent;

    if (canStream) {
      // 统一流式入口 → 交给 liveGen 单例托管：事件先落 liveGen 累计快照、再转发给当前挂着的 view。
      // 页面卸载/重进时流照常存活，thinking 与逐字流无缝续在新页面。report/chat 分流、静默失败兜底、
      // 报告收尾自动入库、P0-5 双保险等业务语义全部内聚在 liveGen，与旧内联实现等价。
      const view = buildLiveView(sendingAgent || agent);
      liveViewRef.current = view;
      liveKeyRef.current = startLiveGen({
        // 新会话（尚无 sessionId）先用临时 key；收到服务端 session 事件后 liveGen 追加真实 sessionId 别名。
        key: sid || `new:${agentKey}:${Date.now()}`,
        sessionId: sid,
        agentKey,
        userText: text,
        body,
        view,
        // 报告收尾自动入库要用的完整 deliverable：从累计快照重装（reportDraft 兜底默认 + 分段 + footer）。
        buildDeliverable: (begin, sections, footer) => {
          let d = reportDraft(sendingAgent || agent, begin ? { title: begin.title, icon: begin.icon, meta: begin.meta } : {});
          d = { ...d, sections };
          if (footer) d = { ...d, trust: footer.trust || d.trust, actions: footer.actions?.length ? footer.actions : d.actions };
          return d;
        },
        autoSave: saveDeliverable,
      });
      return; // 生命周期与 busy 收尾由 liveGen（经 view.clearBusy）负责，不走下方同步收尾
    }

    // 非流式兜底（STREAM_CHAT 关或无 agent）：同步一次产出。此路径不跨页面存活（非默认路径）。
    // chatPending 由本路径自持（流式路径已上收至 liveGen 生命周期）：发送即标记、finally 清除。
    if (sid) { pendingSessionIdRef.current = sid; markChatPending(sid); }
    let handedOff = false;
    try {
      const res = await api.generate(body);
      if (res.generationId && (res.status === 'queued' || res.status === 'running')) {
        handedOff = true;
        if (res.sessionId && !sessionIdRef.current) setSessionId(res.sessionId);
        activeGenerationIdRef.current = res.generationId;
        setActiveGenerationId(res.generationId);
        setReattachedBusy(true);
        resumeGeneration(res.sessionId, sendingAgent || agent!, res.generationId);
      } else {
        renderGenerateResult(res, false, text);
        setTimeout(scrollToEnd, 80);
      }
    } catch (e) {
      if (isUnauthorized(e)) promptLogin('登录态已失效，请重新登录');
      const reply = errorReply(e);
      // P2-15：保留原文供重试；但审核类错误不给重试（重试必再被拦）。
      setMsgs((m) => [...m, { role: 'assistant', reply: { text: reply }, retryText: isModerationErr(reply) ? undefined : text, uid: nextMsgUid() }]);
    } finally {
      if (!handedOff) {
        if (pendingSessionIdRef.current) clearChatPending(pendingSessionIdRef.current);
        pendingSessionIdRef.current = '';
        setBusy(false);
      }
    }
  }

  // B2 停止生成：经 liveGen 中断当前流；收尾（清空占位 / busy）由 liveGen 走 aborted 分支处理。
  const stopGeneration = () => {
    if (!busy) return;
    // 主正文已经落库后只剩至多 3s 的推荐项收尾；此时不再展示/执行“停止”，避免假取消。
    if (activeGenerationPhaseRef.current === 'finalize') return;
    if (liveKeyRef.current && peekLiveGen(liveKeyRef.current)?.active) {
      stopLiveGen(liveKeyRef.current);
      return;
    }
    const generationId = activeGenerationIdRef.current;
    if (generationId) {
      void api.cancelGeneration(generationId)
        .then(() => Taro.showToast({ title: '正在停止', icon: 'none' }))
        .catch((e) => s.handleApiError(e));
    }
  };

  // —— 军师反问选项（ChatReply.asks）——
  // 只在「最后一条实质消息」是带 asks 的军师回复时激活（其后一旦出现用户消息/报告即自然失效，无需记答题状态）。
  let activeAskIdx = -1;
  if (!busy) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const mm = msgs[i];
      if (mm.role === 'memory' || mm.role === 'greet') continue;
      if (mm.role === 'assistant' && !mm.streaming && mm.reply?.asks?.length) activeAskIdx = i;
      break;
    }
  }
  // 这一段跑在渲染体里（不在 JSX 内），任何解引用抛错都直接整页白屏 —— reply/asks 一律按可缺处理。
  const rawAsks = activeAskIdx >= 0 ? (msgs[activeAskIdx] as Extract<Msg, { role: 'assistant' }>).reply?.asks : undefined;
  const activeAsks = Array.isArray(rawAsks) ? rawAsks : [];
  // 选择草稿按消息索引挂靠：换了一条新的提问消息即自动作废旧草稿。
  const [askDraft, setAskDraft] = useState<{ idx: number; sel: Record<number, string>; other: Record<number, string> }>({ idx: -1, sel: {}, other: {} });
  const [askComposerTarget, setAskComposerTarget] = useState<{ idx: number; qi: number } | null>(null);
  const askSel = askDraft.idx === activeAskIdx ? askDraft.sel : {};
  const askOther = askDraft.idx === activeAskIdx ? askDraft.other : {};
  const activeAskComposer = askComposerTarget?.idx === activeAskIdx ? askComposerTarget : null;
  // composer-dock 随问卷答题态显隐切换后（display:none 时测不到 rect，jumpBottom 保留旧值），
  // 重新出现时补测 --jump-bottom。此处才是 activeAskComposer 声明后的作用域（measureDock 的 effect 在其上方，引用会命中 TDZ）。
  useEffect(() => { setTimeout(measureDock, 80); }, [activeAskComposer]);
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

  // 撤掉一份粘贴长文时连本地全文一起忘掉：忘了才允许主公有意重新粘同一段（去重不该挡住真心想重来的）。
  const forgetPaste = (id: string) => { pasteTextRef.current.delete(id); };

  // 本轮里找一份「实质上就是这段」的已归卷长文，返回它的引用签 id（判定规则与用例见 services/pasteAbsorb）。
  const findDupPaste = (pasted: string): string => {
    let hit = '';
    pasteTextRef.current.forEach((text, id) => {
      if (!hit && isSamePaste(pasted, text)) hit = id;
    });
    return hit;
  };

  // 点卡片 = 看全文（不是删除）。旧实现整张卡的点击都走 toggleRef，主公想核对内容，一点反而把长文删了。
  // 全文取本地 pasteTextRef，点开即有、不打网络。refId 为空 = 还在归卷的占位卡，此时只能看不能移除。
  const openPastePreview = (refId: string, text: string) => {
    if (!text) return;
    setPastePreview({ refId, chars: text.length, text });
    store.setOverlay(true, 'paste-preview');
  };
  const closePastePreview = () => {
    setPastePreview(null);
    store.setOverlay(false, 'paste-preview');
  };

  // 长文粘贴 → 归为附卷：异步建知识，成功挂引用签；期间允许继续写草稿但禁止发送。
  // 关键时序：先落一张 pending 占位卡，再去打网络。输入框清空与卡片出现同帧——
  // 旧实现要等 createKnowledge 回来才 setRefs，弱网下就是「框里的字没了、卡片还没来」，主公只能理解成粘贴失败 → 再粘一遍。
  const absorbPasteToFile = async (pasted: string, retryKey?: string) => {
    const key = retryKey ?? `p${(pasteSeqRef.current += 1)}`;
    const chars = pasted.length;
    const title = `粘贴长文·${chars}字`;
    const excerpt = pasteExcerpt(pasted);
    setPastePendings((cur) => retryKey
      ? cur.map((p) => p.key === key ? { ...p, status: 'uploading' } : p)
      : [...cur, { key, chars, excerpt, text: pasted, status: 'uploading' }]);
    // 在途这一份也立刻记进账本（先挂占位 key，成功后换成真 id）：
    // 否则第一份还在打网络时又粘一遍，去重扫不到它，照样会出两份。
    pasteTextRef.current.set(key, pasted);
    pastePendingKeysRef.current.add(key);
    if (!isPasteHinted()) { setPasteHint(true); markPasteHinted(); }
    pasteInflightRef.current += 1;
    let succeeded = false;
    try {
      const { id } = await api.createKnowledge({ kind: 'document', title, text: pasted, sourceType: 'paste' });
      pasteTextRef.current.set(id, pasted);
      // ready 状态，无需标「拆读中」；再核一次上限，防并发越挂。
      setRefs((cur) => (cur.length >= UPLOAD_COUNT_MAX || cur.some((x) => x.kind === 'knowledge' && x.id === id))
        ? cur : [...cur, { kind: 'knowledge', id, label: title }]);
      succeeded = true;
    } catch {
      // 不再 writeInput(fullValue)：归卷期间用户可能已继续写了新草稿，
      // 异步失败回填会把新草稿整段覆盖。失败卡保留全文，可预览、重试或移除。
      setPastePendings((cur) => cur.map((p) => p.key === key ? { ...p, status: 'failed' } : p));
      Taro.showToast({ title: '长文归卷未成，可重试', icon: 'none' });
    } finally {
      pasteInflightRef.current -= 1;
      pastePendingKeysRef.current.delete(key);
      if (succeeded) {
        pasteTextRef.current.delete(key); // 占位 key 让位给真 id
        setPastePendings((cur) => cur.filter((p) => p.key !== key));
      }
    }
  };

  const removePastePending = (key: string) => {
    pasteTextRef.current.delete(key);
    pastePendingKeysRef.current.delete(key);
    setPastePendings((cur) => cur.filter((p) => p.key !== key));
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
    // 同一段长文本轮已经归过卷：不建第二份，把视线引回已在的那张卡。
    // （主公以为上一次没成功、又粘了一遍——这正是双份附卷的来路。）
    // 但命中的那份必须此刻真在屏上（在途占位卡，或已挂上的引用签）：极小概率下正文记了账却没挂上签
    // （并发把附卷顶到九份上限），那时说「已在附卷里」是在撒谎，得让这次照常归卷。
    const dupId = findDupPaste(pasted);
    const dupLive = !!dupId
      && (pastePendings.some((p) => p.key === dupId)
        || pastePendingKeysRef.current.has(dupId)
        || refs.some((x) => x.kind === 'knowledge' && x.id === dupId));
    if (dupId && !dupLive) forgetPaste(dupId);
    if (dupLive) {
      writeInput(kept);
      setPasteDupId(dupId);
      if (pasteDupTimerRef.current) clearTimeout(pasteDupTimerRef.current);
      pasteDupTimerRef.current = setTimeout(() => { setPasteDupId(''); pasteDupTimerRef.current = null; }, PASTE_DUP_FLASH_MS);
      Taro.showToast({ title: '这段长文已在附卷里', icon: 'none' });
      return;
    }
    // 附卷已满九份：不转，完整粘贴内容留在输入框，容主公自行取舍。
    if (refs.length + pasteInflightRef.current >= UPLOAD_COUNT_MAX) {
      Taro.showToast({ title: `附卷已满${UPLOAD_COUNT_MAX}份，容后再呈`, icon: 'none' });
      return;
    }
    void absorbPasteToFile(pasted);
    writeInput(kept);
  };

  // h5：Stencil 渲染出内部 <textarea> 才算就绪（见 nativeInputWrite 注释：早写会在 watchValue 里抛错，
  // 且被 Stencil 自己 catch 成一行 console.error，外层 try/catch 兜不住）。weapp 的 FormElement 无此结构，恒就绪。
  const inputElRendered = (el: any): boolean =>
    IS_WEAPP || (typeof el?.querySelector === 'function' && !!el.querySelector('textarea'));

  // 真正落到原生框的一步：未就绪就下一帧再试，作废/等不到就放弃（值仍在 input state 里，不丢）。
  const writeInputNative = (text: string, tries: number) => {
    const el = taRef.current;
    const step = nativeWriteStep({
      hasEl: !!el,
      elRendered: inputElRendered(el),
      stale: lastValueRef.current !== text,
      tries,
      maxTries: NATIVE_WRITE_MAX_TRIES,
    });
    if (step === 'drop') return;
    if (step === 'retry') {
      nativeWriteTimerRef.current = setTimeout(() => writeInputNative(text, tries + 1), NATIVE_WRITE_RETRY_MS);
      return;
    }
    try { el.value = text; } catch { /* noop */ }
  };

  // 程序性写入输入框（草稿恢复 / 粘贴归卷回填 / 粘贴结算 / 发送清空）。
  // Textarea 已解除受控（不绑 value），故必须经 ref 直写原生框：
  //  - weapp：taRef.current 是 Taro FormElement，其 value setter → setAttribute(VALUE) → setData，更新原生 textarea；
  //  - h5：taRef.current 是 Stencil <taro-textarea-core>，value 属性 @Watch 会回写内层 <textarea>。
  // setInput 仍要调（字数/发送键/草稿判定读 input state），但不再驱动 Textarea 显示；lastValueRef 供粘贴增量判定。
  const writeInput = (text: string) => {
    setInput(text);
    lastValueRef.current = text;
    // 上一次写入还在等原生节点就绪时又来一次：旧的直接作废，只留最新值。
    if (nativeWriteTimerRef.current) { clearTimeout(nativeWriteTimerRef.current); nativeWriteTimerRef.current = null; }
    writeInputNative(text, 0);
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
    if (pastePendings.length) {
      const failed = pastePendings.some((p) => p.status === 'failed');
      Taro.showToast({ title: failed ? '请先处理归卷失败的长文' : '长文归卷中，稍候再发', icon: 'none' });
      return;
    }
    const v = (typeof raw === 'string' ? raw : input).trim();
    if (!v || !agent) return;
    // 软限制守卫：手动堆出的超长（非粘贴）在此拦下——粘贴早已转附卷，不会走到这。
    if (v.length > INPUT_MAX) {
      Taro.showToast({ title: '言过两千，可精简或粘贴成附卷', icon: 'none' });
      return;
    }
    if (!store.isAuthed()) {
      promptLogin('登录后即可发送，刚才写的内容会为你保留', 'chat');
      return;
    }
    writeInput('');
    // 发送即作废在途的粘贴结算，免得定时器到点后把已清空/新输入误判成粘贴。
    if (pasteSettleTimerRef.current) { clearTimeout(pasteSettleTimerRef.current); pasteSettleTimerRef.current = null; }
    pasteBurstRef.current = null;
    setInputFocus(false);
    const sending = refs;
    setRefs([]);
    setParsingRefIds([]); // 引用签已随本轮发出；之后谁没读完由服务端 refNotices 据实说
    // 粘贴账本随这一轮出清：下一轮再粘同一段是新的一次引用，不该被上一轮的去重挡住。
    // 在途占位 key 不清（它们的 finally 还要用来收尾），发出后归卷成功仍会挂到新一轮的引用签上。
    pasteTextRef.current.forEach((_t, id) => { if (!pastePendingKeysRef.current.has(id)) pasteTextRef.current.delete(id); });
    setPasteHint(false);
    closePastePreview();
    doSend(v, sessionId, agent.key, sending);
  };

  const onKeyboardHeightChange = (e: { detail?: { height?: number } }) => {
    const next = Math.max(0, Number(e.detail?.height || 0));
    setKeyboardHeight(next);
    if (next > 0) setTimeout(scrollToEnd, 40);
  };

  // 海报成品图能力探测：只在海报设计师会话里问一次（模块级按 token 缓存 + 单飞，切会话不重复打服务端）。
  // 失败/未登录返回 null → 成果卡不显示出图入口，不弹错（探测失败不该打扰用户）。
  useEffect(() => {
    if (agent?.key !== 'poster' || !store.isAuthed()) return;
    let alive = true;
    void getCreativeStatus().then((st) => { if (alive) setCreativeStatus(st); });
    return () => { alive = false; };
  }, [agent?.key]);

  // 进海报确认页：带 sessionId + messageId 让服务端预填需求单。分包跳转失败必须提示（AGENTS.md §7.2）。
  const openPosterConfirm = (messageId?: string) => {
    if (!messageId) return;
    const qs = `?messageId=${encodeURIComponent(messageId)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`;
    const started = navTo(`/packages/work/poster/index${qs}`, {
      fail: () => Taro.showToast({ title: '成品图页面加载失败，请重试', icon: 'none' }),
    });
    if (!started) Taro.showToast({ title: '页面正在打开，请稍候', icon: 'none' });
  };

  // 回看已出的成品图：jobId 取成果消息里回写的 creativeJobId（服务端在任务成功时补进 contentJson）。
  // 没有这个入口，用户一离开详情页就再也找不回那张海报（本地在途标记进终态即清）。
  const openPosterJob = (jobId?: string) => {
    if (!jobId) return;
    const started = navTo(`/packages/work/posterJob/index?jobId=${encodeURIComponent(jobId)}`, {
      fail: () => Taro.showToast({ title: '成品图页面加载失败，请重试', icon: 'none' }),
    });
    if (!started) Taro.showToast({ title: '页面正在打开，请稍候', icon: 'none' });
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
      Taro.showToast({ title: '先让军师出一份方案，定了才能转成军令', icon: 'none' });
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
    // 订阅授权必须在点击手势内、且早于 loading 遮罩唤起：晚了微信不弹窗（授权失败不阻断生成）
    await requestWechatSubscribe('report').catch((e) => { console.warn('[subscribe] report 授权失败', e); });
    Taro.showLoading({ title: '生成网页版…' });
    try {
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
      promptLogin('登录后即可上传或引用资料', 'upload');
      return;
    }
    Taro.showActionSheet({
      itemList: ['上传资料（PDF/Word/Excel…）', '上传图片', '引用已有案卷 / 方案 / 资料'],
      success: (r) => {
        if (r.tapIndex === 0) uploadMaterial();
        else if (r.tapIndex === 1) uploadImage();
        else if (r.tapIndex === 2) openPicker();
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
      if (ok) Taro.showToast({ title: `${ok} 份已送达，拆读中…可以直接发问`, icon: 'none' });
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
      Taro.showToast({ title: `「${u.name}」已送达，拆读中`, icon: 'none' });
      return next;
    });
  };

  // 单张图片呈送：真进度 + 成功挂 image 引用（军师即可阅图）。
  const runImageUpload = async (u: UploadEntry) => {
    uploadCancelledRef.current[u.id] = false;
    patchUpload(u.id, { status: 'uploading', pct: 0 });
    try {
      const { id } = await api.uploadChatImage(u.path, projectId || undefined, u.name, {
        onProgress: (p) => patchUpload(u.id, { pct: p }),
        onTask: (t) => { uploadTasksRef.current[u.id] = t; },
      });
      if (uploadCancelledRef.current[u.id]) return; // 已撤回：不挂引用
      patchUpload(u.id, { status: 'done', pct: 100 });
      // 图片直接 ready，无「拆读」态；挂上 image 引用签，签名预览 URL 由 effect 按需补取。
      setRefs((cur) => cur.some((x) => x.kind === 'image' && x.id === id) ? cur : [...cur, { kind: 'image', id, label: '图片' }]);
    } catch (e) {
      if (uploadCancelledRef.current[u.id]) return;
      patchUpload(u.id, { status: 'failed' });
      Taro.showToast({ title: (e as Error).message || '图片没能呈上', icon: 'none' });
    } finally {
      uploadTasksRef.current[u.id] = null;
    }
  };

  // 上传图片：微信选图（相册/拍照）→ 逐张呈送 → 挂为本轮 image 引用。单条至多 4 张（与服务端阅图上限对齐）。
  const uploadImage = async () => {
    if (!IS_WEAPP) { Taro.showToast({ title: '请在微信小程序内上传图片', icon: 'none' }); return; }
    const remain = Math.min(4, UPLOAD_COUNT_MAX - refs.length);
    if (remain <= 0) { Taro.showToast({ title: `一次至多带 ${UPLOAD_COUNT_MAX} 份，容后再呈`, icon: 'none' }); return; }
    let chosen: Taro.chooseImage.SuccessCallbackResult;
    try {
      chosen = await Taro.chooseImage({ count: remain, sizeType: ['compressed'], sourceType: ['album', 'camera'] });
    } catch (e) {
      const msg = String((e as { errMsg?: string })?.errMsg || '');
      if (!/cancel/i.test(msg)) Taro.showToast({ title: '没能打开相册，请重试', icon: 'none' });
      return; // 用户取消则静默
    }
    const files = (chosen.tempFiles || []).slice(0, remain);
    if (!files.length) return;
    // 单张体积上限（与 server 10MB 对齐）：一张超限即整批不发，提示压缩后再来。
    for (const f of files) {
      const chk = checkImageUpload({ size: f.size });
      if (!chk.ok) { Taro.showToast({ title: chk.desc || '图片太大', icon: 'none' }); return; }
    }
    const batch: UploadEntry[] = files.map((f, i) => ({
      id: `img-${Date.now()}-${i}`,
      name: '图片',
      size: f.size || 0,
      path: f.path,
      pct: 0,
      status: 'waiting' as UploadStatus,
    }));
    setUploads((cur) => ({ ...cur, ...Object.fromEntries(batch.map((u) => [u.id, u])) }));
    for (const u of batch) await runImageUpload(u); // 串行逐张呈送
    setUploads((cur) => {
      const next = { ...cur };
      let ok = 0;
      for (const u of batch) {
        const st = next[u.id]?.status;
        if (st === 'done') ok++;
        if (st === 'done' || st === 'cancelled') delete next[u.id];
      }
      if (ok) Taro.showToast({ title: `${ok} 张已送达，我现在就看`, icon: 'none' });
      return next;
    });
  };

  // 打开 @引用选择器：拉取可引用的 案卷/方案/资料
  const openPicker = async () => {
    setInputFocus(false);
    if (!store.isAuthed()) {
      promptLogin('登录后即可引用你的案卷、方案和资料', 'save');
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
    // 撤掉粘贴长文时连指纹与本地全文一起忘掉：忘了才允许主公有意重新粘同一段。
    if (isPasteRef(r) && refs.some((x) => x.kind === r.kind && x.id === r.id)) forgetPaste(r.id);
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
        {/* 历史窗口化：仅当仍有更早历史未展开时露出——点一次向前补一窗（军师文风）。 */}
        {histShown < fullMsgsRef.current.length ? (
          <View className="hist-more" onClick={expandEarlier}>
            <Text className="hist-more-t" style={{ color: accent }}>阅早前问对</Text>
          </View>
        ) : null}
        {msgs.map((m, i) => {
          if (m.role === 'greet') {
            return (
              <View key={m.uid} className="msg a">
                <View className="who"><AdvisorAvatar agentKey={m.agent.key} size={24} /><Text>{m.agent.name}</Text></View>
                <View className="bubble" onLongPress={() => copyText(m.agent.greet)}>
                  <Text>{m.agent.greet}</Text>
                  <View className="memory-disclosure">
                    <View className="md-h">
                      <Icon name="layers" size={13} color={accent} />
                      <Text style={{ color: accent }}>军师印象</Text>
                    </View>
                    <Text className="md-copy">我会参考你在本账号存的企业档案、历史偏好和本次引用的资料，让建议保持同一套业务口径。</Text>
                    <View className="md-tags">
                      <Text>企业档案</Text>
                      <Text>对话偏好</Text>
                      <Text>引用资料</Text>
                    </View>
                  </View>
                  <View className="acts">
                    {/* chips 来自 GET /agents（服务端 chipsJson 列），非数组时 .map 抛错即白屏 —— 兜一层空数组。 */}
                    {(Array.isArray(m.agent?.chips) ? m.agent.chips : []).map(([ic, label]) => (
                      <View key={label} className="act-chip" onClick={() => doSend(label, sessionId, m.agent.key)}>
                        <Icon name={ic} size={13} color={accent} /><Text>{label}</Text>
                      </View>
                    ))}
                  </View>
                </View>

                {/* 问诊四问（新设计稿 diagnosis-card）：只在总军师的新会话露出——
                    专业军师线程有自己的开场，已经聊起来的会话再摆一遍四问就是噪音。
                    下面的 chips 按「卡点」进对话，与上面 acts 里按「产出」进对话的服务端 chips 互补，不替换它们。 */}
                {m.agent.key === 'general' && msgs.length <= 1 ? (
                  <View className="diagnosis-card">
                    <Text className="dg-t">今天先把案卷跑通</Text>
                    <Text className="dg-s">你可以先按这 4 件事讲，讲不全也没关系，我会继续问。</Text>
                    <View className="dg-list">
                      {DIAGNOSIS_ASKS.map(([k, d], di) => (
                        <View key={k} className="dg-row">
                          <Text className="dg-no serif" style={{ background: 'var(--accent-soft)', color: accent }}>{di + 1}</Text>
                          <Text className="dg-rt"><Text className="dg-rk">{k}</Text>：{d}</Text>
                        </View>
                      ))}
                    </View>
                    <View className="dg-chips">
                      {DIAGNOSIS_CHIPS.map((c) => (
                        <View key={c.label} className="dg-chip" style={{ borderColor: accent }} onClick={() => doSend(c.text, sessionId, m.agent.key)}>
                          <Text style={{ color: accent }}>{c.label}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                ) : null}
              </View>
            );
          }
          if (m.role === 'user') {
            return (
              <View key={m.uid} className="msg u">
                {/* 附件在正文之上：与输入区「卡片在上、输入框在下」同序，也与 ChatGPT / Claude 的用户轮一致。
                    旧版把 .uref 当 .msg.u 的第二个 flex 子节点，行方向下气泡与附件卡并排挤在一行，多份时排版彻底散掉。 */}
                {m.refs?.length ? (
                  <View className="uref">
                    {m.refs.map((r, j) => {
                      if (r.kind === 'image') {
                        const url = imageUrls[r.id];
                        return (
                          <View key={j} className="uref-img" onClick={() => previewImageRef(r.id)}>
                            {url
                              ? <Image className="uref-img-el" src={url} mode="aspectFill" />
                              : <View className="uref-img-ph"><Icon name="image" size={18} color={accent} /></View>}
                          </View>
                        );
                      }
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
                <View className="ubub" style={{ background: accent }} onLongPress={() => copyText(m.text)}><Text>{m.text}</Text></View>
              </View>
            );
          }
          if (m.role === 'assistant') {
            return (
              <View key={m.uid} className="msg a">
                <View className="who"><AdvisorAvatar agentKey={agent?.key ?? 'general'} size={24} /><Text>{agent?.name}</Text></View>
                <View className="ai-text" onLongPress={() => copyText(replyToText(m.reply))}>
                  {m.streaming && !m.reply?.text ? (
                    <View className="think-dots">
                      <View className="think-dot" style={{ background: accent }} />
                      <View className="think-dot d2" style={{ background: accent }} />
                      <View className="think-dot d3" style={{ background: accent }} />
                    </View>
                  ) : (
                    <MarkdownText text={m.streaming ? visibleStreamText(m.reply?.text) : m.reply?.text} streaming={m.streaming} selectable />
                  )}
                  {Array.isArray(m.reply?.points) && m.reply.points.length ? (
                    <View className="points">
                      {m.reply.points.map((p, j) => <View key={j} className="pt"><View className="pd" style={{ background: accent }} /><MarkdownText text={p} className="pt-t" selectable /></View>)}
                    </View>
                  ) : null}
                </View>
                {/*
                  「还没写完」提示。服务端撞输出上限时已自动续写，走到这里说明连续写几轮都没收住
                  （多半是用户要的其实是一份报告）。正文是真内容、不是错误，所以这里只做**说明 + 续写入口**，
                  绝不做成错误气泡。
                  续写入口只挂在最后一条上：点它是往会话末尾追加一轮，模型接的是最新上下文；
                  历史里更早那条即使也没写完，也只保留说明，不给按钮——否则点了会接错地方。
                */}
                {!m.streaming && m.reply?.truncated ? (
                  <View className="unfinished">
                    <Icon name="pen" size={13} color={accent} />
                    <Text className="unfinished-t">内容较长，先写到这里</Text>
                    {i === msgs.length - 1 ? (
                      <Text
                        className={`unfinished-go ${busy ? 'off' : ''}`}
                        style={busy ? {} : { color: accent }}
                        onClick={() => { if (!busy) doSend(CONTINUE_REQUEST_TEXT, sessionId, agent?.key ?? '', [], true); }}
                      >
                        继续写完
                      </Text>
                    ) : null}
                  </View>
                ) : null}
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
                            {(Array.isArray(a?.options) ? a.options : []).map((op) => (
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
              <View key={m.uid} className="mem-learned" onLongPress={() => copyText(`${m.agentName} 记下了这次对话里的偏好和口径，往后说话会更贴你的实际。`)}>
                <Icon name="spark" size={13} color={accent} />
                <Text>{m.agentName} 记下了这次对话里的偏好和口径，往后说话会更贴你的实际。</Text>
              </View>
            );
          }
          // report
          // 报告操作硬条件（2026-07-28 假完成修复）：必须有真实落库 messageId、非空正文、非流式、
          // 非降级草稿，才开放查看/分享/存入/认可。此前只看 streaming 位——断流对账交回轮询后卡片
          // 被误收成非流式（messageId 为空、正文可能半截），操作全开、状态误写「已生成」。
          const reportReady = !m.streaming && !!m.messageId && !m.deliverable?.degraded && (m.deliverable?.sections?.length ?? 0) > 0;
          // 出图入口条件：海报设计师 + 成品图能力已开启 + 本卡是已落库可操作成果（降级/半截卡不给出图，
          // 否则等于拿一份不完整方案去扣钻石）。能力关闭时整块不渲染，不做「点了再报 403」。
          const posterEntryOn = reportReady && agent?.key === 'poster' && !!creativeStatus?.enabled;
          return (
            // P2-14：报告气泡用稳定 uid 作 key（创建即有，先于 messageId），避免「延迟插入记忆 / 顶部插历史」导致索引位移、ReportCard 渐显动画状态错位。
            <View key={m.uid ?? m.messageId ?? `r-${i}`} className="msg a">
              <View className="who"><AdvisorAvatar agentKey={agent?.key ?? 'general'} size={24} /><Text>{agent?.name}</Text></View>
              <View onLongPress={() => copyDeliverable(m.deliverable)}>
                <ReportCard
                  data={m.deliverable}
                  animate={m.animate}
                  streaming={m.streaming}
                  operable={reportReady}
                  saved={m.saved}
                  onView={reportReady ? () => shareReport(m.messageId) : undefined}
                  onSave={reportReady ? () => saveDeliverable(m.deliverable, m.messageId) : undefined}
                  onShareMenu={reportReady ? (kind) => onReportShareMenu(kind, m.deliverable, m.messageId) : undefined}
                  posterPrice={posterEntryOn ? creativeStatus!.pricePerPoster : undefined}
                  onPoster={posterEntryOn ? () => openPosterConfirm(m.messageId) : undefined}
                  onViewPoster={m.deliverable?.creativeJobId ? () => openPosterJob(m.deliverable.creativeJobId) : undefined}
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
                  硬条件同上（reportReady），中断/降级/未落库一律不开放认可，先重试补全再认可。 */}
              {reportReady && !m.retryText ? (
                <View className="accept-card">
                  <View className="accept-b">
                    <Text className="accept-t">这份方案，就按这个来？</Text>
                    <Text className="accept-d">存入方案库留一版，执行页承接军令与复盘。</Text>
                  </View>
                  <View className="accept-btn" style={{ background: accent }} onClick={() => acceptPlan(m.deliverable)}>
                    <Icon name="check" size={13} color="#fff" />
                    <Text>就按这个来 · 去执行</Text>
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
      {/* 问卷答题激活时视觉隐藏（display:none），让 chat-log 吃掉这块空间、少被键盘遮挡；不卸载以保住 taRef 与测量稳定 */}
      <View className={`composer-dock ${activeAskComposer ? 'ask-hidden' : ''}`}>
        {/* 顶沿渐隐：让对话内容读成「从输入区底下过去」，而不是被齐平裁断。absolute 在 dock 盒外，
            不影响 .composer-dock 的 boundingClientRect（jump-latest 定位靠它测高） */}
        <View className="dock-fade" />
        {/* B5：非模态上传清单（逐份真进度 / 逐份可撤回；失败可单独重递或删掉） */}
        {uploadList.length ? (
          <View className="upload-bar">
            <View className="ub-head">
              <Text className="ub-t">
                {uploading
                  ? `发送资料 ${uploadList.filter((u) => u.status === 'done').length}/${uploadList.length}`
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

        {/* 已选引用（刚传上来的标「拆读中」：正文还没拆完，此刻发问军师未必读得到）
            粘贴长文单独走一张宽卡：露字数 + 内容摘要 + 可点开看全文，主公才认得出「这就是我刚粘的那段」。 */}
        {(refs.length || pastePendings.length) ? (
          <View className="ref-row">
            {refs.map((r, j) => {
              if (isPasteRef(r)) {
                const c = refCardParts(r);
                const text = pasteTextRef.current.get(r.id) ?? '';
                return (
                  <View
                    key={j}
                    className={`paste-card ${pasteDupId === r.id ? 'dup' : ''}`}
                    style={pasteDupId === r.id ? { borderColor: accent } : {}}
                    onClick={() => openPastePreview(r.id, text)}
                  >
                    <View className="paste-ic" style={{ background: 'var(--accent-soft)' }}>
                      <Icon name={c.icon} size={15} color={accent} />
                    </View>
                    <View className="paste-b">
                      <Text className="paste-t">粘贴长文 · {r.label.replace('粘贴长文·', '')}</Text>
                      <Text className="paste-m">{text ? pasteExcerpt(text) : '点开可看全文'}</Text>
                    </View>
                    <Text
                      className="paste-x"
                      onClick={(e) => { e.stopPropagation?.(); forgetPaste(r.id); setRefs((cur) => cur.filter((x) => !(x.kind === r.kind && x.id === r.id))); }}
                    >✕</Text>
                  </View>
                );
              }
              return (
                <View key={j} className="ref-chip" style={{ borderColor: accent }} onClick={() => toggleRef(r)}>
                  {r.kind === 'image' && imageUrls[r.id]
                    ? <Image className="ref-chip-thumb" src={imageUrls[r.id]} mode="aspectFill" />
                    : <Icon name={refCardParts(r).icon} size={12} color={accent} />}
                  <Text className="ref-chip-l" style={{ color: accent }}>{refCardParts(r).title}</Text>
                  {r.kind === 'knowledge' && parsingRefIds.includes(r.id) ? <Text className="ref-parsing">拆读中</Text> : null}
                  <Text className="ref-x">✕</Text>
                </View>
              );
            })}
            {/* 归卷在途的占位卡：与输入框清空同帧出现，弱网也不会出现「字没了、卡还没来」的空窗 */}
            {pastePendings.map((p) => (
              <View
                key={p.key}
                className={`paste-card pending ${p.status === 'failed' ? 'failed' : ''} ${pasteDupId === p.key ? 'dup' : ''}`}
                style={pasteDupId === p.key ? { borderColor: accent } : {}}
                onClick={() => openPastePreview('', p.text)}
              >
                <View className="paste-ic" style={{ background: 'var(--accent-soft)' }}>
                  <Icon name="doc" size={15} color={accent} />
                </View>
                <View className="paste-b">
                  <Text className="paste-t">粘贴长文 · {p.chars}字</Text>
                  <Text className="paste-m">{p.excerpt}</Text>
                </View>
                {p.status === 'uploading' ? <Text className="paste-badge">归卷中</Text> : (
                  <View className="paste-failed-actions" onClick={(e) => e.stopPropagation?.()}>
                    <Text className="paste-retry" style={{ color: accent }} onClick={() => { void absorbPasteToFile(p.text, p.key); }}>重试</Text>
                    <Text className="paste-remove" onClick={() => removePastePending(p.key)}>移除</Text>
                  </View>
                )}
              </View>
            ))}
          </View>
        ) : null}

        {/* 「长文自动归卷」只解释这一次：toast 一闪就没，说不清也留不住 */}
        {pasteHint && (refs.some(isPasteRef) || pastePendings.length) ? (
          <View className="paste-hint">
            <Text className="paste-hint-t">长文已归为附卷，军师会通读全文；点卡片可查看或移除。</Text>
            <Text className="paste-hint-x" onClick={() => setPasteHint(false)}>知道了</Text>
          </View>
        ) : null}

        {/* 输入区：高度自适应卡片，底排为 加号(资料) / 选模型 / 语音·发送 */}
        <View className={`composer ${busy ? 'busy' : ''}`}>
          <View className="box" onClick={() => { if (!busy) setInputFocus(true); }}>
            <Textarea
              ref={taRef}
              className="cinput"
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
                  activeGenerationPhase === 'finalize' || (reattachedBusy && !activeGenerationId) ? (
                    <View className="csend waiting" aria-label="容我想想" style={{ borderColor: accent }}>
                      <View className="waiting-dot" style={{ background: accent }} />
                    </View>
                  ) : (
                    // 当前页发起时由 liveGen 取消；重进后由 generationId 取消，二者都是真停止。
                    <View
                      className="csend stop"
                      role="button"
                      aria-label="停止生成"
                      style={{ background: accent }}
                      onClick={(e) => { e.stopPropagation?.(); stopGeneration(); }}
                    >
                      <View className="stop-sq" />
                    </View>
                  )
                ) : (
                  <View
                    className={`csend ${!input.trim() || pastePendings.length ? 'off' : ''}`}
                    role="button"
                    aria-label="发送"
                    style={input.trim() && !pastePendings.length ? { background: accent } : {}}
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

      {/* 粘贴长文预览：点卡片打开。看全文（消除「到底传上去没有」的疑心）+ 复制 + 移除。
          不做「放回输入框」——本页发送硬上限 2000 字，把 2000+ 的长文塞回去只会撞上限，是死路。 */}
      {pastePreview ? (
        <View className="ref-sheet">
          <View className="ref-mask" onClick={closePastePreview} />
          <View className="ref-panel paste-panel">
            <View className="ref-ph">
              <Text className="ref-pt">粘贴长文 · {pastePreview.chars}字</Text>
              <Text className="ref-done" style={{ color: accent }} onClick={closePastePreview}>关闭</Text>
            </View>
            <View className="paste-scroll">
              <ScrollView scrollY className="paste-body" enhanced showScrollbar={false}>
                <View className="paste-body-in">
                  {/* Taro Text 合法的长按选择属性只有 selectable；userSelect 不是（见 MarkdownText/selectProps） */}
                  <Text className="paste-full" selectable>{pastePreview.text}</Text>
                </View>
              </ScrollView>
              {/* 与 dock-fade 同一套渐隐：正文滑到动作条前先化掉，而不是被齐平切在半个字上 */}
              <View className="paste-body-fade" />
            </View>
            <View className="paste-acts">
              <View className="paste-act" onClick={() => copyText(pastePreview.text, '全文已复制')}>
                <Text style={{ color: accent }}>复制全文</Text>
              </View>
              {pastePreview.refId ? (
                <View
                  className="paste-act del"
                  onClick={() => {
                    const id = pastePreview.refId;
                    forgetPaste(id);
                    setRefs((cur) => cur.filter((x) => !(x.kind === 'knowledge' && x.id === id)));
                    closePastePreview();
                  }}
                >
                  <Text>移除这份</Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>
      ) : null}

      <Login
        open={showLogin}
        reason={loginReason}
        onClose={() => setShowLogin(false)}
        onLoggedIn={() => {
          setShowLogin(false);
          initChat();
        }}
      />
    </View>
  );
}

function stripTags(html: string): string {
  // memText 来自 GET /agents（服务端非空列），但运营后台/版本覆盖链路一旦回 null 就会在渲染期抛错；
  // 这一处在军师印象条上，抛错即整页白屏，故按字符串强制处理。
  return String(html ?? '').replace(/<[^>]+>/g, '');
}
function data_delay(d: Deliverable): number {
  return 900 + (Array.isArray(d?.sections) ? d.sections.length : 0) * 640 + 500;
}
