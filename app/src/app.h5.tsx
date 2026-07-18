import { PropsWithChildren } from 'react';
import { createPortal } from 'react-dom';
import { useLaunch } from '@tarojs/taro';
import CustomTabBar from './custom-tab-bar';
import { store } from './services/store';
import './app.scss';
import './app.h5.scss';

function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    // 智能体注册表是公共数据，随时可拉；用户信息仅在已登录时拉取（内部已判断）
    store.loadAgents();
    store.loadMe();
    // 锦囊朱砂点：启动时比对最新报告时间与本地已看时间
    store.refreshSatchelDot();
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
