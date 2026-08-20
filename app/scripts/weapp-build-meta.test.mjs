import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertNativeBuild,
  assertReleaseBuild,
  BUILD_META_FILE,
  BUILD_META_SCHEMA_VERSION,
  BUILD_RUNTIME,
  readBuildMeta,
} from './weapp-build-meta.mjs';

function withMeta(meta, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'junshi-weapp-meta-'));
  try {
    fs.writeFileSync(path.join(dir, BUILD_META_FILE), JSON.stringify(meta));
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const serverMeta = {
  schemaVersion: BUILD_META_SCHEMA_VERSION,
  runtime: BUILD_RUNTIME,
  mode: 'server',
  api: 'https://wxapi.aibuzz.cn/api',
  version: '0.2.21',
  gitSha: 'abc1234',
};

test('原生微信构建元数据固定为 schema 2 / native-weapp', () => {
  assert.equal(BUILD_META_SCHEMA_VERSION, 2);
  assert.equal(BUILD_RUNTIME, 'native-weapp');
});

test('原生 mock 产物可预览但不可上传', () => {
  withMeta({ ...serverMeta, mode: 'mock', api: 'http://localhost:4000/api' }, (dir) => {
    assert.equal(assertNativeBuild(dir).runtime, BUILD_RUNTIME);
    assert.throws(() => assertReleaseBuild(dir), /不是 SERVER/);
  });
});

test('server 构建模式、API 与版本一致时允许上传', () => {
  withMeta(serverMeta, (dir) => {
    assert.equal(assertReleaseBuild(dir, {
      expectedApi: serverMeta.api,
      expectedVersion: serverMeta.version,
    }).mode, 'server');
  });
});

test('mock 构建即使带生产 API 也必须拒绝上传', () => {
  withMeta({ ...serverMeta, mode: 'mock' }, (dir) => {
    assert.throws(
      () => assertReleaseBuild(dir, {
        expectedApi: serverMeta.api,
        expectedVersion: serverMeta.version,
      }),
      /不是 SERVER/
    );
  });
});

test('构建版本与上传版本不一致时拒绝上传', () => {
  withMeta(serverMeta, (dir) => {
    assert.throws(
      () => assertReleaseBuild(dir, {
        expectedApi: serverMeta.api,
        expectedVersion: '0.2.22',
      }),
      /版本.*不一致/
    );
  });
});

test('server 元数据仍使用 HTTP 时拒绝上传', () => {
  withMeta({ ...serverMeta, api: 'http://wxapi.aibuzz.cn/api' }, (dir) => {
    assert.throws(() => assertReleaseBuild(dir), /不是线上 HTTPS 地址/);
  });
});

test('元数据不是对象或缺少必填字段时拒绝', () => {
  withMeta(null, (dir) => {
    assert.throws(() => readBuildMeta(dir), /无法解析/);
  });
  withMeta({ ...serverMeta, gitSha: '' }, (dir) => {
    assert.throws(() => assertNativeBuild(dir), /gitSha 为空/);
  });
});

test('旧 Taro 微信产物即使是 server 模式也拒绝上传', () => {
  withMeta({ ...serverMeta, schemaVersion: 1, runtime: undefined }, (dir) => {
    assert.throws(() => assertReleaseBuild(dir, { expectedApi: serverMeta.api }), /版本不受支持/);
  });
});

test('schema 2 但不是 native-weapp 运行时也拒绝上传', () => {
  withMeta({ ...serverMeta, runtime: 'taro-weapp' }, (dir) => {
    assert.throws(() => assertReleaseBuild(dir, { expectedApi: serverMeta.api }), /不是原生微信小程序/);
  });
});

test('包体积不得顶穿微信上限：主包与各分包压缩后都要留够余量', () => {
  // 2026-08-19：主包曾达 2.54MB（上限 2MB）被这条挡住。根因是 build-native-weapp.mjs 把
  // app/src/assets/ 整目录拷进包，连 1.79MB 的 H5 字体一起带上了——而小程序侧根本不读包内
  // 字体（services/font.js 走 wx.loadFontFace 拉远程 URL）。构建脚本现已排除 fonts/。
  //
  // 微信算的是**压缩后**体积，所以这里用 zip 近似（真实打包略有差异，故阈值留 15% 余量）。
  // 这条守的不是某个具体文件，而是「谁往 src/assets/ 放了大东西」这类会静默顶穿上限的改动
  // ——那种问题只有上传到微信后台才会报，本地 tsc 与单测都看不出来。
  const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dist = path.join(distRoot, 'dist-native');
  if (!fs.existsSync(dist)) return; // 未构建时跳过（CI 里先 build 再跑本条）

  const SUBS = ['packages/main', 'packages/work', 'packages/video'];
  const walk = (root) => fs.readdirSync(root, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(root, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
  const groups = new Map([['主包', []], ...SUBS.map((s) => [s, []])]);
  for (const abs of walk(dist)) {
    const rel = path.relative(dist, abs).split(path.sep).join('/');
    const hit = SUBS.find((s) => rel.startsWith(`${s}/`));
    groups.get(hit ?? '主包').push(abs);
  }

  // 用 zlib 逐文件 deflate 求和近似压缩包体积（不引第三方 zip 库）
  const zipish = (files) => files.reduce(
    (sum, f) => sum + zlib.deflateSync(fs.readFileSync(f), { level: 9 }).length + 100, 0,
  );

  const LIMIT = 2 * 1024 * 1024;
  const BUDGET = LIMIT * 0.85; // 留 15% 余量：真实打包与 zip 近似有差异，且别贴着上限过
  for (const [name, files] of groups) {
    const size = zipish(files);
    assert.ok(
      size <= BUDGET,
      `${name} 压缩后约 ${(size / 1048576).toFixed(2)}MB，超出预算 ${(BUDGET / 1048576).toFixed(2)}MB`
      + `（微信硬上限 2MB）。别急着调高阈值——先看是不是又有大文件被拷进包了：`
      + `du -sh dist-native/assets/*`,
    );
  }

  // 字体必须不在包里（这是上面那个根因的定点守卫）
  assert.ok(
    !fs.existsSync(path.join(dist, 'assets/fonts')),
    'assets/fonts 不该进小程序包：小程序走 wx.loadFontFace 拉远程字体，包内那份是纯白占 1.79MB',
  );
});
