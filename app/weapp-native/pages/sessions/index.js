const { api } = require('../../services/api');
const store = require('../../services/store');
const { navTo } = require('../../services/nav');
const { baseData, syncTabBar } = require('../../services/page');

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

Page({
  data: baseData({
    quickCards: QUICK, rows: [], historyRows: [], searchGroups: [], query: '',
    showHistory: false, showLogin: false, loginReason: 'chat', unlockAgent: null, loading: true, error: false, searching: false,
  }),
  onLoad() { this._sessions = []; this._agents = []; },
  onShow() {
    const snapshot = store.snapshot();
    this.setData({ themeClass: snapshot.themeClass, isMock: snapshot.mock });
    syncTabBar(this, 0);
    this.load();
  },
  onUnload() { if (this._searchTimer) clearTimeout(this._searchTimer); },
  async load() {
    this.setData({ loading: true, error: false });
    const authed = store.isAuthed();
    const loaded = await Promise.all([store.loadAgents(), authed ? store.loadMe() : Promise.resolve(null)]);
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
    const historyRows = this._sessions.filter((item) => !q || `${item.agentName}${item.title}${item.snippet}`.toLowerCase().includes(q)).map((item) => ({
      id: item.id, agentKey: item.agentKey, agentName: item.agentName, alias: ALIASES[item.agentKey] || '',
      avatar: avatarFor(item.agentKey), timeText: relTime(item.updatedAt), preview: `${item.title} · ${item.snippet}`,
      unreadText: item.unreadCount ? (item.unreadCount > 99 ? '99+' : String(item.unreadCount)) : '',
    }));
    this.setData({ rows, historyRows });
  },
  requireLogin(reason) {
    if (store.isAuthed()) return true;
    this.setData({ showLogin: true, loginReason: reason || 'chat' });
    return false;
  },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
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
});
