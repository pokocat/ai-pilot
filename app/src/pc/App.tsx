import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../hooks/useStore';
import NavRail from './NavRail';
import ListPane from './ListPane';
import Login from './Login';
import { ContextMenu, Stage, Toast, TopBar } from './Chrome';
import { REGIONS } from './regions';
import type { Region } from './regions/types';
import { usePcState, type PcState } from './state';
import { bindToast } from './toastBridge';
import { bindLoginGate } from './authBridge';
import type { AuthReason } from '../services/authGate';

// PC 工作台外壳：导航轨 + 列表栏 + 主工作区（含右侧抽屉），叠加右键菜单与 Toast。
// 换区不跳页，只改 usePcState 的状态；地址栏由 state.ts 同步。

/**
 * 各区的 `useBar` / `useGroups` **是 hook**（问策区的 useChatBar 里有 useStore/useState/useEffect，
 * 其余区暂时是零 hook 的纯函数）。所以绝不能在 App 函数体里直接调 `region.useBar(st)`——
 * 换区时 App 这一个组件实例的 hook 数量会变，React 直接抛
 * 「Rendered more hooks than during the previous render」并卸载整棵树，表现为切区白屏。
 *
 * 拆成下面两个以 `st.tab` 为 key 的子组件：区一换就是新实例，hook 表各算各的，
 * 后来的区想加多少 hook 都不会串位。
 */
function RegionBar({ region, st }: { region: Region; st: PcState }) {
  const bar = region.useBar(st);
  return <TopBar title={bar.title} sub={bar.sub} actions={bar.actions} />;
}

function RegionList({ region, st }: { region: Region; st: PcState }) {
  const groups = region.useGroups?.(st);
  const ListBody = region.ListBody;
  return (
    <ListPane
      st={st}
      glyph={region.head.glyph}
      kicker={region.head.kicker}
      title={region.head.title}
      groups={groups}
    >
      {ListBody && <ListBody st={st} />}
    </ListPane>
  );
}

export default function App() {
  const st = usePcState();
  const s = useStore();
  const color = s.color();
  const authed = s.isAuthed();
  const me = s.me();
  const region = REGIONS[st.tab];

  // 业务层（services/store 的错误提示等）经 platform.toast 投递到这里的 Toast。
  useEffect(() => { bindToast(st.say); }, [st.say]);

  // PC 是个人工作台，不提供游客态：没有 token 时只渲染不可关闭的登录屏；有历史 token 时
  // 先用 /me 验真，验证完成前也不挂载任何区组件，避免失效 token 短暂闪出个人工作区。
  // requireAuth 仍保留为登录态在动作瞬间失效时的第二道防线。
  const [loginReason, setLoginReason] = useState<AuthReason | null>(null);
  const [authChecking, setAuthChecking] = useState(authed && !me);
  const openLogin = useCallback((reason?: AuthReason) => {
    setLoginReason(reason ?? null);
  }, []);
  useEffect(() => { bindLoginGate(openLogin); }, [openLogin]);

  const verifyAuth = useCallback(async () => {
    if (!s.isAuthed() || s.me()) return;
    setAuthChecking(true);
    try {
      await s.loadMe();
      if (s.isAuthed() && s.me()) await s.loadAgents();
    } finally {
      setAuthChecking(false);
    }
  }, [s]);
  useEffect(() => { void verifyAuth(); }, [verifyAuth, authed, me]);

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

  const Main = region.Main;
  const shellStyle = { ...color.vars, '--pc-list-w': `${st.listW}px` } as React.CSSProperties;

  if (!authed) {
    return (
      <div className="pc-shell pc-auth-shell" style={shellStyle}>
        <Login required reason={loginReason ?? undefined} />
      </div>
    );
  }

  if (!me) {
    return (
      <div className="pc-shell pc-auth-shell" style={shellStyle}>
        <div className="pc-login-mask pc-login-required">
          <div className="pc-login pc-login-check" role="status">
            <div className="pc-login-seal">军</div>
            <div className="pc-login-title">{authChecking ? '正在核验登录态' : '暂时无法进入工作台'}</div>
            <div className="pc-login-sub">
              {authChecking ? '正在连接军师服务，确认账户与个人数据。' : '账户尚未通过线上校验，请检查网络后重试。'}
            </div>
            {authChecking ? <div className="pc-login-loader"><i /><i /><i /></div> : (
              <div className="pc-login-check-actions">
                <button type="button" className="pc-login-submit" onClick={() => { void verifyAuth(); }}>重新验证</button>
                <button type="button" className="pc-login-switch" onClick={() => s.logout()}>换账号登录</button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="pc-shell"
      style={shellStyle}
    >
      <NavRail st={st} />

      {/* key={st.tab}：见下方 RegionList / RegionBar 的说明，切区必须整体重挂载 */}
      <RegionList key={st.tab} region={region} st={st} />

      <main className="pc-main">
        <RegionBar key={st.tab} region={region} st={st} />
        <Stage st={st}>
          <Main st={st} />
        </Stage>
      </main>

      {st.ctx && <ContextMenu data={st.ctx} onClose={st.closeCtx} />}
      {st.toast && <Toast text={st.toast} />}
    </div>
  );
}
