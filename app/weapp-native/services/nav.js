const TAB_ROUTES = new Set([
  '/pages/sessions/index', '/pages/home/index', '/pages/execution/index',
  '/pages/thinktank/index', '/pages/profile/index',
]);

const EXECUTION_ROUTE = '/pages/execution/index';
let executionIntent = null;
let executionIntentTimer = null;

const LOCK_MS = 800;
let lockedUntil = 0;
let inFlight = false;

function acquire() {
  const now = Date.now();
  if (inFlight || now < lockedUntil) return false;
  inFlight = true;
  lockedUntil = now + LOCK_MS;
  return true;
}

function success() { inFlight = false; }
function fail(error) {
  inFlight = false;
  lockedUntil = 0;
  wx.showToast({ title: '页面打开失败，请重试', icon: 'none' });
  return error;
}

function navTo(url) {
  if (!acquire()) return false;
  const route = String(url || '').split('?')[0];
  if (TAB_ROUTES.has(route)) wx.switchTab({ url: route, success, fail });
  else wx.navigateTo({ url, success, fail });
  return true;
}

/**
 * tabBar 页不能带 query。把「今日 / 本周」做成一次性内存 intent：成功、失败或超时都会清，
 * execution onShow 消费后同样立即清。无新 intent 时页面保留用户原来的段和滚动位置。
 */
function gotoExecution(segment) {
  if (!acquire()) return false;
  const value = segment === 'week' ? 'week' : 'today';
  executionIntent = { segment: value, at: Date.now() };
  if (executionIntentTimer) clearTimeout(executionIntentTimer);
  executionIntentTimer = setTimeout(() => { executionIntent = null; executionIntentTimer = null; }, 1800);
  wx.switchTab({
    url: EXECUTION_ROUTE,
    success: () => { success(); },
    fail: (error) => {
      executionIntent = null;
      if (executionIntentTimer) clearTimeout(executionIntentTimer);
      executionIntentTimer = null;
      fail(error);
    },
  });
  return true;
}

function consumeExecutionIntent() {
  const intent = executionIntent;
  executionIntent = null;
  if (executionIntentTimer) clearTimeout(executionIntentTimer);
  executionIntentTimer = null;
  return intent && (intent.segment === 'today' || intent.segment === 'week') ? intent.segment : '';
}

module.exports = { navTo, gotoExecution, consumeExecutionIntent, TAB_ROUTES };
