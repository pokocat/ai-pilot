// 屏 03 · 模板详情。竖屏预览 + 结构拆解（哪些句子出镜、哪些配画面）+ 价格 + 开始制作。
//
// 结构拆解是这一屏的说服力来源：用户在建项目**之前**就看懂「出镜少 = 便宜」，
// 到了配画面那屏才不会对价格条感到意外。
const host = require('../host');
const api = require('../api');
const model = require('../model');

Page({
  data: host.hostBaseData({
    templateId: '',
    loading: true,
    template: null,
    durationText: '',
    avatar: null,
    avatarChecked: false,
    creating: false,
    showLogin: false,
  }),

  onLoad(options) {
    const templateId = String((options && options.templateId) || '');
    if (!templateId) { host.toast('缺少模板参数'); host.back(); return; }
    this.setData({ templateId });
    this.loadAvatar();
    api.template(templateId)
      .then((template) => this.setData({
        loading: false,
        template,
        durationText: model.formatDuration(template.estDurationSec),
      }))
      .catch((error) => {
        const builtIn = api.builtInTemplate(templateId);
        if (builtIn) {
          this.setData({
            loading: false,
            template: builtIn,
            durationText: model.formatDuration(builtIn.estDurationSec),
          });
          return;
        }
        this.setData({ loading: false });
        host.toast(error && error.message ? error.message : '打开失败');
      });
  },

  loadAvatar() {
    if (!host.isLoggedIn()) { this.setData({ avatar: null, avatarChecked: false }); return Promise.resolve(null); }
    return api.avatar().catch(() => null).then((avatar) => {
      this.setData({ avatar, avatarChecked: true });
      return avatar;
    });
  },

  start() {
    if (!host.requireLogin(this, 'execute')) return;
    if (!this.data.avatarChecked) {
      this.loadAvatar().then(() => this.start());
      return;
    }
    const avatar = this.data.avatar;
    if (!avatar || avatar.imageStatus !== 'ready') {
      if (avatar && avatar.imageStatus === 'training') {
        host.toast('数字分身还在训练，先看看进度');
        host.go('avatar/index');
      } else {
        host.toast('先创建数字分身，再开始出片');
        host.go('clone/index');
      }
      return;
    }
    if (this.data.creating) return;
    this.setData({ creating: true });
    api.createProject(this.data.templateId)
      .then((project) => {
        this.setData({ creating: false });
        host.go(`script/index?projectId=${encodeURIComponent(project.id)}`);
      })
      .catch((error) => {
        this.setData({ creating: false });
        host.toast(error && error.message ? error.message : '创建失败');
      });
  },

  back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.loadAvatar(); },
});
