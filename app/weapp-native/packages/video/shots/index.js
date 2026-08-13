// 第 2 步 · 按语义段配画面。
// 文案句子与画面镜头分层：用户可圈选连续多句共用一个画面，渲染端也按 shot 聚合，不再逐句硬切。
const host = require('../host');
const api = require('../api');
const model = require('../model');
const { ROLE } = model;

const SAVE_DEBOUNCE_MS = 1200;

function rangeSelectionState(rows) {
  const selected = (Array.isArray(rows) ? rows : []).filter((row) => row.selected).map((row) => row.no);
  const contiguous = selected.every((no, index) => index === 0 || no === selected[index - 1] + 1);
  return {
    count: selected.length,
    invalid: !contiguous,
    text: !selected.length
      ? '全部取消后，每句话都会单独成段'
      : (contiguous ? `已选 ${selected.length} 句继续共用一个画面` : '保留在一起的句子需要连续'),
  };
}

Page({
  data: host.hostBaseData({
    projectId: '', loading: true, project: null, rows: [],
    totalText: '0:00', avatarSec: 0, credits: 0,
    flash: null, previewOpen: false, rangeOpen: false,
    groupCount: 0, rangeShotId: '', rangeTitle: '', rangeRows: [],
    rangeSelectedCount: 0, rangeInvalid: false, rangeText: '',
    assetsById: {}, avatars: [], selectedAvatar: null, avatarPreviewUrl: '', avatarPickerOpen: false,
    assetPreviewOpen: false, previewAsset: null,
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
    if (this.data.assetPreviewOpen) host.setOverlay(false, 'video-asset-preview');
    if (this.data.avatarPickerOpen) host.setOverlay(false, 'video-avatar-picker');
  },

  load() {
    Promise.all([
      api.project(this.data.projectId),
      api.assets().catch(() => []),
      api.avatars().catch(() => []),
    ])
      .then(([project, assets, avatars]) => {
        const avatarList = Array.isArray(avatars) ? avatars : [];
        const selectedAvatar = avatarList.find((item) => item.id === project.avatarId)
          || avatarList.find((item) => item.imageStatus === 'ready') || avatarList[0] || null;
        const normalized = Object.assign({}, project, {
          shots: model.ensureShots(project.segments, project.shots),
          avatarId: selectedAvatar ? selectedAvatar.id : null,
          voiceId: selectedAvatar ? selectedAvatar.linkedVoiceId || null : null,
        });
        const assetsById = {};
        (Array.isArray(assets) ? assets : []).forEach((asset) => { if (asset && asset.id) assetsById[asset.id] = asset; });
        this.setData({
          loading: false,
          project: normalized,
          assetsById,
          avatars: avatarList,
          selectedAvatar,
          avatarPreviewUrl: selectedAvatar && selectedAvatar.imagePreviewUrl ? selectedAvatar.imagePreviewUrl : '',
        });
        if (selectedAvatar && (project.avatarId !== normalized.avatarId || project.voiceId !== normalized.voiceId)) {
          api.saveProject(this.data.projectId, { avatarId: normalized.avatarId, voiceId: normalized.voiceId, step: 2 }).catch(() => {});
        }
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
      rows: rendered.map((shot, index) => this.decorate(shot, rendered[index + 1])),
      groupCount: rendered.filter((shot) => shot.role !== ROLE.TAIL).length,
      totalText: model.formatDuration(estimate.summary.totalSec),
      avatarSec: estimate.summary.avatarSec,
      credits: estimate.total,
    });
  },

  decorate(shot, following) {
    const seconds = model.segmentSeconds(shot);
    const isTail = shot.role === ROLE.TAIL;
    const isAvatar = shot.role === ROLE.AVATAR;
    const asset = shot.assetId ? this.data.assetsById[shot.assetId] : null;
    const assetKind = asset && asset.kind ? asset.kind : 'video';
    const assetDisplayLabel = model.assetDisplayLabel(asset && asset.label ? asset.label : shot.assetLabel, assetKind);
    const count = shot.endNo - shot.startNo + 1;
    const range = count > 1 ? `${String(shot.startNo).padStart(2, '0')}–${String(shot.endNo).padStart(2, '0')}` : String(shot.startNo).padStart(2, '0');
    return Object.assign({}, shot, {
      seconds, sentenceCount: count, multi: count > 1,
      rangeText: `第 ${range} 句`,
      roleClass: isTail ? 'tail' : (isAvatar ? 'avatar' : 'broll'),
      roleLabel: isTail ? '固定片段' : (isAvatar ? '分身出镜' : '配画面'),
      metaText: isTail
        ? `${shot.durationSec} 秒 · 可整段替换`
        : (isAvatar ? `出镜 ${seconds} 秒`
          : (shot.assetId ? `${seconds} 秒 · 画面已选` : (shot.hint || '还没配画面'))),
      assetDisplayLabel,
      assetTypeText: assetKind === 'image' ? '图片素材' : '视频素材',
      // 素材短于本段口播时，合成端会用 -stream_loop 正向循环把它铺满 —— 播到底跳回开头，
      // 硬跳在横摇/推镜素材上很像倒带。与其让用户出片后才发现，不如在这里就说清。
      // 图片没有时长概念，不参与判定。
      assetSeconds: assetKind === 'image' ? 0 : Math.round(Number(asset && asset.durationSec) || 0),
      assetTooShort: assetKind !== 'image'
        && Number(asset && asset.durationSec) > 0
        && Math.round(Number(asset.durationSec)) < seconds,
      assetPreviewUrl: asset && asset.previewUrl ? asset.previewUrl : '',
      framePreviewUrl: isAvatar ? this.data.avatarPreviewUrl : (asset && asset.previewUrl ? asset.previewUrl : ''),
      previewMeta: isTail ? '固定片段' : (isAvatar ? '分身出镜' : (assetKind === 'image' ? '已选图片素材' : '已选视频素材')),
      avatarSpanText: count > 1 ? `连续 ${count} 句出镜` : '',
      hasAsset: Boolean(shot.assetId), switchable: !isTail,
      canMergeNext: !isTail && Boolean(following && following.role !== ROLE.TAIL),
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

  openRange(event) {
    const id = String(event.currentTarget.dataset.id || '');
    const shot = this.data.project.shots.find((item) => item.id === id);
    if (!shot || shot.role === ROLE.TAIL || shot.startNo === shot.endNo) return;
    const rows = this.data.project.segments
      .filter((segment) => segment.no >= shot.startNo && segment.no <= shot.endNo)
      .map((segment) => ({ no: segment.no, text: segment.text, selected: true }));
    const state = rangeSelectionState(rows);
    host.setOverlay(true, 'video-shot-range');
    this.setData({
      rangeOpen: true,
      rangeShotId: id,
      rangeTitle: shot.startNo === shot.endNo ? `第 ${shot.startNo} 句` : `第 ${shot.startNo}–${shot.endNo} 句`,
      rangeRows: rows,
      rangeSelectedCount: state.count,
      rangeInvalid: state.invalid,
      rangeText: state.text,
    });
  },

  tapRangeSentence(event) {
    const no = Number(event.currentTarget.dataset.no);
    const rows = this.data.rangeRows.map((row) => (row.no === no ? Object.assign({}, row, { selected: !row.selected }) : row));
    const state = rangeSelectionState(rows);
    this.setData({
      rangeRows: rows,
      rangeSelectedCount: state.count,
      rangeInvalid: state.invalid,
      rangeText: state.text,
    });
  },

  applyRange() {
    const project = this.data.project;
    const selectedNos = this.data.rangeRows.filter((row) => row.selected).map((row) => row.no);
    const result = model.regroupShotSelection(project.segments, project.shots, this.data.rangeShotId, selectedNos);
    if (result.error) { host.toast(result.error); return; }
    this.setData({ project: Object.assign({}, project, { shots: result.shots }) });
    this.closeRange(); this.recompute(); this.scheduleSave();
    host.toast('已按勾选重新分段', 'success');
  },

  splitRange() {
    const project = this.data.project;
    const shots = model.splitShot(project.segments, project.shots, this.data.rangeShotId);
    this.setData({ project: Object.assign({}, project, { shots }) });
    this.closeRange(); this.recompute(); this.scheduleSave();
    host.toast('这段已拆成单句', 'success');
  },

  mergeNext(event) {
    const id = String(event.currentTarget.dataset.id || '');
    const project = this.data.project;
    const index = project.shots.findIndex((shot) => shot.id === id);
    const current = project.shots[index];
    const following = project.shots[index + 1];
    const apply = () => {
      const result = model.mergeAdjacentShots(project.segments, project.shots, id);
      if (result.error) { host.toast(result.error); return; }
      this.setData({ project: Object.assign({}, project, { shots: result.shots }) });
      this.recompute(); this.scheduleSave();
      host.toast('已和下一段合并', 'success');
    };
    const needsNewAsset = current && following && (current.assetId || following.assetId)
      && String(current.assetId || '') !== String(following.assetId || '');
    if (!needsNewAsset) { apply(); return; }
    host.confirm({ title: '合并并重新选画面？', content: '这两段当前画面不同，合并后需要为整段重新选择一个画面。' })
      .then((ok) => { if (ok) apply(); });
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
    this.setData({ rangeOpen: false, rangeShotId: '', rangeRows: [] });
  },

  openAvatarPicker() {
    if (!this.data.avatars.length) { host.go('clone/index'); return; }
    host.setOverlay(true, 'video-avatar-picker');
    this.setData({ avatarPickerOpen: true });
  },

  closeAvatarPicker() {
    host.setOverlay(false, 'video-avatar-picker');
    this.setData({ avatarPickerOpen: false });
  },

  openNewAvatar() { this.closeAvatarPicker(); host.go('clone/index?new=1'); },

  chooseAvatar(event) {
    const id = String(event.currentTarget.dataset.id || '');
    const selectedAvatar = this.data.avatars.find((item) => item.id === id);
    if (!selectedAvatar || selectedAvatar.imageStatus !== 'ready') { host.toast('这个数字人还没训练好'); return; }
    const project = Object.assign({}, this.data.project, { avatarId: id, voiceId: selectedAvatar.linkedVoiceId || null });
    this.setData({ project, selectedAvatar, avatarPreviewUrl: selectedAvatar.imagePreviewUrl || '' });
    this.closeAvatarPicker(); this.recompute(); this.scheduleSave();
    host.toast(selectedAvatar.linkedVoiceId ? '已切换数字人，关联声音也已带入' : '已切换数字人，请先为它关联声音', 'success');
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

  previewSelectedAsset(event) {
    const id = String(event.currentTarget.dataset.assetId || '');
    if (!id) return;
    const asset = this.data.assetsById[id];
    const contentUrl = asset && (asset.contentUrl || asset.previewUrl);
    if (!contentUrl) { host.toast('这个素材暂时没有可预览文件'); return; }
    host.setOverlay(true, 'video-asset-preview');
    this.setData({ assetPreviewOpen: true, previewAsset: Object.assign({}, asset, { contentUrl }) });
  },

  closeAssetPreview() {
    host.setOverlay(false, 'video-asset-preview');
    this.setData({ assetPreviewOpen: false, previewAsset: null });
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
    const displayLabel = model.assetDisplayLabel(asset && asset.label, asset && asset.kind);
    const shots = project.shots.map((shot) => (shot.id === shotId
      ? Object.assign({}, shot, { assetId: asset.id, assetLabel: displayLabel }) : shot));
    const assetsById = Object.assign({}, this.data.assetsById, { [asset.id]: Object.assign({}, asset, { label: displayLabel }) });
    this.setData({ project: Object.assign({}, project, { shots }), assetsById }, () => {
      this.recompute(); this.scheduleSave();
    });
  },

  scheduleSave() {
    host.writeDraft(this.data.projectId, { project: Object.assign({}, this.data.project, { step: 2 }), step: 2 });
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, SAVE_DEBOUNCE_MS);
  },

  flush() {
    const project = this.data.project; if (!project) return;
    api.saveProject(this.data.projectId, { segments: project.segments, shots: project.shots, avatarId: project.avatarId, voiceId: project.voiceId, step: 2 }).catch(() => {});
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
