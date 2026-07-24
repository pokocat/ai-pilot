import { PropsWithChildren } from 'react';
import { createPortal } from 'react-dom';
import { useLaunch } from '@tarojs/taro';
import CustomTabBar from './custom-tab-bar';
import { store } from './services/store';
import { api } from './services/api';
import './app.scss';
import './app.h5.scss';

// 附身登录（运营排查）：H5 链接可带 ?imp_token=<token>，以目标用户身份登入。
// Taro H5 用 hash 路由，参数可能落在 search（?imp_token=…）或 hash 内（#/pages/…?imp_token=…），两处都兜。
// 与小程序端 ImpersonateSheet（components/ImpersonateSheet）同口径「先验后登」：先用该 token 调一次
// /me 验证有效，验证通过才 store.afterLogin 落地；无效/过期一律不碰 storage（不清、不写）。
// 这道验证不可省——地址栏参数是不可信输入，若不验证直接 setToken：
// ①伪造/过期/残缺的 imp_token 会把当前浏览器里已登录用户的正常会话直接顶掉，之后请求 401，
//   被全局 onAuthLost 强制登出，只因打开了一个坏链接；
// ②任何人都能拼一条 `https://<H5域名>/?imp_token=<自己的普通登录 token>` 发给受害者，受害者一旦点开，
//   会话被静默切到发链接者的账号且没有任何提示，后续在此账号下的操作（充值、绑定手机号、上传资料等）
//   实际落在发链接者名下——这正是「验证与登录耦合、跳过校验直接登入」的会话固定风险。
// 验证通过后仍会 replaceState 把 imp_token 从地址栏抹掉（无论成败，避免坏/敏感 token 残留浏览历史）。
function extractImpToken(): string {
  if (typeof window === 'undefined') return '';
  const { search, hash } = window.location;
  const pick = (qs: string): string => {
    const i = qs.indexOf('?');
    if (i < 0) return '';
    return new URLSearchParams(qs.slice(i + 1)).get('imp_token') || '';
  };
  return pick(search) || pick(hash);
}

function stripImpTokenFromUrl(): void {
  if (typeof window === 'undefined') return;
  try {
    const { search, hash, pathname } = window.location;
    const strip = (qs: string): string => {
      const i = qs.indexOf('?');
      if (i < 0) return qs;
      const head = qs.slice(0, i);
      const params = new URLSearchParams(qs.slice(i + 1));
      params.delete('imp_token');
      const rest = params.toString();
      return rest ? `${head}?${rest}` : head;
    };
    window.history.replaceState(null, '', `${pathname}${strip(search)}${strip(hash)}`);
  } catch { /* 地址栏清理失败不阻断登入 */ }
}

async function consumeImpersonationToken(): Promise<boolean> {
  const token = extractImpToken();
  if (!token) return false;
  let ok = false;
  try {
    // 先验后登：用传入 token 直连 /me（不落 storage、不触发全局登出）；无效/过期在此抛错。
    const me = await api.verifyImpersonation(token);
    const onboarded = typeof me.onboarded === 'boolean' ? me.onboarded : true;
    await store.afterLogin(token, onboarded, me.user.benmingColor);
    ok = true;
  } catch {
    ok = false; // 令牌无效/过期：不落地、不影响已存在的登录态
  }
  stripImpTokenFromUrl();
  return ok;
}

function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    void (async () => {
      // 附身 token 消费需早于默认 loadMe/loadAgents；验证通过时 afterLogin 内部已含 loadMe+loadAgents，
      // 无需重复拉取；无 token 或验证失败则走默认已登录/未登录判断。
      const consumed = await consumeImpersonationToken();
      if (!consumed) {
        // 智能体注册表是公共数据，随时可拉；用户信息仅在已登录时拉取（内部已判断）
        store.loadAgents();
        store.loadMe();
      }
    })();
  });

  // H5 白屏防线：Taro 把 `taro_router` 类加在 #app 容器上，页面 `.taro_page` 由 router
  // 命令式挂载到其下。若把悬浮底栏作为 #app 的直接子节点渲染，它会（在弹层开合、页面 stationed
  // 重排等时序下）成为 `.taro_router` 的最后一个直接子元素，触发 Taro 路由样式
  // `.taro_router > .taro_page…:not(.taro_tabbar_page):not(:last-child){display:none}`
  // 把当前非 tabBar 页（如 packages/main/chat）整页隐藏 → 只剩底栏的白屏。
  // 底栏本就是 position:fixed 脱离文档流，portal 到 body 后彻底不再是 `.taro_router` 的子元素，规则无从命中。
  const tabBar = typeof document !== 'undefined'
    ? createPortal(<CustomTabBar />, document.body)
    : <CustomTabBar />;

  return (
    <>
      {children}
      {tabBar}
    </>
  );
}

export default App;
