import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setPlatform } from '../services/platform';
import { store } from '../services/store';
import { setToken } from '../services/token';
import App from './App';
import { pushToast } from './toastBridge';
import './index.scss';

// PC 工作台入口。零 Taro：业务层（services/*）已通过 platform 垫片与运行时解耦，
// 这里只补 PC 自己的提示/导航实现，其余（存储、请求、上传）用垫片的 Web 默认实现。

setPlatform({
  toast: pushToast,
  // PC 用浏览器原生确认框（业务里只有权益不足/到期两处用到，频次极低，不值得自绘）。
  confirm: async (o) => window.confirm(`${o.title}\n\n${o.content}`),
  // 移动端路径 → PC 区。业务层里写死的是移动路由，这里做一次映射，
  // 映射不到的（长尾子页）打开移动版页面，避免"点了没反应"。
  navigate: (url) => { routeFromMobilePath(url); },
  relaunch: (url) => { routeFromMobilePath(url); },
});

const MOBILE_TO_PC: Record<string, string> = {
  '/pages/sessions/index': '#/sessions',
  '/pages/home/index': '#/sand',
  '/pages/studio/index': '#/exec',
  '/pages/thinktank/index': '#/think',
  '/pages/profile/index': '#/lord',
  '/packages/work/plans/index': '#/lord?view=plans',
  '/packages/work/credits/index': '#/lord?view=credits',
};

function routeFromMobilePath(url: string) {
  const path = url.split('?')[0];
  const target = MOBILE_TO_PC[path];
  if (target) { window.location.hash = target.slice(1); return; }
  // 未桌面化的页面：开新标签跳移动版，PC 这边不动。
  window.open(`/#${url}`, '_blank', 'noopener');
}

// 附身登录（运营排查）：?imp_token=<token> 以目标用户身份登入，随后从地址栏抹掉。
// 与移动 H5 同一套 token 存储格式，同源下两边互认。
(function consumeImpersonationToken() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('imp_token');
  if (!token) return;
  setToken(token);
  try {
    params.delete('imp_token');
    const qs = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
  } catch { /* 地址栏清理失败不阻断登入 */ }
})();

store.loadAgents();
store.loadMe();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
