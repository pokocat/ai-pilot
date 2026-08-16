const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { navTo } = require('../../../services/nav');

const CATEGORIES = ['全部', '战略目标', '执行拆解', 'IP 增长', '个人成长', '企业经营', '组织管理', '知识资产', '数据增强'];
const MODULES = [
  { id: 'strategic-goals', icon: 'target', category: '战略目标', title: '3-5 年目标体系', desc: '把长期愿景拆成年度目标、季度战役、月度里程碑和本周动作。', status: '基础可用', tier: 'power', price: '80', priceIcon: true, depth: '深度推演按次产出', placement: '战局', agentKey: 'strat', prompt: '帮我把 3-5 年目标拆成年度目标、季度战役、月度里程碑和本周动作。' },
  { id: 'daily-command', icon: 'check', category: '执行拆解', title: '每日军令与周计划', desc: '方案定了，自动拆成每日任务、提醒、复盘和数据记录。', status: '已启用', tier: 'free', price: '基础版', depth: '自动排程属方案权益', placement: '战局', agentKey: 'general', prompt: '按我们最近定的方案，出今天的军令和本周计划。' },
  { id: 'ip-os', icon: 'image', category: 'IP 增长', title: '创始人 IP 打造', desc: '定位、内容日历、选题库、AI 创作与发布复盘一体化。', status: '基础可用', tier: 'power', price: '60', priceIcon: true, depth: 'AI 创作发布按次产出', placement: '战局 / 图籍', agentKey: 'ip', prompt: '帮我做一份创始人个人 IP 打造方案，从定位到选题库和发布日历。' },
  { id: 'study-map', icon: 'crown', category: '个人成长', title: '年度学习与读书计划', desc: '围绕事业阶段生成学习主题、书单、训练任务和认知复盘。', status: '可添加', tier: 'single', price: '39/次', priceIcon: true, depth: '细化到每日训练需开通', placement: '战局 / 主公', agentKey: 'general', prompt: '围绕我当前的事业阶段，帮我生成一份年度学习与读书计划。' },
  { id: 'enterprise-growth', icon: 'trend', category: '企业经营', title: '企业增长执行图', desc: '围绕获客、转化、复购、客单价和组织协作生成增长动作。', status: '基础可用', tier: 'plan', price: '方案权益', depth: '绑定经营数据后增强', placement: '战局', agentKey: 'growth', prompt: '帮我生成一份企业增长执行图，覆盖获客、转化、复购和客单价。' },
  { id: 'org-management', icon: 'layers', category: '组织管理', title: '组织与人才盘点', desc: '识别组织瓶颈、关键岗位、协作机制和管理节奏。', status: '可添加', tier: 'power', price: '90', priceIcon: true, depth: '深度组织诊断按次产出', placement: '战局', agentKey: 'org', prompt: '帮我做一次组织与人才盘点，找出组织瓶颈和关键岗位缺口。' },
  { id: 'knowledge-base', icon: 'doc', category: '知识资产', title: '客户知识库', desc: '上传资料后由军师自动参考，判断更贴近真实业务。', status: '已启用', tier: 'free', price: '基础版', depth: '多资料交叉分析按次产出', placement: '图籍' },
  { id: 'data-bindings', icon: 'attach', category: '数据增强', title: '数据源绑定', desc: '绑定企业、店铺、内容账号、财务表和 CRM，让诊断从事实出发。', status: '待绑定', tier: 'single', price: '按数据源', depth: '部分数据源需单独开通', placement: '图籍 / 主公' },
].map((item) => Object.assign({}, item, { actionText: item.status === '已启用' ? '使用' : item.agentKey ? '启用' : '了解' }));
const SKILLS = [
  { id: 'forces', icon: 'flow', title: '三势初判', desc: '天势、市势、人势合参，先定局再落子。', status: '默认启用', tier: 'free', cost: '基础诊断', prompt: '用三势判断（天势、市势、人势）帮我重新看一遍当前局势。' },
  { id: 'contradiction', icon: 'shield', title: '矛盾初筛', desc: '识别主要矛盾、次要矛盾和阶段打法。', status: '默认启用', tier: 'free', cost: '基础诊断', prompt: '帮我做一次矛盾分析：现在的主要矛盾是什么，阶段打法应该是什么？' },
  { id: 'mckinsey', icon: 'grid', title: '结构化拆解', desc: 'MECE 拆问题、定指标、排优先级。', status: '基础可用', tier: 'free', cost: '基础版', prompt: '用结构化拆解（MECE）把我当前的问题拆成指标和优先级。' },
  { id: 'trend', icon: 'spark', title: '趋势参照', desc: '用时机、变化、进退辅助做阶段判断。', status: '方案权益', tier: 'plan', cost: '方案权益', prompt: '结合当前时机和趋势，帮我判断该进攻、收缩还是等待。' },
  { id: 'founder-rhythm', icon: 'crown', title: '创始人节奏', desc: '辅助判断创始人优势、压力点和决策节奏。', status: '需补充档案', tier: 'plan', cost: '方案权益', prompt: '基于我的档案，帮我分析我的决策节奏、优势和压力点。' },
  { id: 'shop-funnel', icon: 'chart', title: '增长漏斗诊断', desc: '分析曝光、点击、转化、复购和客单价。', status: '建议绑定数据', tier: 'power', cost: '80', costIcon: true, prompt: '帮我做一次增长漏斗诊断：曝光、点击、转化、复购、客单价，问题出在哪一层？' },
  { id: 'ip-content', icon: 'pen', title: 'IP 内容引擎', desc: '从定位生成选题、脚本、发布计划和复盘。', status: '可用', tier: 'single', cost: '29/次', costIcon: true, prompt: '用 IP 内容引擎：从我的定位出发生成选题、脚本和发布计划。' },
  { id: 'finance-health', icon: 'lock', title: '经营财务体检', desc: '看现金流、利润结构、成本和风险边界。', status: '需上传资料', tier: 'single', cost: '49/次', costIcon: true, prompt: '帮我做一次经营财务体检，看现金流、利润结构和风险边界。' },
];

