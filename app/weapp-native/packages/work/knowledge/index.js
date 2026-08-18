const { api, isMock } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { navTo } = require('../../../services/nav');
const { getToken } = require('../../../services/token');
const { getApiBaseUrl } = require('../../../services/runtime-mode');
const { withShare } = require('../../../services/share');

const SUPPORTED_EXT = ['pdf', 'doc', 'docx', 'xlsx', 'csv', 'pptx', 'md', 'markdown', 'txt'];
const POLL_DELAYS = [2000, 4000, 8000, 8000, 8000];
const STATUS = { ready: '就绪', parsing: '解析中', embedding: '嵌入中', failed: '失败', pending: '排队' };
const STAGES = { staging: { label: '待整理', cls: 'kb-st-staging' }, optimized: { label: '已优化', cls: 'kb-st-optimized' } };
const isSettled = (status) => status === 'ready' || status === 'failed';

function cleanSourceName(value) {
  const name = String(value || '').trim();
  if (!name || /^(tmp_|wxfile:|file:|blob:|undefined$|null$)/i.test(name)) return '';
  if (/^(上传资料(?:\s*\d+)?|未命名(?:文件|资料)?|待识别资料)$/i.test(name)) return '';
  if (/^(founder|company|finance|content|growth|customer|proof|unknown)资料$/i.test(name)) return '';
  return name;
}
function displayName(row) { return cleanSourceName(row.fileName) || cleanSourceName(row.title) || '待识别资料'; }
/**
 * 对话里粘贴长文自动归卷的条目。判据优先用服务端的 `sourceType='paste'`（chat-core 归卷时就传了）；
 * 存量数据没有该字段，退回按标题启发式认（归卷标题固定形如「粘贴长文·N字」），不写迁移脚本。
 */
function isPasted(row) {
  if (row && row.sourceType === 'paste') return true;
  return /^粘贴长文/.test(String((row && (row.title || row.fileName)) || ''));
}
function fmtSize(bytes) {
  const value = Number(bytes) || 0;
  if (!value) return '';
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)}KB`;
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}
function fmtWhen(iso) {
  const stamp = new Date(iso).getTime(); if (!stamp) return '';
  const diff = Date.now() - stamp;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`;
  const date = new Date(stamp); return `${date.getMonth() + 1}月${date.getDate()}日`;
}
function viewRow(row) {
  const badge = STAGES[row.stage] || null;
  const settled = isSettled(row.status); const failed = row.status === 'failed'; const staging = row.stage === 'staging';
  const meta = [row.fileType ? String(row.fileType).toUpperCase() : '', row.fileSize ? fmtSize(row.fileSize) : '', fmtWhen(row.updatedAt || row.createdAt)].filter(Boolean);
  return {
    id: row.id, title: displayName(row), stageLabel: badge && badge.label, stageClass: badge && badge.cls,
    statusLabel: STATUS[row.status] || row.status || '', statusClass: failed ? 'bad' : settled ? 'ok' : 'wait',
    summary: staging ? '待整理 · 确认入库后军师才能用上' : failed ? (row.error || '解析失败，删掉重传即可') : (row.summary || (settled ? '（该资料无可预览正文）' : '正在解析正文…')),
    meta: `${meta.join(' · ')}${!staging && !failed && row.chunkCount ? ` · ${row.chunkCount} 切片` : ''}`,
  };
}

function parseUploadBody(value) { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch (_) { return {}; } }

