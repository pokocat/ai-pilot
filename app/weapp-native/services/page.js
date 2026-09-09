const store = require('./store');
const { backendEnvironmentData } = require('./backend-environment');

function capsuleMetrics() {
  try {
    const rect = wx.getMenuButtonBoundingClientRect();
    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    if (!rect || !rect.bottom) {
      const navTop = Math.max(20, Number(win && win.statusBarHeight) || 20);
      return { navInset: navTop + 50, navTop, navRowHeight: 40, navRightInset: 16 };
    }
    const capsuleHeight = Math.max(1, Number(rect.height) || 32);
    // 36px 是返回按钮的最小视觉/命中高度；胶囊在这条 36px 行里垂直居中，
    // 行底再留 10px 呼吸，避免按钮贴住标题栏分隔线。
    const navRowHeight = Math.max(36, capsuleHeight);
    const navTop = Math.max(0, (Number(rect.top) || 0) - ((navRowHeight - capsuleHeight) / 2));
    return {
      // 胶囊行底部留白：10 → 18px。10px 时标题「军情/问策」几乎贴着胶囊下沿，真机上整个页头
      // 像是被顶在屏幕边上；抬到 18px 后标题区自己成一块，与状态栏/胶囊明显分层。
      navInset: navTop + navRowHeight + 18,
      navTop,
      navRowHeight,
      navRightInset: Math.max(16, win && win.windowWidth ? win.windowWidth - rect.left + 12 : 16),
    };
  } catch (_) { return { navInset: 70, navTop: 20, navRowHeight: 40, navRightInset: 16 }; }
}

function capsuleInset() { return capsuleMetrics().navInset; }

/**
 * 微信 PC / iPad 在 app.json 开启 resizable 后，页面显示区域会随拖拽、最大化和旋转变化。
 * 这里统一把官方 onResize 返回的 px 尺寸折成三档；页面只消费语义档位，不猜 platform，
 * 因而 Windows 大窗口、macOS 大窗口、iPad 横屏和开发者工具都走同一套布局。
 *
 * ⚠️ 2026-09-05 起 app.json 不再开 `frameset`：官方分栏只在 Windows 微信 3.3+ 生效，
 * 而它一开就把窗口钉成左右两栏 —— 左栏永远是手机宽的 tab 页，右栏在没打开次级页面前
 * 是一整块空白（官方只提供 frameset/placeholder.png 兜底图）。副作用是每一栏都够不到
 * 720 / 960 断点，下面这三档在桌面上从来没被点亮过。改回单栏后窗口宽度就是排版宽度。
 *
 * ⚠️ 2026-09-05 桌面骨架：expanded 门槛 1100 → 960。1100 是拍脑袋定的，实测微信 PC 的
 * 默认窗口约 1008pt 宽，按 1100 算它永远进不了双栏档，双栏做了也白做。960 是倒推的下限：
 * 72 左导航 + 40 页边距 + 24 栏间距 + 320 副栏 = 456，留给主栏 504px，刚好放得下一张完整
 * 军令卡；再窄就该退回单栏。
 */
function viewportData(size) {
  let win = size || null;
  if (!win) {
    try { win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync(); } catch (_) { win = null; }
  }
  const windowWidth = Math.max(1, Number(win && win.windowWidth) || 375);
  const windowHeight = Math.max(1, Number(win && win.windowHeight) || 667);
  const sizeClass = windowWidth >= 960 ? 'expanded' : (windowWidth >= 720 ? 'medium' : 'compact');
  return {
    windowWidth,
    windowHeight,
    viewportClass: `viewport-${sizeClass}${windowWidth > windowHeight ? ' viewport-landscape' : ''}`,
    isLargeScreen: sizeClass !== 'compact',
    // 只有 expanded 才够摆得下常驻侧栏（问策的会话轨）。medium 档窗口一分为二后
    // 两边都不成立，所以要的是这个布尔量，不是 isLargeScreen。
    isExpanded: sizeClass === 'expanded',
  };
}

