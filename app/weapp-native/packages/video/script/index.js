// 屏 05 · 第 1 步 改文案。
//
// 交互要点（设计稿）：整段文案连读展示，变量高亮；点某句进入「正在改」态，
// 该句下方出现 试听 / AI 改写 / 改好了 三个动作。底部常驻「预计 2:42 读完全文的时长」。
const host = require('../host');
const api = require('../api');
const model = require('../model');
const { ROLE } = model;

const SAVE_DEBOUNCE_MS = 1200;

Page({
  data: host.hostBaseData({
    projectId: '',
    loading: true,
    project: null,
    rows: [],
    totalText: '0:00',
    /** 当前正在编辑的句子序号；null = 只读浏览态 */
    editingNo: null,
    editingText: '',
    editingSeconds: 0,
    /** 最近一次成功试听对应的文本；提交时完全相同才保留真实时长。 */
    previewedText: null,
    rewriting: false,
    previewing: false,
    showLogin: false,
  }),

  onLoad(options) {
    const projectId = String((options && options.projectId) || '');
    if (!projectId) { host.toast('缺少项目参数'); host.back(); return; }
    this.setData({ projectId });
    this.saveTimer = null;
    this.load();
  },

  onUnload() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; this.flush(); }
    if (this.audio) { this.audio.stop(); this.audio.destroy(); this.audio = null; }
  },

  load() {
    api.project(this.data.projectId)
      .then((project) => {
        this.setData({ loading: false, project });
        host.writeDraft(this.data.projectId, { project, step: 1 });
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

  recompute(segments) {
    const summary = model.summarize(segments);
    this.setData({
      rows: segments
        .filter((segment) => segment.role !== ROLE.TAIL)
        .map((segment) => Object.assign({}, segment, {
          seconds: model.segmentSeconds(segment),
          editing: segment.no === this.data.editingNo,
        })),
      totalText: model.formatDuration(summary.totalSec),
    });
  },

  /* ── 编辑单句 ── */

  startEdit(event) {
    const no = Number(event.currentTarget.dataset.no);
    const segment = this.data.project.segments.find((item) => item.no === no);
    if (!segment || segment.role === ROLE.TAIL) return;
    this.setData({
      editingNo: no,
      editingText: segment.text,
      editingSeconds: model.segmentSeconds(segment),
      previewedText: segment.actualDurationSec > 0 ? segment.text : null,
    });
    this.recompute(this.data.project.segments);
  },

  inputText(event) {
    const text = String(event.detail.value || '');
    this.setData({ editingText: text, editingSeconds: model.estimateSeconds(text) });
  },

  commitEdit() {
    const no = this.data.editingNo;
    if (no == null) return;
    const project = this.data.project;
    const segments = model.commitSegmentText(
      project.segments,
      no,
      this.data.editingText,
      this.data.previewedText,
    );
    this.setData({ project: Object.assign({}, project, { segments }), editingNo: null, previewedText: null });
    this.recompute(segments);
    this.scheduleSave();
  },

  cancelEdit() {
    this.setData({ editingNo: null, previewedText: null });
    this.recompute(this.data.project.segments);
  },

  /* ── 试听 ── */

  previewVoice() {
    if (!host.requireLogin(this, 'execute')) return;
    if (this.data.previewing) return;
    const no = this.data.editingNo;
    this.setData({ previewing: true });
    api.previewVoice(this.data.projectId, no, this.data.editingText)
      .then((result) => {
        this.setData({ previewing: false });
        // 用真实 TTS 时长回填，报价随之变准（方案 §2.1 的二级精度）
        const project = this.data.project;
        const segments = project.segments.map((segment) => (segment.no === no
          ? Object.assign({}, segment, { actualDurationSec: result.actualDurationSec })
          : segment));
        this.setData({
          project: Object.assign({}, project, { segments }),
          editingSeconds: result.actualDurationSec,
          previewedText: this.data.editingText,
        });
        this.recompute(segments);
        if (result.audioUrl) this.playAudio(result.audioUrl);
        else host.toast('试听音频待接入');
      })
      .catch((error) => {
        this.setData({ previewing: false });
        host.toast(error && error.message ? error.message : '试听失败');
      });
  },

  playAudio(url) {
    if (!this.audio) this.audio = wx.createInnerAudioContext();
    this.audio.src = url;
    this.audio.play();
  },

  /* ── AI 改写 ── */

  rewriteOne() { this.rewrite('segment'); },
  rewriteAll() { this.rewrite('all'); },

  rewrite(scope) {
    if (!host.requireLogin(this, 'execute')) return;
    if (this.data.rewriting) return;
    this.setData({ rewriting: true });
    const no = scope === 'segment' ? this.data.editingNo : null;
    const text = scope === 'segment' ? this.data.editingText : null;
    api.aiRewrite(this.data.projectId, scope, no, text)
      .then((result) => {
        this.setData({ rewriting: false });
        if (scope === 'segment') {
          this.setData({ editingText: result.text, editingSeconds: model.estimateSeconds(result.text), previewedText: null });
          return;
        }
        if (result.segments) {
          const project = Object.assign({}, this.data.project, { segments: result.segments });
          this.setData({ project });
          this.recompute(result.segments);
          this.scheduleSave();
        } else {
          host.toast('整段改写结果待接入');
        }
      })
      .catch((error) => {
        this.setData({ rewriting: false });
        host.toast(error && error.message ? error.message : '改写失败');
      });
  },

  restoreTemplate() {
    host.confirm({ title: '恢复模板原文', content: '你改过的文字会被覆盖，确定吗？' }).then((ok) => {
      if (!ok) return;
      host.loading('正在恢复');
      api.resetScript(this.data.projectId)
        .then((result) => {
          host.hideLoading();
          const segments = result && result.segments;
          if (!Array.isArray(segments)) throw new Error('恢复结果不完整');
          const project = Object.assign({}, this.data.project, { segments });
          this.setData({ project, editingNo: null, previewedText: null });
          this.recompute(segments);
          this.scheduleSave();
          host.toast('已恢复模板原文', 'success');
        })
        .catch((error) => {
          host.hideLoading();
          host.toast(error && error.message ? error.message : '恢复失败');
        });
    });
  },

  /* ── 保存与导航 ── */

  scheduleSave() {
    host.writeDraft(this.data.projectId, {
      project: Object.assign({}, this.data.project, { step: 1 }),
      step: 1,
    });
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, SAVE_DEBOUNCE_MS);
  },

  flush() {
    const project = this.data.project;
    if (!project) return;
    api.saveProject(this.data.projectId, { segments: project.segments, step: 1 }).catch(() => {});
  },

  saveDraft() {
    this.flush();
    host.toast('已存草稿', 'success');
  },

  next() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.flush();
    host.go(`shots/index?projectId=${encodeURIComponent(this.data.projectId)}`);
  },

  back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); },
});
