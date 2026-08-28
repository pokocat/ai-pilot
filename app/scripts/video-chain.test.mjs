// 快出片主链 · 用户视角逐页走通（mock 模式，无需开发者工具）。
//
// 与另外两套测试的分工：
//   video-catalog / video-model.test.mjs  纯函数：模板真值、报价、镜头切分
//   video-e2e.mjs                         开发者工具自动化：布局契约、横向溢出、截图
//   ← 本文件                              页面 JS 的真实行为：取数、状态流转、按钮、跳转参数
//
// 中间这层此前是空的：`video-e2e.mjs` 只走到模板详情就停了，
// 「改文案 → 配画面 → 确认 → 出片 → 作品」这条真正的出片链路一步没被跑过，
// 而它恰恰是用户唯一在意的那条路。且 e2e 依赖开发者工具已登录 + 服务端口已开，
// 换机后跑不起来（2026-08-27 实况：新装工具 profile 无登录态，CLI 卡在 initialize）。
//
// 跑法：cd app && node --test scripts/video-chain.test.mjs      # 不需要先构建
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRuntime } from './weapp-runtime.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 直接跑**源码**，不跑构建产物。
 *
 * 构建器对 JS 是逐字节搬运的（只额外生成 config/env.js 并编译样式），跑源码等于跑产物，
 * 还多两个好处：改完源码立刻生效，不存在「拿旧产物测新代码」的假绿；以及不写共享的
 * dist-native —— `node --test scripts/*.test.mjs` 是并行的，在测试里重建产物会和
 * 读产物的用例抢文件（实测把 native-weapp.test.mjs 打成 ENOENT app.wxss）。
 * config/env 由 weapp-runtime 钉成 mock 档（源码里那份默认值是可以被改的，不让测试跟着它漂）。
 */
const SRC = path.join(APP_ROOT, 'weapp-native');

const VIDEO = 'packages/video';
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
/** 与 services/nav.js 的 LOCK_MS 对齐，留一点余量。 */
const NAV_LOCK_MS = 850;
/** 比 config.js 的 POLL_INTERVAL_MS(3000) 长一点，足够让漏清的计时器暴露出来。 */
const POLL_GRACE_MS = 3600;

