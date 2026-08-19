// 屏 09 · 成片详情。竖屏播放器 + 保存相册 + 一键代发 + 再出一条。
//
// 水印跟随项目 subtitleStyle.aiWatermark；缺省关闭，只有用户主动开启才显示并随成片保留。
//
// 代发平台边界（方案 §11.11）：真正可发只有 抖音 / 快手 / 小红书 / 视频号，
// 其余平台在 aidrama 侧会 501。**产品文案不要承诺「全平台一键发布」。**
const host = require('../host');
const api = require('../api');
const model = require('../model');
const { withShare, pathWithCode } = require('../../../services/share');

const PLATFORMS = [
  { key: 'douyin', label: '抖音' },
  { key: 'kuaishou', label: '快手' },
  { key: 'xiaohongshu', label: '小红书' },
  { key: 'shipinhao', label: '视频号' },
];

/**
 * 平台代发是否真的可用。**当前恒 false，因为上游没实现**（2026-08-17 查实）：
 * AIStar `ClipWorkService.publish()` 里写着 `if (!shiliu.mockMode()) throw 503
 * CLIP_PUBLISH_NOT_CONFIGURED「平台发布能力仍在接入验收中」`，只有石榴 mock 模式才会写一条
 * 假的「Mock 已提交」。而生产是 production profile（禁 forceMock、allowMock 只在非生产生效），
 * `required()` 必定返回真实网关 → `mockMode()` 恒 false → 四个平台按钮在生产上 100% 是 503。
 *
 * 所以这里不再让用户「点 → 确认发布 → 等接口 → 报错」——那是让人先确认一件做不到的事。
 * 改成明说「即将开放」，把能用的那条路（保存到相册，自己发）留在原位。
 * 上游接完平台授权后：把这个常量交给服务端下发的能力位，别再硬编码。
 */
const PUBLISH_READY = false;

