#!/usr/bin/env node
/**
 * 用 miniprogram-ci 上传 dist/ 到微信小程序后台。
 *
 *   PRIVATE_KEY_PATH=/path/to/private.key \
 *   UPLOAD_VERSION=0.1.0 \
 *   UPLOAD_DESC="..." \
 *     node scripts/upload-weapp.js
 *
 * 密钥从环境变量或第一个 CLI 参数读入，绝不入库。
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const ci = require('miniprogram-ci');

const APP_ROOT = path.resolve(__dirname, '..');
const projectConfig = JSON.parse(
  fs.readFileSync(path.join(APP_ROOT, 'project.config.json'), 'utf8'),
);
const pkg = JSON.parse(
  fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'),
);
const DIST_ROOT = path.join(APP_ROOT, projectConfig.miniprogramRoot || 'dist/');
const EXPECTED_API =
  process.env.WEAPP_EXPECTED_API ||
  process.env.TARO_APP_API ||
  'https://wxapi.aibuzz.cn/api';

function readBuiltJs(dir) {
  let out = '';
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out += readBuiltJs(p);
    else if (name.endsWith('.js')) out += fs.readFileSync(p, 'utf8');
  }
  return out;
}

function assertServerBuild() {
  if (!fs.existsSync(path.join(DIST_ROOT, 'app.json'))) {
    console.error('Missing built app.json. Run npm run build:weapp:server first.');
    process.exit(1);
  }
  const bundle = readBuiltJs(DIST_ROOT);
  if (!bundle.includes(EXPECTED_API)) {
    console.error(`dist missing expected API ${EXPECTED_API}. Run npm run build:weapp:server before upload.`);
    process.exit(1);
  }
  if (bundle.includes('http://localhost:4000/api')) {
    console.error('dist still contains default localhost API; refusing to upload a mock/dev build.');
    process.exit(1);
  }
}

const privateKeyPath =
  process.env.PRIVATE_KEY_PATH || process.argv[2];
if (!privateKeyPath || !fs.existsSync(privateKeyPath)) {
  console.error(
    'Missing PRIVATE_KEY_PATH env var or CLI arg pointing to the upload key.',
  );
  process.exit(1);
}

const version = process.env.UPLOAD_VERSION || pkg.version;
let desc = process.env.UPLOAD_DESC;
if (!desc) {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: APP_ROOT,
    })
      .toString()
      .trim();
    const sha = execSync('git rev-parse --short HEAD', { cwd: APP_ROOT })
      .toString()
      .trim();
    desc = `${branch}@${sha}`;
  } catch {
    desc = `build ${new Date().toISOString()}`;
  }
}

const project = new ci.Project({
  appid: projectConfig.appid,
  type: 'miniProgram',
  projectPath: DIST_ROOT,
  privateKeyPath,
  ignores: ['node_modules/**/*'],
});

(async () => {
  assertServerBuild();
  console.log(`Uploading appid=${projectConfig.appid} version=${version}`);
  console.log(`desc: ${desc}`);
  const result = await ci.upload({
    project,
    version,
    desc,
    setting: {
      es6: true,
      es7: true,
      minify: true,
      autoPrefixWXSS: true,
    },
    onProgressUpdate: (info) => {
      if (typeof info === 'string') {
        console.log(info);
      } else if (info && info._msg) {
        console.log(`[${info._status}] ${info._msg}`);
      }
    },
  });
  console.log('Upload OK:', JSON.stringify(result, null, 2));
})().catch((err) => {
  console.error('Upload failed:', err && err.message ? err.message : err);
  process.exit(1);
});
