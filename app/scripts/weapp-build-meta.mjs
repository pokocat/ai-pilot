import fs from 'node:fs';
import path from 'node:path';

export const BUILD_META_FILE = 'junshi-build-meta.json';
export const BUILD_META_SCHEMA_VERSION = 2;
export const BUILD_RUNTIME = 'native-weapp';

export function readBuildMeta(distRoot) {
  const metaPath = path.join(distRoot, BUILD_META_FILE);
  if (!fs.existsSync(metaPath)) {
    throw new Error(`缺少 ${BUILD_META_FILE}，这是旧产物或未通过项目脚本构建；拒绝上传。`);
  }
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('invalid metadata shape');
    return meta;
  } catch {
    throw new Error(`${BUILD_META_FILE} 无法解析；拒绝上传。`);
  }
}

export function assertNativeBuild(distRoot) {
  const meta = readBuildMeta(distRoot);
  if (meta.schemaVersion !== BUILD_META_SCHEMA_VERSION) {
    throw new Error(`构建元数据版本不受支持：${String(meta.schemaVersion)}；请重新构建。`);
  }
  if (meta.runtime !== BUILD_RUNTIME) {
    throw new Error(`当前产物运行时为 ${String(meta.runtime || '旧 Taro 微信端')}，不是原生微信小程序；拒绝上传。`);
  }
  if (!['mock', 'server'].includes(meta.mode)) {
    throw new Error(`当前产物模式无效：${String(meta.mode)}；请重新构建。`);
  }
  if (typeof meta.api !== 'string' || !meta.api) {
    throw new Error('当前产物 API 为空；请重新构建。');
  }
  if (typeof meta.version !== 'string' || !meta.version) {
    throw new Error('当前产物版本为空；请重新构建。');
  }
  if (typeof meta.gitSha !== 'string' || !meta.gitSha) {
    throw new Error('当前产物 gitSha 为空；请重新构建。');
  }
  return meta;
}

export function assertReleaseBuild(distRoot, { expectedApi, expectedVersion } = {}) {
  const meta = assertNativeBuild(distRoot);
  if (meta.mode !== 'server') {
    throw new Error(`当前产物模式为 ${String(meta.mode).toUpperCase()}，不是 SERVER；拒绝上传。`);
  }
  let apiUrl;
  try {
    apiUrl = new URL(meta.api);
  } catch {
    throw new Error(`当前产物 API ${meta.api} 不是有效 URL；拒绝上传。`);
  }
  if (apiUrl.protocol !== 'https:' || apiUrl.hostname === 'localhost' || apiUrl.hostname === '127.0.0.1') {
    throw new Error(`当前产物 API 为 ${meta.api}，不是线上 HTTPS 地址；拒绝上传。`);
  }
  if (expectedApi && meta.api !== expectedApi) {
    throw new Error(`产物 API ${meta.api} 与目标 API ${expectedApi} 不一致；拒绝上传。`);
  }
  if (expectedVersion && meta.version !== expectedVersion) {
    throw new Error(`产物版本 ${meta.version} 与上传版本 ${expectedVersion} 不一致；拒绝上传。`);
  }
  return meta;
}
