const { getToken } = require('./token');

const KEY_PREFIX = 'junshi.coach.v1.';
const STEPS = [
  { route: '/pages/sessions/index', title: '问策 · 有事问军师', text: '总军师置顶统筹，专业军师分线出策，结论汇回主线。像发微信一样，直接说你的问题。' },
  { route: '/pages/home/index', title: '军情 · 每天的判断', text: '今天的主要矛盾、下一步就做、现在别做，一屏讲清——先判断，再行动。' },
  { route: '/pages/studio/index', title: '军令 · 把话变成事', text: '判断拆成今日任务：做完打卡、回填战果，军师据此修正下一轮判断。' },
  { route: '/pages/thinktank/index', title: '锦囊 · 越攒越值钱', text: '资料、方法、历次方案都留档在这，是你的家底，越攒越厚。' },
  { route: '/pages/profile/index', title: '老板 · 你自己', text: '档案、算力、服务老师都在这里打理。往后有事，随时唤军师。' },
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
function coachPending() { return safeGet(armedKey()) === '1' && safeGet(doneKey()) !== '1'; }
function markDone() { safeSet(doneKey(), '1'); safeRemove(stepKey()); safeRemove(armedKey()); }
function loadStep() { const value = Number(safeGet(stepKey())); return Number.isFinite(value) && value >= 0 && value < STEPS.length ? value : 0; }
function saveStep(step) { safeSet(stepKey(), String(step)); }
function stepForRoute(route) { if (!route) return -1; const normalized = String(route).startsWith('/') ? String(route) : `/${route}`; return STEPS.findIndex((item) => item.route === normalized); }

module.exports = { STEPS, CN, armCoach, coachPending, markDone, loadStep, saveStep, stepForRoute };
