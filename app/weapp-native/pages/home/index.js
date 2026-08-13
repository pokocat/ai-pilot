// 战局页 = 原沙盘(判断) + 原点兵(执行) 合并（2026-08 IA 重排）。
// 判断区在上、今日军令在下；命盘/时运两个 mode 已迁出（入口在主公），
// 但 fortuneOn/chart 保留——三势合参 sheet 的天势一栏仍参命盘。
const { api } = require('../../services/api');
const store = require('../../services/store');
const { navTo } = require('../../services/nav');
const { baseData, syncTabBar } = require('../../services/page');
// mock 数据档案：只有 mock 包才渲染角标，非 mock 构建下这几行是死代码（留着无害）。
const mockProfile = require('../../services/mockProfile');

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
    // 战局页时运条用的紧凑口径：一行说完「本月怎么走 + 拐点在几月」。
    // 命理只调节奏，不参与经营结论——这条只给节奏，不给判断（AGENTS §7 口径）。
    briefLine: `本月宜${phase}${turning.length ? ` · 拐点月 ${turning.join('/')}月` : ''}`,
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
function dayKey(offset) {
  const date = new Date();
  date.setDate(date.getDate() + Number(offset || 0));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function dateLabel(value) {
  if (value === today()) return '今天';
  const parts = String(value || '').split('-');
  return parts.length === 3 ? `${Number(parts[1])}月${Number(parts[2])}日` : String(value || '');
}
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
/**
 * 近 7 天军令按天分组（今天在最上）。只收今天往前 6 天，不是「最近七个有记录的日子」——
 * 打卡机制的前提是日历连续，跳着显示就看不出断没断。
 */
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
    .map(([date, rows]) => ({
      date,
      label: dateLabel(date),
      doneText: `${rows.filter((item) => item.done).length}/${rows.length}`,
      orders: rows,
    }));
}
/**
 * 七日打卡条：固定七格（周一在左），有军令且全完成=满格，部分完成=半格，有令未动=空格，
 * 无令=虚格。这是页面上唯一的连续性可视化，断了一天要一眼看得见。
 */
