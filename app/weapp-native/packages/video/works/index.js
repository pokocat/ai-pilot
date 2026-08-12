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
          createdText: model.workTimeText(item),
        }));
        this.setWorks(decorated);
      })
      .catch(() => this.setData({ loading: false }));
  },

  setWorks(works) {
    const rows = Array.isArray(works) ? works : [];
    const counts = {
      all: rows.length,
      generating: rows.filter((i) => i.status === 'generating').length,
      done: rows.filter((i) => i.status === 'done' || i.status === 'published').length,
    };
    this.setData({ loading: false, works: rows, counts });
    this.applyFilter();
    if (!counts.generating) this.stopPolling(); else if (!this.timer) this.startPolling();
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

  removeWork(event) {
    const id = String(event.currentTarget.dataset.id || '');
    const work = this.data.works.find((item) => item.id === id);
    if (!work) return;
    const generating = work.status === 'generating';
    host.confirm({
      title: generating ? '取消并删除作品？' : '删除这个作品？',
      content: generating
        ? '删除后会取消正在生成的任务，并从作品集移除。'
        : '删除后作品会从作品集移除，成片将无法再打开。',
      confirmText: '删除',
    }).then((confirmed) => {
      if (!confirmed) return;
      this.stopPolling();
      host.loading('正在删除');
      api.deleteWork(id)
        .then(() => {
          host.hideLoading();
          this.setWorks(this.data.works.filter((item) => item.id !== id));
          host.toast('作品已删除', 'success');
        })
        .catch((error) => {
          host.hideLoading();
          this.startPolling();
          host.toast(error && error.message ? error.message : '删除失败');
        });
    });
  },

  pickTemplate() { host.back(); },

  back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
});
