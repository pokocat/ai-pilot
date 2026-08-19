// 运营后台外壳：鉴权 → 分组导航 → 分区渲染 → 详情面板 / 命令面板 / toast。
//
// 改版要点（旧版问题见 nav.ts 与 router.ts 顶部注释）：
//   ① 22 个目的地不再平铺在横滚底栏里，而是按「看 vs 改」收敛成 7 个运营场景组 + 组内 segmented 分区；
//   ② 当前位置写进 hash，刷新 / 返回 / 分享链接都不丢现场；
//   ③ ⌘K 命令面板可直达任意一屏，也能按姓名/手机号直接跳到某个用户；
//   ④ 桌面端左栏常驻、内容进 max-width 容器，不再把 1440px 屏当成手机用。

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import { api, adminAuth, type AdminMe } from './api';
import AgentDetailPanel from './AgentDetailPanel';
import AdminLogin from './AdminLogin';
import CommandPalette from './CommandPalette';
import { useDialogFocus } from './components';
import { getAdminToken, clearAdminToken } from './auth';
import { NAV_GROUPS, findSection, sectionsOf, visibleGroups, type GroupKey, type SectionKey } from './nav';
import { navigate, onRouteChange, parseHash } from './router';
import logo from './assets/logo.png';

import { OverviewView } from './views/overview';
import { UsersView, UserDetailPanel } from './views/users';
import { PaymentsView, FunnelView, UsageView, TokenUsageView } from './views/revenue';
// 邀请增长三视图单独成文件（手写 SVG 体量大，且 revenue.tsx 正被并行改动）——见该文件头注释。
import { ReferralView } from './views/referral';
import { ObservabilityView, ModerationView, AuditView } from './views/observe';
import { AgentsView, SkillLibraryView, KnowledgeView, RetrievalDebugView } from './views/studio';
import { PlansView, SkusView, EcoToolsView } from './views/catalog';
import { BenchmarksView, FlagsView, SayingsView, SurveyView, AccountsView } from './views/settings';
import { ModelView } from './views/model';
import { CreativeView } from './views/creative';
import { WenceView } from './views/wence';

