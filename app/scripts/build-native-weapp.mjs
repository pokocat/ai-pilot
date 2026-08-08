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

function emitSharedIcons() {
  const targetRoot = path.join(OUTPUT_ROOT, 'assets', 'native-icons');
  fs.mkdirSync(targetRoot, { recursive: true });
  const lucideRoot = path.join(APP_ROOT, 'node_modules', 'lucide-static');
  const licenseFile = path.join(lucideRoot, 'LICENSE');
  if (!fs.existsSync(licenseFile)) throw new Error('缺少 lucide-static，请先 npm install');
  fs.copyFileSync(licenseFile, path.join(targetRoot, 'LUCIDE-LICENSE.txt'));
  for (const [name, lucideName] of Object.entries(LUCIDE_ICON_MAP)) {
    const sourceFile = path.join(lucideRoot, 'icons', `${lucideName}.svg`);
    if (!fs.existsSync(sourceFile)) throw new Error(`Lucide 图标不存在：${lucideName}`);
    const source = fs.readFileSync(sourceFile, 'utf8');
    for (const [tone, color] of Object.entries(ICON_COLORS)) {
      fs.writeFileSync(path.join(targetRoot, `${name}-${tone}.svg`), source.replaceAll('currentColor', color));
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
      fs.writeFileSync(target, result.css);
    } else {
      const target = path.join(OUTPUT_ROOT, relative);
      ensureParent(target);
      fs.copyFileSync(source, target);
    }
  }
  fs.cpSync(ASSET_ROOT, path.join(OUTPUT_ROOT, 'assets'), { recursive: true });
  emitSharedIcons();
  const envSource = `module.exports = ${JSON.stringify({ APP_MODE: mode, BASE_URL: api, CONFIGURED_API: apiExplicit ? api : '', API_EXPLICIT: apiExplicit, VERSION: version, GIT_SHA: gitSha, STREAM_CHAT: process.env.WEAPP_APP_STREAM !== '0' }, null, 2)};\n`;
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
  for (const relative of CHAT_TEXTAREA_TARGETS) {
    const file = path.join(OUTPUT_ROOT, relative);
    if (!fs.existsSync(file)) throw new Error(`聊天 textarea 校验目标缺失：${relative}（铁律检查不得随文件搬家失效）`);
    const source = fs.readFileSync(file, 'utf8');
    if (/<textarea[^>]+\bvalue=/.test(source)) {
      throw new Error(`原生聊天 textarea 禁止绑定 value（${relative}）：会重新引入华为/百度输入法重复与光标跳尾问题`);
    }
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
