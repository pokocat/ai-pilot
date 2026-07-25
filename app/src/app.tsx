import { PropsWithChildren } from 'react';
import { useLaunch } from '@tarojs/taro';
import { store } from './services/store';
import { prefetchWechatSubscribeTemplates } from './services/wechatSubscribe';
import './app.scss';

function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    // 智能体注册表是公共数据，随时可拉；用户信息仅在已登录时拉取（内部已判断）
    store.loadAgents();
    store.loadMe();
    // 底栏角标（问策未读 / 军令待复盘）：启动即拉一次，之后各 tab 的 useDidShow 搭车刷新（内部 15 秒节流 + 未登录直返）
    void store.loadBadges();
    // 订阅模板配置预热：授权弹窗必须在点击手势内同步唤起，不能等这次请求（内部已判断登录/环境）
    void prefetchWechatSubscribeTemplates();
  });

  return children;
}

export default App;