Page(withShare({
  data: baseData({ loading: true, items: [], pasteItems: [], pasteCount: 0, pasteOpen: false, busy: false, pct: 0, pollHint: false, errorText: '', showLogin: false }),
  togglePaste() { this.setData({ pasteOpen: !this.data.pasteOpen }); },
  onLoad() { this._attempt = 0; this.load(true); },
  onShow() { this.setData({ themeClass: store.snapshot().themeClass }); if (this._loaded) { this._attempt = 0; this.load(true); } },
  onHide() { this.clearPoll(); },
  onUnload() { this.clearPoll(); this._cancelled = true; },
  onPullDownRefresh() { this._attempt = 0; this.setData({ pollHint: false }); this.load(true).finally(() => wx.stopPullDownRefresh()); },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/thinktank/index' }) }); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(true); },
  clearPoll() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } },
  async load(poll) {
    if (!store.isAuthed()) { this.setData({ loading: false, showLogin: true }); return; }
    if (!this._loaded) this.setData({ loading: true });
    try {
      const rows = await api.knowledgeDocs(); this._rows = rows || []; this._loaded = true;
      // 对话里粘贴超限自动归卷的长文也是 KnowledgeItem，会和用户主动上传的文件混在同一列表里
      // （2026-08-08 真机反馈：「知识库里为什么混进去粘贴板内容了」）。它们仍被会话引用着、
      // 也得能删，所以不隐藏，只按来源分组：主列表=自己上传的，附卷收进下面可展开的一组。
      const uploads = this._rows.filter((row) => !isPasted(row));
      const pastes = this._rows.filter(isPasted);
      this.setData({
        loading: false, errorText: '',
        items: uploads.map(viewRow),
        pasteItems: pastes.map(viewRow),
        pasteCount: pastes.length,
      });
      if (!poll) return;
      this.clearPoll();
      if (!this._rows.some((row) => !isSettled(row.status))) { this._attempt = 0; this.setData({ pollHint: false }); return; }
      if (this._attempt >= POLL_DELAYS.length) { this.setData({ pollHint: true }); return; }
      const delay = POLL_DELAYS[this._attempt++]; this._timer = setTimeout(() => this.load(true), delay);
    } catch (error) {
      const kind = store.handleApiError(error, { silent: true });
      this._loaded = true; this.setData({ loading: false, errorText: kind === 'unauthorized' ? '' : (error.message || '资料库读取失败'), showLogin: kind === 'unauthorized' });
    }
  },
  retry() { this._attempt = 0; this.load(true); },
  openDetail(event) { navTo(`/packages/work/knowledge/detail/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}`); },
  remove(event) {
    const id = event.currentTarget.dataset.id; const row = (this._rows || []).find((item) => item.id === id); if (!row) return;
    wx.showModal({ title: '删除资料', content: `删除「${displayName(row)}」？军师将不再参考它。`, confirmText: '删除', confirmColor: '#9C4A38', success: async (result) => {
      if (!result.confirm) return;
      try { await api.deleteKnowledge(id); wx.showToast({ title: '已删除', icon: 'none' }); this.load(false); }
      catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '删除失败' }); }
    } });
  },
  chooseUpload() {
    if (this.data.busy) return;
    wx.showModal({ title: '从微信聊天选择文件', content: '微信只允许小程序选取「聊天里的文件」。请先把资料发给「文件传输助手」，下一步选它即可。这不是转发，是选文件。', confirmText: '去选择', success: (guide) => {
      if (!guide.confirm) return;
      wx.chooseMessageFile({ count: 1, type: 'file', extension: SUPPORTED_EXT, success: (chosen) => this.upload(chosen.tempFiles && chosen.tempFiles[0]), fail: (error) => { if (!/cancel/i.test(String(error.errMsg || ''))) wx.showToast({ title: '没能打开文件选择，请重试', icon: 'none' }); } });
    } });
  },
  async upload(file) {
    if (!file) return;
    const name = cleanSourceName(file.name); const ext = String((file.name || '').split('.').pop() || '').toLowerCase();
    if (!SUPPORTED_EXT.includes(ext)) { wx.showToast({ title: `不支持的格式 .${ext}`, icon: 'none' }); return; }
    if (Number(file.size || 0) > 20 * 1024 * 1024) { wx.showToast({ title: '单个文件不能超过 20MB', icon: 'none' }); return; }
    this._cancelled = false; this.setData({ busy: true, pct: 0 });
    try {
      const result = await this.uploadFile(file.path, name);
      if (this._cancelled) return;
      wx.showToast({ title: '已上传，解析中…', icon: 'none' });
      const now = new Date().toISOString(); const optimistic = { id: result.id, title: name || '待识别资料', fileName: name || '待识别资料', fileType: ext, fileSize: file.size, status: result.status || 'parsing', stage: result.stage || 'confirmed', chunkCount: 0, summary: '', createdAt: now, updatedAt: now };
      if (!(this._rows || []).some((item) => item.id === result.id)) { this._rows = [optimistic].concat(this._rows || []); this.setData({ items: this._rows.map(viewRow) }); }
      this._attempt = 0; this.setData({ pollHint: false }); this.load(true);
    } catch (error) {
      if (!this._cancelled) store.handleApiError(error, { fallbackTitle: error.message || '上传失败' });
    } finally { this._uploadTask = null; this.setData({ busy: false, pct: 0 }); }
  },
  uploadFile(filePath, originalName) {
    if (isMock()) return api.uploadKnowledge(filePath, { originalName }, { onProgress: (progress) => { if (!this._cancelled) this.setData({ pct: Number(progress.progress) || 0 }); } });
    const tokenAtRequest = getToken();
    return new Promise((resolve, reject) => {
      const task = wx.uploadFile({
        url: `${getApiBaseUrl()}/knowledge/upload`, filePath, name: 'file', formData: originalName ? { originalName } : {},
        header: tokenAtRequest ? { 'x-user-id': tokenAtRequest } : {}, timeout: 180000,
        success: (response) => {
          const data = parseUploadBody(response.data);
          if (response.statusCode >= 200 && response.statusCode < 300) { resolve(data); return; }
          reject(Object.assign(new Error(data.error || `上传失败（${response.statusCode}）`), { code: response.statusCode === 401 ? 'UNAUTHORIZED' : (data.code || `HTTP_${response.statusCode}`), data, hadToken: Boolean(tokenAtRequest) }));
        },
        fail: (error) => reject(Object.assign(new Error(/abort/i.test(String(error.errMsg || '')) ? '上传已取消' : '网络连接失败，请检查网络后重试。'), { code: /abort/i.test(String(error.errMsg || '')) ? 'CANCELLED' : 'NETWORK_ERROR' })),
      });
      this._uploadTask = task;
      task.onProgressUpdate((progress) => { if (!this._cancelled) this.setData({ pct: Number(progress.progress) || 0 }); });
    });
  },
  cancelUpload() { this._cancelled = true; if (this._uploadTask) this._uploadTask.abort(); this._uploadTask = null; this.setData({ busy: false, pct: 0 }); wx.showToast({ title: '已取消上传', icon: 'none' }); },
}, { timeline: true }));
