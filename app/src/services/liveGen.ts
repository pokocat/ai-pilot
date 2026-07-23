import { generateStream, type StreamControl, type StreamHandlers } from './streaming';
import { api } from './api';
import { markChatPending, clearChatPending } from './chatPending';
import type { GenRequest, GenResult, ChatReply, Deliverable, DeliverableSection } from '../../../shared/contracts';

/**
 * liveGen —— 跨页面存活的「军师推演」单例。
 *
 * 病灶：对话页发问后，thinking / streaming 由本地 busy + 消息对象的 streaming 标志驱动，
 * 组件卸载即随之丢失；而底层 wx.request 流并不随页面销毁取消，仍在后台空转。
 * 退出对话列表再重进，只从已落库消息还原（生成中途从不落库），thinking 指示器凭空消失。
 *
 * 方案：把一轮生成的「流生命周期 + 累计快照」上提到模块级单例（不随组件卸载而亡），
 * 页面只做「可插拔的观察者」。事件先落 liveGen（累计文本 / 分段 / 阶段），再转发给当前挂着的
 * 页面 view；页面卸载即 detach（停止 UI 副作用，快照照常累计），重进即 attach 并重放快照，
 * 让 thinking / 逐字流无缝续在新页面上。
 *
 * 约定：一轮生成对应一个 entry；同一 entry 同一时刻至多挂一个 view。
 * 新会话（发问时尚无 sessionId）先用临时 key 落账，收到服务端 session 事件里的真实 sessionId 后
 * 追加为别名（不删临时 key），令「按临时 key stop/detach」与「按真实 sessionId 重进 attach」都能命中。
 */

// 报告段落降级降噪：liveGen 侧只做「累计供重放」的极简合并（h 默认名交由 view 侧补），
// 与 chat/index.tsx 的 mergeReportSection 同构但不含展示兜底。
function mergeSnapshotSection(
  sections: (DeliverableSection & { index?: number })[],
  section: DeliverableSection & { index?: number },
): (DeliverableSection & { index?: number })[] {
  const { index, ...rest } = section as DeliverableSection & { index?: number };
  const next = sections.slice();
  const clean = rest as DeliverableSection & { index?: number };
  if (typeof index === 'number' && index >= 0) next[index] = clean;
  else next.push(clean);
  return next.filter(Boolean);
}

const isModerationErr = (s?: string) => !!s && /审核/.test(s);

// 页面提供的 UI 观察者：liveGen 在「实时事件」与「重进重放」两条路径上调用同一组方法，
// 页面据此做 setMsgs / 滚动 / busy 等副作用。所有方法都应对「当前无对应气泡」保持幂等/安全。
export interface LiveGenView {
  onSession(sessionId: string): void;
  startChat(): void;
  appendToken(text: string): void;
  setChat(reply: ChatReply): void;
  startReport(): void;
  reportBegin(data: { title: string; icon: string; meta: string }): void;
  reportSection(section: DeliverableSection & { index?: number }): void;
  reportFooter(data: { trust: string; actions: string[] }): void;
  finishChat(messageId: string | undefined, refNotices: string[] | undefined): void;
  finishReport(messageId: string | undefined, refNotices: string[] | undefined): void;
  error(kind: LiveKind, message: string, retry: string | undefined): void;
  fallbackDone(res: GenResult, retryText: string): void;
  memoryLearned(agentName: string): void;
  // 主动停止：清掉尚无一字的空聊天占位（有字则收干净为非流式）。
  abortedChat(): void;
  // 无论哪条收尾路径，最终统一清 busy（幂等）。
  clearBusy(): void;
}

type LiveKind = 'chat' | 'report' | null;
type LiveStage = 'active' | 'done' | 'error';

