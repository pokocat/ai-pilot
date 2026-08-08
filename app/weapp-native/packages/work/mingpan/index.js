const { api } = require('../../../services/api');
const { navTo } = require('../../../services/nav');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');

const shichen = [
  ['不确定', null], ['早子 0-1', 0], ['丑 1-3', 2], ['寅 3-5', 4], ['卯 5-7', 6], ['辰 7-9', 8], ['巳 9-11', 10], ['午 11-13', 12], ['未 13-15', 14], ['申 15-17', 16], ['酉 17-19', 18], ['戌 19-21', 20], ['亥 21-23', 22], ['晚子 23-24', 23],
].map(([label, hour], index) => ({ label, hour, index }));
const branchClass = { 巳: 'mp-b-si', 午: 'mp-b-wu', 未: 'mp-b-wei', 申: 'mp-b-shen', 辰: 'mp-b-chen', 酉: 'mp-b-you', 卯: 'mp-b-mao', 戌: 'mp-b-xu', 寅: 'mp-b-yin', 丑: 'mp-b-chou', 子: 'mp-b-zi', 亥: 'mp-b-hai' };
const huaClass = { 禄: 'lu', 权: 'quan', 科: 'ke', 忌: 'ji' };
const sealByColor = { green: '绿', gold: '金', red: '朱', blue: '黛', purple: '绛', iron: '玄' };

