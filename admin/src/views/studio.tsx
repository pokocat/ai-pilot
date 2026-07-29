// 智能体：顾问上下架/调教 · 技能库 · 知识库 · 检索调试。
import { useEffect, useState, type MouseEvent } from 'react';
import Icon from '../Icon';
import NumInput from '../NumInput';
import { api, type AdminAgent, type AgentBilling, type AdminUserItem, type SkillToolDef, type SkillToolUpsert, type SkillToolMeta, type AdminKnowledgeView, type AdminRetrievalDebug } from '../api';
import { PageHead, ViewState, ErrorState, ConfirmDialog, type ConfirmSpec } from '../components';
import { useResource } from '../useResource';
import { billingTag } from '../format';

export function AgentsView({ onOpen, toast }: { onOpen: (k: string) => void; toast: (m: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ key: '', name: '', role: '', billing: 'unlock' as AgentBilling, price: 10 });
  const res = useResource(api.agents, []);
  const list = res.data ?? [];
  const load = async () => res.reload();
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
      <PageHead k="agent" res={res} badge={`${list.filter((a) => a.enabled).length}/${list.length} 上架`} />
      <div className="pad">
        {res.error && list.length === 0 && <ErrorState msg={res.error} onRetry={res.reload} />}
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
        {!res.initial && list.length === 0 && !res.error && <div className="empty">还没有智能体。点上方「新增智能体」创建一个。</div>}
        {list.map((a) => (
          <div key={a.key} className="crd agent-card" onClick={() => onOpen(a.key)}>
            <div className="crd-row">
              <span className="crd-ic"><Icon name={a.icon} size={18} /></span>
              <div className="crd-b">
                <div className="ct">{a.name} {billingTag(a.billing, a.price)} {!a.enabled && <span className="tag off">停用</span>} {a.draftDirty && <span className="tag warn">待发布</span>}</div>
                <div className="cs">{a.publishedVersion ? `线上 v${a.publishedVersion}` : '未发布'} · 倍率 ×{a.billingRatio ?? 1} · {a.deliverableKey ? `产出 · ${a.deliverableKey}` : a.role} · 已开通 {a.ownerCount ?? 0}</div>
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

type SkillForm = { id?: string; key: string; name: string; description: string; httpMethod: 'GET' | 'POST'; httpUrl: string; argsLocation: 'body' | 'query'; enabled: boolean; headersText: string; schemaText: string };

const BLANK_SKILL: SkillForm = { key: '', name: '', description: '', httpMethod: 'POST', httpUrl: '', argsLocation: 'body', enabled: true, headersText: '', schemaText: '{\n  "type": "object",\n  "properties": {\n    "query": { "type": "string", "description": "参数说明" }\n  },\n  "required": ["query"]\n}' };

const KIND_LABEL: Record<string, string> = { tool: '模型工具', output: '产出处理' };

export function SkillLibraryView({ toast }: { toast: (m: string) => void }) {
  const [form, setForm] = useState<SkillForm | null>(null);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const custom = useResource(api.customSkillTools, []);
  const builtin = useResource(api.skillTools, []);
  const list = custom.data ?? [];
  const meta = builtin.data ?? [];
  const load = () => { custom.reload(); builtin.reload(); };
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

  const del = (d: SkillToolDef) => setConfirmSpec({
    title: '删除自定义技能',
    desc: '删除后勾选了该工具的顾问将不再拥有此能力，模型也不会再调用它。',
    echo: [{ k: '技能', v: d.name }, { k: 'key', v: d.key }, { k: '接口', v: `${d.httpMethod} ${d.httpUrl}` }],
    confirmText: '删除',
    danger: true,
    onConfirm: async () => { await api.delSkillTool(d.id); toast('已删除'); load(); },
  });

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
      <PageHead k="skilllib" res={custom} badge={`内置 ${nativeSkills.length} · 自建 ${list.length}`} />
      <div className="pad">
        {custom.error && <ErrorState msg={custom.error} onRetry={custom.reload} />}
        <div className="sec-h"><span className="t">内置技能</span><span className="s">代码提供 · 只读</span></div>
        {builtin.initial && <div className="skel"><div className="skel-b skel-r" /><div className="skel-b skel-r" /></div>}
        {!builtin.initial && nativeSkills.length === 0 && <div className="empty">没有内置技能。</div>}
        {nativeSkills.map((m) => (
          <div key={m.name} className="mem-card">
            <span className="mi"><Icon name={m.kind === 'output' ? 'layers' : 'insight'} size={16} /></span>
            <div className="mb">
              <div className="mt">{m.name}<span className="tag">{KIND_LABEL[m.kind] ?? m.kind}</span><span className="tag off">内置</span></div>
              <div className="mm">{m.description}</div>
            </div>
          </div>
        ))}
        <div className="sec-h"><span className="t">自定义 HTTP 工具</span><span className="s">运营自建</span></div>
        <button type="button" className="add-btn full" onClick={() => setForm({ ...BLANK_SKILL })}><Icon name="spark" size={15} /> 新增技能</button>
        {!custom.initial && list.length === 0 && <div className="empty">还没有自定义技能。点「新增技能」定义一个 HTTP 工具。</div>}
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
      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
    </>
  );
}

// 知识库：看用户知识库被切片/嵌入加工的状态 + 维度体检 + 一键重嵌（换嵌入模型后存量会维度不匹配、向量召回静默失效）。
export function KnowledgeView({ toast }: { toast: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const res = useResource(api.knowledge, []);
  return (
    <>
      <PageHead k="knowledge" res={res} badge={res.data ? `${res.data.totals.items} 项` : undefined} />
      <ViewState res={res} skeleton="stats">
        {(data: AdminKnowledgeView) => {
          const { totals } = data;
          const stale = totals.staleChunks > 0 || totals.staleMemories > 0;
          const reembed = () => setConfirmSpec({
            title: '重新嵌入存量',
            desc: '用当前嵌入模型重嵌全部知识库切片与长期记忆。数据量大时会跑一段时间，期间召回质量可能波动。',
            echo: [
              { k: '切片', v: `${totals.chunks}` },
              { k: '长期记忆', v: `${totals.memories}` },
              { k: '当前模型', v: data.embedRemote ? `远程 ${data.embedModel}` : '本地确定性嵌入' },
            ],
            confirmText: '开始重嵌',
            onConfirm: async () => {
              setBusy(true);
              try {
                const r = await api.reembedKnowledge();
                toast(`已重嵌 ${r.chunks} 切片 / ${r.memories} 记忆 · ${r.dim} 维`);
                res.reload();
              } finally { setBusy(false); }
            },
          });
          return (
            <div className="pad">
              <div className={`ai-test ${stale ? 'err' : 'ok'}`}>
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
                    <div className="mt">{it.title}<span className="tag off">{it.kind}</span>{it.stale && <span className="tag warn">旧维度</span>}</div>
                    <div className="mm">{it.tenantName ?? it.tenantId.slice(0, 8)} · {it.chunks} 切片 · 维度 {it.dims.join('/') || '—'}</div>
                  </div>
                </div>
              ))}
            </div>
          );
        }}
      </ViewState>
      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
    </>
  );
}

export function RetrievalDebugView() {
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [agents, setAgents] = useState<AdminAgent[]>([]);
  const [userId, setUserId] = useState('');
  const [agentKey, setAgentKey] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [res, setRes] = useState<AdminRetrievalDebug | null>(null);
  const [loadErr, setLoadErr] = useState('');
  useEffect(() => {
    api.users().then((u) => { setUsers(u); if (u[0]) setUserId(u[0].id); }).catch((e) => setLoadErr((e as Error).message || '用户列表加载失败'));
    api.agents().then((a) => { setAgents(a); const s = a.find((x) => x.key === 'strat') ?? a[0]; if (s) setAgentKey(s.key); }).catch((e) => setLoadErr((e as Error).message || '顾问列表加载失败'));
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
      <PageHead k="retrieval" />
      <div className="pad">
        {loadErr && <ErrorState msg={loadErr} />}
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

            <div className="sec-h" style={{ marginTop: 6 }}><span className="t">最终注入 · 个人档案</span></div>
            {res.understanding.length === 0
              ? <div className="empty">暂无个人档案行。</div>
              : res.understanding.map((u, i) => <div key={i} className="usage-row"><div className="usage-meta">{u}</div></div>)}
          </>
        )}
      </div>
    </>
  );
}