function weekStrip(orders) {
  const byDate = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    if (!order || !order.date) continue;
    if (!byDate.has(order.date)) byDate.set(order.date, []);
    byDate.get(order.date).push(order);
  }
  const cells = [];
  for (let offset = -6; offset <= 0; offset += 1) {
    const date = dayKey(offset);
    const rows = byDate.get(date) || [];
    const done = rows.filter((item) => item.done).length;
    const state = !rows.length ? 'none' : done === rows.length ? 'full' : done ? 'part' : 'idle';
    cells.push({
      date,
      weekday: WEEK_CN[new Date(`${date}T00:00:00`).getDay()],
      dayNum: Number(date.split('-')[2]),
      state,
      isToday: offset === 0,
      countText: rows.length ? `${done}/${rows.length}` : '—',
    });
  }
  return cells;
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
    authed: false, onboarded: false, onboardingKnown: false, showLogin: false, loading: false, loadFailed: false, heroExpanded: false, committing: false,
    fortuneOn: false, chart: null, cited: [],
    forcesOpen: false, evidenceOpen: false, reviewOpen: false,
    forceDetails: [], forceSynthesis: null, risks: [], kpi: null,
    summary: '先说说你眼下最难拿主意的事，我来判断主要矛盾。',
    metrics: [{ value: '—', label: '案卷完整度', tone: '' }, { value: '0', label: '待补资料', tone: 'warn' }, { value: '—', label: '风险锁', tone: '' }],
    forces: [], questions: [], saying: '谋定而后动，先把主要矛盾看清。', sayingDate: '', dossierTitle: '', refreshing: false,
    // —— 军令区（原点兵，按设计稿收敛：军令带兵器 → 回填 → 复盘抽屉） ——
    streak: 0, reminders: [], hasDossier: false,
    // 日 / 周两段：日计划做今天，周计划看连续性——打卡机制的两半，缺一半就没有「别断」的压力。
    segments: ['今日军令', '本周'], segment: 0,
    weekGroups: [], weekStrip: [], weekDone: 0, weekTotal: 0,
    orders: [], displayOrders: [], leftoverWeapons: [], doneHidden: 0, showDoneArchive: false, backfill: null, savingBackfill: false,
    orderDone: 0, fillingOrderId: '', fillingOrderText: '', savingOrderResult: false,
    goalRows: goalRows(null), goalEdit: null, goalDraft: '', savingGoal: false,
    battleForces: [], pendingDecision: null, verifying: false,
    bizItems: [], bizSaved: false, bizEditing: false, savingBiz: false,
  }),
  onLoad() { this._backfill = {}; this._orderResultText = ''; this._goalDraft = ''; this._bizDraft = {}; this._forceVerdicts = {}; },
  onShow() {
    const state = store.snapshot();
    this.setData({
      themeClass: state.themeClass,
      colorKey: state.colorKey,
      isMock: state.mock,
      mockProfileLabel: state.mock ? mockProfile.label() : '',
      authed: state.authed,
      onboarded: state.onboarded,
      onboardingKnown: state.onboardingKnown,
    });
    syncTabBar(this, 1);
    // 拉一次复盘账本判红点（15 秒节流、失败静默），拿到后再同步一遍底栏。
    store.loadReviewBadge().then(() => syncTabBar(this, 1)).catch(() => {});
    this.load();
  },
  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    api.todaySaying().then((value) => this.setData({ saying: String(value.text || this.data.saying).replace(/<\/?em>/g, ''), sayingDate: value.date || '' })).catch(() => {});
    if (!store.isAuthed()) { this.setData({ loading: false }); return; }
    const [meResult, workbenchResult, decisionsResult, casefileResult, remindersResult, reviewsResult, bizTemplateResult, bizSeriesResult, prescriptionsResult] = await Promise.allSettled([
      store.loadMe(), api.workbench(), api.decisions(), api.casefile(),
      api.reminders(), api.reviews(), api.bizMetricTemplate(), api.bizMetricSeries(8), api.prescriptions(),
    ]);
    const me = meResult.status === 'fulfilled' ? meResult.value : null;
    // 判断或案卷**任一**没回来就提示可重试：原先要求两条都挂才报，结果只挂案卷时页面会说
    // 「还没有案卷 / 还没有军令」——把读失败说成空态，是最容易骗到自己的一种假象。
    this.setData({ loadFailed: meResult.status !== 'fulfilled' || casefileResult.status !== 'fulfilled' });
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
    const weekFrom = dayKey(-6);
    const weekOrders = allOrders.filter((item) => item && item.date && item.date >= weekFrom && item.date <= today());
    const orders = allOrders.filter((item) => item.date === today());
    const pendingOrders = orders.filter((item) => !item.done).map((item, index) => Object.assign({}, item, { no: index + 1 }));
    const doneOrders = orders.filter((item) => item.done);
    const orderDone = doneOrders.length;
    // 兵器挂在军令上（设计稿 ③）：**用服务端下发的 order.weapon**——拆军令那一轮 LLM 顺带选的工具，
    // 绑定 1:1。此前是「处方按位置贴到第 N 条军令」，那是展示层凑数：处方讲的问题和军令可能毫不相干。
    // 处方仍然有用，但只作为军令之后的独立兵器条（问题导向，不冒充某条军令的配套）。
    const weapons = prescriptionsResult.status === 'fulfilled' ? activePrescriptions(prescriptionsResult.value) : [];
    // 已办军令：当天的照常展示但限量，超出的与历史日期的收进归档行（评审意见 2026-08-12
    // 「当天的可以展示，但也要限制数量，历史的收起来」）。展开/收起只切本地视图，不重新取数——
    // 派生素材存在 this 上，由 applyOrderView 单点组装。
    // order.weapon 由服务端给（未配 / 工具已停用则为 null），端上不再自己配对。
    this._pendingWithWeapons = pendingOrders;
    this._doneOrders = doneOrders;
    // 独立兵器条（处方）：没有军令时一条都不列——否则「还没有军令」的引导卡下面紧跟兵器卡，
    // 页面既说没事可做又在推工具（用户反馈「两个配了军旗的卡片」）。
    // 已经作为某条军令兵器出现过的工具不再重复列，最多 2 张，不让富余处方堆成第四个货架。
    const onOrder = new Set(pendingOrders.map((item) => item.weapon && item.weapon.key).filter(Boolean));
    const leftoverWeapons = pendingOrders.length
      ? weapons.filter((item) => !onOrder.has(item.toolKey)).slice(0, 2)
      : [];
    const backfill = dossier && dossier.backfill ? dossier.backfill[today()] || null : null;
    this.setData({
      summary, questions, forces, fortuneOn, chart, cited,
      forceDetails: forces.map((item) => ({
        kind: item.kind,
        label: `${item.name} · ${item.levelLabel}`,
        // title 只放结论——打法已有独立的「打法：」行，拼进标题会整段重复且标点错乱（截图实证）。
        title: item.conclusion,
        body: item.note,
        tactic: `打法：${item.tactic}`,
        tacticTone: item.tacticTone,
      })),
      forceSynthesis: synthesis,
      risks: dossierInfo.risks,
      kpi: dossierInfo.kpi,
      onboarded: store.snapshot().onboarded,
      onboardingKnown: store.snapshot().onboardingKnown,
      metrics: [
        { value: `${workbench ? Number(workbench.completeness) || 0 : 0}%`, label: '案卷完整度', tone: '' },
        { value: String(workbench && workbench.missing ? workbench.missing.length : questions.length), label: '待补资料', tone: 'warn' },
        { value: dossierInfo.risks.length ? String(dossierInfo.risks.length) : '—', label: '风险锁', tone: dossierInfo.risks.length ? 'danger' : '' },
      ],
      // 只认真实案卷标题（workbench 契约里没有 title，历史兜底是死代码，勿加回）。
      dossierTitle: plainInline(dossier && dossier.title) || '',
      // —— 军令区 ——
      reminders: remindersView.items || [], streak: Number(reviews.streak) || 0,
      pendingDecision: decision, battleForces,
      bizItems, bizSaved: Boolean(savedMetrics), bizEditing: false, hasDossier: Boolean(dossier),
      orders, leftoverWeapons, orderDone,
      weekGroups: recentOrderGroups(allOrders), weekStrip: weekStrip(allOrders),
      weekDone: weekOrders.filter((item) => item.done).length, weekTotal: weekOrders.length,
      goalRows: goalRows(dossier && dossier.goals), backfill,
      loading: false,
    });
    this.applyOrderView();
  },
  /** 军令视图单点组装：待执行（带兵器）+ 已办（限量，其余进归档行）。展开/收起只走这里。 */
  applyOrderView() {
    const DONE_INLINE_MAX = 3;
    const done = this._doneOrders || [];
    const inline = this.data.showDoneArchive ? done : done.slice(0, DONE_INLINE_MAX);
    this.setData({
      displayOrders: (this._pendingWithWeapons || []).concat(inline),
      doneHidden: Math.max(0, done.length - inline.length),
    });
  },
  selectSegment(event) { this.setData({ segment: Number(event.currentTarget.dataset.index) }); },
  /** MOCK 角标即档案开关：切「经营中 / 空态」后重取本页数据，用来验收满态与空态两种排版。 */
  switchMockProfile() {
    mockProfile.switchProfile(() => { this.setData({ mockProfileLabel: mockProfile.label() }); this.load(); });
  },
  requireLogin() { if (store.isAuthed()) return true; this.setData({ showLogin: true }); return false; },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false, authed: true }); this.load(); },
  retry() { this.setData({ loadFailed: false }); this.load(); },
  // 三个抽屉都是组件式全屏层：必须走 store.setOverlay 隐藏自定义底栏——
  // 单纯 z-index 压不过微信独立 custom tabbar 层（AGENTS §7.2，agent-unlock 踩过）。
  _sheet(field, open) {
    store.setOverlay(open, `battle-${field}`);
    this.setData({ [field]: open });
  },
  openEvidence() { this._sheet('evidenceOpen', true); },
  closeEvidence() { this._sheet('evidenceOpen', false); },
  openReview() { if (this.requireLogin()) this._sheet('reviewOpen', true); },
  closeReview() { this._sheet('reviewOpen', false); },
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
  askQuestion(event) { if (!this.requireLogin()) return; navTo(`/packages/main/chat/index?agentKey=general&continue=1&prompt=${encodeURIComponent(event.currentTarget.dataset.text || '')}`); },
  async refreshForces() {
    if (!this.requireLogin() || this.data.refreshing) return;
    this.setData({ refreshing: true });
    try { await api.refreshForces(); await this.load(); wx.showToast({ title: '判断已刷新', icon: 'none' }); }
    catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '刷新失败' }); }
    finally { this.setData({ refreshing: false }); }
  },
  openForces() { if (this.data.forces.length) this._sheet('forcesOpen', true); },
  closeForces() { this._sheet('forcesOpen', false); },
  onHide() { this._closeSheets(); },
  onUnload() { this._closeSheets(); },
  _closeSheets() {
    for (const field of ['forcesOpen', 'evidenceOpen', 'reviewOpen']) {
      if (this.data[field]) this._sheet(field, false);
    }
  },
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
    try { await api.battleCommit(); wx.showToast({ title: '军令和方案已出', icon: 'none' }); await this.load(); }
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
  /**
   * 军令上的兵器：agent 类进这位军师的对话（带上军令原文当开场），external 类跳外部小程序。
   * 展示物料与跳转参数都来自服务端解析出的 order.weapon，端上不认 key、不拼文案。
   */
  openWeapon(event) {
    if (!this.requireLogin()) return;
    const order = this.data.displayOrders[Number(event.currentTarget.dataset.index)];
    const weapon = order && order.weapon;
    if (!weapon) return;
    if (weapon.kind === 'external') {
      if (!weapon.appId) { wx.showToast({ title: '这个兵器还没配好，稍后再试', icon: 'none' }); return; }
      wx.navigateToMiniProgram({
        appId: weapon.appId,
        path: weapon.path || '',
        fail: () => wx.showToast({ title: '没能打开这个兵器', icon: 'none' }),
      });
      return;
    }
    const send = encodeURIComponent(`就这条军令「${String(order.text || '').slice(0, 60)}」，你替我做。`);
    navTo(`/packages/main/chat/index?agentKey=${encodeURIComponent(weapon.key)}&continue=1&send=${send}`);
  },
  openPrescription(event) {
    const id = String(event.currentTarget.dataset.id || '');
    if (!id) return;
    api.prescriptionAction(id, 'clicked').catch(() => {});
    if (!navTo(`/packages/work/market/index?from=prescription&pid=${encodeURIComponent(id)}`)) {
      wx.showToast({ title: '页面正在打开，请稍候', icon: 'none' });
    }
  },
  // —— 军令区（原点兵逻辑按设计稿收敛后迁入） ——
  makeCommand() { if (this.requireLogin()) navTo('/packages/main/chat/index?agentKey=general&continue=1&send=' + encodeURIComponent('按我们最近定下的方案，把今天最重要的 1-3 件事拆成今日军令，并给出每件事的完成标准。')); },
  makeGoalPlan() { if (this.requireLogin()) navTo('/packages/main/chat/index?agentKey=strat&continue=1&send=' + encodeURIComponent('帮我把目标拆成阶梯：本周、季度、年度、3-5 年各一句话，并给出关键指标。')); },
  // 「帮我写脚本」：从一条具体军令直接找 IP 军师产出可用脚本（原点兵横滑卡组上的动作，
  // 随卡组一起被砍掉，2026-08-12 按评审意见补回，改挂在军令卡上——它本就该长在军令现场）。
  makeScript(event) {
    if (!this.requireLogin()) return;
    const text = String(event.currentTarget.dataset.text || '').trim();
    const prompt = text
      ? `围绕这条军令帮我产出可直接使用的内容脚本：「${text}」。`
      : '按我们最近定下的方案，帮我写今天要发布的内容脚本。';
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
      this.setData({ pendingDecision: null });
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
  // 手动加令走 showModal 的 editable 输入框：页内 input 在长滚动页里会被键盘顶走焦点。
  // 没案卷先说清楚，别让用户打完字再吃一个服务端 409（/casefile/orders 与 /casefile/backfill
  // 都要求先有 active casefile）。mock 会当场捏一份空案卷，缺门禁只在真机暴露。
  addOrderByModal() {
    if (!this.requireLogin()) return;
    if (!this.data.hasDossier) { wx.showToast({ title: '先和军师定下一份方案，生成案卷', icon: 'none' }); return; }
    wx.showModal({
      title: '加一条今日军令', editable: true, placeholderText: '今天必须完成的一件事', confirmText: '加入',
      success: async (result) => {
        const value = String(result.content || '').trim();
        if (!result.confirm || !value) return;
        try { await api.addOrder(value); await this.load(); wx.showToast({ title: '已加入今日军令', icon: 'none' }); }
        catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '添加失败' }); }
      },
    });
  },
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
  toggleDoneArchive() { this.setData({ showDoneArchive: !this.data.showDoneArchive }, () => this.applyOrderView()); },
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
