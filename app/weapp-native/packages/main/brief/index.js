const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { navTo } = require('../../../services/nav');
const { withShare } = require('../../../services/share');

const CATEGORIES = [
  { key: 'founder', title: '创始人 · 你这个人', sub: '创业故事 · 背景 · 性格 · 决策风格 · 天赋与短板', icon: 'insight', tone: 'purple', tint: '#EEEDFE' },
  { key: 'company', title: '企业 · 你的生意', sub: '发展历程 · 行业 · 阶段 · 团队 · 业务模式', icon: 'layers', tone: 'green', tint: '#E1F5EE' },
  { key: 'status', title: '现状 · 眼下的经营', sub: '当前经营数据 · 主要痛点 · 卡点', icon: 'trend', tone: 'gold', tint: '#FAEEDA' },
  { key: 'vision', title: '目标愿景 · 你想做成的事', sub: '抱负 · 长期目标 · 使命', icon: 'target', tone: 'red', tint: '#FBEAF0' },
  { key: 'strategy', title: '战略 · 打法共识', sub: '主要矛盾 · 定位 · 主攻赛道 · 当前策略', icon: 'shield', tone: 'red', tint: '#FAECE7' },
  { key: 'rapport', title: '陪跑 · 相处之道', sub: '沟通偏好 · 忌讳 · 反馈 · 约定', icon: 'spark', tone: 'blue', tint: '#E6F1FB' },
];
const FILL_LABEL = { unknown: '待补', thin: '部分', known: '较全', settled: '已确认' };

function maturityLabel(value) {
  if (value === 'ready') return '可用于咨询';
  if (value === 'forming') return '正在整理';
  return '待补资料';
}

function evidenceLine(value) {
  const count = (value && value.evidenceCount) || {};
  const parts = [count.profile ? '档案 1' : '', count.memories ? `线索 ${count.memories}` : '', count.projects ? `案卷 ${count.projects}` : '', count.knowledge ? `资料 ${count.knowledge}` : '', count.sessions ? `对话 ${count.sessions}` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : '还没有资料';
}

function mapLibrary(value) {
  const groups = (value && value.groups) || [];
  return CATEGORIES.map((category) => {
    const group = groups.find((item) => item.category === category.key) || {};
    return Object.assign({}, category, {
      fillLabel: FILL_LABEL[group.fill || 'unknown'],
      entries: (group.entries || []).map((entry) => Object.assign({}, entry, { removable: !String(entry.id || '').startsWith('sp-') })),
    });
  });
}

Page(withShare({
  data: baseData({
    loading: true, failed: false, showLogin: false, understanding: null,
    memoryTotal: 0, memoryGroups: [], sections: [], questions: [],
  }),
  onLoad() { this.load(); },
  onShow() { this.setData({ themeClass: store.snapshot().themeClass }); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) }); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
  async load() {
    if (!store.isAuthed()) { this.setData({ loading: false, failed: false, showLogin: true }); return; }
    this.setData({ loading: true, failed: false });
    try {
      const [me, library] = await Promise.all([store.loadMe(), api.raw('/me/memory-library')]);
      const understanding = me && me.understanding;
      this.setData({
        loading: false,
        understanding: understanding ? Object.assign({}, understanding, { maturityLabel: maturityLabel(understanding.maturity), countsLine: evidenceLine(understanding) }) : null,
        memoryTotal: Number(library && library.total) || 0,
        memoryGroups: mapLibrary(library),
        sections: understanding && understanding.sections || [],
        questions: understanding && understanding.nextQuestions || [],
      });
    } catch (error) {
      const kind = store.handleApiError(error, { silent: true });
      this.setData({ loading: false, failed: kind !== 'unauthorized', showLogin: kind === 'unauthorized' });
    }
  },
  retry() { this.load(); },
  removeEntry(event) {
    const id = event.currentTarget.dataset.id;
    if (!id || String(id).startsWith('sp-')) return;
    wx.showModal({
      title: '删掉这条记忆？',
      content: '删掉后军师不再据此判断你的生意，之后的建议可能少一层依据。确定删除？',
      confirmText: '删除', confirmColor: '#9C4A38',
      success: async (result) => {
        if (!result.confirm) return;
        try { await api.raw(`/memories/${encodeURIComponent(id)}`, 'DELETE'); await this.load(); }
        catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '删除失败' }); }
      },
    });
  },
  openDossier() { navTo('/packages/work/dossier/index'); },
  askQuestion(event) { this.startInterview(event.currentTarget.dataset.question || ''); },
  askGeneral() { this.startInterview(''); },
  startInterview(focus) {
    const text = focus
      ? `请进入个人档案访谈模式，围绕「${focus}」只问我一个简单具体的问题。不要先分析，不要引用旧报告，不要替我假设业务事实。`
      : '请进入个人档案访谈模式。不要先分析，不要引用旧报告，不要替我假设业务事实；请先用老板能听懂的话问我 3 个简单具体的问题，帮你补齐行业、阶段和当前难题。';
    navTo(`/packages/main/chat/index?send=${encodeURIComponent(text)}`);
  },
}));