/** 把 `/packages/video/script/index?projectId=x` 拆成 route + query。 */
function parseUrl(url) {
  const [rawPath, rawQuery] = String(url).split('?');
  const route = rawPath.replace(/^\//, '');
  const query = {};
  for (const pair of String(rawQuery || '').split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const k = i < 0 ? pair : pair.slice(0, i);
    query[decodeURIComponent(k)] = decodeURIComponent(i < 0 ? '' : pair.slice(i + 1));
  }
  return { route, query };
}

/**
 * 一次会话。`open` 走跳转意图真正挂载目标页，等同用户点击后落到下一屏。
 * settle 给页面的异步取数留时间——页面普遍是 onLoad 里发请求、then 里 setData。
 */
function createSession({ loggedIn = true } = {}) {
  const rt = createRuntime(SRC);
  // 'local-user' 不是三段 JWT → isLoggedIn() 为真而 useMockApi() 仍为真，
  // 正是 runtime-mode.js 设计的「mock 包内的登录用户」。
  if (loggedIn) rt.storage.set('junshi.userId', 'local-user');

  async function mount(route, query, settle = 260) {
    const cfg = rt.loadPageConfig(route);
    const page = rt.instantiate(cfg, query);
    rt.stack.push(page);
    await rt.withGlobals(async () => {
      // 真机顺序是 onLoad → onShow 紧接着发生，取数是它们之后才回来的。
      // 先等 settle 再 onShow 会让「onShow 里刷新状态」这类逻辑测出错误的时序。
      if (page.onLoad) page.onLoad(query || {});
      if (page.onShow) page.onShow();
      await tick(settle);
    });
    return page;
  }

  /**
   * 触发页面动作，然后消费跳转意图（若有）并挂载目标页。
   *
   * 动作前先等过 `services/nav` 的 800ms 导航锁 —— 那是防连点开两页的真实产品行为，
   * 真人在每一屏上都要花几秒，测试跑得比人快才会撞上它。绕开锁就等于测了一份
   * 线上不存在的代码，所以这里选择等，不选择拆锁。
   */
  async function act(page, method, arg, settle = 260) {
    // 顺序要紧：先等过锁，再清意图。反过来的话，等待这 850ms 里若有上一页的
    // 晚到跳转落进来，就会被当成本次动作的结果读走。
    await tick(NAV_LOCK_MS);
    rt.clearNav();
    await rt.withGlobals(async () => {
      const out = page[method](arg);
      if (out && typeof out.then === 'function') await out;
      await tick(settle);
    });
    const nav = rt.pendingNav;
    if (!nav) return null;
    const { route, query } = parseUrl(nav.url);
    await applyNavToStack(nav, page);
    return { nav, route, query };
  }

  /**
   * 按微信语义结算页面栈与生命周期。
   *
   * 光 pop 数组是不够的：被关掉的页要跑 onUnload（清轮询、关浮层、落草稿），
   * 被盖住的页要跑 onHide。这些是真实跳转时才会发生的收尾动作，
   * 不跑就等于把「跳走时该做的事」整类漏在测试之外。
   */
  async function applyNavToStack(nav, from) {
    const fire = (page, hook) => {
      if (page && typeof page[hook] === 'function') {
        try { page[hook](); } catch (_) { /* 收尾尽力而为，不掩盖主断言 */ }
      }
    };
    await rt.withGlobals(async () => {
      if (nav.type === 'navigateTo') {
        fire(from, 'onHide');                       // 旧页被盖住，不销毁
      } else if (nav.type === 'redirectTo') {
        fire(from, 'onUnload'); rt.stack.pop();     // 旧页被替换掉
      } else if (nav.type === 'reLaunch' || nav.type === 'switchTab') {
        for (let i = rt.stack.length - 1; i >= 0; i -= 1) fire(rt.stack[i], 'onUnload');
        rt.stack.length = 0;                        // 整栈清空
      }
      await tick(60);
    });
  }

  /** 走完一次跳转并落到新页。 */
  async function follow(page, method, arg, settle = 260) {
    const hop = await act(page, method, arg, settle);
    assert.ok(hop, `${page.route} 的 ${method}() 没有产生跳转`);
    const next = await mount(hop.route, hop.query, settle);
    return { hop, page: next };
  }

  /**
   * 收口。按页面栈倒序走 onUnload，让页面自己清掉计时器/浮层，
   * 再等一拍让在途回调落地，最后摘掉全局。
   *
   * 不收口的话，上一个用例的悬挂回调会打到下一个用例的 wx/storage 上；
   * 而且每个 runtime 都把「前一个 runtime 的全局」存成原值，只 dispose 最后一个
   * 会还原成上一个 runtime 而不是进程原始全局。
   */
  async function close() {
    await rt.withGlobals(async () => {
      for (let i = rt.stack.length - 1; i >= 0; i -= 1) {
        const page = rt.stack[i];
        try { if (page.onHide) page.onHide(); if (page.onUnload) page.onUnload(); } catch (_) { /* 收口尽力而为 */ }
      }
      await tick(120);
    });
    rt.stack.length = 0;
    rt.dispose();
  }

  return { rt, mount, act, follow, close, applyNav: applyNavToStack };
}

/** 每个用例建会话都走这里，保证无论断言成败都收口。 */
function session(t, options) {
  const s = createSession(options);
  t.after(() => s.close());
  return s;
}

/* ══════════════ 1. 落地页：游客能看，登录后看到分身门槛 ══════════════ */

test('游客进首页不被拦，看得到三步说明和主行动', async (t) => {
  const s = session(t, { loggedIn: false });
  const home = await s.mount(`${VIDEO}/home/index`, {});

  assert.equal(home.data.guest, true, '未登录应标记为游客');
  assert.equal(home.data.bannerFailed, false, '横幅不该一上来就落兜底底纹');
  assert.deepEqual(home.data.steps.map((x) => x.name), ['改文案', '配画面', '出片'],
    '三步说明是落地页讲清「片子怎么来的」的唯一位置');
  // 游客不该被要求先登录才能浏览（军师登录门整改结论）
  assert.equal(home.data.showLogin, false, '浏览首页不该弹登录');
});

test('分身读失败不能被说成「你还没有」', async (t) => {
  const s = session(t);
  const home = await s.mount(`${VIDEO}/home/index`, {});

  // 四态里最危险的一条：读失败与空态混为一谈，会引导一个明明有分身的用户去重训。
  const failed = home.resolveAvatarState({ failed: true });
  assert.equal(failed.avatarState, 'failed');
  const empty = home.resolveAvatarState({ rows: [] });
  assert.equal(empty.avatarState, 'missing');
  assert.notEqual(failed.avatarState, empty.avatarState, '读失败与确实没有必须是两个状态');
});

/* ══════════════ 2. 选模板：首页 → 专区 → 详情 ══════════════ */

test('主行动进模板专区，专区只列真实存在的那一套', async (t) => {
  const s = session(t);
  const home = await s.mount(`${VIDEO}/home/index`, {});

  const { hop, page: list } = await s.follow(home, 'openTemplates');
  assert.equal(hop.route, `${VIDEO}/templates/index`, '首页主行动应去模板专区');

  assert.equal(list.data.state, 'ok');
  assert.equal(list.data.templates.length, 1, '首发三套里只有《为实体发声》真的存在');
  assert.equal(list.data.templates[0].id, 'ct_shiti');
  // 卡片上的三个数必须来自运行时推导，不是写死的设计稿常量
  assert.match(list.data.templates[0].durationText, /^\d+:\d{2}$/);
  assert.notEqual(list.data.templates[0].creditText, '0 积分');
});

test('模板详情能打开，且时长/积分与目录真值一致', async (t) => {
  const s = session(t);
  const list = await s.mount(`${VIDEO}/templates/index`, {});
  const { hop, page: detail } = await s.follow(
    list, 'openTemplate', { currentTarget: { dataset: { id: 'ct_shiti' } } });

  assert.equal(hop.route, `${VIDEO}/template/index`);
  assert.equal(hop.query.templateId, 'ct_shiti');
  assert.ok(detail.data.template, '详情页应已载入模板');
  assert.equal(detail.data.template.id, 'ct_shiti');

  const catalog = s.rt.require(path.join(SRC, VIDEO, 'catalog.js'));
  const truth = catalog.getBuiltInTemplate('ct_shiti');
  assert.equal(detail.data.template.estDurationSec, truth.estDurationSec,
    '详情页时长必须与 catalog 推导值同源');
});

/* ══════════════ 3. 出片链路主干 ══════════════ */

/** 走到确认页，返回沿途各页。`fill` 决定要不要像真人那样把画面段配满。 */
async function walkToConfirm(s, { fill }) {
  const detail = await s.mount(`${VIDEO}/template/index`, { templateId: 'ct_shiti' });

  // 「开始制作」要先过分身门槛；mock 的分身是 ready，应直接建工程
  const { hop: toScript, page: script } = await s.follow(detail, 'start', undefined, 420);
  assert.equal(toScript.route, `${VIDEO}/script/index`, '有 ready 分身应直接进改文案');
  const projectId = toScript.query.projectId;
  assert.ok(projectId, '建工程后必须带 projectId');

  const editedText = await editFirstLine(s, script);

  const { hop: toShots, page: shots } = await s.follow(script, 'next', undefined, 420);
  assert.equal(toShots.route, `${VIDEO}/shots/index`);
  assert.equal(toShots.query.projectId, projectId, '配画面必须承接同一个工程');

  if (fill) await fillEveryShot(s, shots);

  const { hop: toConfirm, page: confirm } = await s.follow(shots, 'next', undefined, 620);
  assert.equal(toConfirm.route, `${VIDEO}/confirm/index`);
  assert.equal(toConfirm.query.projectId, projectId, '确认页必须承接同一个工程');

  return { projectId, editedText, detail, script, shots, confirm };
}

/**
 * 真的改一句文案：点开第一段 → 逐字输入 → 收起。
 * 光走 next() 不改字的话，「改了字没落库」「改完 shots 没重算」这类缺陷会一路全绿。
 */
async function editFirstLine(s, script) {
  const first = script.data.rows[0];
  assert.ok(first, '改文案页应至少有一段可改');
  const text = `${first.text}我在这条街上开了十二年。`;
  await s.rt.withGlobals(async () => {
    script.startEdit({ currentTarget: { dataset: { no: first.no } } });
    script.inputText({ detail: { value: text } });
    script.commitEdit();
    await tick(120);
  });
  const saved = script.data.project.segments.find((x) => x.no === first.no);
  assert.equal(saved.text, text, '收起编辑后，改动要留在工程里');
  return text;
}

/** 逐个空画面段走「从相册选」——真人配画面就是这么一段段点过去的。 */
async function fillEveryShot(s, shots) {
  const empty = () => (shots.data.project.shots || []).filter((x) => x.role === 'broll' && !x.assetId);
  const total = empty().length;
  assert.ok(total > 0, '这套模板应当有需要配画面的段');

  // 走真实入口 pickAsset（登录门 → dataset 取 shotId → 操作菜单），不直接调内部方法：
  // 绑定断了、dataset 名改了、菜单选项顺序变了，都该在这里红。
  // 菜单项按素材库有没有东西重排，所以按文案选「从相册选」而不是按下标。
  s.rt.pickActionSheetBy(/相册/);
  for (let guard = 0; guard < total + 2; guard += 1) {
    const next = empty()[0];
    if (!next) break;
    await s.rt.withGlobals(async () => {
      shots.pickAsset({ currentTarget: { dataset: { id: next.id } } });
      await tick(340);
    });
  }
  assert.equal(empty().length, 0, `还有 ${empty().length} 个画面段没配上`);
  assert.equal(s.rt.actionSheets.length, total,
    `配画面应当每段正好弹一次操作菜单，实际弹了 ${s.rt.actionSheets.length} 次（应 ${total} 次）`);
}

test('从模板详情一路走到确认页，每一跳都带着同一个 projectId', async (t) => {
  const s = session(t);
  const { script, shots, confirm, editedText } = await walkToConfirm(s, { fill: true });

  // 改文案页：22 段脚本里 21 段正文可改，固定尾段不进编辑区
  // 不写死 22/21：模板段数是内容侧的事，正常调整不该打红这里。
  // 要守的是那条关系 —— 固定尾段不进编辑区。
  const segs = script.data.project.segments;
  const tails = segs.filter((x) => x.role === 'tail');
  assert.equal(tails.length, 1, '这套模板应当有且只有一个固定尾段');
  assert.equal(script.data.rows.length, segs.length - tails.length,
    '可编辑列表应当正好是「全部段落减去固定尾段」');
  assert.ok(!script.data.rows.some((r) => r.no === tails[0].no), '固定尾段不该出现在可编辑列表里');

  assert.ok(shots.data.rows.length > 0, '配画面页应有镜头');
  // 改文案 → 配画面是跨页重新取数的；改动没落库的话这里读回来还是模板原文
  const carried = shots.data.project.segments.find((x) => x.text === editedText);
  assert.ok(carried, '在改文案页改的字，到配画面页必须还在');

  // 确认页要能给出可下单的报价，否则用户走到这一步是死路
  assert.equal(confirm.data.quoteReady, true, `确认页报价没就绪：${confirm.data.quoteError || '(无错因)'}`);
  assert.ok(confirm.data.estimate, '报价对象缺失');
  assert.ok(confirm.data.estimate.total > 0, '整单报价应大于 0');
  assert.deepEqual(confirm.data.problems, [], `确认页仍有拦截项：${JSON.stringify(confirm.data.problems)}`);
});

test('画面段没配满就不许下单，且要说清差在哪', async (t) => {
  const s = session(t);
  const { confirm } = await walkToConfirm(s, { fill: false });

  // 这是花钱前的最后一道闸：报价照给（用户要知道多少钱），但不许提交。
  assert.equal(confirm.data.quoteReady, true, '报价与拦截是两回事，缺素材不该连价都不给');
  // 不依赖 problems 的排序：用户在意的是「这一条被拦住了并且说清楚了」
  const missing = confirm.data.problems.find((x) => x.code === 'CLIP_ASSET_NOT_ALLOWED');
  assert.ok(missing, `还有画面段没素材时必须拦住，实际：${JSON.stringify(confirm.data.problems)}`);
  assert.match(missing.message, /画面段/, '拦截文案要指名是画面段的问题');

  const hop = await s.act(confirm, 'submit', undefined, 500);
  assert.equal(hop, null, '被拦住时不该发生跳转');
  const toast = s.rt.lastToast();
  assert.ok(toast && String(toast.title).includes('画面段'),
    `应当用 toast 告诉用户差什么，实际：${toast ? toast.title : '(没有任何提示)'}`);
});

test('确认页扣费提交后进出片页，且不把确认页留在返回栈里', async (t) => {
  const s = session(t);
  const { projectId, confirm } = await walkToConfirm(s, { fill: true });
  const depth = s.rt.stack.length;

  const hop = await s.act(confirm, 'submit', undefined, 800);
  assert.ok(hop, '确认出片应产生跳转');
  assert.equal(hop.route, `${VIDEO}/rendering/index`, '提交后应进出片页');
  assert.equal(hop.nav.type, 'redirectTo',
    '必须 redirectTo：navigateTo 会把确认页留在返回栈，用户一按返回就能重复下单');
  assert.equal(s.rt.stack.length, depth - 1, 'redirectTo 应替换掉确认页而不是叠一层');
  assert.equal(hop.query.projectId, projectId);
  assert.ok(hop.query.jobId, '出片页需要 jobId 才能轮询');
});

/* ══════════════ 4. 出片与作品 ══════════════ */

test('出片页轮询到完成后落到作品页，作品能打开', async (t) => {
  const s = session(t);
  const { confirm } = await walkToConfirm(s, { fill: true });
  const hop = await s.act(confirm, 'submit', undefined, 800);
  assert.ok(hop, '提交未成功，后面的出片断言无意义');

  const rendering = await s.mount(hop.route, hop.query, 300);
  assert.equal(rendering.data.jobId, hop.query.jobId, '出片页要认得自己在等哪个任务');
  assert.ok(rendering.data.stageRows && rendering.data.stageRows.length,
    '出片页应给出阶段进度，否则用户看到的是一个不动的空屏');

  // mock 出片 16 秒走完四阶段；轮询到出现跳转为止
  s.rt.clearNav();
  let done = null;
  await s.rt.withGlobals(async () => {
    for (let i = 0; i < 45 && !done; i += 1) {
      await tick(600);
      if (s.rt.pendingNav) done = s.rt.pendingNav;
    }
  });
  assert.ok(done, '出片完成后应自动跳转，否则用户会一直盯着进度条');
  const { route, query } = parseUrl(done.url);
  assert.equal(route, `${VIDEO}/work/index`, '出片成功应落到作品页');
  assert.equal(done.type, 'redirectTo', '出好了不该让用户能返回到进度页');
  assert.ok(query.workId, '作品页需要 workId');

  // 这一跳是轮询里自己发起的，同样要按真实语义结算栈与生命周期，
  // 否则出片页的 onUnload（清轮询）在测试里永远不会跑。
  // 这一跳是轮询里自己发起的，同样要按真实语义结算栈与生命周期，
  // 否则出片页的 onUnload（清轮询）在测试里永远不会跑。
  let unloaded = false;
  const realUnload = rendering.onUnload;
  rendering.onUnload = () => { unloaded = true; return realUnload.call(rendering); };
  await s.applyNav(done, rendering);
  assert.ok(unloaded, 'redirect 走掉时出片页应当收到 onUnload，否则轮询留在后台');

  const work = await s.mount(route, query, 400);
  assert.ok(work.data.work, '作品页应载入作品');
  assert.equal(work.data.workId, query.workId, '作品页要认得自己在展示哪一条');
  assert.ok(work.data.durationText, '成片时长要能显示，那是用户确认「拿到的是这条」的依据');
  // 注意：mock 不给 videoUrl —— mock.js 有明确政策，编造媒体地址只会播 404
  // 并掩盖真实回落分支。可播与否由下面那条用例按视图层的兜底文案来守。
});

test('成片取不到播放地址时要说人话，不能只给一块黑底纹', async () => {
  // 契约里 videoUrl 是可选的（ClipWorkDetail），下载接口对同一状态给的是
  // CLIP_WORK_NOT_READY「成片还没有准备好」。观看这条路以前什么都不说，
  // 用户看到的是「你的故事，已经成片」配一个空框——和首页「读失败不能说成
  // 你还没有」是同一类问题：不能把取不到显示成正常。
  const wxml = fs.readFileSync(
    path.join(SRC, VIDEO, 'work/index.wxml'), 'utf8');

  // 播放器是 wx:if="{{work.videoUrl}}"，兜底分支就是同一容器里的 wx:else
  assert.match(wxml, /wx:if="\{\{work\.videoUrl\}\}"/, '播放器仍应按有无地址决定是否渲染');
  const m = wxml.match(/<view wx:else[^>]*class="[^"]*wd-pending[^"]*"[^>]*>([\s\S]*?)<\/view>/);
  assert.ok(m, '没有播放地址时应有一个带说明的兜底块，而不是空底纹');
  const fallback = m[1];
  assert.ok(/还播不了|没有准备好/.test(fallback),
    '没有播放地址时，播放器位置必须给出用户看得懂的说明');
  // 本页不许对积分下结论：详情接口只透传作品、不做结算，结算在任务轮询那条路径上。
  // 读到的可能还是 generating，也可能 hold 还没推进到 settled——
  // 断言「已结算」等于把一句可能为假的话固化成要求。
  assert.ok(!/已经结过|已结算|已扣/.test(fallback),
    '本页无从判断这一单结没结，不能在这里断言扣费结果');
  assert.ok(!/videoUrl|CLIP_[A-Z_]+|null|undefined/.test(fallback),
    '兜底文案里不许出现字段名或错误码');
});

test('作品读失败要说没读到，不能套用出片成功的版式', async (t) => {
  // 真让详情接口失败，断言页面落到哪个状态 —— 只扫 WXML 标记的话，
  // 哪天 JS 不再置 loadFailed，静态断言照样绿。
  const s = session(t);
  const api = s.rt.require(path.join(SRC, VIDEO, 'api.js'));
  const real = api.work;
  api.work = () => Promise.reject(Object.assign(new Error('网络开小差了'), { statusCode: 500 }));
  try {
    const work = await s.mount(`${VIDEO}/work/index`, { workId: 'cw_mock_2' }, 320);
    assert.equal(work.data.loadFailed, true, '读失败必须落到独立的失败态');
    assert.equal(work.data.work, null, '没读到就不许留着上一份作品数据');
    assert.equal(work.data.done, false, '读失败绝不能被算成完成');
    assert.equal(work.data.loadError, '网络开小差了', '失败原因要透出来，别盖成固定文案');
    assert.equal(typeof work.retryLoad, 'function', '读失败要给重试，否则用户只能对着空页面');

    // 重试要真能把页面救回来
    api.work = real;
    await s.rt.withGlobals(async () => { work.retryLoad(); await tick(320); });
    assert.equal(work.data.loadFailed, false, '重试成功后应退出失败态');
    assert.ok(work.data.work, '重试成功后应载入作品');

    // JS 置了 loadFailed 还不够，模板得真的用它 —— 否则页面仍会落进成功版式
    const wxml = fs.readFileSync(path.join(SRC, VIDEO, 'work/index.wxml'), 'utf8');
    const failedAt = wxml.indexOf('wx:elif="{{loadFailed}}"');
    assert.ok(failedAt >= 0, '模板必须有读失败分支');
    assert.ok(failedAt < wxml.indexOf('wdr-title'),
      '读失败分支要排在成功版式之前，否则 work 为 null 时仍会落进「已经成片」');
  } finally { api.work = real; }
});

test('读不到的原因不同，给的出路也要不同', async (t) => {
  // 一个「重试」按钮对 401 和 404 都是摆设：没登录时重试一万次还是 401，
  // 作品不存在时重试也不会让它存在。仓库的 api-error 分类同样把这两类标成不可重试。
  const s = session(t);
  const api = s.rt.require(path.join(SRC, VIDEO, 'api.js'));
  const real = api.work;
  const failWith = (extra, message) => {
    api.work = () => Promise.reject(Object.assign(new Error(message), extra));
  };

  try {
    // services/request.js 的 unauthorized() 会挂 hadToken/authHandled/staleAuth，
    // 401 因此是三种而不是一种，本页只该管其中一种。
    failWith({ statusCode: 401, code: 'UNAUTHORIZED', hadToken: false, authHandled: false, staleAuth: false }, '未登录');
    const guest = await s.mount(`${VIDEO}/work/index`, { workId: 'cw_mock_2' }, 320);
    assert.equal(guest.data.showLogin, true, '游客 401 应当由本页弹登录门');
    assert.equal(guest.data.canRetry, false, '没登录时「重试」是摆设');

    // 带 token 的 401：全局 onAuthLost 已经清态 + 提示 + 准备 reLaunch，
    // 本页再弹一个登录浮层就是第二次打扰（AGENTS §0.7）。
    failWith({ statusCode: 401, code: 'UNAUTHORIZED', hadToken: true, authHandled: true, staleAuth: false }, '登录态已失效');
    const handled = await s.mount(`${VIDEO}/work/index`, { workId: 'cw_mock_2' }, 320);
    assert.equal(handled.data.showLogin, false, '全局已经接管的 401，本页不该再弹一次登录门');

    // 旧请求晚到，用户可能**已经重新登录**了 —— 这时弹登录门等于把登录好的会话盖住。
    failWith({ statusCode: 401, code: 'UNAUTHORIZED', hadToken: true, authHandled: false, staleAuth: true }, '未登录');
    const stale = await s.mount(`${VIDEO}/work/index`, { workId: 'cw_mock_2' }, 320);
    assert.equal(stale.data.showLogin, false, '过期请求的 401 绝不能盖住已经重新登录的会话');

    failWith({ statusCode: 404, code: 'CLIP_WORK_NOT_FOUND' }, '作品不存在');
    const gone = await s.mount(`${VIDEO}/work/index`, { workId: 'cw_missing' }, 320);
    assert.equal(gone.data.canRetry, false, '作品不存在时重试不会让它存在');
    assert.equal(gone.data.showLogin, false, '404 不该误弹登录门');

    failWith({ statusCode: 500 }, '服务开小差了');
    const oops = await s.mount(`${VIDEO}/work/index`, { workId: 'cw_mock_2' }, 320);
    assert.equal(oops.data.canRetry, true, '5xx 是真的可能好转，要给重试');
  } finally { api.work = real; }
});

test('生成中的作品不许显示成「已经成片」，也不该给保存和代发', async (t) => {
  // 契约允许 status=generating，mock 里 cw_mock_1 就是。深链或从列表点进来都会撞上。
  const s = session(t);
  const wip = await s.mount(`${VIDEO}/work/index`, { workId: 'cw_mock_1' }, 320);
  assert.equal(wip.data.work.status, 'generating', 'cw_mock_1 应当是生成中，否则这条用例失去意义');
  assert.equal(wip.data.done, false, '生成中不算完成，页面不能说「已经成片」');

  // 没出好就点保存，只会拿到「成片还没有准备好」，得先挡住
  await s.rt.withGlobals(async () => { wip.saveToAlbum(); await tick(80); });
  const toast = s.rt.lastToast();
  assert.ok(toast && /还没出好/.test(String(toast.title)),
    `生成中点保存应当被挡住并说明，实际：${toast ? toast.title : '(没有任何提示)'}`);

  await s.rt.withGlobals(async () => { wip.publish({ currentTarget: { dataset: { key: 'douyin' } } }); await tick(80); });
  const pubToast = s.rt.lastToast();
  assert.ok(pubToast && /还没出好/.test(String(pubToast.title)),
    `生成中点代发也应当被挡住，实际：${pubToast ? pubToast.title : '(没有任何提示)'}`);

  const done = await s.mount(`${VIDEO}/work/index`, { workId: 'cw_mock_2' }, 320);
  assert.equal(done.data.done, true, '已完成的作品才是完成态');

  // 视图侧同样要收口：光有 done 这一位、模板不用它，页面照样恭喜你已经成片，
  // 也照样把点下去必然失败的按钮摆出来。方法里的防线只是兜底。
  const wxml = fs.readFileSync(path.join(SRC, VIDEO, 'work/index.wxml'), 'utf8');
  const ready = wxml.match(/<view class="wd-ready"[^>]*>/);
  assert.ok(ready && /wx:if="\{\{done\}\}"/.test(ready[0]),
    '「生成完成」那块必须按 done 收口');
  assert.match(wxml, /wx:if="\{\{done && work\.credits\}\}"/,
    '「已扣 N 积分」只有完成态才敢说');
  const save = wxml.match(/<view[^>]*bindtap="saveToAlbum"[^>]*>/);
  assert.ok(save && /wx:if="\{\{done\}\}"/.test(save[0]),
    '「保存到相册」必须按 done 收口，别摆一个点下去必然失败的主按钮');
  const section = wxml.match(/<view class="wd-section"[^>]*>\s*<text class="wd-sec-kicker">下一步/);
  assert.ok(section && /wx:if="\{\{done\}\}"/.test(section[0]),
    '「下一步」整块（保存 + 代发）必须按 done 收口');
});


test('离开出片页要停掉轮询，别让用户切走后还在后台拉进度', async (t) => {
  const s = session(t);
  const { confirm } = await walkToConfirm(s, { fill: true });
  const hop = await s.act(confirm, 'submit', undefined, 800);
  const rendering = await s.mount(hop.route, hop.query, 300);

  // 断行为不断字段名：轮询用什么实现是内部事，用户在意的是切走之后别再拉了。
  const api = s.rt.require(path.join(SRC, VIDEO, 'api.js'));
  const realJob = api.job;
  let callsAfterLeave = 0;

  await s.rt.withGlobals(async () => { rendering.onUnload(); await tick(80); });
  api.job = (...args) => { callsAfterLeave += 1; return realJob(...args); };
  try {
    await s.rt.withGlobals(async () => { await tick(POLL_GRACE_MS); });
  } finally { api.job = realJob; }

  assert.equal(callsAfterLeave, 0,
    `离开出片页后还在拉进度 ${callsAfterLeave} 次；页面切走后 setData 会触发微信的后台告警`);
});
