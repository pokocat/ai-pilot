const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { armCoach } = require('../../../services/coach');
const { COLORS, colorByKey } = require('../../../services/colors');

const DEFAULT_SURVEY = [
  { key: 'industry', title: '你的行业？', options: ['SaaS / 软件', '电商 / 跨境', '餐饮 / 食品', '美业 / 医美', '大健康 / 养生', '教育 / 培训', '医疗 / 医药', '制造 / 工业', '专业服务 / 咨询', '本地生活服务', '文旅 / 酒店', '房产 / 家居', '消费 / 零售', '其他'] },
  { key: 'stage', title: '年营收大概在？', options: ['100 万以下', '100-500 万', '500 万-5000 万', '5000 万以上'] },
  { key: 'pain', title: '最头疼的事？', options: ['增长乏力', '现金流', '融资', '组织 / 团队', '定位 / 竞争'] },
];
const LEAD = '我先看看你的案卷，判断眼下的处境……';
const FALLBACK_TODO = '先把最近 7 天的关键数（线索 / 咨询 / 成交）拉齐，军师入局后据此为你定策。';

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}
function isOther(value) { return value === '其他' || value === '其它'; }

Page({
  data: baseData({
    step: 'color', colors: COLORS, currentColor: colorByKey('green'), questions: DEFAULT_SURVEY,
    answers: {}, custom: {}, company: '', surveyDone: false, saving: false,
    typed: '', settled: false, judgeDone: false, mainConflict: '', todoOne: '',
  }),
  onLoad() {
    this._answers = {};
    this._custom = {};
    this._target = '';
    const state = store.snapshot();
    this.setData({ colorKey: state.colorKey, themeClass: state.themeClass, currentColor: colorByKey(state.colorKey) });
    api.survey().then((questions) => {
      if (Array.isArray(questions) && questions.length) this.setData({ questions });
    }).catch(() => {});
    if (store.isAuthed() && !state.onboardingKnown) store.loadMe().then(() => this.guardOnboarded());
    else this.guardOnboarded();
  },
  onShow() { this.guardOnboarded(); },
  onUnload() { this.stopTypewriter(); },
  guardOnboarded() {
    const state = store.snapshot();
    if (this.data.step === 'color' && state.authed && state.onboardingKnown && state.onboarded) {
      wx.switchTab({ url: '/pages/home/index' });
      return true;
    }
    return false;
  },
  leaveOnboarding() {
    this.stopTypewriter();
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/sessions/index' }) });
    else wx.switchTab({ url: '/pages/sessions/index' });
  },
  selectColor(event) {
    const colorKey = event.currentTarget.dataset.key;
    const currentColor = colorByKey(colorKey);
    store.setColor(colorKey, true);
    this.setData({ colorKey, themeClass: `theme-${colorKey}`, currentColor });
  },
  nextColor() { this.setData({ step: 'casefile' }); },
  selectSurveyOption(event) {
    const key = String(event.currentTarget.dataset.key || '');
    const value = String(event.currentTarget.dataset.value || '');
    this._answers = Object.assign({}, this._answers, { [key]: value });
    const answers = Object.assign({}, this._answers);
    this.setData({ answers, surveyDone: this.isSurveyDone(answers, this._custom) });
  },
  inputCustom(event) {
    const key = String(event.currentTarget.dataset.key || '');
    this._custom = Object.assign({}, this._custom, { [key]: event.detail.value });
    const custom = Object.assign({}, this._custom);
    this.setData({ custom, surveyDone: this.isSurveyDone(this._answers, custom) });
  },
  inputCompany(event) { this.setData({ company: event.detail.value }); },
  isSurveyDone(answers, custom) {
    return this.data.questions.length > 0 && this.data.questions.every((question) => {
      const answer = answers[question.key];
      if (!answer) return false;
      return !isOther(answer) || Boolean(String(custom[question.key] || '').trim());
    });
  },
  effectiveAnswers() {
    const result = {};
    for (const question of this.data.questions) {
      const answer = this._answers[question.key];
      if (!answer) continue;
      result[question.key] = isOther(answer) ? String(this._custom[question.key] || '').trim() : answer;
    }
    return result;
  },
  async submitCasefile() {
    if (this.data.saving || !this.data.surveyDone) return;
    const answers = this.effectiveAnswers();
    this.setData({ saving: true });
    try {
      const company = String(this.data.company || '').trim();
      if (company) await api.updateIdentity({ company }).catch(() => {});
      await api.saveProfile(answers);
      await store.loadMe();
      store.completeOnboarding();
      this.setData({ step: 'judge', saving: false, typed: '', settled: false, judgeDone: false, mainConflict: '', todoOne: '' });
      this.runJudge(answers);
    } catch (error) {
      this.setData({ saving: false });
      store.handleApiError(error, { fallbackTitle: '建档未保存，请检查网络后重试' });
    }
  },
  startTypewriter() {
    this.stopTypewriter();
    this._typedTimer = setInterval(() => {
      const current = String(this.data.typed || '');
      const target = String(this._target || '');
      const typed = current.length >= target.length ? current : target.slice(0, current.length + 1);
      const judgeDone = Boolean(this.data.settled && target.length && typed.length >= target.length);
      if (typed !== current || judgeDone !== this.data.judgeDone) this.setData({ typed, judgeDone });
    }, 55);
  },
  stopTypewriter() {
    if (this._typedTimer) clearInterval(this._typedTimer);
    this._typedTimer = null;
  },
  async runJudge(answers) {
    this._target = LEAD;
    this.startTypewriter();
    const industry = answers.industry || '你所在的行业';
    const pain = answers.pain || '眼下的难处';
    const degrade = () => {
      this._target = `${LEAD}\n\n「${industry}」这一行，眼下最吃紧的是「${pain}」。此为初步军情，正式入局后，军师再与你逐条对策。`;
      this.setData({ mainConflict: pain, todoOne: FALLBACK_TODO });
    };
    try {
      const result = await withTimeout(api.quickScan({ industry, revenueBand: answers.stage || '', pain }), 18000);
      const judgement = String(result && result.judgement || '').trim();
      if (judgement) {
        this._target = `${LEAD}\n\n${judgement}`;
        this.setData({
          mainConflict: String(result.contradiction || '').trim() || pain,
          todoOne: String(result.firstMove || '').trim() || FALLBACK_TODO,
        });
      } else degrade();
    } catch (_) { degrade(); }
    this.setData({ settled: true });
  },
  enterHQ() {
    this.stopTypewriter();
    store.completeOnboarding();
    armCoach();
    wx.switchTab({ url: '/pages/sessions/index' });
  },
});
