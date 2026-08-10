// 用户：客服排查主战场——找人 → 看额度/用量/订单 → 处置（额度/钻石/套餐/模块/附身）。
import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from 'react';
import Icon from '../Icon';
import NumInput from '../NumInput';
import { api, uploadUserKnowledge, type ServiceAssignmentView, type AdminUserItem, type AdminUserDetail, type AdminUserUsage, type AdminUserPlanStatus, type AdminUserContext, type AdminUserQuotaView, type KnowledgeDetail, type AdminImpersonateResult } from '../api';
import { PageHead, ViewState, SearchBox, ConfirmDialog, ErrorState, Skeleton, type ConfirmSpec } from '../components';
import { useResource } from '../useResource';
import { KV, sum, fmtTime, creditText, sourceLabel, fmtTokens, fmtCny, fmtYuan, fmtSize, planStatusText } from '../format';

/* 客服拿到的线索只有「姓名」或「手机号」，旧版这一屏却是：一次性渲染全部用户、无搜索、
   无筛选、无排序——找人只能靠浏览器 Ctrl+F 在长列表里翻。现在给出搜索 + 三个真实值班
   会用到的筛选（额度耗尽 / 无套餐 / 未绑微信）+ 排序。数据量不大（api.users() 本就返回
   全量），过滤排序在前端做，不必改后端。 */
type UserSort = 'recent' | 'token' | 'spent' | 'balance';
const SORTS: [UserSort, string][] = [['recent', '最近活跃'], ['token', 'Token 用量'], ['spent', '钻石消耗'], ['balance', '余额']];

