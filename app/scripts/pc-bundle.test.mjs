import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pcSrc = path.join(appRoot, 'src', 'pc');

function walk(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

// PC 工作台是纯 React DOM + Vite 应用，与 Taro 彻底分家（services 层经 services/platform.ts 解耦）。
// 这道守卫防的是回归：只要有人在 src/pc/ 里 import 一个还带 Taro 的模块，
// 整个 Taro 运行时就会被重新拖进 PC 包（实测会胖 70KB+，且把小程序专用 API 带进浏览器）。
// 之所以做成源码级断言而不是只查产物：产物要先构建才有，源码级能在 typecheck/test 阶段就拦住。

test('PC 源码不得直接引用 Taro', () => {
  const offenders = walk(pcSrc)
    .filter((f) => /\.(ts|tsx|js|jsx)$/.test(f))
    .filter((f) => /@tarojs\//.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(appRoot, f));
  assert.deepEqual(offenders, [], `这些 PC 文件 import 了 Taro：${offenders.join(', ')}`);
});

// services 里这几个模块仍是小程序专属（微信支付、原生底栏、订阅消息、小程序文件系统、
// 画布分享图），它们照旧 import Taro —— 这没问题，但 PC 不能碰，碰了就等于把 Taro 请回来。
const TARO_BOUND_SERVICES = [
  'pay', 'tabbar', 'wechatSubscribe', 'creative', 'canvasCard', 'reportShareCard', 'posterPending', 'nav',
];

test('PC 源码不得引用仍绑定 Taro 的 services 模块', () => {
  const pattern = new RegExp(`services/(${TARO_BOUND_SERVICES.join('|')})['"]`);
  const offenders = walk(pcSrc)
    .filter((f) => /\.(ts|tsx|js|jsx)$/.test(f))
    .filter((f) => pattern.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(appRoot, f));
  assert.deepEqual(offenders, [], `这些 PC 文件引用了小程序专属服务：${offenders.join(', ')}`);
});

// 业务层是两端共用的地基，回退成直连 Taro 就会让 PC 构建再次失败（或悄悄变胖）。
const SHARED_SERVICES = ['api.ts', 'store.ts', 'mock.ts', 'token.ts', 'chatPending.ts', 'dossier.ts', 'platform.ts'];

test('共用业务层保持无 Taro', () => {
  const offenders = SHARED_SERVICES
    .filter((name) => /@tarojs\//.test(fs.readFileSync(path.join(appRoot, 'src', 'services', name), 'utf8')));
  assert.deepEqual(offenders, [], `这些共用服务重新 import 了 Taro：${offenders.join(', ')}`);
});

// 构建过产物就顺带查一眼真身；没构建过不算失败（CI 里 build:pc 会先跑）。
test('dist-pc 产物不含 Taro 运行时', () => {
  const assetsDir = path.join(appRoot, 'dist-pc', 'assets');
  if (!fs.existsSync(assetsDir)) return;
  const offenders = fs.readdirSync(assetsDir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /tarojs|TaroElement|TaroRootElement/.test(fs.readFileSync(path.join(assetsDir, f), 'utf8')));
  assert.deepEqual(offenders, [], `PC 产物里出现 Taro：${offenders.join(', ')}`);
});
