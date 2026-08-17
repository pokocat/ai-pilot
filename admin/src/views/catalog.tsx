// 商品：套餐 / 单次付费 SKU / 生态工具 —— 「卖什么」。

import { useState } from 'react';
import Icon from '../Icon';
import NumInput from '../NumInput';
import { api, type AdminPlan, type AdminSku, type AdminEcoTool } from '../api';
import { PageHead, ViewState, ConfirmDialog, Switch, type ConfirmSpec } from '../components';
import { useResource } from '../useResource';

// 套餐目录：**线上套餐的唯一维护入口**。2026-08-01 起代码侧不再有 syncPlans 之类的同步脚本
//（它按 name 全字段 upsert，运营改过价之后一跑就把线上价打回代码常量），server 的 seedConfig
// 只剩本地/测试夹具。所以这里必须能建档、改档、停售，否则全新部署一个套餐都没有、
// 而无套餐用户被 planGate 全局禁写 → 付费转化路径直接断。
const PLAN_BLANK = {
  name: '', priceYuan: 0, period: 'month' as 'month' | 'year',
  planFamilyKey: '', tierRank: 0, usageLevel: 'custom' as 'standard' | '5x' | '20x' | 'custom', usageLabel: '扩展用量',
  usageNormalPercent: 50, usageNearPercent: 80,
  creditsPerMonth: 0, tokenQuotaPerMonth: 0, agentCount: 0, features: '', highlighted: false, hidden: false, sort: 0,
  autoRenewEnabled: false, wechatContractPlanId: '',
  // 优惠：挂牌价（priceYuan）之外的「实际价 + 生效时间」。promoYuan 留空 = 不做优惠、按挂牌价卖。
  promoYuan: '', promoStartsAt: '', promoEndsAt: '', promoLabel: '',
};

