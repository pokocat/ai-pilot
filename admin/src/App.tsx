// 运营后台外壳：鉴权 → 分组导航 → 分区渲染 → 详情面板 / 命令面板 / toast。
//
// 改版要点（旧版问题见 nav.ts 与 router.ts 顶部注释）：
//   ① 目的地不再平铺在横滚底栏里，而是按「看 vs 改」收敛成 8 个运营场景组 + 组内 segmented 分区；
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
import { useResource } from './useResource';
import { getAdminToken, clearAdminToken } from './auth';
import {
  NAV_GROUPS, findSection, inScope, productLabel, scopeOptions, sectionsOf, visibleGroups,
  type GroupKey, type ProductScope, type SectionKey,
} from './nav';
import { navigate, onRouteChange, parseHash } from './router';
import logo from './assets/logo.png';

import { OverviewView } from './views/overview';
import { UsersView, UserDetailPanel } from './views/users';
import { PaymentsView, FunnelView, UsageView, TokenUsageView } from './views/revenue';
// 邀请增长三视图单独成文件（手写 SVG 体量大，且 revenue.tsx 正被并行改动）——见该文件头注释。
import { ReferralView } from './views/referral';
/* 「增长」组的三个新页在 `src/growth/`（shadcn 模块）而不是 `src/views/`：那个目录是
   Tailwind 作用域与 lint:ui 规则 1 的豁免边界，见 admin/DESIGN.md「shadcn 模块（增长组）」。 */