export default function App() {
  const [authed, setAuthed] = useState(() => !!getAdminToken());
  const [route, setRoute] = useState(parseHash);
  const [toast, setToast] = useState('');
  const [pwOpen, setPwOpen] = useState(false);
  const [palOpen, setPalOpen] = useState(false);
  const [me, setMe] = useState<AdminMe | null>(null);
  const [agentsKey, setAgentsKey] = useState(0); // 改 key 强制 AgentsView 重载（编辑/发布后刷新徽标）
  // 每组记住上次停留的分区：从「经营」切走再切回，回到刚才那屏而不是永远弹回第一个。
  const [lastOf, setLastOf] = useState<Partial<Record<GroupKey, SectionKey>>>({});

  const showToast = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(''), 1800); }, []);

  // 任一请求 401（密钥失效/被撤销）→ 切回登录页。403 不在此列：那是权限不足，
  // 登录态还好着，由页面就地提示（见 api.ts 的 401/403 分流）。
  useEffect(() => {
    const onUnauth = () => setAuthed(false);
    window.addEventListener('admin:unauth', onUnauth);
    return () => window.removeEventListener('admin:unauth', onUnauth);
  }, []);

  useEffect(() => onRouteChange(() => setRoute(parseHash())), []);

  // 当前登录者：按角色显隐「运营账户」等 owner-only 分区。
  useEffect(() => { if (authed) api.me().then(setMe).catch(() => setMe(null)); }, [authed]);
  const isOwner = !!me?.isSuper;

  const groups = useMemo(() => visibleGroups(isOwner), [isOwner]);
  const section = findSection(route.section);
  // 非法 / 无权限的 hash（改错链接、被降权）统一兜回概览，而不是白屏。
  const invalid = !section || (section.ownerOnly && !isOwner);
  useEffect(() => { if (authed && invalid) navigate('home', undefined, { replace: true }); }, [authed, invalid]);

  const activeGroup: GroupKey = section && !invalid ? section.group : 'today';
  const siblings = useMemo(() => sectionsOf(activeGroup, isOwner), [activeGroup, isOwner]);

  // 记录当前组停留位置
  useEffect(() => {
    if (section && !invalid) setLastOf((m) => (m[section.group] === section.key ? m : { ...m, [section.group]: section.key }));
  }, [section, invalid]);

  const goGroup = (g: GroupKey) => {
    const secs = sectionsOf(g, isOwner);
    const remembered = lastOf[g];
    navigate(remembered && secs.some((s) => s.key === remembered) ? remembered : secs[0].key);
  };
  const openUser = useCallback((id: string) => navigate('users', id), []);
  // 订单只带 userName（契约无 userId），所以按姓名带进用户搜索而不是伪造 id。
  const findUser = useCallback((name: string) => navigate('users', undefined, { params: { q: name } }), []);
  const go = useCallback((k: string) => navigate(k), []);

  // ⌘K / Ctrl+K 开关命令面板。输入框里也允许触发（这是全局跳转，不是页面内搜索）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalOpen((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!authed) return <AdminLogin onAuthed={() => setAuthed(true)} />;

  const key = (invalid ? 'home' : section!.key) as SectionKey;
  const detailUser = key === 'users' ? route.id : '';
  const detailAgent = key === 'agent' ? route.id : '';

  const logout = () => { adminAuth.logout(); clearAdminToken(); setAuthed(false); };

  return (
    <div className="screen">
      <div className="shell">
        {/* 桌面端左栏：品牌 + 运营场景组（见 nav.ts）+ 命令面板入口 + 账户 */}
        <aside className="rail">
          <div className="rail-brand">
            <img className="rail-mk" src={logo} alt="军师" />
            <div className="rail-bt"><div className="t">运营后台</div><div className="s">JUNSHI · CONSOLE</div></div>
          </div>
          <nav className="rail-groups" aria-label="功能分组">
            {groups.map((g) => {
              const n = sectionsOf(g.key, isOwner).length;
              return (
                <button
                  key={g.key}
                  type="button"
                  className={`rail-g ${activeGroup === g.key ? 'on' : ''}`}
                  onClick={() => goGroup(g.key)}
                  aria-current={activeGroup === g.key ? 'page' : undefined}
                >
                  <Icon name={g.icon} size={17} />
                  {g.label}
                  {n > 1 && <span className="n">{n}</span>}
                </button>
              );
            })}
          </nav>
          <div className="rail-foot">
            <button type="button" className="rail-key" onClick={() => setPalOpen(true)}>
              <Icon name="search" size={15} /> 跳转 / 找人
              <span className="kbd">⌘K</span>
            </button>
            <AccountMenu username={me?.username} onChangePassword={() => setPwOpen(true)} onLogout={logout} />
          </div>
        </aside>

        <div className="main">
          {/* 移动端顶栏（桌面端由左栏承担） */}
          <div className="adm-top">
            <img className="adm-mk" src={logo} alt="军师" />
            <div className="adm-tt"><div className="t">运营后台</div><div className="s">JUNSHI · CONSOLE</div></div>
            <button type="button" className="top-key" onClick={() => setPalOpen(true)} aria-label="跳转或找人"><Icon name="search" size={16} /></button>
            <AccountMenu username={me?.username} onChangePassword={() => setPwOpen(true)} onLogout={logout} />
          </div>

          {/* 组内分区（只有一屏的组不渲染，避免摆一个假 tab） */}
          {siblings.length > 1 && (
            <nav className="subnav" aria-label={`${NAV_GROUPS.find((g) => g.key === activeGroup)?.label}分区`}>
              {siblings.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className={`subnav-i ${key === s.key ? 'on' : ''}`}
                  onClick={() => navigate(s.key)}
                  aria-current={key === s.key ? 'page' : undefined}
                >
                  <Icon name={s.icon} size={14} />{s.label}
                </button>
              ))}
            </nav>
          )}

          <div className="content">
            <div className="wrap">
              {key === 'home' && <OverviewView onGo={go} />}
              {key === 'users' && <UsersView onOpen={openUser} initialQ={route.params.q ?? ''} />}
              {key === 'usage' && <UsageView />}
              {key === 'payments' && <PaymentsView toast={showToast} isSuper={isOwner} onFindUser={findUser} />}
              {key === 'funnel' && <FunnelView />}
              {key === 'referral' && <ReferralView />}
              {key === 'tokens' && <TokenUsageView onOpenUser={openUser} />}
              {key === 'trace' && <ObservabilityView />}
              {key === 'say' && <SayingsView toast={showToast} />}
              {key === 'agent' && <AgentsView key={agentsKey} onOpen={(k) => navigate('agent', k)} toast={showToast} />}
              {key === 'skilllib' && <SkillLibraryView toast={showToast} />}
              {key === 'knowledge' && <KnowledgeView toast={showToast} />}
              {key === 'retrieval' && <RetrievalDebugView />}
              {key === 'account' && isOwner && <AccountsView toast={showToast} />}
              {key === 'audit' && <AuditView />}
              {key === 'moderation' && <ModerationView onOpenUser={openUser} />}
              {key === 'model' && <ModelView toast={showToast} />}
              {key === 'flags' && <FlagsView toast={showToast} isSuper={isOwner} />}
              {key === 'creative' && <CreativeView toast={showToast} isSuper={isOwner} />}
              {key === 'wence' && <WenceView toast={showToast} />}
              {key === 'form' && <SurveyView />}
              {key === 'plan' && <PlansView toast={showToast} />}
              {key === 'sku' && <SkusView toast={showToast} />}
              {key === 'eco' && <EcoToolsView toast={showToast} />}
              {key === 'benchmark' && <BenchmarksView toast={showToast} />}
            </div>
          </div>

          {/* 详情面板锚在 .main 内：桌面端左栏保持可见，钻进详情不会失去导航出口。
              关闭 = 回到不带 id 的同一分区，浏览器返回键同样有效。 */}
          {detailAgent && (
            <AgentDetailPanel
              agentKey={detailAgent}
              onClose={() => { navigate('agent'); setAgentsKey((k) => k + 1); }}
              toast={showToast}
            />
          )}
          {detailUser && (
            <UserDetailPanel
              userId={detailUser}
              isOwner={isOwner}
              onClose={() => navigate('users')}
              toast={showToast}
            />
          )}
        </div>
      </div>

      {/* 移动端底栏：只放组（7 个，flex 均分）→ 永远放得下，不再横滚 */}
      <nav className="botnav" aria-label="功能分组">
        {groups.map((g) => (
          <button
            key={g.key}
            type="button"
            className={`botnav-i ${activeGroup === g.key ? 'on' : ''}`}
            onClick={() => goGroup(g.key)}
            aria-current={activeGroup === g.key ? 'page' : undefined}
          >
            <Icon name={g.icon} size={19} />
            <span>{g.label}</span>
          </button>
        ))}
      </nav>

      {palOpen && (
        <CommandPalette
          isOwner={isOwner}
          onClose={() => setPalOpen(false)}
          onGo={go}
          onOpenUser={openUser}
        />
      )}
      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} toast={showToast} />}
      {toast && <div className="admin-toast show" role="status" aria-live="polite"><Icon name="check" size={14} />{toast}</div>}
    </div>
  );
}

