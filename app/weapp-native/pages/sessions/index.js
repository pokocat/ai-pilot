// 问策 tab：按 /me.features.wenceForm 分形态。
//  · 'chat'            → 终态「总军师对话即 tab」（合一页头 + 对话区 + 提示 pill + 底部合体浮岛 + 双段抽屉）
//  · 'control'/'dock'/字段缺失/取数失败 → 现状军师列表，一个节点不动（灰度回退的前提）
// 游客没有 /me，形态读 GET /wence/hints 的 guestForm；登录后立刻改用 /me 的正式分桶。
const { api } = require('../../services/api');
const store = require('../../services/store');
const { navTo } = require('../../services/nav');
const { getToken } = require('../../services/token');
const { baseData, syncTabBar } = require('../../services/page');
const { TABS, visualTabs } = require('../../services/tabbar');
const { chatCore, useStreamRenderer } = require('../../chat-core/behavior');
const { GUEST_PRELUDE, FALLBACK_HINTS } = require('../../data/wence-defaults');

const ALIASES = { general: '玄衡', strat: '观澜', growth: '青衍', ip: '鸣璋', ops: '照微', org: '云枢', intel: '察远', fund: '泓策', model: '构衡', brand: '声澜' };
const CORE = {
  strat: ['主要矛盾 · 取舍', '战略判断写进战局主线'],
  growth: ['获客 · 转化 · 复购', '转化路径直通执行指标'],
  ip: ['定位 · 内容 · 发布', '内容任务写入每日军令'],
  ops: ['数据 · 复盘 · 节奏', '数据更新，明日打法随调'],
};
const QUICK = [
  { title: '上传经营资料', desc: '企业、老板、产品、财务资料', url: '/packages/work/knowledge/index', reason: 'upload' },
  { title: '账号与数据', desc: '账号矩阵、授权与经营数据', url: '/packages/work/bindings/index', reason: 'execute' },
  { title: '生成方案', desc: '把这次对话炼成一份方案', url: '/packages/work/library/index', reason: 'save' },
  { title: '转成军令', desc: '方案定了，自动拆成今天要做的事', url: '/pages/studio/index', reason: 'execute' },
  { title: '今日执行', desc: '军令、任务、打卡、复盘', url: '/pages/studio/index', reason: 'execute' },
];
const PORTRAITS = { general: 'general', strat: 'strat', growth: 'growth', ip: 'ip', ops: 'ops', org: 'org', intel: 'strat', fund: 'org', model: 'growth', brand: 'ip' };

const FORM_CACHE_PREFIX = 'junshi.wenceForm.';
const FIRST_SEND_PREFIX = 'junshi.wence.firstsend.';
const HINT_ROTATE_MS = 3000;
const HINT_FADE_MS = 320;

/**
 * 主线会话闲置多久算「过一段时间再进来」。超过它且没有未读，冷进时不再续接旧会话，
 * 改开一条新的（旧的自然归档进历史抽屉）——常见 AI app 的口径，也免得用户对着三天前的
 * 半截对话继续说话。**纯客户端判定**，服务端没有过期概念，旧会话原封不动躺在那儿。
 */
const SESSION_IDLE_HOURS = 24;

/**
 * 过期只在**冷进**（bootChat）判，refreshChat（切 tab 回来）绝不判：
 * 用户正聊着聊着跨过 24 小时整点就被切走是最恶心的一种"聪明"。
 * 这条依赖 `_chatBooted` 缓存——同一次小程序生命周期内只 boot 一次，所以判定天然只在
 * 冷启动/杀进程重进时发生，正好对上"过一段时间再进去"的语义。改动 `_chatBooted` 的
 * 复用范围前先回来看这条。
 *
 * 有未读时**照旧续接**：军师主动说了新东西，连续性比新鲜感重要；进入即读、角标照常清。
 */
