import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertReleaseBuild, BUILD_META_FILE } from './weapp-build-meta.mjs';

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
  schemaVersion: 1,
  mode: 'server',
  api: 'https://wxapi.aibuzz.cn/api',
  version: '0.2.21',
  gitSha: 'abc1234',
};

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
