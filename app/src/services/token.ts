import Taro from '@tarojs/taro';

// 登录态 token（演示版 = userId）。单独成模块，供 api / mock 共用，避免循环依赖。
const KEY = 'junshi.userId';

export function getToken(): string {
  try { return Taro.getStorageSync(KEY) || ''; } catch { return ''; }
}
export function setToken(v: string) {
  Taro.setStorageSync(KEY, v);
}
export function clearToken() {
  try { Taro.removeStorageSync(KEY); } catch { /* noop */ }
}