Page(withShare({
  data: host.hostBaseData({
    workId: '',
    loading: true,
    work: null,
    durationText: '',
    platforms: PLATFORMS,
    publishReady: PUBLISH_READY,
    saving: false,
    savingCover: false,
    saveProgress: 0,
    publishing: '',
    showLogin: false,
  }),

  /**
   * 转发给朋友。**必须显式声明**：小程序页面不实现 onShareAppMessage 时，微信右上角 ⋯ 菜单里的
   * 「转发给朋友」是**置灰**的——用户看到的就是「转发按钮点不动」（2026-08-17 报障）。
   *
   * path 刻意用快拍入口、**不带 workId**：与 mingpan / quickscan 两页同一条约定。成片是私有资产，
   * 把 `work/index?workId=...` 转出去，对方要么因为不属于他而拿不到（本页无参直接 toast 退回），
   * 要么等于把别人的作品塞给他看。转发卡片的作用是把人带进快拍，不是共享这一条片子。
   */
  onShareAppMessage() {
    const title = String((this.data.work && this.data.work.title) || '').trim();
    return {
      title: title ? `${title} · 军师快拍` : '一分钟出一条能发的短视频 · 军师快拍',
      path: pathWithCode('/packages/video/home/index'),
    };
  },

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
    // 下载走军师同源接口，由 BFF 每次读取作品并刷新上游短签名；不能用详情里的旧 videoUrl
    // 做前置门槛，否则地址缺失/过期时会连下载请求都不发，用户只能看到“地址待接入”。
    if (!work) { host.toast('作品还没加载完成，请稍后重试'); return; }
    if (this.data.saving) return;

    wx.getSetting({
      success: (setting) => {
        if (setting && setting.authSetting && setting.authSetting['scope.writePhotosAlbum'] === false) {
          this.openAlbumSetting();
          return;
        }
        this.downloadAndSave();
      },
      fail: () => this.downloadAndSave(),
    });
  },

  /**
   * 单独保存封面图。
   *
   * 封面在成片里只有 0.04 秒（合成端 COVER_DURATION_SEC，约 1.2 帧）——它是**故意**这么设计的，
   * 用途是当视频第一帧和平台缩略图，不占正片时长。但抖音/视频号取不取第一帧当封面是平台说了算，
   * 用户手上必须有这张图才能在发布时手动设置。以前这一屏只把它当 poster 用，用户拿不到它，
   * 于是「我设了封面，发出去却没有」（2026-08-18 反馈）。
   */
  saveCover() {
    if (!host.requireLogin(this, 'execute')) return;
    const work = this.data.work;
    if (!work || !work.thumbnailUrl) { host.toast('这条片子没有封面图'); return; }
    if (this.data.savingCover) return;
    this.setData({ savingCover: true });
    host.loading('下载封面');
    host.downloadFile(work.thumbnailUrl, {
      success: (res) => {
        if (Number(res.statusCode) !== 200 || !res.tempFilePath) {
          host.hideLoading(); this.setData({ savingCover: false });
          host.toast('封面下载没有完成，请稍后重试');
          return;
        }
        wx.saveImageToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => { host.hideLoading(); this.setData({ savingCover: false }); host.toast('封面已存到相册', 'success'); },
          fail: (error) => {
            host.hideLoading(); this.setData({ savingCover: false });
            const message = String(error && error.errMsg || '');
            // 与 saveToAlbum 同一套：拒过权限只能引导去设置页，不能只 toast 一句失败
            if (/auth|deny|denied|permission|writePhotosAlbum/i.test(message)) { this.openAlbumSetting(); return; }
            if (/cancel/i.test(message)) return;
            host.toast('封面写入相册失败，请检查手机存储空间');
          },
        });
      },
      fail: () => { host.hideLoading(); this.setData({ savingCover: false }); host.toast('封面下载失败，请检查网络后重试'); },
    });
  },

  openAlbumSetting() {
    host.confirm({ title: '需要相册权限', content: '去设置里打开「保存到相册」，回来后再点一次保存。', confirmText: '去设置' })
      .then((ok) => { if (ok) wx.openSetting({}); });
  },

  downloadAndSave() {
    this.setData({ saving: true, saveProgress: 0 });
    host.loading('下载成片');
    const task = host.downloadFile(api.workDownloadUrl(this.data.workId), {
      success: (res) => {
        if (Number(res.statusCode) !== 200 || !res.tempFilePath) {
          host.hideLoading(); this.setData({ saving: false, saveProgress: 0 });
          host.toast(Number(res.statusCode) === 401 ? '登录态已失效，请重新登录后保存' : '成片下载没有完成，请稍后重试');
          return;
        }
        host.loading('写入相册');
        wx.saveVideoToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => { host.hideLoading(); this.setData({ saving: false, saveProgress: 100 }); host.toast('已存到相册', 'success'); },
          fail: (error) => {
            host.hideLoading();
            this.setData({ saving: false, saveProgress: 0 });
            const message = String(error && error.errMsg || '');
            if (/auth|deny|denied|permission|writePhotosAlbum/i.test(message)) {
              this.openAlbumSetting();
              return;
            }
            host.toast(/invalid video|format/i.test(message) ? '成片文件暂时无法识别，请联系运营' : '写入相册失败，请检查手机存储空间');
          },
        });
      },
      fail: (error) => {
        host.hideLoading(); this.setData({ saving: false, saveProgress: 0 });
        const message = String(error && error.errMsg || '');
        host.toast(/domain|合法域名/i.test(message) ? '下载域名配置未生效，请联系运营' : '成片下载失败，请检查网络后重试');
      },
    });
    if (task && typeof task.onProgressUpdate === 'function') task.onProgressUpdate((event) => {
      this.setData({ saveProgress: Math.max(0, Math.min(99, Number(event && event.progress) || 0)) });
    });
  },

  publish(event) {
    const key = String(event.currentTarget.dataset.key || '');
    const platform = PLATFORMS.find((item) => item.key === key);
    // 上游未接入时直接说清楚，不走确认框也不打接口（见 PUBLISH_READY 注释）。
    if (!PUBLISH_READY) { host.toast('平台代发还在接入，先保存到相册自己发'); return; }
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
}));
