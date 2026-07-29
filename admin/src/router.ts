// 极简 hash 路由（零依赖，与 admin 只有 react/react-dom 的依赖口径一致）。
//
// 为什么需要：旧版当前 tab 与「打开了哪个用户/顾问详情」全在 React state 里，导致
//   ① 刷新丢现场（客服排查时最痛：F5 一下回到概览，得重新找人）；
//   ② 浏览器返回键要么无效、要么直接退出后台，详情面板返回不了；
//   ③ 排查现场没法分享——不能把「这个用户」的链接甩给同事。
// 现在 `#/<section>` + 可选 `#/<section>/<id>` 全部可直达、可分享、可返回。
//
// 形如：#/home  #/users  #/users/cms5lsrjv001f102sfo315l6c  #/agent/intel  #/payments

export interface Route {
  /** NAV_SECTIONS 里的 key；非法值由调用方兜底到 home */
  section: string;
  /** 详情 id（用户 id / agent key），空串表示无详情 */
  id: string;
  /** 查询参数：用于跨屏带上下文，如订单页「查用户」→ #/users?q=王总 */
  params: Record<string, string>;
}

export interface NavOptions {
  /** 不新增历史条目（兜底重定向用，避免返回键卡在非法地址上） */
  replace?: boolean;
  params?: Record<string, string>;
}

export function parseHash(hash = window.location.hash): Route {
  const raw = hash.replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  const pathPart = qi === -1 ? raw : raw.slice(0, qi);
  const queryPart = qi === -1 ? '' : raw.slice(qi + 1);
  const [section = '', id = ''] = pathPart.split('/');
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(queryPart)) params[k] = v;
  return { section: decodeURIComponent(section), id: decodeURIComponent(id), params };
}

export function toHash(section: string, id?: string, params?: Record<string, string>): string {
  const qs = params ? new URLSearchParams(params).toString() : '';
  return `#/${encodeURIComponent(section)}${id ? '/' + encodeURIComponent(id) : ''}${qs ? '?' + qs : ''}`;
}

/** 跳转（写 hash，由 hashchange 驱动渲染）。 */
export function navigate(section: string, id?: string, opts: NavOptions = {}): void {
  const next = toHash(section, id, opts.params);
  if (window.location.hash === next) return;
  if (opts.replace) {
    window.history.replaceState(null, '', next);
    // replaceState 不触发 hashchange，手动广播一次，保证订阅者重渲染。
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = next;
  }
}

/** 订阅 hash 变化。返回取消订阅。 */
export function onRouteChange(fn: () => void): () => void {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
}
