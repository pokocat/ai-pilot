#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as sass from 'sass';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = path.join(APP_ROOT, 'weapp-native');
const OUTPUT_ROOT = path.join(APP_ROOT, 'dist-native');
const ASSET_ROOT = path.join(APP_ROOT, 'src', 'assets');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
const mode = arg('mode', process.env.WEAPP_APP_MODE || process.env.TARO_APP_MODE || 'mock');
const apiExplicit = args.includes('--api') || Object.prototype.hasOwnProperty.call(process.env, 'WEAPP_APP_API') || Object.prototype.hasOwnProperty.call(process.env, 'TARO_APP_API');
const api = arg('api', process.env.WEAPP_APP_API || process.env.TARO_APP_API || (mode === 'server' ? 'https://wxapi.aibuzz.cn/api' : 'http://localhost:4000/api'));
const version = arg('version', process.env.WEAPP_APP_VERSION || process.env.TARO_APP_VERSION || pkg.version || 'dev');
const gitSha = process.env.WEAPP_BUILD_SHA || process.env.TARO_APP_BUILD_SHA || (() => {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: APP_ROOT, encoding: 'utf8' }).trim(); }
  catch (_) { return 'unknown'; }
})();

// 构建期为小程序输出主题色 SVG：所有功能图形统一从 Lucide 官方静态包读取。
const ICON_COLORS = {
  neutral: '#969BA1',
  ink: '#16191D',
  brand: '#143726',
  white: '#FFFFFF',
  danger: '#9C4A38',
  gold: '#A07D2C',
  green: '#1E5A43',
  red: '#9E2B25',
  blue: '#1F4E79',
  purple: '#5B3A6B',
  iron: '#33373D',
};

// 产品内部语义名 → Lucide 官方图标名。功能图标均来自 lucide-static（ISC），
// 避免自行绘制导致风格分裂。
const LUCIDE_ICON_MAP = {
  home: 'house',
  grid: 'layout-grid',
  agent: 'bot',
  user: 'user',
  chat: 'message-square',
  conversation: 'messages-square',
  insight: 'sun',
  mic: 'mic',
  attach: 'paperclip',
  send: 'arrow-right',
  arrow: 'chevron-right',
  up: 'arrow-up',
  plus: 'plus',
  chevron: 'chevron-down',
  collapse: 'chevron-up',
  back: 'chevron-left',
  close: 'x',
  more: 'ellipsis',
  stop: 'square',
  play: 'play',
  alert: 'triangle-alert',
  trend: 'trending-up',
  check: 'check',
  target: 'target',
  layers: 'layers',
  doc: 'file-text',
  image: 'image',
  video: 'video',
  pen: 'pen-line',
  spark: 'sparkles',
  chart: 'chart-no-axes-column-increasing',
  clock: 'clock',
  flow: 'git-branch',
  // 「这里可以切换」的可供性图标：角色标签、数字人行都要用它明示可点。
  swap: 'arrow-left-right',
  bolt: 'zap',
  shield: 'shield-check',
  crown: 'crown',
  flag: 'flag',
  token: 'scroll-text',
  pouch: 'archive',
  upload: 'upload',
  copy: 'copy',
  trash: 'trash-2',
  lock: 'lock-keyhole',
  diamond: 'gem',
  phone: 'smartphone',
  wechat: 'messages-square',
  group: 'users',
  square: 'square',
  radio: 'circle',
  radioChecked: 'circle-dot',
};

// 聊天输入的两个 textarea 现在住在主包共享模板 chat-core/composer.wxml 里，
// 宿主页只剩页头与模板引用；每个 <import> 了 composer 模板的宿主页都要列进来，
// 文件缺失本身就让构建失败，防止铁律检查随文件搬家静默失效。
// 当前宿主：chat 分包页 + 问策 tab 终态（对话即 tab）。
const CHAT_TEXTAREA_TARGETS = ['chat-core/composer.wxml', 'packages/main/chat/index.wxml', 'pages/sessions/index.wxml'];

if (!['mock', 'server'].includes(mode)) throw new Error(`无效 --mode ${mode}，只允许 mock/server`);
if (mode === 'server' && !/^https:\/\//.test(api)) throw new Error(`server 构建必须使用 HTTPS API：${api}`);

function walk(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(full)); else files.push(full);
  }
  return files;
}

function ensureParent(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }

// 微信开发者工具会持续监听 miniprogramRoot。若构建时把 dist-native 根目录本身
// 删除再重建，macOS 下它偶发丢失文件监听并误报某个已存在的 WXML “not found”。
// 保留根目录 inode，只清理其子项，IDE 的本地预览就能稳定跟随重建结果。
function clearOutputRoot() {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  for (const entry of fs.readdirSync(OUTPUT_ROOT)) {
    fs.rmSync(path.join(OUTPUT_ROOT, entry), { recursive: true, force: true });
  }
}

