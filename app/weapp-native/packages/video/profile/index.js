// 「我的」tab（设计稿 Profile.dc.html）。
//
// 只摆有真数据、有真去处的东西：
//   账号（/me）· 钻石余额（/me/credits，军师钱包，方案 §8.5 说了它是唯一真值）
//   数字人 / 声音 / 素材空间 / 作品 四行，各有自己的页面
// 设计稿里的「连接的应用」是独立形态才有的概念，现在挂在军师里没有这回事，不摆；
// 「充值 / 看套餐」军师那边的入口路由本分包不该写死，先不放按钮，余额旁边说清楚去哪充。
// 「通知 / 保存到相册」两项没有可改的设置项在背后，不摆假开关。
const host = require('../host');
const api = require('../api');
const model = require('../model');

Page({
  data: host.hostBaseData({
    loading: true, guest: false,
    name: '', company: '', phone: '',
    balance: null, balanceFailed: false,
    rows: [],
    version: '',
    showLogin: false, loginReason: 'video',
  }),

  onLoad() { this.load(); },
  onShow() { if (!this.data.loading) this.load(); },

  load() {
    if (!host.isLoggedIn()) { this.setData({ loading: false, guest: true }); return; }
    // store 里的 me 可能还没水合（刚登录 / 冷启动），拿不到就自己去读一次
    const applyMe = (me) => {
      const m = me || {}; const u = m.user || m;
      this.setData({ guest: false, name: u.name || u.nickname || '', company: (m.tenant && m.tenant.name) || u.company || '', phone: maskPhone(u.phone) });
    };
    const cached = host.currentUser();
    if (cached) applyMe(cached); else host.fetchMe().then(applyMe).catch(() => {});

    Promise.all([
      host.myCredits().then((r) => ({ r })).catch(() => ({ failed: true })),
      api.avatars().then((rows) => ({ rows })).catch(() => ({ failed: true })),
      api.voices().then((rows) => ({ rows })).catch(() => ({ failed: true })),
      api.assetStorage().then((s) => ({ s })).catch(() => ({ failed: true })),
      api.works().then((rows) => ({ rows })).catch(() => ({ failed: true })),
    ]).then(([credits, avatars, voices, storage, works]) => {
      // 余额：服务端返回流水 items[].balance，取最新一条；也兼容直接给 balance 的形状
      let balance = null;
      if (!credits.failed) {
        const r = credits.r || {};
        if (typeof r.balance === 'number') balance = r.balance;
        else if (Array.isArray(r.items) && r.items.length && typeof r.items[0].balance === 'number') balance = r.items[0].balance;
      }
      const rows = [
        row('avatar', '数字人', avatars, (x) => countText(x.rows, (a) => a.imageStatus === 'ready', '个可用', '个训练中', (a) => a.imageStatus === 'training'), 'avatar/index'),
        row('voice', '我的声音', voices, (x) => `${(x.rows || []).length} 个`, 'voices/index'),
        row('storage', '素材空间', storage, (x) => x.s ? `${model.formatBytes(x.s.usedBytes)} / ${model.formatBytes(x.s.limitBytes)}` : '', 'assets/index?tab=1'),
        row('works', '作品', works, (x) => `${(x.rows || []).length} 条`, 'works/index?tab=1'),
      ];
      this.setData({ loading: false, balance, balanceFailed: credits.failed, rows });
    });
  },

  goRow(e) { const go = e.currentTarget.dataset.go; if (go) host.go(go); },
  needLogin() { host.requireLogin(this, 'video'); },
  login() { host.requireLogin(this, 'video'); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false, loading: true }); this.load(); },
});

function row(key, name, result, valueOf, go) {
  // 读失败与「没有」分开：失败显示「没读到」，不显示 0
  return { key, name, go, value: result.failed ? '没读到' : valueOf(result), failed: !!result.failed };
}
function countText(rows, isReady, readyUnit, otherUnit, isOther) {
  const list = rows || [];
  const ready = list.filter(isReady).length; const other = list.filter(isOther).length;
  if (!list.length) return '还没有';
  return `${ready} ${readyUnit}` + (other ? ` · ${other} ${otherUnit}` : '');
}
function maskPhone(p) { const s = String(p || ''); return s.length >= 7 ? s.slice(0, 3) + '****' + s.slice(-4) : s; }
