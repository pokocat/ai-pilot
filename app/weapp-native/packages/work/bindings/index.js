const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { navTo } = require('../../../services/nav');

const DATA_BINDINGS = [
  { id: 'qcc', icon: 'shield', title: '企业工商数据', provider: '企查查类企业档案', status: '可开通', price: '单独开通', desc: '同步工商、股东、风险、司法、知识产权等外部事实。' },
  { id: 'shop', icon: 'grid', title: '店铺经营数据', provider: '淘宝 / 抖店 / 小红书店铺', status: '待绑定', price: '数据增强', desc: '分析流量、转化、客单价、复购、商品和活动表现。' },
  { id: 'content', icon: 'image', title: '内容账号数据', provider: '视频号 / 公众号 / 小红书', status: '待绑定', price: '基础可绑', desc: '同步内容表现、粉丝画像、发布时间和互动质量。' },
  { id: 'wechat', icon: 'chat', title: '企业微信与客户池', provider: '企业微信 / 私域 CRM', status: '可开通', price: '方案权益', desc: '辅助判断客户分层、私域活跃、转化跟进和服务节奏。' },
  { id: 'finance', icon: 'chart', title: '财务与经营表', provider: 'Excel / 飞书表格 / 财务系统', status: '上传即可', price: '深度分析按次产出', desc: '上传收入、成本、利润和现金流表，生成经营体检。' },
].map((item) => Object.assign({}, item, { actionText: item.status.includes('上传') ? '上传' : item.status }));

Page({
  data: baseData({ items: DATA_BINDINGS, showLogin: false }),
  onLoad() { if (!store.isAuthed()) this.setData({ showLogin: true }); },
  onShow() { this.setData({ themeClass: store.snapshot().themeClass }); },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) }); },
  closeLogin() { this.setData({ showLogin: false }); }, loggedIn() { this.setData({ showLogin: false }); },
  tap(event) { const item = DATA_BINDINGS.find((entry) => entry.id === event.currentTarget.dataset.id); if (!item) return; if (!store.isAuthed()) { this.setData({ showLogin: true }); return; } if (item.id === 'finance' || item.status.includes('上传')) navTo('/packages/work/knowledge/index'); else wx.showToast({ title: '数据源授权接入即将开放，可先上传相关资料', icon: 'none' }); },
  askPriority() { if (!store.isAuthed()) { this.setData({ showLogin: true }); return; } const text = '结合我的情况，判断我现在最应该先补充哪类数据或资料，按优先级排一下。'; navTo(`/packages/main/chat/index?agentKey=general&continue=1&send=${encodeURIComponent(text)}`); },
});
