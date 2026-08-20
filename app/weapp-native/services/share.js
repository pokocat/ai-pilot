/**
 * 全站分享（转发给朋友 + 分享到朋友圈）。
 *
 * 改动前：54 个页面里只有 4 个实现了 onShareAppMessage（天时日历 / 命盘 / 速诊 / 快拍成片），
 * 5 个 tab 页一个都没有——微信的规则是页面不实现该回调，右上角 ··· 里的「转发给朋友」就是**置灰**的，
 * 于是用户在主界面看到的转发永远点不动，观感就是「这小程序不能转发」。朋友圈（onShareTimeline）
 * 更是全站零实现，菜单项根本不出现。
 *
 * ## 为什么分享内容与页面解耦
 *
 * 本次定的口径是**任何页面都可以分享，但分享出去的是固定的内置海报素材（图 + 文案）轮动**，
 * 落地页统一指向一个对陌生游客友好的公开页。这样做同时解决三件事：
 *   ① 私密页（账本 / 档案 / 绑定 / 算力 / 支付）转发出去不会暴露当前页，收到的人不会撞上
 *      别人的空态或登录门；
 *   ② 素材由运营统一精修，不必为 54 个页面各写一套标题；
 *   ③ 分享卡的样子可预期，出问题好排查。
 * 已经有自定义分享的那 4 个页面**保留自己的成果型分享**（分享「我的命盘 / 我的天时日历」
 * 比通用海报有效得多），只把 path 补上邀请码。
 *
 * ## 为什么用 Object.assign 而不是 Behavior
 *
 * 页面级 `behaviors` 对生命周期函数的合并语义随基础库版本有差异，而分享回调漏挂是**静默失效**
 * ——按钮变灰但不报错，代码 review 看不出来，只有真机点开 ··· 菜单才发现。`Object.assign`
 * 是确定的 JS 语义，不依赖框架实现。（同一理由见 ai-society `behaviors/share.js` 的文件头。）
 *
 * ## 归因
 *
 * 分享路径统一带自己的邀请码（`?ic=`），好友点开即由 `app.js` 捕获（见 services/invite.js）。
 * 码从 store 里 `/me` 已经返回的 `inviteCode` 取——**零新增请求**，不为一个分享参数在每页多打一次接口。
 * **拿不到码就退回无参路径**：分享照常可用，只是这一跳不计归因；绝不能因为缺一个参数把分享按钮变哑。
 */

const store = require('./store');

/**
 * 分享落地页：问策 tab。
 *
 * 不用速诊页（`packages/work/quickscan/index`）——它 onLoad 里就 `setData({ showLogin: true })`，
 * 陌生访客点开分享卡看到的第一屏会是登录弹层，这既伤转化，也踩 2026-08-05 微信审核整改的口径
 * （驳回原因正是「未浏览体验服务即要求授权登录」）。问策 tab 的登录弹层只在用户主动动作或 401 时出现，
 * 游客进来渲染的是真实公开内容（读 GET /wence/hints 的 guestForm）。
 */
const LANDING = '/pages/sessions/index';

/**
 * 分享卡底图。**绝不能留空**。
 *
 * 一开始把 image 留空、想让微信「自动截当前页」兜底，那是个隐私事故：从账本、档案、订单这些
 * 私密页转发时，缩略图会把个人经营数据直接带进分享卡，"分享内容与页面解耦"也就成了空话。
 * 现在固定用这两张品牌底图（`app/src/assets/share/`，构建时整目录拷进 `dist-native/assets/`）。
 *
 * 两张分开是因为微信的裁切规则不同：转发给朋友按 5:4 原样显示，朋友圈按 1:1 **居中裁剪**，
 * 拿 5:4 的图去发朋友圈会被裁掉两侧。图上刻意不写字——文案由 title 承载，
 * 免得出现「图上写的和标题不一样」，也不引入字体依赖。
 */
const CARD_FRIEND = '/assets/share/card-friend.png';
const CARD_TIMELINE = '/assets/share/card-timeline.png';

/**
 * 内置海报素材池（运营出图前的兜底，也是服务端下发失败时的降级）。
 *
 * 文案口径：**切真实经营痛点**（获客贵 / 现金流紧 / 招人难 / 方向不定），不用「宜攻宜守」
 * 这类盘面语——对真实经商、开企业的人没有代入感。军师的语感留在称谓与语气里
 * （「过一遍」「摆给军师看看」），不体现在痛点表述本身。
 *
 * `timelineTitle` 单列：朋友圈是「广而告之」的语气，转发给朋友是「递给你看」的语气。
 */
