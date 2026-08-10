import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../hooks/useStore';
import NavRail from './NavRail';
import ListPane from './ListPane';
import Login from './Login';
import { ContextMenu, Stage, Toast, TopBar } from './Chrome';
import { REGIONS } from './regions';
import { usePcState } from './state';
import { bindToast } from './toastBridge';
import { bindLoginGate } from './authBridge';
import type { AuthReason } from '../services/authGate';

// PC 工作台外壳：导航轨 + 列表栏 + 主工作区（含右侧抽屉），叠加右键菜单与 Toast。
// 换区不跳页，只改 usePcState 的状态；地址栏由 state.ts 同步。

export default function App() {
  const st = usePcState();
  const s = useStore();
  const color = s.color();
  const region = REGIONS[st.tab];

  // 业务层（services/store 的错误提示等）经 platform.toast 投递到这里的 Toast。
  useEffect(() => { bindToast(st.say); }, [st.say]);

  // 动作级登录门：各区调 requireAuth('chat') 等，最终落到这里开弹层。
  // 游客可以自由浏览，只有要动数据时才拦。
  const [loginReason, setLoginReason] = useState<AuthReason | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const openLogin = useCallback((reason?: AuthReason) => {
    setLoginReason(reason ?? null);
    setLoginOpen(true);
  }, []);
  useEffect(() => { bindLoginGate(openLogin); }, [openLogin]);

  // Esc：先关右键菜单，再关抽屉（就近关闭，符合桌面直觉）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (st.ctx) { st.closeCtx(); return; }
      if (st.drawer) st.closeDrawer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [st]);

  const groups = region.useGroups?.(st);
  const bar = region.useBar(st);
  const ListBody = region.ListBody;
  const Main = region.Main;

  return (
    <div
      className="pc-shell"
      style={{ ...color.vars, '--pc-list-w': `${st.listW}px` } as React.CSSProperties}
    >
      <NavRail st={st} />

      <ListPane
        st={st}
        glyph={region.head.glyph}
        kicker={region.head.kicker}
        title={region.head.title}
        groups={groups}
      >
        {ListBody && <ListBody st={st} />}
      </ListPane>

      <main className="pc-main">
        <TopBar title={bar.title} sub={bar.sub} actions={bar.actions} />
        <Stage st={st}>
          <Main st={st} />
        </Stage>
      </main>

      {st.ctx && <ContextMenu data={st.ctx} onClose={st.closeCtx} />}
      {loginOpen && <Login reason={loginReason ?? undefined} onClose={() => setLoginOpen(false)} />}
      {st.toast && <Toast text={st.toast} />}
    </div>
  );
}
