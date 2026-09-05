#!/usr/bin/env node
// 快出片分包（packages/video）· 微信开发者工具本地自动化验收。
//
// 跑法：
//   1) npm run build:weapp                     # 产物在 app/dist-native
//   2) 开发者工具 → 设置 → 安全设置 → 打开「服务端口」
//   3) npm run e2e:weapp                       # 本脚本会自己起自动化端口
//
// 覆盖的是**布局契约与状态文案**这类肉眼要反复核对的东西：主卡是否压在次级入口之上、
// 分身四态文案是否串味、模板是否真的只剩一套、有没有横向溢出。
// 麦克风、相机、真实上传只能真机验，这里不冒充。
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(APP_ROOT, 'package.json'));

// 绕开 automator.connect 的 checkVersion：0.12.1 读不到新版工具的版本号，
// cmpVersion(undefined) 会直接抛。内部 Connection + MiniProgram 建连即可。
const Connection = require('miniprogram-automator/out/Connection').default;
const MiniProgram = require('miniprogram-automator/out/MiniProgram').default;

const PROJECT = path.join(APP_ROOT, 'dist-native');
const CLI = process.env.WEAPP_CLI || '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
const PORT = Number(process.env.WEAPP_AUTO_PORT || 9420);
const SHOTS = process.env.WEAPP_E2E_SHOTS || path.join(APP_ROOT, 'dist-native-e2e-shots');

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 开发者工具的自动化端口在每次断开后就关了，所以每轮都要重新 enable。 */
function enableAutomation() {
  return new Promise((resolve, reject) => {
    execFile(CLI, ['auto', '--project', PROJECT, '--auto-port', String(PORT)],
      { timeout: 120000 }, (error) => (error ? reject(error) : resolve()));
  });
}

if (!fs.existsSync(PROJECT)) {
  console.error(`产物不存在：${PROJECT}\n先跑 npm run build:weapp`);
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });

/**
 * CLI 的 `auto` 子命令会先于自动化 WebSocket 真正 listen 就返回，
 * 直接 connect 会 ECONNREFUSED。所以带退避重试，别把这段时间当成失败。
 */
async function connectWithRetry(attempts = 15) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try { return new MiniProgram(await Connection.create(`ws://127.0.0.1:${PORT}`)); }
    catch (error) { lastError = error; await wait(1000); }
  }
  throw new Error(`连不上自动化端口 ${PORT}：${lastError && lastError.message}\n`
    + '检查开发者工具「设置 → 安全设置 → 服务端口」是否已打开。');
}

await enableAutomation();
const mini = await connectWithRetry();
console.log('已连上开发者工具\n');

