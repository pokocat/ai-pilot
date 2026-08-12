const { api } = require('../../services/api');
const store = require('../../services/store');
const { navTo } = require('../../services/nav');
const { baseData, syncTabBar } = require('../../services/page');
// mock 数据档案开关（只有 mock 包渲染角标；非 mock 构建下是死代码）。
const mockProfile = require('../../services/mockProfile');

const MENU_GROUPS = [
  { title: '档案', rows: [
    { icon: 'grid', label: '个人 / 企业档案', status: '', action: 'workbench' },
    { icon: 'flow', label: '公司与事业架构', status: '待建立', route: '/packages/work/architecture/index' },
    { icon: 'user', label: '人脉圈与持续记忆', status: '未开通', route: '/packages/work/relations/index' },
    { icon: 'flag', label: '战略账本 · 决策与天机', status: '决策记录', route: '/packages/work/ledger/index' },
  ] },
  { title: '资产', rows: [
    { icon: 'image', label: '锦囊 · 军师替你出的成品', status: '方案 / 海报 / 成片', route: '/pages/pouch/index' },
    { icon: 'spark', label: '我的品牌资产', status: '数字人 / 短视频', route: '/packages/work/brandkit/index' },
    { icon: 'chart', label: '数据授权与隐私', status: '', route: '/packages/work/bindings/index' },
  ] },
  { title: '系统', rows: [
    { icon: 'clock', label: '提醒与日历', status: '', route: '/packages/work/reminders/index' },
    { icon: 'user', label: '设置 · 资料与偏好', status: '', route: '/packages/main/settings/index' },
    // 账单视角的兵器清单：只管「已启用的管理与续费」，不做推荐——分发归军师（兵器条/兵器卡）。
    { icon: 'grid', label: '已启用的兵器 · 管理与续费', status: '', route: '/packages/work/market/index' },
    { icon: 'lock', label: '退出登录', status: '', action: 'logout' },
  ] },
];

const GUEST_GROUPS = [
  { title: '服务', rows: [
    { icon: 'spark', label: '方案与价格', route: '/packages/work/plans/index' },
    { icon: 'grid', label: '军师的手艺 · 锦囊', route: '/pages/pouch/index' },
  ] },
  { title: '规则与隐私', rows: [
    { icon: 'doc', label: '用户协议', route: '/packages/main/legal/index?doc=agreement' },
    { icon: 'lock', label: '隐私政策', route: '/packages/main/legal/index?doc=privacy' },
    { icon: 'user', label: '联系客服', action: 'contact' },
  ] },
];

function maskPhone(phone) {
  const value = String(phone || '');
  return /^1\d{10}$/.test(value) ? `${value.slice(0, 3)}****${value.slice(-4)}` : '未绑定';
}
function maturityPct(value) { return value === 'ready' ? 85 : value === 'forming' ? 55 : 20; }
const TIAN_GAN = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
const DI_ZHI = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];
function ganZhiYear(year) { if (!Number.isFinite(Number(year))) return ''; const y=Number(year); return `${TIAN_GAN[((y-4)%10+10)%10]}${DI_ZHI[((y-4)%12+12)%12]}`; }
function verseLines(value) { const lines=[]; for(const segment of String(value||'').split(/[，,。.；;、！!？?｜|/\s]+/)){const chars=Array.from(segment.trim());if(!chars.length)continue;if(chars.length>8){for(let i=0;i<chars.length;i+=7)lines.push(chars.slice(i,i+7).join(''));}else lines.push(chars.join(''));}return lines.slice(0,4); }
function list(value) { return Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : []); }
function buildMenuGroups(completeness, missingCount, fortuneOn) {
  const groups = MENU_GROUPS.map((group) => ({ title: group.title, rows: group.rows.map((row) => Object.assign({}, row)) }));
  groups[0].rows[0].status = missingCount ? `待补 ${missingCount} 项` : `完整度 ${completeness}%`;
  // 命盘/时运从战局首屏迁出后，唯一常驻入口在这里（战局的三势 sheet 仍有情景入口）。
  if (fortuneOn) groups[0].rows.splice(2, 0,
    { icon: 'trend', label: '命盘报告 · 八字紫微印证', status: '', route: '/packages/work/mingpan/index' },
    { icon: 'clock', label: '天时日历 · 时运节奏', status: '', route: '/packages/work/calendar/index' });
  return groups;
}

