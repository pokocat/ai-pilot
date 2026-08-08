const KEY = 'junshi.userId';

function getToken() {
  try { return wx.getStorageSync(KEY) || ''; } catch (_) { return ''; }
}

function setToken(value) {
  wx.setStorageSync(KEY, value || '');
}

function clearToken() {
  try { wx.removeStorageSync(KEY); } catch (_) { /* noop */ }
}

module.exports = { KEY, getToken, setToken, clearToken };
