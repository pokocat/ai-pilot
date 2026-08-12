const { getToken } = require('./token');

// v1→v2：2026-08 IA 重排（战局合并、锦囊改作品、图籍接家底）。键位升版 + coachPending 里的
// legacyDone 兜底，让走完过 v1 引导的老用户自动补一轮 v2，认识换了位的三个 tab；只补一次。
const KEY_PREFIX = 'junshi.coach.v2.';
const LEGACY_DONE_PREFIX = 'junshi.coach.v1.';
const STEPS = [
  // 问策入口有两种形态（列表 / 对话即 tab），coach 数据是静态的，所以这句要两边都说得通：
  // 「直接说」在两种形态下都成立，「军师团 / 历史看右上」在终态是页头双入口、在列表态是搜索行右侧，
  // 都在右上方向，不误导。别写成只描述其中一种形态的话术。
  { route: '/pages/sessions/index', title: '问策 · 有事问军师', text: '有事直接说，总军师在这等你。换专业军师、翻旧对话都在右上角；结论会汇回主线判断。' },
  { route: '/pages/home/index', title: '战局 · 判断与今日的事', text: '上半是判断：主要矛盾、三势、现在别做；下半是今日军令：做完打卡、回填战果，军师据此调明天。' },
  { route: '/pages/pouch/index', title: '锦囊 · 军师替你出的成品', text: '方案、海报、成片都住在这里，随时翻出来分享或照着再来一件。' },
  { route: '/pages/thinktank/index', title: '图籍 · 军师断事的依据', text: '资料和数据源都收在这。图籍越厚，军师断事越准。' },
  { route: '/pages/profile/index', title: '主公 · 你自己', text: '档案、算力、服务老师都在这里打理。往后有事，随时唤军师。' },
];
const CN = ['一', '二', '三', '四', '五'];

function suffix() { return getToken() || 'anon'; }
function doneKey() { return `${KEY_PREFIX}${suffix()}`; }
function stepKey() { return `${KEY_PREFIX}step.${suffix()}`; }
function armedKey() { return `${KEY_PREFIX}armed.${suffix()}`; }
function safeGet(key) { try { return wx.getStorageSync(key); } catch (_) { return ''; } }
function safeSet(key, value) { try { wx.setStorageSync(key, value); } catch (_) { /* noop */ } }
function safeRemove(key) { try { wx.removeStorageSync(key); } catch (_) { /* noop */ } }

function armCoach() { safeSet(armedKey(), '1'); }
function legacyDone() { return safeGet(`${LEGACY_DONE_PREFIX}${suffix()}`) === '1'; }
function coachPending() { if (safeGet(doneKey()) === '1') return false; return safeGet(armedKey()) === '1' || legacyDone(); }
function markDone() { safeSet(doneKey(), '1'); safeRemove(stepKey()); safeRemove(armedKey()); }
function loadStep() { const value = Number(safeGet(stepKey())); return Number.isFinite(value) && value >= 0 && value < STEPS.length ? value : 0; }
function saveStep(step) { safeSet(stepKey(), String(step)); }
function stepForRoute(route) { if (!route) return -1; const normalized = String(route).startsWith('/') ? String(route) : `/${route}`; return STEPS.findIndex((item) => item.route === normalized); }

module.exports = { STEPS, CN, armCoach, coachPending, markDone, loadStep, saveStep, stepForRoute };