import { InvitesView } from './growth/InvitesView';
import { ChainView } from './growth/ChainView';
import { DistributionView } from './growth/DistributionView';
import { ObservabilityView, ModerationView, AuditView } from './views/observe';
import { SessionsView, SessionDetailPanel } from './views/sessions';
import { AgentsView, SkillLibraryView, KnowledgeView, RetrievalDebugView } from './views/studio';
import { PlansView, SkusView, EcoToolsView } from './views/catalog';
import { BenchmarksView, ClonePricingView, FlagsView, SayingsView, SurveyView, AccountsView } from './views/settings';
import { ClipOpsView, ClipTemplatesView, ClipVendorView } from './views/clipops';
import { ModelView } from './views/model';
import { CreativeView } from './views/creative';
import { ProductsView } from './views/products';
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

  // —— 产品视角 ——
  // 后台是一个、按产品分区（见 views/products.tsx 顶部）。这里切的只是**看什么**：
  // 公共面（用户 / 订单 / 钱包流水 / 模型 / 审计 / 账户）在哪个视角下都在，
  // 产品专属面只在自己的视角下出现。权限仍由服务端的 requireProductAccess 决定，
  // 切视角改不了任何一次请求的鉴权结果 —— 这里少切一刀不会漏权，多切一刀也不会提权。
  // 未登录时不发这个请求 —— 登录页也会跑这些 hook，不挡住就是每次打开后台先来一记 401。
  const perms = useResource(
    useCallback(() => (authed ? api.adminProducts() : Promise.resolve(null)), [authed]),
    [authed],
  );
  const options = useMemo(
    () => scopeOptions(perms.data?.accessible ?? [], isOwner),
    [perms.data?.accessible, isOwner],
  );
  const [scope, setScope] = useState<ProductScope>(() => {
    try { return (localStorage.getItem('admin.scope') as ProductScope) || 'all'; } catch { return 'all'; }
  });
  // 存下来的视角可能已经不合法了（运营被收回了某个产品的授权）。等权限读回来再校正，
  // 别在 options 还是空数组时把用户的选择重置掉。
  useEffect(() => {
    if (!perms.data) return;
    if (!options.includes(scope)) setScope(options[0] ?? 'all');
  }, [perms.data, options, scope]);
  useEffect(() => { try { localStorage.setItem('admin.scope', scope); } catch { /* 隐私模式下写不了，无所谓 */ } }, [scope]);

  const groups = useMemo(() => visibleGroups(isOwner, scope), [isOwner, scope]);
  const section = findSection(route.section);
  // 非法 / 无权限的 hash（改错链接、被降权）统一兜回概览，而不是白屏。
  const invalid = !section || (section.ownerOnly && !isOwner);
  useEffect(() => { if (authed && invalid) navigate('home', undefined, { replace: true }); }, [authed, invalid]);

  // 命令面板搜的是**全部**分区（那是它作为逃生口的价值）。搜到一个当前视角看不见的，
  // 点进去要把视角跟着切过去 —— 否则页面开着、导航里却找不到它，看着像 bug。
  useEffect(() => {
    if (!section || invalid || inScope(section, scope)) return;
    const target = section.products?.find((c) => options.includes(c));
    if (target) setScope(target);
  }, [section, invalid, scope, options]);

  // 切不过去的情况：只被授予爱速拍的运营，手上一个军师分区的旧链接（或命令面板搜到的）。
  // 上面那个 effect 找不到可切的视角，于是页面会**照常渲染那一屏军师的内容**。
  //
  // 这里拦一道，但要说清它**不是权限**：军师那些路由（/admin/agents 等）服务端至今没有
  // 产品闸，真要拿数据绕过前端就行。不加那层闸是因为今天所有运营账号的
  // AdminProductAccess 都是空的，一上来就按产品拦会把现有运营全锁在门外，
  // 那是一次需要先发授权、再切换的迁移，不能顺手做。
  const outOfScope = !!section && !invalid && !inScope(section, scope)
    && !section.products?.some((c) => options.includes(c));

  const activeGroup: GroupKey = section && !invalid ? section.group : 'today';
  const siblings = useMemo(() => sectionsOf(activeGroup, isOwner, scope), [activeGroup, isOwner, scope]);

  // 记录当前组停留位置
  useEffect(() => {
    if (section && !invalid) setLastOf((m) => (m[section.group] === section.key ? m : { ...m, [section.group]: section.key }));
  }, [section, invalid]);

  const goGroup = (g: GroupKey) => {
    const secs = sectionsOf(g, isOwner, scope);
    const remembered = lastOf[g];
    navigate(remembered && secs.some((s) => s.key === remembered) ? remembered : secs[0].key);
  };
  const openUser = useCallback((id: string) => navigate('users', id), []);
  // 「增长」组的跨屏直达：邀请关系 / 代理名册 / 用户详情都往邀请链跳；空 id = 回到找人空态。
  const openChain = useCallback((id: string) => navigate('chain', id || undefined), []);
  const openDistributor = useCallback((id: string) => navigate('distribution', id || undefined), []);
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
  const detailSession = key === 'sessions' ? route.id : '';

  const logout = () => { adminAuth.logout(); clearAdminToken(); setAuthed(false); };

  return (
    <div className="screen">
      <div className="shell">
        {/* 桌面端左栏：品牌 + 产品视角 + 运营场景组（见 nav.ts）+ 命令面板入口 + 账户 */}
        <aside className="rail">
          <div className="rail-brand">
            <img className="rail-mk" src={logo} alt="军师" />
            <div className="rail-bt"><div className="t">运营后台</div><div className="s">JUNSHI · CONSOLE</div></div>
          </div>
          <ScopeBar options={options} scope={scope} onChange={setScope} />
          <nav className="rail-groups" aria-label="功能分组">
            {groups.map((g) => {
              const n = sectionsOf(g.key, isOwner, scope).length;
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
          {/* 移动端：左栏整条 display:none，视角选择器跟到顶栏下面自成一行 */}
          <ScopeBar options={options} scope={scope} onChange={setScope} mobile />

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
              {outOfScope ? (
                <div className="pad">
                  <div className="empty">
                    这一屏属于「{(section!.products ?? []).map(productLabel).join(' / ')}」，
                    不在你能切换的产品视角里。
                    <div className="usage-meta">
                      链接可能是别人发的，或者这个产品的授权被收回了。要看它，得先让超管在
                      「经营 · 产品」里授予对应产品。
                    </div>
                  </div>
                </div>
              ) : <>
              {key === 'home' && <OverviewView onGo={go} />}
              {key === 'users' && <UsersView onOpen={openUser} initialQ={route.params.q ?? ''} />}
              {/* 产品视角影响的是**数据**，不只是导航：切到爱速拍就只统计花在爱速拍上的钻石。
                  'all' 不传 product，行为与加视角之前逐字节一致。 */}
              {key === 'usage' && <UsageView product={scope === 'all' ? undefined : scope} />}
              {key === 'payments' && <PaymentsView toast={showToast} isSuper={isOwner} onFindUser={findUser} />}
              {key === 'funnel' && <FunnelView />}
              {key === 'referral' && <ReferralView />}
              {key === 'invites' && <InvitesView isSuper={isOwner} onOpenChain={openChain} toast={showToast} />}
              {/* chain / distribution 的 route.id 语义不同：前者是 userId，后者是 distributorId */}
              {key === 'chain' && <ChainView userId={route.id} onOpenChain={openChain} onOpenUser={openUser} onOpenDistributor={openDistributor} />}
              {key === 'distribution' && <DistributionView isSuper={isOwner} distributorId={route.id} onOpenDistributor={openDistributor} onOpenChain={openChain} toast={showToast} />}
              {key === 'tokens' && <TokenUsageView onOpenUser={openUser} />}
              {key === 'sessions' && <SessionsView onOpen={(id) => navigate('sessions', id)} />}
              {key === 'trace' && <ObservabilityView />}
              {key === 'say' && <SayingsView toast={showToast} />}
              {key === 'agent' && <AgentsView key={agentsKey} onOpen={(k) => navigate('agent', k)} toast={showToast} />}
              {key === 'skilllib' && <SkillLibraryView toast={showToast} />}
              {key === 'knowledge' && <KnowledgeView toast={showToast} />}
              {key === 'retrieval' && <RetrievalDebugView />}
              {key === 'account' && isOwner && <AccountsView toast={showToast} />}
              {key === 'audit' && <AuditView onOpenUser={openUser} onOpenSession={(id) => navigate('sessions', id)} />}
              {key === 'moderation' && <ModerationView onOpenUser={openUser} />}
              {key === 'model' && <ModelView toast={showToast} />}
              {key === 'flags' && <FlagsView toast={showToast} isSuper={isOwner} />}
              {key === 'clone' && <ClonePricingView toast={showToast} isSuper={isOwner} />}
              {key === 'creative' && <CreativeView toast={showToast} isSuper={isOwner} />}
              {key === 'products' && <ProductsView toast={showToast} isSuper={isOwner} />}
              {key === 'clipops' && <ClipOpsView toast={showToast} isSuper={isOwner} />}
              {key === 'templates' && <ClipTemplatesView toast={showToast} isSuper={isOwner} />}
              {key === 'vendor' && <ClipVendorView />}
              {key === 'wence' && <WenceView toast={showToast} />}
              {key === 'form' && <SurveyView />}
              {key === 'plan' && <PlansView toast={showToast} />}
              {key === 'sku' && <SkusView toast={showToast} />}
              {key === 'eco' && <EcoToolsView toast={showToast} />}
              {key === 'benchmark' && <BenchmarksView toast={showToast} />}
              </>}
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
              onOpenChain={openChain}
              toast={showToast}
            />
          )}
          {detailSession && (
            <SessionDetailPanel
              id={detailSession}
              onClose={() => navigate('sessions')}
              onOpenUser={openUser}
            />
          )}
        </div>
      </div>

      {/* 移动端底栏：只放组（8 个，flex 均分）→ 永远放得下，不再横滚。
          375px / 8 ≈ 46px 一格，组名保持 2-3 字（见 nav.ts 与 DESIGN.md） */}
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
/**
 * 产品视角选择器。
 *
 * 只切**看什么**：公共面（用户 / 订单 / 钱包流水 / 模型 / 审计 / 账户）在哪个视角下都在，
 * 产品专属面只在自己的视角下出现。不是权限开关 —— 服务端的 requireProductAccess
 * 该拦的照拦，切到「军师」也不会让一个只被授予爱速拍的运营多看见任何数据。
 *
 * 只有一个选项时整条不渲染：给只被授权一个产品的运营摆一个切不动的控件，
 * 只会让人以为自己少了权限。
 */
function ScopeBar({ options, scope, onChange, mobile = false }: {
  options: ProductScope[];
  scope: ProductScope;
  onChange: (s: ProductScope) => void;
  mobile?: boolean;
}) {
  if (options.length < 2) return null;
  return (
    <div className={mobile ? 'scope m' : 'scope'} role="group" aria-label="产品视角">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          className={`scope-i ${scope === o ? 'on' : ''}`}
          onClick={() => onChange(o)}
          aria-pressed={scope === o}
        >{o === 'all' ? '全部' : productLabel(o)}</button>
      ))}
    </div>
  );
}

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