const BUILTIN_COPY = [
  // ── 通用（不指定具体痛点，适合还不知道对方卡在哪的时候递出去）──
  { title: '生意上最头疼的那件事，先让军师给你过一遍',
    timelineTitle: '经营卡在哪一环？让军师陪你拆一遍' },
  { title: '想不清下一步的时候，找个人把话摆开说说',
    timelineTitle: '做生意的难处，值得找个懂的人拆一遍' },

  // ── 获客与客户 ──
  { title: '客户越来越贵，先看清钱花在哪一环上',
    timelineTitle: '获客越来越贵，问题往往不在投得少' },
  { title: '来的客户不少，成的不多——中间漏在哪儿',
    timelineTitle: '流量不缺、成交不够，中间那一环值得查' },
  { title: '老客户不回头，比拉新客更该先看',
    timelineTitle: '复购掉下来的时候，别急着加投放' },

  // ── 现金流与成本 ──
  { title: '账上紧的时候，先分清是没赚到还是没收回',
    timelineTitle: '现金流紧，先分清赚没赚到和收没收回' },
  { title: '看着有利润，钱却总不在账上',
    timelineTitle: '利润表好看、账上没钱，这中间有账要算' },
  { title: '成本一年年往上走，先找出最该砍的那一刀',
    timelineTitle: '降本不是砍人，先找准该砍哪一刀' },

  // ── 用人与团队 ──
  { title: '招人难、留人更难，先把用人这件事想清楚',
    timelineTitle: '招人留人这件事，值得先想清楚再动手' },
  { title: '事都压在自己身上，先把该交出去的交出去',
    timelineTitle: '老板忙到没空想事，这本身就是要解的题' },

  // ── 方向与决策 ──
  { title: '下一步该押哪里？把你的局摆给军师看看',
    timelineTitle: '下一步押哪里，值得先想清楚再投钱' },
  { title: '要不要扩、要不要转，先把账和势都算一遍',
    timelineTitle: '扩张还是收一收，先把账算清再决定' },
];

/**
 * 底图池。图与文案**各自独立随机**，不成对绑定——12 条文案 × 3 套图 = 36 种组合，
 * 用户连着看到两条一样的概率很低。图上刻意没有文字，所以任意文案配任意图都不会矛盾。
 *
 * 每套两张：转发给朋友按 5:4 原样显示，朋友圈按 1:1 **居中裁剪**，拿 5:4 去发朋友圈会裁掉两侧。
 */
const BUILTIN_ART = [
  { image: CARD_FRIEND, timelineImage: CARD_TIMELINE },
];

/**
 * 素材池读取。服务端下发优先（运营后台维护），拿不到用内置兜底。
 * 文案与底图**分开两个池**：运营可能只想换文案不换图，绑在一起就必须成套替换。
 */
function copyPool() {
  try {
    const pool = store.snapshot().me.shareCopy;
    if (Array.isArray(pool) && pool.length && pool.every((c) => c && c.title)) return pool;
  } catch (_) { /* store 未就绪 */ }
  return BUILTIN_COPY;
}

function artPool() {
  try {
    const pool = store.snapshot().me.shareArt;
    if (Array.isArray(pool) && pool.length && pool.every((a) => a && a.image)) return pool;
  } catch (_) { /* store 未就绪 */ }
  return BUILTIN_ART;
}

/**
 * 每次分享**随机**取一条文案、一套图。
 *
 * 早先是按本地自然日轮动（同一天全站同一套），好处是「用户说他看到的图不对」能复现。
 * 改随机是产品要求：同一个人一天里分享几次，卡片长得一模一样会显得很假。
 *
 * **可排查性没有丢**：`share_expose` 埋点把这次选中的两个序号一起报上去（copy / art），
 * 线上照样能还原「他当时看到的是哪一条配哪张图」——随机与可追溯并不冲突，
 * 只要选择结果被记下来。所以这里可以放心用 Math.random()。
 *
 * 两个池独立取：12 条文案 × N 套图，组合数是乘的，比成对绑定耐看得多。
 */
function pickIndex(len) {
  return len > 1 ? Math.floor(Math.random() * len) : 0;
}

