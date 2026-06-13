import Taro from '@tarojs/taro';

const LS_TABBAR_HIDDEN = 'junshi.tabbarHidden';
const EVENT_TABBAR_HIDDEN = 'junshi:tabbar-hidden';

function safeSetHidden(hidden: boolean) {
  try { Taro.setStorageSync(LS_TABBAR_HIDDEN, hidden ? '1' : ''); } catch { /* noop */ }
}

export function readTabBarHidden() {
  try { return Taro.getStorageSync(LS_TABBAR_HIDDEN) === '1'; } catch { return false; }
}

function applyNativeTabBarHidden(hidden: boolean) {
  callNativeTabBarApi(hidden);

  try {
    const current = Taro.getCurrentInstance?.()?.page as any;
    const pages = (globalThis as any).getCurrentPages?.() || [];
    const page = current || pages[pages.length - 1];
    page?.getTabBar?.()?.setData?.({ hidden });
  } catch { /* noop */ }
}

function callNativeTabBarApi(hidden: boolean) {
  try {
    const api = hidden ? Taro.hideTabBar : Taro.showTabBar;
    const result = api?.({ animation: false, fail: () => {} } as any);
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch(() => {});
    }
  } catch { /* noop */ }
}

export function syncTabBarHidden(hidden: boolean) {
  safeSetHidden(hidden);
  try { Taro.eventCenter?.trigger?.(EVENT_TABBAR_HIDDEN, hidden); } catch { /* noop */ }

  applyNativeTabBarHidden(hidden);
  setTimeout(() => applyNativeTabBarHidden(hidden), 80);
  setTimeout(() => applyNativeTabBarHidden(hidden), 240);
}

export function hideNativeTabBarOnly() {
  callNativeTabBarApi(true);
  setTimeout(() => callNativeTabBarApi(true), 80);
  setTimeout(() => callNativeTabBarApi(true), 240);
}

export function onTabBarHiddenChange(fn: (hidden: boolean) => void) {
  try { Taro.eventCenter?.on?.(EVENT_TABBAR_HIDDEN, fn); } catch { /* noop */ }
  return () => {
    try { Taro.eventCenter?.off?.(EVENT_TABBAR_HIDDEN, fn); } catch { /* noop */ }
  };
}
