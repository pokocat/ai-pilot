const { api } = require('../../../services/api');
const { navTo } = require('../../../services/nav');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const canvas = require('../gift/canvas');
const { withShare, pathWithCode } = require('../../../services/share');
const birthTime = require('../../../services/birth-time');

const phaseHints = { 进攻: '签约、扩张、上新动作放这几个月', 平稳: '正常推进、练内功、补短板', 防守: '收缩保现金流，不宜重大决策' };

function validDate(calendar, year, month, day) {
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && y % 100 !== 0 || y % 400 === 0;
  const days = calendar === 'lunar' ? 30 : [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return y >= 1930 && y <= new Date().getFullYear() && m >= 1 && m <= 12 && d >= 1 && d <= days;
}

function normalizeChart(chart) {
  if (!chart) return null;
  const nowMonth = new Date().getMonth() + 1;
  const months = ((chart.monthlyOutlook && chart.monthlyOutlook.months) || []).map((month) => ({ ...month, phaseClass: month.phase === '进攻' ? 'atk' : month.phase === '防守' ? 'def' : '', now: month.month === nowMonth }));
  const current = months.find((month) => month.now);
  return { ...chart, months, nowMonth, current, currentHint: current && phaseHints[current.phase] || '', turningMonths: months.filter((month) => month.turning).map((month) => `${month.month}月`).join('、') };
}

function paint(context, width, height, chart) {
  const months = chart.months || []; const year = chart.monthlyOutlook.year;
  context.setFillStyle('#FBFAF6'); context.fillRect(0, 0, width, height);
  const gradient = context.createLinearGradient(0, 0, width, 188); gradient.addColorStop(0, '#1E5A43'); gradient.addColorStop(1, '#123C2C'); context.setFillStyle(gradient); context.fillRect(0, 0, width, 188);
  context.setTextAlign('center'); context.setFillStyle('#D9C48A'); context.setFontSize(22); context.fillText('军师参谋部 · 天势研判', width / 2, 52); context.setFillStyle('#FBFAF6'); context.setFontSize(48); context.fillText(`${year} 年天时日历`, width / 2, 112); context.setFillStyle('rgba(251,250,246,.72)'); context.setFontSize(23); context.fillText(`${chart.pattern.name} · 引擎按你的命盘逐月推演`, width / 2, 154);
  const pad = 40, gap = 14, cellW = (width - pad * 2 - gap * 2) / 3, cellH = 92, top = 218;
  const tones = { 进攻: ['rgba(30,90,67,.12)', '#1E5A43'], 防守: ['rgba(180,140,30,.16)', '#8A6D1F'], 平稳: ['#F0EFEA', '#565C63'] };
  months.forEach((month, index) => { const col = index % 3, row = Math.floor(index / 3), x = pad + col * (cellW + gap), y = top + row * (cellH + gap), tone = tones[month.phase] || tones.平稳; context.setFillStyle(tone[0]); context.fillRect(x, y, cellW, cellH); context.setFillStyle(tone[1]); context.setFontSize(30); context.fillText(`${month.month}月`, x + cellW / 2, y + 42); context.setFontSize(22); context.fillText(`${month.phase}${month.turning ? ' ·拐点' : ''}`, x + cellW / 2, y + 74); });
  context.setTextAlign('left'); context.setFillStyle('#16191D'); context.setFontSize(24); canvas.wrapText(context, `日主 ${chart.dayMaster.gan}${chart.dayMaster.element} · ${chart.dayMaster.strength}${chart.turningMonths ? ` · 拐点在 ${chart.turningMonths}` : ''}`, pad, 690, width - pad * 2, 38); context.setFillStyle('#565C63'); context.setFontSize(22); canvas.wrapText(context, '进攻月宜主动布局，防守月宜收缩练功；重大动作尽量避开拐点月首尾。', pad, 742, width - pad * 2, 36);
  context.setFillStyle('#F1F7F3'); context.fillRect(pad, height - 176, width - pad * 2, 96); context.setTextAlign('center'); context.setFillStyle('#969BA1'); context.setFontSize(21); context.fillText('想要完整的天势 × 战略诊断？', width / 2, height - 136); context.setFillStyle('#1E5A43'); context.setFontSize(28); context.fillText('找军师参谋部', width / 2, height - 102); context.setFillStyle('#B4B8BE'); context.setFontSize(19); context.fillText('命理为文化视角的经营参考，不构成决策依据', width / 2, height - 38);
}

Page(withShare({
  data: baseData({ authed: false, chart: null, loaded: false, disabled: false, calendar: 'solar', year: '', month: '', day: '', timeKnown: false, birthTime: birthTime.DEFAULT_BIRTH_TIME, gender: 'male', place: '', valid: false, busy: false, imgPath: '', showLogin: false }),
  onShow() {
    const authed = store.isAuthed(); this.setData({ authed });
    if (!authed) { this.setData({ loaded: true }); return; }
    store.loadMe().then(() => { const me = store.snapshot().me; const disabled = Boolean(me && me.features && me.features.fortune === false); this.setData({ disabled }); if (!disabled) this.loadChart(); });
  },
  onShareAppMessage() { const chart = this.data.chart; return { title: chart ? `我的 ${chart.monthlyOutlook.year} 年经营节奏表——哪几个月该加力、哪几个月该收着做` : '看看你全年哪几个月适合加力、哪几个月适合收着做', path: pathWithCode('/packages/work/calendar/index') }; },
  back() { if (getCurrentPages().length > 1) wx.navigateBack(); else wx.switchTab({ url: '/pages/home/index', fail: () => wx.reLaunch({ url: '/pages/home/index' }) }); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false, authed: true }); this.loadChart(); },
  login() { this.setData({ showLogin: true }); },
  async loadChart() {
    try { const result = await api.chart(); this.setData({ chart: normalizeChart(result && result.chart), loaded: true }); }
    catch (error) { const code = String(error.code || error.data && error.data.code || ''); if (code === 'FEATURE_DISABLED') this.setData({ disabled: true, chart: null, loaded: true }); else { const kind = store.handleApiError(error, { silent: true }); this.setData({ chart: null, loaded: true, authed: kind !== 'unauthorized', showLogin: kind === 'unauthorized' }); } }
  },
  input(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }); this.refreshValid(); },
  select(event) { const field = event.currentTarget.dataset.field; const value = event.currentTarget.dataset.value; this.setData({ [field]: value }); this.refreshValid(); },
  setTimeKnown(event) { this.setData({ timeKnown: event.currentTarget.dataset.known === '1' }); },
  changeBirthTime(event) { this.setData({ birthTime: event.detail.value }); },
  refreshValid() { setTimeout(() => this.setData({ valid: validDate(this.data.calendar, this.data.year, this.data.month, this.data.day) }), 0); },
  async saveBirth() {
    if (!this.data.valid || this.data.busy) return;
    this.setData({ busy: true }); wx.showLoading({ title: '排盘中…' });
    try {
      const time = birthTime.parts(this.data.timeKnown, this.data.birthTime);
      const result = await api.saveBazi({ calendar: this.data.calendar, year: Number(this.data.year), month: Number(this.data.month), day: Number(this.data.day), hour: time.hour, minute: time.minute, gender: this.data.gender, birthPlace: this.data.place.trim() || undefined });
      if (result.chart) { this.setData({ chart: normalizeChart(result.chart) }); wx.showToast({ title: this.data.place.trim() ? '已按出生钟表时间排盘' : '命盘已生成', icon: 'none' }); } else wx.showToast({ title: '生成失败，请检查生辰', icon: 'none' });
    } catch (error) { const code = String(error.code || error.data && error.data.code || ''); if (code === 'FEATURE_DISABLED') { this.setData({ disabled: true }); wx.showToast({ title: '命理能力已下线', icon: 'none' }); } else if (store.handleApiError(error, { silent: true }) === 'unauthorized') this.setData({ showLogin: true }); else wx.showToast({ title: '排盘失败，请重试', icon: 'none' }); }
    finally { wx.hideLoading(); this.setData({ busy: false }); }
  },
  openMingpan() { navTo('/packages/work/mingpan/index'); },
  async makeImage() {
    if (!this.data.chart || this.data.busy) return;
    this.setData({ busy: true, imgPath: '' }); wx.showLoading({ title: '生成天时日历图…' });
    try { const imgPath = await canvas.render(this, 'tcalCanvas', 600, 940, (context, width, height) => paint(context, width, height, this.data.chart)); this.setData({ imgPath }); wx.showToast({ title: '图已生成 · 存相册或发给朋友', icon: 'none' }); }
    catch (_) { wx.showToast({ title: '生成失败，请重试', icon: 'none' }); }
    finally { wx.hideLoading(); this.setData({ busy: false }); }
  },
  shareImage() { canvas.share(this.data.imgPath); }, saveImage() { canvas.save(this.data.imgPath); },
}, { timeline: true }));
