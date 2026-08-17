import { generateStream, type StreamControl, type StreamHandlers, type StreamErrorKind } from './streaming';
import { api } from './api';
import { markChatPending, clearChatPending } from './chatPending';
import { classifyReconcileTick, reportCloseAction, type ReconcileOutcome } from './liveGenCore';
import { apiErrorPresentation } from './apiError';
import type {
  GenRequest, GenResult, ChatReply, Deliverable, DeliverableSection, SessionDetail, SessionMessage,
  GenerationPhase, GenerationStatus, ImageGenerationProgress,
} from '../../../shared/contracts';

// 收尾裁决的纯逻辑在 liveGenCore（可单测）；这里保留 re-export 兼容既有引用（chat/index.tsx）。
export { storedReplyFor } from './liveGenCore';

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

// 断流对账：客户端断链 ≠ 生成失败。小程序切后台会杀掉在途请求，而服务端照常算完并落库（报告尤其如此：
// 正文一次性生成，逐段下发只是呈现节奏）。故断流后先向服务端核实再判生死，最多 RECONCILE_TRIES 次、
// 每次间隔 RECONCILE_GAP_MS；次数用尽仍无定论才落回失败态——有限重试，绝不无限循环。
const RECONCILE_TRIES = 3;
const RECONCILE_GAP_MS = 1200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 页面提供的 UI 观察者：liveGen 在「实时事件」与「重进重放」两条路径上调用同一组方法，
// 页面据此做 setMsgs / 滚动 / busy 等副作用。所有方法都应对「当前无对应气泡」保持幂等/安全。
export interface LiveGenView {
  onSession(sessionId: string): void;
  onGeneration(data: { generationId: string; phase?: GenerationPhase; status?: GenerationStatus; imageProgress?: ImageGenerationProgress | null; refNotices?: string[] }): void;
  startChat(): void;
  appendThought(text: string): void;
  appendToken(text: string): void;
  replaceToken(text: string): void;
  setChat(reply: ChatReply): void;
  startReport(): void;
  reportBegin(data: { title: string; icon: string; meta: string }): void;
  reportSection(section: DeliverableSection & { index?: number }): void;
  reportFooter(data: { trust: string; actions: string[] }): void;
  finishChat(messageId: string | undefined, refNotices: string[] | undefined): void;
  finishReport(messageId: string | undefined, refNotices: string[] | undefined): void;
  // broken=true：断流对账后仍判定失败（链路断的，非服务端明确回错）。页面据此记账，回前台时再兜一次底。
  error(kind: LiveKind, message: string, retry: string | undefined, broken?: boolean, code?: string, statusCode?: number): void;
  fallbackDone(res: GenResult, retryText: string): void;
  // 断流对账「已落库」：以服务端消息为准整体重绘本页（走与加载路径同一套 restore），不留半截中断卡。
  restoreServerTruth(detail: SessionDetail): void;
  // 断流对账「仍在生成」：交回页面的 generating 轮询兜底。liveGen 就此退出本轮，保持两条恢复路径互斥。
  resumeServerPolling(sessionId: string): void;
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
  generationId?: string;
  generationPhase?: GenerationPhase;
  generationStatus?: GenerationStatus;
  imageProgress?: ImageGenerationProgress | null;
  buildDeliverable: LiveGenStartParams['buildDeliverable'];
  autoSave: LiveGenStartParams['autoSave'];
  // —— 累计快照 ——
  kind: LiveKind;
  stage: LiveStage;
  text: string;                // 聊天累计 token
  thought: string;             // 模型主动撰写的公开思路摘要（不含隐藏 reasoning）
  reply?: ChatReply;           // 完整聊天回复（onChat 到达后）
  reportBeginData?: { title: string; icon: string; meta: string };
  sections: (DeliverableSection & { index?: number })[];
  reportFooterData?: { trust: string; actions: string[] };
  messageId?: string;
  refNotices?: string[];
  pendingRefNotices: string[];
  learnedAgentName: string;
  errorMessage?: string;
  errorCode?: string;
  errorStatusCode?: number;
  // —— 运行态 ——
  view: LiveGenView | null;
  control: StreamControl;
  aborted: boolean;
  streamErrored: boolean;
  // 收到断流类 onError，收尾推迟到 drive 里对账后再定（见 reconcileDisconnect）。
  disconnected: boolean;
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

function surfaceError(entry: LiveGenEntry, message: string, broken = false, code = entry.errorCode, statusCode = entry.errorStatusCode) {
  const source = Object.assign(new Error(message), { code, statusCode });
  const shown = apiErrorPresentation(source, message);
  const retry = shown.retryable ? entry.userText : undefined;
  entry.view?.error(entry.kind, shown.message, retry, broken, code, statusCode);
}

function handleError(entry: LiveGenEntry, message: string, kind: StreamErrorKind, code?: string, statusCode?: number) {
  // streamErrored 立刻置位：对账推迟的只是「怎么收尾」，不能让 drive 的静默失败兜底趁这个空档重发一轮。
  entry.streamErrored = true;
  entry.errorMessage = message;
  entry.errorCode = code;
  entry.errorStatusCode = statusCode;
  if (kind === 'disconnect' && !entry.aborted) {
    entry.disconnected = true; // 断线不当死讯：收尾交给 drive 的对账
    return;
  }
  surfaceError(entry, message);
}

type ReconcileResult = Exclude<ReconcileOutcome, null>;

// 对账认定本轮已完成：撤掉断流留下的失败态，改按正常收尾语义走。
function applyStoredReply(entry: LiveGenEntry, detail: SessionDetail, stored: SessionMessage) {
  entry.streamErrored = false;
  entry.errorMessage = undefined;
  entry.errorCode = undefined;
  entry.errorStatusCode = undefined;
  entry.kind = stored.role === 'report' ? 'report' : 'chat';
  entry.messageId = stored.id;
  entry.view?.restoreServerTruth(detail);
  // 报告自动入库：与 handleDone 同一副作用，页面不在场也要执行（网络/存储副作用有效）。
  // 内容取服务端落库的完整成果，不用本地被掐断的残缺快照。
  if (entry.kind === 'report' && stored.content) {
    const d = stored.content as Deliverable;
    Promise.resolve().then(() => entry.autoSave(d, stored.id, { auto: true }));
  }
  if (entry.learnedAgentName) entry.view?.memoryLearned(entry.learnedAgentName);
}

async function reconcileDisconnect(entry: LiveGenEntry): Promise<ReconcileResult> {
  if (!entry.sessionId) return 'dead'; // 新会话连 sessionId 都没拿到，无从对账
  for (let i = 0; i < RECONCILE_TRIES; i++) {
    if (i) await sleep(RECONCILE_GAP_MS);
    // 对账期间用户按了停止：返回值不再重要，drive 的 aborted 分支优先收尾。
    if (entry.aborted) return 'dead';
    let detail: SessionDetail | null = null;
    try { detail = await api.session(entry.sessionId); } catch { detail = null; }
    if (entry.aborted) return 'dead';
    if (!detail) continue; // 对账请求本身也可能被后台掐断，用完剩余次数再判
    // 单次判定收拢到纯核：已落库 → stored；仍在生成且页面在场 → handoff；否则 pending 继续等
    // ——报告落库通常比 generating 落幕早一步，多等一轮就能等到，进而完成自动入库。
    const tick = classifyReconcileTick({
      messages: detail.messages,
      generating: !!detail.generating,
      userText: entry.userText,
      hasView: !!entry.view,
    });
    if (tick.verdict === 'stored') { applyStoredReply(entry, detail, tick.stored); return 'stored'; }
    if (tick.verdict === 'handoff' && entry.view) {
      entry.streamErrored = false;
      entry.errorMessage = undefined;
      entry.view.resumeServerPolling(entry.sessionId);
      return 'handoff';
    }
  }
  return 'dead';
}

function makeHandlers(entry: LiveGenEntry): StreamHandlers {
  return {
    onGeneration: (data) => {
      entry.generationId = data.generationId;
      entry.generationPhase = data.phase;
      entry.generationStatus = data.status;
      entry.imageProgress = data.imageProgress;
      if (data.refNotices?.length) entry.pendingRefNotices = data.refNotices;
      if (data.sessionId) bindSession(entry, data.sessionId);
      entry.view?.onGeneration(data);
      // 用户可能在建单响应回来前就点了停止；拿到持久任务 id 后才真正发取消，
      // 不能只 abort 订阅连接（退出/断网都不等于取消）。
      if (entry.aborted) {
        void cancelThenAbort(entry, data.generationId);
      }
    },
    onSession: (id) => { if (id) { bindSession(entry, id); entry.view?.onSession(id); } },
    onReportStart: () => startReport(entry),
    onChatStart: () => startChat(entry),
    onThought: (text) => {
      if (entry.kind === 'report') return;
      startChat(entry);
      entry.thought += text;
      entry.view?.appendThought(text);
    },
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
    onToken: (t, replace) => {
      if (entry.kind === 'report') return;
      startChat(entry);
      if (replace) {
        entry.text = t;
        entry.view?.replaceToken(t);
      } else {
        entry.text += t;
        entry.view?.appendToken(t);
      }
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
    onError: (em, kind, code, statusCode) => handleError(entry, em, kind, code, statusCode),
  };
}

async function drive(entry: LiveGenEntry) {
  const control: StreamControl = { abort: () => {} };
  entry.control = control;
  let streamOk = false;
  let syncHandoff = false;
  try {
    streamOk = await generateStream(entry.body, makeHandlers(entry), control);
  } catch {
    streamOk = false;
  }

  // 断流（非主动停止）：先向服务端对账，别拿一次断链当死讯。对账结论决定下面怎么收尾。
  const reconciled: ReconcileResult | null =
    !entry.aborted && entry.disconnected ? await reconcileDisconnect(entry) : null;

  if (entry.aborted) {
    // 主动停止：聊天空占位清掉，report 卡由下方收尾裁决按中断收（不装「已生成」）。
    if (entry.kind === 'chat') entry.view?.abortedChat();
  } else if (reconciled === 'dead') {
    // 对账无果（服务端确实没落库、也不在生成，或对账请求本身也断了）：这才是真失败。
    surfaceError(entry, entry.errorMessage || '网络连接中断', true);
  } else if (!reconciled && !streamOk && entry.kind !== 'report' && !entry.streamErrored) {
    // 静默失败（流未正常收尾、onError 从未触发、且未进 report 分支）：同步补发一次。
    // 这一步是真正的兜底生成（api.generate 会落库），即便页面已卸载也必须执行，否则用户什么都拿不到。
    try {
      const res = await api.generate(entry.body);
      if (res.sessionId) bindSession(entry, res.sessionId);
      if (res.generationId && (res.status === 'queued' || res.status === 'running')) {
        // 同步兜底复用了同一 clientRequestId，202 表示原 job 仍在跑，不是空结果。
        // 交给持久任务轮询，禁止清 busy 或渲染“生成失败”。
        entry.generationId = res.generationId;
        if (entry.sessionId && entry.view) {
          syncHandoff = true;
          entry.view.resumeServerPolling(entry.sessionId);
        }
      } else {
        entry.kind = res.kind === 'report' ? 'report' : 'chat';
        entry.messageId = res.messageId;
        entry.view?.fallbackDone(res, entry.userText);
      }
    } catch (e) {
      const msg = String((e as { message?: string })?.message || '') || '生成失败';
      const code = String((e as { code?: string })?.code || '') || undefined;
      const statusCode = Number((e as { statusCode?: number })?.statusCode) || undefined;
      entry.streamErrored = true;
      entry.errorMessage = msg;
      entry.errorCode = code;
      entry.errorStatusCode = statusCode;
      surfaceError(entry, msg, false, code, statusCode);
    }
  }

  // 报告卡收尾裁决（2026-07-28 假完成修复，取代旧 P0-5「无脑 finishReport」双保险）：
  // - handoff/stored：轮询或服务端真值已接管本卡，这里绝不能再收——旧行为在 handoff 后仍调
  //   finishReport，把还在生成的卡收成「已生成」（无 messageId、正文可能半截），正是线上假完成的病灶；
  // - 有真实 messageId：正常完成收尾（onDone 已收过时守卫不命中即 no-op，保持幂等）；
  // - 无 id 且错误路径没收过（主动停止 / 流静默结束）：按中断收尾，保留已流出分段 + 重试，不装完成。
  const close = reportCloseAction({
    kind: entry.kind,
    reconciled,
    messageId: entry.messageId,
    streamErrored: entry.streamErrored,
  });
  if (close === 'finish') entry.view?.finishReport(entry.messageId, entry.refNotices);
  else if (close === 'interrupt') surfaceError(entry, entry.aborted ? '已停止生成' : '生成连接中断，请稍后回来查看或重试');

  // 已把思考态交给页面轮询时不能清 busy——否则页面刚接手就被抹掉，重新卡成「什么都没有」。
  if (reconciled !== 'handoff' && !syncHandoff) entry.view?.clearBusy();
  entry.stage = entry.errorMessage ? 'error' : 'done';
  // 收尾汇合处（done / error / abort / 兜底补发所有路径都经此）：清 chatPending。此后本轮以落库消息为准，
  // 列表页与重进不再据 chatPending 误显「正在思考」。新会话若从未绑定 sessionId 则为 no-op。
  if (entry.sessionId && !syncHandoff) clearChatPending(entry.sessionId);
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
    thought: '',
    sections: [],
    pendingRefNotices: [],
    learnedAgentName: '',
    view: p.view,
    control: { abort: () => {} },
    aborted: false,
    streamErrored: false,
    disconnected: false,
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
  if (entry.generationId) {
    view.onGeneration({ generationId: entry.generationId, phase: entry.generationPhase, status: entry.generationStatus, imageProgress: entry.imageProgress, refNotices: entry.refNotices });
  }
  // 仅重放「进行中」内容以重建气泡；已 done/error 的对账交给调用方（以落库消息为准），此处不重放终态。
  if (entry.kind === 'chat') {
    view.startChat();
    if (entry.thought) view.appendThought(entry.thought);
    if (entry.text) view.replaceToken(entry.text);
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

/**
 * 通知服务端取消，然后无论成败都断掉本地订阅。
 * 取消失败对用户是不可行动的（本地已经停了，服务端那边最多多算一轮），所以吞掉错误——
 * 但必须显式 catch：`void p.finally(...)` 里 finally 返回的仍是会继承拒绝的 promise，
 * 取消接口一失败就是一条 unhandled rejection。
 */
async function cancelThenAbort(entry: LiveGenEntry, generationId: string): Promise<void> {
  try { await api.cancelGeneration(generationId); } catch { /* 取消失败不影响本地收尾 */ }
  entry.control.abort();
}

/** 用户点「停止」：中断底层请求；drive 的收尾走 aborted 分支。 */
export function stopLiveGen(key: string) {
  const entry = lookup(key);
  if (!entry) return;
  entry.aborted = true;
  // 尚未拿到 generationId 时只置 aborted：建单响应回来后由 onGeneration 补发取消。
  // 只 abort 订阅连接不等于取消（退出/断网都会断订阅，服务端仍照常算完）。
  if (entry.generationId) {
    void cancelThenAbort(entry, entry.generationId);
  }
}

/** 重进对账：确认该轮已落库/无需重放时，丢弃 entry。 */
export function dropLiveGen(key: string) {
  const entry = lookup(key);
  if (entry) drop(entry);
}
