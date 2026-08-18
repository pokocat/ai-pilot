// 屏 10 · 我的素材库。
//
// 两种进入方式：
//   · 浏览态（从首页进）：看、传、改标签、删。
//   · 挑选态（从「配画面」那屏进，带 pick=1&no=N）：点一张就回填到那一句，自动返回。
const host = require('../host');
const api = require('../api');
const { formatBytes, formatAssetDuration, formatResolution, mediaDimensions } = require('../model');
const { ASSET_LIMITS } = require('../config');
const { withShare } = require('../../../services/share');

Page(withShare({
  data: host.hostBaseData({
    loading: true,
    assets: [],
    visible: [],
    tags: [],
    /** 素材库容量。null = 还没读到，不显示容量条而不是显示 0（读失败 ≠ 没占用）。 */
    storage: null,
    expanding: false,
    activeTag: '',
    /** 挑选态 */
    picking: false,
    pickShotId: '',
    pickProjectId: '',
    previewOpen: false,
    previewAsset: null,
    showLogin: false,
  }),

  onLoad(options) {
    const opts = options || {};
    this.setData({
      picking: String(opts.pick || '') === '1',
      pickShotId: String(opts.shotId || ''),
      pickProjectId: String(opts.projectId || ''),
    });
    this.load();
  },

  onUnload() {
    if (this.data.previewOpen) host.setOverlay(false, 'video-asset-preview');
  },

  load() {
    if (!host.isLoggedIn()) { this.setData({ loading: false }); return; }
    api.assets()
      .then((assets) => {
        const tags = [];
        assets.forEach((item) => { if (item.tag && tags.indexOf(item.tag) < 0) tags.push(item.tag); });
        this.setData({ loading: false, assets: assets.map((item) => this.decorate(item)), tags });
        this.applyFilter();
      })
      .catch(() => this.setData({ loading: false }));
    this.loadStorage();
  },

  /**
   * 容量单独拉：它失败不该让整页素材也看不到。
   *
   * 口径（2026-08-14）：**素材与作品共用一份额度**，所以文案说的是「空间」不是「素材库」。
   * 扩容价来自服务端（运营后台可配），端上不自带常量；价没读到就不显示扩容按钮，
   * 不显示一个编出来的价。
   */
  loadStorage() {
    api.assetStorage()
      .then((storage) => {
        if (!storage || typeof storage.limitBytes !== 'number' || storage.limitBytes <= 0) return;
        const percent = Math.min(100, Math.round((storage.usedBytes / storage.limitBytes) * 100));
        const canExpand = Number(storage.packBytes) > 0 && Number(storage.packs) < Number(storage.maxPacks);
        this.setData({
          storage: Object.assign({}, storage, {
            percent,
            usedText: formatBytes(storage.usedBytes),
            limitText: formatBytes(storage.limitBytes),
            // 90% 起变红：等真正满了才提示，用户已经白拍了一段素材
            nearFull: percent >= 90,
            canExpand,
            expandText: canExpand
              ? `扩容 ${formatBytes(storage.packBytes)} · ${storage.packCredits} 钻石`
              : '',
          }),
        });
      })
      .catch(() => { /* 容量读不到就不显示容量条，不显示 0 —— 读失败不等于没占用 */ });
  },

  /**
   * 买一个扩容包。**先让用户看清要花多少**再确认 —— 花钱的路径不许静默发生。
   * 幂等标识按「当前已购包数」派生：连点两下是同一单，买成之后包数变了才是新的一单。
   */
  expandStorage() {
    const storage = this.data.storage;
    if (!storage || !storage.canExpand || this.data.expanding) return;
    if (!host.requireLogin(this, 'execute')) return;
    host.confirm({
      title: '扩容空间',
      content: `增加 ${formatBytes(storage.packBytes)}，扣 ${storage.packCredits} 钻石。素材和成片共用这份空间。`,
      confirmText: '确认扩容',
    }).then((ok) => {
      if (!ok) return;
      this.setData({ expanding: true });
      api.expandStorage(`storage:${storage.packs || 0}:${Date.now()}`)
        .then(() => { this.setData({ expanding: false }); host.toast('空间已增加'); this.loadStorage(); })
        .catch((error) => {
          this.setData({ expanding: false });
          if (error && error.code === 'INSUFFICIENT_CREDITS') {
            host.confirm({ title: '钻石不够', content: `扩容需要 ${storage.packCredits} 钻石。去充值吗？`, confirmText: '去充值' })
              .then((go) => { if (go) host.goHost('/packages/work/credits/index'); });
            return;
          }
          host.toast(error && error.message ? error.message : '扩容失败');
        });
    });
  },

  decorate(item) {
    return Object.assign({}, item, {
      durationText: item.kind === 'video' ? formatAssetDuration(item.durationSec) : '',
      sizeText: item.bytes ? formatBytes(item.bytes) : '',
      // 空串 = 这条素材没有宽高记录（上传时微信没给，或它早于本次改动入库）。
      // wxml 据此整块不渲染；**不得**回退成 0×0 或「未知分辨率」这类看起来像真值的文案。
      resolutionText: formatResolution(item.width, item.height),
    });
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

    if (!this.data.picking) { this.openPreview(asset); return; }

    // 挑选态：把选中的素材塞回上一页，由配画面屏写进整个 shot 范围。
    const pages = getCurrentPages();
    const previous = pages[pages.length - 2];
    if (previous && typeof previous.assignAsset === 'function') {
      previous.assignAsset(this.data.pickShotId, asset);
    }
    host.back();
  },

  previewAsset(event) {
    const id = String(event.currentTarget.dataset.id || '');
    const asset = this.data.assets.find((item) => item.id === id);
    if (asset) this.openPreview(asset);
  },

  openPreview(asset) {
    const contentUrl = asset && (asset.contentUrl || asset.previewUrl);
    if (!contentUrl) { host.toast('这个素材暂时没有可预览文件'); return; }
    host.setOverlay(true, 'video-asset-preview');
    this.setData({ previewOpen: true, previewAsset: Object.assign({}, asset, { contentUrl }) });
  },

  closePreview() {
    host.setOverlay(false, 'video-asset-preview');
    this.setData({ previewOpen: false, previewAsset: null });
  },

  swallow() {},

  /** 长按改标签（浏览态）。 */
  /** 内置素材不属于用户：长按菜单也不该出现「改标签 / 删除」。 */
  longPressAsset(event) {
    if (this.data.picking) return;
    const id = String(event.currentTarget.dataset.id || '');
    const asset = this.data.assets.find((item) => item.id === id);
    if (asset && asset.preset) { host.toast('这是内置素材，不能改名也不能删除'); return; }
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

  /** 可见的删除入口。长按菜单不好发现，卡片上直接给一个删除按钮。 */
  deleteFromCard(event) {
    const id = String(event.currentTarget.dataset.id || '');
    if (id) this.removeAsset(id);
  },

  removeAsset(id) {
    host.confirm({ title: '删除素材', content: '删了之后用过它的成片不受影响，但新片子就选不到了。' })
      .then((ok) => {
        if (!ok) return;
        api.deleteAsset(id)
          .then(() => {
            this.setData({ assets: this.data.assets.filter((item) => item.id !== id) });
            this.applyFilter();
            this.loadStorage();
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
      // ★ 与克隆采集同一条理由：不写 sizeType 时微信默认取压缩版，b-roll 素材被压过一道后
      //   合进成片就再也补不回来。sizeType 对视频**确实生效**（基础库 2.25.0 起对全量
      //   mediaType 有效，本项目 libVersion 3.16.2），依据见 clone/index.js 的详细注释。
      sizeType: ['original'],
      maxDuration: 30,
      camera: 'back',
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        // 与配画面页同一道闸：超过 100MB 的文件不该先传完再被 BFF 用 413 打回。
        if ((Number(file.size) || 0) > ASSET_LIMITS.maxBytes) {
          host.confirm({
            title: '这条素材太大了',
            content: `它有 ${formatBytes(Number(file.size))}，超过了 ${formatBytes(ASSET_LIMITS.maxBytes)} 的上限。换一段短一点的，或者先在相册里裁剪压缩后再传。`,
            confirmText: '知道了',
            cancelText: '取消',
          });
          return;
        }
        host.loading('上传中');
        // 宽高只在真读到时才带：拿不到就**不传这两个字段**，让服务端保持 null。
        // 传 0 会把「没测到」写成「0 像素」，素材卡从此显示 0×0。
        api.uploadAsset(file.tempFilePath, Object.assign(
          { kind: file.fileType || 'video' },
          mediaDimensions(file),
        ))
          .then((asset) => {
            host.hideLoading();
            this.setData({ assets: [this.decorate(asset)].concat(this.data.assets) });
            this.applyFilter();
            this.loadStorage();
          })
          .catch((error) => {
            host.hideLoading();
            if (error && error.code === 'CLIP_ASSET_QUOTA_EXCEEDED') {
              // 容量满了要给出口：告诉他删什么最省地方，而不是干报一句失败
              host.confirm({
                title: '素材库满了',
                content: '空间不够放这条素材了。删掉一些用不上的旧素材就能继续传。',
                confirmText: '知道了',
                cancelText: '取消',
              });
              this.loadStorage();
              return;
            }
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
}));
