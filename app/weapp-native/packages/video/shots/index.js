// 第 2 步 · 按语义段配画面。
// 文案句子与画面镜头分层：用户可圈选连续多句共用一个画面，渲染端也按 shot 聚合，不再逐句硬切。
const host = require('../host');
const api = require('../api');
const model = require('../model');
const { ROLE } = model;

const SAVE_DEBOUNCE_MS = 1200;

Page({
  data: host.hostBaseData({
    projectId: '', loading: true, project: null, rows: [],
    totalText: '0:00', avatarSec: 0, credits: 0,
    flash: null, previewOpen: false, rangeOpen: false,
    rangeStart: 0, rangeEnd: 0, rangeRows: [], rangeText: '先点起句，再点止句',
    showLogin: false,
  }),

  onLoad(options) {
    const projectId = String((options && options.projectId) || '');
    if (!projectId) { host.toast('缺少项目参数'); host.back(); return; }
    this.setData({ projectId });
    this.saveTimer = null; this.flashTimer = null; this.load();
  },

  onUnload() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; this.flush(); }
    if (this.flashTimer) clearTimeout(this.flashTimer);
    if (this.data.previewOpen) host.setOverlay(false, 'video-preview');
    if (this.data.rangeOpen) host.setOverlay(false, 'video-shot-range');
  },

  load() {
    api.project(this.data.projectId)
      .then((project) => {
        const normalized = Object.assign({}, project, { shots: model.ensureShots(project.segments, project.shots) });
        this.setData({ loading: false, project: normalized });
        host.writeDraft(this.data.projectId, { project: normalized, step: 2 });
        this.recompute();
      })
      .catch((error) => {
        const draft = host.readDraft(this.data.projectId);
        if (draft && draft.project && Array.isArray(draft.project.segments)) {
          const normalized = Object.assign({}, draft.project, { shots: model.ensureShots(draft.project.segments, draft.project.shots) });
          this.setData({ loading: false, project: normalized });
          this.recompute(); host.toast('网络不稳，已打开本地草稿'); return;
        }
        this.setData({ loading: false });
        host.toast(error && error.message ? error.message : '打开失败');
      });
  },

  recompute() {
    const project = this.data.project;
    if (!project) return;
    const shots = model.ensureShots(project.segments, project.shots);
    const rendered = model.materializeShots(project.segments, shots);
    const estimate = model.estimateCredits(project.segments, shots);
    this.setData({
      project: Object.assign({}, project, { shots }),
      rows: rendered.map((shot) => this.decorate(shot)),
      totalText: model.formatDuration(estimate.summary.totalSec),
      avatarSec: estimate.summary.avatarSec,
      credits: estimate.total,
    });
  },

  decorate(shot) {
    const seconds = model.segmentSeconds(shot);
    const isTail = shot.role === ROLE.TAIL;
    const isAvatar = shot.role === ROLE.AVATAR;
    const count = shot.endNo - shot.startNo + 1;
    const range = count > 1 ? `${String(shot.startNo).padStart(2, '0')}–${String(shot.endNo).padStart(2, '0')}` : String(shot.startNo).padStart(2, '0');
    return Object.assign({}, shot, {
      seconds, sentenceCount: count, multi: count > 1,
      rangeText: `第 ${range} 句`,
      roleClass: isTail ? 'tail' : (isAvatar ? 'avatar' : 'broll'),
      roleLabel: isTail ? '固定片段' : (isAvatar ? '分身出镜' : '配画面'),
      metaText: isTail
        ? `${shot.durationSec} 秒 · 可整段替换`
        : (isAvatar ? `出镜 ${seconds} 秒 · 你的脸和声音`
          : (shot.assetLabel ? `已选：${shot.assetLabel}` : (shot.hint || '还没配画面'))),
      hasAsset: Boolean(shot.assetId), switchable: !isTail,
    });
  },

  toggleRole(event) {
    if (String(event.currentTarget.dataset.switchable) !== 'true') return;
    const id = String(event.currentTarget.dataset.id || '');
    const project = this.data.project;
    const result = model.toggleShotRole(project.segments, project.shots, id);
    if (result.error) { host.toast(result.error); return; }
    this.setData({ project: Object.assign({}, project, { shots: result.shots }) });
    this.recompute(); this.showFlash(id, result.delta); this.scheduleSave();
  },

  showFlash(id, delta) {
    if (!delta) return;
    const row = this.data.rows.find((item) => item.id === id);
    const action = row && row.role === ROLE.AVATAR ? '改成分身出镜' : '改回配画面';
    this.setData({ flash: { text: `${row ? row.rangeText : '这一段'}${action}`, delta: `${delta > 0 ? '+' : ''}${delta}` } });
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.setData({ flash: null }), 3000);
  },

  openRange() {
    const segments = this.data.project.segments.filter((segment) => segment.role !== ROLE.TAIL);
    host.setOverlay(true, 'video-shot-range');
    this.setData({
      rangeOpen: true, rangeStart: 0, rangeEnd: 0, rangeText: '先点起句，再点止句',
      rangeRows: segments.map((segment) => ({ no: segment.no, text: segment.text, selected: false })),
    });
  },

  tapRangeSentence(event) {
    const no = Number(event.currentTarget.dataset.no);
    let start = this.data.rangeStart; let end = this.data.rangeEnd;
    if (!start || (start && end && start !== end)) { start = no; end = no; }
    else { const anchor = start; start = Math.min(anchor, no); end = Math.max(anchor, no); }
    this.setData({
      rangeStart: start, rangeEnd: end,
      rangeText: start === end ? `已选第 ${start} 句，再点一句作为止句` : `将第 ${start}–${end} 句共用一个画面`,
      rangeRows: this.data.rangeRows.map((row) => Object.assign({}, row, { selected: row.no >= start && row.no <= end })),
    });
  },

  applyRange() {
    const project = this.data.project;
    const result = model.mergeShotRange(project.segments, project.shots, this.data.rangeStart, this.data.rangeEnd);
    if (result.error) { host.toast(result.error); return; }
    this.setData({ project: Object.assign({}, project, { shots: result.shots }) });
    this.closeRange(); this.recompute(); this.scheduleSave();
    host.toast('已合成一个画面段', 'success');
  },

  splitShot(event) {
    const id = String(event.currentTarget.dataset.id || '');
    const project = this.data.project;
    const shots = model.splitShot(project.segments, project.shots, id);
    this.setData({ project: Object.assign({}, project, { shots }) });
    this.recompute(); this.scheduleSave();
  },

  closeRange() {
    host.setOverlay(false, 'video-shot-range');
    this.setData({ rangeOpen: false });
  },

  pickAsset(event) {
    const shotId = String(event.currentTarget.dataset.id || '');
    if (!host.requireLogin(this, 'execute')) return;
    wx.showActionSheet({
      itemList: ['拍一段', '从相册选', '我的素材库'],
      success: (res) => {
        if (res.tapIndex === 2) {
          host.go(`assets/index?pick=1&projectId=${encodeURIComponent(this.data.projectId)}&shotId=${encodeURIComponent(shotId)}`); return;
        }
        this.chooseMedia(shotId, res.tapIndex === 0 ? 'camera' : 'album');
      },
    });
  },

  chooseMedia(shotId, sourceType) {
    host.chooseMedia({
      count: 1, mediaType: ['video', 'image'], sourceType: [sourceType], maxDuration: 30, camera: 'back',
      success: (res) => { const file = res.tempFiles && res.tempFiles[0]; if (file) this.uploadAsset(shotId, file); },
      fail: (error) => { if (String(error && error.errMsg || '').indexOf('cancel') < 0) host.toast('打开相机/相册失败'); },
    });
  },

  uploadAsset(shotId, file) {
    host.loading('上传中');
    api.uploadAsset(file.tempFilePath, { shotId, kind: file.fileType || 'video' })
      .then((asset) => { host.hideLoading(); this.assignAsset(shotId, asset); })
      .catch((error) => { host.hideLoading(); host.toast(error && error.message ? error.message : '上传失败'); });
  },

  assignAsset(shotId, asset) {
    const project = this.data.project;
    const shots = project.shots.map((shot) => (shot.id === shotId
      ? Object.assign({}, shot, { assetId: asset.id, assetLabel: asset.label }) : shot));
    this.setData({ project: Object.assign({}, project, { shots }) });
    this.recompute(); this.scheduleSave();
  },

  scheduleSave() {
    host.writeDraft(this.data.projectId, { project: Object.assign({}, this.data.project, { step: 2 }), step: 2 });
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, SAVE_DEBOUNCE_MS);
  },

  flush() {
    const project = this.data.project; if (!project) return;
    api.saveProject(this.data.projectId, { segments: project.segments, shots: project.shots, step: 2 }).catch(() => {});
  },

  prev() { host.back(); },
  next() {
    if (!host.requireLogin(this, 'execute')) return;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.flush(); host.go(`confirm/index?projectId=${encodeURIComponent(this.data.projectId)}`);
  },
  preview() { if (!this.data.rows.length) return; host.setOverlay(true, 'video-preview'); this.setData({ previewOpen: true }); },
  closePreview() { host.setOverlay(false, 'video-preview'); this.setData({ previewOpen: false }); },
  swallow() {}, back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); }, loggedIn() { this.setData({ showLogin: false }); },
});
