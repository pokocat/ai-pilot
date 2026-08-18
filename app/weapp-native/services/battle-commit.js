const { api } = require('./api');
const { navTo } = require('./nav');
const store = require('./store');

function codeOf(error) { return String((error && (error.code || (error.data && error.data.code))) || ''); }

/** 战局与执行共用的一份出令错误分流；成功返回 true，失败已向用户说明并返回 false。 */
async function commitBattle() {
  try {
    await api.battleCommit();
    wx.showToast({ title: '军令和方案已出', icon: 'none' });
    return true;
  } catch (error) {
    const code = codeOf(error);
    if (code === 'PLAN_EXPIRED') {
      wx.showModal({ title: '方案已到期', content: '续费后可继续生成军令与方案。', confirmText: '去续费', success: (result) => { if (result.confirm) navTo('/packages/work/plans/index'); } });
    } else if (code === 'INSUFFICIENT_QUOTA' || code === 'INSUFFICIENT_CREDITS' || code === 'SKU_REQUIRED') {
      wx.showModal({ title: '算力不足', content: '当前额度不足，可补充算力或调整方案后继续。', confirmText: '查看算力', success: (result) => { if (result.confirm) navTo('/packages/work/credits/index'); } });
    } else store.handleApiError(error, { fallbackTitle: error.message || '生成失败' });
    return false;
  }
}

module.exports = { commitBattle };
