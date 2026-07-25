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
    // 订阅模板配置预热：授权弹窗必须在点击手势内同步唤起，不能等这次请求（内部已判断登录/环境）
    void prefetchWechatSubscribeTemplates();
  });

  return children;
}

export default App;
