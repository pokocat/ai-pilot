const { baseData } = require('../../../services/page');
const { navTo } = require('../../../services/nav');
const store = require('../../../services/store');
const { withShare } = require('../../../services/share');

const steps = [
  ['添加服务老师', '分班完成后这里会出现服务老师微信与班级二维码。'],
  ['发送注册信息', '发送称呼和注册手机号，服务老师确认后邀请入群。'],
  ['进入班级群', '入群后接收班级任务、军师提醒和复盘通知。'],
].map(([title, desc], index) => ({ title, desc, no: index + 1, active: index === 0 }));

Page(withShare({
  data: baseData({ steps, classTitle: '登录后分配班级' }),
  onShow() {
    const snapshot = store.snapshot();
    const name = snapshot.me && snapshot.me.user && snapshot.me.user.name;
    this.setData({ themeClass: snapshot.themeClass, colorKey: snapshot.colorKey, classTitle: name ? `${name} · 待分班` : '登录后分配班级' });
  },
  back() { wx.navigateBack(); },
  openBrief() { navTo('/packages/main/brief/index'); },
  openCouncil() { wx.switchTab({ url: '/pages/sessions/index' }); },
}));
