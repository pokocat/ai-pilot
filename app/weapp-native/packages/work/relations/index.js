const { baseData } = require('../../../services/page');
const { navTo } = require('../../../services/nav');
const store = require('../../../services/store');

const sources = [
  { key: 'wechat', title: '个人微信记忆', desc: '导入你主动选中的微信资料，先生成一版待你校对的记忆。', values: [['人脉档案', '关系、角色、最近互动'], ['每日日志', '事实、承诺、风险'], ['朋友圈档案', '表达、项目、身份变化'], ['战略校准', '确认后回写战局']], scopes: [['好友与群聊', '联系人、组织、关系来源'], ['聊天记录', '决定、承诺、项目、问题'], ['朋友圈资料', '表达、项目动态、线索'], ['附件与链接', '只整理你选中的资料']] },
  { key: 'wecom', title: '企业微信人脉', desc: '整理客户关系、承诺和跟进断点。', values: [['客户分层', '识别关系阶段和需求'], ['会话结论', '提取顾虑与承诺'], ['跟进提醒', '形成下一步动作'], ['成交复盘', '回写咨询和成交断点']], scopes: [['客户资料', '读取授权范围内的客户字段'], ['会话内容', '按企业配置和同意状态读取'], ['客户标签', '识别分层和跟进状态'], ['成交回写', '只生成复盘，不改原后台']] },
  { key: 'meeting', title: '会议记忆', desc: '整理会议结论、负责人和截止时间。', values: [['会议结论', '提炼决定与未决问题'], ['行动事项', '识别负责人和截止时间'], ['关系动态', '更新合作人与项目关系'], ['战略校准', '对照军令判断是否偏航']], scopes: [['会议信息', '主题、时间与参与成员'], ['录音与纪要', '只处理你授权的会议内容'], ['决定与待办', '提取责任人和截止日期'], ['关联案卷', '写入指定案卷，不混入其他公司']] },
  { key: 'calendar', title: '日历与任务', desc: '让计划、提醒和完成情况进入执行线。', values: [['日程', '识别关键会议和时间投入'], ['任务', '归集待办与截止时间'], ['兑现率', '比较计划与实际完成'], ['复盘', '生成次日优先级']], scopes: [['日历标题', '读取业务日程名称'], ['参与人与时间', '识别协作关系和投入'], ['任务状态', '读取完成与延期'], ['提醒', '按军令生成新的提醒建议']] },
  { key: 'moments', title: '朋友圈档案', desc: '整理表达主题、项目进展和个人品牌变化。', values: [['表达主题', '归纳长期观点与阶段重点'], ['项目线索', '记录发布过的产品和合作'], ['关系互动', '识别重要互动与跟进机会'], ['IP 资产', '沉淀可复用的观点和故事']], scopes: [['朋友圈正文', '整理文字内容与发布时间'], ['图片说明', '只识别你主动导入的图片'], ['互动备注', '由你选择是否提供'], ['IP 档案', '确认后写入个人品牌资料']] },
].map((source) => ({
  ...source,
  values: source.values.map(([title, desc]) => ({ title, desc })),
  scopes: source.scopes.map(([title, desc]) => ({ title, desc })),
}));

Page({
  data: baseData({ sources: sources.map((item, index) => ({ ...item, open: index === 0 })), serviceReady: false, teacherName: '' }),
  onShow() {
    const snapshot = store.snapshot();
    const service = snapshot.me && snapshot.me.service;
    this.setData({ themeClass: snapshot.themeClass, colorKey: snapshot.colorKey, serviceReady: Boolean(service), teacherName: service && service.teacherName || '' });
  },
  back() { wx.navigateBack(); },
  toggleSource(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({ sources: this.data.sources.map((item) => ({ ...item, open: item.key === key ? !item.open : false })) });
  },
  openPlans() { navTo('/packages/work/plans/index'); },
  requestImport() {
    if (this.data.serviceReady) navTo('/packages/work/community/index');
    else wx.showToast({ title: '服务老师分配后开放', icon: 'none' });
  },
});
