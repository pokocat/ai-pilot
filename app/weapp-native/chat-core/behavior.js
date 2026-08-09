// 问策对话核心（主包）。分包页可以引用主包文件，反向不行——所以对话核心必须落在主包，
// 供 packages/main/chat 与后续「问策 tab 内嵌总军师对话」共用。
// 这里只承载与页面宿主无关的逻辑：消息加载/规范化、发送、SSE 流式对接、生成态/停止/重试、
// 键盘避让、粘贴归卷、asks 问答卡、成果卡闭环。导航参数解析、页头与返回键留在各宿主页。
const { api } = require('../services/api');
const store = require('../services/store');
const { generateStream } = require('../services/streaming');
const { navTo } = require('../services/nav');
const { diffPasted, pasteExcerpt, isSamePaste } = require('../services/paste-absorb');
const { stripSerializedAsksTail, streamVisibleText, extendsShown, attachmentOnlyPrompt } = require('../services/chat-reply');

// towxml 流式打字机（548K）留在 packages/main/vendor/towxml 分包里，主包不得反向 require 分包文件。
// 宿主页在自己的包内取到 globalCb 后调用 useStreamRenderer 注入，下面的调用点与抽取前一字不差。
const streamRenderer = { setMdText() {}, setStreamFinish() {}, stopImmediatelyCb() {} };
// 打字机是否真的接上了。宿主页用 require.async 跨包异步取 globalCb 时**可能失败**（弱网首启、
// 分包未下载完），那时三个回调仍是 no-op：如果照样给消息发 streamRenderId，模板就会渲染一个
// 永远收不到文字的 towxml，真机上就是一片空白。所以这里记账，未接上时改走纯文本兜底（见 ensureStreamItem）。
let streamRendererReady = false;
function useStreamRenderer(next) {
  if (!next || typeof next !== 'object') return false;
  let injected = 0;
  for (const key of ['setMdText', 'setStreamFinish', 'stopImmediatelyCb']) {
    if (typeof next[key] === 'function') { streamRenderer[key] = next[key]; injected += 1; }
  }
  if (injected === 3) streamRendererReady = true;
  return streamRendererReady;
}
function hasStreamRenderer() { return streamRendererReady; }
function setMdText(id, text) { streamRenderer.setMdText(id, text); }
function setStreamFinish(id) { streamRenderer.setStreamFinish(id); }
function stopImmediatelyCb(id) { streamRenderer.stopImmediatelyCb(id); }

const ALIASES = { general: '玄衡', strat: '观澜', growth: '青衍', ip: '鸣璋', ops: '照微', org: '云枢', intel: '察远' };
const PORTRAITS = {
  general: 'general', strat: 'strat', growth: 'growth', ip: 'ip', ops: 'ops', org: 'org',
  intel: 'strat', fund: 'org', model: 'growth', brand: 'ip', promo: 'ip', poster: 'growth',
  shortvideo: 'strat', copy: 'org',
};
const PORTRAIT_POOL = ['general', 'strat', 'growth', 'ip', 'ops', 'org'];
const REF_KIND_LABEL = { project: '案卷', report: '方案', knowledge: '附卷', memory: '军师印象', image: '图片' };
const REF_KIND_ICON = { project: 'layers', report: 'doc', knowledge: 'doc', memory: 'spark', image: 'image' };
const TERMINAL = new Set(['completed', 'truncated', 'failed', 'cancelled']);
const ASK_OTHER = '__other__';
const INPUT_MAX = 2000;
const PASTE_DELTA_MIN = 500;
const PASTE_SETTLE_MS = 250;
const PASTE_DUP_FLASH_MS = 1800;
const REF_LIMIT = 9;
// 没有打字机时纯文本兜底的回写节流：这条路径本来就违反「SSE token 到达不整段 setData」的口径，
// 只在降级时启用，节流到 120ms 把 setData 次数压到可接受范围（正常路径永远走 towxml 增量解析）。
const PLAIN_STREAM_MS = 120;

function avatarFor(agentKey) {
  const key = textOf(agentKey) || 'general';
  let portrait = PORTRAITS[key];
  if (!portrait) {
    let hash = 0;
    for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) % 997;
    portrait = PORTRAIT_POOL[hash % PORTRAIT_POOL.length];
  }
  return `/assets/avatars/generated/${portrait}-imagegen.jpg`;
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function stringList(value) {
  return Array.isArray(value) ? value.map(textOf).filter(Boolean) : [];
}

function displayRef(ref) {
  const value = ref && typeof ref === 'object' ? ref : {};
  const kind = textOf(value.kind) || 'knowledge';
  const kindLabel = REF_KIND_LABEL[kind] || '资料';
  const parts = textOf(value.label).split('·').map((part) => part.trim()).filter(Boolean);
  const title = parts[0] || textOf(value.label) || kindLabel;
  const extra = parts.slice(1).join(' · ');
  return Object.assign({}, value, {
    kind,
    isImage: kind === 'image',
    icon: REF_KIND_ICON[kind] || 'doc',
    viewTitle: title,
    viewMeta: extra ? `${extra} · ${kindLabel}` : kindLabel,
  });
}

function presentRefs(value) { return Array.isArray(value) ? value.map(displayRef) : []; }

function mergedStrings(...values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    for (const item of stringList(value)) {
      if (seen.has(item)) continue;
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function addLine(lines, value, prefix) {
  const text = textOf(value).trim();
  if (text) lines.push(`${prefix || ''}${text}`);
}

function cellText(value) {
  return textOf(value) || textOf(value && value.text);
}

function isReportReady(messageId, deliverable) {
  return Boolean(
    textOf(messageId).trim()
    && deliverable
    && typeof deliverable === 'object'
    && deliverable.degraded !== true
    && Array.isArray(deliverable.sections)
    && deliverable.sections.length > 0,
  );
}

function reportText(deliverable) {
  if (!deliverable) return '';
  const lines = [];
  addLine(lines, deliverable.title);
  if (deliverable.cover && deliverable.cover.title !== deliverable.title) addLine(lines, deliverable.cover.title);
  addLine(lines, deliverable.cover && deliverable.cover.subtitle);
  addLine(lines, deliverable.cover && deliverable.cover.motto);
  addLine(lines, deliverable.meta);
  for (const section of Array.isArray(deliverable.sections) ? deliverable.sections : []) {
    if (!section || typeof section !== 'object') continue;
    const heading = textOf(section.h).trim();
    if (heading) lines.push(`【${heading}】`);
    addLine(lines, section.sub);
    addLine(lines, section.b);
    for (const item of stringList(section.list)) addLine(lines, item, '· ');
    if (section.type === 'hero') {
      for (const paragraph of stringList(section.paras)) addLine(lines, paragraph);
    } else if (section.type === 'stats') {
      for (const item of Array.isArray(section.items) ? section.items : []) {
        addLine(lines, `${textOf(item && item.num)}${textOf(item && item.unit)}${item && item.label ? ` · ${textOf(item.label)}` : ''}`);
      }
    } else if (section.type === 'roster') {
      addLine(lines, section.intro);
      for (const person of Array.isArray(section.people) ? section.people : []) {
        addLine(lines, [textOf(person && person.name), textOf(person && person.role)].filter(Boolean).join(' · '));
        addLine(lines, person && person.desc);
      }
    } else if (section.type === 'table') {
      const headers = stringList(section.headers);
      if (headers.length) lines.push(headers.join(' ｜ '));
      for (const row of Array.isArray(section.rows) ? section.rows : []) {
        const cells = (Array.isArray(row) ? row : []).map(cellText).filter(Boolean);
        if (cells.length) lines.push(cells.join(' ｜ '));
      }
    } else if (section.type === 'phases') {
      for (const phase of Array.isArray(section.items) ? section.items : []) {
        const tab = [textOf(phase && phase.tab), textOf(phase && phase.when)].filter(Boolean).join(' · ');
        addLine(lines, `${tab ? `【${tab}】` : ''}${textOf(phase && phase.h)}`);
        for (const action of stringList(phase && phase.actions)) addLine(lines, action, '· ');
        addLine(lines, phase && phase.kpi, '军令状：');
      }
    } else if (section.type === 'timeline') {
      for (const item of Array.isArray(section.items) ? section.items : []) {
        addLine(lines, [textOf(item && item.when), textOf(item && item.h)].filter(Boolean).join(' · '));
        addLine(lines, item && item.d);
      }
    } else if (section.type === 'quote') {
      addLine(lines, section.text);
      addLine(lines, section.cite, '—— ');
    } else if (section.type === 'letter') {
      addLine(lines, section.salute);
      for (const paragraph of stringList(section.paras)) addLine(lines, paragraph);
      addLine(lines, section.close);
      addLine(lines, section.sign);
    } else if (section.type === 'gauge') {
      addLine(lines, section.score, '总分：');
      addLine(lines, section.verdict);
      for (const item of Array.isArray(section.items) ? section.items : []) {
        addLine(lines, `${textOf(item && item.label)}：${textOf(item && item.score)}${item && item.note ? ` · ${textOf(item.note)}` : ''}`);
      }
    } else if (section.type === 'matrix') {
      const axes = stringList(section.xLabels).concat(stringList(section.yLabels));
      if (axes.length) lines.push(`坐标：${axes.join(' ｜ ')}`);
      for (const quad of Array.isArray(section.quads) ? section.quads : []) {
        const title = textOf(quad && quad.title).trim();
        if (title) lines.push(`【${title}】`);
        for (const item of stringList(quad && quad.items)) addLine(lines, item, '· ');
      }
    } else if (section.type === 'gantt') {
      const unit = textOf(section.unit) || '期';
      if (section.total != null) addLine(lines, `${textOf(section.total)}${unit}`, '总周期：');
      for (const row of Array.isArray(section.rows) ? section.rows : []) {
        const span = row && row.from != null && row.to != null ? `${textOf(row.from)}–${textOf(row.to)}${unit}` : '';
        addLine(lines, [textOf(row && row.label), span, textOf(row && row.note)].filter(Boolean).join(' · '));
      }
    } else {
      for (const paragraph of stringList(section.paras)) addLine(lines, paragraph);
      addLine(lines, section.text);
    }
  }
  if (Array.isArray(deliverable.actions) && deliverable.actions.length) {
    lines.push('【下一步】');
    for (const action of stringList(deliverable.actions)) addLine(lines, action, '· ');
  }
  addLine(lines, deliverable.trust);
  return lines.filter(Boolean).join('\n\n');
}

function normalizeReply(reply) {
  const value = reply && typeof reply === 'object' ? reply : {};
  const points = Array.isArray(value.points) ? value.points.map(textOf).filter(Boolean) : [];
  const asks = Array.isArray(value.asks) ? value.asks.map((ask, index) => {
    const source = ask && typeof ask === 'object' ? ask : {};
    const q = textOf(source.q || source.question).trim();
    const options = stringList(source.options).map((option, optionIndex) => ({ key: optionIndex, value: option }));
    return { key: index, q, options, selected: '', other: '', answer: '' };
  }).filter((ask) => ask.q && ask.options.length) : [];
  return { text: stripSerializedAsksTail(value.text, value.asks), points, asks, truncated: value.truncated === true };
}

function decorateActiveAsks(messages, busy) {
  const next = (messages || []).map((item) => Object.assign({}, item, { activeAsk: false }));
  if (busy) return next;
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const item = next[index];
    if (item && item.greet) continue;
    if (item && item.role === 'assistant' && !item.streaming && !item.typing && Array.isArray(item.asks) && item.asks.length) item.activeAsk = true;
    break;
  }
  return next;
}

function activeAskState(messages) {
  const messageIndex = (messages || []).findIndex((item) => item && item.activeAsk && Array.isArray(item.asks) && item.asks.length);
  if (messageIndex < 0) return { messageIndex: -1, answered: 0, total: 0, ready: false };
  const asks = messages[messageIndex].asks;
  const answered = asks.filter((ask) => textOf(ask && ask.answer).trim()).length;
  return { messageIndex, answered, total: asks.length, ready: asks.length > 1 && answered === asks.length };
}

function normalizeMessage(message, index) {
  const content = message && message.content;
  const knowledgeUsed = stringList(message && message.knowledgeUsed);
  const refNotices = stringList(message && message.refNotices);
  if (message.role === 'user') return { id: message.id || `u-${index}`, role: 'user', text: textOf(content && content.text), points: [], refs: presentRefs(message.refs) };
  if (message.role === 'report') return {
    id: message.id || `r-${index}`, messageId: message.id || '', role: 'assistant', text: reportText(content), points: [],
    report: true, reportReady: isReportReady(message.id, content), deliverable: content, saved: Boolean(message.saved || (content && content.saved)),
    knowledgeUsed, knowledgeUsedText: knowledgeUsed.join('、'), refNotices, refNoticesText: refNotices.join('；'),
  };
  const reply = normalizeReply(content);
  return {
    id: message.id || `a-${index}`, role: 'assistant', text: reply.text, points: reply.points, asks: reply.asks, truncated: reply.truncated,
    // 快捷回应：服务端 SessionMessage.chips 原样带进消息对象（当前唯一写入方是进场主动消息）。
    // 无 chips 的消息拿到空数组，模板据此不渲染这一排。
    chips: stringList(message && message.chips),
    knowledgeUsed, knowledgeUsedText: knowledgeUsed.join('、'), refNotices, refNoticesText: refNotices.join('；'),
  };
}

/**
 * chips 是否已经作废。规则只有一条：**本会话里用户开过口就不再显示**——
 * 点 chip 会立刻发出一条用户消息，手动发送同理，所以「有没有 user 轮」就是唯一判据，
 * 不用再另存一个「点过了」的标记（重进会话也能自然收敛）。
 */
function chipsSpentFor(messages) {
  return (messages || []).some((item) => item && item.role === 'user');
}

function normalizeDetailMessages(detail) {
  const messages = (detail && Array.isArray(detail.messages) ? detail.messages : [])
    .map(normalizeMessage)
    .filter((item) => item.text || item.report || (item.refs && item.refs.length) || (item.points && item.points.length) || (item.asks && item.asks.length));
  return decorateActiveAsks(messages, Boolean(detail && detail.generating));
}

function hasUnansweredTurn(messages, generating) {
  if (generating || !Array.isArray(messages) || !messages.length) return false;
  const last = messages[messages.length - 1];
  return Boolean(last && last.role === 'user' && textOf(last.text).trim());
}

function asList(value) { return Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : []); }
function cleanRef(ref) { return { kind: ref.kind, id: ref.id, label: ref.label, ...(ref.version ? { version: ref.version } : {}) }; }

