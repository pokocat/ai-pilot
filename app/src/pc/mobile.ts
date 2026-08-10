// PC 未桌面化的长尾页统一交给移动 H5。默认 /pc/ 与移动站同源时 origin 为空；
// 独立域名构建会注入 wxapi.aibuzz.cn，避免在 copilot 域名重新打开 PC 自己。
const MOBILE_ORIGIN = (process.env.TARO_APP_MOBILE_ORIGIN || '').replace(/\/+$/, '');

export function mobileHashUrl(path: string) {
  return `${MOBILE_ORIGIN}/#${path.startsWith('/') ? path : `/${path}`}`;
}
