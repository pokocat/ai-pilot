#!/usr/bin/env node
// 微信小程序「真机预览」—— 官方 miniprogram-ci ci.preview()。
// 生成预览二维码 PNG，用微信扫码即可在真机上实时运行当前构建产物（不进版本管理、不发布）。
//
// 前置：
//   1) mp 后台「上传密钥」下载 private.<appid>.key，并把**本机公网 IP** 加进该密钥 IP 白名单。
//   2) 先 server 模式构建产物：npm run build:weapp:server
//
// 用法（密钥只给路径，别贴聊天）：
//   WEAPP_UPLOAD_KEY=/abs/path/private.<appid>.key \
//   node scripts/weapp-preview.mjs --desc "真机预览"
import ci from 'miniprogram-ci';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const projectConfig = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'project.config.json'), 'utf8'));

const APPID = arg('appid', process.env.WEAPP_APPID || projectConfig.appid);
const KEY = process.env.WEAPP_UPLOAD_KEY || arg('key');
const DESC = arg('desc', process.env.WEAPP_DESC || '军师 · 真机预览');
const PAGE = arg('page', process.env.WEAPP_PAGE || '');           // 可选：指定打开页，如 pages/index/index
const PROJ = path.join(APP_ROOT, 'dist');
const QR_OUT = path.join(APP_ROOT, '..', 'weapp-preview.png');
const INFO_OUT = path.join(APP_ROOT, '..', 'weapp-auto-preview-info.json');

const die = (m) => { console.error(`[weapp] ✗ ${m}`); process.exit(1); };
if (!KEY) die('缺少上传密钥：设 WEAPP_UPLOAD_KEY=/path/to/private.<appid>.key');
if (!fs.existsSync(KEY)) die(`密钥文件不存在：${KEY}`);
if (!fs.existsSync(path.join(PROJ, 'app.json'))) die(`未找到构建产物 ${PROJ}/app.json —— 先跑 npm run build:weapp:server`);

const project = new ci.Project({
  appid: APPID,
  type: 'miniProgram',
  projectPath: PROJ,
  privateKeyPath: KEY,
  ignores: ['node_modules/**/*'],
});

console.log(`[weapp] 生成预览二维码 appid=${APPID} desc="${DESC}"\n        from ${PROJ}`);
try {
  const r = await ci.preview({
    project,
    desc: DESC,
    qrcodeFormat: 'image',
    qrcodeOutputDest: QR_OUT,
    setting: { es6: false, es7: false, minify: false, autoPrefixWXSS: false },
    pagePath: PAGE || undefined,
    onProgressUpdate: () => {},
  });
  fs.writeFileSync(INFO_OUT, JSON.stringify(r, null, 2));
  console.log(`[weapp] ✓ 预览二维码已生成：${QR_OUT}`);
  console.log(`        子包体积信息：${INFO_OUT}`);
} catch (e) {
  const msg = String(e?.message || e);
  if (/ip|白名单|whitelist|invalid ip/i.test(msg)) {
    die(`被拒：本机公网 IP 不在密钥白名单。到 mp 后台「上传密钥」页把当前外网 IP 加进白名单后重试。原始：${msg}`);
  }
  die(`生成失败：${msg}`);
}