function isSessionStale(item) {
  if (!item) return false;
  if (Number(item.unreadCount) > 0) return false;
  const idleMs = Date.now() - new Date(item.updatedAt).getTime();
  if (!Number.isFinite(idleMs)) return false; // 时间戳读不出来一律按不过期，宁可续接也不误开新会话
  return idleMs > SESSION_IDLE_HOURS * 3600 * 1000;
}

function relTime(iso) {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(seconds) || seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  const days = Math.floor(seconds / 86400);
  return days === 1 ? '昨天' : `${days} 天前`;
}

function avatarFor(key) {
  const file = PORTRAITS[key] || 'general';
  return `/assets/avatars/generated/${file}-imagegen.jpg`;
}

function buildRows(agents, sessions, authed) {
  const latest = {};
  sessions.forEach((item) => { if (!latest[item.agentKey]) latest[item.agentKey] = item; });
  return agents.filter((a) => a.enabled !== false && a.type !== 'creative').map((agent) => {
    const last = latest[agent.key];
    const core = CORE[agent.key];
    return Object.assign({}, agent, {
      alias: ALIASES[agent.key] || '',
      avatar: avatarFor(agent.key),
      online: agent.key === 'general',
      timeText: last ? relTime(last.updatedAt) : (agent.key === 'general' ? '在线' : ''),
      preview: last ? last.snippet : (agent.greet || (core ? `${core[0]} · ${core[1]}` : agent.role)),
      unreadText: last && last.unreadCount ? (last.unreadCount > 99 ? '99+' : String(last.unreadCount)) : '',
      locked: Boolean(authed && agent.billing === 'unlock' && !agent.owned),
      core: agent.key === 'general' || Boolean(core),
    });
  });
}

/**
 * 折成一行。**必须在数据层折**：微信 `<text>` 组件把内容里的 `\n` 当真换行渲染，
 * WXSS 的 `white-space:nowrap` 管不住它——抽屉历史行的摘要因此在真机上铺了十几行
 * （2026-08-08 真机实拍）。省略号仍由 CSS 的 text-overflow 负责，这里只统一空白。
 */
function oneLine(value) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); }

function badgeText(count) { return count > 0 ? (count > 99 ? '99+' : String(count)) : ''; }
function safeGet(key) { try { return wx.getStorageSync(key) || ''; } catch (_) { return ''; } }
function safeSet(key, value) { try { wx.setStorageSync(key, value); } catch (_) { /* storage 满/禁用都不该影响主流程 */ } }
function localHints() { return FALLBACK_HINTS.map((text, index) => ({ id: `local-${index + 1}`, text })); }

