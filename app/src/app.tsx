import { PropsWithChildren } from 'react';
import { useLaunch } from '@tarojs/taro';
import { store } from './services/store';
import './app.scss';

function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    // 启动时拉取用户与智能体注册表（替代原型的本地常量）
    store.loadMe();
    store.loadAgents();
  });

  return children;
}

export default App;