function currentPoster() {
  const copies = copyPool();
  const arts = artPool();
  const ci = pickIndex(copies.length);
  const ai = pickIndex(arts.length);
  const copy = copies[ci] || {};
  const art = arts[ai] || {};
  return {
    title: copy.title,
    timelineTitle: copy.timelineTitle || copy.title,
    image: art.image,
    timelineImage: art.timelineImage || art.image,
    copyIndex: ci,
    artIndex: ai,
  };
}

/**
 * 分享曝光埋点（`share_expose`，邀请漏斗第一段）。
 *
 * **三条硬约束，缺一条都会把分享弄坏**：
 *   ① `onShareAppMessage` / `onShareTimeline` 的返回值是微信**同步**取走的，所以埋点只能
 *      fire-and-forget——绝不 await。`api.track` 本身就是裸 `wx.request` + 空回调
 *      （见 services/api.js：刻意不走 `request()`，否则「带 token 的 401」会触发全局 onAuthLost
 *      把用户从对话里踢出去），这里只负责调它。
 *   ② 整个调用被 try 包住：连 `require('./api')` 都在 try 里。分享是转化入口，
 *      **宁可丢一条统计，也不能因为埋点让分享变慢或失败**。
 *   ③ props **只带通道与当日素材序号**，不带页面路径、页面内容、邀请码或任何个人数据。
 *      同一天全站分享的是同一套固定海报，序号足以还原「用户看到的是哪张卡」；
 *      带上页面就等于把「谁在账本页点了转发」写进埋点库，与「分享内容与页面解耦」自相矛盾。
 *
 * 为什么**懒 require('./api')**：api.js 顶层 `require('./invite')`、store.js 顶层 `require('./api')`，
 * 而 share.js 被全部 54 个页面在模块顶层引入。把 api 提到顶层就是往这条加载链中间再插一环，
 * 一旦哪天成环，拿到的是半初始化的 exports（CJS 不报错，只是静默变哑）。懒引用把风险收敛到
 * 「用户点了分享才加载」，且 require 有缓存，第二次起就是查表。
 */
function trackShareExpose(channel, pick) {
  try {
    // props 只带通道 + 本次选中的两个序号。**序号必须是这次真正用掉的那组**——
    // 早先的写法是在这里再算一次序号，按日轮动时那样还算对（同一天恒等），
    // 改成随机后就变成"埋点自己又摇了一次"，报上去的不是用户看到的那张，等于埋点说谎。
    // 所以序号由回调结果透上来（见 wrapShareCallback 的 __pick）。
    const props = { channel };
    if (pick && typeof pick.copy === 'number') props.copy = pick.copy;
    if (pick && typeof pick.art === 'number') props.art = pick.art;
    require('./api').api.track('share_expose', props);
  } catch (_) { /* 埋点不可用（模块没加载起来 / 宿主无 wx）：分享照常，绝不冒泡 */ }
}

/** 当前用户的邀请码（未登录 / `/me` 未回来时为空串，此时退回无参路径）。 */
function currentCode() {
  try {
    const me = store.snapshot().me;
    return (me && me.inviteCode) || '';
  } catch (_) { return ''; }
}

/** 给任意页面路径接上邀请码；无码返回原路径。 */
function pathWithCode(base) {
  const path = base || LANDING;
  const code = currentCode();
  if (!code) return path;
  return `${path}${path.indexOf('?') >= 0 ? '&' : '?'}ic=${encodeURIComponent(code)}&src=friend`;
}

/** 朋友圈只能给 query（落地页被微信固定为当前页，改不了 path），所以这里只回参数串。 */
function timelineQuery() {
  const code = currentCode();
  return code ? `ic=${encodeURIComponent(code)}&src=timeline` : '';
}

const friendMixin = {
  onShareAppMessage() {
    const poster = currentPoster();
    // imageUrl 一定要给：不给的话微信会截当前页当封面，从账本 / 档案页转发就把个人数据带出去了。
    return {
      title: poster.title,
      path: pathWithCode(LANDING),
      imageUrl: poster.image || CARD_FRIEND,
      // 内部字段：只为把「这次选了哪组」交给 wrapShareCallback 上报，返回给微信前会被删掉。
      __pick: { copy: poster.copyIndex, art: poster.artIndex },
    };
  },
};