function uid(prefix) { return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`; }

function decodeOption(value) {
  try { return decodeURIComponent(value || ''); } catch (_) { return String(value || ''); }
}

const data = {
  title: '总军师', alias: '玄衡', agentKey: 'general', advisorAvatar: avatarFor('general'), messages: [],
  busy: false, canStop: false, showThinking: false, canSend: false, canRetryLast: false, inputCount: 0, showCount: false,
  // composerSeed = textarea 的一次性初值，只在交替挂载的那一刻写。不变量：写进去之后
  // 到下一次重建之前绝不再动它——中途改成 '' 就等于把用户正在编辑的文字回灌掉。
  composerOdd: false, composerSeed: '', composerHeight: 124, keyboardHeight: 0, bottomAnchor: 'chat-bottom',
  showLogin: false, loginReason: 'chat', errorText: '', refs: [], uploading: false,
  regularRefs: [], pasteRefs: [], pastePendings: [], pasteHint: false, pasteDupId: '',
  pastePreview: null,
  chipsSpent: false,
  showPicker: false, pickerLoading: false, pickGroups: [], accepting: false, reportBusy: '',
  posterEnabled: false, posterPrice: 0,
  askAnsweredCount: 0, askTotal: 0, askRemaining: 0, askReady: false,
  askComposerOpen: false, askComposerMessage: -1, askComposerQuestion: -1,
};

// 宿主页在自己的 onLoad 里解析导航参数后调用；behavior 只认已解析好的配置对象。
const methods = {
  chatCoreLoad(options) {
    const config = options && typeof options === 'object' ? options : {};
    this._alive = true;
    this._epoch = 1;
    this._sendSeq = 0;
    this._pollSeq = 0;
    this._draft = '';
    this._lastInputValue = '';
    this._pasteBurst = null;
    this._pasteSettleTimer = null;
    this._pasteDupTimer = null;
    this._askScrollTimer = null;
    this._pasteSeq = 0;
    this._pasteTexts = new Map();
    this._sessionId = textOf(config.sessionId);
    this._agentKey = textOf(config.agentKey) || 'general';
    this._projectId = textOf(config.projectId);
    this._continue = config.continueLatest === true;
    this._refs = [];
    this._pendingPrompt = textOf(config.pendingPrompt);
    // localPrelude：宿主页本地合成的开场 assistant 消息（text + chips），**只在内存里渲染，
    // 零服务端写入**。用于游客态：他没有会话可续、也不该因为看一眼就在库里落一条消息。
    this._localPrelude = Array.isArray(config.localPrelude) ? config.localPrelude : [];
    this._sendEntry = '';
    this._plainStreamTimer = null;
    this._plainStreamIndex = null;
    this._plainStreamText = '';
    this._pollTimer = null;
    this._streamControl = null;
    this._generationId = '';
    this._streamIndex = null;
    this._streamText = '';
    this._streamShown = '';
    this._streamAutoScrollTimer = null;
    this._streamDoneStatus = '';
    this._runKnowledgeUsed = [];
    this._runRefNotices = [];
    this._askOtherDraft = '';
    this.initialize(this._epoch);
  },
  chatCoreUnload() {
    if (this.data && this.data.pastePreview) store.setOverlay(false, 'paste-preview');
    this._alive = false;
    this._epoch += 1;
    this._sendSeq += 1;
    this._pollSeq += 1;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    if (this._pasteSettleTimer) clearTimeout(this._pasteSettleTimer);
    if (this._pasteDupTimer) clearTimeout(this._pasteDupTimer);
    if (this._askScrollTimer) clearTimeout(this._askScrollTimer);
    if (this._plainStreamTimer) clearTimeout(this._plainStreamTimer);
    this._plainStreamTimer = null;
    this.stopStreamAutoScroll();
    const streamItem = this._streamIndex == null ? null : this.data.messages[this._streamIndex];
    if (streamItem && streamItem.streamRenderId) stopImmediatelyCb(streamItem.streamRenderId);
    if (this._streamControl && this._streamControl.abort) this._streamControl.abort();
    this._pollTimer = null;
    this._pasteSettleTimer = null;
    this._pasteDupTimer = null;
    this._askScrollTimer = null;
    this._streamControl = null;
  },
  isCurrent(epoch) { return this._alive && epoch === this._epoch; },
  /**
   * 对话核心 → 宿主页的单向事件出口。宿主页可选实现 `chatCoreEvent(name, props)`；
   * chat 分包页不实现 = 完全不埋点（埋点是问策 tab 的入口实验口径，不该跟着核心散到每个宿主）。
   * 埋点绝不能反过来影响对话：这里吞掉一切异常。
   */
  emitChatEvent(name, props) {
    if (typeof this.chatCoreEvent !== 'function') return;
    try { this.chatCoreEvent(name, props || {}); } catch (_) { /* 埋点失败不许波及主流程 */ }
  },
  /**
   * 代用户发送一段既有文字（chip 快捷回应 / 提示 pill）。
   * 刻意**不回填输入框**：textarea 铁律禁止绑定 value，没有任何合法路径能把文字写进去；
   * 直接代发与 chip 语义一致，也少一次「填进去还得自己点发送」的门槛。
   * 已有草稿时不发——那会静默吞掉用户正在写的话。
   */
  sendText(text, entry) {
    const value = textOf(text).trim();
    if (!value || this.data.busy) return false;
    if (this.hasDraft()) { wx.showToast({ title: '输入框里还有内容，先发出去', icon: 'none' }); return false; }
    if (!store.isAuthed()) {
      // 游客：走 _pendingPrompt 而不是 _draft。textarea 是非受控的，往 _draft 里塞一句
      // 屏幕上看不见的话，用户登录回来会看到「空输入框 + 发送键亮着」，一按发出一句他没写过的话。
      this._pendingPrompt = value;
      this._sendEntry = textOf(entry) || 'keyboard';
      this.safeSetData({ showLogin: true, loginReason: 'chat' });
      return false;
    }
    this._draft = value;
    this._lastInputValue = '';
    this._sendEntry = textOf(entry) || 'keyboard';
    this.send();
    return true;
  },
  tapChip(event) {
    if (this.data.busy || this.data.chipsSpent) return;
    const messageIndex = Number(event.currentTarget.dataset.message);
    const chipIndex = Number(event.currentTarget.dataset.index);
    const message = this.data.messages[messageIndex];
    const chip = textOf(message && message.chips && message.chips[chipIndex]).trim();
    if (!chip) return;
    this.emitChatEvent('chip_tap', { message_id: textOf(message.id), chip_idx: chipIndex });
    this.sendText(chip, 'chip');
  },
  safeSetData(patch, callback) {
    if (!this._alive) return;
    this.setData(patch, () => { if (this._alive && callback) callback(); });
  },
  refViewPatch(extra) {
    const refs = this._refs.slice();
    const next = extra || {};
    const pendings = Array.isArray(next.pastePendings) ? next.pastePendings : this.data.pastePendings;
    const uploading = Object.prototype.hasOwnProperty.call(next, 'uploading') ? Boolean(next.uploading) : this.data.uploading;
    return Object.assign({
      refs,
      pasteRefs: refs.filter((item) => item && item.isPaste),
      regularRefs: refs.filter((item) => !item || !item.isPaste),
      canSend: !this.data.busy && !uploading && !pendings.length && Boolean(this.draftText() || refs.length),
    }, next);
  },
  // 草稿只有一个真相源：非受控 textarea 的 bindinput 写进来的 _draft。
  // 长文粘贴不再把手打内容搬出输入框，所以这里没有第二段要拼。
  draftText() { return textOf(this._draft).trim(); },
  hasPendingPaste() { return Array.isArray(this.data.pastePendings) && this.data.pastePendings.length > 0; },
  draftStatePatch(extra) {
    const text = this.draftText();
    const count = text.length;
    return Object.assign({
      canSend: Boolean(text || this._refs.length) && !this.data.busy && !this.data.uploading && !this.hasPendingPaste(),
      inputCount: count,
      showCount: count >= 1800,
    }, extra || {});
  },
  askPatch(messages, busy) {
    const decorated = decorateActiveAsks(messages, Boolean(busy));
    const state = activeAskState(decorated);
    return {
      messages: decorated,
      askAnsweredCount: state.answered,
      askTotal: state.total,
      askRemaining: Math.max(0, state.total - state.answered),
      askReady: state.ready,
      askComposerOpen: false,
      askComposerMessage: -1,
      askComposerQuestion: -1,
      keyboardHeight: 0,
    };
  },
  hasDraft() { return Boolean(this.draftText()); },
  async resolveContinueSession(epoch) {
    if (this._sessionId || !this._continue || !store.isAuthed()) return;
    try {
      const sessions = asList(await api.sessions());
      if (!this.isCurrent(epoch)) return;
      const latest = sessions.find((item) => item.agentKey === this._agentKey || (item.agent && item.agent.key === this._agentKey));
      if (latest) this._sessionId = latest.id;
    } catch (_) { /* 无历史就按新对话进入 */ }
  },
  flushPendingPrompt(epoch) {
    const pageEpoch = epoch || this._epoch;
    if (!this.isCurrent(pageEpoch) || !store.isAuthed() || this.data.busy || !this._pendingPrompt || this.hasDraft()) return;
    this._draft = this._pendingPrompt;
    this._pendingPrompt = '';
    this.safeSetData({ canSend: true }, () => {
      setTimeout(() => { if (this.isCurrent(pageEpoch) && !this.data.busy) this.send(); }, 30);
    });
  },
  async initialize(epoch) {
    const agents = await store.loadAgents();
    if (!this.isCurrent(epoch)) return;
    const agent = agents.find((item) => item.key === this._agentKey) || agents.find((item) => item.key === 'general') || agents[0];
    this._agentKey = agent ? agent.key : 'general';
    const snapshot = store.snapshot();
    this.safeSetData({
      title: agent ? agent.name : '总军师', alias: ALIASES[this._agentKey] || '', agentKey: this._agentKey,
      advisorAvatar: avatarFor(this._agentKey),
      themeClass: snapshot.themeClass, colorKey: snapshot.colorKey,
    });
    this.loadCreativeStatus(epoch);
    await this.resolveContinueSession(epoch);
    if (!this.isCurrent(epoch)) return;
    if (this._sessionId && store.isAuthed()) await this.restoreSession(epoch);
    else if (this._localPrelude.length) {
      // 本地开场序列走普通 assistant 气泡（不是 greet 样式）：它承担的是「军师先开口」的语义，
      // 与服务端注入的主动消息在视觉上必须一致，否则游客登录后同一句话会换个长相。
      const messages = this._localPrelude.map((item, index) => ({
        id: `local-${index}`, role: 'assistant', text: textOf(item && item.text), points: [], asks: [],
        chips: stringList(item && item.chips), local: true,
      })).filter((item) => item.text);
      this.safeSetData(Object.assign(this.askPatch(messages, false), { chipsSpent: false }));
      this.emitChatEvent('prelude_show', { source: 'local', count: messages.length });
    } else this.safeSetData(this.askPatch([{ id: 'greet', role: 'assistant', text: (agent && agent.greet) || '坐下来聊聊。你眼下最难拿主意的是哪件事？', points: [], greet: true }], false));
    if (!this.isCurrent(epoch)) return;
    this.toBottom();
    this.measureComposer();
    this.flushPendingPrompt(epoch);
  },
  async restoreSession(epoch) {
    const pageEpoch = epoch || this._epoch;
    try {
      const detail = await api.session(this._sessionId);
      if (!this.isCurrent(pageEpoch)) return false;
      const agent = detail.agent || {};
      this._agentKey = detail.agentKey || this._agentKey;
      const messages = normalizeDetailMessages(detail);
      const active = detail.activeGeneration && !TERMINAL.has(detail.activeGeneration.status) ? detail.activeGeneration : null;
      const generating = Boolean(active || detail.generating);
      const canRetryLast = hasUnansweredTurn(messages, generating);
      this._streamIndex = null;
      this._generationId = active ? active.id : '';
      this.safeSetData(Object.assign({}, this.askPatch(messages, generating), {
        title: agent.name || this.data.title, alias: ALIASES[this._agentKey] || '', advisorAvatar: avatarFor(this._agentKey), messages,
        chipsSpent: chipsSpentFor(messages),
        busy: generating, canStop: Boolean(active), showThinking: generating, canSend: generating ? false : this.hasDraft(),
        canRetryLast, errorText: canRetryLast ? '军师这次没有完成回答。你的问题已经保留，可以直接重新回答。' : '',
      }), () => { this.toBottom(); this.measureComposer(); });
      this.loadCreativeStatus(pageEpoch);
      this.hydrateImageRefs(messages, pageEpoch);
      if (active) this.startPolling(active.id, pageEpoch);
      else if (detail.generating) this.startSessionPolling(pageEpoch);
      return true;
    } catch (error) {
      if (!this.isCurrent(pageEpoch)) return false;
      const kind = store.handleApiError(error, { silent: true });
      if (kind === 'unauthorized') this.safeSetData({ showLogin: true });
      else this.safeSetData({ errorText: error.message || '会话读取失败' });
      return false;
    }
  },
  closeLogin() { this.safeSetData({ showLogin: false }); },
  async loggedIn() {
    const epoch = this._epoch;
    const snapshot = store.snapshot();
    this.safeSetData({ showLogin: false, themeClass: snapshot.themeClass, colorKey: snapshot.colorKey });
    await this.resolveContinueSession(epoch);
    if (!this.isCurrent(epoch)) return;
    if (this._sessionId) {
      const restored = await this.restoreSession(epoch);
      if (!restored || !this.isCurrent(epoch)) return;
    }
    this.loadCreativeStatus(epoch);
    this.flushPendingPrompt(epoch);
  },
  async loadCreativeStatus(epoch) {
    const pageEpoch = epoch || this._epoch;
    if (this._agentKey !== 'poster' || !store.isAuthed()) {
      if (this.isCurrent(pageEpoch)) this.safeSetData({ posterEnabled: false, posterPrice: 0 });
      return;
    }
    try {
      const status = await api.creativeStatus();
      if (!this.isCurrent(pageEpoch) || this._agentKey !== 'poster') return;
      const price = Number(status && status.pricePerPoster);
      this.safeSetData({ posterEnabled: Boolean(status && status.enabled && Number.isFinite(price)), posterPrice: Number.isFinite(price) ? price : 0 });
    } catch (_) {
      if (this.isCurrent(pageEpoch)) this.safeSetData({ posterEnabled: false, posterPrice: 0 });
    }
  },
  askSelectionPatch(messages, extra) {
    const state = activeAskState(messages);
    return Object.assign({
      messages,
      askAnsweredCount: state.answered,
      askTotal: state.total,
      askRemaining: Math.max(0, state.total - state.answered),
      askReady: state.ready,
    }, extra || {});
  },
  activeAskMessage() {
    const index = this.data.messages.findIndex((item) => item && item.activeAsk && Array.isArray(item.asks) && item.asks.length);
    return index >= 0 ? { index, item: this.data.messages[index] } : null;
  },
  openAskComposer(event) {
    if (this.data.busy) return;
    const messageIndex = Number(event.currentTarget.dataset.message);
    const questionIndex = Number(event.currentTarget.dataset.question);
    const messages = this.data.messages.slice();
    const message = messages[messageIndex];
    if (!message || !message.activeAsk || !message.asks || !message.asks[questionIndex]) return;
    const asks = message.asks.slice();
    const ask = Object.assign({}, asks[questionIndex]);
    ask.selected = ASK_OTHER;
    ask.answer = textOf(ask.other).trim();
    asks[questionIndex] = ask;
    messages[messageIndex] = Object.assign({}, message, { asks });
    this._askOtherDraft = textOf(ask.other);
    this.safeSetData(this.askSelectionPatch(messages, {
      askComposerOpen: true,
      askComposerMessage: messageIndex,
      askComposerQuestion: questionIndex,
      composerHeight: 0,
    }), () => this.scrollToAskEditor(messageIndex, questionIndex));
  },
  onAskOtherFocus(event) {
    if (this.data.busy) return;
    const messageIndex = Number(event.currentTarget.dataset.message);
    const questionIndex = Number(event.currentTarget.dataset.question);
    const message = this.data.messages[messageIndex];
    const ask = message && message.activeAsk && message.asks && message.asks[questionIndex];
    if (!ask || ask.selected !== ASK_OTHER) return;
    this._askOtherDraft = textOf(ask.other);
    if (this.data.askComposerOpen && this.data.askComposerMessage === messageIndex && this.data.askComposerQuestion === questionIndex) {
      this.scrollToAskEditor(messageIndex, questionIndex);
      return;
    }
    this.safeSetData({ askComposerOpen: true, askComposerMessage: messageIndex, askComposerQuestion: questionIndex, composerHeight: 0 }, () => this.scrollToAskEditor(messageIndex, questionIndex));
  },
  scrollToAskEditor(messageIndex, questionIndex) {
    const mi = Number(messageIndex);
    const qi = Number(questionIndex);
    if (mi < 0 || qi < 0) return;
    if (this._askScrollTimer) clearTimeout(this._askScrollTimer);
    const epoch = this._epoch;
    const anchor = `ask-other-m${mi}-q${qi}`;
    this.safeSetData({ bottomAnchor: '' });
    this._askScrollTimer = setTimeout(() => {
      this._askScrollTimer = null;
      if (!this.isCurrent(epoch) || !this.data.askComposerOpen || this.data.askComposerMessage !== mi || this.data.askComposerQuestion !== qi) return;
      this.safeSetData({ bottomAnchor: anchor });
    }, 50);
  },
  pickAskOption(event) {
    if (this.data.busy) return;
    const messageIndex = Number(event.currentTarget.dataset.message);
    const questionIndex = Number(event.currentTarget.dataset.question);
    const option = textOf(event.currentTarget.dataset.option);
    if (option === ASK_OTHER) { this.openAskComposer(event); return; }
    const messages = this.data.messages.slice();
    const message = messages[messageIndex];
    if (!message || !message.activeAsk || !message.asks || !message.asks[questionIndex] || !option) return;
    if (message.asks.length === 1) { this.sendAskText(option); return; }
    const asks = message.asks.slice();
    const current = asks[questionIndex];
    const selected = current.selected === option ? '' : option;
    asks[questionIndex] = Object.assign({}, current, { selected, answer: selected });
    messages[messageIndex] = Object.assign({}, message, { asks });
    const closing = this.data.askComposerOpen && this.data.askComposerMessage === messageIndex && this.data.askComposerQuestion === questionIndex;
    this.safeSetData(this.askSelectionPatch(messages, closing ? { askComposerOpen: false, keyboardHeight: 0 } : {}), () => { if (closing) this.measureComposer(); });
  },
  onAskOtherInput(event) {
    // 可见原生 input 自己维护文字和选区。编辑中绝不把草稿回灌视图，
    // 否则在已有文字中间插入或拖动选区时，微信会把光标重新推到末尾。
    this._askOtherDraft = textOf(event.detail && event.detail.value);
  },
  finishAskOther(event) {
    const active = this.activeAskMessage();
    const hasValue = Boolean(event && event.detail && Object.prototype.hasOwnProperty.call(event.detail, 'value'));
    const value = textOf(hasValue ? event.detail.value : this._askOtherDraft).trim();
    const single = Boolean(active && active.item.asks.length === 1);
    this.closeAskComposer();
    if (single && value) this.sendAskText(value);
  },
  closeAskComposer() {
    if (!this.data.askComposerOpen && !this.data.keyboardHeight) return;
    if (this._askScrollTimer) clearTimeout(this._askScrollTimer);
    this._askScrollTimer = null;
    const messageIndex = this.data.askComposerMessage;
    const questionIndex = this.data.askComposerQuestion;
    const messages = this.data.messages.slice();
    const message = messages[messageIndex];
    const ask = message && message.activeAsk && message.asks && message.asks[questionIndex];
    if (ask && ask.selected === ASK_OTHER) {
      const asks = message.asks.slice();
      const value = textOf(this._askOtherDraft);
      asks[questionIndex] = Object.assign({}, ask, { other: value, answer: value.trim() });
      messages[messageIndex] = Object.assign({}, message, { asks });
    }
    this.safeSetData(this.askSelectionPatch(messages, { askComposerOpen: false, askComposerMessage: -1, askComposerQuestion: -1, keyboardHeight: 0, bottomAnchor: '' }), () => this.measureComposer());
  },
  onAskKeyboardHeight(event) {
    const height = Math.max(0, Number(event.detail && event.detail.height) || 0);
    const messageIndex = this.data.askComposerMessage;
    const questionIndex = this.data.askComposerQuestion;
    this.safeSetData({ keyboardHeight: height }, () => {
      if (height > 0) this.scrollToAskEditor(messageIndex, questionIndex);
    });
  },
  sendAskText(value) {
    const text = textOf(value).trim();
    if (!text || this.data.busy) return;
    this._draft = text;
    this._lastInputValue = text;
    this.safeSetData({ askComposerOpen: false, askComposerMessage: -1, askComposerQuestion: -1, keyboardHeight: 0, canSend: true });
    const epoch = this._epoch;
    setTimeout(() => { if (this.isCurrent(epoch) && !this.data.busy) this.send(); }, 20);
  },
  sendAskAnswers() {
    if (this.data.busy || !this.data.askReady) return;
    const active = this.activeAskMessage();
    if (!active) return;
    const lines = active.item.asks.map((ask) => `${ask.q} ${textOf(ask.answer).trim()}`).filter(Boolean);
    if (lines.length === active.item.asks.length) this.sendAskText(lines.join('\n'));
  },
  copyMessage(event) {
    const item = this.data.messages[Number(event.currentTarget.dataset.index)];
    if (!item) return;
    const data = [item.text].concat(item.points || []).filter(Boolean).join('\n\n');
    wx.setClipboardData({ data });
  },

  // 关键：textarea 完全不绑定 value。输入法每次 onInput 只写普通 JS 字段，绝不 setData 回灌文字。
  // 这避免 Taro controlled textarea 在华为 + 百度输入法上反复 setData 导致重复上屏、光标跳尾。
  onComposerInput(event) {
    if (this.data.busy) return;
    const value = textOf(event.detail && event.detail.value);
    const previous = this._lastInputValue;
    this._lastInputValue = value;
    this._draft = value;
    if (value.length - previous.length >= PASTE_DELTA_MIN && !this._pasteBurst) this._pasteBurst = { baseline: previous };
    if (this._pasteBurst) {
      if (this._pasteSettleTimer) clearTimeout(this._pasteSettleTimer);
      this._pasteSettleTimer = setTimeout(() => this.settlePaste(), PASTE_SETTLE_MS);
    }
    this.safeSetData(this.draftStatePatch(), () => this.measureComposer());
  },
  settlePaste() {
    this._pasteSettleTimer = null;
    const burst = this._pasteBurst;
    this._pasteBurst = null;
    if (!burst || !this._alive) return;
    const baseline = textOf(burst.baseline);
    const final = textOf(this._lastInputValue);
    if (!(final.length > INPUT_MAX && final.length - baseline.length >= PASTE_DELTA_MIN)) return;
    const { pasted, kept } = diffPasted(baseline, final);
    if (!pasted) return;
    const duplicateId = this.findDuplicatePaste(pasted);
    if (duplicateId) {
      this.keepTypedAfterPaste(kept);
      this.safeSetData({ pasteDupId: duplicateId });
      if (this._pasteDupTimer) clearTimeout(this._pasteDupTimer);
      this._pasteDupTimer = setTimeout(() => {
        this._pasteDupTimer = null;
        if (this._alive) this.safeSetData({ pasteDupId: '' });
      }, PASTE_DUP_FLASH_MS);
      wx.showToast({ title: '这段长文已在附卷里', icon: 'none' });
      return;
    }
    if (this._refs.length + this.data.pastePendings.length >= REF_LIMIT) {
      wx.showToast({ title: `附卷已满${REF_LIMIT}份，容后再呈`, icon: 'none' });
      return;
    }
    this.absorbPasteToFile(pasted);
    this.keepTypedAfterPaste(kept, true);
  },
  // 粘贴超限时只把「粘进来的那一段」抽走归为附卷，用户自己打的字原样留在输入框里——
  // 逐字打不到 2000 字，被判定成长文的必然是粘贴的那段，没有理由连他的提问一起收走。
  // 实现上只能借交替挂载：给新挂载的那个 textarea 一次性初值 composerSeed。
  // seed 写完就冻住，直到下一次重建（发送 / 再次粘贴）才会被覆盖。
  keepTypedAfterPaste(kept, pending) {
    const retained = textOf(kept).trim();
    this._draft = retained;
    this._lastInputValue = retained;
    this._pasteBurst = null;
    this.safeSetData(this.draftStatePatch({
      composerOdd: !this.data.composerOdd,
      composerSeed: retained,
      canSend: pending ? false : Boolean(retained || this._refs.length),
    }), () => this.measureComposer());
  },
  findDuplicatePaste(value) {
    let found = '';
    this._pasteTexts.forEach((text, id) => {
      if (found || !isSamePaste(value, text)) return;
      const pending = this.data.pastePendings.some((item) => item.key === id);
      const attached = this._refs.some((item) => item && item.isPaste && item.id === id);
      if (pending || attached) found = id;
    });
    return found;
  },
  markPasteHinted() {
    try {
      if (wx.getStorageSync('junshi.native.pasteHinted')) return false;
      wx.setStorageSync('junshi.native.pasteHinted', true);
      return true;
    } catch (_) { return false; }
  },
  async absorbPasteToFile(raw, retryKey) {
    const text = textOf(raw).trim();
    if (!text || !this._alive) return;
    const key = retryKey || `paste-${Date.now()}-${++this._pasteSeq}`;
    const pending = { key, chars: text.length, excerpt: pasteExcerpt(text), status: 'uploading' };
    const current = this.data.pastePendings.slice();
    const existing = current.findIndex((item) => item.key === key);
    if (existing >= 0) current[existing] = pending; else current.push(pending);
    this._pasteTexts.set(key, text);
    this.safeSetData({ pastePendings: current, pasteHint: this.data.pasteHint || this.markPasteHinted(), canSend: false }, () => this.measureComposer());
    try {
      const created = await api.createKnowledge({
        kind: 'document', title: `粘贴长文·${text.length}字`, text, sourceType: 'paste', projectId: this._projectId || undefined,
      });
      if (!this._alive) return;
      const id = textOf(created && created.id);
      if (!id) throw new Error('归卷结果缺少资料编号');
      if (this._refs.length >= REF_LIMIT) throw new Error(`附卷已满${REF_LIMIT}份`);
      this._pasteTexts.delete(key);
      this._pasteTexts.set(id, text);
      if (!this._refs.some((item) => item.kind === 'knowledge' && item.id === id)) {
        this._refs.push({
          kind: 'knowledge', id, label: `粘贴长文·${text.length}字`, isPaste: true,
          chars: text.length, excerpt: pasteExcerpt(text),
        });
      }
      const next = this.data.pastePendings.filter((item) => item.key !== key);
      const combined = this.draftText();
      this.safeSetData(this.refViewPatch({
        pastePendings: next,
        canSend: Boolean(combined || this._refs.length) && !this.data.busy && next.length === 0,
      }), () => this.measureComposer());
    } catch (error) {
      if (!this._alive) return;
      const next = this.data.pastePendings.map((item) => item.key === key ? Object.assign({}, item, { status: 'failed' }) : item);
      this.safeSetData({ pastePendings: next, canSend: false }, () => this.measureComposer());
      wx.showToast({ title: error.message || '长文归卷未成，可重试', icon: 'none' });
    }
  },
  retryPaste(event) {
    const key = textOf(event.currentTarget.dataset.key);
    const value = this._pasteTexts.get(key);
    if (value) this.absorbPasteToFile(value, key);
  },
  removePastePending(event) {
    const key = textOf(event.currentTarget.dataset.key);
    this._pasteTexts.delete(key);
    const next = this.data.pastePendings.filter((item) => item.key !== key);
    const combined = this.draftText();
    this.safeSetData({ pastePendings: next, canSend: Boolean(combined || this._refs.length) && !this.data.busy && next.length === 0 }, () => this.measureComposer());
  },
  openPastePreview(event) {
    const id = textOf(event.currentTarget.dataset.id || event.currentTarget.dataset.key);
    const text = this._pasteTexts.get(id);
    if (!text) return;
    const pending = Boolean(event.currentTarget.dataset.key);
    const row = pending ? this.data.pastePendings.find((item) => item.key === id) : null;
    this.safeSetData({ pastePreview: { id, pending, status: row && row.status, chars: text.length, text } });
    store.setOverlay(true, 'paste-preview');
  },
  closePastePreview() {
    this.safeSetData({ pastePreview: null });
    store.setOverlay(false, 'paste-preview');
  },
  dismissPasteHint() { this.safeSetData({ pasteHint: false }, () => this.measureComposer()); },
  copyPastePreview() {
    const value = this.data.pastePreview && this.data.pastePreview.text;
    if (value) wx.setClipboardData({ data: value });
  },
  removePasteRef(event) {
    const id = textOf(event.currentTarget.dataset.id || (this.data.pastePreview && this.data.pastePreview.id));
    if (!id) return;
    this._pasteTexts.delete(id);
    this._refs = this._refs.filter((item) => !(item.kind === 'knowledge' && item.id === id));
    this.closePastePreview();
    this.safeSetData(this.refViewPatch(), () => this.measureComposer());
  },
  removePastePreview() {
    const preview = this.data.pastePreview;
    if (!preview || !preview.id) return;
    if (preview.pending) {
      if (preview.status !== 'failed') return;
      this._pasteTexts.delete(preview.id);
      const next = this.data.pastePendings.filter((item) => item.key !== preview.id);
      const combined = this.draftText();
      this.closePastePreview();
      this.safeSetData({ pastePendings: next, canSend: Boolean(combined || this._refs.length) && !this.data.busy && next.length === 0 }, () => this.measureComposer());
      return;
    }
    this.removePasteRef({ currentTarget: { dataset: { id: preview.id } } });
  },
  onComposerResize() { this.measureComposer(); },
  onKeyboardHeight(event) {
    const height = Math.max(0, Number(event.detail && event.detail.height) || 0);
    this.safeSetData({ keyboardHeight: height }, () => { if (height > 0) this.toBottom(); });
  },
  onComposerBlur() { if (this.data.keyboardHeight) this.safeSetData({ keyboardHeight: 0 }); },
  measureComposer() {
    const epoch = this._epoch;
    const measure = () => {
      if (!this.isCurrent(epoch) || !wx.createSelectorQuery) return;
      wx.createSelectorQuery().in(this).select('.composer-dock').boundingClientRect((rect) => {
        if (!this.isCurrent(epoch) || !rect || !Number.isFinite(Number(rect.height))) return;
        const height = Math.max(96, Math.ceil(Number(rect.height)));
        if (Math.abs(height - Number(this.data.composerHeight || 0)) > 1) this.safeSetData({ composerHeight: height });
      }).exec();
    };
    if (wx.nextTick) wx.nextTick(measure); else setTimeout(measure, 0);
  },
  onConfirm(event) {
    if (this.data.busy) return;
    const eventValue = textOf(event.detail && event.detail.value);
    this._draft = eventValue;
    this._lastInputValue = eventValue;
    this.send();
  },
  pickAttachment() {
    if (!store.isAuthed()) { this.safeSetData({ showLogin: true, loginReason: 'upload' }); return; }
    if (this.data.busy || this.data.uploading || this._refs.length + this.data.pastePendings.length >= REF_LIMIT) return;
    this.emitChatEvent('attach_open', {});
    wx.showActionSheet({ itemList: ['拍照或选择图片', '从微信聊天选择文件', '引用已有案卷 / 方案 / 资料', '粘贴长文为附卷'], success: (res) => { if (res.tapIndex === 0) this.pickImage(); else if (res.tapIndex === 1) this.pickFile(); else if (res.tapIndex === 2) this.openPicker(); else this.pasteKnowledge(); } });
  },
  pickImage() {
    wx.chooseMedia({ count: Math.min(4, REF_LIMIT - this._refs.length - this.data.pastePendings.length), mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'], success: async (result) => {
      for (const file of result.tempFiles || []) {
        if (Number(file.size || 0) > 10 * 1024 * 1024) { wx.showToast({ title: '单张图片不能超过 10MB', icon: 'none' }); continue; }
        this.safeSetData({ uploading: true, canSend: false }, () => this.measureComposer());
        try { const uploaded = await api.uploadChatImage(file.tempFilePath, this._projectId || undefined, '对话图片'); if (!this._alive) return; this._refs.push({ kind: 'image', id: uploaded.id, label: '对话图片', previewUrl: file.tempFilePath }); this.safeSetData(this.refViewPatch(), () => this.measureComposer()); }
        catch (error) { wx.showToast({ title: error.message || '图片上传失败', icon: 'none' }); }
        finally { this.safeSetData(this.refViewPatch({ uploading: false }), () => this.measureComposer()); }
      }
    } });
  },
  pickFile() {
    wx.chooseMessageFile({ count: Math.min(REF_LIMIT - this._refs.length - this.data.pastePendings.length, 4), type: 'file', extension: ['pdf','doc','docx','xls','xlsx','csv','md','markdown','txt'], success: async (result) => {
      for (const file of result.tempFiles || []) {
        if (Number(file.size || 0) > 20 * 1024 * 1024) { wx.showToast({ title: '单个文件不能超过 20MB', icon: 'none' }); continue; }
        this.safeSetData({ uploading: true, canSend: false }, () => this.measureComposer());
        try { const uploaded = await api.uploadKnowledge(file.path, { projectId: this._projectId || undefined, originalName: file.name }); if (!this._alive) return; this._refs.push({ kind: 'knowledge', id: uploaded.id, label: file.name || '对话资料' }); this.safeSetData(this.refViewPatch(), () => this.measureComposer()); }
        catch (error) { wx.showToast({ title: error.message || '文件上传失败', icon: 'none' }); }
        finally { this.safeSetData(this.refViewPatch({ uploading: false }), () => this.measureComposer()); }
      }
    } });
  },
  removeRef(event) {
    const kind = textOf(event.currentTarget.dataset.kind);
    const id = textOf(event.currentTarget.dataset.id);
    this._refs = this._refs.filter((item) => !(item.kind === kind && item.id === id));
    this.safeSetData(this.refViewPatch(), () => this.measureComposer());
  },
  async hydrateImageRefs(messages, epoch) {
    const pageEpoch = epoch || this._epoch;
    const jobs = [];
    (messages || []).forEach((message, messageIndex) => (message.refs || []).forEach((ref, refIndex) => {
      if (ref.kind !== 'image' || ref.previewUrl) return;
      jobs.push(api.chatImageUrl(ref.id).then((result) => {
        if (!this.isCurrent(pageEpoch) || !result || !result.url) return;
        this.safeSetData({ [`messages[${messageIndex}].refs[${refIndex}].previewUrl`]: result.url });
      }).catch(() => {}));
    }));
    await Promise.all(jobs);
  },
  async openPicker() {
    const epoch = this._epoch;
    if (!store.isAuthed()) { this.safeSetData({ showLogin: true, loginReason: 'save' }); return; }
    this.safeSetData({ showPicker: true, pickerLoading: true, pickGroups: [] });
    try {
      const [projects, reports, knowledge, memories] = await Promise.all([
        api.projects().catch(() => []), api.reports(this._projectId || undefined).catch(() => []),
        api.knowledge(this._projectId || undefined).catch(() => []), api.memories(this._agentKey).catch(() => []),
      ]);
      const groups = [
        { title: '案卷', kind: 'project', rows: asList(projects).map((item) => ({ id: item.id, label: item.name || item.title || '未命名案卷', sub: item.summary || '' })) },
        { title: '方案', kind: 'report', rows: asList(reports).map((item) => ({ id: item.id, label: item.title || '未命名方案', version: item.currentVersion || item.version, sub: item.type || '' })) },
        { title: '资料', kind: 'knowledge', rows: asList(knowledge).map((item) => ({ id: item.id, label: item.fileName || item.title || '未命名资料', sub: item.summary || item.category || '' })) },
        { title: '军师印象', kind: 'memory', rows: asList(memories).map((item) => ({ id: item.id, label: item.text || item.title || '一条军师印象', sub: item.agentName || '' })) },
      ].filter((group) => group.rows.length).map((group) => Object.assign({}, group, { rows: group.rows.map((row) => Object.assign({}, row, { selected: this._refs.some((ref) => ref.kind === group.kind && ref.id === row.id) })) }));
      if (!this.isCurrent(epoch)) return;
      this.safeSetData({ pickGroups: groups, pickerLoading: false });
    } catch (error) { if (!this.isCurrent(epoch)) return; this.safeSetData({ pickerLoading: false }); store.handleApiError(error, { fallbackTitle: error.message || '引用列表读取失败' }); }
  },
  closePicker() { this.safeSetData({ showPicker: false, pickGroups: [] }); },
  togglePickerRef(event) {
    const groupIndex = Number(event.currentTarget.dataset.group);
    const rowIndex = Number(event.currentTarget.dataset.index);
    const group = this.data.pickGroups[groupIndex]; const row = group && group.rows[rowIndex];
    if (!row) return;
    const existing = this._refs.findIndex((ref) => ref.kind === group.kind && ref.id === row.id);
    if (existing >= 0) this._refs.splice(existing, 1);
    else if (this._refs.length + this.data.pastePendings.length < REF_LIMIT) this._refs.push({ kind: group.kind, id: row.id, label: row.label, ...(row.version ? { version: row.version } : {}) });
    else { wx.showToast({ title: `单次最多引用 ${REF_LIMIT} 份`, icon: 'none' }); return; }
    const pickGroups = this.data.pickGroups.map((item, gi) => Object.assign({}, item, { rows: item.rows.map((candidate, ri) => Object.assign({}, candidate, { selected: gi === groupIndex && ri === rowIndex ? existing < 0 : candidate.selected })) }));
    this.safeSetData(this.refViewPatch({ pickGroups }), () => this.measureComposer());
  },
  pasteKnowledge() {
    if (!store.isAuthed()) { this.safeSetData({ showLogin: true, loginReason: 'upload' }); return; }
    wx.showModal({ title: '粘贴长文为附卷', editable: true, placeholderText: '粘贴会议纪要、方案草稿或一段背景资料', confirmText: '归卷', success: (result) => {
      const text = String(result.content || '').trim(); if (!result.confirm || !text) return;
      if (this._refs.length + this.data.pastePendings.length >= REF_LIMIT) { wx.showToast({ title: `单次最多引用 ${REF_LIMIT} 份`, icon: 'none' }); return; }
      this.absorbPasteToFile(text);
    } });
  },
  async send() {
    if (this.data.busy) return;
    if (this._pasteBurst || this._pasteSettleTimer) { wx.showToast({ title: '正在识别粘贴的长文', icon: 'none' }); return; }
    if (this.hasPendingPaste()) {
      const failed = this.data.pastePendings.some((item) => item.status === 'failed');
      wx.showToast({ title: failed ? '请先处理归卷失败的长文' : '长文归卷中，稍候再发', icon: 'none' });
      return;
    }
    const retrying = Boolean(this._retryNoEcho);
    const displayRefs = retrying ? (this._retryRefs || []).slice() : this._refs.slice();
    const typedText = this.draftText();
    if (!typedText && !displayRefs.length) return;
    const text = typedText || attachmentOnlyPrompt(displayRefs);
    if (text.length > INPUT_MAX) { wx.showToast({ title: '言过两千，可精简或粘贴成附卷', icon: 'none' }); return; }
    if (!store.isAuthed()) { this.safeSetData({ showLogin: true, loginReason: 'chat' }); return; }
    // 登录门放行之后才算「真的发出去了」——放在门前会把每次弹登录都记成一次发送。
    this.emitChatEvent('send', { entry: this._sendEntry || 'keyboard' });
    this._sendEntry = '';
    const epoch = this._epoch;
    const sendSeq = ++this._sendSeq;
    const active = () => this.isCurrent(epoch) && sendSeq === this._sendSeq;
    const sendRefs = displayRefs.map(cleanRef);
    const userMessage = { id: uid('user'), role: 'user', text, points: [], refs: presentRefs(displayRefs) };
    const messages = decorateActiveAsks(retrying ? this.data.messages : this.data.messages.concat(userMessage), true);
    this._retryNoEcho = false; this._retryRefs = null;
    this._draft = '';
    this._lastInputValue = '';
    this._refs = [];
    this._pasteTexts.clear();
    if (this.data.pastePreview) store.setOverlay(false, 'paste-preview');
    this._pasteBurst = null;
    if (this._pasteSettleTimer) clearTimeout(this._pasteSettleTimer);
    this._pasteSettleTimer = null;
    this._runKnowledgeUsed = [];
    this._runRefNotices = [];
    this._streamDoneStatus = '';
    this._streamIndex = null;
    this._streamText = '';
    this._streamShown = '';
    if (this._plainStreamTimer) clearTimeout(this._plainStreamTimer);
    this._plainStreamTimer = null;
    this._plainStreamText = '';
    this.stopStreamAutoScroll();
    this._pollSeq += 1;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._pollTimer = null;
    // 仅发送成功起步时交替挂载两个 textarea 达到原生清空；编辑过程中从不重建。
    // 这里必须把 composerSeed 一并清掉：粘贴留下的初值若不清，新挂载的框会把已发出去的话再显示一遍。
    this.safeSetData(Object.assign({}, this.askPatch(messages, true), {
      refs: [], regularRefs: [], pasteRefs: [], pastePendings: [], pasteHint: false,
      pastePreview: null, chipsSpent: true,
      busy: true, canStop: false, showThinking: true, canSend: false, inputCount: 0, showCount: false,
      composerOdd: !this.data.composerOdd, composerSeed: '', errorText: '',
    }), () => this.measureComposer());
    this.toBottom();
    try {
      const body = {
        text, agentKey: this._agentKey, sessionId: this._sessionId || undefined,
        projectId: this._projectId || undefined, clientRequestId: uid('native'), refs: sendRefs,
      };
      const streamed = await generateStream(body, {
        onControl: (control) => { if (active()) this._streamControl = control; else if (control && control.abort) control.abort(); },
        onGeneration: (data) => { if (!active()) return; this._generationId = data.generationId || data.id || this._generationId; if (data.sessionId) this._sessionId = data.sessionId; this.safeSetData({ canStop: Boolean(this._generationId) }); },
        onSession: (id) => { if (active() && id) this._sessionId = id; },
        onMeta: (data) => {
          if (!active()) return;
          this._runRefNotices = mergedStrings(this._runRefNotices, data.refNotices);
          this._runKnowledgeUsed = mergedStrings(this._runKnowledgeUsed, data.knowledgeUsed);
          if (data.kind === 'chat') this.ensureStreamItem(false); else if (data.kind === 'report') this.ensureStreamItem(true);
        },
        onToken: (chunk, replace) => { if (active()) this.updateStreamText(chunk, replace); },
        onChat: (reply) => { if (active()) this.updateStreamReply(reply); },
        onReport: (deliverable) => { if (active()) this.updateStreamReport(deliverable); },
        onDone: (data) => { if (active()) this._streamDoneStatus = textOf(data && data.status); },
      });
      if (!active()) return;
      this._streamControl = null;
      if (streamed.sessionId) this._sessionId = streamed.sessionId;
      if (streamed.generationId) this._generationId = streamed.generationId;
      if (streamed.error && streamed.generationId) { this.startPolling(streamed.generationId, epoch); return; }
      if (streamed.error && streamed.error.code === 'CANCELLED') { this.finishBusy({ errorText: '' }, epoch); return; }
      if (streamed.error) throw streamed.error;
      if (this._streamDoneStatus === 'failed' || this._streamDoneStatus === 'cancelled') {
        this.markStreamInterrupted();
        this._streamIndex = null;
        this._generationId = '';
        this.finishBusy({ errorText: this._streamDoneStatus === 'cancelled' ? '本次回复已停止' : '军师暂时没有接上，请重试', canRetryLast: true }, epoch);
        return;
      }
      if (streamed.available && streamed.rendered && streamed.finished) { this.finishStream(streamed, epoch); return; }
      if (streamed.available && streamed.generationId) { this.startPolling(streamed.generationId, epoch); return; }
      this.safeSetData({ canStop: false });
      const result = await api.generate(body);
      if (!active()) return;
      this._sessionId = result.sessionId || this._sessionId;
      if (result.status && !TERMINAL.has(result.status) && result.generationId) {
        this.startPolling(result.generationId, epoch);
        return;
      }
      this.finishResult(result, epoch);
    } catch (error) {
      if (!active()) return;
      // 会话上真有一条在途生成（多为另一端发起）：接管它而不是把用户晾在错误里——
      // 那条回复本来就是他要的，服务端也不会因为这次 409 丢东西。自己点过停止的情况
      // 服务端已让位（见 generationJobs.createGenerationJob 的 superseded 分支），走不到这里。
      const inProgressId = error && error.code === 'GENERATION_IN_PROGRESS'
        && (error.data && error.data.generationId);
      if (inProgressId) {
        this.markStreamInterrupted();
        this.startPolling(inProgressId, epoch);
        return;
      }
      store.handleApiError(error, { silent: true });
      this.markStreamInterrupted();
      this.finishBusy({ errorText: error.message || '军师暂时没有接上，请重试', canRetryLast: true }, epoch);
    }
  },
  ensureStreamItem(report) {
    const knowledgeUsed = mergedStrings(this._runKnowledgeUsed);
    const refNotices = mergedStrings(this._runRefNotices);
    if (this._streamIndex != null && this.data.messages[this._streamIndex]) {
      const current = this.data.messages[this._streamIndex];
      const patch = {};
      const knowledgeUsedText = knowledgeUsed.join('、');
      const refNoticesText = refNotices.join('；');
      if (this.data.showThinking) patch.showThinking = false;
      if (current.knowledgeUsedText !== knowledgeUsedText) {
        patch[`messages[${this._streamIndex}].knowledgeUsed`] = knowledgeUsed;
        patch[`messages[${this._streamIndex}].knowledgeUsedText`] = knowledgeUsedText;
      }
      if (current.refNoticesText !== refNoticesText) {
        patch[`messages[${this._streamIndex}].refNotices`] = refNotices;
        patch[`messages[${this._streamIndex}].refNoticesText`] = refNoticesText;
      }
      if (report && !current.report) {
        if (current.streamRenderId) stopImmediatelyCb(current.streamRenderId);
        patch[`messages[${this._streamIndex}].report`] = true;
        patch[`messages[${this._streamIndex}].reportReady`] = false;
        patch[`messages[${this._streamIndex}].typing`] = false;
        patch[`messages[${this._streamIndex}].streamRenderId`] = '';
        patch[`messages[${this._streamIndex}].streamStarted`] = false;
        this._streamText = '';
        this._streamShown = '';
        this.stopStreamAutoScroll();
      }
      if (Object.keys(patch).length) this.safeSetData(patch);
      return this._streamIndex;
    }
    // 没接上打字机（宿主页未注入 / require.async 跨包异步失败）就不发 streamRenderId：
    // 模板会退回 markdown-text，由 updateStreamText 节流回写正文，宁可少一层打字机动画也不留白屏。
    const streamRenderId = report || !hasStreamRenderer() ? '' : uid('towxml');
    const item = {
      id: uid(report ? 'report' : 'assistant'), role: 'assistant', text: '', points: [], asks: [], activeAsk: false, report: Boolean(report), reportReady: false, streaming: true,
      typing: !report, streamStarted: false, streamRenderId,
      knowledgeUsed, knowledgeUsedText: knowledgeUsed.join('、'), refNotices, refNoticesText: refNotices.join('；'),
    };
    this._streamIndex = this.data.messages.length;
    this.safeSetData({ messages: this.data.messages.concat(item), showThinking: false });
    this.toBottom();
    return this._streamIndex;
  },
  updateStreamText(chunk, replace) {
    const index = this.ensureStreamItem(false); const current = this.data.messages[index] || {};
    const raw = replace ? String(chunk || '') : `${this._streamText || ''}${chunk || ''}`;
    this._streamText = raw;
    // 扣尾：token 流是模型原文，尾部 ask 协议块要到完整结果处才被服务端剥离；打字机只增不减，
    // 所以只把「已确定不是协议块」的部分喂下去，疑似段暂扣、被后文证伪后自然放行。
    const text = streamVisibleText(raw);
    this._streamShown = text;
    if (current.streamRenderId) setMdText(current.streamRenderId, text);
    else this.flushPlainStream(index, text);
    if (!current.streamStarted && text) {
      this.safeSetData({ [`messages[${index}].streamStarted`]: true });
      this.startStreamAutoScroll();
    }
  },
  /** 取消在途的纯文本回写：收尾/中断时必须先取消，否则迟到的一帧会盖掉剥过 asks 的最终正文。 */
  cancelPlainStream() {
    if (this._plainStreamTimer) clearTimeout(this._plainStreamTimer);
    this._plainStreamTimer = null;
    this._plainStreamIndex = null;
  },
  /** 无打字机时的正文回写：节流 120ms 整段写入，只在降级路径生效（见 PLAIN_STREAM_MS）。 */
  flushPlainStream(index, text) {
    this._plainStreamIndex = index;
    this._plainStreamText = text;
    if (this._plainStreamTimer) return;
    this._plainStreamTimer = setTimeout(() => {
      this._plainStreamTimer = null;
      if (!this._alive || this._plainStreamIndex == null) return;
      this.safeSetData({ [`messages[${this._plainStreamIndex}].text`]: this._plainStreamText || '' });
    }, PLAIN_STREAM_MS);
  },
  updateStreamReply(reply) {
    const index = this.ensureStreamItem(false); const value = normalizeReply(reply);
    const current = this.data.messages[index] || {};
    this._streamText = value.text;
    // 服务端清洗后的正文可能比已打出的短（扣尾没兜住时）：打字机收不回去，回喂只会白费一帧，
    // 该不该整条换渲染器交给 finishStream 判。
    if (current.streamRenderId && value.text && extendsShown(value.text, this._streamShown)) {
      this._streamShown = value.text;
      setMdText(current.streamRenderId, value.text);
    }
    const patch = {
      [`messages[${index}].text`]: value.text,
      [`messages[${index}].points`]: value.points,
      [`messages[${index}].asks`]: value.asks,
      [`messages[${index}].truncated`]: value.truncated,
    };
    if (!current.streamStarted && value.text) patch[`messages[${index}].streamStarted`] = true;
    this.safeSetData(patch);
    if (value.text) this.startStreamAutoScroll();
  },
  updateStreamReport(deliverable) {
    const index = this.ensureStreamItem(true); this.safeSetData({ [`messages[${index}].text`]: reportText(deliverable), [`messages[${index}].report`]: true, [`messages[${index}].reportReady`]: false, [`messages[${index}].deliverable`]: deliverable }); this.toBottom();
  },
  finishBusy(extra, epoch) {
    const pageEpoch = epoch || this._epoch;
    if (!this.isCurrent(pageEpoch)) return;
    this._streamControl = null;
    this.safeSetData(Object.assign({ busy: false, canStop: false, showThinking: false, canSend: Boolean(this.hasDraft() || this._refs.length), canRetryLast: false }, extra || {}), () => {
      this.measureComposer();
      this.flushPendingPrompt(pageEpoch);
    });
  },
  finishStream(result, epoch) {
    const pageEpoch = epoch || this._epoch;
    if (!this.isCurrent(pageEpoch)) return;
    this.cancelPlainStream();
    const index = this._streamIndex;
    let finished = null;
    if (index != null && this.data.messages[index]) {
      const current = this.data.messages[index];
      const messageId = textOf(result && result.messageId) || textOf(current.messageId);
      const knowledgeUsed = mergedStrings(this._runKnowledgeUsed, result && result.knowledgeUsed);
      const refNotices = mergedStrings(this._runRefNotices, result && result.refNotices);
      finished = Object.assign({}, current, {
        id: current.id, messageId, streaming: false, typing: Boolean(!current.report && current.streamRenderId && current.streamStarted), interrupted: false,
        reportReady: isReportReady(messageId, current.deliverable),
        knowledgeUsed, knowledgeUsedText: knowledgeUsed.join('、'), refNotices, refNoticesText: refNotices.join('；'),
        ...(result && result.deliverable ? { deliverable: result.deliverable, text: reportText(result.deliverable), report: true } : {}),
      });
      if (result && result.reply && !finished.report) {
        const reply = normalizeReply(result.reply);
        finished.text = reply.text;
        finished.points = reply.points;
        finished.asks = reply.asks;
        finished.truncated = reply.truncated;
      }
      if (finished.report) {
        finished.reportReady = isReportReady(messageId, finished.deliverable);
        if (finished.streamRenderId) stopImmediatelyCb(finished.streamRenderId);
        finished.typing = false;
        finished.streamStarted = false;
        finished.streamRenderId = '';
        this.stopStreamAutoScroll();
      } else if (finished.streamRenderId) {
        // 收尾一律以服务端清洗后的正文（= 落库版本）为准重渲染。towxml 打字机只增不减：
        // 已打出的字不是最终正文的前缀时（扣尾没兜住的协议块残字、或流中途换了说法），
        // 喂短文本收不回去，必须停掉打字机、清掉 streamRenderId，整条换回 markdown-text 渲染最终正文。
        // 打字机压根没开口（think-dots 阶段就 done）同样要清，否则模板会永远停在三个点上。
        if (!finished.streamStarted || !extendsShown(finished.text, this._streamShown)) {
          stopImmediatelyCb(finished.streamRenderId);
          finished.streamRenderId = '';
          finished.streamStarted = false;
          finished.typing = false;
          this.stopStreamAutoScroll();
        } else {
          if (finished.text) setMdText(finished.streamRenderId, finished.text);
          setStreamFinish(finished.streamRenderId);
        }
      } else if (!finished.text && this._streamShown) {
        // 纯文本兜底路径：最后一段节流可能还没落地，收尾时按已下发正文补齐，别丢掉已经吐出来的字。
        finished.text = this._streamShown;
      }
      const next = this.data.messages.slice();
      next[index] = finished;
      this.safeSetData(this.askPatch(next, false));
    } else if (result && (result.reply || result.deliverable)) {
      this.finishResult(result, pageEpoch);
      return;
    }
    this._streamIndex = null;
    this._streamText = '';
    this._streamShown = '';
    this._generationId = '';
    this._pollSeq += 1;
    this.finishBusy({}, pageEpoch);
    if (finished && finished.reportReady && finished.deliverable) this.saveReportItem(finished, true).catch(() => {});
    this.toBottom();
  },
  markStreamInterrupted() {
    this.cancelPlainStream();
    const index = this._streamIndex;
    if (index == null || !this.data.messages[index]) return;
    const current = this.data.messages[index];
    if (current.streamRenderId) stopImmediatelyCb(current.streamRenderId);
    // 一个字都没出就被停掉（thinking 阶段按停止）：这条气泡没有任何内容可留，
    // 留下就是一个永远空着的军师气泡——它还会跟下一轮的 thinking 点叠成两个「军师 ···」。
    // 只在它是最后一条时移除，避免动到后面消息的下标。
    if (!current.text && !this._streamShown && !current.report && index === this.data.messages.length - 1) {
      this.safeSetData({ messages: this.data.messages.slice(0, index), showThinking: false });
      this._streamText = '';
      this._streamShown = '';
      this._streamIndex = null;
      this.stopStreamAutoScroll();
      return;
    }
    const patch = {
      [`messages[${index}].streaming`]: false,
      [`messages[${index}].typing`]: false,
      // 中断时也只留已下发的正文：_streamText 是含协议块的模型原文，不能当正文落进气泡。
      [`messages[${index}].text`]: current.text || this._streamShown || '',
    };
    if (current.report) {
      patch[`messages[${index}].interrupted`] = true;
      patch[`messages[${index}].reportReady`] = false;
      patch[`messages[${index}].messageId`] = '';
    }
    this.safeSetData(patch);
    this._streamText = '';
    this._streamShown = '';
    if (!this.data.messages.some((item, itemIndex) => itemIndex !== index && item && item.typing)) this.stopStreamAutoScroll();
  },
  startStreamAutoScroll() {
    if (this._streamAutoScrollTimer) return;
    this.toBottom();
    this._streamAutoScrollTimer = setInterval(() => {
      if (!this._alive) { this.stopStreamAutoScroll(); return; }
      this.toBottom();
    }, 180);
  },
  stopStreamAutoScroll() {
    if (!this._streamAutoScrollTimer) return;
    clearInterval(this._streamAutoScrollTimer);
    this._streamAutoScrollTimer = null;
  },
  onStreamTypingFinish(event) {
    const streamRenderId = textOf(event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.streamId);
    const index = this.data.messages.findIndex((item) => item && item.streamRenderId === streamRenderId);
    if (index < 0) return;
    const next = this.data.messages.slice();
    next[index] = Object.assign({}, next[index], { typing: false });
    if (!next.some((item) => item && item.typing)) this.stopStreamAutoScroll();
    this.safeSetData(this.askPatch(next, this.data.busy), () => this.toBottom());
  },
  stopGeneration() {
    if (!this.data.canStop) return;
    const epoch = this._epoch;
    const generationId = this._generationId || (this._streamControl && this._streamControl.generationId) || '';
    this._sendSeq += 1;
    this._pollSeq += 1;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._pollTimer = null;
    if (this._streamControl && this._streamControl.abort) this._streamControl.abort();
    if (generationId) api.cancelGeneration(generationId).catch(() => {});
    this.markStreamInterrupted();
    this._streamIndex = null;
    this._streamControl = null;
    this._generationId = '';
    this.finishBusy({ errorText: '' }, epoch);
  },
  startSessionPolling(epoch) {
    const pageEpoch = epoch || this._epoch;
    const sessionId = this._sessionId;
    if (!this.isCurrent(pageEpoch) || !sessionId) return;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._pollTimer = null;
    this._generationId = '';
    const pollSeq = ++this._pollSeq;
    this.safeSetData({ busy: true, canStop: false, showThinking: true, canSend: false });
    this._pollTimer = setTimeout(() => {
      if (this.isCurrent(pageEpoch) && pollSeq === this._pollSeq && sessionId === this._sessionId) this.pollSession(sessionId, pageEpoch, pollSeq);
    }, 1200);
  },
  async pollSession(sessionId, epoch, pollSeq) {
    try {
      const detail = await api.session(sessionId);
      if (!this.isCurrent(epoch) || pollSeq !== this._pollSeq || sessionId !== this._sessionId) return;
      this._pollTimer = null;
      const active = detail.activeGeneration && !TERMINAL.has(detail.activeGeneration.status) ? detail.activeGeneration : null;
      const agent = detail.agent || {};
      this._agentKey = detail.agentKey || this._agentKey;
      if (active) {
        const messages = normalizeDetailMessages(detail);
        this.safeSetData(Object.assign({}, this.askPatch(messages, true), {
          title: agent.name || this.data.title, alias: ALIASES[this._agentKey] || '', messages,
          busy: true, canStop: true, showThinking: true, canSend: false, canRetryLast: false, errorText: '',
        }), () => { this.toBottom(); this.measureComposer(); });
        this.hydrateImageRefs(messages, epoch);
        this.startPolling(active.id, epoch);
        return;
      }
      if (detail.generating) {
        this._pollTimer = setTimeout(() => {
          if (this.isCurrent(epoch) && pollSeq === this._pollSeq && sessionId === this._sessionId) this.pollSession(sessionId, epoch, pollSeq);
        }, 1500);
        return;
      }
      const messages = normalizeDetailMessages(detail);
      const canRetryLast = hasUnansweredTurn(messages, false);
      this._streamIndex = null;
      this._generationId = '';
      this._pollSeq += 1;
      this.safeSetData(Object.assign({}, this.askPatch(messages, false), {
        title: agent.name || this.data.title, alias: ALIASES[this._agentKey] || '', messages,
        busy: false, canStop: false, showThinking: false, canSend: this.hasDraft(),
        canRetryLast, errorText: canRetryLast ? '军师这次没有完成回答。你的问题已经保留，可以直接重新回答。' : '',
      }), () => {
        this.hydrateImageRefs(messages, epoch);
        this.toBottom();
        this.measureComposer();
        this.flushPendingPrompt(epoch);
      });
    } catch (error) {
      if (!this.isCurrent(epoch) || pollSeq !== this._pollSeq || sessionId !== this._sessionId) return;
      this._pollTimer = null;
      const kind = store.handleApiError(error, { silent: true });
      if (kind === 'unauthorized') {
        this._pollSeq += 1;
        this._generationId = '';
        this.finishBusy({ showLogin: true, errorText: '' }, epoch);
        return;
      }
      this._pollTimer = setTimeout(() => {
        if (this.isCurrent(epoch) && pollSeq === this._pollSeq && sessionId === this._sessionId) this.pollSession(sessionId, epoch, pollSeq);
      }, 1800);
    }
  },
  startPolling(id, epoch) {
    const pageEpoch = epoch || this._epoch;
    if (!this.isCurrent(pageEpoch) || !id) return;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._pollTimer = null;
    this._generationId = id;
    this.safeSetData({ busy: true, canStop: true });
    const pollSeq = ++this._pollSeq;
    this.pollGeneration(id, pageEpoch, pollSeq);
  },
  applyGenerationSnapshot(result) {
    if (!result) return;
    if (result.kind === 'report' || result.deliverable) {
      const index = this.ensureStreamItem(true);
      const deliverable = result.deliverable;
      const text = deliverable ? reportText(deliverable) : textOf(result.partialText);
      const patch = { [`messages[${index}].text`]: text, [`messages[${index}].report`]: true, [`messages[${index}].reportReady`]: false };
      if (deliverable) patch[`messages[${index}].deliverable`] = deliverable;
      this.safeSetData(patch);
    } else if (result.reply) {
      this.updateStreamReply(result.reply);
    } else if (result.partialText) {
      this.updateStreamText(result.partialText, true);
    }
  },
  async pollGeneration(id, epoch, pollSeq) {
    try {
      const result = await api.generation(id);
      if (!this.isCurrent(epoch) || pollSeq !== this._pollSeq || id !== this._generationId) return;
      this._pollTimer = null;
      this.applyGenerationSnapshot(result);
      if (!TERMINAL.has(result.status)) {
        this._pollTimer = setTimeout(() => {
          if (this.isCurrent(epoch) && pollSeq === this._pollSeq && id === this._generationId) this.pollGeneration(id, epoch, pollSeq);
        }, result.phase === 'provider' ? 1200 : 1800);
        return;
      }
      if (result.status === 'failed' || result.status === 'cancelled') {
        this.markStreamInterrupted();
        this._streamIndex = null;
        this._generationId = '';
        this._pollSeq += 1;
        this.finishBusy({ errorText: result.status === 'cancelled' ? '本次回复已停止' : '军师暂时没有接上，请重试', canRetryLast: true }, epoch);
        return;
      }
      this.finishResult(result, epoch);
    } catch (error) {
      if (!this.isCurrent(epoch) || pollSeq !== this._pollSeq || id !== this._generationId) return;
      this.markStreamInterrupted();
      this._streamIndex = null;
      this._generationId = '';
      this._pollSeq += 1;
      this.finishBusy({ errorText: error.message || '回复读取失败', canRetryLast: true }, epoch);
    }
  },
  finishResult(result, epoch) {
    const pageEpoch = epoch || this._epoch;
    if (!this.isCurrent(pageEpoch)) return;
    const messageId = textOf(result && (result.messageId || result.resultMessageId));
    const knowledgeUsed = mergedStrings(this._runKnowledgeUsed, result && result.knowledgeUsed);
    const refNotices = mergedStrings(this._runRefNotices, result && result.refNotices);
    let item;
    if (result.kind === 'report' || result.deliverable) item = {
      id: messageId || uid('report'), messageId, role: 'assistant', text: reportText(result.deliverable) || textOf(result.partialText), points: [],
      report: true, reportReady: isReportReady(messageId, result.deliverable), deliverable: result.deliverable, saved: false,
      knowledgeUsed, knowledgeUsedText: knowledgeUsed.join('、'), refNotices, refNoticesText: refNotices.join('；'),
    };
    else {
      const reply = normalizeReply(result.reply || { text: result.partialText, truncated: result.status === 'truncated' });
      item = {
        id: messageId || uid('assistant'), messageId, role: 'assistant', text: reply.text, points: reply.points, asks: reply.asks, truncated: reply.truncated,
        knowledgeUsed, knowledgeUsedText: knowledgeUsed.join('、'), refNotices, refNoticesText: refNotices.join('；'),
      };
    }
    if (this._streamIndex != null && this.data.messages[this._streamIndex]) {
      // 兜底路径同样以服务端清洗后的正文整条替换；替换掉的打字机要先停，别让它继续打已经作废的原文。
      const previous = this.data.messages[this._streamIndex];
      if (previous && previous.streamRenderId) stopImmediatelyCb(previous.streamRenderId);
      const next = this.data.messages.slice(); next[this._streamIndex] = item; this._streamIndex = null; this.safeSetData(this.askPatch(next, false));
    } else this.safeSetData(this.askPatch(this.data.messages.concat(item), false));
    this._streamText = '';
    this._streamShown = '';
    this._generationId = '';
    this._pollSeq += 1;
    this.finishBusy({}, pageEpoch);
    if (item.reportReady && item.deliverable) this.saveReportItem(item, true).catch(() => {});
    this.toBottom();
  },
  reportMessage(index) { const item = this.data.messages[Number(index)]; return item && item.report ? item : null; },
  reportBody(item, auto) {
    return { title: item.deliverable.title || this.data.title, type: item.deliverable.type || item.deliverable.title || '方案', agentKey: this._agentKey, sessionId: this._sessionId || undefined, content: item.deliverable, projectId: this._projectId || undefined, ...(auto ? { auto: true } : {}) };
  },
  async saveReportItem(item, auto) {
    if (!item || !item.reportReady || !isReportReady(item.messageId, item.deliverable) || item.saved) return;
    await api.saveToLibrary(this.reportBody(item, auto));
    if (!this._alive) return;
    const index = this.data.messages.findIndex((message) => message.id === item.id);
    if (index >= 0) this.safeSetData({ [`messages[${index}].saved`]: true });
    if (!auto) wx.showToast({ title: '已存入方案库', icon: 'none' });
  },
  async saveReport(event) {
    const item = this.reportMessage(event.currentTarget.dataset.index); if (!item || !item.reportReady || this.data.reportBusy) return;
    this.safeSetData({ reportBusy: item.id });
    try { await this.saveReportItem(item, false); }
    catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '保存失败' }); }
    finally { this.safeSetData({ reportBusy: '' }); }
  },
  async acceptReport(event) {
    const item = this.reportMessage(event.currentTarget.dataset.index); if (!item || !item.reportReady || !isReportReady(item.messageId, item.deliverable) || this.data.accepting) return;
    this.safeSetData({ accepting: true }); wx.showLoading({ title: '军令拟定中…', mask: true });
    try {
      const result = await api.acceptDeliverable(item.deliverable, this.data.title);
      await this.saveReportItem(item, true).catch(() => {});
      wx.hideLoading();
      wx.showToast({ title: result && result.newOrders ? `已生成 ${result.newOrders} 条军令` : '已生成案卷与军令', icon: 'none' });
      setTimeout(() => wx.switchTab({ url: '/pages/studio/index' }), 650);
    } catch (error) { wx.hideLoading(); store.handleApiError(error, { fallbackTitle: error.message || '案卷生成未成' }); }
    finally { this.safeSetData({ accepting: false }); }
  },
  async renderReportItem(item) {
    if (!this._sessionId || !item || !item.reportReady || !isReportReady(item.messageId, item.deliverable)) throw new Error('请先等方案完整生成');
    return api.renderReport(this._sessionId, item.messageId);
  },
  async viewReport(event) {
    const item = this.reportMessage(event.currentTarget.dataset.index); if (!item || !item.reportReady || this.data.reportBusy) return;
    this.safeSetData({ reportBusy: item.id }); wx.showLoading({ title: '生成网页版…' });
    try { const result = await this.renderReportItem(item); wx.hideLoading(); if (!result.htmlUrl) { wx.showToast({ title: '本地预览模式无网页版', icon: 'none' }); return; } navTo(`/packages/work/webview/index?url=${encodeURIComponent(result.htmlUrl)}`); }
    catch (error) { wx.hideLoading(); store.handleApiError(error, { fallbackTitle: error.message || '网页版生成失败' }); }
    finally { this.safeSetData({ reportBusy: '' }); }
  },
  async downloadReport(event) {
    const item = this.reportMessage(event.currentTarget.dataset.index); if (!item || !item.reportReady || this.data.reportBusy) return;
    this.safeSetData({ reportBusy: item.id }); wx.showLoading({ title: '生成 PDF…' });
    try {
      const result = await this.renderReportItem(item); const htmlUrl = result.htmlUrl || ''; const match = htmlUrl.match(/\/api\/r\/[A-Za-z0-9_-]+/); if (!match) throw new Error('本地预览模式无 PDF');
      const pdfUrl = htmlUrl.replace(match[0], `${match[0]}/pdf`); const download = await new Promise((resolve, reject) => wx.downloadFile({ url: pdfUrl, success: resolve, fail: reject }));
      if (download.statusCode !== 200) throw new Error('PDF 下载失败'); wx.hideLoading(); await new Promise((resolve, reject) => wx.openDocument({ filePath: download.tempFilePath, fileType: 'pdf', showMenu: true, success: resolve, fail: reject }));
    } catch (error) { wx.hideLoading(); store.handleApiError(error, { fallbackTitle: error.message || 'PDF 生成失败' }); }
    finally { this.safeSetData({ reportBusy: '' }); }
  },
  openPoster(event) {
    const item = this.reportMessage(event.currentTarget.dataset.index);
    if (!item || !item.reportReady || !isReportReady(item.messageId, item.deliverable)) return;
    if (this._agentKey !== 'poster' || !this.data.posterEnabled || !item.messageId) return;
    const query = [`messageId=${encodeURIComponent(item.messageId)}`];
    if (this._sessionId) query.push(`sessionId=${encodeURIComponent(this._sessionId)}`);
    if (!navTo(`/packages/work/poster/index?${query.join('&')}`)) wx.showToast({ title: '页面正在打开，请稍候', icon: 'none' });
  },
  openPosterJob(event) {
    const item = this.reportMessage(event.currentTarget.dataset.index);
    if (!item || !item.reportReady || !isReportReady(item.messageId, item.deliverable)) return;
    const jobId = textOf(item.deliverable && item.deliverable.creativeJobId).trim();
    if (!jobId) return;
    if (!navTo(`/packages/work/posterJob/index?jobId=${encodeURIComponent(jobId)}`)) wx.showToast({ title: '页面正在打开，请稍候', icon: 'none' });
  },
  reportMenu(event) {
    const index = Number(event.currentTarget.dataset.index);
    const item = this.reportMessage(index); if (!item || !item.reportReady) return;
    wx.showActionSheet({
      itemList: ['查看 / 保存 PDF', '复制全文'],
      success: (result) => {
        if (result.tapIndex === 0) this.downloadReport({ currentTarget: { dataset: { index } } });
        else wx.setClipboardData({ data: item.text || reportText(item.deliverable) });
      },
    });
  },
  async summarizeChat() {
    if (!this._sessionId) { wx.showToast({ title: '先聊几句再整理', icon: 'none' }); return; }
    wx.showLoading({ title: '正在整理…' });
    try { const result=await api.summarize(this._sessionId);wx.hideLoading();if(result.reportId)navTo(`/packages/work/report/index?id=${encodeURIComponent(result.reportId)}`);else wx.showToast({title:'整理已完成',icon:'none'}); }
    catch(error){wx.hideLoading();store.handleApiError(error,{fallbackTitle:error.message||'整理失败'});}
  },
  retry() { const failed = this.data.messages.filter((item) => item.role === 'user').slice(-1)[0]; if (!failed) return; this._draft = failed.text; this._lastInputValue = failed.text; this._retryNoEcho = true; this._retryRefs = failed.refs || []; const epoch = this._epoch; this.safeSetData({ errorText: '', canRetryLast: false, canSend: true }); setTimeout(() => { if (this.isCurrent(epoch)) this.send(); }, 20); },
  stop() {},
  toBottom() { const epoch = this._epoch; this.safeSetData({ bottomAnchor: '' }); setTimeout(() => { if (this.isCurrent(epoch)) this.safeSetData({ bottomAnchor: 'chat-bottom' }); }, 20); },
};

module.exports = {
  chatCore: Behavior({ data, methods }),
  useStreamRenderer,
  hasStreamRenderer,
  decodeOption,
  textOf,
};
