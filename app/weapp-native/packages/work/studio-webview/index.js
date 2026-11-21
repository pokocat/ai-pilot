const { withShare } = require('../../../services/share');
const { attachStudioContainer, releaseStudioContainer } = require('../../../services/studio-draft');

Page(withShare({
  data: { url: '', error: '' },
  onLoad() {
    wx.hideShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    const intent = attachStudioContainer(this);
    this.setData(intent ? { url: intent.url } : { error: '请从军师对话打开声量AI草稿。' });
  },
  onUnload() { releaseStudioContainer(this); },
  loadError() { this.setData({ url: '', error: '网页打开失败，请回对话重试。' }); },
  back() { wx.navigateBack(); },
}));
