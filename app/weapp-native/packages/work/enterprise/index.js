const { baseData } = require('../../../services/page');
const { navTo } = require('../../../services/nav');
const store = require('../../../services/store');
const { withShare } = require('../../../services/share');

const services = [
  { key: 'register', title: '注册公司', desc: '确认主体用途后，补齐股东、注册地址、经营范围和负责人资料。', trigger: '战略报告识别到需要独立主体承接新事业或新收入。', steps: ['诊断触发', '资料待补', '服务商报价', '办理回写'], materials: ['股东与出资比例', '注册地址证明', '经营范围草案', '法定代表人信息'], handoff: '服务老师整理资料后对接工商服务商，实际办理结果以主管机关审核为准。', archive: '营业执照、章程、登记信息和服务合同写入资料库的企业资产目录。' },
  { key: 'trademark', title: '商标申请', desc: '承接取名问策结果，先做风险初筛，再确认核心类别和防御类别。', trigger: '品牌名、产品名或 IP 名确定后，需要先占类别再放大传播。', steps: ['名称确认', '类别建议', '代理检索', '申请入云'], materials: ['主推品牌名', '商品 / 服务范围', '营业主体信息', '备用名称'], handoff: '正式检索和申请由商标代理或专业机构承接，不承诺商标一定注册成功。', archive: '申请号、回执、驳回复审记录和商标证书写入企业资产目录。' },
  { key: 'tax', title: '财税代账', desc: '公司成立或经营后，按票据量、开票需求和申报周期匹配代账方案。', trigger: '主体开始开票、发薪或有对公流水，需要稳定的记账与申报节奏。', steps: ['需求确认', '票据预估', '报价方案', '申报提醒'], materials: ['营业执照', '银行与发票情况', '月票据量预估', '历史收支表'], handoff: '记账、申报和财税意见由会计、代账机构或税务专业人员承接，不提供避税承诺。', archive: '代账资料、申报记录、服务合同和经营摘要写入企业资产目录。' },
  { key: 'copyright', title: '版权登记', desc: '脚本、传记、视觉素材、课程文档和软著先形成确权清单。', trigger: '内容资产开始对外分发或授权他人二创。', steps: ['作品归集', '权属确认', '资料提交', '证书入云'], materials: ['作品文件', '创作过程记录', '作者 / 权利人信息', '首次发表证明'], handoff: '登记路径和法律意见由专业机构或律师承接，结果以登记机关或专业意见为准。', archive: '登记证书、软著、授权记录和可二创范围写入企业资产目录。' },
  { key: 'contract', title: '合同授权', desc: '代理、经销商、二创和素材分发前，先明确授权范围和审核机制。', trigger: '出现代理裂变、经销商分销或素材对外授权的执行动作。', steps: ['场景确认', '授权边界', '合同复核', '执行回流'], materials: ['代理名单', '可授权素材', '禁用表达', '分发与分佣规则'], handoff: '合同文本和法律效力建议由律师或专业服务方复核。', archive: '代理合同、素材授权、二创审核记录和分发数据写入企业资产目录。' },
  { key: 'qualification', title: '行业资质', desc: '涉及健康、教育、食品、电商和本地生活时，先列出可能需要的资质。', trigger: '经营范围或销售渠道进入受监管行业。', steps: ['行业识别', '资质提示', '专业咨询', '证照归档'], materials: ['行业与产品说明', '销售渠道', '经营范围', '线下门店情况'], handoff: '具体资质办理和合规意见以主管机关、律师或专业服务方意见为准。', archive: '许可证、备案、资质提醒和有效期记录写入企业资产目录。' },
].map((item) => ({ ...item, steps: item.steps.map((text, index) => ({ text, last: index === item.steps.length - 1 })), materials: item.materials.map((text, index) => ({ text, no: index + 1 })), open: false }));

Page(withShare({
  data: baseData({ services, teacherName: '' }),
  onShow() {
    const snapshot = store.snapshot();
    const service = snapshot.me && snapshot.me.service;
    this.setData({ themeClass: snapshot.themeClass, colorKey: snapshot.colorKey, teacherName: service && service.teacherName || '' });
  },
  back() { wx.navigateBack(); },
  toggleService(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({ services: this.data.services.map((item) => ({ ...item, open: item.key === key ? !item.open : false })) });
  },
  openKnowledge() { navTo('/packages/work/knowledge/index'); },
  askAdvisor() { wx.switchTab({ url: '/pages/sessions/index' }); },
  openCommunity() { navTo('/packages/work/community/index'); },
  reserve() { wx.showToast({ title: '已记录企业版意向', icon: 'none' }); },
}));