/** 账户菜单必须是「触发按钮 + 同级 menu」，不能把可点击 div 塞进 button。 */
function AccountMenu({ username, onChangePassword, onLogout }: {
  username?: string | null;
  onChangePassword: () => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openFromKeyboard = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown') return;
    e.preventDefault();
    setOpen(true);
    window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
  };
  const act = (fn: () => void) => { setOpen(false); fn(); };

  return (
    <div className="acct" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="adm-av"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={openFromKeyboard}
        title={username ?? '账户'}
        aria-label={`账户${username ? `：${username}` : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >运营</button>
      {open && (
        <div className="acct-menu" id={menuId} role="menu" aria-label="账户操作">
          <button type="button" className="acct-menu-item" role="menuitem" onClick={() => act(onChangePassword)}><Icon name="crown" size={14} /> 修改密码</button>
          <button type="button" className="acct-menu-item" role="menuitem" onClick={() => act(onLogout)}><Icon name="arrow" size={14} /> 退出登录</button>
        </div>
      )}
    </div>
  );
}

// 修改后台登录密码：需当前密码（或主密钥）+ 新密码。成功后吊销旧会话，需重新登录。
function ChangePasswordModal({ onClose, toast }: { onClose: () => void; toast: (m: string) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const titleId = useId();
  const requestClose = () => { if (!busy) onClose(); };
  const dialogRef = useDialogFocus<HTMLFormElement>(requestClose);

  const submit = async () => {
    if (next.length < 6) return setErr('新密码至少 6 位');
    if (next !== confirm) return setErr('两次输入的新密码不一致');
    setBusy(true); setErr('');
    try {
      const r = await adminAuth.changePassword({ currentPassword: current, newPassword: next });
      if (r.ok) { toast('密码已修改，请用新密码重新登录'); onClose(); window.dispatchEvent(new Event('admin:unauth')); return; }
      setErr((r.data as { error?: string })?.error || '修改失败');
    } catch (e) {
      setErr((e as Error)?.message || '修改失败，请检查网络后重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={(e) => { if (e.target === e.currentTarget) requestClose(); }}>
      <form ref={dialogRef} className="al-card modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="al-label" id={titleId}>修改登录密码</div>
        <input className="al-input" type="password" value={current} placeholder="当前密码" onChange={(e) => setCurrent(e.target.value)} autoFocus />
        <input className="al-input" type="password" value={next} placeholder="新密码（至少 6 位）" onChange={(e) => setNext(e.target.value)} />
        <input className="al-input" type="password" value={confirm} placeholder="确认新密码" onChange={(e) => setConfirm(e.target.value)} />
        {err && <div className="al-err" role="alert"><Icon name="alert" size={13} /> {err}</div>}
        <button type="submit" className="al-btn" disabled={busy}><Icon name="check" size={15} /> {busy ? '提交中…' : '确认修改'}</button>
        <button type="button" className="al-cancel" onClick={requestClose} disabled={busy}>取消</button>
      </form>
    </div>
  );
}
