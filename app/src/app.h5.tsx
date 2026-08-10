import { PropsWithChildren } from 'react';
import { createPortal } from 'react-dom';
import Taro, { useLaunch } from '@tarojs/taro';
import CustomTabBar from './custom-tab-bar';
import { store, setHostHooks } from './services/store';
import { setToken } from './services/token';
import { setPlatform } from './services/platform';
import { syncTabBarHidden } from './services/tabbar';
import { prefetchWechatSubscribeTemplates } from './services/wechatSubscribe';
import './app.scss';
import './app.h5.scss';

// services 层已与 Taro 解耦（见 services/platform.ts）。移动端在这里把提示与导航换回 Taro 实现，
// 行为与解耦前逐帧一致；存储与请求沿用垫片的 Web 默认实现（Taro H5 底层本来就是 localStorage / XHR，
// 且垫片照抄了 Taro 的 {"data": v} 存储格式，老用户登录态不受影响）。
setPlatform({
  toast: (title) => { Taro.showToast({ title, icon: 'none' }); },
  confirm: (o) => Taro.showModal(o).then((r) => !!r.confirm),
  navigate: (url) => { void Taro.navigateTo({ url }); },
  relaunch: (url) => { void Taro.reLaunch({ url }); },
});

// store 里两处只有移动端才有意义的副作用（隐藏自定义底栏、预取微信订阅模板）由宿主注入。
// store 不再静态 import 这两个 Taro 模块，PC 包因此不会被拖进 Taro 运行时。
setHostHooks({
  onOverlayChange: syncTabBarHidden,
  onMeLoaded: () => { void prefetchWechatSubscribeTemplates(); },
});

// 附身登录（运营排查）：H5 链接可带 ?imp_token=<token>，以目标用户身份登入。
// Taro H5 用 hash 路由，参数可能落在 search（?imp_token=…）或 hash 内（#/pages/…?imp_token=…），两处都兜。
// 命中后落 token 到 storage，并用 replaceState 把 imp_token 从地址栏抹掉（避免链接被复制转发 / 残留在浏览历史）。
function consumeImpersonationToken(): boolean {
  if (typeof window === 'undefined') return false;
  const { search, hash, pathname } = window.location;
  const pick = (qs: string): string => {
    const i = qs.indexOf('?');
    if (i < 0) return '';
    return new URLSearchParams(qs.slice(i + 1)).get('imp_token') || '';
  };
  const token = pick(search) || pick(hash);
  if (!token) return false;
  setToken(token);
  try {
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
  return true;
}

function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    // 附身 token 注入需早于 loadMe（loadMe 依赖已落地的 token）
    consumeImpersonationToken();
    // 智能体注册表是公共数据，随时可拉；用户信息仅在已登录时拉取（内部已判断）
    store.loadAgents();
    store.loadMe();
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
