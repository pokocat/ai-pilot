// 屏 05 · 第 1 步 改文案。
//
// 交互要点（设计稿）：整段文案连读展示，变量高亮；点某句进入「正在改」态，
// 该句下方出现 试听 / AI 改写 / 改好了 三个动作。底部常驻「预计 2:42 读完全文的时长」。
const host = require('../host');
const api = require('../api');
const model = require('../model');
const { withShare } = require('../../../services/share');
const { ROLE } = model;

const SAVE_DEBOUNCE_MS = 1200;

Page(withShare({
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
    /**
     * 编辑模式。'line' 逐句微调；'bulk' 整段编辑 —— 用户拿着写好的稿子过来时，
     * 一句句抠是折磨，整段模式让他直接粘一整篇（一行一句）。
     */
    editMode: 'line',
    bulkText: '',
    /** 进入整段模式时的原文；用来判断用户改过没有，改过就不能默默丢掉。 */
    bulkOriginal: '',
    /** 整段模式下的实时统计，让用户粘贴前就知道会影响几句、丢几个已配画面。 */
    bulkStats: null,
    bulkSaving: false,
    rewriting: false,
    previewing: false,
    chatting: false,
    aiOpen: false,
    chatInput: '',
    chatMessages: [],
    chatScrollTop: 0,
    chatSuggestions: ['写得更口语一点', '突出我的手艺，让人信得过', '开头更抓人，但别像广告'],
    showLogin: false,
  }),

  onLoad(options) {
    const projectId = String((options && options.projectId) || '');
    if (!projectId) { host.toast('打不开这个项目'); host.back(); return; }
    this.setData({ projectId });
    this.saveTimer = null;
    this.load();
  },

  onUnload() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; this.flush(); }
    if (this.audio) { this.audio.stop(); this.audio.destroy(); this.audio = null; }
    if (this.data.aiOpen) host.setOverlay(false, 'video-script-ai');
  },

  load() {
    api.project(this.data.projectId)
      .then((project) => {
        const normalized = Object.assign({}, project, {
          shots: model.ensureShots(project.segments, project.shots),
          scriptChat: Array.isArray(project.scriptChat) ? project.scriptChat : [],
        });
        this.setData({ loading: false, project: normalized, chatMessages: normalized.scriptChat });
        host.writeDraft(this.data.projectId, { project: normalized, step: 1 });
        this.recompute(normalized.segments);
      })
      .catch((error) => {
        const draft = host.readDraft(this.data.projectId);
        if (draft && draft.project && Array.isArray(draft.project.segments)) {
          const normalized = Object.assign({}, draft.project, {
            shots: model.ensureShots(draft.project.segments, draft.project.shots),
            scriptChat: Array.isArray(draft.project.scriptChat) ? draft.project.scriptChat : [],
          });
          this.setData({ loading: false, project: normalized, chatMessages: normalized.scriptChat });
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
    if (!host.requireLogin(this, 'video')) return;
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
        else host.toast('暂时没有试听音频');
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
    if (!host.requireLogin(this, 'video')) return;
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
          const project = Object.assign({}, this.data.project, {
            segments: result.segments,
            shots: model.defaultShots(result.segments),
          });
          this.setData({ project });
          this.recompute(result.segments);
          this.scheduleSave();
        } else {
          host.toast('整篇改写没有结果，请重试');
        }
      })
      .catch((error) => {
        this.setData({ rewriting: false });
        host.toast(error && error.message ? error.message : '改写失败');
      });
  },

  /* ── 和 AI 对话写稿 ── */

  openAi() {
    host.setOverlay(true, 'video-script-ai');
    this.setData({ aiOpen: true, chatScrollTop: 999999 });
  },

  closeAi() {
    host.setOverlay(false, 'video-script-ai');
    this.setData({ aiOpen: false });
  },

  inputChat(event) { this.setData({ chatInput: String(event.detail.value || '') }); },

  useSuggestion(event) {
    this.setData({ chatInput: String(event.currentTarget.dataset.prompt || '') });
    this.sendChat();
  },

  sendChat() {
    if (!host.requireLogin(this, 'video')) return;
    const message = String(this.data.chatInput || '').trim();
    if (!message) { host.toast('先说说你想怎么写'); return; }
    if (this.data.chatting) return;
    const optimistic = (this.data.chatMessages || []).concat([{ id: `local_${Date.now()}`, role: 'user', content: message }]);
    this.setData({ chatting: true, chatInput: '', chatMessages: optimistic, chatScrollTop: this.data.chatScrollTop + 999999 });
    api.scriptChat(this.data.projectId, message)
      .then((result) => {
        const project = Object.assign({}, result.project, {
          shots: model.ensureShots(result.project.segments, result.project.shots),
          scriptChat: Array.isArray(result.project.scriptChat) ? result.project.scriptChat : [],
        });
        this.setData({ chatting: false, project, chatMessages: project.scriptChat, chatScrollTop: this.data.chatScrollTop + 999999 });
        this.recompute(project.segments);
        host.writeDraft(this.data.projectId, { project, step: 1 });
        if (result.applied) host.toast('新稿已写进正文，可继续聊着改', 'success');
      })
      .catch((error) => {
        this.setData({ chatting: false, chatMessages: this.data.project.scriptChat || [], chatInput: message });
        host.toast(error && error.message ? error.message : 'AI 暂时没接上，请重试');
      });
  },

  /* ── 整段编辑 ────────────────────────────────────────────────────── */

  enterBulk() {
    const project = this.data.project;
    if (!project) return;
    // 进整段模式前先把逐句的未提交编辑冲掉，否则用户会看到一份不含刚改内容的旧稿
    if (this.data.editingNo != null) this.commitEdit();
    const text = model.scriptToText(this.data.project.segments);
    this.setData({
      editMode: 'bulk',
      bulkText: text,
      bulkOriginal: text,
      bulkStats: null,
      editingNo: null,
    });
  },

  exitBulk() {
    // 用户可能刚粘完一整篇稿子，直接丢弃是不可接受的
    if (String(this.data.bulkText || '') !== String(this.data.bulkOriginal || '')) {
      host.confirm({
        title: '放弃这次修改？',
        content: '你在整段编辑里改的内容还没用上，返回就没了。',
        confirmText: '放弃',
        cancelText: '继续编辑',
      }).then((ok) => { if (ok) this.doExitBulk(); });
      return;
    }
    this.doExitBulk();
  },

  doExitBulk() {
    this.setData({ editMode: 'line', bulkStats: null, bulkOriginal: '' });
    this.recompute(this.data.project.segments);
  },

  /** 自动分段：按句末标点切，碎句并进上一段，超长段在次级标点断开。 */
  autoSplit() {
    const pieces = model.splitScriptText(this.data.bulkText);
    if (!pieces.length) { host.toast('先粘贴一段文案'); return; }
    const bulkText = pieces.join('\n');
    if (bulkText === this.data.bulkText) { host.toast('已经分好段了'); return; }
    const project = this.data.project;
    this.setData({ bulkText, bulkStats: model.applyBulkScript(project.segments, project.shots, bulkText).stats });
    host.toast(`分成 ${pieces.length} 段`, 'success');
  },

  inputBulk(event) {
    const bulkText = String(event.detail.value || '');
    const project = this.data.project;
    const preview = model.applyBulkScript(project.segments, project.shots, bulkText);
    this.setData({ bulkText, bulkStats: preview.stats });
  },

  applyBulk() {
    const project = this.data.project;
    if (!project || this.data.bulkSaving) return;
    const result = model.applyBulkScript(project.segments, project.shots, this.data.bulkText);

    if (result.stats.empty) { host.toast('文案不能是空的'); return; }

    const commit = () => {
      this.setData({
        bulkSaving: false,
        editMode: 'line',
        bulkStats: null,
        previewedText: null,
        project: Object.assign({}, project, { segments: result.segments, shots: result.shots }),
      });
      this.recompute(result.segments);
      this.scheduleSave();
      host.toast(`已更新 ${result.stats.after} 句`, 'success');
    };

    // 丢画面是不可逆的（素材本身还在素材库，但这一句上的绑定没了），必须先说清楚
    if (result.stats.droppedAssets > 0) {
      this.setData({ bulkSaving: true });
      host.confirm({
        title: '有画面会被清掉',
        content: `改动会让 ${result.stats.droppedAssets} 句已配好的画面被清掉（素材还在素材库，只是要重新配）。继续吗？`,
        confirmText: '继续',
      }).then((ok) => {
        if (!ok) { this.setData({ bulkSaving: false }); return; }
        commit();
      });
      return;
    }
    commit();
  },

  restoreTemplate() {
    host.confirm({ title: '恢复模板原文', content: '你改过的文字会换回模板原文，确定吗？' }).then((ok) => {
      if (!ok) return;
      host.loading('正在恢复');
      api.resetScript(this.data.projectId)
        .then((result) => {
          host.hideLoading();
          const segments = result && result.segments;
          if (!Array.isArray(segments)) throw new Error('恢复失败，请重试');
          const shots = Array.isArray(result.shots) && result.shots.length ? result.shots : model.defaultShots(segments);
          const project = Object.assign({}, this.data.project, { segments, shots });
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
    api.saveProject(this.data.projectId, {
      segments: project.segments,
      shots: model.ensureShots(project.segments, project.shots),
      scriptChat: project.scriptChat || [],
      step: 1,
    }).catch(() => {});
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
  swallow() {},
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); },
}));
