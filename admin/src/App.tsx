import { useEffect, useState, type MouseEvent, type ReactNode, type CSSProperties } from 'react';
import Icon from './Icon';
import {
  api,
  adminAuth,
  type Overview,
  type Saying,
  type AdminAgent,
  type AgentBilling,
  type SurveyQ,
  type Plan,
  type AiConfig,
  type AiPreset,
  type AiProvider,
  type AdminUserItem,
  type AdminUserDetail,
  type AdminUsageView,
  type AdminTokenUsageView,
  type AdminAuditItem,
} from './api';
import AgentDetailPanel from './AgentDetailPanel';
import AdminLogin from './AdminLogin';
import { getAdminToken, clearAdminToken } from './auth';

type Tab = 'home' | 'users' | 'usage' | 'tokens' | 'agent' | 'audit' | 'model' | 'say' | 'form' | 'plan';
const TABS: { key: Tab; icon: string; label: string }[] = [
  { key: 'home', icon: 'chart', label: '概览' },
  { key: 'users', icon: 'user', label: '用户' },
  { key: 'usage', icon: 'crown', label: '消耗' },
  { key: 'tokens', icon: 'trend', label: 'Token' },
  { key: 'agent', icon: 'agent', label: '顾问' },
  { key: 'audit', icon: 'clock', label: '审计' },
  { key: 'model', icon: 'insight', label: '模型' },
  { key: 'say', icon: 'spark', label: '献策' },
  { key: 'form', icon: 'doc', label: '问卷' },
  { key: 'plan', icon: 'layers', label: '套餐' },
];