export interface LiveGenStartParams {
  key: string;                 // 临时 key（新会话）或真实 sessionId
  sessionId: string;           // 新会话为 ''
  agentKey: string;
  userText: string;            // 供失败重试回填
  body: GenRequest;
  view: LiveGenView | null;
  // 报告收尾自动入库需要的两个页面侧回调（发问时捕获；即便页面已卸载，其网络/存储副作用仍有效，
  // 只有其中的 setMsgs 类 UI 更新在卸载后自然 no-op）。
  buildDeliverable: (
    begin: { title: string; icon: string; meta: string } | undefined,
    sections: DeliverableSection[],
    footer: { trust: string; actions: string[] } | undefined,
  ) => Deliverable;
  autoSave: (d: Deliverable, messageId: string | undefined, opts: { auto?: boolean }) => void | Promise<void>;
}

interface LiveGenEntry {
  key: string;
  sessionId: string;
  agentKey: string;
  userText: string;
  body: GenRequest;
  buildDeliverable: LiveGenStartParams['buildDeliverable'];
  autoSave: LiveGenStartParams['autoSave'];
  // —— 累计快照 ——
  kind: LiveKind;
  stage: LiveStage;
  text: string;                // 聊天累计 token
  reply?: ChatReply;           // 完整聊天回复（onChat 到达后）
  reportBeginData?: { title: string; icon: string; meta: string };
  sections: (DeliverableSection & { index?: number })[];
  reportFooterData?: { trust: string; actions: string[] };
  messageId?: string;
  refNotices?: string[];
  pendingRefNotices: string[];
  learnedAgentName: string;
  errorMessage?: string;
  // —— 运行态 ——
  view: LiveGenView | null;
  control: StreamControl;
  aborted: boolean;
  streamErrored: boolean;
  dropTimer?: ReturnType<typeof setTimeout>;
}

// key（临时 key 与真实 sessionId 皆可）→ entry。
// 会话列表「军师正在思考」标记不走 liveGen 订阅，改由服务端 SessionDetail.generating +
// 客户端 chatPending 标记覆盖（更权威、且不漏后台完成的落库态），故此处无需 entries 集合/订阅机制。
const byKey = new Map<string, LiveGenEntry>();

function register(entry: LiveGenEntry, key: string) {
  if (!key) return;
  byKey.set(key, entry);
}
function bindSession(entry: LiveGenEntry, sessionId: string) {
  if (!sessionId || entry.sessionId === sessionId) return;
  entry.sessionId = sessionId;
  register(entry, sessionId); // 追加别名，临时 key 保留
  // 新会话拿到真实 sessionId：立刻登记 chatPending，桥接「服务端登记 generating 前」的窗口期，
  // 令「刚发问即返回列表 / 重进」也不会闪掉思考态。
  markChatPending(sessionId);
}
function drop(entry: LiveGenEntry) {
  if (entry.dropTimer) { clearTimeout(entry.dropTimer); entry.dropTimer = undefined; }
  for (const [k, v] of byKey) if (v === entry) byKey.delete(k);
}
function scheduleDrop(entry: LiveGenEntry) {
  if (entry.dropTimer) clearTimeout(entry.dropTimer);
  // 收尾后短暂保留：给「收尾瞬间正好重进」留出对账窗口（重进侧对 done/error 一律丢弃、以落库为准）。
  entry.dropTimer = setTimeout(() => drop(entry), 1500);
}

// —— 流阶段推进（liveGen 持有 report/chat 分流与首启守卫，view 只被动应用 UI）——
function startChat(entry: LiveGenEntry) {
  if (entry.kind) return;
  entry.kind = 'chat';
  entry.view?.startChat();
}
function startReport(entry: LiveGenEntry) {
  if (entry.kind === 'report') return;
  entry.kind = 'report';
  entry.view?.startReport();
}