// 底栏五 tab 的图标不走 lucide，改用 H5 Icon 组件的自绘路径（src/components/Icon/index.tsx 的 PATHS）。
// 动因（2026-08-09 视觉反馈）：lucide 默认 stroke-width 2，22px 下明显偏粗；且 `pouch` 映到 lucide
// 的 archive 是个收纳箱——为补它的视觉分量曾单独放大到 26px，造成「锦囊不激活也大一号」。
// H5 那套是 stroke 1.6 的自绘线稿（锦囊是真的袋形），两端从此同一套字形。
// 路径直接从 tsx 里正则抽取：格式是稳定的单行 `  name: '<path .../>'`，抽不到就构建失败，
// 不会静默退回 lucide。
// 新五键 = 2026-08-09 重设计的底栏图标（问策泡/沙盘旗台/点兵名册/锦囊束口袋/主公玉玺）；
// 老五键仍被报告卡/项目页等处消费，继续按 H5 同源路径发射，不回退 lucide。
// codex = 图籍专用书册（2026-08-12）；muster 仍要发射——老键在别处消费，且它还是 H5 侧的资产。
const CUSTOM_TAB_ICONS = ['counsel', 'sandtable', 'muster', 'brocade', 'lord', 'codex', 'conversation', 'flag', 'token', 'pouch', 'crown'];
function extractIconPaths(names) {
  const source = fs.readFileSync(path.join(APP_ROOT, 'src', 'components', 'Icon', 'index.tsx'), 'utf8');
  const paths = {};
  for (const name of names) {
    const m = source.match(new RegExp(`^\\s{2}${name}: '(.+)',$`, 'm'));
    if (!m) throw new Error(`未能从 Icon/index.tsx 抽出 ${name} 的路径——PATHS 写法变了就同步改这里`);
    paths[name] = m[1];
  }
  return paths;
}