export function UsersView({ onOpen, initialQ = '' }: { onOpen: (id: string) => void; initialQ?: string }) {
  const res = useResource(api.users, []);
  // 从订单/审核等页跳进来时带着搜索词（#/users?q=王总），直接落在那个人身上。
  const [q, setQ] = useState(initialQ);
  useEffect(() => { setQ(initialQ); }, [initialQ]);
  const [sort, setSort] = useState<UserSort>('recent');
  const [drained, setDrained] = useState(false);   // 额度耗尽（quotaRemaining === 0）
  const [noPlan, setNoPlan] = useState(false);     // 无套餐
  const [noWechat, setNoWechat] = useState(false); // 未绑微信

  const all = res.data ?? [];
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = all.filter((u) => {
      if (drained && u.quotaRemaining !== 0) return false;
      if (noPlan && u.planName) return false;
      if (noWechat && u.wechatLinked) return false;
      if (!needle) return true;
      return u.name?.toLowerCase().includes(needle)
        || u.phone?.includes(needle)
        || u.id.toLowerCase().startsWith(needle)
        || u.tenantName?.toLowerCase().includes(needle);
    });
    out = [...out].sort((a, b) => {
      if (sort === 'token') return b.tokenUsed30d - a.tokenUsed30d;
      if (sort === 'spent') return b.totalSpent - a.totalSpent;
      if (sort === 'balance') return b.creditBalance - a.creditBalance;
      // recent：有会话的按最后会话倒序，没会话的排后面
      const ta = a.lastSessionAt ? Date.parse(a.lastSessionAt) : 0;
      const tb = b.lastSessionAt ? Date.parse(b.lastSessionAt) : 0;
      return tb - ta;
    });
    return out;
  }, [all, q, sort, drained, noPlan, noWechat]);

  const filtered = q.trim() || drained || noPlan || noWechat;

  return (
    <>
      <PageHead k="users" res={res} badge={`${all.length} 人`} />
      <div className="pad">
        <div className="filter-bar">
          <SearchBox value={q} onChange={setQ} placeholder="姓名 / 手机号 / 租户 / 用户 ID…" />
          <div className="chip-row">
            <button type="button" className={`chip ${drained ? 'on' : ''}`} onClick={() => setDrained((v) => !v)}>额度耗尽</button>
            <button type="button" className={`chip ${noPlan ? 'on' : ''}`} onClick={() => setNoPlan((v) => !v)}>无套餐</button>
            <button type="button" className={`chip ${noWechat ? 'on' : ''}`} onClick={() => setNoWechat((v) => !v)}>未绑微信</button>
          </div>
        </div>
        <div className="filter-bar">
          <div className="chip-row">
            {SORTS.map(([v, l]) => (
              <button key={v} type="button" className={`chip ${sort === v ? 'on' : ''}`} onClick={() => setSort(v)}>{l}</button>
            ))}
          </div>
        </div>
        {!res.initial && (
          <div className="pill-row">
            <span className="pill"><Icon name="user" size={13} /> {filtered ? `${shown.length} / ${all.length}` : all.length} 用户</span>
            <span className="pill"><Icon name="chat" size={13} /> {sum(shown, 'sessionCount')} 会话</span>
            <span className="pill"><Icon name="doc" size={13} /> {sum(shown, 'deliverableCount')} 成果</span>
          </div>
        )}
      </div>
      <ViewState res={res}>
        {() => (
          <div className="pad">
            {shown.length === 0 && (
              <div className="empty">
                {all.length === 0 ? '还没有注册用户。' : `没有匹配的用户。`}
                {filtered && all.length > 0 && <div className="usage-meta">试着清掉搜索词或筛选条件。</div>}
              </div>
            )}
            {shown.map((u) => (
              <div key={u.id} className="crd user-card" onClick={() => onOpen(u.id)}>
                <div className="crd-row">
                  <span className="crd-ic"><Icon name="user" size={18} /></span>
                  <div className="crd-b">
                    <div className="ct">{u.name} {u.wechatLinked && <span className="tag">微信</span>} {u.quotaRemaining === -1 && <span className="tag">不限量</span>} {u.quotaRemaining === 0 && <span className="tag warn">额度耗尽</span>}</div>
                    <div className="cs">{u.phone} · {u.tenantName} · {u.planName ?? '未分配套餐'}</div>
                  </div>
                  <span className="user-balance">{creditText(u.creditBalance)}</span>
                  <span className="edit"><Icon name="pen" size={15} /></span>
                </div>
                <div className="kv-grid">
                  <KV k="注册时间" v={fmtTime(u.createdAt)} />
                  <KV k="最后会话" v={u.lastSessionAt ? fmtTime(u.lastSessionAt) : '暂无'} />
                  <KV k="会话/成果" v={`${u.sessionCount}/${u.deliverableCount}`} />
                  <KV k="钻石消耗" v={`${u.totalSpent}`} />
                  <KV k="30 天 Token" v={fmtTokens(u.tokenUsed30d)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </ViewState>
    </>
  );
}

// 用户详情：智能体开通 + 上下文中心（个人档案 / 长期记忆 / 知识库）——观测与纠偏。
const MATURITY_LABEL: Record<string, string> = { empty: '资料不足', forming: '初步成形', ready: '可作底稿' };

const KB_STATUS_LABEL: Record<string, string> = { ready: '就绪', parsing: '解析中', embedding: '嵌入中', failed: '失败', pending: '排队' };

// 附身登录（仅超管）：签发目标用户的短时 token，运营复制令牌后在小程序内以其身份登入排查。
// 展示失效时间，未配 APP_JWT_SECRET 时展示后端 warning（token 为明文且不过期）。
// 注：H5 链路暂缓（wxapi 根为占位页、H5 仅在 aibuzz.cn 托管且公网可达性存疑），故只给令牌走小程序。
function ImpersonateBlock({ userId, userName, toast }: { userId: string; userName: string; toast: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AdminImpersonateResult | null>(null);
  const [err, setErr] = useState('');
  const sign = async () => {
    setErr(''); setBusy(true);
    try { setResult(await api.impersonate(userId)); }
    catch (e) { setResult(null); setErr((e as Error).message || '签发失败'); }
    setBusy(false);
  };
  const copy = (text: string, label: string) => {
    navigator.clipboard?.writeText(text).then(() => toast(`已复制${label}`)).catch(() => toast(text));
  };
  return (
    <div className="blk">
      <div className="blk-h"><Icon name="user" size={15} /><span className="t">附身登录</span><span className="badge">仅超管</span></div>
      <div className="blk-d">为「{userName}」签发一枚短时令牌，复制后在小程序里以其身份登入排查线上问题。令牌切勿转发，用后即弃，签发会留审计。</div>
      <div className="blk-d">用法：复制令牌 → 小程序登录页长按 slogan 首字「谋」（谋定而后动），或「我的」→「设置」长按「当前版本」→ 粘贴令牌即以其身份登入。</div>
      <button type="button" className="mini-btn primary" disabled={busy} onClick={sign}>{busy ? '签发中…' : '签发附身令牌'}</button>
      {err && <div className="blk-d err"><Icon name="alert" size={13} /> {err}</div>}
      {result && (
        <div className="mem-list">
          <div className="mem-card">
            <span className="mi"><Icon name="arrow" size={16} /></span>
            <div className="mb">
              <div className="mt">附身令牌</div>
              <div className="mm">{result.token}</div>
              <div className="mm">{result.expiresAt ? `令牌 ${fmtTime(result.expiresAt)} 失效` : '令牌不过期（未启用签名，明文令牌）'}</div>
            </div>
            <button type="button" className="mini-btn" onClick={() => copy(result.token, '令牌')}>复制令牌</button>
          </div>
          {result.warning && <div className="blk-d err"><Icon name="alert" size={13} /> {result.warning}</div>}
        </div>
      )}
    </div>
  );
}

export function UserDetailPanel({ userId, isOwner, onClose, toast }: { userId: string; isOwner: boolean; onClose: () => void; toast: (m: string) => void }) {
  const [data, setData] = useState<AdminUserDetail | null>(null);
  const [ctx, setCtx] = useState<AdminUserContext | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [openDoc, setOpenDoc] = useState('');
  const [docDetail, setDocDetail] = useState<KnowledgeDetail | null>(null);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const load = () => api.userDetail(userId).then((d) => { setData(d); setErr(''); }).catch((e) => setErr((e as Error).message || '加载失败'));
  const loadCtx = () => api.userContext(userId).then(setCtx).catch(() => { /* 上下文次要，失败不挡住主面板 */ });
  useEffect(() => { load(); loadCtx(); }, [userId]);
  // 详情打不开时要给出出口，而不是渲染 null（旧版：面板整个不出现，运营以为点击没反应）。
  if (!data) {
    return (
      <div className="ad-detail show">
        <div className="ad-dh">
          <button type="button" className="bk" onClick={onClose} aria-label="返回"><Icon name="arrow" size={18} /></button>
          <div className="dt"><div className="t">用户详情</div><div className="s">{userId.slice(0, 12)}…</div></div>
        </div>
        <div className="ad-db">
          {err
            ? <ErrorState msg={err} onRetry={load} />
            : <Skeleton kind="stats" />}
        </div>
      </div>
    );
  }
  const u = data.user;
  const toggle = async (key: string, owned: boolean, name: string) => {
    setBusy(key);
    try {
      if (owned) { await api.revokeAgent(userId, key); toast(`已取消「${name}」`); }
      else { await api.grantAgent(userId, key); toast(`已为该用户开通「${name}」`); }
      await load();
    } catch (e) { toast((e as Error)?.message || '操作失败'); }
    setBusy('');
  };
  // 删记忆/删知识项都会改变该用户后续产出，回显具体内容再确认（原生 confirm 只有一句干话）。
  const delMem = (mid: string, text: string, agentKey: string) => setConfirmSpec({
    title: '删除这条长期记忆',
    desc: '删除后不再影响该用户后续产出，用于纠正脏记忆或隐私清理。不可恢复。',
    echo: [{ k: '所属顾问', v: agentKey }, { k: '记忆内容', v: text }],
    confirmText: '删除记忆',
    danger: true,
    onConfirm: async () => {
      setBusy('m' + mid);
      try { await api.delUserMemory(userId, mid); toast('已删除记忆'); await loadCtx(); }
      finally { setBusy(''); }
    },
  });
  const openDetail = async (kid: string, force = false) => {
    if (openDoc === kid && !force) { setOpenDoc(''); setDocDetail(null); return; }
    setOpenDoc(kid); setDocDetail(null);
    try { setDocDetail(await api.userKnowledgeDetail(userId, kid)); }
    catch (e) { toast((e as Error)?.message || '知识详情加载失败'); }
  };
  const reembedKb = async (kid: string) => {
    setBusy('k' + kid);
    try { const r = await api.reembedUserKnowledge(userId, kid); toast(`已重嵌 ${r.chunks} 切片`); await loadCtx(); if (openDoc === kid) await openDetail(kid, true); }
    catch (e) { toast((e as Error)?.message || '重嵌失败'); }
    setBusy('');
  };
  const delKb = (kid: string, title: string, chunks: number) => setConfirmSpec({
    title: '删除该知识项',
    desc: '切片与原件会一并清除，该用户后续产出不再引用这份资料。不可恢复。',
    echo: [{ k: '知识项', v: title }, { k: '切片数', v: `${chunks}` }],
    confirmText: '删除',
    danger: true,
    onConfirm: async () => {
      setBusy('k' + kid);
      try {
        await api.delUserKnowledge(userId, kid); toast('已删除');
        if (openDoc === kid) { setOpenDoc(''); setDocDetail(null); }
        await loadCtx();
      } finally { setBusy(''); }
    },
  });
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
        <UsageQuotaBlock userId={userId} isOwner={isOwner} toast={toast} />

        {isOwner && <ImpersonateBlock userId={userId} userName={u.name} toast={toast} />}

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

        <ServiceBlock userId={userId} toast={toast} />

        {ctx && (
          <div className="blk">
            <div className="blk-h"><Icon name="insight" size={15} /><span className="t">个人档案</span><span className="badge">{MATURITY_LABEL[ctx.understanding.maturity] ?? ctx.understanding.maturity}</span></div>
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
                  <button className="mini-btn danger" disabled={busy === 'm' + m.id} onClick={() => delMem(m.id, m.text, m.agentKey)}>删除</button>
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
                  <button className="mini-btn danger" disabled={busy === 'k' + k.id} onClick={() => delKb(k.id, k.title || k.fileName || k.kind, k.chunkCount)}>删除</button>
                </div>
              ))}
              {!ctx.knowledge.length && <div className="blk-d">暂无知识库内容。</div>}
            </div>
          </div>
        )}
        <div style={{ height: 40 }} />
      </div>
      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
    </div>
  );
}

type OpsKind = 'reset' | 'adjustQuota' | 'credits' | 'extend' | 'grantPlan' | 'module';

function Fold({ icon, title, count, open, onToggle, children }: { icon: string; title: string; count: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="blk">
      <div className="blk-h" style={{ cursor: 'pointer' }} onClick={onToggle}>
        <Icon name={icon} size={15} /><span className="t">{title}</span>
        <span className="badge">{open ? '收起' : count}</span>
      </div>
      {open && children}
    </div>
  );
}

function UsageQuotaBlock({ userId, isOwner, toast }: { userId: string; isOwner: boolean; toast: (m: string) => void }) {
  const [data, setData] = useState<AdminUserUsage | null>(null);
  const [quotaDetail, setQuotaDetail] = useState<AdminUserQuotaView | null>(null);
  const [modal, setModal] = useState<OpsKind | null>(null);
  const [open, setOpen] = useState<'' | 'credits' | 'payments' | 'activations'>('');
  const [err, setErr] = useState('');
  const load = () => Promise.all([api.userUsage(userId, 30), api.userQuotaDetail(userId)])
    .then(([usage, detail]) => { setData(usage); setQuotaDetail(detail); setErr(''); })
    .catch((e) => setErr((e as Error).message || '用量加载失败'));
  useEffect(() => { load(); }, [userId]);
  // 额度/用量是客服排查的第一屏信息，取不到必须说出来——否则运营会以为这个用户「没有用量」。
  if (!data) {
    return (
      <div className="blk">
        <div className="blk-h"><Icon name="crown" size={15} /><span className="t">用量与额度</span></div>
        {err ? <ErrorState msg={err} onRetry={load} /> : <Skeleton kind="stats" />}
      </div>
    );
  }
  const { quota, plan, tokens } = data;
  const byDayMax = Math.max(1, ...tokens.byDay.map((d) => d.totalTokens));
  return (
    <>
      {/* 月度额度 */}
      <div className="blk">
        <div className="blk-h"><Icon name="crown" size={15} /><span className="t">月度产出额度</span>{quota?.periodKey && <span className="badge">本月 {quota.periodKey}</span>}</div>
        {quota === null ? (
          <div className="empty">未建额度账户</div>
        ) : quota.unlimited ? (
          <div className="usage-row">
            <div className="usage-h">
              <div className="usage-name">额度 <span className="tag">不限量</span></div>
              <div className="usage-num ok">已用 {fmtTokens(quota.used)}</div>
            </div>
            <div className="usage-meta">套餐 {plan.planName ?? '—'} · {planStatusText(plan)}</div>
          </div>
        ) : (
          <div className="usage-row">
            <div className="usage-h">
              <div className="usage-name">额度剩余</div>
              <div className={`usage-num ${quota.remaining > 0 ? 'ok' : ''}`}>剩 {fmtTokens(quota.remaining)}</div>
            </div>
            <div className="usage-meta">已用 {fmtTokens(quota.used)} / {fmtTokens(quota.limit)} · 套餐 {plan.planName ?? '—'} · {planStatusText(plan)}</div>
            {plan.subscription && <div className="usage-meta">自动续费：{plan.subscription.status === 'active' ? `已开启${plan.subscription.nextBillingAt ? ` · ${fmtTime(plan.subscription.nextBillingAt)} 发起续费` : ''}` : plan.subscription.status === 'pending' ? '等待微信签约结果' : plan.subscription.status === 'cancel_pending' ? '关闭中' : '续费失败，需用户重新开通'}</div>}
            <div className="meter"><i style={{ width: `${quota.limit > 0 ? Math.min(100, Math.max(2, Math.round((quota.used / quota.limit) * 100))) : 2}%` }} /></div>
          </div>
        )}
        {quotaDetail && quotaDetail.adjustments.filter((item) => !item.revokedAt).length > 0 && (
          <div className="mem-list">
            {quotaDetail.adjustments.filter((item) => !item.revokedAt).map((item) => (
              <div key={item.id} className="mem-card">
                <span className="mi"><Icon name="spark" size={16} /></span>
                <div className="mb"><div className="mt">临时调整 {item.delta > 0 ? '+' : ''}{fmtTokens(item.delta)}</div><div className="mm">{item.reason} · {item.expiresAt ? `${fmtTime(item.expiresAt)} 失效` : '本周期持续有效'}</div></div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 30 天 token / 成本 */}
      <div className="blk">
        <div className="blk-h"><Icon name="trend" size={15} /><span className="t">近 30 天用量</span><span className="badge">token / 成本</span></div>
        <div className="usage-summary">
          <div><b>{fmtTokens(tokens.totalTokens)}</b><span>总 Token</span></div>
          <div><b>{fmtCny(tokens.costMicros)}</b><span>成本</span></div>
          <div><b>{tokens.calls}</b><span>调用次数</span></div>
          <div><b>{fmtTokens(tokens.outputTokens)}</b><span>输出 Token</span></div>
        </div>
        {tokens.byDay.length > 0 && (
          <div className="spark">
            {tokens.byDay.map((d) => <i key={d.day} title={`${d.day} · ${fmtTokens(d.totalTokens)}`} style={{ height: `${Math.max(6, Math.round((d.totalTokens / byDayMax) * 100))}%` }} />)}
          </div>
        )}
        {tokens.byAgent.length > 0 && (
          <>
            <div className="usage-meta" style={{ marginTop: 12 }}>按顾问（前 3）</div>
            {tokens.byAgent.slice(0, 3).map((a) => (
              <div key={a.key} className="usage-row">
                <div className="usage-h"><div className="usage-name">{a.key}</div><div className="usage-num ok">{fmtCny(a.costMicros)}</div></div>
                <div className="usage-meta">{a.calls} 次 · {fmtTokens(a.totalTokens)} token</div>
              </div>
            ))}
          </>
        )}
        {tokens.byModel.length > 0 && (
          <>
            <div className="usage-meta" style={{ marginTop: 12 }}>按模型（前 3）</div>
            {tokens.byModel.slice(0, 3).map((m) => (
              <div key={m.key} className="usage-row">
                <div className="usage-h"><div className="usage-name">{m.key}</div><div className="usage-num ok">{fmtCny(m.costMicros)}</div></div>
                <div className="usage-meta">{m.calls} 次 · {fmtTokens(m.totalTokens)} token</div>
              </div>
            ))}
          </>
        )}
        {tokens.calls === 0 && <div className="usage-meta">近 30 天暂无 token 记录。</div>}
      </div>

      {/* 折叠：钻石流水 / 支付订单 / 开通归因 */}
      <Fold icon="crown" title="钻石流水" count={data.credits.length} open={open === 'credits'} onToggle={() => setOpen(open === 'credits' ? '' : 'credits')}>
        {data.credits.length === 0 ? <div className="empty">暂无钻石流水。</div> : (
          <div className="mem-list">
            {data.credits.map((c, i) => (
              <div key={i} className="mem-card">
                <span className="mi"><Icon name="crown" size={16} /></span>
                <div className="mb"><div className="mt">{c.reason || '—'}</div><div className="mm">余额 {c.balance} · {fmtTime(c.at)}</div></div>
                <div className={`usage-num ${c.delta >= 0 ? 'ok' : ''}`}>{c.delta >= 0 ? '+' : ''}{c.delta}</div>
              </div>
            ))}
          </div>
        )}
      </Fold>

      <Fold icon="doc" title="支付订单" count={data.payments.length} open={open === 'payments'} onToggle={() => setOpen(open === 'payments' ? '' : 'payments')}>
        {data.payments.length === 0 ? <div className="empty">暂无支付订单。</div> : (
          <div className="mem-list">
            {data.payments.map((p, i) => (
              <div key={i} className="mem-card">
                <span className="mi"><Icon name="doc" size={16} /></span>
                <div className="mb"><div className="mt">¥{fmtYuan(p.amount)}<span className="tag off">{p.status}</span></div><div className="mm">尾号 {p.orderNo}{p.attrSource ? ` · ${p.attrSource}` : ''} · {p.paidAt ? fmtTime(p.paidAt) : '未支付'}</div></div>
              </div>
            ))}
          </div>
        )}
      </Fold>

      <Fold icon="target" title="开通归因" count={data.activations.length} open={open === 'activations'} onToggle={() => setOpen(open === 'activations' ? '' : 'activations')}>
        {data.activations.length === 0 ? <div className="empty">暂无开通记录。</div> : (
          <div className="mem-list">
            {data.activations.map((a, i) => (
              <div key={i} className="mem-card">
                <span className="mi"><Icon name="spark" size={16} /></span>
                <div className="mb"><div className="mt">{a.itemKey}<span className="tag off">{a.itemType}</span></div><div className="mm">来源 {a.source} · {fmtTime(a.at)}</div></div>
              </div>
            ))}
          </div>
        )}
      </Fold>

      {/* 运营动作（owner-only）*/}
      {isOwner && (
        <div className="blk">
          <div className="blk-h"><Icon name="insight" size={15} /><span className="t">运营动作</span><span className="badge">仅超管</span></div>
          <div className="blk-d">额度、钻石、套餐有效期为资金敏感动作，操作会留审计（before/after）。</div>
          <div className="ops-actions">
            <button type="button" className="mini-btn" onClick={() => setModal('reset')}>恢复套餐标准</button>
            <button type="button" className="mini-btn" onClick={() => setModal('adjustQuota')}>临时调整额度</button>
            <button type="button" className="mini-btn primary" onClick={() => setModal('credits')}>补发钻石</button>
            <button type="button" className="mini-btn" onClick={() => setModal('extend')}>延长套餐</button>
            <button type="button" className="mini-btn" onClick={() => setModal('grantPlan')}>开通套餐</button>
            <button type="button" className="mini-btn" onClick={() => setModal('module')}>模块管理</button>
          </div>
        </div>
      )}

      {modal && <OpsActionModal kind={modal} userId={userId} plan={plan} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); }} toast={toast} />}
    </>
  );
}

// A1 运营动作确认弹窗：重置/调整额度、补发钻石（必填事由）、延长套餐。资金敏感 → 全部二次确认。
function OpsActionModal({ kind, userId, plan, onClose, onDone, toast }: {
  kind: OpsKind; userId: string; plan: AdminUserPlanStatus;
  onClose: () => void; onDone: () => void; toast: (m: string) => void;
}) {
  const [quota, setQuota] = useState(0);
  const [delta, setDelta] = useState(0);
  const [reason, setReason] = useState('');
  const [quotaExpiresAt, setQuotaExpiresAt] = useState('');
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [planList, setPlanList] = useState<{ id: string; name: string; price: number }[]>([]);
  const [grantPlanId, setGrantPlanId] = useState('');
  const [moduleKey, setModuleKey] = useState('');
  // 改档会缩短用户有效期时服务端回 409（带确切损失天数），这里存原文并要求二次确认后才带 force 重试。
  const [shortenWarn, setShortenWarn] = useState('');

  useEffect(() => {
    if (kind === 'grantPlan') api.plans().then((ps) => setPlanList(ps.map((p: { id: string; name: string; price: number }) => ({ id: p.id, name: p.name, price: p.price })))).catch((e) => setErr((e as Error).message || '套餐列表加载失败，无法选择'));
  }, [kind]);

  const meta: Record<OpsKind, { title: string; desc: string }> = {
    reset: { title: '恢复套餐标准额度', desc: `撤销该用户当前有效的临时调整，按套餐（${plan.planName ?? '无套餐'}）标准恢复；已用量不会清零。` },
    adjustQuota: { title: '临时调整月度额度', desc: '填写增量，正数加额、负数扣减；不会覆盖已用量。可设置自动失效时间，所有操作留审计。' },
    credits: { title: '补发 / 扣减钻石', desc: '正数补发、负数扣减；扣减不得使余额为负。事由必填，写入流水（前缀 admin:）。' },
    extend: { title: '延长套餐有效期', desc: '在当前到期日（或今日，取较晚者）基础上顺延天数（1-366）。仅推有效期，不动快照与钱包。' },
    grantPlan: { title: '开通套餐（运营发放）', desc: `不经支付直接发放套餐权益（含无套餐用户）。当前：${plan.planName ?? '无套餐'}。发放走与支付同一口径（有效期/钻石/额度），审计记 admin_grant。升级/同档会自动结转剩余天数；会缩短有效期的改档需二次确认。` },
    module: { title: '模块管理（发放 / 收回）', desc: '按 moduleKey 直接发放（source=admin，与购买区分）或收回模块权益。key 可在「能力模块」或 SKU 目录查看。' },
  };
  const cfg = meta[kind];

  /** 开通套餐（force=true 即运营已确认承担时长损失）。carriedDays>0 说明剩余时长被结转，回显给运营。 */
  const doGrantPlan = async (force: boolean) => {
    const r = await api.grantUserPlan(userId, grantPlanId, force);
    toast(`已开通「${r.planName}」${r.carriedDays > 0 ? ` · 结转 ${r.carriedDays} 天` : ''}${r.grantedCredits > 0 ? ` · 发放 ${r.grantedCredits} 钻石` : ''}`);
  };

  const submit = async () => {
    setErr('');
    try {
      if (kind === 'reset') {
        setBusy(true);
        await api.restoreUserQuota(userId);
        toast('已恢复套餐标准，保留当前已用量');
      } else if (kind === 'adjustQuota') {
        if (!Number.isInteger(quota) || quota === 0) { setErr('调整量需为非 0 整数'); return; }
        const r = reason.trim();
        if (!r) { setErr('请填写调整原因'); return; }
        if (r.length > 100) { setErr('调整原因不超过 100 字'); return; }
        const expiresAt = quotaExpiresAt ? new Date(quotaExpiresAt).toISOString() : null;
        setBusy(true);
        await api.adjustUserQuota(userId, { delta: quota, reason: r, expiresAt });
        toast(`已临时${quota > 0 ? '增加' : '扣减'} ${Math.abs(quota)} 额度`);
      } else if (kind === 'credits') {
        if (!Number.isInteger(delta) || delta === 0) { setErr('增减数需为非 0 整数'); return; }
        const r = reason.trim();
        if (!r) { setErr('请填写事由'); return; }
        if (r.length > 50) { setErr('事由不超过 50 字'); return; }
        setBusy(true);
        await api.adjustUserCredits(userId, { delta, reason: r });
        toast(`已${delta > 0 ? '补发' : '扣减'} ${Math.abs(delta)} 钻石`);
      } else if (kind === 'extend') {
        if (!plan.planName) { setErr('该用户无套餐，无法延长；可用「开通套餐」直接发放'); return; }
        if (!Number.isInteger(days) || days < 1 || days > 366) { setErr('天数需为 1-366 的整数'); return; }
        setBusy(true);
        await api.extendUserPlan(userId, { days });
        toast(`套餐已延长 ${days} 天`);
      } else if (kind === 'grantPlan') {
        if (!grantPlanId) { setErr('请选择要开通的套餐'); return; }
        setBusy(true);
        try {
          await doGrantPlan(false);
        } catch (e) {
          // 409 PLAN_CHANGE_SHORTENS：会让用户损失剩余时长 → 原样透出服务端文案（含确切天数与两个套餐名），
          // 由运营看见后再点「确认强制改档」。绝不吞成「操作失败」，也不自动补 force。
          if ((e as { code?: string }).code === 'PLAN_CHANGE_SHORTENS') {
            setBusy(false);
            setShortenWarn((e as Error).message || '该改档会缩短用户有效期');
            return;
          }
          throw e;
        }
      } else {
        const key = moduleKey.trim();
        if (!key) { setErr('请填写 moduleKey'); return; }
        setBusy(true);
        await api.grantUserModule(userId, key);
        toast(`已发放模块 ${key}`);
      }
      onDone();
    } catch (e) {
      setBusy(false);
      setErr((e as Error)?.message || '操作失败');
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="al-card" style={{ width: 300, margin: 0 }} onClick={(e) => e.stopPropagation()}>
        <div className="al-label">{cfg.title}</div>
        <div className="blk-d">{cfg.desc}</div>
        {kind === 'adjustQuota' && (
          <>
            <NumInput className="al-input" value={quota} onChange={setQuota} placeholder="增量（正数增加 / 负数扣减）" />
            <div style={{ marginTop: 10 }}><input className="al-input" value={reason} maxLength={100} placeholder="调整原因（必填）" onChange={(e) => setReason(e.target.value)} /></div>
            <div style={{ marginTop: 10 }}><input className="al-input" type="datetime-local" value={quotaExpiresAt} onChange={(e) => setQuotaExpiresAt(e.target.value)} /></div>
            <div className="al-note">失效时间可留空；留空表示本周期持续有效。</div>
          </>
        )}
        {kind === 'extend' && <NumInput className="al-input" min={1} max={366} value={days} onChange={setDays} />}
        {kind === 'grantPlan' && (
          <>
            {/* 换选套餐必须清掉上一次的强制确认，否则「确认强制改档」会打到另一个套餐上。 */}
            <select className="al-input" value={grantPlanId} onChange={(e) => { setShortenWarn(''); setGrantPlanId(e.target.value); }}>
              <option value="">选择套餐…</option>
              {planList.map((p) => <option key={p.id} value={p.id}>{p.name}{p.price > 0 ? ` · ¥${fmtYuan(p.price)}` : p.price < 0 ? ' · 面议' : ' · 免费'}</option>)}
            </select>
            {shortenWarn && (
              <>
                <div className="al-err"><Icon name="alert" size={13} /> {shortenWarn}</div>
                <button type="button" className="al-btn" disabled={busy} onClick={async () => {
                  setErr(''); setBusy(true);
                  try { await doGrantPlan(true); onDone(); }
                  catch (e) { setBusy(false); setErr((e as Error)?.message || '强制改档失败'); }
                }}><Icon name="alert" size={15} /> {busy ? '提交中…' : '确认强制改档（承担上述时长损失）'}</button>
              </>
            )}
          </>
        )}
        {kind === 'module' && (
          <>
            <input className="al-input" value={moduleKey} placeholder="moduleKey（如 deep-contradiction）" onChange={(e) => setModuleKey(e.target.value)} />
            <div className="al-note" style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={async () => {
              const key = moduleKey.trim();
              if (!key) { setErr('请填写 moduleKey'); return; }
              try { await api.revokeUserModule(userId, key); toast(`已收回模块 ${key}`); onDone(); }
              catch (e) { setErr((e as Error).message || '收回失败'); }
            }}>收回该模块（停用）</div>
          </>
        )}
        {kind === 'credits' && (
          <>
            <NumInput className="al-input" value={delta} onChange={setDelta} placeholder="增减数（正补发 / 负扣减）" />
            <div style={{ marginTop: 10 }}>
              <input className="al-input" value={reason} maxLength={50} placeholder="事由（必填，≤50 字）" onChange={(e) => setReason(e.target.value)} />
            </div>
          </>
        )}
        {err && <div className="al-err"><Icon name="alert" size={13} /> {err}</div>}
        <button type="button" className="al-btn" onClick={submit} disabled={busy}><Icon name="check" size={15} /> {busy ? '提交中…' : '确认'}</button>
        <div className="al-note" style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={onClose}>取消</div>
      </div>
    </div>
  );
}

// 社群服务分配（用户详情内）：班主任 / 班级 / 群二维码 / 陪跑任务进度 / 备注。空 → 待分配。
function ServiceBlock({ userId, toast }: { userId: string; toast: (m: string) => void }) {
  const blank: ServiceAssignmentView = { teacherName: '', teacherWechat: '', className: '', groupQrUrl: '', taskDone: 0, taskTotal: 0, note: '' };
  const [assigned, setAssigned] = useState<boolean | null>(null);
  const [form, setForm] = useState<ServiceAssignmentView>(blank);
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const load = () => api.userService(userId)
    .then(({ service }) => { setAssigned(!!service); setForm(service ?? blank); setLoadErr(''); })
    .catch((e: unknown) => { setAssigned(null); setLoadErr((e as Error)?.message || '社群服务加载失败'); });
  useEffect(() => { load(); }, [userId]);
  const set = (p: Partial<ServiceAssignmentView>) => setForm((f) => ({ ...f, ...p }));
  const save = async () => {
    setBusy(true);
    try {
      const { service } = await api.setUserService(userId, {
        teacherName: form.teacherName.trim(), teacherWechat: form.teacherWechat.trim(),
        className: form.className.trim(), groupQrUrl: form.groupQrUrl.trim(),
        taskDone: form.taskDone, taskTotal: form.taskTotal, note: form.note.trim(),
      });
      setAssigned(!!service); setForm(service ?? blank); toast('社群服务已保存');
    } catch (e) { toast((e as Error)?.message || '保存失败'); }
    setBusy(false);
  };
  return (
    <div className="blk">
      <div className="blk-h"><Icon name="chat" size={15} /><span className="t">社群服务</span><span className="badge">{assigned == null ? '…' : assigned ? '已分配' : '待分配'}</span></div>
      <div className="blk-d">分配班主任 / 班级 / 群二维码与陪跑任务进度，前台「我的服务」据此展示。留空即视为未填。</div>
      {loadErr && <ErrorState msg={loadErr} onRetry={load} stale />}
      <div className="ai-field"><div className="ai-fl">班主任姓名</div><input className="ai-input" value={form.teacherName} onChange={(e) => set({ teacherName: e.target.value })} placeholder="如 张老师" /></div>
      <div className="ai-field"><div className="ai-fl">班主任微信</div><input className="ai-input" value={form.teacherWechat} onChange={(e) => set({ teacherWechat: e.target.value })} placeholder="微信号" /></div>
      <div className="ai-field"><div className="ai-fl">班级</div><input className="ai-input" value={form.className} onChange={(e) => set({ className: e.target.value })} placeholder="如 2026 春季 3 班" /></div>
      <div className="ai-field"><div className="ai-fl">群二维码链接</div><input className="ai-input" value={form.groupQrUrl} onChange={(e) => set({ groupQrUrl: e.target.value })} placeholder="https://…（群二维码图片地址）" /></div>
      <div className="ai-field"><div className="ai-fl">已完成任务</div><NumInput className="ai-input" min={0} value={form.taskDone} onChange={(taskDone) => set({ taskDone })} /></div>
      <div className="ai-field"><div className="ai-fl">任务总数</div><NumInput className="ai-input" min={0} value={form.taskTotal} onChange={(taskTotal) => set({ taskTotal })} /></div>
      <div className="ai-field"><div className="ai-fl">备注</div><textarea className="ta" rows={2} value={form.note} onChange={(e) => set({ note: e.target.value })} /></div>
      <div className="ai-actions">
        <button className="ai-btn primary" onClick={save} disabled={busy}><Icon name="check" size={14} /> {busy ? '保存中…' : '保存服务分配'}</button>
      </div>
    </div>
  );
}