function handleDone(entry: LiveGenEntry, messageId?: string) {
  const refNotices = entry.pendingRefNotices.length ? entry.pendingRefNotices : undefined;
  entry.messageId = messageId;
  entry.refNotices = refNotices;
  if (entry.kind === 'report') {
    entry.view?.finishReport(messageId, refNotices);
    // 自动入库：报告收尾后静默存入方案库。放在 liveGen（而非 view）里做，保证「退页面后台完成」
    // 一样会入库（网络 + 本地 saved 标记有效；view 侧 markMsgSaved 在无页面时自然 no-op）。
    if (messageId) {
      const d = entry.buildDeliverable(entry.reportBeginData, entry.sections, entry.reportFooterData);
      Promise.resolve().then(() => entry.autoSave(d, messageId, { auto: true }));
    }
  } else if (entry.kind === 'chat') {
    entry.view?.finishChat(messageId, refNotices);
  }
  if (entry.learnedAgentName) entry.view?.memoryLearned(entry.learnedAgentName);
}

function handleError(entry: LiveGenEntry, message: string) {
  entry.streamErrored = true;
  entry.errorMessage = message;
  const retry = isModerationErr(message) ? undefined : entry.userText;
  entry.view?.error(entry.kind, message, retry);
}

function makeHandlers(entry: LiveGenEntry): StreamHandlers {
  return {
    onSession: (id) => { if (id) { bindSession(entry, id); entry.view?.onSession(id); } },
    onReportStart: () => startReport(entry),
    onChatStart: () => startChat(entry),
    onReportBegin: (data) => {
      startReport(entry);
      entry.reportBeginData = data;
      entry.view?.reportBegin(data);
    },
    onReportSection: (section) => {
      startReport(entry);
      entry.sections = mergeSnapshotSection(entry.sections, section);
      entry.view?.reportSection(section);
    },
    onReportFooter: (data) => {
      startReport(entry);
      entry.reportFooterData = data;
      entry.view?.reportFooter(data);
    },
    onToken: (t) => {
      if (entry.kind === 'report') return;
      startChat(entry);
      entry.text += t;
      entry.view?.appendToken(t);
    },
    onChat: (reply) => {
      if (entry.kind === 'report') return;
      startChat(entry);
      entry.reply = reply;
      entry.view?.setChat(reply);
    },
    onRefNotices: (ns) => { entry.pendingRefNotices = ns; },
    onMemory: (data) => { if (data.learned && data.agentName) entry.learnedAgentName = data.agentName; },
    onDone: (messageId) => handleDone(entry, messageId),
    onError: (em) => handleError(entry, em),
  };
}

async function drive(entry: LiveGenEntry) {
  const control: StreamControl = { abort: () => {} };
  entry.control = control;
  let streamOk = false;
  try {
    streamOk = await generateStream(entry.body, makeHandlers(entry), control);
  } catch {
    streamOk = false;
  }

  if (entry.aborted) {
    // 主动停止：聊天空占位清掉，report 卡由下方双保险收尾。
    if (entry.kind === 'chat') entry.view?.abortedChat();
  } else if (!streamOk && entry.kind !== 'report' && !entry.streamErrored) {
    // 静默失败（流未正常收尾、onError 从未触发、且未进 report 分支）：同步补发一次。
    // 这一步是真正的兜底生成（api.generate 会落库），即便页面已卸载也必须执行，否则用户什么都拿不到。
    try {
      const res = await api.generate(entry.body);
      entry.kind = res.kind === 'report' ? 'report' : 'chat';
      entry.messageId = res.messageId;
      if (res.sessionId) bindSession(entry, res.sessionId);
      entry.view?.fallbackDone(res, entry.userText);
    } catch (e) {
      const msg = String((e as { message?: string })?.message || '') || '生成失败';
      entry.streamErrored = true;
      entry.errorMessage = msg;
      entry.view?.error(entry.kind, msg, isModerationErr(msg) ? undefined : entry.userText);
    }
  }

  // P0-5 双保险：报告流无论结果（含主动停止 / 中途抛错），最终强制把报告卡 streaming 置 false，
  // 避免流未触发 onDone/onError 时报告卡永久停在「产出中」。幂等：onDone 已收尾时守卫不命中即 no-op。
  if (entry.kind === 'report') entry.view?.finishReport(entry.messageId, entry.refNotices);

  entry.view?.clearBusy();
  entry.stage = entry.errorMessage ? 'error' : 'done';
  // 收尾汇合处（done / error / abort / 兜底补发所有路径都经此）：清 chatPending。此后本轮以落库消息为准，
  // 列表页与重进不再据 chatPending 误显「正在思考」。新会话若从未绑定 sessionId 则为 no-op。
  if (entry.sessionId) clearChatPending(entry.sessionId);
  scheduleDrop(entry);
}

