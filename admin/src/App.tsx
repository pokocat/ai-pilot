import { useEffect, useState, type ChangeEvent, type MouseEvent, type ReactNode } from 'react';
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
  type AiModel,
  type AiModelUpsert,
  type AdminUserItem,
  type AdminUserDetail,
  type AdminUsageView,
  type AdminTokenUsageView,
  type AdminAuditItem,
  type AdminTraceListView,
  type AdminTraceDetail,
  type SkillToolDef,
  type SkillToolUpsert,
  type SkillToolMeta,
  type AdminKnowledgeView,
  type AdminRetrievalDebug,
  type AdminUserContext,
  type KnowledgeDetail,
  uploadUserKnowledge,
} from './api';
import AgentDetailPanel from './AgentDetailPanel';
import NumInput from './NumInput';
import AdminLogin from './AdminLogin';
import { getAdminToken, clearAdminToken } from './auth';

type Tab = 'home' | 'users' | 'usage' | 'tokens' | 'trace' | 'agent' | 'skilllib' | 'knowledge' | 'retrieval' | 'audit' | 'model' | 'say' | 'form' | 'plan';
const TABS: { key: Tab; icon: string; label: string }[] = [
  { key: 'home', icon: 'chart', label: '概览' },
  { key: 'users', icon: 'user', label: '用户' },
  { key: 'usage', icon: 'crown', label: '消耗' },
  { key: 'tokens', icon: 'trend', label: 'Token' },
  { key: 'trace', icon: 'insight', label: '诊断' },
  { key: 'agent', icon: 'agent', label: '顾问' },
  { key: 'skilllib', icon: 'layers', label: '技能库' },
  { key: 'knowledge', icon: 'doc', label: '知识库' },
  { key: 'retrieval', icon: 'target', label: '检索' },
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
    <div className="screen">
      <div className="adm-top">
          <div className="adm-mk">军</div>
          <div className="adm-tt"><div className="t">运营后台</div><div className="s">JUNSHI · CONSOLE</div></div>
          <div className="adm-av" onClick={() => setMenuOpen((v) => !v)} title="账户" style={{ cursor: 'pointer', position: 'relative' }}>
            运营
            {menuOpen && (
              <div className="acct-menu" onClick={(e) => e.stopPropagation()}>
                <div className="acct-menu-item" onClick={() => { setMenuOpen(false); setPwOpen(true); }}><Icon name="crown" size={14} /> 修改密码</div>
                <div className="acct-menu-item" onClick={() => { setMenuOpen(false); logout(); }}><Icon name="arrow" size={14} /> 退出登录</div>
              </div>
            )}
          </div>
        </div>

        <div className="adm-scroll">
          {tab === 'home' && <OverviewView />}
          {tab === 'users' && <UsersView onOpen={setDetailUser} />}
          {tab === 'usage' && <UsageView />}
          {tab === 'tokens' && <TokenUsageView />}
          {tab === 'trace' && <ObservabilityView />}
          {tab === 'say' && <SayingsView toast={showToast} />}
          {tab === 'agent' && <AgentsView onOpen={setDetailKey} toast={showToast} />}
          {tab === 'skilllib' && <SkillLibraryView toast={showToast} />}
          {tab === 'knowledge' && <KnowledgeView toast={showToast} />}
          {tab === 'retrieval' && <RetrievalDebugView />}
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
  );
}


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
    <div className="modal-scrim" onClick={onClose}>
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

