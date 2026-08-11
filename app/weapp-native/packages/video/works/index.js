// 屏 11 · 我的作品。默认全部，生成中 / 已完成只作为筛选。
//
// 设计稿里这是一个 tabBar 页；分包做不了 tabBar，改为从快出片首页进入的独立页。
const host = require('../host');
const api = require('../api');
const model = require('../model');
const { POLL_INTERVAL_MS } = require('../config');

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'generating', label: '生成中' },
  { key: 'done', label: '已完成' },
];

Page({
  data: host.hostBaseData({
    loading: true,
    tabs: TABS,
    active: 'all',
    works: [],
    visible: [],
    counts: { all: 0, generating: 0, done: 0 },
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
          all: decorated.length,
          generating: decorated.filter((i) => i.status === 'generating').length,
          done: decorated.filter((i) => i.status === 'done' || i.status === 'published').length,
        };
        this.setData({ loading: false, works: decorated, counts });
        this.applyFilter();
        if (!counts.generating) this.stopPolling(); else if (!this.timer) this.startPolling();
      })
      .catch(() => this.setData({ loading: false }));
  },

  applyFilter() {
    const active = this.data.active;
    this.setData({ visible: this.data.works.filter((item) => active === 'all'
      || (active === 'done' ? item.status === 'done' || item.status === 'published' : item.status === active)) });
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