Page({
  behaviors: [chatCore],
  data: baseData({
    // 形态初值取本地缓存（默认 control = 零改动现状）：/me 回来之前先按上次的样子画，
    // 免得 chat 用户每次冷启动都先闪一屏军师列表。
    form: safeGet(`${FORM_CACHE_PREFIX}${getToken() || 'guest'}`) === 'chat' ? 'chat' : 'control',
    quickCards: QUICK, rows: [], historyRows: [], councilRows: [], searchGroups: [], query: '',
    showHistory: false, showLogin: false, loginReason: 'chat', unlockAgent: null, loading: true, error: false, searching: false,
    // 终态专属
    isleTabs: visualTabs('theme-green'), unread: 0, councilUnreadText: '',
    headHeight: 0, drawerOpen: false, drawerSeg: 'council',
    hintText: '', hintId: '', hintFade: false,
  }),

  onLoad() {
    this._sessions = [];
    this._agents = [];
    this._hints = [];
    this._hintIndex = 0;
    this._chatBooted = false;
    this._booting = false;
    this._streamReady = this.setupStreamRenderer();
    this.setData({ headHeight: Number(this.data.navInset || 0) + 105 });
  },

  onShow() {
    const snapshot = store.snapshot();
    // 先补 overlay 再 syncTabBar：顺序反过来会让 custom-tab-bar 先亮一帧再被浮岛顶掉。
    if (this.data.form === 'chat') store.setOverlay(true, 'wence-isle');
    this.setData({ themeClass: snapshot.themeClass, colorKey: snapshot.colorKey, isMock: snapshot.mock, isleTabs: visualTabs(snapshot.themeClass) });
    syncTabBar(this, 0);
    this._enterAt = Date.now();
    this.boot(false);
  },

  onHide() {
    // overlay 记账按 key 成对释放：切到别的 tab 时底栏必须立刻回来。
    store.setOverlay(false, 'wence-isle');
    store.setOverlay(false, 'wence-drawer');
    this.stopHintRotation();
    if (this.data.drawerOpen) this.setData({ drawerOpen: false });
  },

  onUnload() {
    store.setOverlay(false, 'wence-isle');
    store.setOverlay(false, 'wence-drawer');
    this.stopHintRotation();
    if (this._searchTimer) clearTimeout(this._searchTimer);
    if (this._chatBooted) this.chatCoreUnload();
  },

  /**
   * towxml（568K）住在 packages/main 分包，主包页面只能跨包异步取它的流式打字机回调。
   * 时序铁律：**先 useStreamRenderer 再 chatCoreLoad**——反过来第一轮流式的 setMdText 会打进
   * no-op，用户对着一个永远不出字的气泡。拿不到（分包没下下来、旧基础库没有 require.async）
   * 也不许白屏：chat-core 检测到没接上打字机就不发 streamRenderId，退回 markdown-text 纯文本渲染。
   */
  setupStreamRenderer() {
    try {
      if (typeof require.async !== 'function') return Promise.resolve(false);
      return require.async('../../packages/main/vendor/towxml/globalCb.js')
        .then((mod) => useStreamRenderer(mod))
        .catch(() => false);
    } catch (_) { return Promise.resolve(false); }
  },

  /* ────────────── 形态解析与装载 ────────────── */

  formCacheKey() { return `${FORM_CACHE_PREFIX}${getToken() || 'guest'}`; },
  cachedForm() { return safeGet(this.formCacheKey()) === 'chat' ? 'chat' : 'control'; },

  async resolveForm(authed, me) {
    if (authed) {
      const form = me && me.features && me.features.wenceForm;
      // 只认 'chat'：'dock' 与 control 同属列表渲染路径，字段缺失（旧服务端）也按现状走。
      if (form) return form === 'chat' ? 'chat' : 'control';
      return this.cachedForm();
    }
    try {
      const result = await api.wenceHints();
      this._hintsResult = result;
      return result && result.guestForm === 'chat' ? 'chat' : 'control';
    } catch (_) { return this.cachedForm(); }
  },

  async boot(force) {
    if (this._booting) return;
    this._booting = true;
    try {
      const authed = store.isAuthed();
      // /me 这一趟同时供形态判定与 control 的 load() 用，别让一次 onShow 打两遍。
      const me = authed ? await store.loadMe() : null;
      const form = await this.resolveForm(authed, me);
      const changed = form !== this.data.form;
      if (changed) this.setData({ form });
      safeSet(this.formCacheKey(), form === 'chat' ? 'chat' : '');
      if (form !== 'chat') {
        store.setOverlay(false, 'wence-isle');
        this._chatBooted = false;
        await this.load({ meLoaded: true });
      } else {
        store.setOverlay(true, 'wence-isle');
        syncTabBar(this, 0);
        if (force || changed || !this._chatBooted) await this.bootChat();
        else await this.refreshChat();
      }
      this.trackEnter(form);
    } finally { this._booting = false; }
  },

  /** 会话装载：已登录续接 general 最近会话 → 没有就试注入主动消息 → 再没有走 greet 空会话；游客走本地开场序列。 */
  async bootChat() {
    // 重装前把上一轮的定时器/在途流断干净（登录后重装会走到这里），否则旧 epoch 的回调仍会写数据。
    if (this._chatBooted) this.chatCoreUnload();
    this._chatBooted = true;
    await this._streamReady;
    this.loadHints();
    this.measureHead();
    const authed = store.isAuthed();
    this._agents = await store.loadAgents();
    if (!authed) {
      this._sessions = [];
      this.refreshRows();
      this.setData({ loading: false, error: false });
      // 游客：本地合成的主动消息，仅内存渲染、零服务端写入（发送动作才弹登录门）。
      this.chatCoreLoad({ agentKey: 'general', localPrelude: GUEST_PRELUDE });
      return;
    }
    await this.fetchSessions();
    const latest = (this._sessions || []).find((item) => item.agentKey === 'general');
    // 闲置超过 SESSION_IDLE_HOURS 且无未读 → 不续接，落到下面的「无会话」分支重开一条。
    if (latest && !isSessionStale(latest)) { this.chatCoreLoad({ sessionId: latest.id }); this.markGeneralRead(); return; }

    // 无会话（或旧会话已过期）：先试主动消息注入。已有会话的用户会拿到 reason='exists'，
    // 这是**预期结果**不是错误——过期路径本来就是「服务端还有会话、端上不想续接」。
    let result = null;
    try { result = await api.proactiveSession(); } catch (_) { /* 主动消息失败一律静默降级，不得阻塞进场 */ }
    if (result && result.injected && result.sessionId) {
      api.track('proactive_show', { source: 'template', session_id: result.sessionId });
      this.chatCoreLoad({ sessionId: result.sessionId });
      await this.fetchSessions();
      this.markGeneralRead();
      return;
    }
    // injected:false 的三种原因（exists / empty-pool / disabled）都不是错误：走 greet 空会话。
    this.chatCoreLoad({ agentKey: 'general' });
    this.measureHead();
  },

  /** 切走再切回：只同步角标与已读，不重复装载会话、不重复注入主动消息。 */
  async refreshChat() {
    this.startHintRotation();
    this.measureHead();
    if (!store.isAuthed()) return;
    await this.fetchSessions();
    this.markGeneralRead();
  },

  async fetchSessions() {
    if (!store.isAuthed()) { this._sessions = []; this.refreshRows(); this.setData({ loading: false, error: false }); return; }
    this.setData({ loading: true });
    try {
      this._sessions = await api.sessions();
      this.refreshRows();
      this.setData({ loading: false, error: false });
    } catch (error) {
      const kind = store.handleApiError(error, { silent: true });
      this._sessions = [];
      this.refreshRows();
      this.setData({ loading: false, error: kind !== 'unauthorized' });
    }
  },

  /**
   * 进 tab 就装载了 general 会话详情，服务端已写 lastReadAt——本地缓存必须同步掉掉这份未读，
   * 否则底栏与「军师团」角标会一直挂着一个点不进去的红点。专业军师的未读一条不动。
   */
  markGeneralRead() {
    let changed = false;
    this._sessions = (this._sessions || []).map((item) => {
      if (item.agentKey !== 'general' || !Number(item.unreadCount)) return item;
      changed = true;
      return Object.assign({}, item, { unreadCount: 0, hasUnread: false });
    });
    if (changed) this.refreshRows();
  },

  measureHead() {
    if (this.data.form !== 'chat' || !wx.createSelectorQuery) return;
    const run = () => {
      wx.createSelectorQuery().in(this).select('.wence-head').boundingClientRect((rect) => {
        const height = rect && Number(rect.height);
        if (!Number.isFinite(height) || height <= 0) return;
        const next = Math.ceil(height);
        if (Math.abs(next - Number(this.data.headHeight || 0)) > 1) this.setData({ headHeight: next });
      }).exec();
    };
    if (wx.nextTick) wx.nextTick(run); else setTimeout(run, 0);
  },

  /* ────────────── 现状列表（control）：与改版前逐行一致 ────────────── */

  // options.meLoaded：boot() 刚拉过 /me 就别再拉一遍。重试链路（bindtap="load"）没有这个参数，
  // 拿到的是事件对象 → 照旧刷新 /me，与改版前一致。
  async load(options) {
    this.setData({ loading: true, error: false });
    const authed = store.isAuthed();
    const skipMe = Boolean(options && options.meLoaded === true);
    const loaded = await Promise.all([store.loadAgents(), authed && !skipMe ? store.loadMe() : Promise.resolve(null)]);
    this._agents = loaded[0];
    if (!authed) {
      this._sessions = [];
      this.refreshRows();
      this.setData({ loading: false });
      return;
    }
    try {
      this._sessions = await api.sessions();
      store.syncUnread(this._sessions);
      this.refreshRows();
      syncTabBar(this, 0);
      this.setData({ loading: false, error: false });
    } catch (error) {
      const kind = store.handleApiError(error, { silent: true });
      this._sessions = [];
      this.refreshRows();
      this.setData({ loading: false, error: kind !== 'unauthorized', showLogin: kind === 'unauthorized' });
    }
  },

  refreshRows() {
    const q = String(this.data.query || '').trim().toLowerCase();
    const rows = buildRows(this._agents, this._sessions, store.isAuthed()).filter((row) => !q || `${row.name}${row.alias}${row.role}`.toLowerCase().includes(q));
    const historyRows = this._sessions.filter((item) => !q || `${item.agentName}${item.title}${item.snippet}`.toLowerCase().includes(q)).map((item) => {
      const alias = ALIASES[item.agentKey] || '';
      const timeText = relTime(item.updatedAt);
      return {
        id: item.id, agentKey: item.agentKey, agentName: item.agentName, alias,
        avatar: avatarFor(item.agentKey), timeText,
        // control 形态那棵树读的是 preview（军师名当主行、标题挤在摘要里），一个字都不许动。
        preview: `${item.title} · ${item.snippet}`,
        // 终态抽屉：主行=会话标题、辅行=花名·时间、第三行=摘要。花名缺失（未映射的军师）退回本名，
        // 别让辅行出现一个孤零零的「· 3 天前」。
        title: oneLine(item.title) || '新对话',
        metaText: `${alias || item.agentName} · ${timeText}`,
        snippet: oneLine(item.snippet),
        unreadText: badgeText(Number(item.unreadCount) || 0),
      };
    });
    // 未读三层引导链：① 浮岛/底栏问策角标 = 全会话聚合；② 军师团按钮 = 除 general 外之和；③ 抽屉行内各自。
    const councilUnread = (this._sessions || []).filter((item) => item.agentKey !== 'general')
      .reduce((sum, item) => sum + (Number(item.unreadCount) || 0), 0);
    store.syncUnread(this._sessions || []);
    this.setData({
      rows, historyRows,
      councilRows: rows.filter((row) => row.key !== 'general'),
      unread: store.snapshot().unread,
      councilUnreadText: badgeText(councilUnread),
    });
    if (this.data.form === 'chat') syncTabBar(this, 0);
  },

  requireLogin(reason) {
    if (store.isAuthed()) return true;
    this.setData({ showLogin: true, loginReason: reason || 'chat' });
    return false;
  },
  closeLogin() { this.setData({ showLogin: false }); },
  async loggedIn() {
    this.setData({ showLogin: false });
    if (this.data.form !== 'chat') { this.load(); return; }
    // textarea 是非受控的：屏幕上那行字还在，_draft 却会被 chatCoreLoad 清掉。
    // 登录门不得吞掉用户已经写好的话（§6），所以重装后把草稿接回去。
    // _pendingPrompt 是另一回事：游客点 chip / 提示 pill 触发登录门时那句话存在这里，
    // 登录成功就该自动发出去（用户已经表达过「就发这句」的意图）。
    const draft = this._draft || '';
    const pending = this._pendingPrompt || '';
    const entry = this._sendEntry || '';
    await this.boot(true);
    if (this.data.form !== 'chat') return;
    if (draft) {
      this._draft = draft;
      this._lastInputValue = draft;
      this.setData(this.draftStatePatch());
    }
    if (pending) { this._pendingPrompt = pending; this._sendEntry = entry; this.flushPendingPrompt(); }
  },

  inputQuery(event) {
    const query = event.detail.value;
    this.setData({ query });
    this.refreshRows();
    if (this._searchTimer) clearTimeout(this._searchTimer);
    if (!query.trim() || !store.isAuthed()) { this.setData({ searchGroups: [], searching: false }); return; }
    this.setData({ searching: true });
    this._searchTimer = setTimeout(() => this.runSearch(query.trim()), 300);
  },
  clearQuery() { this.setData({ query: '', searchGroups: [], searching: false }); this.refreshRows(); },
  async runSearch(query) {
    try {
      const result = await api.search(query);
      const labels = { agent: '军师', session: '会话', report: '方案', knowledge: '资料' };
      const kinds = ['agent', 'session', 'report', 'knowledge'];
      const searchGroups = kinds.map((kind) => ({ kind, label: labels[kind], rows: (result.hits || []).filter((hit) => hit.kind === kind) })).filter((group) => group.rows.length);
      if (query === String(this.data.query || '').trim()) this.setData({ searchGroups, searching: false });
    } catch (error) { store.handleApiError(error, { silent: true }); this.setData({ searchGroups: [], searching: false }); }
  },
  toggleHistory() {
    if (!this.requireLogin('history')) return;
    this.setData({ showHistory: !this.data.showHistory });
  },
  tapQuick(event) {
    const item = this.data.quickCards[Number(event.currentTarget.dataset.index)];
    if (this.requireLogin(item.reason)) navTo(item.url);
  },
  tapAgent(event) {
    const key = event.currentTarget.dataset.key;
    const row = this.data.rows.find((item) => item.key === key);
    if (store.isAuthed() && row && row.locked) { this.setData({ unlockAgent: row }); return; }
    navTo(`/packages/main/chat/index?agentKey=${key}&continue=1`);
  },
  closeUnlock() { this.setData({ unlockAgent: null }); },
  agentUnlocked(event) {
    const agent = event.detail && event.detail.agent || this.data.unlockAgent;
    this._agents = store.snapshot().agents;
    this.setData({ unlockAgent: null });
    this.refreshRows();
    if (agent && agent.key) navTo(`/packages/main/chat/index?agentKey=${agent.key}&continue=1`);
  },
  tapSession(event) {
    if (!this.requireLogin('history')) return;
    navTo(`/packages/main/chat/index?sessionId=${event.currentTarget.dataset.id}`);
  },
  deleteSession(event) {
    const id = event.currentTarget.dataset.id;
    const item = this._sessions.find((row) => row.id === id);
    wx.showModal({ title: '删除会话', content: `删除「${item ? item.title : '这段会话'}」后不可恢复，确定删除？`, confirmText: '删除', confirmColor: '#9C4A38', success: async (result) => {
      if (!result.confirm) return;
      const before = this._sessions;
      this._sessions = before.filter((row) => row.id !== id); this.refreshRows();
      try { await api.deleteSession(id); } catch (error) { this._sessions = before; this.refreshRows(); store.handleApiError(error, { fallbackTitle: '删除失败' }); }
    } });
  },
  tapHit(event) {
    if (!this.requireLogin('search')) return;
    const group = this.data.searchGroups[Number(event.currentTarget.dataset.group)];
    const hit = group && group.rows[Number(event.currentTarget.dataset.index)];
    if (hit) navTo(hit.route);
  },

  /* ────────────── 终态：抽屉 / 浮岛 tab 行 / 提示 pill ────────────── */

  openCouncil() { this.openDrawer('council'); },
  openHistory() { this.openDrawer('history'); },
  openDrawer(seg) {
    // 游客可看军师团（目录是公开的），但翻历史是个人内容 → 动作级登录门（§6）。
    if (seg === 'history' && !this.requireLogin('history')) return;
    api.track('drawer_open', { entry: seg });
    store.setOverlay(true, 'wence-drawer');
    this.setData({ drawerOpen: true, drawerSeg: seg });
  },
  closeDrawer() {
    store.setOverlay(false, 'wence-drawer');
    this.setData({ drawerOpen: false, query: '', searchGroups: [], searching: false });
    this.refreshRows();
  },
  switchSeg(event) {
    const seg = event.currentTarget.dataset.seg;
    if (seg === this.data.drawerSeg) return;
    if (seg === 'history' && !this.requireLogin('history')) return;
    this.setData({ drawerSeg: seg });
  },

  switchIsleTab(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (!TABS[index] || index === 0) return;
    api.track('tab_switch', { from: TABS[0].path, to: TABS[index].path });
    store.setOverlay(false, 'wence-isle');
    wx.switchTab({ url: TABS[index].path });
  },

  loadHints() {
    const apply = (result) => {
      const hints = (result && Array.isArray(result.hints) ? result.hints : []).filter((item) => item && item.text);
      this._hints = hints.length ? hints : localHints();
      this.startHintRotation();
    };
    if (this._hintsResult) { apply(this._hintsResult); return; }
    api.wenceHints().then((result) => { this._hintsResult = result; apply(result); }).catch(() => apply(null));
  },
  startHintRotation() {
    this.stopHintRotation();
    // 冷会话才轮播：用户开过口（chipsSpent）之后 pill 已经永久收起，再定时 setData 只是白烧帧。
    if (!this._hints.length || this.data.form !== 'chat' || this.data.chipsSpent) return;
    this._hintIndex %= this._hints.length;
    this.applyHint();
    if (this._hints.length < 2) return;
    this._hintTimer = setInterval(() => {
      if (this.data.chipsSpent) { this.stopHintRotation(); return; }
      this.setData({ hintFade: true });
      this._hintSwapTimer = setTimeout(() => {
        this._hintIndex = (this._hintIndex + 1) % this._hints.length;
        this.applyHint();
      }, HINT_FADE_MS);
    }, HINT_ROTATE_MS);
  },
  applyHint() {
    const hint = this._hints[this._hintIndex];
    if (!hint) return;
    this.setData({ hintText: hint.text, hintId: hint.id || '', hintFade: false });
  },
  stopHintRotation() {
    if (this._hintTimer) clearInterval(this._hintTimer);
    if (this._hintSwapTimer) clearTimeout(this._hintSwapTimer);
    this._hintTimer = null;
    this._hintSwapTimer = null;
  },
  /**
   * 点提示问题 = 直接代发，**不是原型里的「点选即填」**：textarea 铁律禁止绑定 value，
   * 程序化回填输入框在原生没有实现路径。代发与 chip 同语义，也少一步「填进去还得自己点发送」。
   */
  tapHint() {
    const text = String(this.data.hintText || '').trim();
    if (!text) return;
    api.track('hint_tap', { hint_id: this.data.hintId });
    this.sendText(text, 'hint');
  },

  /* ────────────── 埋点 ────────────── */

  /** chat-core 的事件出口（behavior 只发事件，映射与上报都在宿主页）。 */
  chatCoreEvent(name, props) {
    if (name === 'send') { this.trackFirstSend(props && props.entry); return; }
    if (name === 'chip_tap') { api.track('chip_tap', props); return; }
    if (name === 'attach_open') { api.track('attach_open', props); return; }
    if (name === 'prelude_show') { api.track('proactive_show', { source: 'local' }); }
  },
  trackEnter(form) {
    const authed = store.isAuthed();
    const userState = !authed ? 'guest' : ((this._sessions || []).length ? 'returning' : 'new');
    api.track('wence_enter', { form, user_state: userState });
  },
  /** 北极星分子：本账号首次经本页发出消息。ttfm 自本次 onShow 起算。 */
  trackFirstSend(entry) {
    const key = `${FIRST_SEND_PREFIX}${getToken() || 'guest'}`;
    if (safeGet(key) === '1') return;
    safeSet(key, '1');
    api.track('first_message_send', {
      ttfm_ms: this._enterAt ? Math.max(0, Date.now() - this._enterAt) : 0,
      entry: entry || 'keyboard',
    });
  },
});
