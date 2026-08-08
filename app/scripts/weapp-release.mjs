#!/usr/bin/env node
// 唯一推荐的小程序正式上传入口：
// 1) 用原生构建器强制重建 server 产物；2) 校验构建模式/API/版本；3) 从 dist-native 调微信 DevTools CLI 上传开发版。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertReleaseBuild } from './weapp-build-meta.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_ROOT = path.join(APP_ROOT, 'dist-native');
const args = process.argv.slice(2);
const arg = (key, fallback) => {
  const index = args.indexOf(`--${key}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const version = arg('version', process.env.WEAPP_VERSION);
const desc = arg('desc', process.env.WEAPP_DESC || '军师 · 例行更新');
const dryRun = args.includes('--dry-run');
const expectedApi = process.env.WEAPP_EXPECTED_API || 'https://wxapi.aibuzz.cn/api';
const defaultCli = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
const devtoolsCli = process.env.WECHAT_DEVTOOLS_CLI || (fs.existsSync(defaultCli) ? defaultCli : 'cli');

const die = (message) => {
  console.error(`[weapp-release] ✗ ${message}`);
  process.exit(1);
};
const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, {
    cwd: APP_ROOT,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) die(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
  return result;
};

if (!version) die('缺少版本号：npm run release:weapp -- --version 0.2.22 --desc "更新说明"');
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`版本号格式无效：${version}，应为 x.y.z`);

console.log(`[weapp-release] 正式构建 version=${version} api=${expectedApi}`);
run(process.execPath, [path.join('scripts', 'build-native-weapp.mjs'), '--mode', 'server', '--api', expectedApi, '--version', version], {
  env: {
    ...process.env,
    WEAPP_APP_VERSION: version,
    WEAPP_APP_API: expectedApi,
  },
});

let meta;
try {
  meta = assertReleaseBuild(DIST_ROOT, { expectedApi, expectedVersion: version });
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
console.log(`[weapp-release] ✓ 产物校验通过：SERVER · ${meta.api} · v${meta.version} · ${meta.gitSha}`);
if (!fs.existsSync(path.join(DIST_ROOT, 'project.config.json'))) {
  die('dist-native 缺少独立 project.config.json；拒绝把外层 Taro 工程交给微信开发者工具。');
}
if (dryRun) {
  console.log('[weapp-release] ✓ dry-run 完成，未调用微信上传。');
  process.exit(0);
}

const login = spawnSync(devtoolsCli, ['islogin', '--project', DIST_ROOT], {
  cwd: APP_ROOT,
  encoding: 'utf8',
});
if (login.error) die(login.error.message);
const loginOutput = `${login.stdout || ''}\n${login.stderr || ''}`;
if (login.status !== 0 || !/"login"\s*:\s*true/.test(loginOutput)) {
  process.stdout.write(loginOutput);
  die('微信开发者工具未登录，请扫码登录后重试。');
}

console.log(`[weapp-release] 上传开发版 version=${version} desc="${desc}"`);
run(devtoolsCli, ['upload', '--project', DIST_ROOT, '-v', version, '-d', desc]);
console.log('[weapp-release] ✓ 上传成功；开发版已进入微信后台，尚未自动提交审核或发布。');
