// 今日 tab：军令、打卡、回填、复盘的日频工作台，页尾接锦囊段。
//
// 2026-08-19 IA 第四刀（B + E3）：锦囊不再是子页。
//   · 页尾的锦囊卡换成锦囊段本体——一门手艺一行，上半「做一张 / 做一条 / 写一份」，
//     下半是这门手艺出过的东西（三张缩略图 + 出过 N 张 ›）。两个落点上下分家。
//   · 段的位置继承原来那张锦囊卡：写在两个段控 block 之外，「今天」和「近七日」都在——
//     这不是新规矩，复盘入口一直也是这么挂的。
//   · 原来那排「今天出的活」148px 横滑卡收成一行汇总，点了滚到锦囊段：
//     同一页上不该出现两处作品缩略图（相隔约 600px，读起来像同一批东西摆了两遍）。
//   · 跨手艺按时间翻的那份清单留在 pages/pouch（唯一剩下的锦囊子页），入口是段末那行。
// 数据与置灰口径全部走 services/pouch-data，不在本页复制一份。
const { api } = require('../../services/api');
const store = require('../../services/store');
const { navTo, consumeExecutionIntent } = require('../../services/nav');
const { baseData, backendEnvironmentData, syncTabBar, syncViewport } = require('../../services/page');
const { commitBattle } = require('../../services/battle-commit');
const worksCache = require('../../services/works-cache');
const pouchData = require('../../services/pouch-data');
const mockProfile = require('../../services/mockProfile');
const { withShare } = require('../../services/share');

const POUCH_MOVED_KEY = 'junshi.execution.pouch-moved.v1';
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
const GOAL_FIELDS = [['weekly', '本周'], ['quarterly', '季度'], ['annual', '年度'], ['longTerm', '3-5年']];

function dateKey(date) { const value = date || new Date(); return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`; }
function today() { return dateKey(new Date()); }
function dayKey(offset) { const date = new Date(); date.setDate(date.getDate() + Number(offset || 0)); return dateKey(date); }
function thisMonday() { const date = new Date(); date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); return dateKey(date); }
function dateLabel(value) { if (value === today()) return '今天'; const parts = String(value || '').split('-'); return parts.length === 3 ? `${Number(parts[1])}月${Number(parts[2])}日` : String(value || ''); }
function at(value) { return Date.parse(String(value || '')) || 0; }
function plainInline(value) {
  return String(value || '').replace(/```[\s\S]*?```/g, ' ').replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/[*_`>]/g, '').replace(/\s+/g, ' ').trim();
}
function recentOrderGroups(orders) {
  const groups = new Map(); const minDate = dayKey(-6); const maxDate = today();
  for (const order of Array.isArray(orders) ? orders : []) {
    if (!order || !order.date || order.date < minDate || order.date > maxDate) continue;
    if (!groups.has(order.date)) groups.set(order.date, []);
    groups.get(order.date).push(order);
  }
  return [...groups.entries()].sort((a, b) => a[0] < b[0] ? 1 : -1).map(([date, rows]) => ({ date, label: dateLabel(date), doneText: `${rows.filter((item) => item.done).length}/${rows.length}`, orders: rows }));
}
function weekStrip(orders) {
  const byDate = new Map();
  for (const order of Array.isArray(orders) ? orders : []) { if (!order || !order.date) continue; if (!byDate.has(order.date)) byDate.set(order.date, []); byDate.get(order.date).push(order); }
  const cells = [];
  for (let offset = -6; offset <= 0; offset += 1) {
    const date = dayKey(offset); const rows = byDate.get(date) || []; const done = rows.filter((item) => item.done).length;
    cells.push({ date, weekday: WEEK_CN[new Date(`${date}T00:00:00`).getDay()], dayNum: Number(date.split('-')[2]), state: !rows.length ? 'none' : done === rows.length ? 'full' : done ? 'part' : 'idle', isToday: offset === 0 });
  }
  return cells;
}
function goalRows(goals) { const value = goals && typeof goals === 'object' ? goals : {}; return GOAL_FIELDS.map(([field, label]) => ({ field, label, value: String(value[field] || ''), empty: !value[field] })); }
function pickPendingDecision(result) { const items = result && Array.isArray(result.items) ? result.items : []; return items.find((item) => item && (item.status === 'pending' || item.verified === false)) || null; }
function activePrescriptions(result) { const items = result && Array.isArray(result.items) ? result.items : []; return items.filter((item) => item && item.id && item.status !== 'dismissed' && item.status !== 'activated'); }
function safeMovedHint() { try { return wx.getStorageSync(POUCH_MOVED_KEY) !== '1'; } catch (_) { return true; } }
/**
 * 今日成品汇总行的文案。
 *
 * 旧版只数海报（横滑卡也只摆海报）。汇总行既然要写「今天出了 N 件」，那这个 N 必须是全的，
 * 否则出了成片的那天会当着用户的面少报。所以只有三条通道**全都有数**时才报总数；
 * 成片还在路上（慢通道未落地）或某一路读失败时，只逐类列出已知的，不给总数。
 */
