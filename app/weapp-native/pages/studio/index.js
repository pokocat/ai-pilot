const { api } = require('../../services/api');
const store = require('../../services/store');
const { navTo } = require('../../services/nav');
const { baseData, syncTabBar } = require('../../services/page');

function today() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function thisMonday() {
  const date = new Date();
  const diff = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - diff);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function dateLabel(value) {
  if (value === today()) return '今天';
  const parts = String(value || '').split('-');
  return parts.length === 3 ? `${Number(parts[1])}月${Number(parts[2])}日` : String(value || '');
}
function todayLabel() {
  const parts = today().split('-');
  return `${Number(parts[1])}月${Number(parts[2])}日`;
}
function dayKey(offset) {
  const date = new Date();
  date.setDate(date.getDate() + Number(offset || 0));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function plainInline(value) {
  let text = String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^[A-Za-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+\s*[·•-]\s*[\u3400-\u9fff]/u.test(text)) {
    text = text.replace(/^[A-Za-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+\s*[·•-]\s*/u, '');
  }
  return text;
}
function recentOrderGroups(orders) {
  const groups = new Map();
  const minDate = dayKey(-6);
  const maxDate = today();
  for (const order of Array.isArray(orders) ? orders : []) {
    if (!order || !order.date || order.date < minDate || order.date > maxDate) continue;
    if (!groups.has(order.date)) groups.set(order.date, []);
    groups.get(order.date).push(order);
  }
  return [...groups.entries()]
    .sort((left, right) => left[0] < right[0] ? 1 : -1)
    .map(([date, rows]) => ({ date, label: dateLabel(date), orders: rows }));
}
const GOAL_FIELDS = [['weekly', '本周'], ['quarterly', '季度'], ['annual', '年度'], ['longTerm', '3-5年']];
function goalRows(goals) {
  const value = goals && typeof goals === 'object' ? goals : {};
  return GOAL_FIELDS.map(([field, label]) => ({ field, label, value: String(value[field] || ''), empty: !value[field] }));
}
function pendingDecision(result) {
  const items = result && Array.isArray(result.items) ? result.items : [];
  return items.find((item) => item && (item.status === 'pending' || item.verified === false)) || null;
}

const CREATIVE_ICONS = new Set(['crown', 'image', 'video', 'pen', 'spark', 'doc']);

function creativeRows(agents, authed) {
  return (Array.isArray(agents) ? agents : [])
    .filter((agent) => agent && agent.type === 'creative' && agent.enabled !== false)
    .map((agent) => {
      const locked = Boolean(authed && agent.billing === 'unlock' && !agent.owned);
      return Object.assign({}, agent, {
        icon: CREATIVE_ICONS.has(agent.icon) ? agent.icon : 'spark',
        locked,
        metered: agent.billing === 'metered',
        costText: `x${Number(agent.price || 0)}`,
        badgeText: locked ? '待启用' : (agent.billing === 'unlock' ? '已启用' : ''),
      });
    });
}

function activePrescriptions(result) {
  const items = result && Array.isArray(result.items) ? result.items : [];
  return items.filter((item) => item && item.id && item.status !== 'dismissed' && item.status !== 'activated');
}

Page({
  data: baseData({
    authed: false, showLogin: false, loading: false, completeness: 0, streak: 0,
    sections: [], reminders: [], pendingDecisions: 0, hasDossier: false, dossierTitle: '', dossierSource: '', dateText: todayLabel(), judgement: '', orders: [], pendingOrders: [], visibleOrders: [], archivedOrders: [], weekGroups: [], deckOrders: [], backfill: null, savingBackfill: false,
    orderDone: 0, orderPercent: 0, orderProgressText: '还没出', mainOrderTitle: '今天还没有军令', mainOrderDesc: '让军师根据案卷生成今天最重要的 1-3 件事。', mainOrderButton: '帮我出今日军令',
    showDoneArchive: false, fillingOrderId: '', fillingOrderText: '', savingOrderResult: false,
    goalRows: goalRows(null), goalEdit: null, goalDraft: '', savingGoal: false,
    battleForces: [], forceVerdicts: {}, pendingDecision: null, verifying: false,
    bizItems: [], bizSaved: false, bizEditing: false, savingBiz: false,
    segments: ['今日军令', '周计划', '复盘'], segment: 0,
    creativeAgents: [], prescriptions: [], unlockAgent: null,
  }),
  onLoad() { this._backfill = {}; this._orderText = ''; this._orderResultText = ''; this._goalDraft = ''; this._bizDraft = {}; this._forceVerdicts = {}; },
  onShow() {
    const state = store.snapshot();
    this.setData({ themeClass: state.themeClass, colorKey: state.colorKey, isMock: state.mock, authed: state.authed });
    syncTabBar(this, 2);
    this.loadCatalog();
    this.load();
  },
  async loadCatalog() {
    const authed = store.isAuthed();
    const [agentsResult, prescriptionsResult] = await Promise.allSettled([
      Promise.all([store.loadAgents(), authed ? store.loadMe() : Promise.resolve(null)]).then(([agents]) => agents),
      api.prescriptions(),
    ]);
    const agents = agentsResult.status === 'fulfilled' ? agentsResult.value : store.snapshot().agents;
    const prescriptions = prescriptionsResult.status === 'fulfilled' ? activePrescriptions(prescriptionsResult.value) : [];
    this.setData({ creativeAgents: creativeRows(agents, authed), prescriptions, authed });
  },
  async load() {
    if (!store.isAuthed()) {
      this.setData({
        sections: [], reminders: [], completeness: 0, hasDossier: false, dossierTitle: '', dossierSource: '', judgement: '',
        orders: [], pendingOrders: [], visibleOrders: [], archivedOrders: [], weekGroups: [], deckOrders: [],
        orderDone: 0, orderPercent: 0, orderProgressText: '还没出', goalRows: goalRows(null), backfill: null,
      });
      return;
    }
    this.setData({ loading: true });
    const [workbench, reminders, reviews, decisions, casefile, meResult, bizTemplate, bizSeries] = await Promise.allSettled([
      api.workbench(), api.reminders(), api.reviews(), api.decisions(), api.casefile(), store.loadMe(), api.bizMetricTemplate(), api.bizMetricSeries(8),
    ]);
    const w = workbench.status === 'fulfilled' ? workbench.value : { completeness: 0, sections: [], missing: [] };
    const r = reminders.status === 'fulfilled' ? reminders.value : { items: [] };
    const rv = reviews.status === 'fulfilled' ? reviews.value : { streak: 0 };
    const d = decisions.status === 'fulfilled' ? decisions.value : { stats: { pending: 0 } };
    const me = meResult.status === 'fulfilled' ? meResult.value : null;
    const decision = pendingDecision(d);
    const template = bizTemplate.status === 'fulfilled' && Array.isArray(bizTemplate.value.items) ? bizTemplate.value.items : [];
    const series = bizSeries.status === 'fulfilled' && Array.isArray(bizSeries.value.items) ? bizSeries.value.items : [];
    const weekEntry = series.find((item) => item.weekStart === thisMonday());
    const savedMetrics = weekEntry && weekEntry.metrics && Object.keys(weekEntry.metrics).length ? weekEntry.metrics : null;
    const bizItems = template.map((item) => ({
      key: item.metricKey, name: item.metricName, unit: item.unit || '',
      value: savedMetrics && savedMetrics[item.metricKey] != null ? String(savedMetrics[item.metricKey]) : '',
    }));
    this._bizDraft = Object.fromEntries(bizItems.map((item) => [item.key, item.value]));
    const rawForces = me && me.understanding && Array.isArray(me.understanding.battleForces) ? me.understanding.battleForces : [];
    const forceNames = { sky: '天势', market: '市势', people: '人势' };
    const battleForces = rawForces.map((item) => ({ kind: item.kind, label: forceNames[item.kind] || item.kind, conclusion: item.conclusion || '', tactic: item.tactic || '', verdict: this._forceVerdicts[item.kind] || '' }));
    const dossier = casefile.status === 'fulfilled' ? casefile.value.casefile : null;
    const allOrders = dossier && Array.isArray(dossier.orders) ? dossier.orders : [];
    const orders = allOrders.filter((item) => item.date === today()).map((item, index) => Object.assign({}, item, { no: index + 1 }));
    const pendingOrders = orders.filter((item) => !item.done);
    const fillingOrderId = this.data.fillingOrderId;
    const visibleOrders = orders.filter((item) => !item.done || item.id === fillingOrderId);
    const archivedOrders = orders.filter((item) => item.done && item.id !== fillingOrderId);
    const orderDone = orders.filter((item) => item.done).length;
    const orderPercent = orders.length ? Math.round(orderDone / orders.length * 100) : 0;
    const firstPending = pendingOrders[0] || null;
    const mainOrderTitle = firstPending ? firstPending.text : orders.length ? '今日军令已归档' : '今天还没有军令';
    const mainOrderDesc = firstPending ? '可让 IP 军师直接生成配套内容脚本。' : orders.length ? '完成项已归档，去录入数据、做复盘。' : '让军师根据案卷生成今天最重要的 1-3 件事。';
    const mainOrderButton = firstPending ? '帮我写脚本' : orders.length ? '开始复盘' : '帮我出今日军令';
    const backfill = dossier && dossier.backfill ? dossier.backfill[today()] || null : null;
    this.setData({
      completeness: Number(w.completeness) || 0, sections: w.sections || [], reminders: r.items || [], streak: Number(rv.streak) || 0,
      pendingDecisions: Number(d.stats && d.stats.pending) || (decision ? 1 : 0), pendingDecision: decision, battleForces,
      bizItems, bizSaved: Boolean(savedMetrics), bizEditing: false, hasDossier: Boolean(dossier),
      dossierTitle: plainInline(dossier && dossier.title), dossierSource: plainInline(dossier && dossier.sourceAgent) || '军师', judgement: plainInline(dossier && dossier.judgment),
      orders, pendingOrders, visibleOrders, archivedOrders, weekGroups: recentOrderGroups(allOrders), deckOrders: pendingOrders.length ? pendingOrders.slice(0, 3) : archivedOrders.slice(0, 3),
      orderDone, orderPercent, orderProgressText: orders.length ? `${orderDone}/${orders.length}` : '还没出', mainOrderTitle, mainOrderDesc, mainOrderButton,
      goalRows: goalRows(dossier && dossier.goals), backfill, loading: false,
    });
  },
  requireLogin() { if (store.isAuthed()) return true; this.setData({ showLogin: true }); return false; },
  closeLogin() { this.setData({ showLogin: false }); },
  stop() {},
  loggedIn() { this.setData({ showLogin: false, authed: true }); this.loadCatalog(); this.load(); },
  ask() { navTo('/packages/main/chat/index?agentKey=general&continue=1'); },
  tapCreative(event) {
    const key = String(event.currentTarget.dataset.key || '');
    const agent = this.data.creativeAgents.find((item) => item.key === key);
    if (!agent) return;
    if (agent.locked) { this.setData({ unlockAgent: agent }); return; }
    navTo(`/packages/main/chat/index?agentKey=${encodeURIComponent(agent.key)}&continue=1`);
  },
  closeUnlock() { this.setData({ unlockAgent: null }); },
  agentUnlocked(event) {
    const agent = event.detail && event.detail.agent;
    if (!agent || !agent.key) { this.setData({ unlockAgent: null }); this.loadCatalog(); return; }
    const creativeAgents = this.data.creativeAgents.map((item) => item.key === agent.key
      ? Object.assign({}, item, agent, { locked: false, badgeText: agent.billing === 'unlock' ? '已启用' : '' })
      : item);
    this.setData({ unlockAgent: null, creativeAgents });
    navTo(`/packages/main/chat/index?agentKey=${encodeURIComponent(agent.key)}&continue=1`);
  },
  openGallery() {
    if (!navTo('/packages/work/gallery/index')) wx.showToast({ title: '页面正在打开，请稍候', icon: 'none' });
  },
  openPrescription(event) {
    const id = String(event.currentTarget.dataset.id || '');
    if (!id) return;
    api.prescriptionAction(id, 'clicked').catch(() => {});
    if (!navTo(`/packages/work/market/index?from=prescription&pid=${encodeURIComponent(id)}`)) {
      wx.showToast({ title: '页面正在打开，请稍候', icon: 'none' });
    }
  },
  selectSegment(event) { this.setData({ segment: Number(event.currentTarget.dataset.index) }); },
  openFirstOrder() { const first = this.data.pendingOrders[0]; if (first) navTo(`/packages/work/command/index?id=${encodeURIComponent(first.id)}`); },
  deckAction() { if (this.data.pendingOrders.length) this.makeScript(); else if (this.data.orders.length) this.reviewToday(); else this.makeCommand(); },
  focusAction() { if (this.data.pendingOrders.length) this.openFirstOrder(); else if (this.data.orders.length) this.reviewToday(); else this.makeCommand(); },
  makeCommand() { if (this.requireLogin()) navTo('/packages/main/chat/index?agentKey=general&continue=1&send=' + encodeURIComponent('按我们最近定下的方案，把今天最重要的 1-3 件事拆成今日军令，并给出每件事的完成标准。')); },
  makeGoalPlan() { if (this.requireLogin()) navTo('/packages/main/chat/index?agentKey=strat&continue=1&send=' + encodeURIComponent('帮我把目标拆成阶梯：本周、季度、年度、3-5 年各一句话，并给出关键指标。')); },
  makeScript() {
    if (!this.requireLogin()) return;
    const first = this.data.pendingOrders[0];
    const prompt = first ? `围绕这条军令帮我产出可直接使用的内容脚本：「${first.text}」。` : '按我们最近定下的方案，帮我写今天要发布的内容脚本。';
    navTo(`/packages/main/chat/index?agentKey=ip&continue=1&send=${encodeURIComponent(prompt)}`);
  },
  openReminders() { if (this.requireLogin()) navTo('/packages/work/reminders/index'); },
  openDaily() { if (this.requireLogin()) navTo('/packages/work/daily/index'); },
  openLedger() { if (this.requireLogin()) navTo('/packages/work/ledger/index'); },
  chooseForce(event) {
    const kind = event.currentTarget.dataset.kind;
    const verdict = event.currentTarget.dataset.verdict;
    if (!kind || !verdict) return;
    this._forceVerdicts[kind] = verdict;
    this.setData({ battleForces: this.data.battleForces.map((item) => Object.assign({}, item, { verdict: item.kind === kind ? verdict : item.verdict })) });
  },
  async verifyDecision(event) {
    if (!this.data.pendingDecision || this.data.verifying) return;
    const outcome = event.currentTarget.dataset.outcome;
    this.setData({ verifying: true });
    try {
      await api.verifyDecision(this.data.pendingDecision.id, outcome);
      this.setData({ pendingDecision: null, pendingDecisions: Math.max(0, this.data.pendingDecisions - 1) });
      wx.showToast({ title: outcome === 'correct' ? '已记为判断正确' : '已记为需修正', icon: 'none' });
    } catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '记录失败' }); }
    finally { this.setData({ verifying: false }); }
  },
  startBizEdit() { this.setData({ bizEditing: true }); },
  inputBiz(event) { this._bizDraft[event.currentTarget.dataset.key] = event.detail.value; },
  async saveBiz() {
    if (this.data.savingBiz) return;
    const metrics = {};
    for (const item of this.data.bizItems) {
      const raw = String(this._bizDraft[item.key] == null ? '' : this._bizDraft[item.key]).trim();
      const value = Number(raw);
      if (raw && Number.isFinite(value)) metrics[item.key] = value;
    }
    this.setData({ savingBiz: true });
    try {
      await api.saveBizMetrics(thisMonday(), metrics);
      const saved = Object.keys(metrics).length > 0;
      const bizItems = this.data.bizItems.map((item) => Object.assign({}, item, { value: metrics[item.key] == null ? '' : String(metrics[item.key]) }));
      this.setData({ bizItems, bizSaved: saved, bizEditing: false });
      wx.showToast({ title: saved ? '本周经营数据已记录' : '已清空本周数据', icon: 'none' });
    } catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '保存失败，请重试' }); }
    finally { this.setData({ savingBiz: false }); }
  },
  async addOrder() {
    if (!this.requireLogin()) return;
    wx.showModal({ title: '新增今日军令', editable: true, placeholderText: '今天必须完成的一件事', confirmText: '加入', success: async (result) => { const text = String(result.content || '').trim(); if (!result.confirm || !text) return; try { await api.addOrder(text); await this.load(); } catch (error) { wx.showToast({ title: error.message || '添加失败', icon: 'none' }); } } });
  },
  inputOrder(event) { this._orderText = event.detail.value; },
  // 没案卷先说清楚，别让用户打完字再吃一个服务端 409（/casefile/orders 与 /casefile/backfill
  // 都要求先有 active casefile）。门禁口径与同页 openGoalEdit 对齐；mock 会当场捏一份空案卷，
  // 所以这条路径在本地永远成功，缺门禁只在真机暴露。
  async addInlineOrder() { const text = String(this._orderText || '').trim(); if (!text) { wx.showToast({ title: '先写下今天要完成的事', icon: 'none' }); return; } if (!this.data.hasDossier) { wx.showToast({ title: '先和军师定下一份方案，生成案卷', icon: 'none' }); return; } try { await api.addOrder(text); this._orderText = ''; await this.load(); } catch (error) { wx.showToast({ title: error.message || '添加失败', icon: 'none' }); } },
  async toggleOrder(event) {
    const id = event.currentTarget.dataset.id;
    const current = this.data.orders.find((item) => item.id === id);
    if (!current) return;
    try {
      await api.toggleOrder(id);
      if (!current.done) {
        this._orderResultText = current.resultNote || '';
        this.setData({ fillingOrderId: id, fillingOrderText: this._orderResultText });
      } else {
        this._orderResultText = '';
        this.setData({ fillingOrderId: '', fillingOrderText: '' });
      }
      await this.load();
    } catch (error) { wx.showToast({ title: error.message || '更新失败', icon: 'none' }); }
  },
  inputOrderResult(event) { this._orderResultText = String(event.detail.value || '').slice(0, 200); },
  async saveOrderResult() {
    const id = this.data.fillingOrderId;
    const value = String(this._orderResultText || '').trim();
    if (!id || this.data.savingOrderResult) return;
    if (!value) { wx.showToast({ title: '先填一句做完的量', icon: 'none' }); return; }
    this.setData({ savingOrderResult: true });
    try {
      await api.setOrderResult(id, value);
      this._orderResultText = '';
      this.setData({ fillingOrderId: '', fillingOrderText: '' });
      await this.load();
      wx.showToast({ title: '数据已回填', icon: 'none' });
    } catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '回填未成，稍后再试' }); }
    finally { this.setData({ savingOrderResult: false }); }
  },
  toggleDoneArchive() { this.setData({ showDoneArchive: !this.data.showDoneArchive }); },
  openOrder(event) { const id = event.currentTarget.dataset.id; if (id) navTo(`/packages/work/command/index?id=${encodeURIComponent(id)}`); },
  removeOrder(event) { const id = event.currentTarget.dataset.id; const text = event.currentTarget.dataset.text || '这条军令'; wx.showModal({ title: '删除军令', content: `确认删除「${text}」？`, confirmText: '删除', success: async (result) => { if (!result.confirm) return; await api.removeOrder(id).catch((error) => wx.showToast({ title: error.message || '删除失败', icon: 'none' })); await this.load(); } }); },
  inputBackfill(event) { this._backfill[event.currentTarget.dataset.field] = event.detail.value; },
  openGoalEdit(event) {
    if (!this.data.hasDossier) { wx.showToast({ title: '先和军师定下一份方案，生成案卷', icon: 'none' }); return; }
    const field = String(event.currentTarget.dataset.field || '');
    const row = this.data.goalRows.find((item) => item.field === field);
    if (!row) return;
    this._goalDraft = row.value;
    this.setData({ goalEdit: { field, label: row.label }, goalDraft: row.value });
  },
  closeGoalEdit() { this._goalDraft = ''; this.setData({ goalEdit: null, goalDraft: '' }); },
  inputGoal(event) { this._goalDraft = String(event.detail.value || '').slice(0, 200); },
  async saveGoal() {
    const edit = this.data.goalEdit;
    if (!edit || this.data.savingGoal) return;
    this.setData({ savingGoal: true });
    try {
      await api.saveGoals({ [edit.field]: String(this._goalDraft || '').trim() });
      this._goalDraft = '';
      this.setData({ goalEdit: null, goalDraft: '' });
      await this.load();
      wx.showToast({ title: '目标已保存', icon: 'none' });
    } catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '目标保存失败' }); }
    finally { this.setData({ savingGoal: false }); }
  },
  async saveBackfill() { if (this.data.savingBackfill) return; if (!this.data.hasDossier) { wx.showToast({ title: '先和军师定下一份方案，生成案卷', icon: 'none' }); return; } const current = this.data.backfill || {}; const values = { leads: String(this._backfill.leads != null ? this._backfill.leads : current.leads || ''), consults: String(this._backfill.consults != null ? this._backfill.consults : current.consults || ''), deals: String(this._backfill.deals != null ? this._backfill.deals : current.deals || '') }; this.setData({ savingBackfill: true }); try { await api.saveBackfill(values); this._backfill = {}; await this.load(); wx.showToast({ title: '今日数据已回填', icon: 'none' }); } catch (error) { wx.showToast({ title: error.message || '回填失败', icon: 'none' }); } finally { this.setData({ savingBackfill: false }); } },
  async reviewToday() {
    if (!this.requireLogin()) return;
    const checks = this.data.battleForces.filter((item) => this._forceVerdicts[item.kind]).map((item) => `${item.label}：今天${this._forceVerdicts[item.kind] === 'on' ? '符合主线' : '偏离主线'}（打法：${item.tactic}）`);
    const prompt = ['根据我今天完成的军令和数据回填，带我做一次经营复盘。', checks.length ? `三势自评：\n${checks.join('\n')}` : ''].filter(Boolean).join('\n');
    try { await api.reviewCasefile('day'); this._forceVerdicts = {}; navTo('/packages/main/chat/index?agentKey=general&continue=1&send=' + encodeURIComponent(prompt)); }
    catch (error) { wx.showToast({ title: error.message || '复盘没有开始', icon: 'none' }); }
  },
});
