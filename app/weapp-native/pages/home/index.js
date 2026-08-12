// 战局页 = 原沙盘(判断) + 原点兵(执行) 合并（2026-08 IA 重排）。
// 判断区在上、今日军令在下；命盘/时运两个 mode 已迁出（入口在主公），
// 但 fortuneOn/chart 保留——三势合参 sheet 的天势一栏仍参命盘。
const { api } = require('../../services/api');
const store = require('../../services/store');
const { navTo } = require('../../services/nav');
const { baseData, syncTabBar } = require('../../services/page');

const PHASE_WORD = { 进攻: '攻', 防守: '守', 平稳: '稳中蓄力' };

function chartView(chart) {
  if (!chart) return null;
  const months = chart.monthlyOutlook && Array.isArray(chart.monthlyOutlook.months) ? chart.monthlyOutlook.months : [];
  const month = new Date().getMonth() + 1;
  const current = months.find((item) => Number(item.month) === month) || null;
  const pattern = chart.pattern || {};
  const turning = months.filter((item) => item.turning).map((item) => item.month);
  const phase = current ? (PHASE_WORD[current.phase] || current.phase || '稳中蓄力') : '稳中蓄力';
  return {
    monthLine: `${pattern.name || '格局待判'} · 本月宜${phase}${current && current.turning ? ' · 拐点月' : ''}`,
    turning: turning.length ? `${turning.join('/')}月` : '无',
  };
}

function businessGateCode(error) { return String((error && (error.code || (error.data && error.data.code))) || ''); }

function forceSynthesis(forces) {
  const strong = (forces || []).find((item) => item.levelLabel === '强');
  const weak = (forces || []).find((item) => item.levelLabel === '弱');
  const head = [strong ? `${strong.name}可借` : '', weak ? `${weak.name}宜守` : ''].filter(Boolean).join('，');
  return {
    title: `合参结论：${head || '因势而动'}`,
    body: `${(forces || []).map((item) => `${item.name}${item.tactic}`).join('；')}。先把优势用足，别在弱项上硬扩。`,
  };
}

