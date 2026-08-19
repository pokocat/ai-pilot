const { api } = require('../../../services/api');
const { navTo } = require('../../../services/nav');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { withShare, pathWithCode, LANDING } = require('../../../services/share');

Page(withShare({
  data: baseData({ industry: '', revenueBand: '', industryOpts: [], bandOpts: [], painReady: false, result: null, busy: false, prefilled: false, editBasics: false, showLogin: false }),
  onLoad() {
    this._pain = '';
    if (!store.isAuthed()) this.setData({ showLogin: true });
    this.loadBasics();
  },
  // 标题保留成果型（「军师速诊：{主要矛盾}」比通用海报有效），但**落地页必须是统一的公开页**：
  // 本页 onLoad 就 setData({ showLogin: true })，让好友点开落回速诊页 = 第一屏是登录弹层，
  // 既伤转化也踩「游客先浏览、登录门不得前置」的整改口径。要改回本页，先让它的游客态友好。
  onShareAppMessage() { return { title: this.data.result ? `军师速诊：${this.data.result.contradiction}` : '3 个问题，10 分钟拿到你的初诊 · 军师参谋部', path: pathWithCode(LANDING) }; },
  back() { wx.navigateBack(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.loadBasics(); },
  async loadBasics() {
    try {
      const survey = await api.survey();
      const find = (key) => (survey || []).find((item) => item.key === key) || { options: [] };
      this.setData({ industryOpts: find('industry').options || [], bandOpts: find('stage').options || [] });
    } catch (_) { /* 保留空选项并允许重进 */ }
    try {
      const profile = await api.getProfile();
      if (profile && profile.industry && profile.stage) this.setData({ industry: profile.industry, revenueBand: profile.stage, prefilled: true });
    } catch (_) { /* mock 或未建档保持手动选择 */ }
  },
  selectIndustry(event) { this.setData({ industry: event.currentTarget.dataset.value }); },
  selectStage(event) { this.setData({ revenueBand: event.currentTarget.dataset.value }); },
  editBasics() { this.setData({ editBasics: true }); },
  inputPain(event) { this._pain = event.detail.value || ''; this.setData({ painReady: Boolean(this._pain.trim()) }); },
  canSubmit() { return Boolean(this.data.industry && this.data.revenueBand && this._pain.trim() && !this.data.busy); },
  async submit() {
    if (!store.isAuthed()) { this.setData({ showLogin: true }); return; }
    if (!this.canSubmit()) return;
    this.setData({ busy: true });
    try { const result = await api.quickScan({ industry: this.data.industry, revenueBand: this.data.revenueBand, pain: this._pain.trim() }); this.setData({ result }); }
    catch (error) {
      const code = String(error.code || error.data && error.data.code || '');
      if (code === 'RATE_LIMITED') wx.showToast({ title: '今天的速诊次数用完了（每日 3 次），明天再来', icon: 'none' });
      else store.handleApiError(error, { fallbackTitle: error.message || '初诊没有完成' });
    } finally { this.setData({ busy: false }); }
  },
  enterWarRoom() { navTo(`/packages/main/chat/index?agentKey=general&continue=1&send=${encodeURIComponent('我做完速诊了，帮我把主要矛盾展开，进入完整诊断。')}`); },
  again() { this._pain = ''; this.setData({ result: null, painReady: false }); },
}));
