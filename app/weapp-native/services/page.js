const store = require('./store');

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
      navInset: navTop + navRowHeight + 10,
      navTop,
      navRowHeight,
      navRightInset: Math.max(16, win && win.windowWidth ? win.windowWidth - rect.left + 12 : 16),
    };
  } catch (_) { return { navInset: 70, navTop: 20, navRowHeight: 40, navRightInset: 16 }; }
}

function capsuleInset() { return capsuleMetrics().navInset; }

function baseData(extra) {
  const snapshot = store.snapshot();
  const metrics = capsuleMetrics();
  return Object.assign({
    themeClass: snapshot.themeClass,
    colorKey: snapshot.colorKey,
    isMock: snapshot.mock,
    navInset: metrics.navInset,
    navTop: metrics.navTop,
    navRowHeight: metrics.navRowHeight,
    navRightInset: metrics.navRightInset,
  }, extra || {});
}

function syncTabBar(page, selected) {
  const tabbar = page && page.getTabBar && page.getTabBar();
  if (tabbar && tabbar.setData) {
    const snapshot = store.snapshot();
    const next = { selected, themeClass: snapshot.themeClass, unread: snapshot.unread, overlay: snapshot.overlay };
    if (typeof tabbar.syncState === 'function') tabbar.syncState(next);
    else tabbar.setData(next);
  }
}

module.exports = { baseData, capsuleInset, capsuleMetrics, syncTabBar };
