// 屏 03 · 模板详情。竖屏预览 + 结构拆解（哪些句子出镜、哪些配画面）+ 价格 + 开始制作。
//
// 结构拆解是这一屏的说服力来源：用户在建项目**之前**就看懂「出镜少 = 便宜」，
// 到了配画面那屏才不会对价格条感到意外。
const host = require('../host');
const api = require('../api');
const model = require('../model');
const { withShare } = require('../../../services/share');

function decorateTemplate(template) {
  if (!template) return null;
  const segments = template.scriptSkeleton && Array.isArray(template.scriptSkeleton.segments) ? template.scriptSkeleton.segments : [];
  const summary = segments.length ? model.summarize(segments) : null;
  const tail = segments.find((item) => item.role === model.ROLE.TAIL) || null;
  const durationSec = summary ? summary.totalSec : Number(template.estDurationSec) || 0;
  return Object.assign({}, template, {
    estDurationSec: durationSec,
    tailLabel: template.tailLabel || (tail && tail.text) || '固定收尾片段',
    tailDurationSec: Number(template.tailDurationSec || (tail && tail.durationSec) || 0),
    tailMediaUrl: template.tailVideoUrl || '',
    tailCoverUrl: template.tailPreviewUrl || '',
  });
}

Page(withShare({
  data: host.hostBaseData({
    templateId: '',
    loading: true,
    template: null,
    durationText: '',
    avatar: null,
    avatarChecked: false,
    creating: false,
    tailPreviewOpen: false,
    showLogin: false,
  }),

  onLoad(options) {
    const templateId = String((options && options.templateId) || '');
    if (!templateId) { host.toast('打不开这个模板'); host.back(); return; }
    this.setData({ templateId });
    this.loadAvatar();
    api.template(templateId)
      .then((raw) => { const template = decorateTemplate(raw); this.setData({
        loading: false,
        template,
        durationText: model.formatDuration(template.estDurationSec),
      }); })
      .catch((error) => {
        const builtIn = api.builtInTemplate(templateId);
        if (builtIn) {
          const template = decorateTemplate(builtIn);
          this.setData({
            loading: false,
            template,
            durationText: model.formatDuration(template.estDurationSec),
          });
          return;
        }
        this.setData({ loading: false });
        host.toast(error && error.message ? error.message : '打开失败');
      });
  },

  onUnload() {
    if (this.data.tailPreviewOpen) host.setOverlay(false, 'video-template-tail');
  },

  loadAvatar() {
    if (!host.isLoggedIn()) { this.setData({ avatar: null, avatarChecked: false }); return Promise.resolve(null); }
    return api.avatars().catch(() => []).then((avatars) => {
      const avatar = (Array.isArray(avatars) ? avatars : []).find((item) => item.imageStatus === 'ready') || (avatars && avatars[0]) || null;
      this.setData({ avatar, avatarChecked: true });
      return avatar;
    });
  },

  start() {
    if (!host.requireLogin(this, 'video')) return;
    if (!this.data.avatarChecked) {
      this.loadAvatar().then(() => this.start());
      return;
    }
    const avatar = this.data.avatar;
    if (!avatar || avatar.imageStatus !== 'ready') {
      if (avatar && avatar.imageStatus === 'training') {
        host.toast('数字人还在训练，先看看进度');
        host.go('avatar/index');
      } else {
        host.toast('先创建数字人，再开始出片');
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

  openTailPreview() {
    if (!this.data.template || !this.data.template.tailMediaUrl) { host.toast('这个固定片段暂时没有预览视频'); return; }
    host.setOverlay(true, 'video-template-tail');
    this.setData({ tailPreviewOpen: true });
  },

  closeTailPreview() {
    host.setOverlay(false, 'video-template-tail');
    this.setData({ tailPreviewOpen: false });
  },

  swallow() {},

  back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.loadAvatar(); },
}));
