// 屏 11 · 我的作品。生成中 / 已完成 / 已发布 三段 + 空态。
//
// 设计稿里这是一个 tabBar 页；分包做不了 tabBar，改为从快出片首页进入的独立页。
const host = require('../host');
const api = require('../api');
const model = require('../model');
const { POLL_INTERVAL_MS } = require('../config');

const TABS = [
  { key: 'generating', label: '生成中' },
  { key: 'done', label: '已完成' },
  { key: 'published', label: '已发布' },
];

Page({
  data: host.hostBaseData({
    loading: true,
    tabs: TABS,
    active: 'generating',
    works: [],
    visible: [],
    counts: { generating: 0, done: 0, published: 0 },
    showLogin: false,
  }),

  onLoad() { this.load(); },
  onShow() { if (!this.data.loading) this.load(); this.startPolling(); },
  onHide() { this.stopPolling(); },
  onUnload() { this.stopPolling(); },

  /** 列表里有生成中的条目才轮询；全部完成就停，别空转。 */
  startPolling() {
    this.stopPolling();
    if (!this.data.works.some((item) => item.status === 'generating')) return;
    this.timer = setInterval(() => this.load(true), POLL_INTERVAL_MS);
  },

  stopPolling() { if (this.timer) { clearInterval(this.timer); this.timer = null; } },

  load(silent) {
    if (!host.isLoggedIn()) { this.setData({ loading: false, works: [], visible: [] }); return; }
    if (!silent) this.setData({ loading: true });
    api.works()
      .then((works) => {
        const decorated = works.map((item) => Object.assign({}, item, {
          durationText: model.formatDuration(item.durationSec),
        }));
        const counts = {
          generating: decorated.filter((i) => i.status === 'generating').length,
          done: decorated.filter((i) => i.status === 'done').length,
          published: decorated.filter((i) => i.status === 'published').length,
        };
        this.setData({ loading: false, works: decorated, counts });
        this.applyFilter();
        if (!counts.generating) this.stopPolling(); else if (!this.timer) this.startPolling();
      })
      .catch(() => this.setData({ loading: false }));
  },

  applyFilter() {
    this.setData({ visible: this.data.works.filter((item) => item.status === this.data.active) });
  },

  selectTab(event) {
    this.setData({ active: String(event.currentTarget.dataset.key) });
    this.applyFilter();
  },

  openWork(event) {
    const id = String(event.currentTarget.dataset.id || '');
    const work = this.data.works.find((item) => item.id === id);
    if (!work) return;
    if (work.status === 'generating') { host.toast('还在出片，好了会通知你'); return; }
    host.go(`work/index?workId=${encodeURIComponent(id)}`);
  },

  pickTemplate() { host.back(); },

  back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
});
