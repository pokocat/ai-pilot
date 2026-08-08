const TAB_ROUTES = new Set([
  '/pages/sessions/index', '/pages/home/index', '/pages/studio/index',
  '/pages/thinktank/index', '/pages/profile/index',
]);

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

module.exports = { navTo, TAB_ROUTES };
