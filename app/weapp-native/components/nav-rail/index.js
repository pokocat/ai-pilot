// 桌面 expanded 档（≥960px）的 72px 通高左导航。
//
// 为什么不是把官方 custom-tab-bar 拉成一整列：那条底栏由微信放在它自己的固定容器里，
// 把容器改成整列高之后命中区会不会跟着走没有任何保证（这类改法在真机上翻车的概率不低）。
// 走的是已经验证过的那条路——桌面档用 store.setOverlay('desktop-rail') 把 custom-tab-bar
// 整条隐藏（见 services/page.js#syncDesktopChrome），导航换成这个我们自己的组件，
// 由五个 tab 页 + 对话分包页各引一次；定位、命中区、层级全在我们手里。
//
// 附带好处：官方 custom-tab-bar 只在 tabBar 页渲染，二级页天生没有导航。这个组件没这条限制，
// 所以桌面上从 tab 进到对话分包页时，左边那条不会突然消失。
// 范围要划死：只给五个 tab + 对话分包页挂。packages/work 下另外二十多个二级页
// （方案库、命盘、账本…）保持「全宽 + 返回」，它们本来就是进去办一件事就出来。
//
// tab 表、主题态图标与切换动作全部来自 services/tabbar.js，与底栏、问策浮岛同源。
const { visualTabs, switchToTab } = require('../../services/tabbar');
const store = require('../../services/store');

Component({
  properties: {
    selected: { type: Number, value: 0 },
    // 由页面下发 isExpanded：为假时整条不渲染（不是 display:none —— 手机档连节点都不该有）。
    show: { type: Boolean, value: false },
  },
  data: { tabs: visualTabs('theme-green'), themeClass: 'theme-green', unread: 0, reviewDue: false },
  lifetimes: {
    attached() {
      // syncTabBar 只在页面 onShow 之类的时机推一次；组件挂载得比它早，
      // 先自己从 store 取一份初值，否则第一帧的主题色与角标都是默认值。
      const snapshot = store.snapshot();
      this.syncState({ themeClass: snapshot.themeClass, unread: snapshot.unread, reviewDue: snapshot.reviewDue });
    },
  },
  methods: {
    // 与 custom-tab-bar#syncState 同签名同语义：services/page.js#syncTabBar 一份数据推两处。
    syncState(next) {
      const themeClass = (next && next.themeClass) || this.data.themeClass;
      this.setData(Object.assign({}, next || {}, { themeClass, tabs: visualTabs(themeClass) }));
    },
    switchTab(event) {
      switchToTab(Number(event.currentTarget.dataset.index), this.data.selected);
    },
  },
});
