const { withShare } = require('../../../services/share');

function safeDecode(raw) {
  try { return decodeURIComponent(String(raw || '')); } catch (_) { return String(raw || ''); }
}

function isValidUrl(url) {
  return /^https?:\/\/.+/i.test(String(url || '').trim());
}

Page(withShare({
  data: { url: '', valid: false },
  onLoad(options) {
    const url = safeDecode(options && options.url).trim();
    this.setData({ url, valid: isValidUrl(url) });
  },
  back() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) });
  },
  loadError() {
    wx.showToast({ title: '网页打开失败，请稍后重试', icon: 'none' });
  },
}));
