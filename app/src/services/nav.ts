import Taro from '@tarojs/taro';

// 防重入导航（A4）：小程序连点/快速双击极易触发两次 navigateTo，
// 造成同页重复入栈或重复建单。这里做一个进程级的 800ms 时间锁 + in-flight 锁：
//   - 800ms 内的重复调用直接忽略（返回 false，不发起跳转）；
//   - navigateTo/switchTab 的 fail 回调里立即释放锁，避免失败后被锁死。
// 覆盖 navigateTo / redirectTo / switchTab / navigateBack 四类薄封装。

const LOCK_MS = 800;
let lockedUntil = 0;
let inFlight = false;

function acquire(): boolean {
  const now = Date.now();
  if (inFlight || now < lockedUntil) return false;
  inFlight = true;
  lockedUntil = now + LOCK_MS;
  return true;
}

function release() {
  inFlight = false;
  lockedUntil = 0;
}

type NavOpts = { fail?: (err: any) => void; success?: () => void; complete?: () => void };

/** 防重入 navigateTo。被锁时返回 false 且不跳转；失败时释放锁并回调 opts.fail。 */
export function navTo(url: string, opts: NavOpts = {}): boolean {
  if (!acquire()) return false;
  Taro.navigateTo({
    url,
    success: () => { inFlight = false; opts.success?.(); },
    fail: (err) => { release(); opts.fail?.(err); },
    complete: opts.complete,
  });
  return true;
}

/** 防重入 switchTab（tab 页跳转）。 */
export function switchTo(url: string, opts: NavOpts = {}): boolean {
  if (!acquire()) return false;
  Taro.switchTab({
    url,
    success: () => { inFlight = false; opts.success?.(); },
    fail: (err) => { release(); opts.fail?.(err); },
    complete: opts.complete,
  });
  return true;
}

/** 防重入 redirectTo（替换当前页）。 */
export function redirectToGuarded(url: string, opts: NavOpts = {}): boolean {
  if (!acquire()) return false;
  Taro.redirectTo({
    url,
    success: () => { inFlight = false; opts.success?.(); },
    fail: (err) => { release(); opts.fail?.(err); },
    complete: opts.complete,
  });
  return true;
}

/** 防重入 navigateBack。 */
export function backGuarded(delta = 1): boolean {
  if (!acquire()) return false;
  Taro.navigateBack({
    delta,
    success: () => { inFlight = false; },
    fail: () => { release(); },
  });
  return true;
}
