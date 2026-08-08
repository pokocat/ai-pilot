const { baseData } = require('../../../services/page');
const { navTo } = require('../../../services/nav');

const triggers = [
  '多个公司与事业同时推进，创始人很难持续记住各主体的真实用途。',
  '登记股权、实际权益、代持安排和职权责可能不完全一致。',
  '财税代办、账号资产、官网和品牌账号分散在不同人员手中。',
].map((text, index) => ({ no: index + 1, text }));

const scopes = [
  ['事业与主体', '事业项目与法律主体的承接关系。'],
  ['权属与控制', '股权、实际控制、代持、董事监事与关键授权。'],
  ['财务与服务', '财务负责人、代账服务、税务状态和经营账号资产。'],
  ['筹建进度', '新公司筹建、取名、注册代办和财税服务进度。'],
].map(([title, desc]) => ({ title, desc }));

const paths = [
  ['整理已有公司', '证照、股权、代持、职权责、财税与账号资产逐项归位。', 'layers'],
  ['筹建新公司 / 新事业', '先确认战略必要性，再决定取名、注册和财税服务。', 'plus'],
].map(([title, desc, icon]) => ({ title, desc, icon }));

Page({
  data: baseData({ triggers, scopes, paths }),
  back() { wx.navigateBack(); },
  askAdvisor() {
    wx.switchTab({
      url: '/pages/sessions/index',
      success: () => wx.showToast({ title: '跟军师说清你有几家主体和几条事业', icon: 'none', duration: 2200 }),
    });
  },
  openEnterprise() { navTo('/packages/work/enterprise/index'); },
});
