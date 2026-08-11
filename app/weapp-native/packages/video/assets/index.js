// 屏 10 · 我的素材库。
//
// 两种进入方式：
//   · 浏览态（从首页进）：看、传、改标签、删。
//   · 挑选态（从「配画面」那屏进，带 pick=1&no=N）：点一张就回填到那一句，自动返回。
const host = require('../host');
const api = require('../api');

Page({
  data: host.hostBaseData({
    loading: true,
    assets: [],
    visible: [],
    tags: [],
    activeTag: '',
    /** 挑选态 */
    picking: false,
    pickNo: 0,
    pickProjectId: '',
    showLogin: false,
  }),

  onLoad(options) {
    const opts = options || {};
    this.setData({
      picking: String(opts.pick || '') === '1',
      pickNo: Number(opts.no || 0),
      pickProjectId: String(opts.projectId || ''),
    });
    this.load();
  },

  load() {
    if (!host.isLoggedIn()) { this.setData({ loading: false }); return; }
    api.assets()
      .then((assets) => {
        const tags = [];
        assets.forEach((item) => { if (item.tag && tags.indexOf(item.tag) < 0) tags.push(item.tag); });
        this.setData({ loading: false, assets, tags });
        this.applyFilter();
      })
      .catch(() => this.setData({ loading: false }));
  },

  applyFilter() {
    const tag = this.data.activeTag;
    this.setData({ visible: tag ? this.data.assets.filter((item) => item.tag === tag) : this.data.assets });
  },

  selectTag(event) {
    const tag = String(event.currentTarget.dataset.tag || '');
    this.setData({ activeTag: tag === this.data.activeTag ? '' : tag });
    this.applyFilter();
  },

  tapAsset(event) {
    const id = String(event.currentTarget.dataset.id || '');
    const asset = this.data.assets.find((item) => item.id === id);
    if (!asset) return;

    if (!this.data.picking) { host.toast('长按可以改标签'); return; }

    // 挑选态：把选中的素材塞回上一页（配画面屏），由它自己写进 segment
    const pages = getCurrentPages();
    const previous = pages[pages.length - 2];
    if (previous && typeof previous.assignAsset === 'function') {
      previous.assignAsset(this.data.pickNo, asset);
    }
    host.back();
  },

  /** 长按改标签（浏览态）。 */
  longPressAsset(event) {
    if (this.data.picking) return;
    const id = String(event.currentTarget.dataset.id || '');
    wx.showActionSheet({
      itemList: ['改标签', '删除'],
      success: (res) => {
        if (res.tapIndex === 0) { this.renameAsset(id); return; }
        this.removeAsset(id);
      },
    });
  },

  renameAsset(id) {
    const asset = this.data.assets.find((item) => item.id === id);
    if (!asset) return;
    host.prompt({ title: '给素材改标签', content: '标签会帮助配画面时优先推荐。', placeholderText: asset.tag || asset.label })
      .then((tag) => {
        if (tag == null) return;
        if (!tag) { host.toast('标签不能为空'); return; }
        return api.updateAsset(id, { label: tag, tag }).then((updated) => {
          this.setData({ assets: this.data.assets.map((item) => (item.id === id ? Object.assign({}, item, updated) : item)) });
          this.rebuildTags();
          this.applyFilter();
          host.toast('标签已更新', 'success');
        });
      })
      .catch((error) => host.toast(error && error.message ? error.message : '更新失败'));
  },

  rebuildTags() {
    const tags = [];
    this.data.assets.forEach((item) => { if (item.tag && tags.indexOf(item.tag) < 0) tags.push(item.tag); });
    this.setData({ tags });
  },

  removeAsset(id) {
    host.confirm({ title: '删除素材', content: '删了之后用过它的成片不受影响，但新片子就选不到了。' })
      .then((ok) => {
        if (!ok) return;
        api.deleteAsset(id)
          .then(() => {
            this.setData({ assets: this.data.assets.filter((item) => item.id !== id) });
            this.applyFilter();
          })
          .catch((error) => host.toast(error && error.message ? error.message : '删除失败'));
      });
  },

  upload() {
    if (!host.requireLogin(this, 'execute')) return;
    host.chooseMedia({
      count: 1,
      mediaType: ['video', 'image'],
      sourceType: ['album', 'camera'],
      maxDuration: 30,
      camera: 'back',
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        host.loading('上传中');
        api.uploadAsset(file.tempFilePath, { kind: file.fileType || 'video' })
          .then((asset) => {
            host.hideLoading();
            this.setData({ assets: [asset].concat(this.data.assets) });
            this.applyFilter();
          })
          .catch((error) => {
            host.hideLoading();
            host.toast(error && error.message ? error.message : '上传失败');
          });
      },
      fail: (error) => {
        if (String(error && error.errMsg || '').indexOf('cancel') >= 0) return;
        host.toast('打开相机/相册失败');
      },
    });
  },

  back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
});
