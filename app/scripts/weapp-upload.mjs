#!/usr/bin/env node
// 微信小程序上传（开发版）—— 官方 miniprogram-ci。上传后在 mp.weixin.qq.com「版本管理」可见，
// 可转「体验版」或「提交审核 → 发布」。本脚本只上传开发版，不会自动发布到全体用户。
//
// 前置：
//   1) 从 mp 后台下载「上传密钥」：开发管理 → 开发设置 → 小程序代码上传 → 生成并下载 private.<appid>.key
//   2) 把**本机公网 IP** 加进该密钥的 IP 白名单（同一页面），否则上传被拒。
//   3) 先 server 模式构建产物：
//      TARO_APP_MODE=server TARO_APP_API=https://wxapi.aibuzz.cn/api npm run build:weapp
//
// 用法（密钥只给路径，不要贴进聊天）：
//   WEAPP_UPLOAD_KEY=/绝对路径/private.<appid>.key \
//   npm run upload:weapp -- --version 0.2.0 --desc "知识库：我的资料库 + 上传"
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
const VERSION = arg('version', process.env.WEAPP_VERSION);
const DESC = arg('desc', process.env.WEAPP_DESC || '军师 · 例行更新');
const PROJ = path.join(APP_ROOT, 'dist');

const die = (m) => { console.error(`[weapp] ✗ ${m}`); process.exit(1); };
if (!KEY) die('缺少上传密钥：设 WEAPP_UPLOAD_KEY=/path/to/private.<appid>.key（mp 后台下载）');
if (!fs.existsSync(KEY)) die(`密钥文件不存在：${KEY}`);
if (!VERSION) die('缺少版本号：加 --version 0.2.0');
if (!fs.existsSync(path.join(PROJ, 'app.json'))) die(`未找到已构建产物 ${PROJ}/app.json —— 先跑 server 模式 build:weapp`);

const project = new ci.Project({
  appid: APPID,
  type: 'miniProgram',
  projectPath: PROJ,
  privateKeyPath: KEY,
  ignores: ['node_modules/**/*'],
});

console.log(`[weapp] 上传 appid=${APPID} version=${VERSION} desc="${DESC}"\n        from ${PROJ}`);
try {
  // 产物已由 Taro 构建并压缩，CI 不再二次编译/压缩，避免破坏已编译代码。
  const r = await ci.upload({
    project,
    version: VERSION,
    desc: DESC,
    setting: { es6: false, es7: false, minify: false, autoPrefixWXSS: false },
    onProgressUpdate: () => {},
  });
  console.log('[weapp] ✓ 上传成功 —— 开发版已在 mp 后台「版本管理」，可转体验版 / 提交审核。');
  console.log(JSON.stringify(r, null, 2));
} catch (e) {
  const msg = String(e?.message || e);
  if (/ip|白名单|whitelist|invalid ip/i.test(msg)) {
    die(`上传被拒：本机公网 IP 不在密钥白名单。到 mp 后台「上传密钥」页把当前外网 IP 加进白名单后重试。原始：${msg}`);
  }
  die(`上传失败：${msg}`);
}