const TYPE_LABEL = { poster: '海报', clip: '成片', report: '方案' };
function todaySummary(feed) {
  const parts = []; let total = 0; let complete = true;
  for (const type of ['poster', 'clip', 'report']) {
    const rows = type === 'poster' ? feed.posters : type === 'clip' ? feed.clips : feed.reports;
    if (!rows) { complete = false; continue; }
    const count = rows.filter((row) => dateKey(new Date(row.updatedAt)) === today()).length;
    if (!count) continue;
    total += count;
    parts.push(`${TYPE_LABEL[type]} ${count}`);
  }
  const failed = feed.failed.map((type) => TYPE_LABEL[type]).join(' / ');
  let text;
  if (total && complete) text = `今天出了 ${total} 件 · ${parts.join(' · ')}`;
  else if (total) text = `今天出的活 · ${parts.join(' · ')}`;
  else if (complete) text = '今天还没出东西 · 去锦囊段开工';
  else if (failed) text = '今天出的活';
  else text = '正在汇总今天的成品…';
  return { text, partial: failed ? `${failed}没读出来` : '', empty: complete && !total };
}

Page(withShare({
  data: baseData({
    authed: false, showLogin: false, coreStatus: 'idle', coreError: '', worksStatus: 'idle', worksError: '', reviewStatus: 'idle', reviewError: '', committing: false,
    segments: ['今天', '近七日'], segment: 0, scrollTop: 0, pouchMovedHint: safeMovedHint(), reviewDue: false,
    hasDossier: false, orders: [], displayOrders: [], leftoverWeapons: [], doneHidden: 0, showDoneArchive: false,
    orderDone: 0, fillingOrderId: '', fillingOrderText: '', savingOrderResult: false,
    weekGroups: [], weekStrip: [], weekDone: 0, weekTotal: 0, streak: 0,
    backfill: null, savingBackfill: false, reminders: [], reviewOpen: false,
    todaySummary: '', todayPartial: '', todayEmpty: false, crafts: [], archiveText: '跨手艺翻找 · 全部作品按时间排', unlockAgent: null,
    battleForces: [], pendingDecision: null, verifying: false,
    bizItems: [], bizSaved: false, bizEditing: false, savingBiz: false, reviewKeyboardHeight: 0, reviewAnchor: '',
    goalRows: goalRows(null), goalEdit: null, goalDraft: '', savingGoal: false,
  }),
  onLoad() {
    this._scrollBySegment = [0, 0]; this._backfill = {}; this._orderResultText = ''; this._goalDraft = ''; this._bizDraft = {}; this._forceVerdicts = {};
  },
  onResize(event) { syncViewport(this, event && event.size); },
  onShow() {
    const state = store.snapshot();
    this._pouchEntryTracked = false;
    const intent = consumeExecutionIntent();
    const segment = intent ? (intent === 'week' ? 1 : 0) : this.data.segment;
    this.setData(Object.assign({
      themeClass: state.themeClass, colorKey: state.colorKey, isMock: state.mock, mockProfileLabel: state.mock ? mockProfile.label() : '',
      authed: state.authed, segment, scrollTop: this._scrollBySegment[segment] || 0, reviewDue: state.reviewDue,
    }, backendEnvironmentData()));
    syncTabBar(this, 2);
    store.loadReviewBadge().then(() => { const next = store.snapshot(); this.setData({ reviewDue: next.reviewDue }); syncTabBar(this, 2); }).catch(() => {});
    api.track('execution_enter', { segment: segment ? 'week' : 'today', reviewDue: state.reviewDue });
    this.loadCore();
    // 锦囊段固定在两个段控栏，取数与 segment 无关。
    if (state.authed) this.loadPouch();
  },
  onPageScroll() {},
  onScroll(event) { this._scrollBySegment[this.data.segment] = Number(event.detail && event.detail.scrollTop) || 0; },
  selectSegment(event) {
    const segment = Number(event.currentTarget.dataset.index) === 1 ? 1 : 0;
    if (segment === this.data.segment) return;
    this.setData({ segment, scrollTop: this._scrollBySegment[segment] || 0 });
  },
  switchMockProfile() { if (!this.data.isMock) return; mockProfile.switchProfile(() => { this.setData({ mockProfileLabel: mockProfile.label() }); worksCache.invalidate(); this.loadCore({ force: true }); this.loadPouch({ force: true }); }); },
  requireLogin() { if (store.isAuthed()) return true; this.setData({ showLogin: true }); return false; },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false, authed: true }); this.loadCore({ force: true }); this.loadPouch({ force: true }); },
  askLogin() { this.requireLogin(); },

  async loadCore() {
    if (this.data.coreStatus === 'loading') return;
    if (!store.isAuthed()) { this.setData({ authed: false, coreStatus: 'idle', coreError: '', orders: [], crafts: [], todaySummary: '' }); return; }
    this.setData({ coreStatus: 'loading', coreError: '' });
    const [meResult, casefileResult, reviewsResult, prescriptionsResult] = await Promise.allSettled([
      store.loadMe(), api.casefile(), api.reviews(), api.prescriptions(),
    ]);
    if (casefileResult.status !== 'fulfilled' || meResult.status !== 'fulfilled' || !meResult.value || reviewsResult.status !== 'fulfilled' || prescriptionsResult.status !== 'fulfilled') {
      this.setData({ coreStatus: 'error', coreError: '军令没读出来，网络不畅或服务端在忙' });
      return;
    }
    const me = meResult.value || {}; const casefile = casefileResult.value || {}; const dossier = casefile.casefile || null;
    const allOrders = dossier && Array.isArray(dossier.orders) ? dossier.orders : [];
    const orders = allOrders.filter((item) => item.date === today());
    const pendingOrders = orders.filter((item) => !item.done).map((item, index) => Object.assign({}, item, { no: index + 1 }));
    const doneOrders = orders.filter((item) => item.done);
    this._pendingWithWeapons = pendingOrders; this._doneOrders = doneOrders;
    const weapons = prescriptionsResult.status === 'fulfilled' ? activePrescriptions(prescriptionsResult.value) : [];
    const onOrder = new Set(pendingOrders.map((item) => item.weapon && item.weapon.key).filter(Boolean));
    const leftoverWeapons = pendingOrders.length ? weapons.filter((item) => !onOrder.has(item.toolKey)).slice(0, 2) : [];
    const reviews = reviewsResult.status === 'fulfilled' ? reviewsResult.value : { streak: 0 };
    const forceNames = { sky: '天势', market: '市势', people: '人势' };
    const rawForces = me.understanding && Array.isArray(me.understanding.battleForces) ? me.understanding.battleForces : [];
    const weekOrders = allOrders.filter((item) => item && item.date >= dayKey(-6) && item.date <= today());
    this.setData({
      coreStatus: 'ready', coreError: '', hasDossier: Boolean(dossier), orders, orderDone: doneOrders.length, leftoverWeapons,
      weekGroups: recentOrderGroups(allOrders), weekStrip: weekStrip(allOrders), weekDone: weekOrders.filter((item) => item.done).length, weekTotal: weekOrders.length,
      backfill: dossier && dossier.backfill ? dossier.backfill[today()] || null : null, streak: Number(reviews.streak) || 0,
      battleForces: rawForces.map((item) => ({ kind: item.kind, label: forceNames[item.kind] || item.kind, conclusion: item.conclusion || '', tactic: item.tactic || '', verdict: this._forceVerdicts[item.kind] || '' })),
      goalRows: goalRows(dossier && dossier.goals),
    });
    this.applyOrderView();
  },
  retryCore() { this.loadCore({ force: true }); },
  /**
   * 锦囊段 + 今日汇总行的取数。
   *
   * 与 loadCore 完全解耦：三条作品通道里 /video/works 是服务端到 aidrama 的同步代理
   * （上游预算 15–60s），今日 tab 是全站最高频的页面，绝不能让军令等它。
   * 任何一路塌了也只塌那一行的计数（'—'），不整段报错。
   */
  async loadPouch(options) {
    if (!store.isAuthed() || this.data.worksStatus === 'loading') return;
    this.setData({ worksStatus: 'loading', worksError: '' });
    // 快通道：海报 + 方案 + 军师目录。成片（12s 预算的 aidrama 代理）走 loadClipChannel 另补，
    // 首屏的汇总行不吊在它上面。
    const [feedResult, agentsResult] = await Promise.allSettled([
      pouchData.loadFeed(Object.assign({}, options, { skipClips: true })),
      store.loadAgents(),
    ]);
    const feed = feedResult.status === 'fulfilled' ? feedResult.value : null;
    if (!feed || feed.failed.length >= 2) {
      this.setData({ worksStatus: 'error', worksError: '锦囊没读出来，网络不畅或服务端在忙' });
      return;
    }
    const agents = agentsResult.status === 'fulfilled' && Array.isArray(agentsResult.value)
      ? agentsResult.value : store.snapshot().agents;
    this._agents = agents;
    // 原始 agent 留一份索引给启用层用（价格只在 agent-unlock 那一刻出现，不进行数据）。
    this._agentsByKey = Object.fromEntries((agents || []).filter((item) => item && item.key).map((item) => [String(item.key), item]));
    this._feed = feed;
    this.renderPouch();
    setTimeout(() => this.observePouchSection(), 0);
    this.loadClipChannel(options);
  },

  /**
   * 慢通道：成片。落地后把「快出片」那行的作品带补上、汇总行升级成带总数的说法。
   * 失败只影响这一行（写「没读出来 · 重试」），不动已经渲染好的其余部分。
   */
  async loadClipChannel(options) {
    if (this._clipInFlight) return;
    this._clipInFlight = true;
    const clips = await pouchData.loadClips(options);
    this._clipInFlight = false;
    if (!this._feed) return;
    this._feed = pouchData.applyClips(this._feed, clips);
    this.renderPouch();
  },

  /** 把当前 feed 落成页面数据。快慢两条通道各自落地一次，渲染口径只有这一处。 */
  renderPouch() {
    const feed = this._feed;
    if (!feed) return;
    const summary = todaySummary(feed);
    // 有一路没读到（或还没到）就不报总数——「12 件」少算了一类比不给数字更糟。
    const complete = !feed.failed.length && !feed.pending.length;
    const total = complete ? ['poster', 'clip', 'report'].reduce((sum, type) => sum + (feed.counts[type] || 0), 0) : null;
    this.setData({
      worksStatus: 'ready', worksError: '',
      todaySummary: summary.text, todayPartial: summary.partial, todayEmpty: summary.empty,
      crafts: pouchData.buildCraftRows(this._agents, feed),
      archiveText: total == null ? '跨手艺翻找 · 全部作品按时间排' : `跨手艺翻找 · ${total} 件全都按时间排`,
    });
  },
  retryWorks() { this.loadPouch({ force: true }); },

  /** 手艺插画取不到时收起 image，留纸底占位——不留破图也不留白框。 */
  onCraftArtError(event) {
    const index = Number(event.currentTarget.dataset.index);
    const item = this.data.crafts[index];
    if (!item || !item.art) return;
    this.setData({ [`crafts[${index}].art`]: '' });
  },
  onCraftWorkError(event) {
    const { index, work } = event.currentTarget.dataset;
    const row = this.data.crafts[Number(index)];
    const item = row && row.works[Number(work)];
    if (!item || item.thumb === item.art) return;
    this.setData({ [`crafts[${index}].works[${work}].thumb`]: item.art });
  },

  /**
   * 汇总行：点了滚到页尾锦囊段（同一页内，不跳转）。
   *
   * 不用 scroll-into-view —— 本页这个 scroll-view 开了 enhanced，且已经绑着 scroll-top 与
   * bindscroll；再叠一个 scroll-into-view 就成了全仓独一份的组合（chat / 问策只绑
   * scroll-into-view，不绑 scroll-top）。这里改成量出段头位置直接写 scroll-top，
   * 与本页既有的分段滚动位置记忆同一条路子。
   */
  scrollToPouch() {
    api.track('pouch_entry_click', { entry: 'today_summary', segment: this.data.segment ? 'week' : 'today' });
    const query = wx.createSelectorQuery();
    query.select('#pouch-sec').boundingClientRect();
    query.select('.exec-scroll').scrollOffset();
    query.exec((res) => {
      const target = res && res[0];
      const scroll = res && res[1];
      if (!target || !scroll) return;
      let top = Math.max(0, scroll.scrollTop + target.top - 12);
      // scroll-top 绑的是同一个值：已经停在那儿时再点，得让值真的变一下才会重滚。
      if (top === this.data.scrollTop) top += 1;
      this._scrollBySegment[this.data.segment] = top;
      this.setData({ scrollTop: top });
    });
  },

  /**
   * 手艺行上半格：已启用的直接开工；未启用的开启用层（价格只在这一刻出现，行上永不标价），
   * 启用成功后由 agentUnlocked 带进这位军师的对话——第一次仍然是军师带着做。
   */
  openCraft(event) {
    const item = this.data.crafts[Number(event.currentTarget.dataset.index)];
    if (!item) return;
    this.dismissMovedHint();
    if (item.locked && item.agentKey) {
      if (!this.requireLogin()) return;
      const agent = this._agentsByKey && this._agentsByKey[item.agentKey];
      if (agent) { this.setData({ unlockAgent: agent }); return; }
      // 目录没取到这位军师（/agents 挂了）：locked 行没有落点，点了不能没反应。
      wx.showToast({ title: '军师目录没读到，下拉重试一次', icon: 'none' });
      return;
    }
    api.track('pouch_entry_click', { entry: 'craft_make', craft: item.key });
    if (item.makeRoute) navTo(item.makeRoute);
  },
  /** 手艺行下半格：进这门手艺的作品库（catchtap，不冒泡给 openCraft）。 */
  openCraftWorks(event) {
    const item = this.data.crafts[Number(event.currentTarget.dataset.index)];
    if (!item) return;
    if (!item.worksRoute) { this.openCraft(event); return; }
    this.dismissMovedHint();
    api.track('pouch_entry_click', { entry: 'craft_works', craft: item.key });
    navTo(item.worksRoute);
  },
  /** 段末那行：跨手艺按时间翻的档案页（锦囊唯一剩下的子页）。 */
  openArchive() {
    this.dismissMovedHint();
    api.track('pouch_entry_click', { entry: 'archive', segment: this.data.segment ? 'week' : 'today' });
    navTo('/pages/pouch/index');
  },
  dismissMovedHint() {
    if (!this.data.pouchMovedHint) return;
    try { wx.setStorageSync(POUCH_MOVED_KEY, '1'); } catch (_) { /* noop */ }
    this.setData({ pouchMovedHint: false });
  },
  closeUnlock() { this.setData({ unlockAgent: null }); },
  agentUnlocked(event) {
    const agent = event.detail && event.detail.agent;
    this.setData({ unlockAgent: null });
    this.loadPouch({ force: true });
    if (agent && agent.key) navTo(`/packages/main/chat/index?agentKey=${encodeURIComponent(agent.key)}&continue=1`);
  },
  observePouchSection() {
    if (this._pouchEntryTracked || typeof wx.createIntersectionObserver !== 'function') return;
    if (this._pouchObserver) this._pouchObserver.disconnect();
    this._pouchObserver = wx.createIntersectionObserver(this);
    this._pouchObserver.relativeToViewport().observe('.pouch-sec', (entry) => {
      if (!entry || Number(entry.intersectionRatio) <= 0 || this._pouchEntryTracked) return;
      this._pouchEntryTracked = true;
      api.track('pouch_entry_view', { entry: 'pouch_section', segment: this.data.segment ? 'week' : 'today', movedHint: this.data.pouchMovedHint });
      if (this._pouchObserver) { this._pouchObserver.disconnect(); this._pouchObserver = null; }
    });
  },

  async loadReviewDetails() {
    if (this.data.reviewStatus === 'loading') return;
    this.setData({ reviewStatus: 'loading', reviewError: '' });
    const [decisionsResult, remindersResult, bizTemplateResult, bizSeriesResult] = await Promise.allSettled([
      api.decisions(), api.reminders(), api.bizMetricTemplate(), api.bizMetricSeries(8),
    ]);
    if ([decisionsResult, remindersResult, bizTemplateResult, bizSeriesResult].some((item) => item.status !== 'fulfilled')) {
      this.setData({ reviewStatus: 'error', reviewError: '复盘资料没读完整，请重试' });
      return;
    }
    const template = Array.isArray(bizTemplateResult.value.items) ? bizTemplateResult.value.items : [];
    const series = Array.isArray(bizSeriesResult.value.items) ? bizSeriesResult.value.items : [];
    const weekEntry = series.find((item) => item.weekStart === thisMonday());
    const saved = weekEntry && weekEntry.metrics && Object.keys(weekEntry.metrics).length ? weekEntry.metrics : null;
    const bizItems = template.map((item) => ({ key: item.metricKey, name: item.metricName, unit: item.unit || '', value: saved && saved[item.metricKey] != null ? String(saved[item.metricKey]) : '' }));
    this._bizDraft = Object.fromEntries(bizItems.map((item) => [item.key, item.value]));
    this.setData({
      reviewStatus: 'ready', reviewError: '', pendingDecision: pickPendingDecision(decisionsResult.value),
      reminders: remindersResult.value.items || [], bizItems, bizSaved: Boolean(saved), bizEditing: false,
    });
  },
  retryReview() { this.loadReviewDetails(); },

  applyOrderView() { const done = this._doneOrders || []; const inline = this.data.showDoneArchive ? done : done.slice(0, 3); this.setData({ displayOrders: (this._pendingWithWeapons || []).concat(inline), doneHidden: Math.max(0, done.length - inline.length) }); },
  async arrangeOrders() { if (!this.requireLogin() || this.data.committing) return; this.setData({ committing: true }); const ok = await commitBattle(); if (ok) await this.loadCore({ force: true }); this.setData({ committing: false }); },
  makeCommand() { if (this.requireLogin()) navTo('/packages/main/chat/index?agentKey=general&continue=1&send=' + encodeURIComponent('按我们最近定下的方案，把今天最重要的 1-3 件事拆成今日军令，并给出每件事的完成标准。')); },
  makeGoalPlan() { if (this.requireLogin()) navTo('/packages/main/chat/index?agentKey=strat&continue=1&send=' + encodeURIComponent('帮我把目标拆成阶梯：本周、季度、年度、3-5 年各一句话，并给出关键指标。')); },
  makeScript(event) { if (!this.requireLogin()) return; const value = String(event.currentTarget.dataset.text || '').trim(); navTo(`/packages/main/chat/index?agentKey=ip&continue=1&send=${encodeURIComponent(value ? `围绕这条军令帮我产出可直接使用的内容脚本：「${value}」。` : '按我们最近定下的方案，帮我写今天要发布的内容脚本。')}`); },
  openWeapon(event) {
    if (!this.requireLogin()) return; const order = this.data.displayOrders[Number(event.currentTarget.dataset.index)]; const weapon = order && order.weapon; if (!weapon) return;
    api.track('weapon_click', { kind: weapon.kind || 'agent', weaponKey: weapon.key || '' });
    if (weapon.kind === 'external') { if (!weapon.appId) { wx.showToast({ title: '这个兵器还没配好，稍后再试', icon: 'none' }); return; } wx.navigateToMiniProgram({ appId: weapon.appId, path: weapon.path || '', fail: () => wx.showToast({ title: '没能打开这个兵器', icon: 'none' }) }); return; }
    navTo(`/packages/main/chat/index?agentKey=${encodeURIComponent(weapon.key)}&continue=1&send=${encodeURIComponent(`就这条军令「${String(order.text || '').slice(0, 60)}」，你替我做。`)}`);
  },
  openPrescription(event) { const id = String(event.currentTarget.dataset.id || ''); if (!id) return; api.prescriptionAction(id, 'clicked').catch(() => {}); navTo(`/packages/work/market/index?from=prescription&pid=${encodeURIComponent(id)}`); },
  addOrderByModal() {
    if (!this.requireLogin()) return; if (!this.data.hasDossier) { wx.showToast({ title: '先和军师定下一份方案，生成案卷', icon: 'none' }); return; }
    wx.showModal({ title: '加一条今日军令', editable: true, placeholderText: '今天必须完成的一件事', confirmText: '加入', success: async (result) => { const value = String(result.content || '').trim(); if (!result.confirm || !value) return; try { await api.addOrder(value); await this.loadCore({ force: true }); wx.showToast({ title: '已加入今日军令', icon: 'none' }); } catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '添加失败' }); } } });
  },
  async toggleOrder(event) { const id = event.currentTarget.dataset.id; const current = this.data.orders.find((item) => item.id === id); if (!current) return; try { await api.toggleOrder(id); if (!current.done) { api.track('order_complete', { orderId: id }); this._orderResultText = current.resultNote || ''; this.setData({ fillingOrderId: id, fillingOrderText: this._orderResultText }); } else { this._orderResultText = ''; this.setData({ fillingOrderId: '', fillingOrderText: '' }); } await this.loadCore({ force: true }); } catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '更新失败' }); } },
  inputOrderResult(event) { this._orderResultText = String(event.detail.value || '').slice(0, 200); },
  async saveOrderResult() { const id = this.data.fillingOrderId; const value = String(this._orderResultText || '').trim(); if (!id || this.data.savingOrderResult) return; if (!value) { wx.showToast({ title: '先填一句做完的量', icon: 'none' }); return; } this.setData({ savingOrderResult: true }); try { await api.setOrderResult(id, value); this._orderResultText = ''; this.setData({ fillingOrderId: '', fillingOrderText: '' }); await this.loadCore({ force: true }); wx.showToast({ title: '数据已回填', icon: 'none' }); } catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '回填未成，稍后再试' }); } finally { this.setData({ savingOrderResult: false }); } },
  toggleDoneArchive() { this.setData({ showDoneArchive: !this.data.showDoneArchive }, () => this.applyOrderView()); },
  openOrder(event) { const id = event.currentTarget.dataset.id; if (id) navTo(`/packages/work/command/index?id=${encodeURIComponent(id)}`); },
  removeOrder(event) { const id = event.currentTarget.dataset.id; const text = event.currentTarget.dataset.text || '这条军令'; wx.showModal({ title: '删除军令', content: `确认删除「${text}」？`, confirmText: '删除', confirmColor: '#B43C32', success: async (result) => { if (!result.confirm) return; try { await api.removeOrder(id); await this.loadCore({ force: true }); } catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '删除失败' }); } } }); },
  inputBackfill(event) { this._backfill[event.currentTarget.dataset.field] = event.detail.value; },
  async saveBackfill() { if (this.data.savingBackfill) return; if (!this.data.hasDossier) { wx.showToast({ title: '先和军师定下一份方案，生成案卷', icon: 'none' }); return; } const current = this.data.backfill || {}; const values = { leads: String(this._backfill.leads != null ? this._backfill.leads : current.leads || ''), consults: String(this._backfill.consults != null ? this._backfill.consults : current.consults || ''), deals: String(this._backfill.deals != null ? this._backfill.deals : current.deals || '') }; this.setData({ savingBackfill: true }); try { await api.saveBackfill(values); api.track('backfill_save', { hasLeads: Boolean(values.leads), hasConsults: Boolean(values.consults), hasDeals: Boolean(values.deals) }); this._backfill = {}; await this.loadCore({ force: true }); wx.showToast({ title: '今日经营结果已记录', icon: 'none' }); } catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '经营结果保存失败' }); } finally { this.setData({ savingBackfill: false }); } },
  _sheet(open) { store.setOverlay(open, 'execution-review'); this._reviewInputAnchor = ''; this.setData({ reviewOpen: open, reviewKeyboardHeight: 0, reviewAnchor: '' }); },
  openReview() { if (this.requireLogin()) { this._sheet(true); if (this.data.reviewStatus !== 'ready') this.loadReviewDetails(); } }, closeReview() { try { wx.hideKeyboard(); } catch (_) { /* noop */ } this._sheet(false); }, stop() {},
  focusReviewInput(event) { const anchor = String(event.currentTarget.dataset.anchor || ''); if (!anchor) return; this._reviewInputAnchor = anchor; this.setData({ reviewAnchor: '' }, () => this.setData({ reviewAnchor: anchor })); },
  onReviewKeyboard(event) { const height = Math.max(0, Number(event.detail && event.detail.height) || 0); const patch = { reviewKeyboardHeight: height }; if (height && this._reviewInputAnchor) patch.reviewAnchor = this._reviewInputAnchor; this.setData(patch); },
  onHide() { if (this._pouchObserver) { this._pouchObserver.disconnect(); this._pouchObserver = null; } if (this.data.reviewOpen) this._sheet(false); if (this.data.goalEdit) this.closeGoalEdit(); }, onUnload() { if (this._pouchObserver) { this._pouchObserver.disconnect(); this._pouchObserver = null; } if (this.data.reviewOpen) this._sheet(false); if (this.data.goalEdit) this.closeGoalEdit(); },
  chooseForce(event) { const kind = event.currentTarget.dataset.kind; const verdict = event.currentTarget.dataset.verdict; if (!kind || !verdict) return; this._forceVerdicts[kind] = verdict; this.setData({ battleForces: this.data.battleForces.map((item) => Object.assign({}, item, { verdict: item.kind === kind ? verdict : item.verdict })) }); },
  async verifyDecision(event) { if (!this.data.pendingDecision || this.data.verifying) return; const outcome = event.currentTarget.dataset.outcome; this.setData({ verifying: true }); try { await api.verifyDecision(this.data.pendingDecision.id, outcome); this.setData({ pendingDecision: null }); wx.showToast({ title: outcome === 'correct' ? '已记为判断正确' : '已记为需修正', icon: 'none' }); } catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '记录失败' }); } finally { this.setData({ verifying: false }); } },
  startBizEdit() { this.setData({ bizEditing: true }); }, inputBiz(event) { this._bizDraft[event.currentTarget.dataset.key] = event.detail.value; },
  async saveBiz() { if (this.data.savingBiz) return; const metrics = {}; for (const item of this.data.bizItems) { const raw = String(this._bizDraft[item.key] == null ? '' : this._bizDraft[item.key]).trim(); const value = Number(raw); if (raw && Number.isFinite(value)) metrics[item.key] = value; } this.setData({ savingBiz: true }); try { await api.saveBizMetrics(thisMonday(), metrics); const saved = Object.keys(metrics).length > 0; this.setData({ bizItems: this.data.bizItems.map((item) => Object.assign({}, item, { value: metrics[item.key] == null ? '' : String(metrics[item.key]) })), bizSaved: saved, bizEditing: false }); wx.showToast({ title: saved ? '本周关键指标已记录' : '已清空本周指标', icon: 'none' }); } catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '保存失败，请重试' }); } finally { this.setData({ savingBiz: false }); } },
  openGoalEdit(event) { if (!this.data.hasDossier) { wx.showToast({ title: '先和军师定下一份方案，生成案卷', icon: 'none' }); return; } const field = String(event.currentTarget.dataset.field || ''); const row = this.data.goalRows.find((item) => item.field === field); if (!row) return; this._goalDraft = row.value; store.setOverlay(true, 'execution-goal'); this.setData({ goalEdit: { field, label: row.label }, goalDraft: row.value }); },
  closeGoalEdit() { this._goalDraft = ''; store.setOverlay(false, 'execution-goal'); this.setData({ goalEdit: null, goalDraft: '' }); }, inputGoal(event) { this._goalDraft = String(event.detail.value || '').slice(0, 200); },
  async saveGoal() { const edit = this.data.goalEdit; if (!edit || this.data.savingGoal) return; this.setData({ savingGoal: true }); try { await api.saveGoals({ [edit.field]: String(this._goalDraft || '').trim() }); this.closeGoalEdit(); await this.loadCore({ force: true }); wx.showToast({ title: '目标已保存', icon: 'none' }); } catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '目标保存失败' }); } finally { this.setData({ savingGoal: false }); } },
  openReminders() { navTo('/packages/work/reminders/index'); }, openDaily() { navTo('/packages/work/daily/index'); }, openLedger() { navTo('/packages/work/ledger/index'); },
  async reviewToday() { if (!this.requireLogin()) return; const checks = this.data.battleForces.filter((item) => this._forceVerdicts[item.kind]).map((item) => `${item.label}：今天${this._forceVerdicts[item.kind] === 'on' ? '符合主线' : '偏离主线'}（打法：${item.tactic}）`); const prompt = ['根据我今天完成的军令和数据回填，带我做一次经营复盘。', checks.length ? `三势自评：\n${checks.join('\n')}` : ''].filter(Boolean).join('\n'); try { await api.reviewCasefile('day'); api.track('review_start', { forceChecks: checks.length }); this._forceVerdicts = {}; this._sheet(false); navTo('/packages/main/chat/index?agentKey=general&continue=1&send=' + encodeURIComponent(prompt)); } catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '复盘没有开始' }); } },
}));