function dossierView(result) {
  const dossier = result && result.casefile ? result.casefile : null;
  const risks = dossier && Array.isArray(dossier.risks)
    ? dossier.risks.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const backfill = dossier && dossier.backfill && typeof dossier.backfill === 'object' ? dossier.backfill : {};
  const days = Object.keys(backfill).sort().slice(-7);
  const sum = (key) => days.reduce((total, day) => total + (parseInt((backfill[day] && backfill[day][key]) || '0', 10) || 0), 0);
  return {
    dossier,
    risks,
    kpi: days.length ? {
      days: days.length,
      rows: [
        { label: '线索', value: sum('leads') },
        { label: '咨询', value: sum('consults') },
        { label: '成交', value: sum('deals') },
      ],
    } : null,
  };
}

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
  if (/^[A-Za-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+\s*[·•-]\s*[㐀-鿿]/u.test(text)) {
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
function pickPendingDecision(result) {
  const items = result && Array.isArray(result.items) ? result.items : [];
  return items.find((item) => item && (item.status === 'pending' || item.verified === false)) || null;
}
function activePrescriptions(result) {
  const items = result && Array.isArray(result.items) ? result.items : [];
  return items.filter((item) => item && item.id && item.status !== 'dismissed' && item.status !== 'activated');
}

Page({
  data: baseData({
    authed: false, onboarded: false, onboardingKnown: false, showLogin: false, loading: false, heroExpanded: false, committing: false,
    fortuneOn: false, chart: null, cited: [],
    forcesOpen: false, forceDetails: [], forceSynthesis: null, risks: [], kpi: null,
    summary: '先说说你眼下最难拿主意的事，我来判断主要矛盾。',
    nextTitle: '先做一次军师首判', nextDesc: '三问形成第一份判断', nextRoute: '/packages/work/quickscan/index',
    metrics: [{ value: '—', label: '案卷完整度', tone: '' }, { value: '0', label: '待补资料', tone: 'warn' }, { value: '—', label: '风险锁', tone: '' }],
    forces: [], questions: [], saying: '谋定而后动，先把主要矛盾看清。', sayingDate: '', dossierTitle: '', refreshing: false,
    scrollAnchor: '',
    // —— 执行区（原点兵） ——
    streak: 0, reminders: [], pendingDecisions: 0, hasDossier: false, dossierSource: '', dateText: todayLabel(),
    orders: [], pendingOrders: [], visibleOrders: [], archivedOrders: [], weekGroups: [], deckOrders: [], backfill: null, savingBackfill: false,
    orderDone: 0, orderPercent: 0, orderProgressText: '还没出', mainOrderTitle: '今天还没有军令', mainOrderDesc: '让军师根据案卷生成今天最重要的 1-3 件事。', mainOrderButton: '帮我出今日军令',
    showDoneArchive: false, fillingOrderId: '', fillingOrderText: '', savingOrderResult: false,
    goalRows: goalRows(null), goalEdit: null, goalDraft: '', savingGoal: false,
    battleForces: [], pendingDecision: null, verifying: false,
    bizItems: [], bizSaved: false, bizEditing: false, savingBiz: false,
    segments: ['今日军令', '周计划', '复盘'], segment: 0,
    prescriptions: [],
  }),
  onLoad() { this._backfill = {}; this._orderText = ''; this._orderResultText = ''; this._goalDraft = ''; this._bizDraft = {}; this._forceVerdicts = {}; },
  onShow() {
    const state = store.snapshot();
    this.setData({
      themeClass: state.themeClass,
      colorKey: state.colorKey,
      isMock: state.mock,
      authed: state.authed,
      onboarded: state.onboarded,
      onboardingKnown: state.onboardingKnown,
    });
    syncTabBar(this, 1);
    this.loadPrescriptions();
    this.load();
  },
  async loadPrescriptions() {
    if (!store.isAuthed()) { this.setData({ prescriptions: [] }); return; }
    try { this.setData({ prescriptions: activePrescriptions(await api.prescriptions()) }); } catch (_) { /* 处方条缺席不拦页面 */ }
  },
  async load() {
    this.setData({ loading: true });
    api.todaySaying().then((value) => this.setData({ saying: String(value.text || this.data.saying).replace(/<\/?em>/g, ''), sayingDate: value.date || '' })).catch(() => {});
    if (!store.isAuthed()) { this.setData({ loading: false }); return; }
    const [meResult, journeyResult, workbenchResult, decisionsResult, casefileResult, remindersResult, reviewsResult, bizTemplateResult, bizSeriesResult] = await Promise.allSettled([
      store.loadMe(), api.journey(), api.workbench(), api.decisions(), api.casefile(),
      api.reminders(), api.reviews(), api.bizMetricTemplate(), api.bizMetricSeries(8),
    ]);
    const me = meResult.status === 'fulfilled' ? meResult.value : null;
    const journey = journeyResult.status === 'fulfilled' ? journeyResult.value : null;
    const workbench = workbenchResult.status === 'fulfilled' ? workbenchResult.value : null;
    const decisions = decisionsResult.status === 'fulfilled' ? decisionsResult.value : { stats: { pending: 0 } };
    const casefile = casefileResult.status === 'fulfilled' ? casefileResult.value : null;
    const remindersView = remindersResult.status === 'fulfilled' ? remindersResult.value : { items: [] };
    const reviews = reviewsResult.status === 'fulfilled' ? reviewsResult.value : { streak: 0 };
    const understanding = me && me.understanding;
    const fortuneOn = !(me && me.features && me.features.fortune === false);
    let chart = null;
    if (fortuneOn) {
      try { chart = chartView((await api.myChart()).chart); } catch (_) { chart = null; }
    }
    const summary = understanding && (understanding.mainContradiction || understanding.summary) || this.data.summary;
    const questions = understanding && Array.isArray(understanding.nextQuestions) ? understanding.nextQuestions.slice(0, 4) : [];
    const forceNames = { sky: '天势', market: '市势', people: '人势' };
    const levelNames = { strong: '强', mid: '中', weak: '弱' };
    const rawForces = understanding && Array.isArray(understanding.battleForces) ? understanding.battleForces : [];
    const forces = rawForces.map((item) => ({
      kind: item.kind || 'sky', name: item.label || item.name || forceNames[item.kind] || '一势', levelLabel: levelNames[item.level] || item.level || '待判',
      conclusion: item.conclusion || item.verdict || item.summary || '待判断', tactic: item.tactic || '先验证', tacticTone: item.tacticTone || (item.level === 'weak' ? 'danger' : item.level === 'mid' ? 'warn' : 'ok'),
      strength: Number(item.strength) || (item.level === 'strong' ? 85 : item.level === 'weak' ? 35 : 60), note: item.note || item.summary || item.desc || '',
    }));
    const battleForces = rawForces.map((item) => ({ kind: item.kind, label: forceNames[item.kind] || item.kind, conclusion: item.conclusion || '', tactic: item.tactic || '', verdict: this._forceVerdicts[item.kind] || '' }));
    const decision = pickPendingDecision(decisions);
    const dossierInfo = dossierView(casefile);
    const dossier = dossierInfo.dossier;
    const synthesis = forceSynthesis(forces);
    const evidence = understanding && understanding.evidenceCount || {};
    const cited = [
      { label: '对话问对', count: Number(evidence.sessions) || 0, route: '/pages/sessions/index', tab: true },
      { label: '档案', count: Number(evidence.profile) || 0, route: '/packages/main/brief/index' },
      { label: '案卷', count: Number(evidence.projects) || 0, route: '/packages/work/projects/index' },
      { label: '资料', count: Number(evidence.knowledge) || 0, route: '/packages/work/knowledge/index' },
      { label: '军师记忆', count: Number(evidence.memories) || 0, route: '/packages/main/brief/index' },
    ].filter((item) => item.count > 0);
    // —— 执行区派生 ——
    const bizTemplate = bizTemplateResult.status === 'fulfilled' && Array.isArray(bizTemplateResult.value.items) ? bizTemplateResult.value.items : [];
    const bizSeries = bizSeriesResult.status === 'fulfilled' && Array.isArray(bizSeriesResult.value.items) ? bizSeriesResult.value.items : [];
    const weekEntry = bizSeries.find((item) => item.weekStart === thisMonday());
    const savedMetrics = weekEntry && weekEntry.metrics && Object.keys(weekEntry.metrics).length ? weekEntry.metrics : null;
    const bizItems = bizTemplate.map((item) => ({
      key: item.metricKey, name: item.metricName, unit: item.unit || '',
      value: savedMetrics && savedMetrics[item.metricKey] != null ? String(savedMetrics[item.metricKey]) : '',
    }));
    this._bizDraft = Object.fromEntries(bizItems.map((item) => [item.key, item.value]));
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
      summary, questions, forces, fortuneOn, chart, cited,
      forceDetails: forces.map((item) => ({
        kind: item.kind,
        label: `${item.name} · ${item.levelLabel}`,
        title: `${item.conclusion}，${item.tactic}`,
        body: item.note,
        tactic: `打法：${item.tactic}`,
        tacticTone: item.tacticTone,
      })),
      forceSynthesis: synthesis,
      risks: dossierInfo.risks,
      kpi: dossierInfo.kpi,
      onboarded: store.snapshot().onboarded,
      onboardingKnown: store.snapshot().onboardingKnown,
      nextTitle: journey && journey.nextStep ? journey.nextStep.title : this.data.nextTitle,
      nextDesc: journey && journey.nextStep ? journey.nextStep.desc : this.data.nextDesc,
      nextRoute: journey && journey.nextStep ? journey.nextStep.route : this.data.nextRoute,
      metrics: [
        { value: `${workbench ? Number(workbench.completeness) || 0 : 0}%`, label: '案卷完整度', tone: '' },
        { value: String(workbench && workbench.missing ? workbench.missing.length : questions.length), label: '待补资料', tone: 'warn' },
        { value: dossierInfo.risks.length ? String(dossierInfo.risks.length) : '—', label: '风险锁', tone: dossierInfo.risks.length ? 'danger' : '' },
      ],
      // 只认真实案卷标题（workbench 契约里没有 title，历史兜底是死代码，勿加回）。
      dossierTitle: plainInline(dossier && dossier.title) || '',
      // —— 执行区 ——
      reminders: remindersView.items || [], streak: Number(reviews.streak) || 0,
      pendingDecisions: Number(decisions.stats && decisions.stats.pending) || (decision ? 1 : 0), pendingDecision: decision, battleForces,
      bizItems, bizSaved: Boolean(savedMetrics), bizEditing: false, hasDossier: Boolean(dossier),
      dossierSource: plainInline(dossier && dossier.sourceAgent) || '军师',
      orders, pendingOrders, visibleOrders, archivedOrders, weekGroups: recentOrderGroups(allOrders), deckOrders: pendingOrders.length ? pendingOrders.slice(0, 3) : archivedOrders.slice(0, 3),
      orderDone, orderPercent, orderProgressText: orders.length ? `${orderDone}/${orders.length}` : '还没出', mainOrderTitle, mainOrderDesc, mainOrderButton,
      goalRows: goalRows(dossier && dossier.goals), backfill,
      loading: false,
    });
  },
  requireLogin() { if (store.isAuthed()) return true; this.setData({ showLogin: true }); return false; },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false, authed: true }); this.loadPrescriptions(); this.load(); },
  goOnboarding() {
    try {
      const pages = getCurrentPages();
      if (pages.some((page) => String(page.route || '').includes('packages/main/onboarding'))) return;
    } catch (_) { /* 页栈读取失败时仍允许正常导航 */ }
    navTo('/packages/main/onboarding/index');
  },
  ask() { navTo('/packages/main/chat/index?agentKey=general&continue=1'); },
  openCalendar() { navTo('/packages/work/calendar/index'); },
  openMingpan() { navTo('/packages/work/mingpan/index'); },
  openLedger() { if (this.requireLogin()) navTo('/packages/work/ledger/index'); },
  tapEvidence(event) {
    const item = this.data.cited[Number(event.currentTarget.dataset.index)];
    if (!item) return;
    if (item.tab) wx.switchTab({ url: item.route }); else navTo(item.route);
  },
  toggleHero() { this.setData({ heroExpanded: !this.data.heroExpanded }); },
  tapMetric(event) { const index = Number(event.currentTarget.dataset.index); if (index === 0) navTo('/packages/main/brief/index'); else if (index === 2) this.askRisks(); else this.ask(); },
  // 军令区在本页下半场：scroll-into-view 锚点滚动，替代旧的 switchTab studio。
  scrollToOrders() {
    this.setData({ scrollAnchor: 'orders-zone' });
    setTimeout(() => this.setData({ scrollAnchor: '' }), 600);
  },
  // 「下一步」卡 route 是语义 key（server journey.ts 下发 'chat'/'studio'，速诊是真路由）。
  // 'studio' 在合并后指本页军令区——滚过去，不再跳 tab。
  next() {
    if (!this.requireLogin()) return;
    const route = String(this.data.nextRoute || '');
    if (route.charAt(0) === '/') { navTo(route); return; }
    if (route === 'studio') { this.scrollToOrders(); return; }
    navTo('/packages/main/chat/index?agentKey=general&continue=1');
  },
  askQuestion(event) { if (!this.requireLogin()) return; navTo(`/packages/main/chat/index?agentKey=general&continue=1&prompt=${encodeURIComponent(event.currentTarget.dataset.text || '')}`); },
  async refreshForces() {
    if (!this.requireLogin() || this.data.refreshing) return;
    this.setData({ refreshing: true });
    try { await api.refreshForces(); await this.load(); wx.showToast({ title: '判断已刷新', icon: 'none' }); }
    catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '刷新失败' }); }
    finally { this.setData({ refreshing: false }); }
  },
  openForces() { if (this.data.forces.length) this.setData({ forcesOpen: true }); },
  closeForces() { this.setData({ forcesOpen: false }); },
  stop() {},
  askRisks() {
    if (!this.requireLogin()) return;
    const known = this.data.risks.length ? `当前风险锁：${this.data.risks.join('；')}。` : '';
    const prompt = `${known}请帮我判断现在最不能做什么，并说明解锁条件。`;
    navTo(`/packages/main/chat/index?agentKey=general&continue=1&prompt=${encodeURIComponent(prompt)}`);
  },
  async commitBattle() {
    if (!this.requireLogin() || this.data.committing) return;
    this.setData({ committing: true });
    try { await api.battleCommit(); wx.showToast({ title: '军令和方案已出', icon: 'none' }); await this.load(); this.scrollToOrders(); }
    catch (error) {
      const code = businessGateCode(error);
      if (code === 'PLAN_EXPIRED') {
        wx.showModal({ title: '方案已到期', content: '续费后可继续生成军令与方案。', confirmText: '去续费', success: (result) => { if (result.confirm) navTo('/packages/work/plans/index'); } });
      } else if (code === 'INSUFFICIENT_QUOTA' || code === 'INSUFFICIENT_CREDITS' || code === 'SKU_REQUIRED') {
        wx.showModal({ title: '算力不足', content: '当前额度不足，可补充算力或调整方案后继续。', confirmText: '查看算力', success: (result) => { if (result.confirm) navTo('/packages/work/credits/index'); } });
      } else store.handleApiError(error, { fallbackTitle: error.message || '生成失败' });
    }
    finally { this.setData({ committing: false }); }
  },
  // —— 处方条（军师配了兵器） ——
  openPrescription(event) {
    const id = String(event.currentTarget.dataset.id || '');
    if (!id) return;
    api.prescriptionAction(id, 'clicked').catch(() => {});
    if (!navTo(`/packages/work/market/index?from=prescription&pid=${encodeURIComponent(id)}`)) {
      wx.showToast({ title: '页面正在打开，请稍候', icon: 'none' });
    }
  },
  // —— 执行区（原点兵逻辑整体迁入） ——
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
  inputOrder(event) { this._orderText = event.detail.value; },
  // 没案卷先说清楚，别让用户打完字再吃一个服务端 409（/casefile/orders 与 /casefile/backfill
  // 都要求先有 active casefile）。mock 会当场捏一份空案卷，缺门禁只在真机暴露。
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