// 用户详情：智能体开通 + 上下文中心（军师档案 / 长期记忆 / 知识库）——观测与纠偏。
const MATURITY_LABEL: Record<string, string> = { empty: '资料不足', forming: '初步成形', ready: '可作底稿' };
const KB_STATUS_LABEL: Record<string, string> = { ready: '就绪', parsing: '解析中', embedding: '嵌入中', failed: '失败', pending: '排队' };
function fmtSize(b: number | null): string {
  if (!b) return '';
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

function UserDetailPanel({ userId, onClose, toast }: { userId: string; onClose: () => void; toast: (m: string) => void }) {
  const [data, setData] = useState<AdminUserDetail | null>(null);
  const [ctx, setCtx] = useState<AdminUserContext | null>(null);
  const [busy, setBusy] = useState('');
  const [openDoc, setOpenDoc] = useState('');
  const [docDetail, setDocDetail] = useState<KnowledgeDetail | null>(null);
  const load = () => api.userDetail(userId).then(setData).catch(() => {});
  const loadCtx = () => api.userContext(userId).then(setCtx).catch(() => {});
  useEffect(() => { load(); loadCtx(); }, [userId]);
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
  const delMem = async (mid: string) => {
    if (!confirm('删除这条长期记忆？将不再影响该用户后续产出。')) return;
    setBusy('m' + mid);
    try { await api.delUserMemory(userId, mid); toast('已删除记忆'); await loadCtx(); } catch { toast('删除失败'); }
    setBusy('');
  };
  const openDetail = async (kid: string, force = false) => {
    if (openDoc === kid && !force) { setOpenDoc(''); setDocDetail(null); return; }
    setOpenDoc(kid); setDocDetail(null);
    try { setDocDetail(await api.userKnowledgeDetail(userId, kid)); } catch { /* 详情失败不阻塞 */ }
  };
  const reembedKb = async (kid: string) => {
    setBusy('k' + kid);
    try { const r = await api.reembedUserKnowledge(userId, kid); toast(`已重嵌 ${r.chunks} 切片`); await loadCtx(); if (openDoc === kid) await openDetail(kid, true); }
    catch { toast('重嵌失败'); }
    setBusy('');
  };
  const delKb = async (kid: string) => {
    if (!confirm('删除该知识项？其切片与原件将一并清除。')) return;
    setBusy('k' + kid);
    try { await api.delUserKnowledge(userId, kid); toast('已删除'); if (openDoc === kid) { setOpenDoc(''); setDocDetail(null); } await loadCtx(); }
    catch { toast('删除失败'); }
    setBusy('');
  };
  const onUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy('upload');
    try { await uploadUserKnowledge(userId, file); toast('已上传，解析中…'); await loadCtx(); setTimeout(loadCtx, 1200); }
    catch (err) { toast((err as Error).message || '上传失败'); }
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

        {ctx && (
          <div className="blk">
            <div className="blk-h"><Icon name="insight" size={15} /><span className="t">军师档案</span><span className="badge">{MATURITY_LABEL[ctx.understanding.maturity] ?? ctx.understanding.maturity}</span></div>
            <div className="blk-d">{ctx.understanding.summary}</div>
            <div className="mem-list">
              {ctx.understanding.sections.map((s) => (
                <div key={s.key} className="mem-card">
                  <span className="mi"><Icon name="doc" size={16} /></span>
                  <div className="mb">
                    <div className="mt">{s.title}</div>
                    <div className="mm">{s.items.length ? s.items.join('；') : s.emptyText}</div>
                  </div>
                </div>
              ))}
            </div>
            {ctx.understanding.nextQuestions.length > 0 && <div className="blk-d">待补：{ctx.understanding.nextQuestions.join(' / ')}</div>}
          </div>
        )}

        {ctx && (
          <div className="blk">
            <div className="blk-h"><Icon name="spark" size={15} /><span className="t">长期记忆</span><span className="badge">{ctx.memories.length}</span></div>
            <div className="blk-d">系统从对话 / 反馈里学到、会持续影响产出的记忆（按顾问隔离）。删除用于纠正脏记忆或隐私清理。</div>
            <div className="mem-list">
              {ctx.memories.map((m) => (
                <div key={m.id} className="mem-card">
                  <span className="mi"><Icon name="insight" size={16} /></span>
                  <div className="mb">
                    <div className="mt">{m.agentKey}<span className="tag off">{m.kind}</span></div>
                    <div className="mm">{m.text}</div>
                    <div className="mm">权重 {m.weight.toFixed(1)} · {m.source} · {m.createdAt.slice(0, 10)}</div>
                  </div>
                  <button className="mini-btn danger" disabled={busy === 'm' + m.id} onClick={() => delMem(m.id)}>删除</button>
                </div>
              ))}
              {!ctx.memories.length && <div className="blk-d">暂无长期记忆。</div>}
            </div>
          </div>
        )}

        {ctx && (
          <div className="blk">
            <div className="blk-h"><Icon name="doc" size={15} /><span className="t">知识库</span><span className="badge">{ctx.knowledge.length}</span></div>
            <div className="blk-d">该用户的资料：上传文档 / 对话沉淀 / 成果。点条目看切片，可重嵌或删除。</div>
            <label className="add-btn full">
              <Icon name="up" size={15} /> {busy === 'upload' ? '上传中…' : '代上传文档（PDF/Word/Excel/MD/TXT）'}
              <input className="file-hidden" type="file" onChange={onUpload} disabled={busy === 'upload'} />
            </label>
            <div className="mem-list">
              {ctx.knowledge.map((k) => (
                <div key={k.id} className="mem-card">
                  <span className="mi"><Icon name="doc" size={16} /></span>
                  <div className="mb" onClick={() => openDetail(k.id)}>
                    <div className="mt">{k.title || k.fileName || k.kind}<span className={`tag ${k.status === 'failed' ? '' : 'off'}`}>{KB_STATUS_LABEL[k.status] ?? k.status}</span>{k.fileType && <span className="tag">{k.fileType}</span>}</div>
                    <div className="mm">{k.sourceType} · {k.chunkCount} 切片{k.fileSize ? ' · ' + fmtSize(k.fileSize) : ''}{k.error ? ' · ⚠ ' + k.error : ''}</div>
                    {openDoc === k.id && docDetail && <div className="mm">{docDetail.textPreview.slice(0, 300)}{docDetail.textPreview.length > 300 ? '…' : ''}（{docDetail.chunks.length} 切片 · 维度 {[...new Set(docDetail.chunks.map((c) => c.dim))].join('/') || '—'}）</div>}
                  </div>
                  <button className="mini-btn" disabled={busy === 'k' + k.id} onClick={() => reembedKb(k.id)}>重嵌</button>
                  <button className="mini-btn danger" disabled={busy === 'k' + k.id} onClick={() => delKb(k.id)}>删除</button>
                </div>
              ))}
              {!ctx.knowledge.length && <div className="blk-d">暂无知识库内容。</div>}
            </div>
          </div>
        )}
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
  const { totals, byModel, topUsers, infra } = data;
  const maxModelCost = Math.max(1, ...byModel.map((m) => m.costMicros));
  const unpriced = byModel.some((m) => !m.calibrated);
  const infraTokens = infra.reduce((a, x) => a + x.totalTokens, 0);
  const infraCost = infra.reduce((a, x) => a + x.costMicros, 0);
  return (
    <>
      <div className="sec-h"><span className="t">Token 用量</span><span className="s">近 {data.windowDays} 天 · 用户产出（chat / deliverable）</span></div>
      <div className="pad">
        <div className="usage-summary">
          <div><b>{fmtTokens(totals.totalTokens)}</b><span>总 Token</span></div>
          <div><b>{fmtCny(totals.costMicros)}</b><span>成本</span></div>
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
            <div className="sec-h" style={{ marginTop: 6 }}><span className="t">按模型</span>{unpriced && <span className="s">部分模型未配单价（计 0）</span>}</div>
            {byModel.map((m) => (
              <div key={m.model} className="usage-row">
                <div className="usage-h">
                  <div className="usage-name">{m.model}{!m.calibrated && <span>未配价</span>}</div>
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
        {infra.length > 0 && (
          <>
            <div className="sec-h" style={{ marginTop: 6 }}><span className="t">检索基建消耗</span><span className="s">嵌入 / 重排 · 不计入用户用量</span></div>
            <div className="usage-summary" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div><b>{fmtTokens(infraTokens)}</b><span>基建 Token</span></div>
              <div><b>{fmtCny(infraCost)}</b><span>基建成本（未配单价则计 0）</span></div>
            </div>
            {infra.map((x) => (
              <div key={x.kind + x.model} className="usage-row">
                <div className="usage-h">
                  <div className="usage-name">{x.kind === 'embedding' ? '嵌入' : x.kind === 'rerank' ? '重排' : x.kind}<span>{x.model}</span></div>
                  <div className="usage-num">{fmtCny(x.costMicros)}</div>
                </div>
                <div className="usage-meta">{x.calls} 次 · {fmtTokens(x.totalTokens)} token</div>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}

function ObservabilityView() {
  const [data, setData] = useState<AdminTraceListView | null>(null);
  const [status, setStatus] = useState<'' | 'ok' | 'error'>('');
  const [detail, setDetail] = useState<AdminTraceDetail | null>(null);
  useEffect(() => { api.traces({ days: 7, status: status || undefined }).then(setData).catch(() => {}); }, [status]);
  if (!data) return <Loading />;
  const errRate = data.totals.calls ? Math.round((data.totals.errors / data.totals.calls) * 100) : 0;
  return (
    <>
      <div className="sec-h"><span className="t">调用诊断</span><span className="s">近 {data.windowDays} 天 · 每次 LLM 调用的耗时/状态/工具</span></div>
      <div className="pad">
        <div className="usage-summary">
          <div><b>{data.totals.calls}</b><span>调用次数</span></div>
          <div><b>{data.totals.errors}</b><span>错误数</span></div>
          <div><b>{errRate}%</b><span>错误率</span></div>
          <div><b>{data.totals.avgLatencyMs}ms</b><span>平均延迟</span></div>
        </div>
        <div className="bill-seg" style={{ margin: '8px 0' }}>
          {([['', '全部'], ['ok', '成功'], ['error', '错误']] as const).map(([v, l]) => (
            <div key={v} className={`bill-opt ${status === v ? 'on' : ''}`} onClick={() => setStatus(v)}><div className="bo-t">{l}</div></div>
          ))}
        </div>
        {data.items.length === 0 && <div className="usage-meta" style={{ padding: '10px 0' }}>暂无调用记录。</div>}
        {data.items.map((t) => (
          <div key={t.id} className="usage-row" style={{ cursor: 'pointer' }} onClick={() => api.trace(t.id).then(setDetail).catch(() => {})}>
            <div className="usage-h">
              <div className="usage-name">{t.agentKey ?? '（全局）'}<span>{t.kind} · {t.provider}/{t.model || '-'}</span></div>
              <div className={`usage-num ${t.status === 'error' ? '' : 'ok'}`}>{t.status === 'error' ? '错误' : `${t.latencyMs}ms`}</div>
            </div>
            <div className="usage-meta">{new Date(t.at).toLocaleString()} · {t.totalTokens} token{t.cachedInput ? ` · 缓存命中 ${t.cachedInput}` : ''}{t.toolCalls ? ` · 工具×${t.toolCalls}` : ''}{t.errorMessage ? ` · ${t.errorMessage.slice(0, 40)}` : ''}</div>
          </div>
        ))}
      </div>
      {detail && (
        <div className="ad-detail show" onClick={() => setDetail(null)}>
          <div className="ad-dh"><div className="bk" onClick={() => setDetail(null)}><Icon name="arrow" size={18} /></div><div className="dt"><div className="t">调用详情</div><div className="s">{detail.kind} · {detail.provider}/{detail.model || '-'}</div></div></div>
          <div className="ad-db" onClick={(e) => e.stopPropagation()}>
            <div className="usage-summary">
              <div><b>{detail.status === 'error' ? '错误' : '成功'}</b><span>状态</span></div>
              <div><b>{detail.latencyMs}ms</b><span>延迟</span></div>
              <div><b>{detail.toolCalls}/{detail.iterations}</b><span>工具/轮次</span></div>
              <div><b>{detail.totalTokens}</b><span>token</span></div>
              <div><b>{detail.cachedInput}</b><span>缓存命中</span></div>
            </div>
            {detail.errorMessage && <div className="ai-test err" style={{ marginTop: 8 }}><Icon name="spark" size={14} /> {detail.errorMessage}</div>}
            <div className="sec-h" style={{ marginTop: 8 }}><span className="t">输入</span></div>
            <pre className="trace-text">{detail.promptText ?? '（未捕获原文，设 LLM_TRACE_CAPTURE_TEXT=true 开启）'}</pre>
            <div className="sec-h"><span className="t">输出</span></div>
            <pre className="trace-text">{detail.responseText ?? '（未捕获原文）'}</pre>
          </div>
        </div>
      )}
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

type SkillForm = { id?: string; key: string; name: string; description: string; httpMethod: 'GET' | 'POST'; httpUrl: string; argsLocation: 'body' | 'query'; enabled: boolean; headersText: string; schemaText: string };
const BLANK_SKILL: SkillForm = { key: '', name: '', description: '', httpMethod: 'POST', httpUrl: '', argsLocation: 'body', enabled: true, headersText: '', schemaText: '{\n  "type": "object",\n  "properties": {\n    "query": { "type": "string", "description": "参数说明" }\n  },\n  "required": ["query"]\n}' };

const KIND_LABEL: Record<string, string> = { tool: '模型工具', output: '产出处理' };

function SkillLibraryView({ toast }: { toast: (m: string) => void }) {
  const [list, setList] = useState<SkillToolDef[]>([]);
  const [meta, setMeta] = useState<SkillToolMeta[]>([]);
  const [form, setForm] = useState<SkillForm | null>(null);
  const load = () => {
    api.customSkillTools().then(setList).catch(() => {});
    api.skillTools().then(setMeta).catch(() => {});
  };
  useEffect(() => { load(); }, []);
  const set = (p: Partial<SkillForm>) => setForm((f) => f && { ...f, ...p });
  const nativeSkills = meta.filter((m) => m.builtin); // 代码内置（tool + output）

  const edit = (d: SkillToolDef) => setForm({
    id: d.id, key: d.key, name: d.name, description: d.description, httpMethod: d.httpMethod, httpUrl: d.httpUrl,
    argsLocation: d.argsLocation, enabled: d.enabled, headersText: '', schemaText: JSON.stringify(d.inputSchema ?? {}, null, 2),
  });

  const save = () => {
    if (!form) return;
    let inputSchema: Record<string, unknown>;
    try { const o = JSON.parse(form.schemaText.trim() || '{}'); if (!o || typeof o !== 'object' || Array.isArray(o)) throw 0; inputSchema = o; }
    catch { toast('参数 Schema 不是合法 JSON 对象'); return; }
    let headers: Record<string, string> | undefined;
    if (form.headersText.trim()) {
      try { const o = JSON.parse(form.headersText.trim()); if (!o || typeof o !== 'object' || Array.isArray(o)) throw 0; headers = o; }
      catch { toast('请求头不是合法 JSON 对象'); return; }
    }
    const body: SkillToolUpsert = { key: form.key.trim(), name: form.name.trim(), description: form.description.trim(), httpMethod: form.httpMethod, httpUrl: form.httpUrl.trim(), argsLocation: form.argsLocation, enabled: form.enabled, inputSchema, ...(headers ? { headers } : {}) };
    const p = form.id ? api.updateSkillTool(form.id, body) : api.createSkillTool(body);
    p.then(() => { toast(form.id ? '已更新' : '已新增'); setForm(null); load(); }).catch((e) => toast(e?.message || '保存失败'));
  };

  const del = (d: SkillToolDef) => { if (confirm(`删除工具「${d.name}」？`)) api.delSkillTool(d.id).then(() => { toast('已删除'); load(); }).catch(() => {}); };

  if (form) {
    return (
      <>
        <div className="sec-h"><span className="t">{form.id ? '编辑技能' : '新增技能'}</span><span className="s">自定义 HTTP 工具</span></div>
        <div className="pad">
          <div className="crd new-agent">
            <div className="ai-field"><div className="ai-fl">工具标识 key（英文，模型调用名，保存后不可改）</div><input className="ai-input" placeholder="query_order" value={form.key} disabled={!!form.id} onChange={(e) => set({ key: e.target.value })} /></div>
            <div className="ai-field"><div className="ai-fl">展示名</div><input className="ai-input" placeholder="查订单" value={form.name} onChange={(e) => set({ name: e.target.value })} /></div>
            <div className="ai-field"><div className="ai-fl">描述（模型据此判断何时调用，写清楚）</div><textarea className="ta" rows={2} value={form.description} onChange={(e) => set({ description: e.target.value })} /></div>
            <div className="ai-field"><div className="ai-fl">请求方式</div>
              <div className="bill-seg">{(['POST', 'GET'] as const).map((m) => <div key={m} className={`bill-opt ${form.httpMethod === m ? 'on' : ''}`} onClick={() => set({ httpMethod: m })}><div className="bo-t">{m}</div></div>)}</div>
            </div>
            <div className="ai-field"><div className="ai-fl">接口 URL</div><input className="ai-input" placeholder="https://api.example.com/orders" value={form.httpUrl} onChange={(e) => set({ httpUrl: e.target.value })} /></div>
            <div className="ai-field"><div className="ai-fl">参数位置</div>
              <div className="bill-seg">{([['body', 'JSON Body'], ['query', 'Query 参数']] as const).map(([v, l]) => <div key={v} className={`bill-opt ${form.argsLocation === v ? 'on' : ''}`} onClick={() => set({ argsLocation: v })}><div className="bo-t">{l}</div></div>)}</div>
            </div>
            <div className="ai-field"><div className="ai-fl">参数 Schema（JSON Schema）</div><textarea className="ta" rows={7} value={form.schemaText} onChange={(e) => set({ schemaText: e.target.value })} /></div>
            <div className="ai-field"><div className="ai-fl">静态请求头 JSON（含鉴权，如 {'{'}"Authorization":"Bearer xxx"{'}'}）{form.id ? ' · 留空保留现有' : ''}</div><textarea className="ta" rows={3} placeholder={form.id ? '留空则不修改已存请求头' : '{\n  "Authorization": "Bearer ..."\n}'} value={form.headersText} onChange={(e) => set({ headersText: e.target.value })} /></div>
            <div className="cfg"><div className="cfg-row"><div className="cb"><div className="ct">启用</div><div className="cs">关闭后不出现在 agent 勾选列表</div></div><div className={`sw ${form.enabled ? 'on' : ''}`} onClick={() => set({ enabled: !form.enabled })}><i /></div></div></div>
            <div className="ai-actions">
              <button type="button" className="ai-btn ghost" onClick={() => setForm(null)}>取消</button>
              <button type="button" className="ai-btn primary" onClick={save}><Icon name="check" size={14} /> 保存</button>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="sec-h"><span className="t">技能库</span><span className="s">可插拔技能 · 内置 + 自建 · agent 可勾选启用</span></div>
      <div className="pad">
        <div className="usage-meta" style={{ padding: '2px 0 8px' }}>内置技能（代码提供，只读）</div>
        {nativeSkills.length === 0 && <div className="usage-meta" style={{ padding: '4px 0' }}>（加载中…）</div>}
        {nativeSkills.map((m) => (
          <div key={m.name} className="mem-card">
            <span className="mi"><Icon name={m.kind === 'output' ? 'layers' : 'insight'} size={16} /></span>
            <div className="mb">
              <div className="mt">{m.name}<span className="tag">{KIND_LABEL[m.kind] ?? m.kind}</span><span className="tag off">内置</span></div>
              <div className="mm">{m.description}</div>
            </div>
          </div>
        ))}
        <div className="usage-meta" style={{ padding: '14px 0 8px' }}>自定义 HTTP 工具（运营自建）</div>
        <button type="button" className="add-btn full" onClick={() => setForm({ ...BLANK_SKILL })}><Icon name="spark" size={15} /> 新增技能</button>
        {list.length === 0 && <div className="usage-meta" style={{ padding: '10px 0' }}>还没有自定义技能。点「新增技能」定义一个 HTTP 工具。</div>}
        {list.map((d) => (
          <div key={d.id} className="mem-card">
            <span className="mi"><Icon name="insight" size={16} /></span>
            <div className="mb" style={{ cursor: 'pointer' }} onClick={() => edit(d)}>
              <div className="mt">{d.name}<span className="tag off">{d.key}</span>{!d.enabled && <span className="tag">停用</span>}</div>
              <div className="mm">{d.httpMethod} {d.httpUrl}{d.hasHeaders ? ` · 含鉴权头(${d.headerKeys.join(',')})` : ''}</div>
            </div>
            <button type="button" className="mini-btn danger" onClick={() => del(d)}>删除</button>
          </div>
        ))}
      </div>
    </>
  );
}

function AuditView() {
  const [list, setList] = useState<AdminAuditItem[]>([]);
  const [selected, setSelected] = useState<AdminAuditItem | null>(null);
  useEffect(() => { api.auditLogs().then(setList).catch(() => {}); }, []);
  return (
    <>
      <div className="sec-h audit-head"><span className="t">审计日志</span><span className="s">默认过滤后台操作 · 用户 API / 登录尝试 · 最近 100 条</span></div>
      <div className="pad audit-pad">
        <div className="audit-table-wrap">
          <div className="audit-table">
            <div className="audit-row audit-header-row">
              <span>时间</span><span>状态</span><span>方法</span><span>接口/动作</span><span>用户</span><span>IP</span><span>摘要</span>
            </div>
            {list.map((a) => (
              <button
                key={a.id}
                type="button"
                className="audit-row audit-data-row"
                onClick={() => setSelected(a)}
                aria-label={`查看审计详情：${auditTarget(a)} ${a.summary ?? auditLabel(a.action)}`}
              >
                <span className="audit-time">{fmtShortTime(a.at)}</span>
                <span className={`audit-status ${statusClass(a.statusCode)}`}>{a.statusCode ?? '-'}</span>
                <span className="audit-method">{a.method ?? actionKind(a.action)}</span>
                <span className="audit-target" title={auditTarget(a)}>{auditTarget(a)}</span>
                <span className="audit-actor" title={actorText(a)}>{compactActorText(a)}</span>
                <span className="audit-ip" title={a.ip ?? ''}>{a.ip ?? '-'}</span>
                <span className="audit-summary" title={a.summary ?? auditLabel(a.action)}>{a.summary ?? auditLabel(a.action)}</span>
                <span className="audit-mobile-meta">{mobileAuditMeta(a)}</span>
              </button>
            ))}
          </div>
        </div>
        {!list.length && <div className="empty">暂无审计记录</div>}
      </div>
      {selected && <AuditDetailPanel item={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function AuditDetailPanel({ item, onClose }: { item: AdminAuditItem; onClose: () => void }) {
  const target = auditTarget(item);
  const summary = item.summary ?? auditLabel(item.action);
  return (
    <div className="ad-detail audit-detail show">
      <div className="ad-dh">
        <button className="bk" type="button" onClick={onClose} aria-label="关闭审计详情"><Icon name="arrow" size={18} /></button>
        <div className="di"><Icon name="clock" size={18} /></div>
        <div className="dt"><div className="t">审计详情</div><div className="s">{item.method ?? actionKind(item.action)} · {target}</div></div>
      </div>
      <div className="ad-db">
        <div className="audit-detail-summary">
          <span className={`audit-status ${statusClass(item.statusCode)}`}>{item.statusCode ?? '-'}</span>
          <div>
            <b>{summary}</b>
            <span>{fmtTime(item.at)}</span>
          </div>
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="target" size={15} /><span className="t">请求与动作</span></div>
          <div className="audit-detail-grid">
            <AuditDetailRow k="动作" v={`${auditLabel(item.action)} (${item.action})`} />
            <AuditDetailRow k="方法" v={item.method ?? actionKind(item.action)} />
            <AuditDetailRow k="接口" v={target} wide />
            <AuditDetailRow k="日志 ID" v={item.id} wide />
          </div>
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="user" size={15} /><span className="t">账号上下文</span></div>
          <div className="audit-detail-grid">
            <AuditDetailRow k="用户" v={actorText(item)} wide />
            <AuditDetailRow k="租户" v={item.tenantName || item.tenantId || '-'} />
            <AuditDetailRow k="用户 ID" v={item.userId || '-'} wide />
          </div>
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="insight" size={15} /><span className="t">网络指纹</span></div>
          <div className="audit-detail-grid">
            <AuditDetailRow k="IP" v={item.ip || '-'} />
            <AuditDetailRow k="UA" v={item.userAgent || '-'} wide />
          </div>
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="doc" size={15} /><span className="t">Payload</span></div>
          <pre className="audit-json">{formatPayload(item.payload)}</pre>
        </div>
        <div style={{ height: 32 }} />
      </div>
    </div>
  );
}

function AuditDetailRow({ k, v, wide = false }: { k: string; v: string; wide?: boolean }) {
  return (
    <div className={`audit-detail-kv ${wide ? 'wide' : ''}`}>
      <span>{k}</span>
      <b>{v || '-'}</b>
    </div>
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
  const openEdit = (e: MouseEvent, key: string) => {
    e.stopPropagation();
    onOpen(key);
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
              <div className="ai-field"><div className="ai-fl">价格（权益点）</div><NumInput className="ai-input" min={0} value={form.price} onChange={(price) => setForm({ ...form, price })} /></div>
            )}
            <div className="ai-actions">
              <button className="ai-btn ghost" onClick={() => setAdding(false)}>取消</button>
              <button className="ai-btn primary" onClick={create}><Icon name="check" size={14} /> 创建</button>
            </div>
          </div>
        )}
        {list.map((a) => (
          <div key={a.key} className="crd agent-card" onClick={() => onOpen(a.key)}>
            <div className="crd-row">
              <span className="crd-ic"><Icon name={a.icon} size={18} /></span>
              <div className="crd-b">
                <div className="ct">{a.name} {billingTag(a.billing, a.price)} {!a.enabled && <span className="tag off">停用</span>}</div>
                <div className="cs">{a.deliverableKey ? `产出 · ${a.deliverableKey}` : a.role} · {typeLabel(a.type)} · 已开通 {a.ownerCount ?? 0} · 成果 {a.deliverableCount ?? 0}</div>
              </div>
              <div className="crd-actions">
                <button type="button" className={`mini-btn ${a.enabled ? 'danger' : 'primary'}`} onClick={(e) => toggle(e, a)}>
                  {a.enabled ? '下架' : '上架'}
                </button>
                <button
                  type="button"
                  className="mini-btn edit-action"
                  onClick={(e) => openEdit(e, a.key)}
                  aria-label={`编辑${a.name}`}
                  title={`编辑${a.name}`}
                >
                  <Icon name="pen" size={13} /> 编辑
                </button>
              </div>
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
  const [form, setForm] = useState({ name: '', priceYuan: 0, creditsPerMonth: 0, tokenQuotaPerMonth: 0, agentCount: 0, features: '' });
  const load = () => api.plans().then(setList).catch(() => {});
  useEffect(() => { load(); }, []);
  const priceLabel = (p: Plan) => p.price < 0 ? '面议' : p.price === 0 ? '¥0' : `¥${(p.price / 100).toLocaleString()}${p.period === 'year' ? '/年' : '/月'}`;
  const startEdit = (p: Plan) => {
    setEditId(p.id);
    setForm({ name: p.name, priceYuan: p.price < 0 ? -1 : p.price / 100, creditsPerMonth: p.creditsPerMonth, tokenQuotaPerMonth: p.tokenQuotaPerMonth, agentCount: p.agentCount, features: p.featuresJson.join('\n') });
  };
  const save = async (id: string) => {
    try {
      await api.savePlan(id, {
        name: form.name,
        price: form.priceYuan < 0 ? -1 : Math.round(form.priceYuan * 100),
        creditsPerMonth: form.creditsPerMonth,
        tokenQuotaPerMonth: form.tokenQuotaPerMonth,
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
            <div className="ai-field"><div className="ai-fl">价格（元，-1=面议）</div><NumInput className="ai-input" value={form.priceYuan} onChange={(priceYuan) => setForm({ ...form, priceYuan })} /></div>
            <div className="ai-field"><div className="ai-fl">每月赠送钻石（-1=不限量）</div><NumInput className="ai-input" value={form.creditsPerMonth} onChange={(creditsPerMonth) => setForm({ ...form, creditsPerMonth })} /></div>
            <div className="ai-field"><div className="ai-fl">每月 token 额度（产出消耗池，-1=不限量）</div><NumInput className="ai-input" value={form.tokenQuotaPerMonth} onChange={(tokenQuotaPerMonth) => setForm({ ...form, tokenQuotaPerMonth })} /></div>
            <div className="ai-field"><div className="ai-fl">含智能体数</div><NumInput className="ai-input" value={form.agentCount} onChange={(agentCount) => setForm({ ...form, agentCount })} /></div>
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

// —— 大模型配置：运营自行「添加模型」（内置接入商 / 通用兼容 / 自主定义），添加后进入快速切换 ——
type ModelMode = 'builtin' | 'compatible' | 'custom';
interface ModelForm {
  id?: string;          // 编辑时有
  mode: ModelMode;
  preset: string;       // builtin 选中的内置接入商 id（'' = 未选）
  provider: AiProvider;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  priceInput: number;       // 元 / 1M 输入 token（内部成本核算）
  priceOutput: number;      // 元 / 1M 输出 token
  priceCachedInput: number; // 元 / 1M 命中缓存输入 token（0=同输入价）
  hasKey: boolean;      // 编辑时该模型是否已存 key（决定 Key 占位符）
}
const BLANK_MODEL: ModelForm = { mode: 'builtin', preset: '', provider: 'openai', label: '', baseUrl: '', model: '', apiKey: '', temperature: 0.7, priceInput: 0, priceOutput: 0, priceCachedInput: 0, hasKey: false };

function ModelView({ toast }: { toast: (m: string) => void }) {
  const [cfg, setCfg] = useState<AiConfig | null>(null);
  const [presets, setPresets] = useState<AiPreset[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [form, setForm] = useState<ModelForm | null>(null);
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // 检索增强（向量嵌入 / 重排）——全局配置，不随对话模型切换变动；可独立配凭证，留空回退当前生效模型。
  const [aux, setAux] = useState({ embeddingEnabled: false, embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', rerankEnabled: false, rerankModel: '', rerankBaseUrl: '', rerankApiKey: '' });
  const [auxTest, setAuxTest] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = () => api.aiConfig().then((v) => {
    setCfg(v.config); setPresets(v.presets); setModels(v.models);
    setAux({
      embeddingEnabled: v.config.embeddingEnabled, embeddingModel: v.config.embeddingModel, embeddingBaseUrl: v.config.embeddingBaseUrl, embeddingApiKey: '',
      rerankEnabled: v.config.rerankEnabled, rerankModel: v.config.rerankModel, rerankBaseUrl: v.config.rerankBaseUrl, rerankApiKey: '',
    });
  }).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!cfg) return <Loading />;

  const set = (p: Partial<ModelForm>) => setForm((f) => (f ? { ...f, ...p } : f));

  // 快速切换：点选某个已添加模型 → 即时生效。
  const activate = (m: AiModel) => {
    if (m.active || busy) return;
    setBusy(true);
    api.activateAiModel(m.id)
      .then((v) => { setCfg(v.config); setModels(v.models); toast(`已切换到「${m.label}」`); })
      .catch((e) => toast(e?.message || '切换失败'))
      .finally(() => setBusy(false));
  };
  const del = (m: AiModel) => {
    if (!confirm(`删除模型「${m.label}」？`)) return;
    api.delAiModel(m.id).then(() => { toast('已删除'); load(); }).catch((e) => toast(e?.message || '删除失败'));
  };
  const edit = (m: AiModel) => {
    setTest(null);
    setForm({
      id: m.id, mode: m.preset ? 'builtin' : m.provider === 'openai' ? 'compatible' : 'custom',
      preset: m.preset || '', provider: m.provider, label: m.label, baseUrl: m.baseUrl, model: m.model,
      apiKey: '', temperature: m.temperature,
      priceInput: m.priceInput, priceOutput: m.priceOutput, priceCachedInput: m.priceCachedInput, hasKey: m.hasKey,
    });
  };

  // —— 添加/编辑表单 ——
  if (form) {
    const setMode = (mode: ModelMode) => {
      setTest(null);
      if (mode === 'compatible') set({ mode, provider: 'openai', preset: '' });
      else if (mode === 'custom') set({ mode, preset: '' });
      else set({ mode });
    };
    const applyPreset = (id: string) => {
      setTest(null);
      const p = presets.find((x) => x.id === id);
      if (!p) { set({ preset: '' }); return; }
      set({ preset: p.id, provider: p.provider, label: form.label.trim() ? form.label : p.label, baseUrl: p.baseUrl, model: p.model });
    };
    const showBaseUrl = form.provider === 'openai';
    const showKey = form.provider !== 'mock';

    const testModel = async () => {
      setBusy(true); setTest(null);
      try {
        const r = await api.testAiModel({
          provider: form.provider, label: form.label, baseUrl: form.baseUrl, model: form.model,
          temperature: Number(form.temperature),
          ...(form.apiKey ? { apiKey: form.apiKey } : {}), ...(form.id ? { modelId: form.id } : {}),
        });
        setTest({ ok: r.ok, msg: r.ok ? `连通 · ${r.latencyMs}ms · ${r.model}${r.sample ? ' · 「' + r.sample + '」' : ''}` : (r.error || '未连通') });
      } catch { setTest({ ok: false, msg: '测试请求失败' }); }
      setBusy(false);
    };
    const saveModel = () => {
      if (!form.label.trim()) { toast('请填写展示名'); return; }
      if (form.provider !== 'mock' && !form.model.trim()) { toast('请填写模型 model'); return; }
      const body: AiModelUpsert = {
        provider: form.provider, label: form.label.trim(), baseUrl: form.baseUrl.trim(), model: form.model.trim(),
        temperature: Number(form.temperature), preset: form.preset || null,
        priceInput: Number(form.priceInput) || 0, priceOutput: Number(form.priceOutput) || 0, priceCachedInput: Number(form.priceCachedInput) || 0,
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      };
      const p = form.id ? api.updateAiModel(form.id, body) : api.addAiModel(body);
      p.then(() => { toast(form.id ? '已更新' : '已添加'); setForm(null); load(); }).catch((e) => toast(e?.message || '保存失败'));
    };

    return (
      <>
        <div className="sec-h"><span className="t">{form.id ? '编辑模型' : '添加模型'}</span><span className="s">{form.id ? '保存后若为生效模型则即时更新' : '保存后进入快速切换'}</span></div>
        <div className="pad">
          {/* 选择接入商模式 */}
          <Field label="接入方式">
            <div className="bill-seg">
              {([['builtin', '内置接入商'], ['compatible', '通用兼容协议'], ['custom', '完全自主定义']] as const).map(([v, l]) => (
                <div key={v} className={`bill-opt ${form.mode === v ? 'on' : ''}`} onClick={() => setMode(v)}><div className="bo-t">{l}</div></div>
              ))}
            </div>
          </Field>

          {form.mode === 'builtin' && (
            <Field label="内置接入商（选择后自动填好网关 / 模型，仍可改）">
              <select className="ai-input" value={form.preset} onChange={(e) => applyPreset(e.target.value)}>
                <option value="">— 选择接入商 —</option>
                {presets.map((p) => <option key={p.id} value={p.id}>{p.label}{p.note ? ` · ${p.note}` : ''}</option>)}
              </select>
            </Field>
          )}
          {form.mode === 'compatible' && (
            <div className="ai-note" style={{ marginTop: 0, marginBottom: 12 }}>通用 OpenAI 兼容协议：填入任意兼容厂商的网关地址（带 /v1）与模型名即可。</div>
          )}
          {form.mode === 'custom' && (
            <Field label="协议 provider">
              <select className="ai-input" value={form.provider} onChange={(e) => set({ provider: e.target.value as AiProvider })}>
                <option value="openai">openai（兼容 Agnes/DeepSeek/Qwen…）</option>
                <option value="claude">claude（Anthropic）</option>
                <option value="mock">mock（本地模板）</option>
              </select>
            </Field>
          )}

          <Field label="展示名"><input className="ai-input" value={form.label} onChange={(e) => set({ label: e.target.value })} placeholder="Agnes 2.0 Flash" /></Field>
          {showBaseUrl && (
            <Field label="网关地址 baseUrl（带 /v1）"><input className="ai-input" value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://apihub.agnes-ai.com/v1" /></Field>
          )}
          {form.provider !== 'mock' && (
            <Field label="模型 model"><input className="ai-input" value={form.model} onChange={(e) => set({ model: e.target.value })} placeholder="agnes-2.0-flash" /></Field>
          )}
          {showKey && (
            <Field label={`API Key${form.id && form.hasKey ? '（已配置，留空=不改）' : ''}`}>
              <input className="ai-input" type="password" value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder={form.id && form.hasKey ? '••••••（留空保留现有）' : '粘贴 API Key'} />
            </Field>
          )}
          {form.provider !== 'mock' && (
            <div className="ai-note" style={{ marginTop: 0, marginBottom: 12 }}>嵌入 / 重排模型不在这里配——它们是「检索增强」的全局配置(下方),独立于对话模型、不随切换变动。</div>
          )}
          <Field label={`温度 temperature · ${form.temperature}`}>
            <input className="ai-range" type="range" min={0} max={1} step={0.1} value={form.temperature} onChange={(e) => set({ temperature: Number(e.target.value) })} />
          </Field>

          {form.provider !== 'mock' && (
            <>
              <div className="ai-note" style={{ marginTop: 0, marginBottom: 8 }}>Token 单价（元 / 1M token）· 仅用于内部成本核算，不影响对用户计费 · 留 0 走内置价表估算。</div>
              <Field label="输入单价（元 / 1M token）"><NumInput className="ai-input" min={0} step={0.01} value={form.priceInput} onChange={(priceInput) => set({ priceInput })} /></Field>
              <Field label="输出单价（元 / 1M token）"><NumInput className="ai-input" min={0} step={0.01} value={form.priceOutput} onChange={(priceOutput) => set({ priceOutput })} /></Field>
              <Field label="缓存输入单价（元 / 1M token · 0=同输入价）"><NumInput className="ai-input" min={0} step={0.01} value={form.priceCachedInput} onChange={(priceCachedInput) => set({ priceCachedInput })} /></Field>
            </>
          )}

          {test && <div className={`ai-test ${test.ok ? 'ok' : 'err'}`}><Icon name={test.ok ? 'check' : 'alert'} size={13} /> {test.msg}</div>}

          <div className="ai-actions">
            <button className="ai-btn ghost" onClick={testModel} disabled={busy}><Icon name="spark" size={14} /> 测试连接</button>
            <button className="ai-btn primary" onClick={saveModel} disabled={busy}><Icon name="check" size={14} /> {form.id ? '保存' : '添加'}</button>
          </div>
          <div className="ai-actions" style={{ marginTop: 10 }}>
            <button className="ai-btn ghost" onClick={() => setForm(null)}>取消</button>
          </div>
        </div>
      </>
    );
  }

  // —— 检索增强（嵌入 / 重排）：全局开关 + 可独立配凭证（留空回退当前生效模型）——
  const setA = (p: Partial<typeof aux>) => setAux((a) => ({ ...a, ...p }));
  const auxPayload = () => ({
    embeddingEnabled: aux.embeddingEnabled, embeddingModel: aux.embeddingModel, embeddingBaseUrl: aux.embeddingBaseUrl,
    rerankEnabled: aux.rerankEnabled, rerankModel: aux.rerankModel, rerankBaseUrl: aux.rerankBaseUrl,
    ...(aux.embeddingApiKey ? { embeddingApiKey: aux.embeddingApiKey } : {}),
    ...(aux.rerankApiKey ? { rerankApiKey: aux.rerankApiKey } : {}),
  });
  const testAux = async () => {
    setBusy(true); setAuxTest(null);
    try {
      const r = await api.testAiConfig(auxPayload());
      const parts: string[] = [];
      if (r.embedding) parts.push(`嵌入 ${r.embedding.ok ? '连通' + (r.embedding.dim ? `·${r.embedding.dim}维` : '') : (r.embedding.error || '未连通')}`);
      if (r.rerank) parts.push(`重排 ${r.rerank.ok ? '连通' : (r.rerank.error || '未连通')}`);
      const ok = (!r.embedding || r.embedding.ok) && (!r.rerank || r.rerank.ok);
      setAuxTest({ ok, msg: parts.length ? parts.join(' ｜ ') : '未开启任何增强项' });
    } catch { setAuxTest({ ok: false, msg: '测试请求失败' }); }
    setBusy(false);
  };
  const saveAux = async () => {
    setBusy(true);
    try { const v = await api.saveAiConfig(auxPayload()); setCfg(v.config); setAux((a) => ({ ...a, embeddingApiKey: '', rerankApiKey: '' })); toast('检索增强配置已保存并即时生效'); }
    catch { toast('保存失败'); }
    setBusy(false);
  };

  // —— 列表 + 快速切换 ——
  // 检索增强「生效」判定：开关开 + 有模型 + (独立 baseUrl 或回退对话模型 baseUrl) + (独立 key 或回退对话模型 key)。
  const baseKey = cfg.hasKey;
  const embReady = cfg.embeddingEnabled && !!cfg.embeddingModel && (!!cfg.embeddingBaseUrl || !!cfg.baseUrl) && (cfg.hasEmbeddingKey || baseKey);
  const rerankReady = cfg.rerankEnabled && !!cfg.rerankModel && (!!cfg.rerankBaseUrl || !!cfg.baseUrl) && (cfg.hasRerankKey || baseKey);
  return (
    <>
      <div className="sec-h"><span className="t">大模型配置</span><span className="s">添加模型 · 一键快速切换 · 即时生效</span></div>
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

        {/* 快速切换：点选已添加模型即时生效 */}
        <div className="ai-label">快速切换</div>
        <div className="ai-presets">
          {models.map((m) => (
            <button key={m.id} className={`ai-preset ${m.active ? 'on' : ''}`} disabled={busy} onClick={() => activate(m)} title={`${m.provider} · ${m.model}${m.hasKey ? '' : ' · 未配 Key'}`}>{m.label}</button>
          ))}
          <button className="ai-preset add" onClick={() => { setTest(null); setForm({ ...BLANK_MODEL }); }}>＋ 添加模型</button>
        </div>

        {/* 已添加模型管理 */}
        <div className="ai-label">已添加模型</div>
        {models.length === 0 && <div className="usage-meta" style={{ padding: '10px 0' }}>还没有模型。点「添加模型」接入一个大模型。</div>}
        {models.map((m) => (
          <div key={m.id} className="mem-card">
            <span className="mi"><Icon name="insight" size={16} /></span>
            <div className="mb" style={{ cursor: 'pointer' }} onClick={() => edit(m)}>
              <div className="mt">{m.label}{m.active && <span className="tag" style={{ marginLeft: 6 }}>生效中</span>}{!m.hasKey && m.provider !== 'mock' && <span className="tag" style={{ marginLeft: 6 }}>未配 Key</span>}</div>
              <div className="mm">{m.provider} · {m.model || '—'}{m.preset ? ` · 内置:${m.preset}` : ''}{(m.priceInput > 0 || m.priceOutput > 0) ? ` · 单价 入¥${m.priceInput}/出¥${m.priceOutput} 每1M` : ' · 单价待配'}</div>
            </div>
            {!m.active && <button className="mini-btn" onClick={() => activate(m)} disabled={busy}>切换</button>}
            <button className="mini-btn danger" onClick={() => del(m)}>删除</button>
          </div>
        ))}
        {/* —— 检索增强：向量嵌入 / 重排（全局开关，不随对话模型切换）—— */}
        <div className="ai-label" style={{ marginTop: 18 }}>检索增强（知识库 / 记忆）</div>
        <div className={`ai-test ${embReady || rerankReady ? 'ok' : 'err'}`} style={{ margin: '0 0 12px' }}>
          <Icon name={embReady || rerankReady ? 'check' : 'alert'} size={13} />
          <span>当前生效：嵌入 {embReady ? `远程·${cfg.embeddingModel}` : '本地确定性兜底'} ｜ 重排 {rerankReady ? `远程·${cfg.rerankModel}` : '未启用（融合分顺序）'}。配置可用≠每次调用都成功——点下方「测试增强项」实地探活；调用失败会静默回退本地。</span>
        </div>
        <div className="ai-sub">
          <div className="ai-sub-h">
            <div className="b"><div className="t">向量嵌入 Embedding</div><div className="s">关＝本地确定性嵌入（零依赖）；开＝调用嵌入模型，语义召回更准</div></div>
            <div className={`sw ${aux.embeddingEnabled ? 'on' : ''}`} onClick={() => setA({ embeddingEnabled: !aux.embeddingEnabled })}><i /></div>
          </div>
          {aux.embeddingEnabled && (
            <>
              <Field label="嵌入模型 model"><input className="ai-input" value={aux.embeddingModel} onChange={(e) => setA({ embeddingModel: e.target.value })} placeholder="text-embedding-3-small / text-embedding-v3" /></Field>
              <Field label="接入地址 baseUrl（留空＝复用当前生效模型）"><input className="ai-input" value={aux.embeddingBaseUrl} onChange={(e) => setA({ embeddingBaseUrl: e.target.value })} placeholder="留空复用对话模型网关" /></Field>
              <Field label={`API Key${cfg.hasEmbeddingKey ? '（已配置，留空＝不改）' : '（留空＝复用对话模型）'}`}>
                <input className="ai-input" type="password" value={aux.embeddingApiKey} onChange={(e) => setA({ embeddingApiKey: e.target.value })} placeholder={cfg.hasEmbeddingKey ? '••••••（留空保留现有）' : '留空复用对话模型 Key'} />
              </Field>
            </>
          )}
        </div>

        <div className="ai-sub">
          <div className="ai-sub-h">
            <div className="b"><div className="t">重排 Rerank</div><div className="s">开＝知识库检索融合打分后，再用 rerank 模型重排候选，提升 TopN 命中</div></div>
            <div className={`sw ${aux.rerankEnabled ? 'on' : ''}`} onClick={() => setA({ rerankEnabled: !aux.rerankEnabled })}><i /></div>
          </div>
          {aux.rerankEnabled && (
            <>
              <Field label="重排模型 model"><input className="ai-input" value={aux.rerankModel} onChange={(e) => setA({ rerankModel: e.target.value })} placeholder="bge-reranker-v2-m3 / rerank-3 …" /></Field>
              <Field label="接入地址 baseUrl（留空＝复用当前生效模型）"><input className="ai-input" value={aux.rerankBaseUrl} onChange={(e) => setA({ rerankBaseUrl: e.target.value })} placeholder="如 https://api.siliconflow.cn/v1" /></Field>
              <Field label={`API Key${cfg.hasRerankKey ? '（已配置，留空＝不改）' : '（留空＝复用对话模型）'}`}>
                <input className="ai-input" type="password" value={aux.rerankApiKey} onChange={(e) => setA({ rerankApiKey: e.target.value })} placeholder={cfg.hasRerankKey ? '••••••（留空保留现有）' : '留空复用对话模型 Key'} />
              </Field>
            </>
          )}
        </div>

        {auxTest && <div className={`ai-test ${auxTest.ok ? 'ok' : 'err'}`}><Icon name={auxTest.ok ? 'check' : 'alert'} size={13} /> {auxTest.msg}</div>}
        <div className="ai-actions">
          <button className="ai-btn ghost" onClick={testAux} disabled={busy}><Icon name="spark" size={14} /> 测试增强项</button>
          <button className="ai-btn primary" onClick={saveAux} disabled={busy}><Icon name="check" size={14} /> 保存检索增强</button>
        </div>
        <div className="ai-note">提示：未配置真实 Key 时系统自动降级本地模板（mock）/ 本地嵌入，保证可用；切换后所有顾问产出 / 记忆提炼 / 对话汇总即走该模型。嵌入 / 重排为全局配置，不随对话模型切换变动。</div>
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

function fmtShortTime(s: string) {
  return fmtTime(s).slice(5);
}

function creditText(v: number) {
  return v < 0 ? '不限量' : `${v} 点`;
}

function actorText(a: AdminAuditItem) {
  const name = a.userName || '匿名/未解析用户';
  const parts = [name, a.userPhone, a.tenantName, a.userId ? `user:${a.userId}` : null].filter(Boolean);
  return parts.join(' · ') || '无账号上下文';
}

function compactActorText(a: AdminAuditItem) {
  return a.userName || a.userPhone || (a.userId ? `user:${a.userId.slice(0, 6)}` : '匿名');
}

function mobileAuditMeta(a: AdminAuditItem) {
  return [compactActorText(a), a.ip].filter(Boolean).join(' · ');
}

function auditTarget(a: AdminAuditItem) {
  return a.path || auditLabel(a.action);
}

function actionKind(action: string) {
  if (action.endsWith('.http')) return 'API';
  if (action.includes('login') || action.includes('auth')) return 'AUTH';
  return 'ACT';
}

function statusClass(status: number | null) {
  if (status === null) return 'muted';
  if (status >= 500) return 'bad';
  if (status >= 400) return 'warn';
  return 'ok';
}

function formatPayload(payload: unknown) {
  if (payload === null || payload === undefined) return '{}';
  if (typeof payload === 'string') {
    try { return JSON.stringify(JSON.parse(payload), null, 2); }
    catch { return payload; }
  }
  try { return JSON.stringify(payload, null, 2); }
  catch { return String(payload); }
}

function auditLabel(action: string) {
  const labels: Record<string, string> = {
    'auth.http': '登录 API 行为',
    'admin.http': '后台 API 行为',
    'auth.register': '手机号注册',
    'auth.login': '手机号登录',
    'auth.sms.send_attempt': '短信验证码尝试',
    'auth.login.attempt': '手机号登录尝试',
    'auth.wechat_register': '微信注册',
    'auth.wechat_login': '微信登录',
    'auth.wechat_login.attempt': '微信登录尝试',
    'auth.wechat_phone.attempt': '本机号登录尝试',
    'auth.carrier_onetap.attempt': '运营商一键登录尝试',
    'auth.onetap_register': '一键登录注册',
    'auth.onetap_login': '一键登录',
    'admin.agent.publish': '功能上架',
    'admin.agent.unpublish': '功能下架',
    'admin.agent.update': '智能体配置变更',
    'admin.agent.create': '新增智能体',
    'admin.user.agent.grant': '后台开通智能体',
    'admin.user.agent.revoke': '取消智能体开通',
    'user.agent.purchase': '用户解锁智能体',
    'admin.ai.update': '模型配置变更',
    'admin.ai.model.add': '添加模型',
    'admin.ai.model.update': '编辑模型',
    'admin.ai.model.delete': '删除模型',
    'admin.ai.model.activate': '快速切换模型',
    'admin.account.init': '初始化后台账户',
    'admin.account.init_attempt': '后台初始化尝试',
    'admin.account.login': '后台账户登录',
    'admin.account.login_attempt': '后台登录尝试',
    'admin.account.password': '修改后台密码',
    'admin.account.password_attempt': '后台改密尝试',
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
// 知识库：看用户知识库被切片/嵌入加工的状态 + 维度体检 + 一键重嵌（换嵌入模型后存量会维度不匹配、向量召回静默失效）。
function KnowledgeView({ toast }: { toast: (m: string) => void }) {
  const [data, setData] = useState<AdminKnowledgeView | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.knowledge().then(setData).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!data) return <Loading />;
  const { totals } = data;
  const stale = totals.staleChunks > 0 || totals.staleMemories > 0;
  const reembed = () => {
    if (!confirm('用当前嵌入模型重嵌全部知识库切片 + 长期记忆？数据量大时可能较慢。')) return;
    setBusy(true);
    api.reembedKnowledge()
      .then((r) => { toast(`已重嵌 ${r.chunks} 切片 / ${r.memories} 记忆 · ${r.dim} 维`); load(); })
      .catch((e) => toast(e?.message || '重嵌失败'))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <div className="sec-h"><span className="t">知识库</span><span className="s">用户知识库 · 切片 / 嵌入加工状态</span></div>
      <div className="pad">
        <div className={`ai-test ${stale ? 'err' : 'ok'}`} style={{ margin: '0 0 12px' }}>
          <Icon name={stale ? 'alert' : 'check'} size={13} />
          <span>当前嵌入：{data.embedRemote ? `远程 ${data.embedModel}` : '本地确定性嵌入'} · {data.embedDim} 维。{stale
            ? ` ⚠ ${totals.staleChunks} 切片 / ${totals.staleMemories} 记忆为旧维度，向量召回已静默失效，请重新嵌入。`
            : ' 存量维度与当前一致 ✓'}</span>
        </div>
        <div className="usage-summary">
          <div><b>{totals.items}</b><span>知识项</span></div>
          <div><b>{totals.chunks}</b><span>切片</span></div>
          <div><b>{totals.memories}</b><span>长期记忆</span></div>
          <div><b>{totals.staleChunks + totals.staleMemories}</b><span>待重嵌</span></div>
        </div>
        <button type="button" className="add-btn full" onClick={reembed} disabled={busy}><Icon name="spark" size={15} /> {busy ? '重新嵌入中…' : '重新嵌入存量'}</button>
        {data.items.length === 0 && <div className="empty">还没有知识库内容。用户在对话里 @ 引用资料 / 上传 / 沉淀成果后，会在此显示。</div>}
        {data.items.map((it) => (
          <div key={it.id} className="mem-card">
            <span className="mi"><Icon name="doc" size={16} /></span>
            <div className="mb">
              <div className="mt">{it.title}<span className="tag off">{it.kind}</span>{it.stale && <span className="tag">旧维度</span>}</div>
              <div className="mm">{it.tenantName ?? it.tenantId.slice(0, 8)} · {it.chunks} 切片 · 维度 {it.dims.join('/') || '—'}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function RetrievalDebugView() {
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [agents, setAgents] = useState<AdminAgent[]>([]);
  const [userId, setUserId] = useState('');
  const [agentKey, setAgentKey] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [res, setRes] = useState<AdminRetrievalDebug | null>(null);
  useEffect(() => {
    api.users().then((u) => { setUsers(u); if (u[0]) setUserId(u[0].id); }).catch(() => {});
    api.agents().then((a) => { setAgents(a); const s = a.find((x) => x.key === 'strat') ?? a[0]; if (s) setAgentKey(s.key); }).catch(() => {});
  }, []);
  const run = () => {
    const q = query.trim();
    if (!userId || !q) { setErr('请选择用户并输入要测试的问题'); return; }
    setErr(''); setBusy(true); setRes(null);
    api.retrievalTest({ userId, query: q, agentKey: agentKey || undefined })
      .then(setRes)
      .catch((e) => setErr(e?.message || '检索失败'))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <div className="sec-h"><span className="t">检索调试</span><span className="s">对某用户跑真实检索 · 命中 / 融合分 / rerank / 记忆 / 注入上下文</span></div>
      <div className="pad">
        <select className="ai-input" value={userId} onChange={(e) => setUserId(e.target.value)}>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name || '（未命名）'} · {u.id.slice(0, 8)}</option>)}
        </select>
        <select className="ai-input" value={agentKey} onChange={(e) => setAgentKey(e.target.value)}>
          {agents.map((a) => <option key={a.key} value={a.key}>{a.name}（{a.key}）</option>)}
        </select>
        <input className="ai-input" value={query} placeholder="输入要测试的问题，如：供应链怎么优化" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') run(); }} />
        <button type="button" className="add-btn full" onClick={run} disabled={busy}><Icon name="target" size={15} /> {busy ? '检索中…' : '跑检索'}</button>
        {err && <div className="ai-test err" style={{ margin: '10px 0 0' }}><Icon name="alert" size={13} /><span>{err}</span></div>}

        {res && (
          <>
            <div className="ai-test ok" style={{ margin: '12px 0' }}>
              <Icon name={res.embedRemote ? 'check' : 'alert'} size={13} />
              <span>嵌入：{res.embedRemote ? `远程 ${res.embedModel}` : res.embedModel} · {res.embedDim} 维。重排：{res.rerankEnabled ? (res.rerankApplied ? `已生效（${res.rerankModel}）` : `已开启但本次未重排（${res.rerankModel}）`) : '未开启'}。</span>
            </div>

            <div className="sec-h" style={{ marginTop: 6 }}><span className="t">候选命中</span><span className="s">融合分降序 · 共 {res.candidates.length}</span></div>
            {res.candidates.length === 0 && <div className="empty">没有召回到任何候选。该用户可能还没有知识库内容，或问题与资料无关。</div>}
            {res.candidates.map((c) => (
              <div key={c.itemId} className="usage-row">
                <div className="usage-h">
                  <div className="usage-name">{c.title || c.kind}{c.rerankRank != null && <span>rerank #{c.rerankRank}</span>}</div>
                  <div className="usage-num">{c.fusionScore.toFixed(3)}</div>
                </div>
                <div className="usage-meta">语义 {c.semScore.toFixed(3)} · 关键词 {c.kwScore.toFixed(3)}{c.rerankScore != null ? ` · rerank ${c.rerankScore.toFixed(3)}` : ''}</div>
                <div className="usage-meta">{c.snippet}</div>
              </div>
            ))}

            <div className="sec-h" style={{ marginTop: 6 }}><span className="t">记忆召回</span><span className="s">{res.agentKey} · {res.memories.length} 条</span></div>
            {res.memories.length === 0 && <div className="empty">该用户 × 该顾问暂无可召回的长期记忆。</div>}
            {res.memories.map((m, i) => <div key={i} className="usage-row"><div className="usage-meta">{m}</div></div>)}

            <div className="sec-h" style={{ marginTop: 6 }}><span className="t">最终注入 · 知识</span><span className="s">buildGenContext 实际注入</span></div>
            {res.contextKnowledge.length === 0
              ? <div className="empty">本轮未注入知识行。</div>
              : res.contextKnowledge.map((k, i) => <div key={i} className="usage-row"><div className="usage-meta">{k}</div></div>)}

            <div className="sec-h" style={{ marginTop: 6 }}><span className="t">最终注入 · 军师档案</span></div>
            {res.understanding.length === 0
              ? <div className="empty">暂无军师档案行。</div>
              : res.understanding.map((u, i) => <div key={i} className="usage-row"><div className="usage-meta">{u}</div></div>)}
          </>
        )}
      </div>
    </>
  );
}

function Loading() { return <div className="pad" style={{ padding: 40, textAlign: 'center', color: 'var(--ink-3)' }}>加载中…</div>; }