Page({
  data: baseData({ categories: CATEGORIES, category: '全部', modules: MODULES, skills: SKILLS, prescription: null, busy: false, showLogin: false }),
  onLoad(options) { this._pid = options && options.pid || ''; if (!store.isAuthed()) this.setData({ showLogin: true }); if (this._pid) this.loadPrescription(); },
  onShow() { this.setData({ themeClass: store.snapshot().themeClass }); },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) }); },
  closeLogin() { this.setData({ showLogin: false }); }, loggedIn() { this.setData({ showLogin: false }); if (this._pid) this.loadPrescription(); },
  async loadPrescription() {
    try { const result = await api.prescriptions(); const found = (result.items || []).find((item) => item.id === this._pid) || null; this._rx = found; this.setData({ prescription: found }); if (found) api.prescriptionAction(found.id, 'seen').catch(() => {}); }
    catch (error) { store.handleApiError(error, { silent: true }); }
  },
  chooseCategory(event) { const category = event.currentTarget.dataset.category; this.setData({ category, modules: category === '全部' ? MODULES : MODULES.filter((item) => item.category === category) }); },
  chat(agentKey, prompt) { if (!store.isAuthed()) { this.setData({ showLogin: true }); return; } navTo(`/packages/main/chat/index?agentKey=${encodeURIComponent(agentKey || 'general')}&continue=1&send=${encodeURIComponent(prompt)}`); },
  tapModule(event) { const item = MODULES.find((entry) => entry.id === event.currentTarget.dataset.id); if (!item) return; if (item.id === 'knowledge-base') { navTo('/packages/work/knowledge/index'); return; } if (item.id === 'data-bindings') { navTo('/packages/work/bindings/index'); return; } if (item.agentKey && item.prompt) { this.chat(item.agentKey, item.prompt); return; } wx.showToast({ title: '方案定下后，这项能力会按需启用', icon: 'none' }); },
  tapSkill(event) { const item = SKILLS.find((entry) => entry.id === event.currentTarget.dataset.id); if (item) this.chat('general', item.prompt); },
  askArrange() { this.chat('general', '根据我的情况，帮我判断现在最该启用哪些能力和锦囊，并说明先后顺序。'); },
  activatePrescription() {
    const rx = this._rx; if (!rx || this.data.busy) return;
    const agent = (store.snapshot().agents || []).find((item) => item.key === rx.toolKey);
    if (!agent || agent.billing !== 'unlock' || agent.owned) { this.finishPrescription(); return; }
    wx.showModal({ title: `启用${agent.name || '专项军师'}`, content: '启用后会加入你的工作台，确认继续？', confirmText: '确认启用', success: async (result) => {
      if (!result.confirm) return; this.setData({ busy: true });
      try { await api.purchaseAgent(agent.key, { source: 'prescription', refId: rx.id }); await store.loadAgents(); await this.finishPrescription(); }
      catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '启用失败' }); }
      finally { this.setData({ busy: false }); }
    } });
  },
  async finishPrescription() { const rx = this._rx; if (!rx) return; try { await api.prescriptionAction(rx.id, 'activated'); wx.showToast({ title: '已记为启用', icon: 'none' }); setTimeout(() => wx.navigateBack(), 500); } catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '状态更新失败' }); } },
});
