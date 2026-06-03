import { PropsWithChildren } from 'react';
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
  });

  return (
    <>
      {children}
      <CustomTabBar />
    </>
  );
}

export default App;
