// 战局页只承载判断：主要矛盾、三势、天时、风险与判断依据。
// 军令/打卡/回填/复盘已迁回独立 pages/execution；命盘/时运两个 mode 已迁出（入口在主公），
// 但 fortuneOn/chart 保留——三势合参 sheet 的天势一栏仍参命盘。
const { api } = require('../../services/api');
const store = require('../../services/store');
const { navTo, gotoExecution } = require('../../services/nav');
const { commitBattle: commitBattleShared } = require('../../services/battle-commit');
const { baseData, backendEnvironmentData, syncTabBar, syncViewport } = require('../../services/page');
// 开发版环境角标：mock 时同时充当数据档案开关。
const mockProfile = require('../../services/mockProfile');
const { withShare } = require('../../services/share');

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

Page(withShare({
  data: baseData({
    authed: false, onboarded: false, onboardingKnown: false, showLogin: false, loading: false, loadFailed: false, heroExpanded: false, committing: false, todayOrderCount: 0, hasValidJudgment: false,
    fortuneOn: false, chart: null, cited: [],
    forcesOpen: false, evidenceOpen: false,
    forceDetails: [], forceSynthesis: null, risks: [], kpi: null,
    summary: '先说说你眼下最难拿主意的事，我来判断主要矛盾。',
    metrics: [{ value: '—', label: '案卷完整度', tone: '' }, { value: '0', label: '待补资料', tone: 'warn' }, { value: '—', label: '风险锁', tone: '' }],
    forces: [], questions: [], saying: '谋定而后动，先把主要矛盾看清。', sayingDate: '', dossierTitle: '', refreshing: false,
    hasDossier: false,
  }),
  onLoad() {},
  onResize(event) { syncViewport(this, event && event.size); },
  onShow() {
    const state = store.snapshot();
    this.setData(Object.assign({
      themeClass: state.themeClass,
      colorKey: state.colorKey,
      isMock: state.mock,
      mockProfileLabel: state.mock ? mockProfile.label() : '',
      authed: state.authed,
      onboarded: state.onboarded,
      onboardingKnown: state.onboardingKnown,
    }, backendEnvironmentData()));
    syncTabBar(this, 1);
    this.load();
  },
  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    api.todaySaying().then((value) => this.setData({ saying: String(value.text || this.data.saying).replace(/<\/?em>/g, ''), sayingDate: value.date || '' })).catch(() => {});
    if (!store.isAuthed()) { this.setData({ loading: false }); return; }
    const [meResult, workbenchResult, casefileResult] = await Promise.allSettled([
      store.loadMe(), api.workbench(), api.casefile(),
    ]);
    const me = meResult.status === 'fulfilled' ? meResult.value : null;
    // 判断或案卷**任一**没回来就提示可重试：原先要求两条都挂才报，结果只挂案卷时页面会说
    // 「还没有案卷 / 还没有军令」——把读失败说成空态，是最容易骗到自己的一种假象。
    this.setData({ loadFailed: !me || workbenchResult.status !== 'fulfilled' || casefileResult.status !== 'fulfilled' });
    const workbench = workbenchResult.status === 'fulfilled' ? workbenchResult.value : null;
    const casefile = casefileResult.status === 'fulfilled' ? casefileResult.value : null;
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
    const allOrders = dossier && Array.isArray(dossier.orders) ? dossier.orders : [];
    const orders = allOrders.filter((item) => item.date === today());
    const hasValidJudgment = Boolean((understanding && (understanding.mainContradiction || understanding.summary)) || rawForces.length);
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
      hasDossier: Boolean(dossier), todayOrderCount: orders.length, hasValidJudgment,
      loading: false,
    });
  },
  /** MOCK 角标即档案开关：切「经营中 / 空态」后重取本页数据，用来验收满态与空态两种排版。 */
  switchMockProfile() {
    if (!this.data.isMock) return;
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
    for (const field of ['forcesOpen', 'evidenceOpen']) {
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
    const ok = await commitBattleShared();
    this.setData({ committing: false });
    if (ok) gotoExecution('today');
  },
  goExecution() { gotoExecution('today'); },
}));
