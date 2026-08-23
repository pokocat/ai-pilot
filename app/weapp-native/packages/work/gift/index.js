const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const canvas = require('./canvas');
const { withShare } = require('../../../services/share');
const birthTime = require('../../../services/birth-time');


function validDate(calendar, year, month, day) {
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && y % 100 !== 0 || y % 400 === 0;
  const days = calendar === 'lunar' ? 30 : [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return y >= 1930 && y <= new Date().getFullYear() && m >= 1 && m <= 12 && d >= 1 && d <= days;
}

function paint(context, width, height, content) {
  const subtitle = content.subtitle || content.title || '为朋友定制的经营天机速写';
  const sketch = content.sketch || content.summary || (content.lines || [])[0] || '看清自己的节奏，先做好眼前这一件事。';
  const trend = content.trend || (content.lines || [])[1] || '今年宜稳中求进，先聚焦，再放大。';
  const advice = content.advice || (content.lines || [])[2] || '守正、聚焦、徐进。';
  context.setFillStyle('#FBFAF6'); context.fillRect(0, 0, width, height);
  const gradient = context.createLinearGradient(0, 0, width, 210); gradient.addColorStop(0, '#16191D'); gradient.addColorStop(1, '#2A2333'); context.setFillStyle(gradient); context.fillRect(0, 0, width, 210);
  context.setTextAlign('center'); context.setFillStyle('#C9A227'); context.setFontSize(22); context.fillText('军师参谋部 · 天机速写', width / 2, 56);
  context.setFillStyle('#FBFAF6'); context.setFontSize(52); context.fillText('天命速写', width / 2, 122); context.setFillStyle('rgba(251,250,246,.72)'); context.setFontSize(24); context.fillText(subtitle, width / 2, 168);
  context.setTextAlign('left'); let y = 266; const x = 48, max = width - 96;
  const section = (label, body, green) => { context.setFillStyle(green ? '#1E5A43' : '#8A6D1F'); context.setFontSize(22); context.fillText(label, x, y); y += 38; context.setFillStyle(green ? '#1E5A43' : '#16191D'); context.setFontSize(28); y = canvas.wrapText(context, body, x, y, max, 42) + 24; };
  section('命 格 速 写', sketch); section('今 年 大 势', trend); section('一 条 建 议', `「${advice}」`, true);
  context.setFillStyle('#F1F7F3'); context.fillRect(x, height - 210, max, 108); context.setTextAlign('center'); context.setFillStyle('#969BA1'); context.setFontSize(22); context.fillText('想要完整的天势 × 战略诊断？', width / 2, height - 164); context.setFillStyle('#1E5A43'); context.setFontSize(30); context.fillText('找军师参谋部', width / 2, height - 126); context.setFillStyle('#B4B8BE'); context.setFontSize(20); context.fillText('命理为文化视角的经营参考，不构成决策依据', width / 2, height - 44);
}

Page(withShare({
  data: baseData({ name: '', calendar: 'solar', year: '', month: '', day: '', timeKnown: false, birthTime: birthTime.DEFAULT_BIRTH_TIME, gender: 'male', place: '', consent: false, valid: false, busy: false, imgPath: '', disabled: false, showLogin: false }),
  onLoad() {
    const snapshot = store.snapshot();
    const disabled = Boolean(snapshot.me && snapshot.me.features && snapshot.me.features.fortune === false);
    this.setData({ disabled });
    if (!store.isAuthed()) this.setData({ showLogin: true }); else store.loadMe().then(() => { const me = store.snapshot().me; this.setData({ disabled: Boolean(me && me.features && me.features.fortune === false) }); });
  },
  back() { wx.navigateBack(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); store.loadMe(); },
  input(event) { const field = event.currentTarget.dataset.field; this.setData({ [field]: event.detail.value }); this.refreshValid(); },
  select(event) { const field = event.currentTarget.dataset.field; const value = event.currentTarget.dataset.value; this.setData({ [field]: value }); this.refreshValid(); },
  setTimeKnown(event) { this.setData({ timeKnown: event.currentTarget.dataset.known === '1' }); },
  changeBirthTime(event) { this.setData({ birthTime: event.detail.value }); },
  toggleConsent() { this.setData({ consent: !this.data.consent }); this.refreshValid(); },
  refreshValid() { setTimeout(() => this.setData({ valid: Boolean(String(this.data.name || '').trim() && validDate(this.data.calendar, this.data.year, this.data.month, this.data.day) && this.data.consent) }), 0); },
  async makeCard() {
    if (!this.data.valid || this.data.busy) return;
    if (!store.isAuthed()) { this.setData({ showLogin: true }); return; }
    this.setData({ busy: true, imgPath: '' }); wx.showLoading({ title: '排盘出卡中…' });
    try {
      const time = birthTime.parts(this.data.timeKnown, this.data.birthTime);
      const content = await api.fateCardPreview({ friendName: this.data.name.trim(), friendBazi: { calendar: this.data.calendar, year: Number(this.data.year), month: Number(this.data.month), day: Number(this.data.day), hour: time.hour, minute: time.minute, gender: this.data.gender, birthPlace: this.data.place.trim() || undefined }, consent: true });
      const imgPath = await canvas.render(this, 'fateCanvas', 600, 880, (context, width, height) => paint(context, width, height, content));
      this.setData({ imgPath }); wx.showToast({ title: '卡已生成 · 保存或发给朋友', icon: 'none' });
    } catch (error) {
      const code = String(error.code || error.data && error.data.code || '');
      if (code === 'FEATURE_DISABLED') { this.setData({ disabled: true }); wx.showToast({ title: '命理能力已下线', icon: 'none' }); }
      else if (store.handleApiError(error, { silent: true }) !== 'unauthorized') wx.showToast({ title: '生成失败，请检查生辰后重试', icon: 'none' });
    } finally { wx.hideLoading(); this.setData({ busy: false }); }
  },
  shareImage() { canvas.share(this.data.imgPath); },
  saveImage() { canvas.save(this.data.imgPath); },
}));
