import Taro from '@tarojs/taro';

const LS_TABBAR_HIDDEN = 'junshi.tabbarHidden';
const EVENT_TABBAR_HIDDEN = 'junshi:tabbar-hidden';

function safeSetHidden(hidden: boolean) {
  try { Taro.setStorageSync(LS_TABBAR_HIDDEN, hidden ? '1' : ''); } catch { /* noop */ }
}

export function readTabBarHidden() {
  try { return Taro.getStorageSync(LS_TABBAR_HIDDEN) === '1'; } catch { return false; }
}

function applyTabBarState(hidden: boolean) {
  // app.json 使用 custom tabBar。微信原生 tabbar 必须始终保持隐藏；
  // hidden 只控制我们自己的胶囊底栏，否则关闭弹层时 showTabBar 会把默认底栏唤出来。
  hideNativeTabBar();

  try {
    const current = Taro.getCurrentInstance?.()?.page as any;
    const pages = (globalThis as any).getCurrentPages?.() || [];
    const page = current || pages[pages.length - 1];
    page?.getTabBar?.()?.setData?.({ hidden });
  } catch { /* noop */ }
}

function hideNativeTabBar() {
  try {
    const result = Taro.hideTabBar?.({ animation: false, fail: () => {} } as any);
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch(() => {});
    }
  } catch { /* noop */ }
}

export function syncTabBarHidden(hidden: boolean) {
  safeSetHidden(hidden);
  try { Taro.eventCenter?.trigger?.(EVENT_TABBAR_HIDDEN, hidden); } catch { /* noop */ }

  applyTabBarState(hidden);
  setTimeout(() => applyTabBarState(hidden), 80);
  setTimeout(() => applyTabBarState(hidden), 240);
}

export function hideNativeTabBarOnly() {
  hideNativeTabBar();
  setTimeout(() => hideNativeTabBar(), 80);
  setTimeout(() => hideNativeTabBar(), 240);
}

export function onTabBarHiddenChange(fn: (hidden: boolean) => void) {
  try { Taro.eventCenter?.on?.(EVENT_TABBAR_HIDDEN, fn); } catch { /* noop */ }
  return () => {
    try { Taro.eventCenter?.off?.(EVENT_TABBAR_HIDDEN, fn); } catch { /* noop */ }
  };
}
