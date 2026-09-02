// 「创作」tab · 模板信息流（设计稿 Home.dc.html，2026-08-26 定稿那版：两列 3:4 卡）。
//
// 起点只有一个：选模板（方案 §3.1）。首页不再是落地页 —— 横幅、三步说明、入口卡都撤了，
// 用户进来看到的就是货架：有几套、哪几套能用、每套多长多少钱。
// 分类条从模板自身的类型推导，不写死一套分类（§13.9 第 13 项：分类字段待定，先用 industry 顶）。
//
// 待办收成右上角一个铃铛：继续上次、数字人训练中、正在出片。点开才是清单，不占首屏。
const host = require('../host');
const api = require('../api');
const { ensureShots } = require('../model');
const { filterOffered } = require('../catalog');
const { withShare } = require('../../../services/share');

/**
 * 已拍板但还没做出来的两套（方案 §0.3 首发三套）。不摆假封面、不给假数字，
 * 卡上写清为什么还不能点。第一天的真实样子就是「三套里只有一套能用」。
 * 做出来之后从 catalog 白名单放出来即可，这里对应的一条删掉。
 */
const UPCOMING = [
  { id: 'ct_qiye', name: '企业宣传片', industry: '品牌故事', cover: 'c3',
    hook: '同一套骨架，讲企业的来历、产线和人',
    blocked: '还在做。要先写好剧本骨架、备齐固定素材，再用真实门店的片子验收。' },
  { id: 'ct_daihuo', name: '短视频带货', industry: '带货', cover: 'c2',
    hook: '明星切片混剪，另一套子系统',
    blocked: '还在做。明星切片的授权谈妥之前不会上线。' },
];
const COVER_BY_TONE = { warm: 'c1', craft: 'c3', street: 'c2', morning: 'c1' };

function fmt(sec) { const s = Math.max(0, Math.round(sec || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

Page(withShare({
  data: host.hostBaseData({
    all: [], list: [], cats: [], cat: '',
    shelfText: '', loadFailed: false, loading: true,
    todoOpen: false, todos: [], todoCount: 0,
    guest: false, showLogin: false, loginReason: 'execute',
  }),

  onLoad() { this.load(); },
  onShow() { this.refreshTodos(); },

  load() {
    this.setData({ guest: !host.isLoggedIn() });
    api.templates()
      .then((rows) => {
        const ready = filterOffered(rows).map((t) => ({
          id: t.id, name: t.name, industry: t.industry || '模板', cover: COVER_BY_TONE[t.coverTone] || 'c1',
          hook: t.description || '', ready: true,
          durText: fmt(t.estDurationSec), avatarSec: t.avatarSecHint, credits: t.creditHint, segmentCount: t.segmentCount,
        }));
        const all = ready.concat(UPCOMING.map((u) => Object.assign({ ready: false }, u)));
        this.setData({ loading: false, loadFailed: false, all, shelfText: `共 ${all.length} 套 · ${ready.length} 套可用` });
        this.applyCat(this.data.cat);
      })
      .catch(() => this.setData({ loading: false, loadFailed: true }));   // 读失败 ≠ 没有模板，分开说
  },

  applyCat(cat) {
    const all = this.data.all;
    const kinds = all.map((t) => t.industry).filter((k, i, xs) => xs.indexOf(k) === i);
    const list = cat ? all.filter((t) => t.industry === cat) : all;
    this.setData({
      cat,
      cats: [{ key: '', label: '全部' }].concat(kinds.map((k) => ({ key: k, label: k }))).map((c) => Object.assign(c, { on: c.key === cat })),
      list: list.map((t) => Object.assign({}, t, { title: t.name + '｜' + t.hook })),
    });
  },
  pickCat(e) { this.applyCat(String(e.currentTarget.dataset.key || '')); },

  openTemplate(e) {
    const id = e.currentTarget.dataset.id; const t = this.data.all.find((x) => x.id === id);
    if (!t) return;
    if (!t.ready) { host.toast(t.blocked || '这套还没上线'); return; }
    host.go(`template/index?templateId=${encodeURIComponent(id)}`);
  },

  /* ── 待办铃铛 ── */
  refreshTodos() {
    if (!host.isLoggedIn()) { this.setData({ guest: true, todos: [], todoCount: 0 }); return; }
    Promise.all([
      api.ongoingProject().catch(() => null),
      api.avatars().then((rows) => ({ rows })).catch(() => ({ failed: true })),   // 读失败别当成「没有」
      api.works().catch(() => null),
    ]).then(([ongoing, avatarResult, works]) => {
      const todos = [];
      if (ongoing) {
        const broll = ensureShots(ongoing.segments || [], ongoing.shots).filter((s) => s.role === 'broll');
        const filled = broll.filter((s) => s.assetId).length;
        const step = ongoing.step === 3 ? 'confirm' : (ongoing.step === 2 ? 'shots' : 'script');
        todos.push({ key: 'ongoing', tone: 'a', title: `继续上次 · ${ongoing.templateName || ongoing.title || ''}`,
          sub: broll.length ? `${broll.length} 个画面段，已配好 ${filled} 个` : '文案还在打磨', action: '继续', go: `${step}/index?projectId=${encodeURIComponent(ongoing.id)}` });
      }
      if (!avatarResult.failed) {
        const rows = avatarResult.rows || [];
        const training = rows.filter((a) => a.imageStatus === 'training');
        if (training.length) todos.push({ key: 'training', tone: 'b', title: '数字人训练中', sub: `${training.length} 个形象，完成会通知你`, action: '看进度', go: 'avatar/index' });
        if (!rows.length) todos.push({ key: 'noavatar', tone: 'a', title: '还没有数字人', sub: '上传一段 5 秒以上正脸视频即可创建', action: '去创建', go: 'clone/index' });
      }
      const generating = Array.isArray(works) ? works.filter((w) => w.status === 'generating' || w.status === 'queued') : [];
      if (generating.length) todos.push({ key: 'rendering', tone: 'c', title: `${generating.length} 条正在出片`, sub: '完成后会在作品里', action: '去看', go: 'works/index?tab=1' });
      this.setData({ guest: false, todos, todoCount: todos.length });
    });
  },
  openTodo() {
    if (!host.requireLogin(this, 'execute')) return;
    host.setOverlay(true, 'video-todo'); this.setData({ todoOpen: true });
  },
  closeTodo() { host.setOverlay(false, 'video-todo'); this.setData({ todoOpen: false }); },
  goTodo(e) { const go = e.currentTarget.dataset.go; this.closeTodo(); if (go) host.go(go); },
  onUnload() { if (this.data.todoOpen) host.setOverlay(false, 'video-todo'); },

  needLogin() { host.requireLogin(this, 'execute'); },
  retry() { this.setData({ loading: true }); this.load(); },
  back() { host.back(); },
  swallow() {},
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); this.refreshTodos(); },
}));
