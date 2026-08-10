import { platform } from './platform';

// 登录态 token（演示版 = userId）。单独成模块，供 api / mock 共用，避免循环依赖。
// 存取走 platform 垫片：Taro H5 与 PC 用同一份存储格式（{"data": v}），同源下互认登录态。
const KEY = 'junshi.userId';

export function getToken(): string {
  return platform.storage.get(KEY);
}
export function setToken(v: string) {
  platform.storage.set(KEY, v);
}
export function clearToken() {
  platform.storage.remove(KEY);
}
