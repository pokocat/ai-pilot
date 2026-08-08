const { api } = require('../../services/api');
const store = require('../../services/store');
const { navTo } = require('../../services/nav');
const { baseData, syncTabBar } = require('../../services/page');

const MODE_LABELS = [
  { key: 'business', label: '经营战局' },
  { key: 'timing', label: '时运策' },
  { key: 'destiny', label: '命盘分析' },
];
const PHASE_WORD = { 进攻: '攻', 防守: '守', 平稳: '稳中蓄力' };

function chartView(chart) {
  if (!chart) return null;
  const months = chart.monthlyOutlook && Array.isArray(chart.monthlyOutlook.months) ? chart.monthlyOutlook.months : [];
  const month = new Date().getMonth() + 1;
  const current = months.find((item) => Number(item.month) === month) || null;
  const pattern = chart.pattern || {};
  const pillars = chart.pillars || {};
  const pillarCells = [
    ['年柱', pillars.year && pillars.year.ganZhi, '根基'],
    ['月柱', pillars.month && pillars.month.ganZhi, '节律'],
    ['日柱', pillars.day && pillars.day.ganZhi, '自驱'],
  ];
  if (chart.hourKnown && pillars.time) pillarCells.push(['时柱', pillars.time.ganZhi, '表达']);
  const turning = months.filter((item) => item.turning).map((item) => item.month);
  const phase = current ? (PHASE_WORD[current.phase] || current.phase || '稳中蓄力') : '稳中蓄力';
  return {
    monthTitle: `本月宜${phase}`,
    monthLine: `${pattern.name || '格局待判'} · 本月宜${phase}${current && current.turning ? ' · 拐点月' : ''}`,
    turning: turning.length ? `${turning.join('/')}月` : '无',
    patternName: pattern.name || '格局待判',
    patternTraits: pattern.traits || '录入完整生辰后补充节律判断',
    suits: Array.isArray(pattern.suits) && pattern.suits.length ? pattern.suits.join(' · ') : '按当前判断推进',
    avoid: Array.isArray(pattern.avoid) && pattern.avoid.length ? pattern.avoid.join(' · ') : '暂无明确禁忌',
    pillarCells: pillarCells.filter((item) => item[1]).map((item) => ({ key: item[0], value: item[1], tag: item[2] })),
    hourKnown: Boolean(chart.hourKnown),
    dayMaster: chart.dayMaster ? `${chart.dayMaster.gan || ''}（${chart.dayMaster.element || ''}）${chart.dayMaster.strength || ''}` : '待补全',
    favorable: Array.isArray(chart.favorableElements) && chart.favorableElements.length ? `喜用：${chart.favorableElements.join(' · ')}` : '喜用五行待补全',
    ziweiStars: chart.ziwei && Array.isArray(chart.ziwei.soulMajorStars) ? chart.ziwei.soulMajorStars.join(' · ') : '',
  };
}

