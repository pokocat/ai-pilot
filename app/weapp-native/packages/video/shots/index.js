// 第 2 步 · 按语义段配画面。
// 文案句子与画面镜头分层：用户可圈选连续多句共用一个画面，渲染端也按 shot 聚合，不再逐句硬切。
const host = require('../host');
const api = require('../api');
const model = require('../model');
const { ASSET_LIMITS } = require('../config');
const { withShare } = require('../../../services/share');
const { formatBytes } = model;
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

Page(withShare({
  data: host.hostBaseData({
    projectId: '', loading: true, project: null, rows: [],
    totalText: '0:00', avatarSec: 0, credits: 0,
    flash: null, storyboardOpen: false, rangeOpen: false,
    groupCount: 0, rangeShotId: '', rangeTitle: '', rangeRows: [],
    rangeSelectedCount: 0, rangeInvalid: false, rangeText: '',
    assetsById: {}, avatars: [], selectedAvatar: null, avatarPreviewUrl: '', avatarPickerOpen: false,
    assetPreviewOpen: false, previewAsset: null,
    /** 素材库里已有几个素材 —— 决定「配画面」入口把哪个选项排第一。 */
    assetCount: 0,
    /* 素材连播（2026-08-18 用户反馈：想把已上传的视频直接拼出来看一遍）。
       纯端上按顺序播已配好的画面，不带配音也不带字幕 —— 没有音频就不存在音画同步问题，
       它只回答「我传的画面顺序对不对、接得顺不顺」。真实效果要看排练片。 */
    playOpen: false, playList: [], playIndex: 0, playItem: null, playTotal: 0, playStalled: false,
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
    if (this.data.storyboardOpen) host.setOverlay(false, 'video-storyboard');
    if (this.data.rangeOpen) host.setOverlay(false, 'video-shot-range');
    if (this.data.assetPreviewOpen) host.setOverlay(false, 'video-asset-preview');
    if (this.data.avatarPickerOpen) host.setOverlay(false, 'video-avatar-picker');
    this.stopPlayback();
  },

  // 页面切走时连播必须停：原生 video 在后台继续跑会既费电又触发后台 setData 报警。
  onHide() { if (this.data.playOpen) this.stopPlayback(); },

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
          assetCount: Object.keys(assetsById).length,
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
      // 用户反复问「每一个对应的视频限多少秒」。真实规则是：素材本身没有时长上限，
      // 每段画面播多久由**那一段口播**决定（合成端 -stream_loop -1 + -t 口播时长），
      // 短了循环补满、长了截断。以前只有配完之后才提示「短了会重复播放」，
      // 选之前什么都不说 —— 现在把它变成事前预算，空态和已配态都显示。
      needText: isTail ? `固定 ${shot.durationSec} 秒` : `这段要念 ${seconds} 秒`,
      pickHint: '视频或图片都行 · 短了画面会重复播放',
      // 素材短于本段口播时，合成端会用 -stream_loop 正向循环把它铺满 —— 播到底跳回开头，
      // 硬跳在横摇/推镜素材上很像倒带。与其让用户出片后才发现，不如在这里就说清。
      // 图片没有时长概念，不参与判定。
      assetSeconds: assetKind === 'image' ? 0 : Math.round(Number(asset && asset.durationSec) || 0),
      assetTooShort: assetKind !== 'image'
        && Number(asset && asset.durationSec) > 0
        && Math.round(Number(asset.durationSec)) < seconds,
      // 比本段长的素材会被截断到口播时长（同一段 -t 参数）。用户按「限多少秒」的思路提问，
      // 说明他不知道多出来的部分去哪了 —— 明说只用前 N 秒，比让他自己猜好。
      assetTooLong: assetKind !== 'image'
        && Number(asset && asset.durationSec) > 0
        && Math.round(Number(asset.durationSec)) > seconds + 1,
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

  /**
   * 与下一段合并。
   *
   * 用户原话：「与下一段合并的时候，能不能有个选择，选上面还是下面的视频素材保留」。
   * 以前两段画面不同时只给「确定 / 取消」，确定就把画面清空 —— 用户读成「素材要重新传」，
   * 而其实素材一直都在库里。现在改成三选一，并把素材名念出来，让他知道选的是哪一个。
   */
  mergeNext(event) {
    const id = String(event.currentTarget.dataset.id || '');
    const project = this.data.project;
    const index = project.shots.findIndex((shot) => shot.id === id);
    const current = project.shots[index];
    const following = project.shots[index + 1];
    const apply = (keepAssetFrom) => {
      const result = model.mergeAdjacentShots(project.segments, project.shots, id, keepAssetFrom);
      if (result.error) { host.toast(result.error); return; }
      this.setData({ project: Object.assign({}, project, { shots: result.shots }) });
      this.recompute(); this.scheduleSave();
      const kept = result.shots.find((shot) => shot.startNo === current.startNo && shot.endNo === following.endNo);
      host.toast(kept && kept.assetId ? '已合并，画面保留' : '已和下一段合并', 'success');
    };
    const needsChoice = current && following
      && current.role !== ROLE.TAIL && following.role !== ROLE.TAIL
      // 合并成分身出镜段不需要画面，没什么可选的
      && !(current.role === ROLE.AVATAR && following.role === ROLE.AVATAR)
      && (current.assetId || following.assetId)
      && String(current.assetId || '') !== String(following.assetId || '');
    if (!needsChoice) { apply(null); return; }

    const labelOf = (shot) => {
      if (!shot || !shot.assetId) return '（这段还没配画面）';
      const asset = this.data.assetsById[shot.assetId];
      return model.assetDisplayLabel(asset && asset.label ? asset.label : shot.assetLabel, asset && asset.kind);
    };
    const options = [
      { label: `保留上面那段的画面 · ${labelOf(current)}`, keep: 'current', enabled: Boolean(current.assetId) },
      { label: `保留下面那段的画面 · ${labelOf(following)}`, keep: 'following', enabled: Boolean(following.assetId) },
      { label: '合并后重新选一个画面', keep: null, enabled: true },
    ].filter((option) => option.enabled);
    wx.showActionSheet({
      itemList: options.map((option) => option.label),
      success: (res) => { const option = options[res.tapIndex]; if (option) apply(option.keep); },
    });
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

  /**
   * 选画面。两处用户反馈直接改了这个入口：
   *   · 「只能上传视频吗？能不能换成图片」—— 能力一直都有，是这三行文案没说。
   *   · 「合并了素材就好像要重新传」—— 其实原素材还在库里，但「我的素材库」排在第三位，
   *     前两项是「拍一段/从相册选」，用户第一反应就是又要拍一遍。
   * 所以：库里有东西时把它排第一并带上数量，另外两项的文案写明图片也行。
   */
  pickAsset(event) {
    const shotId = String(event.currentTarget.dataset.id || '');
    if (!host.requireLogin(this, 'execute')) return;
    const count = Number(this.data.assetCount) || 0;
    const fromLibrary = () => host.go(`assets/index?pick=1&projectId=${encodeURIComponent(this.data.projectId)}&shotId=${encodeURIComponent(shotId)}`);
    const actions = count > 0
      ? [
        { label: `我的素材库（${count} 个）`, run: fromLibrary },
        { label: '从相册选视频或图片', run: () => this.chooseMedia(shotId, 'album') },
        { label: '现拍一段', run: () => this.chooseMedia(shotId, 'camera') },
      ]
      : [
        { label: '从相册选视频或图片', run: () => this.chooseMedia(shotId, 'album') },
        { label: '现拍一段', run: () => this.chooseMedia(shotId, 'camera') },
        { label: '我的素材库', run: fromLibrary },
      ];
    wx.showActionSheet({
      itemList: actions.map((action) => action.label),
      success: (res) => { const action = actions[res.tapIndex]; if (action) action.run(); },
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
      count: 1,
      mediaType: ['video', 'image'],
      sourceType: [sourceType],
      // ★ 不写 sizeType 时微信默认取**压缩版**，画面合进成片就再也补不回来。
      //   素材库页（assets/index.js）早就加了这一行，这里之前漏了，两个入口传出来的
      //   是不同画质的素材。依据见 clone/index.js 里那段详细注释。
      sizeType: ['original'],
      // 注意：maxDuration 只约束**现拍**，从相册选不受它限制。
      maxDuration: 30,
      camera: 'back',
      success: (res) => { const file = res.tempFiles && res.tempFiles[0]; if (file) this.uploadAsset(shotId, file); },
      fail: (error) => { if (String(error && error.errMsg || '').indexOf('cancel') < 0) host.toast('打开相机/相册失败'); },
    });
  },

  /**
   * 上传选好的素材。
   *
   * 两条闸都是用户反馈换来的（「上传会提示失败，又要重新传一次」）：
   *   1. 体积预检 —— 服务端 100MB 上限（BFF 413 CLIP_ASSET_TOO_LARGE），
   *      以前端上不查，用户要等整条传完才被告知超限。相册里一条 4K 长视频很容易过线。
   *   2. 容量满了要给出口 —— 素材库页早就把 CLIP_ASSET_QUOTA_EXCEEDED 单独接住了，
   *      这里之前只 toast 一句「上传失败」，两个入口行为不一致。
   */
  uploadAsset(shotId, file) {
    const size = Number(file && file.size) || 0;
    if (size > ASSET_LIMITS.maxBytes) {
      host.confirm({
        title: '这条素材太大了',
        content: `它有 ${formatBytes(size)}，超过了 ${formatBytes(ASSET_LIMITS.maxBytes)} 的上限。换一段短一点的，或者先在相册里裁剪压缩后再传。`,
        confirmText: '知道了',
        cancelText: '取消',
      });
      return;
    }
    host.loading('上传中');
    api.uploadAsset(file.tempFilePath, { shotId, kind: file.fileType || 'video' })
      .then((asset) => { host.hideLoading(); this.assignAsset(shotId, asset); })
      .catch((error) => {
        host.hideLoading();
        if (error && error.code === 'CLIP_ASSET_QUOTA_EXCEEDED') {
          host.confirm({
            title: '素材库满了',
            content: '空间不够放这条素材了。去素材库删掉一些用不上的旧素材就能继续传。',
            confirmText: '去素材库',
          }).then((ok) => { if (ok) host.go('assets/index'); });
          return;
        }
        host.toast(error && error.message ? error.message : '上传失败');
      });
  },

  assignAsset(shotId, asset) {
    const project = this.data.project;
    const displayLabel = model.assetDisplayLabel(asset && asset.label, asset && asset.kind);
    const shots = project.shots.map((shot) => (shot.id === shotId
      ? Object.assign({}, shot, { assetId: asset.id, assetLabel: displayLabel }) : shot));
    const assetsById = Object.assign({}, this.data.assetsById, { [asset.id]: Object.assign({}, asset, { label: displayLabel }) });
    this.setData({ project: Object.assign({}, project, { shots }), assetsById, assetCount: Object.keys(assetsById).length }, () => {
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
  /** 单轨时间线预览（方案 §3.3）。先把改动落盘，预览页读的是服务端项目。 */
  openPreview() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.flush(); host.go(`preview/index?projectId=${encodeURIComponent(this.data.projectId)}`);
  },
  next() {
    if (!host.requireLogin(this, 'execute')) return;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.flush(); host.go(`confirm/index?projectId=${encodeURIComponent(this.data.projectId)}`);
  },
  /* ── 分镜清单 ──────────────────────────────────────────────────────
     这一屏以前叫「出片前预览」，但它只是一列静帧 + 角色标签：没有声音、没有字幕、
     没有转场，也没有真实时长感。用户因此以为自己已经预览过了，出片才发现效果对不上
     （原话：「合成前那个预览可以浏览整体流线，但没法预览成片效果」）。
     所以正名为「分镜清单」——「预览」这两个字留给真正能看效果的排练片。 */
  openStoryboard() {
    if (!this.data.rows.length) return;
    host.setOverlay(true, 'video-storyboard');
    this.setData({ storyboardOpen: true });
  },
  closeStoryboard() {
    host.setOverlay(false, 'video-storyboard');
    this.setData({ storyboardOpen: false });
  },

  /* ── 素材连播 ──────────────────────────────────────────────────────
     用户自己提的思路：「打算把已上传视频做预览」。
     纯端上按顺序播已配好的画面，**不带配音、不带字幕** —— 没有音频就不存在
     音画同步问题，也就不会给出「字幕就长这样」的错误预期。
     它只回答一件事：我传的画面顺序对不对、接得顺不顺。

     每段播多久严格按**那一段口播的秒数**来切，与合成端 `-t 口播时长` 一致；
     视频素材加 loop，短于本段时的循环行为也和成片一样。 */
  buildPlayList() {
    return this.coverPlayItem().concat(this.shotPlayItems());
  },

  /**
   * 封面在成片里只占 0.04 秒（约一帧），肉眼根本看不见 —— 它的用途是视频第一帧和平台缩略图。
   * 所以连播里给它 2 秒并明说这件事：用户既能看清自己设的封面长什么样，
   * 又不会误以为成片开头真会停这么久。
   *
   * 只有真开了封面才放；没开就不放，别让「没设置」看起来像「设置了但没生效」。
   */
  coverPlayItem() {
    const cover = this.data.project && this.data.project.cover;
    if (!cover || cover.enabled !== true) return [];
    const background = cover.backgroundAssetId ? this.data.assetsById[cover.backgroundAssetId] : null;
    const imageUrl = background ? (background.previewUrl || background.contentUrl || '') : '';
    return [{
      key: 'cover',
      no: 0,
      kind: imageUrl ? 'image' : 'blank',
      rangeText: '封面',
      roleLabel: '封面',
      text: cover.keyword || '',
      seconds: 2,
      videoUrl: '',
      imageUrl,
      note: '成片里封面只占第一帧，用作平台缩略图，不占正片时长',
      blankText: '封面底图会从成片里自动抽一帧',
    }];
  },

  shotPlayItems() {
    const avatarUrl = this.data.avatarPreviewUrl || '';
    return (this.data.rows || []).map((row, index) => {
      const asset = row.assetId ? this.data.assetsById[row.assetId] : null;
      const assetUrl = asset ? (asset.contentUrl || asset.previewUrl || '') : '';
      const isAvatar = row.roleClass === 'avatar';
      let kind = 'blank';
      if (isAvatar) kind = avatarUrl ? 'image' : 'blank';
      else if (asset && assetUrl) kind = asset.kind === 'image' ? 'image' : 'video';
      const isTail = row.roleClass === 'tail';
      return {
        key: row.id,
        no: index + 1,
        kind,
        rangeText: row.rangeText,
        roleLabel: row.roleLabel,
        text: row.text,
        seconds: Math.max(1, Number(row.seconds) || 1),
        videoUrl: kind === 'video' ? assetUrl : '',
        imageUrl: kind === 'image' ? (isAvatar ? avatarUrl : assetUrl) : '',
        // 静帧顶替的地方必须说清楚，不能让用户以为成片也是一张不动的图
        note: isAvatar
          ? '成片里这一段是数字人真人口播'
          : (isTail ? '模板自带的固定结尾' : (kind === 'blank' ? '这一段还没配画面' : '')),
        /* 占位文案要按角色说各自的话。三种「这里没图」的原因完全不同：
             出镜段  —— 数字人还没选好形象预览图，不是「没配画面」
             固定尾段 —— 素材由模板提供，本来就不在用户素材库里
             配画面段 —— 才是真的还没配 */
        blankText: isAvatar ? '这个数字人还没有预览图'
          : (isTail ? '结尾固定片段' : '这一段还没配画面'),
      };
    });
  },

  startPlayback() {
    const playList = this.buildPlayList();
    if (!playList.length) { host.toast('还没有可以播放的画面'); return; }
    this.closeStoryboard();
    host.setOverlay(true, 'video-playback');
    this.playToken = (this.playToken || 0) + 1;
    this.setData({ playOpen: true, playList, playTotal: playList.length, playIndex: 0, playItem: playList[0] }, () => this.armPlayStep(this.playToken));
  },

  stopPlayback() {
    // 先作废代次再清 timer：在途的 setData 回调回来时会因为代次对不上而自动失效。
    this.playToken = (this.playToken || 0) + 1;
    this.clearPlayTimer();
    if (this.data.playItem && this.data.playItem.kind === 'video') {
      const ctx = wx.createVideoContext('shots-playback', this);
      if (ctx && typeof ctx.stop === 'function') ctx.stop();
    }
    if (this.data.playOpen) host.setOverlay(false, 'video-playback');
    this.setData({ playOpen: false, playItem: null, playIndex: 0, playList: [], playTotal: 0, playStalled: false });
  },

  clearPlayTimer() {
    if (this.playTimer) { clearTimeout(this.playTimer); this.playTimer = null; }
  },

  /**
   * 排下一次切换。
   *
   * 计时以**真正开始播放**为起点，不是以换 src 为起点：弱网下缓冲三秒、画面只放了两秒就切走，
   * 用户看到的节奏和成片对不上，而这一屏存在的意义正是核对节奏。
   * 所以视频段先不起表，等 `bindplay` 回调（onPlayStarted）再排；图片/占位段没有加载概念，当场排。
   *
   * `token` 是播放代次：快速连点上一段/下一段时，旧的 setData 回调可能晚于新的一次到达，
   * 代次对不上就直接丢弃，避免多推进一段。
   */
  armPlayStep(token) {
    if (token !== this.playToken) return;
    this.clearPlayTimer();
    const item = this.data.playItem;
    if (!item) return;
    if (item.kind === 'video') {
      const ctx = wx.createVideoContext('shots-playback', this);
      if (ctx) { ctx.seek(0); ctx.play(); }
      // 兜底：拿不到上下文、或 bindplay 因为素材损坏永远不来时，别把用户卡在这一段。
      this.playTimer = setTimeout(() => {
        this.playTimer = null;
        if (token !== this.playToken) return;
        this.setData({ playStalled: true });
        this.advance(token);
      }, (item.seconds + 8) * 1000);
      return;
    }
    this.scheduleAdvance(token, item.seconds);
  },

  /** 视频真的开始播了才起表 —— 这样每段的停留时间才等于那一段口播的秒数。 */
  onPlayStarted() {
    const token = this.playToken;
    const item = this.data.playItem;
    if (!item || item.kind !== 'video') return;
    this.setData({ playStalled: false });
    this.scheduleAdvance(token, item.seconds);
  },

  /** 素材放不出来时说清楚，并接着往下走，别停在黑屏上。 */
  onPlayError() {
    const token = this.playToken;
    if (token !== this.playToken) return;
    this.setData({ playStalled: true });
    this.scheduleAdvance(token, 2);
  },

  scheduleAdvance(token, seconds) {
    if (token !== this.playToken) return;
    this.clearPlayTimer();
    this.playTimer = setTimeout(() => { this.playTimer = null; this.advance(token); }, Math.max(1, seconds) * 1000);
  },

  advance(token) {
    if (token !== this.playToken) return;
    this.playNext();
  },

  playNext() {
    const next = this.data.playIndex + 1;
    if (next >= this.data.playList.length) { this.stopPlayback(); host.toast('画面看完了', 'success'); return; }
    this.goPlayIndex(next);
  },

  playPrev() {
    const prev = this.data.playIndex - 1;
    if (prev < 0) return;
    this.goPlayIndex(prev);
  },

  /** 手动切段：先作废代次并同步清 timer，避免旧回调再推进一次造成跳段。 */
  goPlayIndex(index) {
    this.playToken = (this.playToken || 0) + 1;
    this.clearPlayTimer();
    const token = this.playToken;
    this.setData({ playIndex: index, playItem: this.data.playList[index], playStalled: false }, () => this.armPlayStep(token));
  },

  playSkip() { this.playNext(); },
  swallow() {}, back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); }, loggedIn() { this.setData({ showLogin: false }); },
}));
