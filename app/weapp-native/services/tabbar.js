// 底栏五 tab 的唯一定义（路径 / 图标 / 文案 / 主题态图标资产）。
//
// 三个渲染方共用它：`custom-tab-bar/index.js`（手机悬浮胶囊底栏）、`components/nav-rail`
// （桌面 expanded 档的 72px 左导航）与 `pages/sessions` 终态的底部合体浮岛里那排自绘 tab。
// 它们必须**完全同源**——顺序、图标、选中态、角标口径各写一份的话，
// 问策 tab 上的那排迟早和其余四个 tab 长得不一样（图标换了、顺序调了只改了一处）。
// 角标数据同样只有一个来源：`store.snapshot().unread`（syncUnread 聚合全部会话未读）。

const { gotoExecution } = require('./nav');

// 2026-08-18 IA 回归：战局只做判断；军令/打卡/回填/复盘回到独立执行 tab。
// muster（打勾名册）用于日常执行点检。
// 2026-08-19：锦囊主体内联进今日页尾（手艺行 + 作品带），只留一个跨手艺档案子页 pages/pouch。
const TABS = [
  { path: '/pages/sessions/index', icon: 'counsel', text: '问策' },
  { path: '/pages/home/index', icon: 'sandtable', text: '战局' },
  { path: '/pages/execution/index', icon: 'muster', text: '今日' },
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

/**
 * 五 tab 的切换动作，也只有这一份。
 *
 * 2026-09-05 起有两个渲染方各带一套导航：手机上的 `custom-tab-bar`（悬浮胶囊底栏）与
 * 桌面 expanded 档的 `components/nav-rail`（72px 左导航）。两边把 `wx.switchTab` 各抄一遍
 * 的话，差异不会当场暴露 —— 会在某次只改了一处之后，从「今日在底栏能带段控、在左导航
 * 不能」这类症状里冒出来。index 2 的特殊性正是这种容易漏抄的东西：今日 tab 必须走
 * `gotoExecution('today')` 才能把段控意图带过去（见 services/nav.js 的 executionIntent），
 * 直接 switchTab 会落在上一次的段上。
 *
 * 去重必须按**当前真实路由**判，不能按 selected（2026-09-05 复审修）：
 * `selected` 是「这一项要高亮」的口径，不是「现在就在这个 tab 上」。对话分包页
 * （packages/main/chat）传的是 `selected="{{0}}"` —— 它属于问策这条线所以高亮问策，
 * 但它本身是一个非 tab 的分包页。按 selected 去重的话，在对话页点左导航「问策」
 * 会命中 `0 === 0` 直接 return，表现为「点了没反应」，用户回不去问策首页。
 * 换成路由判之后这一击走 wx.switchTab：切 tab 会关掉栈里所有非 tab 页，
 * 正是从对话页回问策首页要的行为。
 * `selected` 仍保留在签名里 —— 两个渲染方都按位置传参，且它还是组件自己的高亮口径；
 * 只是不再参与去重。
 *
 * @param {number} index  被点的 tab 下标
 * @param {number} selected  该渲染方当前高亮的下标（仅高亮用，不参与去重）
 */
function switchToTab(index, selected) {  // eslint-disable-line no-unused-vars
  const target = Number(index);
  if (!Number.isInteger(target) || target < 0 || target >= TABS.length) return;
  if (target === 2) { gotoExecution('today'); return; }
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
  const route = pages.length ? pages[pages.length - 1].route : '';
  if (TABS[target].path.replace(/^\//, '') === route) return;
  wx.switchTab({ url: TABS[target].path });
}

module.exports = { TABS, toneOf, visualTabs, switchToTab };
