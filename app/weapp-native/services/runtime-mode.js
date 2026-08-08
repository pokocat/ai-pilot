const env = require('../config/env');
const { getToken } = require('./token');

const PRODUCTION_API = 'https://wxapi.aibuzz.cn/api';
const DEFAULT_MOCK_API = 'http://localhost:4000/api';

/** 服务端登录态是三段 JWT；mock-/local- 等本地 token 不会命中。 */
function isSignedUserToken(token) {
  const parts = String(token || '').trim().split('.');
  return parts.length === 3 && parts.every(Boolean);
}

function shouldUseMock(mode, token) {
  return mode === 'mock' && !isSignedUserToken(token);
}

function resolveImpersonationBaseUrl(mode, baseUrl, configuredApi) {
  if (mode === 'server') return baseUrl;
  return String(configuredApi || '').trim() || PRODUCTION_API;
}

function resolveRuntimeBaseUrl(mode, baseUrl, impersonationBaseUrl, token) {
  return mode === 'mock' && isSignedUserToken(token) ? impersonationBaseUrl : baseUrl;
}

// 原生构建器的 mock 默认地址是 localhost；与默认值不同即代表构建时显式指定了 API。
// 同时兼容未来构建器直接写入 CONFIGURED_API / API_EXPLICIT 的形式。
function configuredApiUrl() {
  if (typeof env.CONFIGURED_API === 'string' && env.CONFIGURED_API.trim()) return env.CONFIGURED_API.trim();
  if (env.API_EXPLICIT === true) return String(env.BASE_URL || '').trim();
  const baseUrl = String(env.BASE_URL || '').trim();
  return env.APP_MODE === 'mock' && baseUrl && baseUrl !== DEFAULT_MOCK_API ? baseUrl : '';
}

function getImpersonationBaseUrl() {
  return resolveImpersonationBaseUrl(env.APP_MODE, env.BASE_URL, configuredApiUrl());
}

// mock 包落入有效三段 JWT 后，普通 API、上传与流式都必须切到真实后端。
function useMockApi() {
  return shouldUseMock(env.APP_MODE, getToken());
}

function getApiBaseUrl() {
  return resolveRuntimeBaseUrl(env.APP_MODE, env.BASE_URL, getImpersonationBaseUrl(), getToken());
}

module.exports = {
  PRODUCTION_API,
  DEFAULT_MOCK_API,
  isSignedUserToken,
  shouldUseMock,
  resolveImpersonationBaseUrl,
  resolveRuntimeBaseUrl,
  getImpersonationBaseUrl,
  useMockApi,
  getApiBaseUrl,
};
