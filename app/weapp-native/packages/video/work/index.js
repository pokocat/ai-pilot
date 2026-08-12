// 屏 09 · 成片详情。竖屏播放器 + 保存相册 + 一键代发 + 再出一条。
//
// 水印跟随项目 subtitleStyle.aiWatermark；缺省关闭，只有用户主动开启才显示并随成片保留。
//
// 代发平台边界（方案 §11.11）：真正可发只有 抖音 / 快手 / 小红书 / 视频号，
// 其余平台在 aidrama 侧会 501。**产品文案不要承诺「全平台一键发布」。**
const host = require('../host');
const api = require('../api');
const model = require('../model');

const PLATFORMS = [
  { key: 'douyin', label: '抖音' },
  { key: 'kuaishou', label: '快手' },
  { key: 'xiaohongshu', label: '小红书' },
  { key: 'shipinhao', label: '视频号' },
];

Page({
  data: host.hostBaseData({
    workId: '',
    loading: true,
    work: null,
    durationText: '',
    platforms: PLATFORMS,
    saving: false,
    publishing: '',
    showLogin: false,
  }),

  onLoad(options) {
    const workId = String((options && options.workId) || '');
    if (!workId) { host.toast('缺少作品参数'); host.back(); return; }
    this.setData({ workId });
    api.work(workId)
      .then((work) => this.setData({
        loading: false,
        work,
        durationText: model.formatDuration(work.durationSec),
      }))
      .catch((error) => {
        this.setData({ loading: false });
        host.toast(error && error.message ? error.message : '打开失败');
      });
  },

  /**
   * 保存到相册。
   * ⚠️ 这是本分包相对军师主包的**新增能力面** —— 军师现有代码从没调过
   * wx.saveVideoToPhotosAlbum，需要 scope.writePhotosAlbum 授权，
   * 且用户拒绝过一次后只能引导去设置页开（wx.openSetting）。
   */
  saveToAlbum() {
    if (!host.requireLogin(this, 'execute')) return;
    const work = this.data.work;
    if (!work || !work.videoUrl) { host.toast('成片地址待接入'); return; }
    if (this.data.saving) return;

    this.setData({ saving: true });
    host.loading('保存中');
    wx.downloadFile({
      url: work.videoUrl,
      success: (res) => {
        wx.saveVideoToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => { host.hideLoading(); this.setData({ saving: false }); host.toast('已存到相册', 'success'); },
          fail: (error) => {
            host.hideLoading();
            this.setData({ saving: false });
            if (String(error && error.errMsg || '').indexOf('auth deny') >= 0) {
              host.confirm({ title: '需要相册权限', content: '去设置里打开「保存到相册」就能存了。', confirmText: '去设置' })
                .then((ok) => { if (ok) wx.openSetting({}); });
              return;
            }
            host.toast('保存失败');
          },
        });
      },
      fail: () => { host.hideLoading(); this.setData({ saving: false }); host.toast('下载失败'); },
    });
  },

  publish(event) {
    const key = String(event.currentTarget.dataset.key || '');
    const platform = PLATFORMS.find((item) => item.key === key);
    if (!host.requireLogin(this, 'execute')) return;
    if (!platform || this.data.publishing) return;
    host.confirm({
      title: `发布到${platform.label}`,
      content: this.data.work && this.data.work.aiWatermark
        ? '成片会保留你已开启的「AI 生成」水印，并提交到对应平台。确定继续吗？'
        : '将把这条成片提交到对应平台。确定继续吗？',
      confirmText: '确认发布',
    }).then((ok) => {
      if (!ok) return;
      this.setData({ publishing: key });
      api.publish(this.data.workId, key)
        .then(() => {
          this.setData({ publishing: '' });
          host.toast('已提交平台审核', 'success');
        })
        .catch((error) => {
          this.setData({ publishing: '' });
          host.toast(error && error.message ? error.message : '发布失败');
        });
    });
  },

  again() {
    const work = this.data.work;
    if (!work || !work.projectId) { wx.redirectTo({ url: `${host.ROOT}/home/index` }); return; }
    wx.redirectTo({ url: `${host.ROOT}/script/index?projectId=${encodeURIComponent(work.projectId)}` });
  },

  back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); },
});