function emitSharedIcons() {
  const targetRoot = path.join(OUTPUT_ROOT, 'assets', 'native-icons');
  fs.mkdirSync(targetRoot, { recursive: true });
  const lucideRoot = path.join(APP_ROOT, 'node_modules', 'lucide-static');
  const licenseFile = path.join(lucideRoot, 'LICENSE');
  if (!fs.existsSync(licenseFile)) throw new Error('缺少 lucide-static，请先 npm install');
  fs.copyFileSync(licenseFile, path.join(targetRoot, 'LUCIDE-LICENSE.txt'));
  for (const [name, lucideName] of Object.entries(LUCIDE_ICON_MAP)) {
    if (CUSTOM_TAB_ICONS.includes(name)) continue; // 底栏五图标走下面的自绘发射
    const sourceFile = path.join(lucideRoot, 'icons', `${lucideName}.svg`);
    if (!fs.existsSync(sourceFile)) throw new Error(`Lucide 图标不存在：${lucideName}`);
    const source = fs.readFileSync(sourceFile, 'utf8');
    for (const [tone, color] of Object.entries(ICON_COLORS)) {
      fs.writeFileSync(path.join(targetRoot, `${name}-${tone}.svg`), source.replaceAll('currentColor', color));
    }
  }
  // 与 H5 Icon 组件 dataUri() 同一 SVG 骨架（viewBox 24 / stroke 1.6 / round），CCC 是填充色占位。
  const customPaths = extractIconPaths(CUSTOM_TAB_ICONS);
  for (const [name, inner] of Object.entries(customPaths)) {
    for (const [tone, color] of Object.entries(ICON_COLORS)) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner.replaceAll('CCC', color)}</svg>`;
      fs.writeFileSync(path.join(targetRoot, `${name}-${tone}.svg`), svg);
    }
  }
}

function emitStandaloneDevtoolsConfig() {
  const source = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'project.config.json'), 'utf8'));
  const config = {
    ...source,
    miniprogramRoot: '',
    projectname: `${source.projectname || 'junshi-app'}-native-local`,
  };
  // dist-native 可作为独立项目导入，规避部分 DevTools RC 版本在外层
  // miniprogramRoot 热重建后保留旧文件索引的问题；只用于本地编译，不参与上传。
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'project.config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

// 字体 token 落成字面量（只在小程序产物里做，H5 不动）。
//
// 现象（2026-08-09 真机）：同一台 OPPO，Chrome 与微信内置浏览器打开 H5/运营后台，中文都是宋体；
// 只有小程序里不是。两个浏览器环境证明设备有中文衬线字体、字体栈本身也没写错，
// 差别只剩「小程序的 WXSS 运行时」这一处。而本仓早有两处教训写着真机对 page 级 token 不可靠
// （见 src/app.scss 的 z-index 注释与主题类必须就地覆盖业务主色的注释）——
// font-family 走的正是同一条 `page` 定义 + 子元素 var() 取值的链路。
//
// 所以把 --serif / --sans 在编译产物里直接展开成字面量：SCSS 里仍是单一事实源（改 token 即可），
// 但小程序真机不再需要在运行时解析这两个变量。对浏览器零影响，改错也只是白写一遍同样的值。
const FONT_TOKEN_RE = /^\s*--(serif|sans):\s*([^;]+);/gm;
/** 自带字体的 family 名：必须与 src/app.scss 字体栈第一位、config/env.js 的 FONT_FAMILY 三处一致。 */
const APP_FONT_FAMILY = 'JunshiSerif';
// 字体托管位置：与 H5 同一份文件、同一个地址（H5 走同源 `/fonts`，小程序只能给绝对地址）。
// 文件由 app/src/assets/fonts/ 随 H5 产物发布，所以**发小程序前要先发过一次 H5**。
// ⚠️ 该域名必须在微信后台的 downloadFile 合法域名里，否则 loadFontFace 会被直接拒绝。
const APP_FONT_BASE = (process.env.WEAPP_APP_FONT_BASE || 'https://wxapi.aibuzz.cn/fonts').replace(/\/+$/, '');
/** 只发 400/600 两个字重：正文与标题各一份，合计约 1.8MB；其余字重由渲染器就近取，不再多下文件。 */
const APP_FONT_WEIGHTS = [400, 600];
function fontTokenLiterals() {
  const tokens = new Map();
  const css = fs.readFileSync(path.join(APP_ROOT, 'src', 'app.scss'), 'utf8');
  for (const m of css.matchAll(FONT_TOKEN_RE)) tokens.set(m[1], m[2].trim());
  if (!tokens.has('serif') || !tokens.has('sans')) {
    throw new Error('未能从 src/app.scss 解析出 --serif / --sans 字体栈：字体 token 改名了就得同步改这里');
  }
  return tokens;
}
function inlineFontTokens(css) {
  const tokens = fontTokenLiterals();
  return css
    .replace(/var\(--serif\)/g, tokens.get('serif'))
    .replace(/var\(--sans\)/g, tokens.get('sans'));
}

function build() {
  clearOutputRoot();
  const sourceFiles = walk(SOURCE_ROOT);
  for (const source of sourceFiles) {
    const relative = path.relative(SOURCE_ROOT, source);
    if (relative === path.join('config', 'env.js')) continue;
    if (source.endsWith('.scss')) {
      const target = path.join(OUTPUT_ROOT, relative.replace(/\.scss$/, '.wxss'));
      ensureParent(target);
      const result = sass.compile(source, { style: 'expanded', loadPaths: [APP_ROOT] });
      fs.writeFileSync(target, inlineFontTokens(result.css));
    } else {
      const target = path.join(OUTPUT_ROOT, relative);
      ensureParent(target);
      fs.copyFileSync(source, target);
    }
  }
  fs.cpSync(ASSET_ROOT, path.join(OUTPUT_ROOT, 'assets'), { recursive: true });
  emitSharedIcons();
  // 自带字体：FONT_BASE 置空 → services/font.js 直接跳过加载，CSS 落回系统字体，本地开发不受影响。
  // family 名与 src/app.scss 字体栈第一位必须一致（构建期展开成字面量，见 inlineFontTokens）。
  const envSource = `module.exports = ${JSON.stringify({ APP_MODE: mode, BASE_URL: api, CONFIGURED_API: apiExplicit ? api : '', API_EXPLICIT: apiExplicit, VERSION: version, GIT_SHA: gitSha, STREAM_CHAT: process.env.WEAPP_APP_STREAM !== '0', FONT_FAMILY: APP_FONT_FAMILY, FONT_BASE: APP_FONT_BASE, FONT_WEIGHTS: APP_FONT_WEIGHTS }, null, 2)};\n`;
  ensureParent(path.join(OUTPUT_ROOT, 'config', 'env.js'));
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'config', 'env.js'), envSource);
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'junshi-build-meta.json'), JSON.stringify({ schemaVersion: 2, runtime: 'native-weapp', mode, api, apiExplicit, version, gitSha }, null, 2));
  emitStandaloneDevtoolsConfig();
  validate(sourceFiles);
  console.log(`[native-weapp] ✓ ${mode.toUpperCase()} · ${api} · v${version} · ${gitSha}`);
  console.log(`[native-weapp] ✓ output ${OUTPUT_ROOT}`);
}

function validate(sourceFiles) {
  for (const source of sourceFiles.filter((file) => /\.(js|json|wxml|scss)$/.test(file))) {
    const text = fs.readFileSync(source, 'utf8');
    if (/@tarojs|Taro\./.test(text)) throw new Error(`原生源码不得引用 Taro：${path.relative(APP_ROOT, source)}`);
  }
  const sourceAppJson = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, 'app.json'), 'utf8'));
  const sourcePages = [...(sourceAppJson.pages || [])];
  for (const pkg of sourceAppJson.subPackages || []) for (const page of pkg.pages || []) sourcePages.push(`${pkg.root}/${page}`);
  for (const page of sourcePages) {
    for (const ext of ['.js', '.json', '.wxml', '.scss']) {
      const file = path.join(SOURCE_ROOT, `${page}${ext}`);
      if (!fs.existsSync(file)) throw new Error(`原生页面源码缺失：${path.relative(SOURCE_ROOT, file)}`);
    }
  }
  const appJson = JSON.parse(fs.readFileSync(path.join(OUTPUT_ROOT, 'app.json'), 'utf8'));
  if (appJson.lazyCodeLoading !== 'requiredComponents') throw new Error('app.json 缺少 lazyCodeLoading=requiredComponents');
  const pages = [...(appJson.pages || [])];
  for (const pkg of appJson.subPackages || []) for (const page of pkg.pages || []) pages.push(`${pkg.root}/${page}`);
  for (const page of pages) {
    for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
      const file = path.join(OUTPUT_ROOT, `${page}${ext}`);
      if (!fs.existsSync(file)) throw new Error(`页面产物缺失：${path.relative(OUTPUT_ROOT, file)}`);
    }
  }
  for (const file of walk(OUTPUT_ROOT).filter((item) => item.endsWith('.js'))) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  }
  const allJs = walk(OUTPUT_ROOT).filter((file) => file.endsWith('.js')).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  if (/@tarojs|Taro\./.test(allJs)) throw new Error('dist-native 仍包含 Taro 运行时引用');
  // 聊天输入铁律的校验目标必须显式列全：composer 已抽到主包 chat-core，
  // 只扫分包页会让铁律随文件搬家而静默失效，所以文件缺失本身就要报错。
  // 铁律守的是「编辑过程中回灌」，不是「出现 value 三个字母」。长文粘贴归卷后必须把用户
  // 自己打的提问留在输入框里（他打不到 2000 字，超限的必然是粘进来那段），而原生唯一的
  // 实现路径就是交替挂载时给新节点一次性初值。所以放行 value="{{composerSeed}}" 这一种
  // 精确绑定，把守门位置挪到下面：真正会复现输入法重复上屏与光标跳尾的是编辑期改 seed。
  for (const relative of CHAT_TEXTAREA_TARGETS) {
    const file = path.join(OUTPUT_ROOT, relative);
    if (!fs.existsSync(file)) throw new Error(`聊天 textarea 校验目标缺失：${relative}（铁律检查不得随文件搬家失效）`);
    const source = fs.readFileSync(file, 'utf8');
    for (const tag of source.match(/<textarea\b[^>]*>/g) || []) {
      const bound = tag.match(/\bvalue="([^"]*)"/);
      if (bound && bound[1] !== '{{composerSeed}}') {
        throw new Error(`原生聊天 textarea 只允许 value="{{composerSeed}}" 这一种一次性初值（${relative} 出现 value="${bound[1]}"）：其它受控绑定会重新引入华为/百度输入法重复与光标跳尾问题`);
      }
    }
  }
  const behaviorFile = path.join(OUTPUT_ROOT, 'chat-core/behavior.js');
  if (!fs.existsSync(behaviorFile)) throw new Error('chat-core/behavior.js 缺失：编辑期回灌校验不得随文件搬家失效');
  const onComposerInput = fs.readFileSync(behaviorFile, 'utf8').match(/\bonComposerInput\(event\)\s*\{[\s\S]*?\n {2}\},/);
  if (!onComposerInput) throw new Error('未能定位 onComposerInput：编辑期回灌校验不得随重构静默失效');
  if (/composerSeed/.test(onComposerInput[0])) {
    throw new Error('onComposerInput 不得写 composerSeed：编辑过程中回灌 textarea 会重新引入华为/百度输入法重复与光标跳尾问题');
  }
}

build();

if (args.includes('--watch')) {
  console.log('[native-weapp] watching weapp-native/ and shared styles…');
  let timer = null;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { try { build(); } catch (error) { console.error(error); } }, 120);
  };
  fs.watch(SOURCE_ROOT, { recursive: true }, rebuild);
  fs.watch(path.join(APP_ROOT, 'src'), { recursive: true }, (_, filename) => { if (filename && filename.endsWith('.scss')) rebuild(); });
}