// datetime-local 用**本机时区**的 'YYYY-MM-DDTHH:mm'，库里存 UTC；两头各转一次，
// 运营填的「9 月 1 日 0 点」就是自己时区的 0 点，不会因为直接塞 ISO 串而整体偏 8 小时。
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(value: string): string | null {
  if (!value.trim()) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

export function PlansView({ toast }: { toast: (m: string) => void }) {

  const [editId, setEditId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(PLAN_BLANK);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const res = useResource(api.plans, []);
  const list = res.data ?? [];
  const load = () => res.reload();
  const set = (patch: Partial<typeof PLAN_BLANK>) => setForm((f) => ({ ...f, ...patch }));
  const yuan = (fen: number) => `¥${(fen / 100).toLocaleString()}`;
  // 列表展示的是**用户此刻实际看到的价**（effectivePrice），不是挂牌价——运营核价时要的就是这个。
  const priceLabel = (p: AdminPlan) => p.price < 0 ? '面议' : p.effectivePrice === 0 ? '¥0' : `${yuan(p.effectivePrice)}${p.period === 'year' ? '/年' : '/月'}`;
  const startEdit = (p: AdminPlan) => {
    setAdding(false);
    setEditId(p.id);
    setForm({
      promoYuan: p.promoPrice === null ? '' : String(p.promoPrice / 100),
      promoStartsAt: toLocalInput(p.promoStartsAt), promoEndsAt: toLocalInput(p.promoEndsAt), promoLabel: p.promoLabel ?? '',
      name: p.name, priceYuan: p.price < 0 ? -1 : p.price / 100, period: p.period === 'year' ? 'year' : 'month',
      planFamilyKey: p.planFamilyKey, tierRank: p.tierRank, usageLevel: p.usageLevel, usageLabel: p.usageLabel,
      usageNormalPercent: p.usageNormalPercent, usageNearPercent: p.usageNearPercent,
      creditsPerMonth: p.creditsPerMonth, tokenQuotaPerMonth: p.tokenQuotaPerMonth, agentCount: p.agentCount,
      features: p.featuresJson.join('\n'), highlighted: p.highlighted, hidden: p.hidden, sort: p.sort,
      autoRenewEnabled: p.autoRenewEnabled, wechatContractPlanId: p.wechatContractPlanId ?? '',
    });
  };
  // -1=面议（企业版语义）；其余按元→分。前端不做四舍五入以外的加工，校验以服务端为准。
  const payload = () => ({
    name: form.name,
    price: form.priceYuan < 0 ? -1 : Math.round(form.priceYuan * 100),
    // 优惠价留空 = 显式取消优惠（服务端把 null 当「清空」，不传才是「保持原样」）。
    promoPrice: form.promoYuan.trim() ? Math.round(Number(form.promoYuan) * 100) : null,
    promoStartsAt: fromLocalInput(form.promoStartsAt),
    promoEndsAt: fromLocalInput(form.promoEndsAt),
    promoLabel: form.promoLabel.trim() || null,
    period: form.period,
    planFamilyKey: form.planFamilyKey.trim(), tierRank: form.tierRank,
    usageLevel: form.usageLevel, usageLabel: form.usageLabel.trim(),
    usageNormalPercent: form.usageNormalPercent, usageNearPercent: form.usageNearPercent,
    creditsPerMonth: form.creditsPerMonth,
    tokenQuotaPerMonth: form.tokenQuotaPerMonth,
    agentCount: form.agentCount,
    featuresJson: form.features.split('\n').map((s) => s.trim()).filter(Boolean),
    highlighted: form.highlighted,
    hidden: form.hidden,
    sort: form.sort,
    autoRenewEnabled: form.autoRenewEnabled,
    wechatContractPlanId: form.wechatContractPlanId.trim() || null,
    autoRenewMode: 'delay_24h' as const,
    syncFamilyBenefits: true,
  });
  const save = async (id: string) => {
    // 套餐改价是 requireSuper：非超管会拿到 403「需要 owner 权限」，catch 必须原文透出，
    // 不能盖成「保存失败」让运营去查网络（403 不再踢登录页，见 api.ts）。
    try {
      await api.savePlan(id, payload());
      setEditId(null); await load(); toast('套餐已更新');
    } catch (e) { toast((e as Error)?.message || '保存失败'); }
  };
  const create = async () => {
    if (!form.name.trim()) return toast('请先填套餐名称');
    try {
      await api.createPlan(payload());
      setAdding(false); setForm(PLAN_BLANK); await load(); toast('套餐已创建');
    } catch (e) { toast((e as Error)?.message || '创建失败'); }
  };
  // 删除只对「无用户在册」的档放行（服务端 409 PLAN_IN_USE 兜底，文案带在册人数）。
  // 想停售但保住在册用户 → 用「隐藏」。
  const remove = (p: AdminPlan) => setConfirmSpec({
    title: '删除套餐',
    desc: '仅当没有用户在册时可删。想停售又不影响在册用户，请改用「隐藏（停售）」。',
    echo: [{ k: '套餐', v: p.name }, { k: '价格', v: priceLabel(p) }],
    confirmText: '删除',
    danger: true,
    onConfirm: async () => { await api.deletePlan(p.id); await load(); toast('已删除'); },
  });
  const fields = (
    <>
      <div className="ai-field"><div className="ai-fl">名称</div><input className="ai-input" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="如 入门版" /></div>
      <div className="ai-field"><div className="ai-fl">挂牌价（元，-1=面议）</div><NumInput className="ai-input" value={form.priceYuan} onChange={(priceYuan) => set({ priceYuan })} /></div>
      <div className="ai-field"><div className="ai-fl">优惠价（元，留空=按挂牌价售卖）</div><input className="ai-input" inputMode="decimal" value={form.promoYuan} onChange={(e) => set({ promoYuan: e.target.value })} placeholder={form.priceYuan > 0 ? `低于 ${form.priceYuan}，如 ${Math.round(form.priceYuan / 10)}` : '仅正价套餐可配'} /></div>
      <div className="ai-field"><div className="ai-fl">优惠生效时间（留空=立即生效，本机时区）</div><input className="ai-input" type="datetime-local" value={form.promoStartsAt} onChange={(e) => set({ promoStartsAt: e.target.value })} /></div>
      <div className="ai-field"><div className="ai-fl">优惠结束时间（留空=长期有效；到点自动回挂牌价，无需人工操作）</div><input className="ai-input" type="datetime-local" value={form.promoEndsAt} onChange={(e) => set({ promoEndsAt: e.target.value })} /></div>
      <div className="ai-field"><div className="ai-fl">活动名（小程序折扣角标上显示，如「首发价」）</div><input className="ai-input" value={form.promoLabel} onChange={(e) => set({ promoLabel: e.target.value })} placeholder="留空则只显示折扣率" /></div>
      {/* 折扣率不在这里算：它是用户侧口径，只有服务端一份实现（保存后这一档的列表行会回显真实折扣与生效状态）。 */}
      {form.promoYuan.trim() && form.autoRenewEnabled
        && <div className="ai-field"><div className="ai-fl">注意：本档已开自动续费——优惠结束后，代扣会自动停扣并等用户重新确认，不会按挂牌价静默续。</div></div>}
      <div className="ai-field">
        <div className="ai-fl">计费周期（参与到期日推算与升级折算）</div>
        <select className="ai-input" value={form.period} onChange={(e) => set({ period: e.target.value === 'year' ? 'year' : 'month' })}>
          <option value="month">按月</option>
          <option value="year">按年</option>
        </select>
      </div>
      <div className="ai-field"><div className="ai-fl">方案分组标识（月付/年付同组，保存时月度权益会同步）</div><input className="ai-input" value={form.planFamilyKey} onChange={(e) => set({ planFamilyKey: e.target.value })} placeholder="如 decision" /></div>
      <div className="ai-field"><div className="ai-fl">商业档位（数字越大档位越高）</div><NumInput className="ai-input" min={0} value={form.tierRank} onChange={(tierRank) => set({ tierRank })} /></div>
      <div className="ai-field">
        <div className="ai-fl">用户侧用量等级</div>
        <select className="ai-input" value={form.usageLevel} onChange={(e) => set({ usageLevel: e.target.value as typeof form.usageLevel })}>
          <option value="standard">标准用量</option><option value="5x">5x 用量</option><option value="20x">20x 用量</option><option value="custom">自定义</option>
        </select>
      </div>
      <div className="ai-field"><div className="ai-fl">用户侧用量名称</div><input className="ai-input" value={form.usageLabel} onChange={(e) => set({ usageLabel: e.target.value })} placeholder="如 扩展用量 / 专属用量" /></div>
      <div className="ai-field"><div className="ai-fl">进入「正常使用」的百分比</div><NumInput className="ai-input" min={1} value={form.usageNormalPercent} onChange={(usageNormalPercent) => set({ usageNormalPercent })} /></div>
      <div className="ai-field"><div className="ai-fl">进入「接近上限」的百分比</div><NumInput className="ai-input" min={2} value={form.usageNearPercent} onChange={(usageNearPercent) => set({ usageNearPercent })} /></div>
      <div className="ai-field"><div className="ai-fl">每月赠送钻石（-1=不限量）</div><NumInput className="ai-input" value={form.creditsPerMonth} onChange={(creditsPerMonth) => set({ creditsPerMonth })} /></div>
      <div className="ai-field"><div className="ai-fl">每月 token 额度（产出消耗池，-1=不限量）</div><NumInput className="ai-input" value={form.tokenQuotaPerMonth} onChange={(tokenQuotaPerMonth) => set({ tokenQuotaPerMonth })} /></div>
      <div className="ai-field"><div className="ai-fl">含智能体数</div><NumInput className="ai-input" value={form.agentCount} onChange={(agentCount) => set({ agentCount })} /></div>
      <div className="ai-field"><div className="ai-fl">权益（每行一条）</div><textarea className="ta" rows={4} value={form.features} onChange={(e) => set({ features: e.target.value })} /></div>
      <div className="ai-field"><div className="ai-fl">排序（小在前）</div><NumInput className="ai-input" value={form.sort} onChange={(sort) => set({ sort })} /></div>
      <div className="cfg">
        <div className="cfg-row"><div className="cb"><div className="ct">常用配置</div><div className="cs">前台优先展示这一档</div></div><Switch checked={form.highlighted} onChange={(highlighted) => set({ highlighted })} label="常用配置" /></div>
        <div className="cfg-row"><div className="cb"><div className="ct">隐藏（停售）</div><div className="cs">套餐列表不返回；仅测试白名单手机号可见可购。在册用户的权益不受影响</div></div><Switch checked={form.hidden} onChange={(hidden) => set({ hidden })} label="隐藏套餐" /></div>
        <div className="cfg-row"><div className="cb"><div className="ct">允许用户选择自动续费</div><div className="cs">同时保留单次购买；用户每次都需主动选择自动续费，默认不会勾选</div></div><Switch checked={form.autoRenewEnabled} onChange={(autoRenewEnabled) => set({ autoRenewEnabled })} label="允许自动续费" /></div>
      </div>
      {form.autoRenewEnabled && <div className="ai-field"><div className="ai-fl">微信委托代扣模板 ID（通知后 24 小时扣费）</div><input className="ai-input" value={form.wechatContractPlanId} onChange={(e) => set({ wechatContractPlanId: e.target.value.replace(/\D/g, '') })} placeholder="商户平台审核通过后的数字模板 ID" /></div>}
    </>
  );
  return (
    <>
      <PageHead k="plan" res={res} badge={`${list.length} 档`} />
      <div className="pad">
        {!adding ? (
          <button className="add-btn full" onClick={() => { setEditId(null); setForm(PLAN_BLANK); setAdding(true); }}><Icon name="spark" size={15} /> 新增套餐</button>
        ) : (
          <div className="crd new-agent">
            {fields}
            <div className="ai-actions">
              <button className="ai-btn ghost" onClick={() => { setAdding(false); setForm(PLAN_BLANK); }}>取消</button>
              <button className="ai-btn primary" onClick={create}><Icon name="check" size={14} /> 创建套餐</button>
            </div>
          </div>
        )}
        {list.map((p) => editId === p.id ? (
          <div key={p.id} className="crd new-agent">
            {fields}
            <div className="ai-actions">
              <button className="ai-btn ghost" onClick={() => setEditId(null)}>取消</button>
              <button className="ai-btn ghost" onClick={() => remove(p)}><Icon name="alert" size={14} /> 删除</button>
              <button className="ai-btn primary" onClick={() => save(p.id)}><Icon name="check" size={14} /> 保存</button>
            </div>
          </div>
        ) : (
          <div key={p.id} className={`plan ${p.highlighted ? 'feat' : ''}`}>
            <div className="plan-h">
              <span className="pn">{p.name}</span>
              {p.highlighted && <span className="tag">常用配置</span>}
              {p.hidden && <span className="tag">已隐藏</span>}
              {p.autoRenewEnabled && <span className="tag">{p.autoRenewAvailable ? '自动续费可用' : '自动续费待配置'}</span>}
              <span className="pp">{priceLabel(p)}</span>
              {p.promotion && <span className="pp-was">{yuan(p.promotion.listPrice)}</span>}
              {p.promotion && <span className="pp-off">{p.promotion.label ? `${p.promotion.label} · ${p.promotion.discountLabel}` : p.promotion.discountLabel}</span>}
              {!p.promoActive && p.promoPrice !== null && <span className="pp-soon">优惠待生效 {yuan(p.promoPrice)}</span>}
            </div>
            <div className="plan-meta">{p.usageLabel} · 档位 {p.tierRank} · {p.planFamilyKey} · {p.creditsPerMonth < 0 ? '不限量权益点' : `${p.creditsPerMonth} 点/月`} · 含 {p.agentCount} 智能体 · {p.featuresJson.join(' · ')}</div>
            {p.promoPrice !== null && <div className="plan-meta">优惠：{p.promoActive ? '生效中' : '未生效'} · {p.promoStartsAt ? `${new Date(p.promoStartsAt).toLocaleString()} 起` : '立即生效'} · {p.promoEndsAt ? `${new Date(p.promoEndsAt).toLocaleString()} 止` : '长期有效'}</div>}
            <button className="plan-edit" onClick={() => startEdit(p)}><Icon name="pen" size={13} /> 编辑套餐</button>
          </div>
        ))}
      </div>
      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
    </>
  );
}

// 单次付费 SKU：改价 / 启停 / 展示。
//   · module / service / storage：key、kind、解锁模块走代码目录，只读；这里只改文案价格与上下架。
//   · credits（钻石）/ quota（算力）**增购包**：运营自建的商品——数量 + 定价全在后台配（代码侧不 seed，
//     同「对外数据归运营不归代码」），可新建、可改数量、无订单时可删。key 由服务端生成。
const SKU_KIND_LABEL: Record<string, string> = {
  module: '模块解锁', service: '社群服务', storage: '存储扩容',
  credits: '钻石增购包', quota: '算力增购包',
};

/** 增购包＝运营可自建/可删/可改数量的那两类；其余 kind 的行为一个字都不变。 */
const PACK_KINDS = ['credits', 'quota'] as const;
type PackKind = (typeof PACK_KINDS)[number];
const isPack = (kind: string): kind is PackKind => (PACK_KINDS as readonly string[]).includes(kind);

/** 数量列：钻石论「颗」、算力论 token（千分位，不做缩写——运营核价要看原值）。非增购包无数量概念。 */
function amountText(s: Pick<AdminSku, 'kind' | 'amount'>): string {
  if (!isPack(s.kind) || s.amount == null) return '—';
  return s.kind === 'credits' ? `${s.amount.toLocaleString()} 颗` : `${s.amount.toLocaleString()} token`;
}

const PACK_BLANK = { kind: 'credits' as PackKind, name: '', desc: '', amount: 0, priceYuan: 0, enabled: true, sort: 0 };

export function SkusView({ toast }: { toast: (m: string) => void }) {

  const [editKey, setEditKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', desc: '', amount: 0, priceYuan: 0, enabled: true, sort: 0 });
  const [pack, setPack] = useState(PACK_BLANK);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const res = useResource(api.adminSkus, []);
  const list = res.data ?? [];
  const load = () => res.reload();
  const setPackForm = (p: Partial<typeof PACK_BLANK>) => setPack((f) => ({ ...f, ...p }));
  const yuanText = (fen: number) => `¥${(fen / 100).toLocaleString()}`;
  const startEdit = (s: AdminSku) => {
    setAdding(false);
    setEditKey(s.key);
    setForm({ name: s.name, desc: s.desc, amount: s.amount ?? 0, priceYuan: s.priceFen / 100, enabled: s.enabled, sort: s.sort });
  };
  const toggleEnabled = async (s: AdminSku) => {
    try { await api.updateSku(s.key, { enabled: !s.enabled }); await load(); toast(s.enabled ? '已下架' : '已上架'); }
    catch (e) { toast((e as Error)?.message || '操作失败'); } // 同 requireSuper：403 文案要原样透出
  };
  const save = async (s: AdminSku) => {
    // amount 只对增购包提交：其它 kind 没有数量概念，多传一个字段会被服务端 400 挡下。
    if (isPack(s.kind) && !Number.isInteger(form.amount)) return toast('数量需填正整数');
    if (isPack(s.kind) && form.amount <= 0) return toast(s.kind === 'credits' ? '钻石颗数需大于 0' : 'token 数需大于 0');
    try {
      await api.updateSku(s.key, {
        name: form.name.trim(),
        desc: form.desc.trim(),
        priceFen: Math.max(0, Math.round(form.priceYuan * 100)),
        ...(isPack(s.kind) ? { amount: form.amount } : {}),
        enabled: form.enabled,
        sort: form.sort,
      });
      setEditKey(null); await load(); toast('SKU 已更新');
    } catch (e) { toast((e as Error)?.message || '保存失败'); }
  };
  const create = async () => {
    if (!pack.name.trim()) return toast('请先填增购包名称');
    if (!Number.isInteger(pack.amount) || pack.amount <= 0) return toast(pack.kind === 'credits' ? '钻石颗数需填正整数' : 'token 数需填正整数');
    try {
      await api.createSku({
        kind: pack.kind,
        name: pack.name.trim(),
        desc: pack.desc.trim(),
        amount: pack.amount,
        priceFen: Math.max(0, Math.round(pack.priceYuan * 100)),
        enabled: pack.enabled,
        sort: pack.sort,
      });
      setAdding(false); setPack(PACK_BLANK); await load(); toast('增购包已创建');
    } catch (e) { toast((e as Error)?.message || '创建失败'); }
  };
  // 删除只对「无订单」的增购包放行：服务端 409 SKU_IN_USE 兜底。已有订单的包想下架 → 用「停用」，
  // 否则历史订单会失去它对应的商品档（对账时查不到买的是什么）。
  const remove = (s: AdminSku) => setConfirmSpec({
    title: '删除增购包',
    desc: '仅当这个包还没有任何订单时可删。已经卖出过的包请改用「停用」——前台立即不再展示、不可购买，已购用户的权益不受影响。',
    echo: [{ k: '增购包', v: `${s.name} · ${SKU_KIND_LABEL[s.kind] ?? s.kind}` }, { k: '数量', v: amountText(s) }, { k: '价格', v: yuanText(s.priceFen), amount: true }],
    confirmText: '删除',
    danger: true,
    onConfirm: async () => {
      try { await api.deleteSku(s.key); }
      catch (e) {
        // 409 = 已有订单：不是失败重试的事，直接把出路（停用）说清楚，文案留在弹层里。
        if ((e as { code?: string }).code === 'SKU_IN_USE') throw new Error('这个增购包已有订单，不能删除；请改用「停用」下架（已购用户不受影响）');
        throw e;
      }
      await load(); toast('已删除');
    },
  });
  const amountLabel = (kind: PackKind) => kind === 'credits' ? '数量（钻石颗数，正整数）' : '数量（token 数，正整数）';
  return (
    <>
      <PageHead k="sku" res={res} badge={`${list.filter((x) => x.enabled).length}/${list.length} 在售`} />
      {/* 加载失败绝不能长成「暂无商品」：ViewState 把 loading / 失败（可重试）/ 真空态分开。 */}
      <ViewState res={res}>
        {(all) => (
          <div className="pad">
            {!adding ? (
              <button className="add-btn full" onClick={() => { setEditKey(null); setPack(PACK_BLANK); setAdding(true); }}><Icon name="spark" size={15} /> 新建增购包</button>
            ) : (
              <div className="crd new-agent">
                <div className="ai-field">
                  <div className="ai-fl">类型（决定买到手的是什么，创建后不可改）</div>
                  <select className="ai-input" value={pack.kind} onChange={(e) => setPackForm({ kind: e.target.value === 'quota' ? 'quota' : 'credits' })}>
                    <option value="credits">钻石增购包（按颗发放钻石）</option>
                    <option value="quota">算力增购包（按 token 加算力额度）</option>
                  </select>
                </div>
                <div className="ai-field"><div className="ai-fl">名称</div><input className="ai-input" value={pack.name} onChange={(e) => setPackForm({ name: e.target.value })} placeholder={pack.kind === 'credits' ? '如 100 钻小包' : '如 100 万 token 加油包'} /></div>
                <div className="ai-field"><div className="ai-fl">描述（前台展示的一句话）</div><textarea className="ta" rows={2} value={pack.desc} onChange={(e) => setPackForm({ desc: e.target.value })} /></div>
                <div className="ai-field"><div className="ai-fl">{amountLabel(pack.kind)}</div><NumInput className="ai-input" min={1} step={1} value={pack.amount} onChange={(amount) => setPackForm({ amount })} /></div>
                <div className="ai-field"><div className="ai-fl">价格（元）</div><NumInput className="ai-input" min={0} step={0.01} value={pack.priceYuan} onChange={(priceYuan) => setPackForm({ priceYuan })} /></div>
                <div className="ai-field"><div className="ai-fl">排序（小在前）</div><NumInput className="ai-input" value={pack.sort} onChange={(sort) => setPackForm({ sort })} /></div>
                <div className="cfg"><div className="cfg-row"><div className="cb"><div className="ct">上架启用</div><div className="cs">关闭后前台不展示、不可购买</div></div><Switch checked={pack.enabled} onChange={(enabled) => setPackForm({ enabled })} label="上架增购包" /></div></div>
                <div className="ai-actions">
                  <button className="ai-btn ghost" onClick={() => { setAdding(false); setPack(PACK_BLANK); }}>取消</button>
                  <button className="ai-btn primary" onClick={create}><Icon name="check" size={14} /> 创建增购包</button>
                </div>
              </div>
            )}
            {all.length === 0 && !adding && <div className="empty">还没有任何单次付费商品。钻石 / 算力增购包可以在这里新建。</div>}
            {all.map((s) => editKey === s.key ? (
              <div key={s.id} className="crd new-agent">
                <div className="ai-field"><div className="ai-fl">标识 key · {SKU_KIND_LABEL[s.kind] ?? s.kind}（{isPack(s.kind) ? '服务端生成' : '代码目录'}，不可改）</div><input className="ai-input" value={s.key} disabled /></div>
                <div className="ai-field"><div className="ai-fl">名称</div><input className="ai-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
                <div className="ai-field"><div className="ai-fl">描述</div><textarea className="ta" rows={2} value={form.desc} onChange={(e) => setForm({ ...form, desc: e.target.value })} /></div>
                {isPack(s.kind) && <div className="ai-field"><div className="ai-fl">{amountLabel(s.kind)}——改动只影响新订单，已购订单按下单时的数量发放</div><NumInput className="ai-input" min={1} step={1} value={form.amount} onChange={(amount) => setForm({ ...form, amount })} /></div>}
                <div className="ai-field"><div className="ai-fl">价格（元）</div><NumInput className="ai-input" min={0} step={0.01} value={form.priceYuan} onChange={(priceYuan) => setForm({ ...form, priceYuan })} /></div>
                <div className="ai-field"><div className="ai-fl">排序（小在前）</div><NumInput className="ai-input" value={form.sort} onChange={(sort) => setForm({ ...form, sort })} /></div>
                {s.grantsModuleKey && <div className="ai-field"><div className="ai-fl">解锁模块（代码目录，不可改）</div><input className="ai-input" value={s.grantsModuleKey} disabled /></div>}
                <div className="cfg"><div className="cfg-row"><div className="cb"><div className="ct">上架启用</div><div className="cs">关闭后前台不展示、不可购买</div></div><Switch checked={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} label="上架商品" /></div></div>
                <div className="ai-actions">
                  <button className="ai-btn ghost" onClick={() => setEditKey(null)}>取消</button>
                  {isPack(s.kind) && <button className="ai-btn ghost" onClick={() => remove(s)}><Icon name="alert" size={14} /> 删除</button>}
                  <button className="ai-btn primary" onClick={() => save(s)}><Icon name="check" size={14} /> 保存</button>
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
                  <span className="tag off">{amountText(s)}</span>
                  <span className="user-balance">{yuanText(s.priceFen)}</span>
                  <Switch checked={s.enabled} onChange={() => toggleEnabled(s)} label={`${s.enabled ? '下架' : '上架'}商品 ${s.name}`} stopPropagation />
                  <span className="edit"><Icon name="pen" size={15} /></span>
                </div>
              </div>
            ))}
          </div>
        )}
      </ViewState>
      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
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
            <div className="cfg"><div className="cfg-row"><div className="cb"><div className="ct">启用（可开方）</div><div className="cs">关闭后军师不再向客户开这个方</div></div><Switch checked={form.enabled} onChange={(enabled) => set({ enabled })} label="启用生态工具" /></div></div>
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
            <div className="cfg"><div className="cfg-row"><div className="cb"><div className="ct">启用（可开方）</div><div className="cs">关闭后军师不再向客户开这个方</div></div><Switch checked={form.enabled} onChange={(enabled) => set({ enabled })} label="启用生态工具" /></div></div>
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
              <Switch checked={t.enabled} onChange={() => toggleEnabled(t)} label={`${t.enabled ? '停用' : '启用'}生态工具 ${t.name}`} stopPropagation />
              <span className="edit"><Icon name="pen" size={15} /></span>
            </div>
          </div>
        ))}
      </div>
      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
    </>
  );
}
