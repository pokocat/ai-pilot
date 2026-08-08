const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');

function badge(status) {
  if (status === 'correct') return { badgeText: '正确', badgeClass: 'b-ok' };
  if (status === 'hit') return { badgeText: '命中', badgeClass: 'b-ok' };
  if (status === 'revise') return { badgeText: '需修正', badgeClass: 'b-bad' };
  if (status === 'miss') return { badgeText: '未中', badgeClass: 'b-bad' };
  return { badgeText: '待验证', badgeClass: 'b-wait' };
}

function normalizeItems(items, kind) {
  return (items || []).map((item) => ({
    ...item,
    ...badge(item.status),
    kind,
    text: kind === 'decision' ? item.decision : item.prophecy,
    seqLabel: `${kind === 'decision' ? '决策' : '预言'} #${item.seq}`,
    dueLabel: item.status === 'pending' ? '' : (kind === 'decision' && item.verifyByDate ? `验证期 ${item.verifyByDate}` : kind === 'prophecy' && item.dueDate ? `到期 ${item.dueDate}` : ''),
    disputed: Boolean(item.disputeNote), disputeOpen: false, disputeDraft: '', sending: false,
  }));
}

function statLine(kind, ledger) {
  if (!ledger) return '加载中…';
  const stats = ledger.stats || {};
  if (kind === 'decision') {
    const verified = Number(stats.correct || 0) + Number(stats.revise || 0);
    if (stats.accuracy !== null && stats.accuracy !== undefined) return `准确率 ${stats.accuracy}% · 正确 ${stats.correct || 0} / 需修正 ${stats.revise || 0} · 待验证 ${stats.pending || 0}`;
    if (verified > 0) return `已验证 ${verified} 条 · 先打满 5 条才出准确率 · 待验证 ${stats.pending || 0}`;
    return `共 ${stats.total || 0} 条 · 还没有已验证的决策`;
  }
  const verified = Number(stats.hit || 0) + Number(stats.miss || 0);
  if (stats.hitRate !== null && stats.hitRate !== undefined) return `命中率 ${stats.hitRate}% · 命中 ${stats.hit || 0} / 未中 ${stats.miss || 0} · 待验证 ${stats.pending || 0}`;
  if (verified > 0) return `已验证 ${verified} 条 · 先打满 5 条才出命中率 · 待验证 ${stats.pending || 0}`;
  return `共 ${stats.total || 0} 条 · 还没有已验证的预言`;
}

Page({
  data: baseData({ tab: 'decision', decisions: [], prophecies: [], currentItems: [], statLine: '加载中…', loading: true, error: false, busy: '', showLogin: false }),
  onLoad() { if (!store.isAuthed()) this.setData({ loading: false, showLogin: true }); else this.load(); },
  back() { wx.navigateBack(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
  async load() {
    this.setData({ loading: true, error: false });
    try {
      const [decisions, prophecies] = await Promise.all([api.decisions(), api.prophecies()]);
      this._ledgers = { decision: decisions, prophecy: prophecies };
      this.setData({ decisions: normalizeItems(decisions.items, 'decision'), prophecies: normalizeItems(prophecies.items, 'prophecy'), loading: false });
      this.syncTab();
    } catch (error) {
      const kind = store.handleApiError(error, { silent: true });
      this.setData({ loading: false, error: kind !== 'unauthorized', showLogin: kind === 'unauthorized' });
    }
  },
  retry() { this.load(); },
  selectTab(event) { this.setData({ tab: event.currentTarget.dataset.tab }); this.syncTab(); },
  syncTab() {
    const tab = this.data.tab;
    const currentItems = tab === 'decision' ? this.data.decisions : this.data.prophecies;
    this.setData({ currentItems, statLine: statLine(tab, this._ledgers && this._ledgers[tab]) });
  },
  updateItem(id, patch) {
    const key = this.data.tab === 'decision' ? 'decisions' : 'prophecies';
    const list = this.data[key].map((item) => item.id === id ? { ...item, ...patch } : item);
    this.setData({ [key]: list, currentItems: list });
  },
  async verify(event) {
    const id = event.currentTarget.dataset.id;
    const outcome = event.currentTarget.dataset.outcome;
    const kind = event.currentTarget.dataset.kind;
    if (this.data.busy) return;
    this.setData({ busy: id });
    try {
      const result = kind === 'decision' ? await api.verifyDecision(id, outcome) : await api.verifyProphecy(id, outcome);
      const updated = result && (kind === 'decision' ? result.decision : result.prophecy);
      this.updateItem(id, { ...(updated || { status: outcome }), ...badge(updated && updated.status || outcome) });
      if (result && result.stats && this._ledgers) this._ledgers[kind].stats = result.stats;
      this.setData({ statLine: statLine(kind, this._ledgers && this._ledgers[kind]) });
    } catch (error) { store.handleApiError(error, { fallbackTitle: error.message || '验证失败' }); }
    finally { this.setData({ busy: '' }); }
  },
  toggleDispute(event) { const id = event.currentTarget.dataset.id; this.updateItem(id, { disputeOpen: true }); },
  cancelDispute(event) { const id = event.currentTarget.dataset.id; this.updateItem(id, { disputeOpen: false, disputeDraft: '' }); },
  inputDispute(event) { this.updateItem(event.currentTarget.dataset.id, { disputeDraft: event.detail.value || '' }); },
  async submitDispute(event) {
    const id = event.currentTarget.dataset.id;
    const kind = event.currentTarget.dataset.kind;
    const item = this.data.currentItems.find((row) => row.id === id);
    const note = item && String(item.disputeDraft || '').trim();
    if (!note || item.sending) return;
    this.updateItem(id, { sending: true });
    try {
      if (kind === 'decision') await api.disputeDecision(id, note); else await api.disputeProphecy(id, note);
      this.updateItem(id, { sending: false, disputed: true, disputeOpen: false, disputeDraft: '' });
    } catch (error) { this.updateItem(id, { sending: false }); store.handleApiError(error, { fallbackTitle: '提交失败，请重试' }); }
  },
});