function validDate(calendar, year, month, day) {
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && y % 100 !== 0 || y % 400 === 0;
  const days = calendar === 'lunar' ? 30 : [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return y >= 1930 && y <= new Date().getFullYear() && m >= 1 && m <= 12 && d >= 1 && d <= days;
}

function normalizeReport(report) {
  if (!report) return null;
  const pillars = report.bazi.pillars;
  const columns = [['年', pillars.year, false], ['月', pillars.month, false], ['日', pillars.day, true], ['时', pillars.time, false]].map(([label, pillar, day]) => ({ label, pillar, day, hides: pillar ? (pillar.hideGan || []).map((gan, index) => ({ gan, shi: pillar.shiShenZhi && pillar.shiShenZhi[index] || '', key: `${gan}-${index}` })) : [] }));
  const dm = report.bazi.dayMaster;
  const dmMeta = [dm.strengthLevel, dm.strengthScore !== null && dm.strengthScore !== undefined ? `加权 ${Number(dm.strengthScore) > 0 ? '+' : ''}${dm.strengthScore}` : '', dm.confidence ? `置信${dm.confidence}` : ''].filter(Boolean).join(' · ');
  const counts = report.bazi.wuxingCount.counts || {}; const max = Math.max(1, ...['木', '火', '土', '金', '水'].map((key) => Number(counts[key] || 0)));
  const wuxing = ['木', '火', '土', '金', '水'].map((key) => ({ key, count: Number(counts[key] || 0), width: `${Math.round(Number(counts[key] || 0) / max * 100)}%` }));
  const ziwei = report.ziwei ? { ...report.ziwei, palaces: (report.ziwei.palaces || []).map((palace) => ({ ...palace, branchClass: branchClass[palace.branch] || '', className: `${branchClass[palace.branch] || ''} ${palace.isSoul ? 'soul' : ''} ${palace.isBody ? 'body' : ''}`, majors: (palace.majorStars || []).map((star) => ({ ...star, huaClass: huaClass[star.mutagen] || '' })), minorPreview: `${(palace.minorStars || []).slice(0, 4).join(' ')}${(palace.minorStars || []).length > 4 ? '…' : ''}`, decadalText: palace.decadal ? `${palace.decadal.start}-${palace.decadal.end}` : '' })) } : null;
  const yinzheng = report.yinzheng ? { ...report.yinzheng, baziAxis: { ...report.yinzheng.baziAxis, open: false }, ziweiAxis: { ...report.yinzheng.ziweiAxis, open: false }, favorableText: (report.yinzheng.elementCheck.favorable || []).join('、'), sihua: (report.yinzheng.sihua || []).map((item) => ({ ...item, huaClass: huaClass[item.hua] || '' })) } : null;
  return { ...report, columns, dmMeta, wuxing, ziwei, yinzheng, tiaoHouText: report.bazi.tiaoHou && ((report.bazi.tiaoHou.gods || []).length || (report.bazi.tiaoHou.elements || []).length) ? `${(report.bazi.tiaoHou.gods || []).join('、')}${(report.bazi.tiaoHou.elements || []).length ? `（${report.bazi.tiaoHou.elements.join('、')}）` : ''}` : '' };
}

Page({
  data: baseData({ authed: false, report: null, needBazi: false, loaded: false, disabled: false, showForm: false, editing: false, showLogin: false, activePalace: null, shichen, calendar: 'solar', year: '', month: '', day: '', hourIdx: 0, gender: 'male', place: '', valid: false, busy: false, scrollIntoView: '', seal: '绿' }),
  onShow() {
    const snapshot = store.snapshot(); const authed = store.isAuthed(); this.setData({ authed, themeClass: snapshot.themeClass, colorKey: snapshot.colorKey, seal: sealByColor[snapshot.colorKey] || '绿' });
    if (!authed) { this.setData({ loaded: true }); return; }
    store.loadMe().then(() => { const me = store.snapshot().me; const disabled = Boolean(me && me.features && me.features.fortune === false); this.setData({ disabled }); if (!disabled) this.loadReport(); });
  },
  onUnload() { if (typeof store.setOverlay === 'function') store.setOverlay(false, 'mp-palace'); },
  onShareAppMessage() { return { title: '我的命盘报告 · 八字紫微综合印证', path: '/packages/work/mingpan/index' }; },
  back() { if (getCurrentPages().length > 1) wx.navigateBack(); else wx.switchTab({ url: '/pages/profile/index', fail: () => wx.reLaunch({ url: '/pages/profile/index' }) }); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false, authed: true }); this.loadReport(); },
  login() { this.setData({ showLogin: true }); },
  async loadReport() {
    try {
      const result = await api.chartReport();
      if (result && result.needBazi) this.setData({ loaded: true, needBazi: true, report: null, showForm: true });
      else this.setData({ loaded: true, needBazi: false, report: normalizeReport(result), showForm: false, editing: false });
    } catch (error) { const code = String(error.code || error.data && error.data.code || ''); if (code === 'FEATURE_DISABLED') this.setData({ loaded: true, disabled: true, report: null }); else { const kind = store.handleApiError(error, { silent: true }); this.setData({ loaded: true, report: null, authed: kind !== 'unauthorized', showLogin: kind === 'unauthorized' }); } }
  },
  input(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }); this.refreshValid(); },
  select(event) { const field = event.currentTarget.dataset.field; let value = event.currentTarget.dataset.value; if (field === 'hourIdx') value = Number(value); this.setData({ [field]: value }); this.refreshValid(); },
  refreshValid() { setTimeout(() => this.setData({ valid: validDate(this.data.calendar, this.data.year, this.data.month, this.data.day) }), 0); },
  async saveBirth() {
    if (!this.data.valid || this.data.busy) return;
    this.setData({ busy: true }); wx.showLoading({ title: '立盘中…' });
    try {
      const result = await api.saveBazi({ calendar: this.data.calendar, year: Number(this.data.year), month: Number(this.data.month), day: Number(this.data.day), hour: shichen[this.data.hourIdx].hour, gender: this.data.gender, birthPlace: this.data.place.trim() || undefined });
      if (result.chart) { const place = this.data.place.trim(); wx.showToast({ title: !place ? '生辰已录，正在立盘' : result.matchedCity ? `已按${result.matchedCity}校正真太阳时` : `未识别「${place}」，按北京时间排盘`, icon: 'none' }); this.setData({ editing: false }); await this.loadReport(); } else wx.showToast({ title: '立盘未成，请核对生辰', icon: 'none' });
    } catch (error) { const code = String(error.code || error.data && error.data.code || ''); if (code === 'FEATURE_DISABLED') { this.setData({ disabled: true }); wx.showToast({ title: '命理能力已下线', icon: 'none' }); } else if (store.handleApiError(error, { silent: true }) === 'unauthorized') this.setData({ showLogin: true }); else wx.showToast({ title: '立盘失败，请重试', icon: 'none' }); }
    finally { wx.hideLoading(); this.setData({ busy: false }); }
  },
  async openEditBirth() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try { const result = await api.chart(); const bazi = result && result.bazi; if (bazi) { const idx = shichen.findIndex((item) => item.hour === (bazi.hour === undefined ? null : bazi.hour)); this.setData({ calendar: bazi.calendar === 'lunar' ? 'lunar' : 'solar', year: typeof bazi.year === 'number' ? String(bazi.year) : '', month: typeof bazi.month === 'number' ? String(bazi.month) : '', day: typeof bazi.day === 'number' ? String(bazi.day) : '', gender: bazi.gender === 'female' ? 'female' : 'male', place: bazi.birthPlace || '', hourIdx: idx >= 0 ? idx : 0 }); } } catch (_) { /* 空表单仍可编辑 */ }
    this.setData({ busy: false, editing: true, showForm: true, scrollIntoView: '' }); this.refreshValid(); setTimeout(() => this.setData({ scrollIntoView: 'mingpan-birth-form' }), 40);
  },
  closeEditBirth() { this.setData({ showForm: false, editing: false, scrollIntoView: '' }); },
  openGift() { navTo('/packages/work/gift/index'); },
  openPalace(event) { const palace = this.data.report.ziwei.palaces[Number(event.currentTarget.dataset.index)]; if (typeof store.setOverlay === 'function') store.setOverlay(true, 'mp-palace'); this.setData({ activePalace: palace }); },
  closePalace() { if (typeof store.setOverlay === 'function') store.setOverlay(false, 'mp-palace'); this.setData({ activePalace: null }); },
  stop() {},
  toggleBasis(event) { const key = event.currentTarget.dataset.key; this.setData({ [`report.yinzheng.${key}.open`]: !this.data.report.yinzheng[key].open }); },
});