export default function App() {
  const [authed, setAuthed] = useState(() => !!getAdminToken());
  const [tab, setTab] = useState<Tab>('home');
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [detailUser, setDetailUser] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 1800); };

  // 任一请求 401/403（密钥失效/被撤销）→ 切回登录页
  useEffect(() => {
    const onUnauth = () => setAuthed(false);
    window.addEventListener('admin:unauth', onUnauth);
    return () => window.removeEventListener('admin:unauth', onUnauth);
  }, []);

  const logout = () => { adminAuth.logout(); clearAdminToken(); setAuthed(false); };

  if (!authed) return <AdminLogin onAuthed={() => setAuthed(true)} />;

  return (
    <div className="phone">
      <div className="screen">
        <div className="adm-top">
          <div className="adm-mk">军</div>
          <div className="adm-tt"><div className="t">运营后台</div><div className="s">JUNSHI · CONSOLE</div></div>
          <div className="adm-av" onClick={() => setMenuOpen((v) => !v)} title="账户" style={{ cursor: 'pointer', position: 'relative' }}>
            运营
            {menuOpen && (
              <div
                style={{ position: 'absolute', top: '110%', right: 0, background: '#fff', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.16)', padding: 6, minWidth: 132, zIndex: 30 }}
                onClick={(e) => e.stopPropagation()}
              >
                <div style={menuItem} onClick={() => { setMenuOpen(false); setPwOpen(true); }}><Icon name="crown" size={14} /> 修改密码</div>
                <div style={menuItem} onClick={() => { setMenuOpen(false); logout(); }}><Icon name="arrow" size={14} /> 退出登录</div>
              </div>
            )}
          </div>
        </div>

        <div className="adm-scroll">
          {tab === 'home' && <OverviewView />}
          {tab === 'users' && <UsersView onOpen={setDetailUser} />}
          {tab === 'usage' && <UsageView />}
          {tab === 'tokens' && <TokenUsageView />}
          {tab === 'say' && <SayingsView toast={showToast} />}
          {tab === 'agent' && <AgentsView onOpen={setDetailKey} toast={showToast} />}
          {tab === 'audit' && <AuditView />}
          {tab === 'model' && <ModelView toast={showToast} />}
          {tab === 'form' && <SurveyView />}
          {tab === 'plan' && <PlansView toast={showToast} />}
        </div>

        <nav className="adm-tab">
          {TABS.map((t) => (
            <div key={t.key} className={`at ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>
              <Icon name={t.icon} size={20} />
              <span>{t.label}</span>
            </div>
          ))}
        </nav>

        {detailKey && (
          <AgentDetailPanel
            agentKey={detailKey}
            onClose={() => setDetailKey(null)}
            onSaved={() => { setDetailKey(null); showToast('配置已保存并下发'); }}
          />
        )}

        {detailUser && (
          <UserDetailPanel
            userId={detailUser}
            onClose={() => setDetailUser(null)}
            toast={showToast}
          />
        )}

        {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} toast={showToast} />}

        {toast && <div className="admin-toast show"><Icon name="check" size={14} />{toast}</div>}
      </div>
    </div>
  );
}

const menuItem: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', borderRadius: 8, fontSize: 13, color: '#333', cursor: 'pointer' };

// 修改后台登录密码：需当前密码（或主密钥）+ 新密码。成功后吊销旧会话，需重新登录。
function ChangePasswordModal({ onClose, toast }: { onClose: () => void; toast: (m: string) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (next.length < 6) return setErr('新密码至少 6 位');
    if (next !== confirm) return setErr('两次输入的新密码不一致');
    setBusy(true); setErr('');
    const r = await adminAuth.changePassword({ currentPassword: current, newPassword: next });
    setBusy(false);
    if (r.ok) { toast('密码已修改，请用新密码重新登录'); onClose(); window.dispatchEvent(new Event('admin:unauth')); return; }
    setErr((r.data as { error?: string })?.error || '修改失败');
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={onClose}>
      <div className="al-card" style={{ width: 280, margin: 0 }} onClick={(e) => e.stopPropagation()}>
        <div className="al-label">修改登录密码</div>
        <input className="al-input" type="password" value={current} placeholder="当前密码" onChange={(e) => setCurrent(e.target.value)} autoFocus />
        <input className="al-input" type="password" value={next} placeholder="新密码（至少 6 位）" onChange={(e) => setNext(e.target.value)} />
        <input className="al-input" type="password" value={confirm} placeholder="确认新密码" onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        {err && <div className="al-err"><Icon name="alert" size={13} /> {err}</div>}
        <button className="al-btn" onClick={submit} disabled={busy}><Icon name="check" size={15} /> {busy ? '提交中…' : '确认修改'}</button>
        <div className="al-note" style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={onClose}>取消</div>
      </div>
    </div>
  );
}

function OverviewView() {
  const [data, setData] = useState<Overview | null>(null);
  useEffect(() => { api.overview().then(setData).catch(() => {}); }, []);
  if (!data) return <Loading />;
  return (
    <>
      <div className="sec-h"><span className="t">今日概览</span><span className="s">实时</span></div>
      <div className="pad">
        <div className="stats">
          {data.stats.map((s) => (
            <div key={s.l} className="stat">
              <div className="v">{s.v}</div>
              <div className="l">{s.l}</div>
              <div className={`d ${s.trend}`}><Icon name={s.trend === 'up' ? 'up' : 'trend'} size={12} />{s.d}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="sec-h"><span className="t">近期动态</span><span className="s">运营事件</span></div>
      <div className="pad">
        <div className="feed">
          {data.feed.map((f, i) => (
            <div key={i} className="fr">
              <span className="fi"><Icon name={f.icon} size={16} /></span>
              <div className="fb"><div className="ft">{f.t}</div><div className="fm">{f.m}</div></div>
              <span className="fv">{f.v}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function UsersView({ onOpen }: { onOpen: (id: string) => void }) {
  const [list, setList] = useState<AdminUserItem[]>([]);
  useEffect(() => { api.users().then(setList).catch(() => {}); }, []);
  return (
    <>
      <div className="sec-h"><span className="t">注册用户</span><span className="s">点击管理智能体开通</span></div>
      <div className="pad">
        <div className="pill-row">
          <span className="pill"><Icon name="user" size={13} /> {list.length} 用户</span>
          <span className="pill"><Icon name="chat" size={13} /> {sum(list, 'sessionCount')} 会话</span>
          <span className="pill"><Icon name="doc" size={13} /> {sum(list, 'deliverableCount')} 成果</span>
        </div>
        {list.map((u) => (
          <div key={u.id} className="crd user-card" onClick={() => onOpen(u.id)}>
            <div className="crd-row">
              <span className="crd-ic"><Icon name="user" size={18} /></span>
              <div className="crd-b">
                <div className="ct">{u.name} {u.wechatLinked && <span className="tag">微信</span>}</div>
                <div className="cs">{u.phone} · {u.tenantName} · {u.planName ?? '未分配套餐'}</div>
              </div>
              <span className="user-balance">{creditText(u.creditBalance)}</span>
              <span className="edit"><Icon name="pen" size={15} /></span>
            </div>
            <div className="kv-grid">
              <KV k="注册时间" v={fmtTime(u.createdAt)} />
              <KV k="最后会话" v={u.lastSessionAt ? fmtTime(u.lastSessionAt) : '暂无'} />
              <KV k="会话/成果" v={`${u.sessionCount}/${u.deliverableCount}`} />
              <KV k="已消耗" v={`${u.totalSpent} 点`} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// 单用户：智能体开通管理（运营决定给哪个用户开通哪个付费智能体）
function UserDetailPanel({ userId, onClose, toast }: { userId: string; onClose: () => void; toast: (m: string) => void }) {
  const [data, setData] = useState<AdminUserDetail | null>(null);
  const [busy, setBusy] = useState('');
  const load = () => api.userDetail(userId).then(setData).catch(() => {});
  useEffect(() => { load(); }, [userId]);
  if (!data) return null;
  const u = data.user;
  const toggle = async (key: string, owned: boolean, name: string) => {
    setBusy(key);
    try {
      if (owned) { await api.revokeAgent(userId, key); toast(`已取消「${name}」`); }
      else { await api.grantAgent(userId, key); toast(`已为该用户开通「${name}」`); }
      await load();
    } catch { toast('操作失败'); }
    setBusy('');
  };
  return (
    <div className="ad-detail show">
      <div className="ad-dh">
        <div className="bk" onClick={onClose}><Icon name="arrow" size={18} /></div>
        <div className="di"><Icon name="user" size={18} /></div>
        <div className="dt"><div className="t">{u.name}</div><div className="s">{u.phone} · 余额 {creditText(u.creditBalance)}</div></div>
      </div>
      <div className="ad-db">
        <div className="blk">
          <div className="blk-h"><Icon name="crown" size={15} /><span className="t">付费智能体开通</span><span className="badge">{data.agents.filter((a) => a.owned).length}/{data.agents.length}</span></div>
          <div className="blk-d">为该用户单独开通付费（解锁类）智能体，免其消耗权益点。免费 / 按次智能体所有用户均可直接使用，无需开通。</div>
          <div className="mem-list">
            {data.agents.map((a) => (
              <div key={a.key} className="mem-card">
                <span className="mi"><Icon name={a.icon} size={16} /></span>
                <div className="mb">
                  <div className="mt">{a.name} {a.owned && <span className="tag">{sourceLabel(a.source)}</span>}</div>
                  <div className="mm">{a.role} · {a.price} 点解锁</div>
                </div>
                <button className={`mini-btn ${a.owned ? 'danger' : 'primary'}`} disabled={busy === a.key} onClick={() => toggle(a.key, a.owned, a.name)}>
                  {a.owned ? '取消' : '开通'}
                </button>
              </div>
            ))}
            {!data.agents.length && <div className="blk-d">暂无付费（解锁类）智能体</div>}
          </div>
        </div>
        <div style={{ height: 40 }} />
      </div>
    </div>
  );
}

function UsageView() {
  const [data, setData] = useState<AdminUsageView | null>(null);
  useEffect(() => { api.usage().then(setData).catch(() => {}); }, []);
  if (!data) return <Loading />;
  const maxSpent = Math.max(1, ...data.users.map((u) => u.totalSpent));
  return (
    <>
      <div className="sec-h"><span className="t">权益点消耗</span><span className="s">CreditLedger 汇总</span></div>
      <div className="pad">
        <div className="usage-summary">
          <div><b>{data.summary.totalSpent}</b><span>累计消耗（点）</span></div>
          <div><b>{data.summary.currentBalanceTotal}</b><span>当前余额合计</span></div>
          <div><b>{data.summary.activeUsers}</b><span>30 天活跃</span></div>
          <div><b>{data.summary.reportCount}</b><span>成果产出</span></div>
        </div>
        {data.users.map((u) => (
          <div key={u.id} className="usage-row">
            <div className="usage-h">
              <div className="usage-name">{u.name}<span>{u.phone}</span></div>
              <div className="usage-num">{u.totalSpent} 次</div>
            </div>
            <div className="usage-meta">赠送 {u.totalGranted} · 余额 {creditText(u.creditBalance)} · 成果 {u.deliverableCount}</div>
            <div className="meter"><i style={{ width: `${Math.max(3, Math.round((u.totalSpent / maxSpent) * 100))}%` }} /></div>
          </div>
        ))}
      </div>
    </>
  );
}

function TokenUsageView() {
  const [data, setData] = useState<AdminTokenUsageView | null>(null);
  useEffect(() => { api.tokenUsage(30).then(setData).catch(() => {}); }, []);
  if (!data) return <Loading />;
  const { totals, byModel, topUsers } = data;
  const maxModelCost = Math.max(1, ...byModel.map((m) => m.costMicros));
  const uncalibrated = byModel.some((m) => !m.calibrated);
  return (
    <>
      <div className="sec-h"><span className="t">Token 用量</span><span className="s">近 {data.windowDays} 天 · 估算成本（元）</span></div>
      <div className="pad">
        <div className="usage-summary">
          <div><b>{fmtTokens(totals.totalTokens)}</b><span>总 Token</span></div>
          <div><b>{fmtCny(totals.costMicros)}</b><span>估算成本</span></div>
          <div><b>{totals.calls}</b><span>调用次数</span></div>
          <div><b>{fmtTokens(totals.outputTokens)}</b><span>输出 Token</span></div>
        </div>
        {totals.calls === 0 && (
          <div className="usage-meta" style={{ padding: '10px 0' }}>
            暂无 token 记录。仅真实 Claude / OpenAI 调用计量；本地模板（mock）与 Dify 不计。
          </div>
        )}
        {byModel.length > 0 && (
          <>
            <div className="sec-h" style={{ marginTop: 6 }}><span className="t">按模型</span>{uncalibrated && <span className="s">部分单价待校准</span>}</div>
            {byModel.map((m) => (
              <div key={m.model} className="usage-row">
                <div className="usage-h">
                  <div className="usage-name">{m.model}{!m.calibrated && <span>待校准</span>}</div>
                  <div className="usage-num">{fmtCny(m.costMicros)}</div>
                </div>
                <div className="usage-meta">{m.calls} 次 · {fmtTokens(m.totalTokens)} token</div>
                <div className="meter"><i style={{ width: `${Math.max(3, Math.round((m.costMicros / maxModelCost) * 100))}%` }} /></div>
              </div>
            ))}
          </>
        )}
        {topUsers.length > 0 && (
          <>
            <div className="sec-h" style={{ marginTop: 6 }}><span className="t">Top 用户</span><span className="s">按成本</span></div>
            {topUsers.map((u) => (
              <div key={u.userId} className="usage-row">
                <div className="usage-h">
                  <div className="usage-name">{u.name ?? '（未命名）'}<span>{u.userId.slice(0, 8)}</span></div>
                  <div className="usage-num">{fmtCny(u.costMicros)}</div>
                </div>
                <div className="usage-meta">{fmtTokens(u.totalTokens)} token</div>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
function fmtCny(micros: number): string {
  const cny = micros / 1e6;
  if (cny === 0) return '¥0';
  return cny < 1 ? `¥${cny.toFixed(4)}` : `¥${cny.toFixed(2)}`;
}

function AuditView() {
  const [list, setList] = useState<AdminAuditItem[]>([]);
  useEffect(() => { api.auditLogs().then(setList).catch(() => {}); }, []);
  return (
    <>
      <div className="sec-h"><span className="t">审计日志</span><span className="s">精确到秒 · 最近 100 条</span></div>
      <div className="pad">
        {list.map((a) => (
          <div key={a.id} className="audit-row">
            <div className="audit-line">
              <span className="audit-ic"><Icon name={auditIcon(a.action)} size={15} /></span>
              <div className="audit-main">
                <div className="audit-title">{auditLabel(a.action)}<span>{a.action}</span></div>
                <div className="audit-user">{a.userName ?? '系统/运营'} · {a.userPhone ?? a.tenantName ?? '无账号上下文'}</div>
              </div>
            </div>
            <div className="audit-time">{fmtTime(a.at)}</div>
            <pre className="audit-payload">{payloadText(a.payload)}</pre>
          </div>
        ))}
      </div>
    </>
  );
}

function SayingsView({ toast }: { toast: (m: string) => void }) {
  const [list, setList] = useState<Saying[]>([]);
  const [adding, setAdding] = useState('');
  const load = () => api.sayings().then(setList).catch(() => {});
  useEffect(() => { load(); }, []);
  const strip = (s: string) => s.replace(/<[^>]+>/g, '');
  return (
    <>
      <div className="sec-h"><span className="t">每日献策库</span><span className="s">每日 08:00 随机推一条</span></div>
      <div className="pad">
        {list.map((s) => (
          <div key={s.id} className={`say-row ${s.pushedDate ? 'say-today' : ''}`}>
            <span className="grip"><Icon name="layers" size={15} /></span>
            <div className="sb"><div className="stx">{strip(s.text)}</div><div className="smeta">{s.enabled ? '已启用 · 排期池' : '已停用'}</div></div>
            <div className={`sw ${s.enabled ? 'on' : ''}`} onClick={() => api.toggleSaying(s.id, !s.enabled).then(load)}><i /></div>
          </div>
        ))}
        <div className="add-row">
          <input className="add-input" placeholder="新增一条献策（可用 <em> 强调）" value={adding} onChange={(e) => setAdding(e.target.value)} />
          <button className="add-btn" onClick={() => { if (adding.trim()) api.addSaying(adding.trim()).then(() => { setAdding(''); load(); toast('已新增献策'); }); }}>
            <Icon name="spark" size={15} /> 新增
          </button>
        </div>
      </div>
    </>
  );
}

function AgentsView({ onOpen, toast }: { onOpen: (k: string) => void; toast: (m: string) => void }) {
  const [list, setList] = useState<AdminAgent[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ key: '', name: '', role: '', billing: 'unlock' as AgentBilling, price: 10 });
  const load = () => api.agents().then(setList).catch(() => {});
  useEffect(() => { load(); }, []);
  const toggle = async (e: MouseEvent, a: AdminAgent) => {
    e.stopPropagation();
    await api.saveAgent(a.key, { enabled: !a.enabled });
    await load();
    toast(a.enabled ? '功能已下架' : '功能已上架');
  };
  const create = async () => {
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(form.key)) return toast('key 需小写字母开头');
    if (!form.name.trim()) return toast('请填写名称');
    try {
      await api.createAgent({ key: form.key, name: form.name, role: form.role, billing: form.billing, price: form.billing === 'free' ? 0 : form.price });
      setAdding(false); setForm({ key: '', name: '', role: '', billing: 'unlock', price: 10 });
      await load(); toast('已新增智能体（默认下架，点击可配置上架）');
    } catch { toast('新增失败（key 可能已存在）'); }
  };
  return (
    <>
      <div className="sec-h"><span className="t">智能体上下架 · 定价</span><span className="s">前台仅展示已上架</span></div>
      <div className="pad">
        {!adding ? (
          <button className="add-btn full" onClick={() => setAdding(true)}><Icon name="spark" size={15} /> 新增智能体</button>
        ) : (
          <div className="crd new-agent">
            <div className="ai-field"><div className="ai-fl">key（唯一，小写）</div><input className="ai-input" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="如 legal" /></div>
            <div className="ai-field"><div className="ai-fl">名称</div><input className="ai-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如 法务顾问" /></div>
            <div className="ai-field"><div className="ai-fl">一句话定位</div><input className="ai-input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="合同 · 风险 · 合规" /></div>
            <div className="ai-field">
              <div className="ai-fl">计费</div>
              <select className="ai-input" value={form.billing} onChange={(e) => setForm({ ...form, billing: e.target.value as AgentBilling })}>
                <option value="free">免费赠送</option>
                <option value="unlock">付费解锁</option>
                <option value="metered">按次计费</option>
              </select>
            </div>
            {form.billing !== 'free' && (
              <div className="ai-field"><div className="ai-fl">价格（权益点）</div><input className="ai-input" type="number" min={0} value={form.price} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} /></div>
            )}
            <div className="ai-actions">
              <button className="ai-btn ghost" onClick={() => setAdding(false)}>取消</button>
              <button className="ai-btn primary" onClick={create}><Icon name="check" size={14} /> 创建</button>
            </div>
          </div>
        )}
        {list.map((a) => (
          <div key={a.key} className="crd" onClick={() => onOpen(a.key)}>
            <div className="crd-row">
              <span className="crd-ic"><Icon name={a.icon} size={18} /></span>
              <div className="crd-b">
                <div className="ct">{a.name} {billingTag(a.billing, a.price)} {!a.enabled && <span className="tag off">停用</span>}</div>
                <div className="cs">{a.deliverableKey ? `产出 · ${a.deliverableKey}` : a.role} · {typeLabel(a.type)} · 已开通 {a.ownerCount ?? 0} · 成果 {a.deliverableCount ?? 0}</div>
              </div>
              <button className={`mini-btn ${a.enabled ? 'danger' : 'primary'}`} onClick={(e) => toggle(e, a)}>
                {a.enabled ? '下架' : '上架'}
              </button>
              <span className="edit"><Icon name="pen" size={15} /></span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function SurveyView() {
  const [list, setList] = useState<SurveyQ[]>([]);
  useEffect(() => { api.survey().then(setList).catch(() => {}); }, []);
  return (
    <>
      <div className="sec-h"><span className="t">首登建档问卷</span><span className="s">用于个性化产出</span></div>
      <div className="pad">
        {list.map((q, i) => (
          <div key={q.id} className="q-card">
            <div className="q-h"><span className="no">{i + 1}</span><span className="qt">{q.title}</span><span className="key">{q.key}</span></div>
            <div className="opts">
              {q.optionsJson.map((o) => <span key={o} className="opt">{o}</span>)}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function PlansView({ toast }: { toast: (m: string) => void }) {
  const [list, setList] = useState<Plan[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', priceYuan: 0, creditsPerMonth: 0, agentCount: 0, features: '' });
  const load = () => api.plans().then(setList).catch(() => {});
  useEffect(() => { load(); }, []);
  const priceLabel = (p: Plan) => p.price < 0 ? '面议' : p.price === 0 ? '¥0' : `¥${(p.price / 100).toLocaleString()}${p.period === 'year' ? '/年' : '/月'}`;
  const startEdit = (p: Plan) => {
    setEditId(p.id);
    setForm({ name: p.name, priceYuan: p.price < 0 ? -1 : p.price / 100, creditsPerMonth: p.creditsPerMonth, agentCount: p.agentCount, features: p.featuresJson.join('\n') });
  };
  const save = async (id: string) => {
    try {
      await api.savePlan(id, {
        name: form.name,
        price: form.priceYuan < 0 ? -1 : Math.round(form.priceYuan * 100),
        creditsPerMonth: form.creditsPerMonth,
        agentCount: form.agentCount,
        featuresJson: form.features.split('\n').map((s) => s.trim()).filter(Boolean),
      });
      setEditId(null); await load(); toast('套餐已更新');
    } catch { toast('保存失败'); }
  };
  return (
    <>
      <div className="sec-h"><span className="t">套餐与权益点</span><span className="s">定价 · 权益点规则</span></div>
      <div className="pad">
        {list.map((p) => editId === p.id ? (
          <div key={p.id} className="crd new-agent">
            <div className="ai-field"><div className="ai-fl">名称</div><input className="ai-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="ai-field"><div className="ai-fl">价格（元，-1=面议）</div><input className="ai-input" type="number" value={form.priceYuan} onChange={(e) => setForm({ ...form, priceYuan: Number(e.target.value) })} /></div>
            <div className="ai-field"><div className="ai-fl">每月权益点（-1=不限量）</div><input className="ai-input" type="number" value={form.creditsPerMonth} onChange={(e) => setForm({ ...form, creditsPerMonth: Number(e.target.value) })} /></div>
            <div className="ai-field"><div className="ai-fl">含智能体数</div><input className="ai-input" type="number" value={form.agentCount} onChange={(e) => setForm({ ...form, agentCount: Number(e.target.value) })} /></div>
            <div className="ai-field"><div className="ai-fl">权益（每行一条）</div><textarea className="ta" rows={4} value={form.features} onChange={(e) => setForm({ ...form, features: e.target.value })} /></div>
            <div className="ai-actions">
              <button className="ai-btn ghost" onClick={() => setEditId(null)}>取消</button>
              <button className="ai-btn primary" onClick={() => save(p.id)}><Icon name="check" size={14} /> 保存</button>
            </div>
          </div>
        ) : (
          <div key={p.id} className={`plan ${p.highlighted ? 'feat' : ''}`}>
            <div className="plan-h">
              <span className="pn">{p.name}</span>
              {p.highlighted && <span className="tag">最受欢迎</span>}
              <span className="pp">{priceLabel(p)}</span>
            </div>
            <div className="plan-meta">{p.creditsPerMonth < 0 ? '不限量权益点' : `${p.creditsPerMonth} 点/月`} · 含 {p.agentCount} 智能体 · {p.featuresJson.join(' · ')}</div>
            <button className="plan-edit" onClick={() => startEdit(p)}><Icon name="pen" size={13} /> 编辑套餐</button>
          </div>
        ))}
      </div>
    </>
  );
}

// —— 大模型配置：默认 Agnes 2.0 Flash，可一键切到 DeepSeek/Qwen 等（OpenAI 兼容）或 Claude ——
function ModelView({ toast }: { toast: (m: string) => void }) {
  const [cfg, setCfg] = useState<AiConfig | null>(null);
  const [presets, setPresets] = useState<AiPreset[]>([]);
  const [form, setForm] = useState({ provider: 'openai' as AiProvider, label: '', baseUrl: '', model: '', apiKey: '', embeddingModel: '', temperature: 0.7 });
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.aiConfig().then((v) => {
    setCfg(v.config); setPresets(v.presets);
    setForm({ provider: v.config.provider, label: v.config.label, baseUrl: v.config.baseUrl, model: v.config.model, apiKey: '', embeddingModel: v.config.embeddingModel, temperature: v.config.temperature });
  }).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!cfg) return <Loading />;

  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));
  const applyPreset = (p: AiPreset) => { set({ provider: p.provider, label: p.label, baseUrl: p.baseUrl, model: p.model, embeddingModel: p.embeddingModel ?? form.embeddingModel }); setTest(null); };
  // 保存：apiKey 留空表示不改动已存 key
  const payload = () => ({ provider: form.provider, label: form.label, baseUrl: form.baseUrl, model: form.model, embeddingModel: form.embeddingModel, temperature: Number(form.temperature), ...(form.apiKey ? { apiKey: form.apiKey } : {}) });

  const doTest = async () => {
    setBusy(true); setTest(null);
    try {
      const r = await api.testAiConfig(payload());
      setTest({ ok: r.ok, msg: r.ok ? `连通 · ${r.latencyMs}ms · ${r.model}${r.sample ? ' · 「' + r.sample + '」' : ''}` : (r.error || '未连通') });
    } catch { setTest({ ok: false, msg: '测试请求失败' }); }
    setBusy(false);
  };
  const doSave = async () => {
    setBusy(true);
    try { const v = await api.saveAiConfig(payload()); setCfg(v.config); setForm((f) => ({ ...f, apiKey: '' })); toast('模型配置已保存并即时生效'); }
    catch { toast('保存失败'); }
    setBusy(false);
  };

  return (
    <>
      <div className="sec-h"><span className="t">大模型配置</span><span className="s">可随时切换 · 即时生效</span></div>
      <div className="pad">
        {/* 当前生效状态 */}
        <div className={`ai-status ${cfg.ready ? 'on' : 'off'}`}>
          <span className="dot" />
          <div className="b">
            <div className="t">{cfg.label} · {cfg.model}</div>
            <div className="s">
              {cfg.ready
                ? `已就绪 · provider=${cfg.provider}`
                : `未配置 Key，当前实际走「本地模板 mock」兜底（provider=${cfg.provider}）`}
            </div>
          </div>
        </div>

        {/* 预设一键切换 */}
        <div className="ai-label">快速切换</div>
        <div className="ai-presets">
          {presets.map((p) => (
            <button key={p.id} className={`ai-preset ${form.provider === p.provider && form.model === p.model ? 'on' : ''}`} onClick={() => applyPreset(p)} title={p.note}>{p.label}</button>
          ))}
        </div>

        {/* 表单 */}
        <Field label="协议 provider">
          <select className="ai-input" value={form.provider} onChange={(e) => set({ provider: e.target.value as AiProvider })}>
            <option value="openai">openai（兼容 Agnes/DeepSeek/Qwen…）</option>
            <option value="claude">claude（Anthropic）</option>
            <option value="mock">mock（本地模板）</option>
          </select>
        </Field>
        <Field label="展示名"><input className="ai-input" value={form.label} onChange={(e) => set({ label: e.target.value })} placeholder="Agnes 2.0 Flash" /></Field>
        {form.provider === 'openai' && (
          <Field label="网关地址 baseUrl（带 /v1）"><input className="ai-input" value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://apihub.agnes-ai.com/v1" /></Field>
        )}
        <Field label="模型 model"><input className="ai-input" value={form.model} onChange={(e) => set({ model: e.target.value })} placeholder="agnes-2.0-flash" /></Field>
        <Field label={`API Key${cfg.hasKey ? '（已配置，留空=不改）' : ''}`}>
          <input className="ai-input" type="password" value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder={cfg.hasKey ? '••••••（留空保留现有）' : '粘贴 API Key'} />
        </Field>
        <Field label="嵌入模型 embeddingModel（留空=本地确定性嵌入）"><input className="ai-input" value={form.embeddingModel} onChange={(e) => set({ embeddingModel: e.target.value })} placeholder="text-embedding-3-small / 留空" /></Field>
        <Field label={`温度 temperature · ${form.temperature}`}>
          <input className="ai-range" type="range" min={0} max={1} step={0.1} value={form.temperature} onChange={(e) => set({ temperature: Number(e.target.value) })} />
        </Field>

        {test && <div className={`ai-test ${test.ok ? 'ok' : 'err'}`}><Icon name={test.ok ? 'check' : 'alert'} size={13} /> {test.msg}</div>}

        <div className="ai-actions">
          <button className="ai-btn ghost" onClick={doTest} disabled={busy}><Icon name="spark" size={14} /> 测试连接</button>
          <button className="ai-btn primary" onClick={doSave} disabled={busy}><Icon name="check" size={14} /> 保存并生效</button>
        </div>
        <div className="ai-note">提示：未配置真实 Key 时系统自动降级本地模板（mock），保证可用；填入 Key 后所有顾问产出 / 记忆提炼 / 对话汇总即走该模型。</div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="ai-field"><div className="ai-fl">{label}</div>{children}</div>;
}

function KV({ k, v }: { k: string; v: string }) {
  return <div className="kv"><span>{k}</span><b>{v}</b></div>;
}

function sum(list: AdminUserItem[], key: 'sessionCount' | 'deliverableCount') {
  return list.reduce((n, item) => n + item[key], 0);
}

function fmtTime(s: string) {
  return s.replace('T', ' ').replace('Z', '');
}

function creditText(v: number) {
  return v < 0 ? '不限量' : `${v} 点`;
}

function payloadText(payload: unknown) {
  if (!payload) return '{}';
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function auditIcon(action: string) {
  if (action.includes('agent')) return 'agent';
  if (action.includes('auth')) return 'user';
  if (action.includes('generate') || action.includes('credit') || action.includes('plan')) return 'crown';
  if (action.includes('http')) return 'clock';
  if (action.includes('ai')) return 'insight';
  return 'alert';
}

function auditLabel(action: string) {
  const labels: Record<string, string> = {
    'auth.register': '手机号注册',
    'auth.login': '手机号登录',
    'auth.wechat_register': '微信注册',
    'auth.wechat_login': '微信登录',
    'admin.agent.publish': '功能上架',
    'admin.agent.unpublish': '功能下架',
    'admin.agent.update': '智能体配置变更',
    'admin.agent.create': '新增智能体',
    'admin.user.agent.grant': '后台开通智能体',
    'admin.user.agent.revoke': '取消智能体开通',
    'user.agent.purchase': '用户解锁智能体',
    'admin.ai.update': '模型配置变更',
    'admin.saying.create': '新增每日献策',
    'admin.saying.update': '更新每日献策',
    'admin.saying.delete': '删除每日献策',
    'admin.survey.update': '问卷配置变更',
    'admin.plan.update': '套餐配置变更',
    'user.plan.purchase': '用户购买套餐',
    'user.http': '用户 API 行为',
    'user.generate': '用户发起产出',
    'user.profile.create': '用户完成建档',
    'user.profile.update': '用户更新建档',
    'user.color.update': '用户更换本命色',
    'user.library.create': '用户存入方案库',
    'user.library.delete': '用户删除方案',
    'user.session.summarize': '用户生成纪要',
  };
  return labels[action] ?? action;
}

function typeLabel(t: string) { return t === 'advisory' ? '出谋' : t === 'creative' ? '出活' : t === 'custom' ? '自定义' : '通用'; }
function billingTag(billing: AgentBilling, price: number) {
  if (billing === 'free') return <span className="tag">赠送</span>;
  if (billing === 'metered') return <span className="tag pay">按次 {price}</span>;
  return <span className="tag pay">{price} 点</span>;
}
function sourceLabel(source: string | null) {
  return source === 'purchase' ? '已购买' : source === 'admin_grant' ? '后台开通' : source === 'gift' ? '赠送' : '已开通';
}
function Loading() { return <div className="pad" style={{ padding: 40, textAlign: 'center', color: '#969BA1' }}>加载中…</div>; }
