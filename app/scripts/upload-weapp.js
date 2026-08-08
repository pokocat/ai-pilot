#!/usr/bin/env node
/**
 * 旧手动入口的兼容桥：统一转交给 schema 2 / dist-native 的上传实现。
 *
 * 推荐使用：npm run upload:weapp -- --version x.y.z --desc "说明"
 * 仍兼容旧环境变量 PRIVATE_KEY_PATH / UPLOAD_VERSION / UPLOAD_DESC，
 * 但不再保留第二套构建校验与上传逻辑，避免口径漂移。
 */

if (!process.env.WEAPP_UPLOAD_KEY) {
  process.env.WEAPP_UPLOAD_KEY = process.env.PRIVATE_KEY_PATH || process.argv[2] || '';
}
if (!process.env.WEAPP_VERSION && process.env.UPLOAD_VERSION) {
  process.env.WEAPP_VERSION = process.env.UPLOAD_VERSION;
}
if (!process.env.WEAPP_DESC && process.env.UPLOAD_DESC) {
  process.env.WEAPP_DESC = process.env.UPLOAD_DESC;
}

import('./weapp-upload.mjs').catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