/* 桌面 chrome 开关：expanded 档由 components/nav-rail 那条 72px 左导航接管导航，
   微信的悬浮胶囊底栏整条收起。隐藏走的是既有的 store.setOverlay（按 key 成对记账，
   custom-tab-bar 用 `wx:if="{{!overlay}}"` 消费），不另开第二套显隐机制。

   两条纪律：
   ① key 必须独立（'desktop-rail'），不能蹭问策浮岛的 'wence-isle'——两边同时记账时，
      任何一方 delete 都会把对方的隐藏一并解除。
   ② 必须成对且幂等。Page.onResize 在拖窗口时是连续触发的（一次拖动上百帧），
      值没变就不能再喊一次 setOverlay：它每次都要 getCurrentPages + syncState。
      更要命的是「只加不减」——窗口缩回手机宽时底栏就再也回不来了。 */
let desktopChromeOn = null;
function syncDesktopChrome(isExpanded) {
  const next = !!isExpanded;
  if (desktopChromeOn === next) return;
  desktopChromeOn = next;
  try {
    if (next) store.setOverlay(true, 'desktop-rail');
    else store.setOverlay(false, 'desktop-rail');
  } catch (_) { desktopChromeOn = null; /* 组件销毁阶段失败就让下一帧重来 */ }
}

function syncViewport(page, size) {
  if (!page || typeof page.setData !== 'function') return null;
  const metrics = capsuleMetrics();
  const next = Object.assign({}, viewportData(size), {
    navInset: metrics.navInset,
    navTop: metrics.navTop,
    navRowHeight: metrics.navRowHeight,
    navRightInset: metrics.navRightInset,
  });
  syncDesktopChrome(next.isExpanded);
  page.setData(next);
  return next;
}

function baseData(extra) {
  const snapshot = store.snapshot();
  const metrics = capsuleMetrics();
  const viewport = viewportData();
  // 冷启动就落在桌面窗口时 onResize 不会补第一帧（它只在尺寸**变化**时触发），
  // 底栏会在第一屏原样浮着。这里没有 page 实例，也不需要——只把 chrome 开关拨到位。
  syncDesktopChrome(viewport.isExpanded);
  return Object.assign({
    themeClass: snapshot.themeClass,
    colorKey: snapshot.colorKey,
    isMock: snapshot.mock,
    navInset: metrics.navInset,
    navTop: metrics.navTop,
    navRowHeight: metrics.navRowHeight,
    navRightInset: metrics.navRightInset,
  }, viewport, backendEnvironmentData(), extra || {});
}

function syncTabBar(page, selected) {
  const snapshot = store.snapshot();
  // reviewDue 是执行 tab 的待复盘红点（store 里按「账本取到过 + 今日未复盘 + 过 21:00」判定）。
  // 此前这里不下发，底栏消费的永远是组件默认的 false —— 红点从来不亮。
  const next = { selected, themeClass: snapshot.themeClass, unread: snapshot.unread, reviewDue: snapshot.reviewDue, overlay: snapshot.overlay };
  const tabbar = page && page.getTabBar && page.getTabBar();
  if (tabbar && tabbar.setData) {
    if (typeof tabbar.syncState === 'function') tabbar.syncState(next);
    else tabbar.setData(next);
  }
  // 桌面档的导航是页面内的 nav-rail（getTabBar 够不到它，而且对话分包页根本没有 tabBar），
  // 角标与主题态得单独送一份，否则 PC 上问策未读数和今日红点永远是组件默认值。
  const rail = page && page.selectComponent && page.selectComponent('.nav-rail');
  if (rail && typeof rail.syncState === 'function') rail.syncState(next);
}

module.exports = { baseData, backendEnvironmentData, capsuleInset, capsuleMetrics, syncTabBar, syncViewport, viewportData };
