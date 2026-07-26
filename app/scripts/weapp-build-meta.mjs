import fs from 'node:fs';
import path from 'node:path';

export const BUILD_META_FILE = 'junshi-build-meta.json';

export function readBuildMeta(distRoot) {
  const metaPath = path.join(distRoot, BUILD_META_FILE);
  if (!fs.existsSync(metaPath)) {
    throw new Error(`缺少 ${BUILD_META_FILE}，这是旧产物或未通过项目脚本构建；拒绝上传。`);
  }
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    throw new Error(`${BUILD_META_FILE} 无法解析；拒绝上传。`);
  }
}

export function assertReleaseBuild(distRoot, { expectedApi, expectedVersion } = {}) {
  const meta = readBuildMeta(distRoot);
  if (meta.schemaVersion !== 1) {
    throw new Error(`构建元数据版本不受支持：${String(meta.schemaVersion)}；请重新构建。`);
  }
  if (meta.mode !== 'server') {
    throw new Error(`当前产物模式为 ${String(meta.mode).toUpperCase()}，不是 SERVER；拒绝上传。`);
  }
  if (!meta.api || meta.api.includes('localhost')) {
    throw new Error(`当前产物 API 为 ${String(meta.api || '空')}，疑似本地开发包；拒绝上传。`);
  }
  if (expectedApi && meta.api !== expectedApi) {
    throw new Error(`产物 API ${meta.api} 与目标 API ${expectedApi} 不一致；拒绝上传。`);
  }
  if (expectedVersion && meta.version !== expectedVersion) {
    throw new Error(`产物版本 ${meta.version} 与上传版本 ${expectedVersion} 不一致；拒绝上传。`);
  }
  return meta;
}
