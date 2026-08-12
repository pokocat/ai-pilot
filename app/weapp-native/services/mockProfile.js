// 真机 mock 包的「数据档案」：同一份 mock 数据分两套形态，页面角标即切换入口。
//
//   full  「经营中」——默认档。案卷、军令、兵器、复盘连胜、作品都有，用来验收满态排版。
//   empty 「空态」  ——判断没下、军令没有、作品没有，用来验收各页空态文案与占位。
//
// ★ wx 全局必须 guard：services/mock.js 会被 Node 直接 require 做数据验证（无 wx 全局），
//   那条路径上永远返回默认档案，绝不能因为读 storage 抛异常把验证脚本带崩。
//   要在 Node 下验空态，就给 globalThis.wx 塞一个 storage stub 并写入 junshi.mockProfile。

const STORAGE_KEY = 'junshi.mockProfile';
const DEFAULT_PROFILE = 'full';
/** 档案顺序即 ActionSheet 的选项顺序。 */
const PROFILES = [
  { key: 'full', label: '经营中' },
  { key: 'empty', label: '空态' },
];

function hasStorage() {
  return typeof wx !== 'undefined' && wx && typeof wx.getStorageSync === 'function';
}

function normalize(value) {
  return PROFILES.some((item) => item.key === value) ? value : DEFAULT_PROFILE;
}

/** 当前档案 key：'full' | 'empty'。Node（无 wx）恒为默认档。 */
function current() {
  if (!hasStorage()) return DEFAULT_PROFILE;
  try { return normalize(wx.getStorageSync(STORAGE_KEY)); } catch (_) { return DEFAULT_PROFILE; }
}

/** 角标文案用的中文名：'经营中' | '空态'。 */
function label(key) {
  const target = normalize(key || current());
  return (PROFILES.find((item) => item.key === target) || PROFILES[0]).label;
}

/** 二选一切换：选完先落 storage，再回调（调用方在回调里刷 label + 重新 load 页面数据）。 */
function switchProfile(onDone) {
  if (typeof wx === 'undefined' || !wx || typeof wx.showActionSheet !== 'function') return;
  const active = current();
  wx.showActionSheet({
    itemList: PROFILES.map((item) => `${item.label}${item.key === active ? ' · 当前' : ''}`),
    success: (result) => {
      const picked = PROFILES[Number(result && result.tapIndex)];
      if (!picked) return;
      try { wx.setStorageSync(STORAGE_KEY, picked.key); } catch (_) { /* 写不进去就维持当前档，不弹错 */ }
      if (typeof onDone === 'function') onDone(picked.key);
    },
    fail: () => { /* 取消不是错误 */ },
  });
}

module.exports = { STORAGE_KEY, DEFAULT_PROFILE, PROFILES, current, label, switchProfile };
