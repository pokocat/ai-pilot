import { PropsWithChildren } from 'react';
import { useLaunch, useDidShow } from '@tarojs/taro';
import { store } from './services/store';
import './app.scss';

function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    // 智能体注册表是公共数据，随时可拉；用户信息仅在已登录时拉取（内部已判断）
    store.loadAgents();
    store.loadMe();
    store.refreshSatchelDot();
  });

  // 回前台：最新报告比上次在锦囊看过的更晚 → 亮锦囊朱砂点
  useDidShow(() => {
    store.refreshSatchelDot();
  });

  return children;
}

export default App;
