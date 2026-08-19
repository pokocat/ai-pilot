const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { navTo, gotoExecution } = require('../../../services/nav');
const { withShare } = require('../../../services/share');

const STEP_ROLES = ['准备', '处理', '回写'];
const ACTION_LABEL = { upload: '去图籍上传', backfill: '回填面板', review: '发起复盘', topics: '锦囊手艺', none: '去执行' };
const ACTION_HINT = { upload: '上传后进入智库待整理区，再回写到军师判断。', backfill: '记录线索、咨询、成交，提交后进入今日复盘。', review: '填入完成数据，今晚复盘并调整明日军令。', topics: '去锦囊挑一门手艺，把这条军令落成成品。', none: '按步骤推进这条军令，完成后回执行页打卡。' };

Page(withShare({
  data: baseData({ loading: true, failed: false, order: null, no: 1, steps: [], metrics: [], actionLabel: '', actionHint: '', showLogin: false }),
  onLoad(options) { this._id = options && options.id || ''; this.load(); },
  onShow() { this.setData({ themeClass: store.snapshot().themeClass }); },
  back() { wx.navigateBack({ fail: () => gotoExecution('today') }); },
  closeLogin() { this.setData({ showLogin: false }); }, loggedIn() { this.setData({ showLogin: false }); this.load(); },
  async load() {
    if (!this._id) { this.setData({ loading: false, failed: true }); return; }
    if (!store.isAuthed()) { this.setData({ loading: false, showLogin: true }); return; }
    this.setData({ loading: true, failed: false });
    try {
      const result = await api.casefile(); const dossier = result && result.casefile; const order = dossier && (dossier.orders || []).find((item) => item.id === this._id);
      if (!order) throw new Error('军令不存在或已经归档');
      const sameDay = (dossier.orders || []).filter((item) => item.date === order.date); const no = Math.max(1, sameDay.findIndex((item) => item.id === order.id) + 1); const actionType = order.actionType || 'none';
      this._actionType = actionType;
      this.setData({ loading: false, order: Object.assign({}, order, { headerLabel: order.dueAt ? `第 ${no} 号军令 · ${order.dueAt}` : `第 ${no} 号军令`, headMeta: [order.ownerName ? `负责人 ${order.ownerName}` : '', order.etaMinutes != null ? `预计 ${order.etaMinutes} 分钟` : ''].filter(Boolean).join(' · ') }), no, steps: (order.steps || []).slice(0, 3).map((text, index) => ({ text, no: index + 1, role: STEP_ROLES[index] || `步骤 ${index + 1}` })), metrics: order.metrics || [], actionLabel: ACTION_LABEL[actionType] || ACTION_LABEL.none, actionHint: ACTION_HINT[actionType] || ACTION_HINT.none });
    } catch (error) { const kind = store.handleApiError(error, { silent: true }); this.setData({ loading: false, failed: kind !== 'unauthorized', showLogin: kind === 'unauthorized' }); }
  },
  retry() { this.load(); },
  runAction() { if (this._actionType === 'upload') wx.switchTab({ url: '/pages/thinktank/index' });
    else if (this._actionType === 'topics') navTo('/pages/pouch/index'); else wx.navigateBack({ fail: () => gotoExecution('today') }); },
}));