try {
  const sys = await mini.callWxMethod('getSystemInfo');
  const viewport = sys.windowWidth;

  /* ── 首页 = 落地页 ─────────────────────────────────────────────────
     顺序必须是 宣传横幅 → 主 CTA → (继续上次) → 三步说明 → 分身门槛 → 次级入口。
     这是产品决策（落地页只讲「是什么、值不值得做」，选模板去专区），用断言钉住。 */
  const home = await mini.reLaunch('/packages/video/home/index');
  await wait(2500);

  const rectOf = async (sel) => {
    const el = await home.$(sel);
    if (!el) return null;
    const [offset, size] = await Promise.all([el.offset(), el.size()]);
    return { ...offset, ...size };
  };

  const banner = await rectOf('.banner');
  const cta = await rectOf('.primary-cta');
  const steps = await rectOf('.steps');
  const gate = await rectOf('.gate');
  const entries = await rectOf('.entries');

  check('宣传横幅在首屏最上', banner && banner.top < 200, banner ? `top=${banner.top}` : '未渲染');
  check('横幅图已加载（未落兜底底纹）', (await home.data()).bannerFailed === false);
  check('主 CTA 紧随横幅', banner && cta && cta.top > banner.top && cta.top < banner.top + banner.height + 40,
    banner && cta ? `banner.bottom=${banner.top + banner.height} cta.top=${cta.top}` : '');
  check('三步说明在 CTA 之下', cta && steps && cta.top < steps.top, cta && steps ? `${cta.top} < ${steps.top}` : '');
  check('分身门槛在三步之下', steps && gate && steps.top < gate.top, steps && gate ? `${steps.top} < ${gate.top}` : '');
  check('次级入口排在最后', gate && entries && gate.top < entries.top, gate && entries ? `${gate.top} < ${entries.top}` : '');
  // 落地页要紧凑：整页内容不该长到需要滑两屏才看得到入口
  check('整页足够紧凑', entries && entries.top + entries.height < 1000,
    entries ? `内容底部=${(entries.top + entries.height).toFixed(0)}` : '');

  await mini.screenshot({ path: path.join(SHOTS, '01-home-guest.png') });

  /* ── 分身四态：读失败绝不能说成"你还没有" ──────────────────────── */
  // 守的是四态**各说各的话**（尤其 failed 不能被说成 missing），措辞本身可以变。
  // 2026-08-28 按 shuorenhua 去 AI 味统一了术语与动词：光秃秃的「分身」→「数字人」，
  // 「没读到」「看进度」这类自造口语/动词截断 → 通用词。
  const GATE_CASES = [
    ['missing', '还没有数字人', '去创建'],
    ['training', '数字人训练中', '查看进度'],
    ['failed', '数字人状态加载失败', '重试'],
  ];
  // 必须先真登录：guest 与「已登录但没有分身」在 home/index.wxml 里是两套副文案
  // （`{{guest ? '登录后上传…' : '上传一段 5 秒以上…'}}`），只 setData({avatarState})
  // 不登录的话，02-gate-missing 会和 01-home-guest 渲染出**逐字节相同**的图，
  // 等于「已登录没分身」这一态从来没被走查过（2026-08-27 实测两图 md5 一致）。
  // 'local-user' 不是三段 JWT → isLoggedIn 为真而仍走 mock，与链路测试同一套约定。
  await mini.callWxMethod('setStorageSync', 'junshi.userId', 'local-user');
  await home.setData({ guest: false });
  await wait(300);

  for (const [state, expectTitle, expectAction] of GATE_CASES) {
    await home.setData({ avatarState: state, avatar: null });
    await wait(400);
    const title = await (await home.$('.gate-title')).text();
    const action = await (await home.$('.gate-action')).text();
    check(`分身态 ${state} 文案`, title.includes(expectTitle), `「${title}」`);
    check(`分身态 ${state} 动作`, action.trim() === expectAction, `「${action.trim()}」`);
    // 图标色也要跟着状态走：训练中是正常等待，穿告警红会被读成出错、诱发重复创建。
    // 图标是按 `name-tone.svg` 找文件的，tone 写错会直接 404 开天窗，所以连文件名一起验。
    const visual = await home.$('.gate-visual');
    const visualWxml = visual ? String((await visual.wxml()) || '') : '';
    const expectTone = state === 'failed' ? 'red' : (state === 'training' ? 'brand' : 'neutral');
    check(`分身态 ${state} 图标色`, visualWxml.includes(`-${expectTone}.svg`),
      (visualWxml.match(/[a-z]+-[a-z]+\.svg/) || ['(未取到 src)'])[0]);
    await mini.screenshot({ path: path.join(SHOTS, `02-gate-${state}.png`) });
  }
  const failSub = await (await home.$('.gate-sub')).text();
  check('读失败没被说成空态', !failSub.includes('还没有') && failSub.includes('不代表'), `「${failSub}」`);

  /* ── 有草稿时插在 CTA 与三步之间 ─────────────────────────────── */
  await home.setData({
    avatarState: 'ready',
    avatar: { name: '张姐', imageStatus: 'ready' },
    ongoing: { id: 'cp_e2e', templateName: '为实体发声', stepText: '第 2 步 配画面', progressText: '9 个画面段，已配好 6 个', percent: 66 },
  });
  await wait(600);
  const resume = await rectOf('.resume');
  const ctaAfter = await rectOf('.primary-cta');
  const stepsAfter = await rectOf('.steps');
  check('继续上次在主 CTA 之下', resume && ctaAfter && ctaAfter.top < resume.top,
    resume ? `${ctaAfter.top} < ${resume.top}` : '未渲染');
  check('继续上次在三步之上', resume && stepsAfter && resume.top < stepsAfter.top,
    resume ? `${resume.top} < ${stepsAfter.top}` : '');

  /* ── 横向溢出：小程序没有 overflow 调试面板，只能量边界 ────────── */
  for (const sel of ['.vd-home', '.banner', '.primary-cta', '.resume', '.steps', '.gate', '.entries']) {
    const rect = await rectOf(sel);
    if (!rect) continue;
    const right = rect.left + rect.width;
    check(`${sel} 无横向溢出`, rect.left >= -0.5 && right <= viewport + 0.5,
      `left=${rect.left} right=${right} 视口=${viewport}`);
  }
  await mini.screenshot({ path: path.join(SHOTS, '03-home-resume-ready.png') });

  /* ── 模板专区：从首页主 CTA 进，列表只剩一套 ─────────────────── */
  await (await home.$('.primary-cta')).tap();
  await wait(1800);
  const list = await mini.currentPage();
  check('主 CTA 跳模板专区', list.path.includes('templates/index'), `route=${list.path}`);
  const listData = await list.data();
  check('模板专区只列《为实体发声》',
    listData.templates.length === 1 && listData.templates[0].id === 'ct_shiti',
    `共 ${listData.templates.length} 套`);
  check('专区状态为 ok', listData.state === 'ok', `state=${listData.state}`);
  await mini.screenshot({ path: path.join(SHOTS, '04-templates.png') });

  await (await list.$('.tl-card')).tap();
  await wait(1800);
  check('专区可进模板详情', (await mini.currentPage()).path.includes('template/index'));
  await mini.screenshot({ path: path.join(SHOTS, '05-template-detail.png') });

  // 采集页要登录才进得去。不登录的话会被全局登录浮层盖住，
  // 而**路由断言照样通过** —— 2026-08-27 截出来的 06 其实是「AI 军师」登录页，
  // 真正的采集界面一次都没被走查到。所以这里连内容一起断言。
  await mini.callWxMethod('setStorageSync', 'junshi.userId', 'local-user');
  await mini.reLaunch('/packages/video/clone/index?mode=voice');
  await wait(2000);
  const clone = await mini.currentPage();
  check('声音采集页可打开', clone.path.includes('clone/index'), `route=${clone.path}`);
  const cloneTitle = await clone.$('.vd-title');
  const cloneTitleText = cloneTitle ? (await cloneTitle.text()).trim() : '';
  check('进的是采集页本身，不是被登录页盖住',
    cloneTitleText.includes('声音'), `页头「${cloneTitleText}」`);
  await mini.screenshot({ path: path.join(SHOTS, '06-clone-voice.png') });

  /* ── 成片页三态 ────────────────────────────────────────────────────
     这一页的状态判定由 video-chain.test.mjs 守（那层跑得快、不用工具），
     但**版面只有这里能量**：兜底块是绝对定位 + 左右锚死 + 自带 padding，
     少一个 box-sizing 就会比播放器宽 44px，文字偏心还被裁掉。
     mock 的成片没有 videoUrl（mock.js 有明确政策：不编造媒体地址），
     所以本机打开 cw_mock_2 必然落在兜底态 —— 正好是要量的那一屏。 */
  const rectIn = async (page, sel) => {
    const el = await page.$(sel);
    if (!el) return null;
    const [offset, size] = await Promise.all([el.offset(), el.size()]);
    return { ...offset, ...size };
  };

  await mini.reLaunch('/packages/video/work/index?workId=cw_mock_2');
  await wait(2200);
  const work = await mini.currentPage();
  const workData = await work.data();
  check('成片页可打开', work.path.includes('work/index'), `route=${work.path}`);
  check('已完成的作品是完成态', workData.done === true, `done=${workData.done}`);

  const pending = await rectIn(work, '.wd-pending');
  const player = await rectIn(work, '.wd-player');
  if (pending && player) {
    // 兜底块必须严丝合缝盖住播放器位置，不能撑出去
    check('兜底块没有撑出播放器',
      pending.width <= player.width + 0.5 && pending.left >= player.left - 0.5,
      `兜底 ${pending.width}@${pending.left} vs 播放器 ${player.width}@${player.left}`);
    check('兜底块没有横向溢出视口',
      pending.left >= -0.5 && pending.left + pending.width <= viewport + 0.5,
      `left=${pending.left} right=${pending.left + pending.width} 视口=${viewport}`);
  } else {
    check('兜底块已渲染', false, `pending=${!!pending} player=${!!player}`);
  }
  await mini.screenshot({ path: path.join(SHOTS, '07-work-pending.png') });

  // 生成中：不许出现「已经成片」，也不许摆保存/代发
  await mini.reLaunch('/packages/video/work/index?workId=cw_mock_1');
  await wait(2200);
  const wip = await mini.currentPage();
  const wipData = await wip.data();
  check('生成中的作品不算完成态', wipData.done === false, `done=${wipData.done}`);
  const wipTitle = await wip.$('.wdr-title');
  const wipTitleText = wipTitle ? (await wipTitle.text()).trim() : '';
  check('生成中不说「已经成片」', !wipTitleText.includes('已经成片'), `「${wipTitleText}」`);
  check('生成中不摆「保存到相册」', (await wip.$('.wd-act')) === null);
  check('生成中不摆代发区块', (await wip.$('.wd-platforms')) === null);
  await mini.screenshot({ path: path.join(SHOTS, '08-work-generating.png') });

  // 读失败：重试是主动作，点击区不得低于 44px（§7.2）。
  // 注入的文案要用该状态**真会出现**的那一句：work/index.js 的 loadError 取自
  // error.message（服务端原文），canRetry 由 statusCode 决定。两屏共用一句假文案的话，
  // 截出来的是生产里跑不出来的组合，走查会照着它得出错误结论。
  await wip.setData({ loading: false, loadFailed: true, loadError: '网络开小差了，请稍后再试', canRetry: true, work: null });
  await wait(700);
  const retry = await rectIn(wip, '.wd-failed-act');
  check('读失败给出重试', retry !== null);
  if (retry) {
    check('重试点击区不低于 44px', retry.height >= 44, `高 ${retry.height}px`);
    check('重试按钮无横向溢出',
      retry.left >= -0.5 && retry.left + retry.width <= viewport + 0.5,
      `left=${retry.left} right=${retry.left + retry.width} 视口=${viewport}`);
  }
  await mini.screenshot({ path: path.join(SHOTS, '09-work-failed.png') });

  // 不可重试（404/403）时不该摆一个必然失败的重试 —— 但也不能什么都不给，
  // 只把按钮藏掉等于用「不给假动作」换来一条死路。所以验的是「换成了别的出路」。
  // 连 loadError 一起换：只翻 canRetry 会截出「404 却说网络没通」这种生产里不存在的屏。
  await wip.setData({ canRetry: false, loadError: '这条片子不在当前账号里' });
  await wait(500);
  const altAct = await rectIn(wip, '.wd-failed-act');
  const altText = altAct ? (await (await wip.$('.wd-failed-act')).text()).trim() : '';
  check('不可重试时不摆「重试」', altText !== '重试', `按钮是「${altText}」`);
  check('不可重试时仍给别的出路', altAct !== null && altText.length > 0, `按钮「${altText}」`);
  if (altAct) check('替代出路点击区不低于 44px', altAct.height >= 44, `高 ${altAct.height}px`);
  await mini.screenshot({ path: path.join(SHOTS, '10-work-failed-noretry.png') });
} finally {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) console.log('失败：\n' + failed.map((f) => `  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`).join('\n'));
  console.log(`截图：${SHOTS}`);
  if (typeof mini.disconnect === 'function') await mini.disconnect();
  process.exit(failed.length ? 1 : 0);
}
