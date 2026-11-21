const { withShare } = require('../../../services/share');
const { approveStudioContainer, cancelStudioConfirmation } = require('../../../services/studio-draft');

Page(withShare({
  data: { error: '' },
  onLoad(options) {
    wx.hideShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    const openId = String(options.openId || '');
    const transactionId = String(options.transactionId || '');
    this._alive = true;
    void approveStudioContainer(this, openId, transactionId).then(() => {
      if (!this._alive) return;
      this._approved = true;
      wx.navigateBack();
    }, (error) => {
      if (this._alive) this.setData({ error: error.message || '授权未完成，请从对话重新打开草稿。' });
    });
  },
  onUnload() {
    this._alive = false;
    if (!this._approved) cancelStudioConfirmation(this);
  },
  back() { wx.navigateBack(); },
}));
