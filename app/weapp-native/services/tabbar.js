// 底栏五 tab 的唯一定义（路径 / 图标 / 文案 / 主题态图标资产）。
//
// 两个渲染方共用它：`custom-tab-bar/index.js`（常规底栏）与 `pages/sessions` 终态的底部合体浮岛
// 里那排自绘 tab。浮岛必须与底栏**完全同源**——顺序、图标、选中态、角标口径各写一份的话，
// 问策 tab 上的那排迟早和其余四个 tab 长得不一样（图标换了、顺序调了只改了一处）。
// 角标数据同样只有一个来源：`store.snapshot().unread`（syncUnread 聚合全部会话未读）。

// 2026-08 IA 重排：沙盘+点兵合并为战局；锦囊改为作品页（pages/pouch，束口袋字形归它）；
// 原锦囊页（thinktank）改叫图籍，用新画的 codex（两册线装书）——点兵那枚 muster 是打勾名册，
// 语义是「点检」不是「档案」，不合图籍。
const TABS = [
  { path: '/pages/sessions/index', icon: 'counsel', text: '问策' },
  { path: '/pages/home/index', icon: 'sandtable', text: '战局' },
  { path: '/pages/pouch/index', icon: 'brocade', text: '锦囊' },
  { path: '/pages/thinktank/index', icon: 'codex', text: '图籍' },
  { path: '/pages/profile/index', icon: 'lord', text: '主公' },
];

const THEME_TONES = ['gold', 'green', 'red', 'blue', 'purple', 'iron'];

function toneOf(themeClass) {
  const tone = String(themeClass || '').replace(/^theme-/, '');
  return THEME_TONES.includes(tone) ? tone : 'green';
}

function visualTabs(themeClass) {
  const activeTone = toneOf(themeClass);
  return TABS.map((item) => Object.assign({}, item, {
    iconNormal: `/assets/native-icons/${item.icon}-neutral.svg`,
    iconActive: `/assets/native-icons/${item.icon}-${activeTone}.svg`,
  }));
}

module.exports = { TABS, toneOf, visualTabs };
