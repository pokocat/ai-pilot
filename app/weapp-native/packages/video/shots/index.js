// 屏 06 · 第 2 步 配画面 —— 全产品最重要的一屏。
//
// 设计约束（来自设计稿标注，不要擅自改）：
//   · 逐句列表，像「填格子」。**禁止做成剪辑软件的轨道界面。**
//   · 「分身出镜」与「配画面」两种行样式要一眼可辨（橙 / 蓝）。
//   · 顶部价格条常驻，切一句就跳一次数字 —— 让「出镜时长 = 成本」变成手感。
//   · 结尾行标注「固定片段」，不可切换，但可整段替换。
const host = require('../host');
const api = require('../api');
const model = require('../model');
const { ROLE } = model;

/** 草稿防抖保存间隔：用户连点标签时不该每次都打服务端。 */
const SAVE_DEBOUNCE_MS = 1200;

Page({
  data: host.hostBaseData({
    projectId: '',
    loading: true,
    project: null,
    rows: [],
    totalText: '0:00',
    avatarSec: 0,
    credits: 0,
    /** 刚刚发生的积分变化，用于顶部「+8 刚把第 9 句改成分身出镜」的即时反馈 */
    flash: null,
    previewOpen: false,
    showLogin: false,
  }),

  onLoad(options) {
    const projectId = String((options && options.projectId) || '');
    if (!projectId) { host.toast('缺少项目参数'); host.back(); return; }
    this.setData({ projectId });
    this.saveTimer = null;
    this.flashTimer = null;
    this.load();
  },

  onUnload() {
    // 页面退出前把未落盘的改动冲掉，否则用户返回上一页再进来会看到旧状态
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; this.flush(); }
    if (this.flashTimer) clearTimeout(this.flashTimer);
    if (this.data.previewOpen) host.setOverlay(false, 'video-preview');
  },

  load() {
    api.project(this.data.projectId)
      .then((project) => {
        this.setData({ loading: false, project });
        host.writeDraft(this.data.projectId, { project, step: 2 });
        this.recompute(project.segments);
      })
      .catch((error) => {
        const draft = host.readDraft(this.data.projectId);
        if (draft && draft.project && Array.isArray(draft.project.segments)) {
          this.setData({ loading: false, project: draft.project });
          this.recompute(draft.project.segments);
          host.toast('网络不稳，已打开本地草稿');
          return;
        }
        this.setData({ loading: false });
        host.toast(error && error.message ? error.message : '打开失败');
      });
  },

  /** 单一数据源：segments 变了就整体重算派生态，避免多处各算各的算漏。 */
  recompute(segments) {
    const estimate = model.estimateCredits(segments);
    const summary = estimate.summary;
    this.setData({
      rows: segments.map((segment) => this.decorate(segment)),
      totalText: model.formatDuration(summary.totalSec),
      avatarSec: summary.avatarSec,
      credits: estimate.total,
    });
  },

  /** 一行的展示态。把判断塞进 js，wxml 里只做渲染（wxml 表达式能力弱，塞逻辑容易出错）。 */
  decorate(segment) {
    const seconds = model.segmentSeconds(segment);
    const isTail = segment.role === ROLE.TAIL;
    const isAvatar = segment.role === ROLE.AVATAR;
    return Object.assign({}, segment, {
      seconds,
      noText: String(segment.no).padStart(2, '0'),
      roleClass: isTail ? 'tail' : (isAvatar ? 'avatar' : 'broll'),
      roleLabel: isTail ? '固定片段' : (isAvatar ? '分身出镜' : '配画面'),
      // 出镜行显示「出镜 5 秒 · 你的脸和声音」；配画面行显示已选素材或建议提示
      metaText: isTail
        ? `${segment.durationSec} 秒 · 可整段替换`
        : (isAvatar
          ? `出镜 ${seconds} 秒 · 你的脸和声音`
          : (segment.assetLabel ? `已选：${segment.assetLabel}` : (segment.hint || '还没配画面'))),
      hasAsset: Boolean(segment.assetId),
      switchable: !isTail,
    });
  },

  /* ── 切换角色 ── */

  toggleRole(event) {
    const no = Number(event.currentTarget.dataset.no);
    if (String(event.currentTarget.dataset.switchable) !== 'true') return;
    const project = this.data.project;
    if (!project) return;

    const result = model.toggleRole(project.segments, no);
    if (result.error) { host.toast(result.error); return; }
    const next = Object.assign({}, project, { segments: result.segments });
    this.setData({ project: next });
    this.recompute(result.segments);
    this.showFlash(no, result.delta);
    this.scheduleSave();
  },

  /** 顶部的积分变化提示，3 秒后自动消失。 */
  showFlash(no, delta) {
    if (!delta) return;
    const sign = delta > 0 ? '+' : '';
    const segment = this.data.project.segments.find((item) => item.no === no);
    const action = segment && segment.role === ROLE.AVATAR ? '改成分身出镜' : '改回配画面';
    this.setData({ flash: { text: `刚把第 ${no} 句${action}`, delta: `${sign}${delta}` } });
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.setData({ flash: null }), 3000);
  },

  /* ── 配画面 ── */

  pickAsset(event) {
    const no = Number(event.currentTarget.dataset.no);
    if (!host.requireLogin(this, 'execute')) return;
    wx.showActionSheet({
      itemList: ['拍一段', '从相册选', '我的素材库'],
      success: (res) => {
        if (res.tapIndex === 2) {
          host.go(`assets/index?pick=1&projectId=${encodeURIComponent(this.data.projectId)}&no=${no}`);
          return;
        }
        this.chooseMedia(no, res.tapIndex === 0 ? 'camera' : 'album');
      },
    });
  },

  /**
   * 拍摄 / 相册选素材。
   * ⚠️ 军师主包已在对话、设置与海报图片选择中使用 wx.chooseMedia；本分包新增的是
   * `mediaType: ['video', 'image']` 的视频路径。相机/相册、权限拒绝与恢复仍需双端真机各验一次。
   */
  chooseMedia(no, sourceType) {
    host.chooseMedia({
      count: 1,
      mediaType: ['video', 'image'],
      sourceType: [sourceType],
      maxDuration: 30,
      camera: 'back',
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        this.uploadAsset(no, file);
      },
      fail: (error) => {
        // 用户主动取消不报错
        if (String(error && error.errMsg || '').indexOf('cancel') >= 0) return;
        host.toast('打开相机/相册失败');
      },
    });
  },

  uploadAsset(no, file) {
    host.loading('上传中');
    api.uploadAsset(file.tempFilePath, { no, kind: file.fileType || 'video' })
      .then((asset) => {
        host.hideLoading();
        this.assignAsset(no, asset);
      })
      .catch((error) => {
        host.hideLoading();
        host.toast(error && error.message ? error.message : '上传失败');
      });
  },

  assignAsset(no, asset) {
    const project = this.data.project;
    const segments = project.segments.map((segment) => (segment.no === no
      ? Object.assign({}, segment, { assetId: asset.id, assetLabel: asset.label })
      : segment));
    this.setData({ project: Object.assign({}, project, { segments }) });
    this.recompute(segments);
    this.scheduleSave();
  },

  /* ── 草稿保存 ── */

  scheduleSave() {
    host.writeDraft(this.data.projectId, {
      project: Object.assign({}, this.data.project, { step: 2 }),
      step: 2,
    });
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, SAVE_DEBOUNCE_MS);
  },

  flush() {
    const project = this.data.project;
    if (!project) return;
    api.saveProject(this.data.projectId, { segments: project.segments, step: 2 }).catch(() => {
      // 保存失败不打断操作：本地草稿已经写过，下次进来还在
    });
  },

  /* ── 导航 ── */

  prev() { host.back(); },

  next() {
    if (!host.requireLogin(this, 'execute')) return;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.flush();
    host.go(`confirm/index?projectId=${encodeURIComponent(this.data.projectId)}`);
  },

  preview() {
    if (!this.data.project || !this.data.rows.length) return;
    host.setOverlay(true, 'video-preview');
    this.setData({ previewOpen: true });
  },

  closePreview() {
    host.setOverlay(false, 'video-preview');
    this.setData({ previewOpen: false });
  },

  swallow() {},

  back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); },
});
