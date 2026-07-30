// 商品：套餐 / 单次付费 SKU / 生态工具 —— 「卖什么」。

import { useState } from 'react';
import Icon from '../Icon';
import NumInput from '../NumInput';
import { api, type Plan, type AdminSku, type AdminEcoTool } from '../api';
import { PageHead, ConfirmDialog, type ConfirmSpec } from '../components';
import { useResource } from '../useResource';

export function PlansView({ toast }: { toast: (m: string) => void }) {

  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', priceYuan: 0, creditsPerMonth: 0, tokenQuotaPerMonth: 0, agentCount: 0, features: '' });
  const res = useResource(api.plans, []);
  const list = res.data ?? [];
  const load = () => res.reload();
  const priceLabel = (p: Plan) => p.price < 0 ? '面议' : p.price === 0 ? '¥0' : `¥${(p.price / 100).toLocaleString()}${p.period === 'year' ? '/年' : '/月'}`;
  const startEdit = (p: Plan) => {
    setEditId(p.id);
    setForm({ name: p.name, priceYuan: p.price < 0 ? -1 : p.price / 100, creditsPerMonth: p.creditsPerMonth, tokenQuotaPerMonth: p.tokenQuotaPerMonth, agentCount: p.agentCount, features: p.featuresJson.join('\n') });
  };
  const save = async (id: string) => {
    // 套餐改价是 requireSuper：非超管会拿到 403「需要 owner 权限」，catch 必须原文透出，
    // 不能盖成「保存失败」让运营去查网络（403 不再踢登录页，见 api.ts）。
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
    } catch (e) { toast((e as Error)?.message || '保存失败'); }
  };
  return (
    <>
      <PageHead k="plan" res={res} badge={`${list.length} 档`} />
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

// 单次付费 SKU：改价 / 启停 / 展示（key、kind、解锁模块走代码目录，只读）——镜像 PlansView 的行内编辑。
const SKU_KIND_LABEL: Record<string, string> = { module: '模块解锁', service: '社群服务', storage: '存储扩容' };

export function SkusView({ toast }: { toast: (m: string) => void }) {

  const [editKey, setEditKey] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', desc: '', priceYuan: 0, enabled: true, sort: 0 });
  const res = useResource(api.adminSkus, []);
  const list = res.data ?? [];
  const load = () => res.reload();
  const startEdit = (s: AdminSku) => {
    setEditKey(s.key);
    setForm({ name: s.name, desc: s.desc, priceYuan: s.priceFen / 100, enabled: s.enabled, sort: s.sort });
  };
  const toggleEnabled = async (s: AdminSku) => {
    try { await api.updateSku(s.key, { enabled: !s.enabled }); await load(); toast(s.enabled ? '已下架' : '已上架'); }
    catch (e) { toast((e as Error)?.message || '操作失败'); } // 同 requireSuper：403 文案要原样透出
  };
  const save = async (key: string) => {
    try {
      await api.updateSku(key, {
        name: form.name.trim(),
        desc: form.desc.trim(),
        priceFen: Math.max(0, Math.round(form.priceYuan * 100)),
        enabled: form.enabled,
        sort: form.sort,
      });
      setEditKey(null); await load(); toast('SKU 已更新');
    } catch (e) { toast((e as Error)?.message || '保存失败'); }
  };
  return (
    <>
      <PageHead k="sku" res={res} badge={`${list.filter((x) => x.enabled).length}/${list.length} 在售`} />
      <div className="pad">
        {list.length === 0 && <div className="empty">暂无 SKU。</div>}
        {list.map((s) => editKey === s.key ? (
          <div key={s.id} className="crd new-agent">
            <div className="ai-field"><div className="ai-fl">标识 key · {SKU_KIND_LABEL[s.kind] ?? s.kind}（代码目录，不可改）</div><input className="ai-input" value={s.key} disabled /></div>
            <div className="ai-field"><div className="ai-fl">名称</div><input className="ai-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="ai-field"><div className="ai-fl">描述</div><textarea className="ta" rows={2} value={form.desc} onChange={(e) => setForm({ ...form, desc: e.target.value })} /></div>
            <div className="ai-field"><div className="ai-fl">价格（元）</div><NumInput className="ai-input" min={0} step={0.01} value={form.priceYuan} onChange={(priceYuan) => setForm({ ...form, priceYuan })} /></div>
            <div className="ai-field"><div className="ai-fl">排序（小在前）</div><NumInput className="ai-input" value={form.sort} onChange={(sort) => setForm({ ...form, sort })} /></div>
            {s.grantsModuleKey && <div className="ai-field"><div className="ai-fl">解锁模块（代码目录，不可改）</div><input className="ai-input" value={s.grantsModuleKey} disabled /></div>}
            <div className="cfg"><div className="cfg-row"><div className="cb"><div className="ct">上架启用</div><div className="cs">关闭后前台不展示、不可购买</div></div><div className={`sw ${form.enabled ? 'on' : ''}`} onClick={() => setForm({ ...form, enabled: !form.enabled })}><i /></div></div></div>
            <div className="ai-actions">
              <button className="ai-btn ghost" onClick={() => setEditKey(null)}>取消</button>
              <button className="ai-btn primary" onClick={() => save(s.key)}><Icon name="check" size={14} /> 保存</button>
            </div>
          </div>
        ) : (
          <div key={s.id} className="crd" onClick={() => startEdit(s)}>
            <div className="crd-row">
              <span className="crd-ic"><Icon name="crown" size={18} /></span>
              <div className="crd-b">
                <div className="ct">{s.name} <span className="tag off">{SKU_KIND_LABEL[s.kind] ?? s.kind}</span>{!s.enabled && <span className="tag off">停用</span>}</div>
                <div className="cs">{s.key}{s.grantsModuleKey ? ` · 解锁 ${s.grantsModuleKey}` : ''}{s.desc ? ` · ${s.desc}` : ''}</div>
              </div>
              <span className="user-balance">¥{(s.priceFen / 100).toLocaleString()}</span>
              <div className={`sw ${s.enabled ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); toggleEnabled(s); }}><i /></div>
              <span className="edit"><Icon name="pen" size={15} /></span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// D-3-7：生态工具注册表 CRUD（enabled 控制是否可开方；appId 空则不可启用——前端无跳转目标）。
type EcoForm = { id: string; name: string; desc: string; appId: string; path: string; enabled: boolean; sort: number };

const ECO_BLANK: EcoForm = { id: '', name: '', desc: '', appId: '', path: '', enabled: false, sort: 0 };

export function EcoToolsView({ toast }: { toast: (m: string) => void }) {

  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<EcoForm>(ECO_BLANK);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const res = useResource(api.ecoTools, []);
  const list = res.data ?? [];
  const load = () => res.reload();
  const set = (p: Partial<EcoForm>) => setForm((f) => ({ ...f, ...p }));
  const create = async () => {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(form.id)) return toast('toolKey 需小写字母开头（可含数字、连字符）');
    if (!form.name.trim()) return toast('请填写名称');
    if (form.enabled && !form.appId.trim()) return toast('启用前需先填目标小程序 appId');
    try {
      await api.createEcoTool({ id: form.id, name: form.name.trim(), desc: form.desc.trim(), appId: form.appId.trim(), path: form.path.trim(), enabled: form.enabled, sort: form.sort });
      setAdding(false); setForm(ECO_BLANK); await load(); toast('已新增生态工具');
    } catch (e) { toast((e as Error)?.message || '新增失败（toolKey 可能已存在）'); }
  };
  const startEdit = (t: AdminEcoTool) => { setAdding(false); setEditId(t.id); setForm({ id: t.id, name: t.name, desc: t.desc, appId: t.appId, path: t.path, enabled: t.enabled, sort: t.sort }); };
  const save = async (id: string) => {
    if (!form.name.trim()) return toast('请填写名称');
    if (form.enabled && !form.appId.trim()) return toast('启用前需先填目标小程序 appId');
    try {
      await api.updateEcoTool(id, { name: form.name.trim(), desc: form.desc.trim(), appId: form.appId.trim(), path: form.path.trim(), enabled: form.enabled, sort: form.sort });
      setEditId(null); await load(); toast('生态工具已更新');
    } catch (e) { toast((e as Error)?.message || '保存失败'); }
  };
  const toggleEnabled = async (t: AdminEcoTool) => {
    if (!t.enabled && !t.appId.trim()) return toast('启用前需先填 appId（点开编辑补上）');
    try { await api.updateEcoTool(t.id, { enabled: !t.enabled }); await load(); toast(t.enabled ? '已停用（不再可开方）' : '已启用（可开方）'); }
    catch (e) { toast((e as Error)?.message || '操作失败'); }
  };
  const remove = (t: AdminEcoTool) => setConfirmSpec({
    title: '删除生态工具',
    desc: '已开出的处方不受影响，但此后无法再用它开新方。',
    echo: [{ k: '工具', v: t.name }, { k: 'toolKey', v: t.id }],
    confirmText: '删除',
    danger: true,
    onConfirm: async () => { await api.deleteEcoTool(t.id); await load(); toast('已删除'); },
  });
  return (
    <>
      <PageHead k="eco" res={res} badge={`${list.filter((x) => x.enabled).length}/${list.length} 启用`} />
      <div className="pad">
        {!adding ? (
          <button className="add-btn full" onClick={() => { setEditId(null); setForm(ECO_BLANK); setAdding(true); }}><Icon name="spark" size={15} /> 新增生态工具</button>
        ) : (
          <div className="crd new-agent">
            <div className="ai-field"><div className="ai-fl">toolKey（唯一，小写，开方时 LLM 引用）</div><input className="ai-input" value={form.id} onChange={(e) => set({ id: e.target.value })} placeholder="如 digital-human" /></div>
            <div className="ai-field"><div className="ai-fl">名称</div><input className="ai-input" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="如 数字人代播" /></div>
            <div className="ai-field"><div className="ai-fl">开方场景描述（供军师判断何时开方）</div><textarea className="ta" rows={2} value={form.desc} onChange={(e) => set({ desc: e.target.value })} placeholder="一句话说清这个工具帮客户解决什么" /></div>
            <div className="ai-field"><div className="ai-fl">目标小程序 appId（启用必填）</div><input className="ai-input" value={form.appId} onChange={(e) => set({ appId: e.target.value })} placeholder="wx… · 须与本小程序同一开放平台主体关联" /></div>
            <div className="ai-field"><div className="ai-fl">目标页面 path（可选）</div><input className="ai-input" value={form.path} onChange={(e) => set({ path: e.target.value })} placeholder="pages/index/index" /></div>
            <div className="ai-field"><div className="ai-fl">排序（小在前）</div><NumInput className="ai-input" value={form.sort} onChange={(sort) => set({ sort })} /></div>
            <div className="cfg"><div className="cfg-row"><div className="cb"><div className="ct">启用（可开方）</div><div className="cs">关闭后军师不再向客户开这个方</div></div><div className={`sw ${form.enabled ? 'on' : ''}`} onClick={() => set({ enabled: !form.enabled })}><i /></div></div></div>
            <div className="ai-actions">
              <button className="ai-btn ghost" onClick={() => { setAdding(false); setForm(ECO_BLANK); }}>取消</button>
              <button className="ai-btn primary" onClick={create}><Icon name="check" size={14} /> 创建</button>
            </div>
          </div>
        )}
        {list.length === 0 && !adding && <div className="empty">暂无生态工具。数字人 appId 由运营录入后启用。</div>}
        {list.map((t) => editId === t.id ? (
          <div key={t.id} className="crd new-agent">
            <div className="ai-field"><div className="ai-fl">toolKey（不可改）</div><input className="ai-input" value={t.id} disabled /></div>
            <div className="ai-field"><div className="ai-fl">名称</div><input className="ai-input" value={form.name} onChange={(e) => set({ name: e.target.value })} /></div>
            <div className="ai-field"><div className="ai-fl">开方场景描述</div><textarea className="ta" rows={2} value={form.desc} onChange={(e) => set({ desc: e.target.value })} /></div>
            <div className="ai-field"><div className="ai-fl">目标小程序 appId（启用必填）</div><input className="ai-input" value={form.appId} onChange={(e) => set({ appId: e.target.value })} /></div>
            <div className="ai-field"><div className="ai-fl">目标页面 path（可选）</div><input className="ai-input" value={form.path} onChange={(e) => set({ path: e.target.value })} /></div>
            <div className="ai-field"><div className="ai-fl">排序（小在前）</div><NumInput className="ai-input" value={form.sort} onChange={(sort) => set({ sort })} /></div>
            <div className="cfg"><div className="cfg-row"><div className="cb"><div className="ct">启用（可开方）</div><div className="cs">关闭后军师不再向客户开这个方</div></div><div className={`sw ${form.enabled ? 'on' : ''}`} onClick={() => set({ enabled: !form.enabled })}><i /></div></div></div>
            <div className="ai-actions">
              <button className="ai-btn ghost" onClick={() => setEditId(null)}>取消</button>
              <button className="ai-btn ghost" onClick={() => remove(t)}><Icon name="alert" size={14} /> 删除</button>
              <button className="ai-btn primary" onClick={() => save(t.id)}><Icon name="check" size={14} /> 保存</button>
            </div>
          </div>
        ) : (
          <div key={t.id} className="crd" onClick={() => startEdit(t)}>
            <div className="crd-row">
              <span className="crd-ic"><Icon name="spark" size={18} /></span>
              <div className="crd-b">
                <div className="ct">{t.name} <span className="tag off">生态</span>{!t.enabled && <span className="tag off">停用</span>}{t.enabled && !t.appId && <span className="tag warn">缺 appId</span>}</div>
                <div className="cs">{t.id}{t.appId ? ` · ${t.appId}` : ' · 未填 appId'}{t.desc ? ` · ${t.desc}` : ''}</div>
              </div>
              <div className={`sw ${t.enabled ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); toggleEnabled(t); }}><i /></div>
              <span className="edit"><Icon name="pen" size={15} /></span>
            </div>
          </div>
        ))}
      </div>
      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
    </>
  );
}
