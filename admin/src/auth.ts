// 运营后台登录态：保存「管理员密钥」（对应后端 ADMIN_TOKEN），每次请求作为 x-admin-token 发送。
const KEY = 'junshi.admin.token';

export function getAdminToken(): string {
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}
export function setAdminToken(v: string) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* noop */
  }
}
export function clearAdminToken() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}
