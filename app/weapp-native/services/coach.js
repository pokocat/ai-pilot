const { getToken } = require('./token');

const KEY_PREFIX = 'junshi.coach.v1.';
const STEPS = [
  // 问策入口有两种形态（列表 / 对话即 tab），coach 数据是静态的，所以这句要两边都说得通：
  // 「直接说」在两种形态下都成立，「军师团 / 历史看右上」在终态是页头双入口、在列表态是搜索行右侧，
  // 都在右上方向，不误导。别写成只描述其中一种形态的话术。
  { route: '/pages/sessions/index', title: '问策 · 有事问军师', text: '有事直接说，总军师在这等你。换专业军师、翻旧对话都在右上角；结论会汇回主线判断。' },
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
