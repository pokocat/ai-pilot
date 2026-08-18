/**
 * 邀请码捕获与暂存（裂变归因的入口一侧）。
 *
 * 谁在往这里写：`app.js` 的 onLaunch / onShow —— 分享卡带的 `?ic=`、小程序码带的 scene。
 * 谁在读：`services/api.js` 的登录调用，登录成功后由 `store.afterLogin` 清掉。
 *
 * **冷启动与每次前台都要捕获**：游客也可能从分享链接进来，他之后某一刻才登录，
 * 那一刻才用得上这个码；只在 onLaunch 捕获会漏掉「小程序已在后台、从分享卡再次进入」这条路径。
 *
 * **铁律：捕获绝不触发任何跳转或登录弹层。** 2026-08-05 微信审核整改后启动一律落首页、
 * 游客可浏览（驳回原因正是「未浏览体验服务即要求授权登录」）。捕获到码只是记一笔，
 * 什么时候登录仍然完全由用户的动作决定。
 *
 * **形状校验而不是照单全收**：scene 通道将来可能被别的用途共用（ai-society 那边邀请码
 * `FLM-` 与管理台扫码票据 `S`+24hex 就共用 scene、各认自己的形状互不误吞）。这里只认
 * 本仓邀请码的形状，别人的参数原样放过，不吞不改。
 */

// storage key 跟随本仓惯例（`junshi.userId` / `junshi.color` 同族，点号分段）。
const KEY = 'junshi.invite';
const AT_KEY = 'junshi.inviteAt';

// 与服务端 `server/src/services/community.ts` 的 Crockford base32 字母表同源：
// "JS" + 4 位，去掉易混的 I/L/O/U。大小写敏感——服务端生成的一定是大写。
const SHAPE = /^JS[0-9A-HJKMNP-TV-Z]{4}$/;

function isInviteCode(value) {
  return typeof value === 'string' && SHAPE.test(value);
}

function safeGet(key) {
  try { return wx.getStorageSync(key) || ''; } catch (_) { return ''; }
}

/**
 * 落地打开埋点（`invite_landing`，邀请漏斗第二段）。
 *
 * **必须能在游客态工作**：点开分享卡的那个人此刻还没有账号，他正是漏斗的分母。
 * `POST /events` 鉴权可选（无 token = 游客、userId 记空），`api.track` 也是无 token 就不带头，
 * 所以这条路天然通。
 *
 * **必须绝对不影响启动**：这段代码跑在 `app.js` 的 `onLaunch` 极早期——store 还没 bootstrap、
 * token 可能还没读出来。`api.track` 自身是 fire-and-forget + 全静默（裸 wx.request，失败空回调），
 * 外面再包一层 try：模块没加载起来、宿主没有 wx、什么都可能，**都不许把冷启动带崩**。
 *
 * 为什么在函数体内 `require('./api')` 而不是文件顶部：`services/api.js` 顶层就
 * `require('./invite')`（登录请求统一带邀请码），顶部引用直接成环——Node 的 CJS 环不报错，
 * 但先加载的那一侧会拿到**半初始化**的 exports，症状是静默变哑（`api` 是 undefined 而不是报错），
 * 正是最难查的一类。放在调用时点则两边都已加载完毕（onLaunch 时 store→api 这条链早就跑完了）。
 */
function trackLanding(channel) {
  try {
    require('./api').api.track('invite_landing', { channel });
  } catch (_) { /* 埋点不可用：捕获照常、启动照常 */ }
}

/**
 * 从启动 / 页面参数里捕获邀请码。
 *
 * 覆盖口径 = **末次触点**：新码覆盖旧码，捕获时间一并更新。理由：用户先点了 A 的分享没注册、
 * 又点了 B 的分享才注册，促成转化的是 B；而归因窗口也应该从最后一次接触算起。
 * 「一人只归因一个邀请人」是**绑定**那一刻的公理（服务端 `Referral.userId` 主键保证，
 * 绑定后不可变更），不是捕获阶段的约束——这两件事别混。
 */
function captureInvite(options) {
  const source = options || {};
  const query = source.query || source || {};
  let code = isInviteCode(query.ic) ? query.ic : '';
  // 通道：query = 分享卡 `?ic=`；scene = 小程序码（海报）。埋点只报这一个枚举，不报码本身
  // ——邀请码是可以反查到人的，埋点库没有必要存它（服务端在绑定时点已经完整留痕了 attribution）。
  let channel = code ? 'query' : '';
  if (!code && typeof query.scene === 'string') {
    // scene 由微信按 URL 编码回传；解码失败绝不能让启动流程抛出去。
    let scene = '';
    try { scene = decodeURIComponent(query.scene); } catch (_) { scene = query.scene; }
    // scene 可能是裸邀请码，也可能是 `ic:JSxxxx` 这种带前缀的形态（海报小程序码用后者，
    // 给将来的多用途 scene 留出命名空间）。
    const candidate = scene.indexOf('ic:') === 0 ? scene.slice(3) : scene;
    if (isInviteCode(candidate)) { code = candidate; channel = 'scene'; }
  }
  if (!code) return '';
  try {
    wx.setStorageSync(KEY, code);
    wx.setStorageSync(AT_KEY, Date.now());
  } catch (_) { /* 存不下就这一跳不计归因，不影响任何功能 */ }
  // **每次捕获都报**，包括 onShow 那次「小程序已在后台、又点了一张分享卡」——重复进入本身
  // 就是漏斗要看的数据（同一个人被同一张卡拉回来几次），去重交给取数侧，不在端上偷偷合并。
  // 放在 storage 之后：存不存下都算落地打开了（存不下只是这一跳不计归因），但先把码稳住再上报。
  trackLanding(channel);
  return code;
}

/** 当前暂存的邀请码（没有则空串）。形状再校验一次：storage 可能被历史脏数据污染。 */
function currentInviteCode() {
  const code = safeGet(KEY);
  return isInviteCode(code) ? code : '';
}

/** 捕获时刻（ms epoch），没有则 0。归因窗口由服务端判定，这里只如实上报。 */
function capturedAt() {
  const at = Number(safeGet(AT_KEY));
  return Number.isFinite(at) && at > 0 ? at : 0;
}

/**
 * 登录请求要带的归因参数。没码时返回空对象——**请求体里不要出现 undefined 字段**。
 * 归因窗口（默认 30 天）的判定权在服务端（窗口值归运营后台配置），
 * 客户端不写死任何业务天数，只负责如实上报「码」和「什么时候拿到的」。
 */
function inviteParams() {
  const code = currentInviteCode();
  if (!code) return {};
  const at = capturedAt();
  return at ? { inviteCode: code, inviteCodeAt: at } : { inviteCode: code };
}

/**
 * 清掉暂存的码。由 `store.afterLogin` 在登录成功后调用：
 * 码是一次性的归因凭证，用过即弃。不清的话每次登录都会重复上报同一个码，
 * 服务端每次都要落一条 `already_bound` 的归因日志——那是纯噪音，会把风控视图弄脏。
 */
function clearInvite() {
  try {
    wx.removeStorageSync(KEY);
    wx.removeStorageSync(AT_KEY);
  } catch (_) { /* noop */ }
}

module.exports = { KEY, AT_KEY, SHAPE, isInviteCode, captureInvite, currentInviteCode, capturedAt, inviteParams, clearInvite };