const timelineMixin = {
  onShareTimeline() {
    const poster = currentPoster();
    // 同上：朋友圈也必须给图，且必须是 1:1 那张（5:4 会被居中裁掉两侧）。
    return {
      title: poster.timelineTitle || poster.title,
      query: timelineQuery(),
      imageUrl: poster.timelineImage || CARD_TIMELINE,
      __pick: { copy: poster.copyIndex, art: poster.artIndex },
    };
  },
};

/**
 * 把分享能力合并进页面定义。**页面自己定义的同名方法优先**（那 4 个成果型分享页靠这条保留自己的实现）。
 *
 * @param {object} page  页面定义对象
 * @param {object} [opts] `{ timeline: true }` 才挂朋友圈。
 *   默认不挂的原因：朋友圈的落地页被微信强制为**当前页**、只能带 query 改不了 path，
 *   所以私密页开朋友圈就等于把陌生访客直接丢在账本 / 档案的空态或登录门上。
 *   只有本身就适合被陌生人看到的公开内容页才显式开。
 */
function withShare(page, opts) {
  const wantTimeline = Boolean(opts && opts.timeline);
  const base = wantTimeline ? Object.assign({}, friendMixin, timelineMixin) : Object.assign({}, friendMixin);
  const merged = Object.assign(base, page);
  // 页面自定义的分享回调（那 4 个成果型分享页）**整体覆盖**了 mixin 的实现，
  // 于是它们只要漏写 imageUrl，微信就会退回截**当前页**当封面——从命盘 / 成片这类
  // 页面转发出去等于把个人内容贴到聊天窗里。逐页去补容易再漏，所以在这里统一兜：
  // 页面自己给了图就用它的，没给就补品牌底图。往后新增自定义分享页也不可能漏。
  //
  // 曝光埋点也兜在这一层（**不在 mixin 里**），同一个理由的另一面：埋在 mixin 里，
  // 那 4 个覆盖了 mixin 的成果型分享页就一条都不上报，漏斗第一段凭空少掉最活跃的几页；
  // 埋在这里则 54 页统一一条、且**不会双报**（wrapper 只包最终生效的那个回调）。
  merged.onShareAppMessage = wrapShareCallback(merged.onShareAppMessage, CARD_FRIEND, 'friend');
  if (wantTimeline) merged.onShareTimeline = wrapShareCallback(merged.onShareTimeline, CARD_TIMELINE, 'timeline');
  return merged;
}

/**
 * 包一层：① 先 fire-and-forget 上报一次曝光；② 回调结果缺 imageUrl 时补默认图。
 * 回调没定义或返回空则原样放过。
 *
 * 顺序刻意是「先报再算」：无论页面自己的回调返回什么、甚至抛错，曝光这件事已经发生了
 * （用户确实点开了转发菜单），漏斗第一段不该因为某页回调有 bug 就少一条。
 * 上报本身在 trackShareExpose 里已经 try 住，不会影响下面的同步返回。
 */
function wrapShareCallback(fn, fallback, channel) {
  if (typeof fn !== 'function') return fn;
  return function wrapped(...args) {
    // 时序：**先执行回调、再上报**（原先是先报再执行）。改的原因是随机化之后要报
    // 「这次真正选中的序号」，而序号只有回调跑完才知道。原来"先报"图的是
    // 「回调抛错也不丢曝光」，这条保证没丢——catch 里照样报一次（只是没有序号）。
    let result;
    try {
      result = fn.apply(this, args);
    } catch (err) {
      trackShareExpose(channel, null);
      throw err; // 不吞页面的异常：微信拿不到返回值时自己会兜底，掩掉反而更难查
    }
    const pick = result && typeof result === 'object' ? result.__pick : null;
    trackShareExpose(channel, pick);
    if (!result || typeof result !== 'object') return result;
    // __pick 是内部字段，**必须删掉再交给微信**：分享回调的返回值是有固定契约的，
    // 夹带自定义字段虽然当前无害，但不该把内部实现漏给平台。
    const out = Object.assign({}, result);
    delete out.__pick;
    if (!out.imageUrl) out.imageUrl = fallback;
    return out;
  };
}

module.exports = {
  withShare,
  friendMixin,
  timelineMixin,
  pathWithCode,
  timelineQuery,
  currentPoster,
  copyPool,
  artPool,
  BUILTIN_COPY,
  BUILTIN_ART,
  LANDING,
  CARD_FRIEND,
  CARD_TIMELINE,
};
