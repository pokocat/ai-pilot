const { getApiBaseUrl, useMockApi, PRODUCTION_API } = require('./runtime-mode');

const PREPRODUCTION_API = 'https://wxapi.aibuzz.cn/api_preprod';
const LABELS = { mock: 'MOCK', local: 'LOCAL', preprod: 'PREPROD', prod: 'PROD' };

function normalizeApi(value) {
  return String(value || '').trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/**
 * 角标描述的是当前请求真正会去哪里，而不只是构建时的 APP_MODE：mock 包附身为真实 JWT 后
 * 会切到配置的服务端，这时角标也必须跟着变，避免把真实数据误认成 mock。
 */
function classifyBackendEnvironment(options) {
  const opts = options || {};
  const mock = typeof opts.mock === 'boolean' ? opts.mock : useMockApi();
  if (mock) return 'mock';
  const api = normalizeApi(Object.prototype.hasOwnProperty.call(opts, 'baseUrl') ? opts.baseUrl : getApiBaseUrl());
  if (api === normalizeApi(PREPRODUCTION_API) || /\/api_preprod(?:\/|$)/.test(api)) return 'preprod';
  if (api === normalizeApi(PRODUCTION_API)) return 'prod';
  // 非官方生产/预发地址都属于本机或临时联调入口（局域网、HTTPS tunnel 等）。
  return 'local';
}

function miniProgramEnvVersion() {
  try {
    const account = wx.getAccountInfoSync();
    return String(account && account.miniProgram && account.miniProgram.envVersion || '');
  } catch (_) {
    // 取不到微信版本身份时安全隐藏，不能让体验版/正式版因兜底而泄露开发角标。
    return '';
  }
}

function shouldShowBackendEnvironmentBadge(envVersion) {
  return envVersion === 'develop';
}

function backendEnvironmentData() {
  const backendEnvironment = classifyBackendEnvironment();
  return {
    backendEnvironment,
    backendEnvironmentLabel: LABELS[backendEnvironment],
    showBackendEnvironmentBadge: shouldShowBackendEnvironmentBadge(miniProgramEnvVersion()),
  };
}

module.exports = {
  PREPRODUCTION_API,
  classifyBackendEnvironment,
  shouldShowBackendEnvironmentBadge,
  backendEnvironmentData,
};
