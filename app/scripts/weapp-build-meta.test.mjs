import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