function pickPendingDecision(result) {
  const items = result && Array.isArray(result.items) ? result.items : [];
  return items.find((item) => item && (item.status === 'pending' || item.verified === false)) || null;
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

Page({
  data: baseData({
    authed: false, onboarded: false, onboardingKnown: false, showLogin: false, loading: false, heroExpanded: false, committing: false,
    mode: 'business', modeTabs: MODE_LABELS, fortuneOn: false, chart: null, pendingDecision: null, cited: [],
    forcesOpen: false, forceDetails: [], forceSynthesis: null, risks: [], kpi: null,
    summary: '先说说你眼下最难拿主意的事，我来判断主要矛盾。',
    nextTitle: '先做一次军师首判', nextDesc: '三问形成第一份判断', nextRoute: '/packages/work/quickscan/index',
    metrics: [{ value: '—', label: '案卷完整度', tone: '' }, { value: '0', label: '待补资料', tone: 'warn' }, { value: '—', label: '风险锁', tone: '' }],
    forces: [], questions: [], saying: '谋定而后动，先把主要矛盾看清。', sayingDate: '', dossierTitle: '', refreshing: false,
    modules: [{ title: '战略诊断', owner: '战略军师', tier: 'free', price: '免费' }, { title: '增长路径', owner: '增长军师', tier: 'power', price: '算力' }, { title: '经营复盘', owner: '经营军师', tier: 'plan', price: '方案内' }],
  }),
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
    this.load();
  },
  async load() {
    this.setData({ loading: true });
    api.todaySaying().then((value) => this.setData({ saying: String(value.text || this.data.saying).replace(/<\/?em>/g, ''), sayingDate: value.date || '' })).catch(() => {});
    if (!store.isAuthed()) { this.setData({ loading: false }); return; }
    const [meResult, journeyResult, workbenchResult, decisionsResult, casefileResult] = await Promise.allSettled([
      store.loadMe(), api.journey(), api.workbench(), api.decisions(), api.casefile(),
    ]);
    const me = meResult.status === 'fulfilled' ? meResult.value : null;
    const journey = journeyResult.status === 'fulfilled' ? journeyResult.value : null;
    const workbench = workbenchResult.status === 'fulfilled' ? workbenchResult.value : null;
    const decisions = decisionsResult.status === 'fulfilled' ? decisionsResult.value : null;
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
    const forces = understanding && Array.isArray(understanding.battleForces) ? understanding.battleForces.map((item) => ({
      kind: item.kind || 'sky', name: item.label || item.name || forceNames[item.kind] || '一势', levelLabel: levelNames[item.level] || item.level || '待判',
      conclusion: item.conclusion || item.verdict || item.summary || '待判断', tactic: item.tactic || '先验证', tacticTone: item.tacticTone || (item.level === 'weak' ? 'danger' : item.level === 'mid' ? 'warn' : 'ok'),
      strength: Number(item.strength) || (item.level === 'strong' ? 85 : item.level === 'weak' ? 35 : 60), note: item.note || item.summary || item.desc || '',
    })) : [];
    const pendingDecision = pickPendingDecision(decisions);
    const dossier = dossierView(casefile);
    const synthesis = forceSynthesis(forces);
    const evidence = understanding && understanding.evidenceCount || {};
    const cited = [
      { label: '对话问对', count: Number(evidence.sessions) || 0, route: '/pages/sessions/index', tab: true },
      { label: '档案', count: Number(evidence.profile) || 0, route: '/packages/main/brief/index' },
      { label: '案卷', count: Number(evidence.projects) || 0, route: '/packages/work/projects/index' },
      { label: '资料', count: Number(evidence.knowledge) || 0, route: '/packages/work/knowledge/index' },
      { label: '军师记忆', count: Number(evidence.memories) || 0, route: '/packages/main/brief/index' },
    ].filter((item) => item.count > 0);
    this.setData({
      summary, questions, forces, fortuneOn, chart, pendingDecision, cited,
      forceDetails: forces.map((item) => ({
        kind: item.kind,
        label: `${item.name} · ${item.levelLabel}`,
        title: `${item.conclusion}，${item.tactic}`,
        body: item.note,
        tactic: `打法：${item.tactic}`,
        tacticTone: item.tacticTone,
      })),
      forceSynthesis: synthesis,
      risks: dossier.risks,
      kpi: dossier.kpi,
      onboarded: store.snapshot().onboarded,
      onboardingKnown: store.snapshot().onboardingKnown,
      mode: fortuneOn ? this.data.mode : 'business',
      nextTitle: journey && journey.nextStep ? journey.nextStep.title : this.data.nextTitle,
      nextDesc: journey && journey.nextStep ? journey.nextStep.desc : this.data.nextDesc,
      nextRoute: journey && journey.nextStep ? journey.nextStep.route : this.data.nextRoute,
      metrics: [
        { value: `${workbench ? Number(workbench.completeness) || 0 : 0}%`, label: '案卷完整度', tone: '' },
        { value: String(workbench && workbench.missing ? workbench.missing.length : questions.length), label: '待补资料', tone: 'warn' },
        { value: dossier.risks.length ? String(dossier.risks.length) : '—', label: '风险锁', tone: dossier.risks.length ? 'danger' : '' },
      ],
      dossierTitle: dossier.dossier && dossier.dossier.title || workbench && workbench.title || '',
      loading: false,
    });
  },
  requireLogin() { if (store.isAuthed()) return true; this.setData({ showLogin: true }); return false; },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false, authed: true }); this.load(); },
  goOnboarding() {
    try {
      const pages = getCurrentPages();
      if (pages.some((page) => String(page.route || '').includes('packages/main/onboarding'))) return;
    } catch (_) { /* 页栈读取失败时仍允许正常导航 */ }
    navTo('/packages/main/onboarding/index');
  },
  ask() { navTo('/packages/main/chat/index?agentKey=general&continue=1'); },
  setMode(event) { this.setData({ mode: event.currentTarget.dataset.mode || 'business' }); },
  openCalendar() { navTo('/packages/work/calendar/index'); },
  openMingpan() { navTo('/packages/work/mingpan/index'); },
  openLedger() { navTo('/packages/work/ledger/index'); },
  tapEvidence(event) {
    const item = this.data.cited[Number(event.currentTarget.dataset.index)];
    if (!item) return;
    if (item.tab) wx.switchTab({ url: item.route }); else navTo(item.route);
  },
  toggleHero() { this.setData({ heroExpanded: !this.data.heroExpanded }); },
  tapMetric(event) { const index = Number(event.currentTarget.dataset.index); if (index === 0) navTo('/packages/main/brief/index'); else if (index === 2) this.askRisks(); else this.ask(); },
  next() { if (this.requireLogin()) navTo(this.data.nextRoute || '/packages/main/chat/index?agentKey=general&continue=1'); },
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
  openStudio() { wx.switchTab({ url: '/pages/studio/index' }); },
  openMarket() { navTo('/packages/work/market/index'); },
  async commitBattle() {
    if (!this.requireLogin() || this.data.committing) return;
    this.setData({ committing: true });
    try { await api.battleCommit(); wx.showToast({ title: '军令和方案已出', icon: 'none' }); wx.switchTab({ url: '/pages/studio/index' }); }
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
});