Page({
  data: baseData({
    showLogin: false, authed: false, loading: false, sheet: '', name: '老板', nameInitial: '主', company: '你的经营案卷',
    planName: '尚未开通', phoneDisplay: '未绑定', inviteCode: '—', avatarUrl: '', creditBalance: 0, usagePercent: 0,
    counts: [{ value: 0, label: '案卷' }, { value: 0, label: '方案' }, { value: 0, label: '资料' }],
    menuGroups: MENU_GROUPS, guestGroups: GUEST_GROUPS, serviceReady: false, teacherName: '', teacherInitial: '师', teacherWechat: '', teacherNote: '', className: '', groupQrUrl: '',
    completeness: 0, workbenchSections: [], workbenchMissing: [], progress: null, progressDesc: '', progressNext: '', showRank: false,
    fortuneOn: true, verseLines: [], verseSign: '', verseMoment: '', hasVerse: false,
  }),
  onShow() {
    const state = store.snapshot();
    this.setData({ themeClass: state.themeClass, colorKey: state.colorKey, isMock: state.mock, mockProfileLabel: state.mock ? mockProfile.label() : '', authed: state.authed });
    syncTabBar(this, 4);
    this.load();
  },
  async load() {
    if (!store.isAuthed()) { this.setData({ authed: false }); return; }
    this.setData({ loading: true });
    const [meResult, projects, reports, docs, library, progress, strategic, workbench] = await Promise.allSettled([
      store.loadMe(), api.projects(), api.reports(), api.raw('/knowledge/docs'), api.library(), api.progress(), api.strategicProfile(), api.workbench(),
    ]);
    const me = meResult.status === 'fulfilled' ? meResult.value : null;
    const user = me && me.user || {};
    const tenant = me && me.tenant || {};
    const service = me && me.service || null;
    const name = user.name || '老板';
    const wb = workbench.status === 'fulfilled' ? workbench.value : null;
    const completeness = wb ? Number(wb.completeness) || 0 : maturityPct(me && me.understanding && me.understanding.maturity);
    const missing = wb && Array.isArray(wb.missing) ? wb.missing : [];
    const prog = progress.status === 'fulfilled' ? progress.value.progress : null;
    const fortuneOn = !(me && me.features && me.features.fortune === false);
    const strategy = strategic.status === 'fulfilled' ? strategic.value.strategic : null;
    const verse = strategy && String(strategy.verse || '').trim();
    const moments = strategy && Array.isArray(strategy.verseMoments) ? strategy.verseMoments : [];
    const lastMoment = moments.length ? moments[moments.length - 1] : null;
    const docsCount = list(docs.status === 'fulfilled' ? docs.value : []).length;
    const reportCount = list(reports.status === 'fulfilled' ? reports.value : []).length;
    const libraryCount = list(library.status === 'fulfilled' ? library.value : []).length;
    this.setData({
      authed: true, name, nameInitial: name.slice(0, 1) || '主', company: tenant.name || tenant.industry || '你的经营案卷',
      planName: me && me.plan ? me.plan.name : '尚未开通', phoneDisplay: maskPhone(user.phone), inviteCode: me && me.inviteCode || '—',
      avatarUrl: user.avatarUrl || '', creditBalance: Number(me && me.creditBalance) || 0, usagePercent: Number(me && me.usage && me.usage.usagePercent) || 0,
      counts: [
        { value: list(projects.status === 'fulfilled' ? projects.value : []).length, label: '案卷' },
        { value: reportCount + libraryCount, label: '方案' },
        { value: (me && me.understanding && me.understanding.evidenceCount && Number(me.understanding.evidenceCount.knowledge)) || docsCount, label: '资料' },
      ],
      completeness, workbenchSections: wb && wb.sections || [], workbenchMissing: missing,
      progress: prog, progressDesc: prog ? `连续复盘 ${prog.streak} 天 · 使用第 ${prog.usageDays} 天${prog.decisionAccuracy != null ? ` · 决策准确率 ${prog.decisionAccuracy}%` : ' · 先打满 5 个验证'}` : '', progressNext: prog && prog.nextRank ? `下一段位 ${prog.nextRank.rank}：${prog.nextRank.requirement}` : '查看战略账本', showRank: Boolean(prog && (Number(prog.streak) >= 3 || Number(prog.usageDays) >= 14)),
      fortuneOn, hasVerse: Boolean(fortuneOn && verse), verseLines: verseLines(verse), verseSign: strategy && strategy.verseYear ? `${ganZhiYear(strategy.verseYear)}年 · 军师赠` : '军师赠', verseMoment: lastMoment ? `已点谶 ${moments.length} 次 · 最近：${lastMoment.note}` : '岁末逐句对账',
      menuGroups: buildMenuGroups(completeness, missing.length, fortuneOn),
      serviceReady: Boolean(service), teacherName: service && service.teacherName || '', teacherInitial: service && service.teacherName ? service.teacherName.slice(0,1) : '师', teacherWechat: service && service.teacherWechat || '', teacherNote: service && service.note || '', className: service && service.className || '', groupQrUrl: service && service.groupQrUrl || '', loading: false,
    });
  },
  switchMockProfile() {
    mockProfile.switchProfile(() => { this.setData({ mockProfileLabel: mockProfile.label() }); this.load(); });
  },
  login() { this.setData({ showLogin: true }); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false, authed: true }); this.load(); },
  openIdentity() { navTo('/packages/main/settings/index'); },
  openPlans() { navTo('/packages/work/plans/index'); },
  openCommunity() { navTo('/packages/work/community/index'); },
  // 未分配服务也照常开这一层：里面有占位与「先去军师社群」的下一步。
  // 原先直接转跳社群页，等于把「这项服务存在但还没分到人」这句话吞了。
  // 三个 sheet 都是全屏层，必须 setOverlay 让自定义底栏让位——z-index 压不过微信独立
  // custom tabbar 层（AGENTS §7.2）；这层历史上一直漏了，二维码底下压着一排 tab。
  openTeacher() { this._openSheet('teacher'); },
  openGroup() { this._openSheet('group'); },
  _openSheet(key) { store.setOverlay(true, 'profile-sheet'); this.setData({ sheet: key }); },
  closeSheet() { store.setOverlay(false, 'profile-sheet'); this.setData({ sheet: '' }); },
  onHide() { if (this.data.sheet) this.closeSheet(); },
  onUnload() { if (this.data.sheet) this.closeSheet(); },
  stop() {},
  copyWechat() { if (!this.data.teacherWechat) return; wx.setClipboardData({ data: this.data.teacherWechat }); },
  previewGroup() { if (this.data.groupQrUrl) wx.previewImage({ urls: [this.data.groupQrUrl] }); },
  openBrief() { this.closeSheet(); navTo('/packages/main/brief/index'); },
  fillMissing(event) { const item=this.data.workbenchMissing[Number(event.currentTarget.dataset.index)];this.closeSheet();if(!item){wx.switchTab({url:'/pages/thinktank/index'});return;}if(String(item.key||'').startsWith('next-'))navTo('/packages/main/chat/index?agentKey=general&continue=1&send='+encodeURIComponent(item.title||''));else wx.switchTab({url:'/pages/thinktank/index'}); },
  openRoute(event) { navTo(event.currentTarget.dataset.route); },
  tapCount(event) {
    const routes = ['/packages/work/projects/index', '/packages/work/library/index', '/packages/work/knowledge/index'];
    navTo(routes[Number(event.currentTarget.dataset.index)] || routes[0]);
  },
  tapMenu(event) {
    const group = this.data.menuGroups[Number(event.currentTarget.dataset.group)];
    const item = group && group.rows[Number(event.currentTarget.dataset.index)];
    if (!item) return;
    if (item.action === 'logout') { this.logout(); return; }
    if (item.action === 'workbench') { this._openSheet('workbench'); return; }
    navTo(item.route);
  },
  tapGuestMenu(event) {
    const group = this.data.guestGroups[Number(event.currentTarget.dataset.group)];
    const item = group && group.rows[Number(event.currentTarget.dataset.index)];
    if (!item) return;
    if (item.route) navTo(item.route);
  },
  logout() {
    wx.showModal({ title: '退出登录', content: '确定退出当前账号？', success: (result) => {
      if (!result.confirm) return;
      store.resetAuth();
      wx.reLaunch({ url: '/pages/sessions/index' });
    } });
  },
});