/** 发问入口：登记 entry、启动流、（若有）绑定初始 view。返回可用于 stop/detach 的 key。 */
export function startLiveGen(p: LiveGenStartParams): string {
  const entry: LiveGenEntry = {
    key: p.key,
    sessionId: p.sessionId,
    agentKey: p.agentKey,
    userText: p.userText,
    body: p.body,
    buildDeliverable: p.buildDeliverable,
    autoSave: p.autoSave,
    kind: null,
    stage: 'active',
    text: '',
    sections: [],
    pendingRefNotices: [],
    learnedAgentName: '',
    view: p.view,
    control: { abort: () => {} },
    aborted: false,
    streamErrored: false,
  };
  register(entry, p.key);
  // 已有 sessionId（追问既有会话）：发问即登记 chatPending。新会话的登记推迟到 bindSession 拿到真实 id。
  if (p.sessionId) { register(entry, p.sessionId); markChatPending(p.sessionId); }
  void drive(entry);
  return entry.key;
}

function lookup(key: string): LiveGenEntry | undefined {
  return key ? byKey.get(key) : undefined;
}

// 重进对账用：只看是否仍在推演。
export function peekLiveGen(key: string): { active: boolean } | null {
  const entry = lookup(key);
  if (!entry) return null;
  return { active: entry.stage === 'active' };
}

/** 页面挂载：绑定 view 并把当前累计快照重放到新页面，让 thinking / 逐字流续上。返回是否仍在推演。 */
export function attachLiveGenView(key: string, view: LiveGenView): { active: boolean } {
  const entry = lookup(key);
  if (!entry) return { active: false };
  entry.view = view;
  replay(entry, view);
  return { active: entry.stage === 'active' };
}

function replay(entry: LiveGenEntry, view: LiveGenView) {
  // 仅重放「进行中」内容以重建气泡；已 done/error 的对账交给调用方（以落库消息为准），此处不重放终态。
  if (entry.kind === 'chat') {
    view.startChat();
    if (entry.text) view.appendToken(entry.text);
    if (entry.reply) view.setChat(entry.reply);
  } else if (entry.kind === 'report') {
    view.startReport();
    if (entry.reportBeginData) view.reportBegin(entry.reportBeginData);
    entry.sections.forEach((s, i) => view.reportSection({ ...s, index: i }));
    if (entry.reportFooterData) view.reportFooter(entry.reportFooterData);
  }
  // kind 尚为 null（纯 thinking，未出任何内容）：不建气泡，由页面 busy 展示全局「正在梳理上下文」，
  // 首个 token/section 实时到达时再经 startChat/startReport 建气泡——即 thinking→streaming 的自然过渡。
}

/** 页面卸载：解绑 view（停止 UI 副作用，快照照常累计），不终止流。 */
export function detachLiveGenView(key: string, view: LiveGenView) {
  const entry = lookup(key);
  if (entry && entry.view === view) entry.view = null;
}

/** 用户点「停止」：中断底层请求；drive 的收尾走 aborted 分支。 */
export function stopLiveGen(key: string) {
  const entry = lookup(key);
  if (!entry) return;
  entry.aborted = true;
  entry.control.abort();
}

/** 重进对账：确认该轮已落库/无需重放时，丢弃 entry。 */
export function dropLiveGen(key: string) {
  const entry = lookup(key);
  if (entry) drop(entry);
}
