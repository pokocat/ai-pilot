// 配置：行业基准 / 功能开关（含告警阈值与飞书通知）/ 每日献策 / 问卷 / 运营账户。
// 模型配置同属「配置」组，因页面体量单独放 model.tsx。

import { useEffect, useState, type ChangeEvent } from 'react';
import Icon from '../Icon';
import NumInput from '../NumInput';
import { api, type AdminAccountItem, type AdminClonePricing, type AdminFeatureFlag, type AdminMonitorNotify, type AdminBenchmark } from '../api';
import { PageHead, ErrorState, ViewState, ConfirmDialog, type ConfirmSpec } from '../components';
import { useResource } from '../useResource';
import { fmtTime } from '../format';

// WO-08：行业基准库维护面——表格 + 行业筛选 + CSV 批量导入。
// 宁缺勿假：p50 留空的行注入层不会引用（后端 services/benchmark.ts），面上以「未核实」标签提示运营回填。
type BmForm = { industry: string; revenueBand: string; metricKey: string; metricName: string; unit: string; p25: string; p50: string; p75: string; note: string; source: string };

const BM_BLANK: BmForm = { industry: '', revenueBand: '*', metricKey: '', metricName: '', unit: '', p25: '', p50: '', p75: '', note: '', source: '' };

// 最小 RFC4180 CSV 行解析：支持 "..." 包裹的字段（内含逗号/换行）与 "" 转义引号。
// 朴素 split(',') 会在 note/source 等自由文本字段包含逗号时把后续列全部错位（静默产出错误数据），
// 这类字段来自 Excel 编辑后再导出，含逗号很常见。
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

// CSV 行格式（与文档一致）：industry,revenueBand,metricKey,metricName,unit,p25,p50,p75,note,source
const BM_CSV_COLS = ['industry', 'revenueBand', 'metricKey', 'metricName', 'unit', 'p25', 'p50', 'p75', 'note', 'source'] as const;

const bmNumOrNull = (s: string): number | null => { const t = s.trim(); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : null; };

const bmRowToForm = (b: AdminBenchmark): BmForm => ({
  industry: b.industry, revenueBand: b.revenueBand, metricKey: b.metricKey, metricName: b.metricName, unit: b.unit,
  p25: b.p25 == null ? '' : String(b.p25), p50: b.p50 == null ? '' : String(b.p50), p75: b.p75 == null ? '' : String(b.p75),
  note: b.note ?? '', source: b.source ?? '',
});

export function BenchmarksView({ toast }: { toast: (m: string) => void }) {

  const [industry, setIndustry] = useState('');
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<BmForm>(BM_BLANK);
  const [importing, setImporting] = useState(false);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const res = useResource(api.benchmarks, []);
  const list = res.data ?? [];
  const load = () => res.reload();
  const set = (p: Partial<BmForm>) => setForm((f) => ({ ...f, ...p }));
  const industries = [...new Set(list.map((b) => b.industry))].sort();
  const shown = industry ? list.filter((b) => b.industry === industry) : list;

  const upsert = async (): Promise<boolean> => {
    if (!form.industry.trim()) { toast('请填写行业'); return false; }
    if (!form.metricKey.trim()) { toast('请填写指标 key'); return false; }
    if (!form.metricName.trim()) { toast('请填写指标名'); return false; }
    if (!form.unit.trim()) { toast('请填写单位'); return false; }
    await api.upsertBenchmark({
      industry: form.industry.trim(), revenueBand: form.revenueBand.trim() || '*',
      metricKey: form.metricKey.trim(), metricName: form.metricName.trim(), unit: form.unit.trim(),
      p25: bmNumOrNull(form.p25), p50: bmNumOrNull(form.p50), p75: bmNumOrNull(form.p75),
      note: form.note.trim() || null, source: form.source.trim() || null,
    });
    return true;
  };
  const create = async () => {
    try { if (await upsert()) { setAdding(false); setForm(BM_BLANK); await load(); toast('已保存基准行'); } }
    catch (e) { toast((e as Error)?.message || '保存失败'); }
  };
  const save = async () => {
    try { if (await upsert()) { setEditId(null); await load(); toast('基准行已更新'); } }
    catch (e) { toast((e as Error)?.message || '保存失败'); }
  };
  const remove = (b: AdminBenchmark) => setConfirmSpec({
    title: '删除这条行业基准',
    desc: '删除后该指标不再参与基准注入；p50 缺失时系统本就不注入（宁缺勿假）。',
    echo: [{ k: '行业', v: b.industry }, { k: '指标', v: b.metricName }],
    confirmText: '删除',
    danger: true,
    onConfirm: async () => { await api.deleteBenchmark(b.id); await load(); toast('已删除'); },
  });

  // CSV 批量导入：前端逐行解析后调 upsert（幂等，(行业,营收段,key) 命中即更新）。
  const onImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重复选同一文件
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let ok = 0, skipped = 0;
      for (const line of rows) {
        const cells = parseCsvLine(line);
        if (cells[0]?.toLowerCase() === BM_CSV_COLS[0]) continue; // 跳过表头行
        const [ind, band, key, name, unit, p25, p50, p75, note, source] = cells;
        if (!ind || !key || !name || !unit) { skipped++; continue; }
        try {
          await api.upsertBenchmark({
            industry: ind, revenueBand: band || '*', metricKey: key, metricName: name, unit,
            p25: bmNumOrNull(p25 ?? ''), p50: bmNumOrNull(p50 ?? ''), p75: bmNumOrNull(p75 ?? ''),
            note: (note ?? '').trim() || null, source: (source ?? '').trim() || null,
          });
          ok++;
        } catch { skipped++; }
      }
      await load();
      toast(`导入完成：成功 ${ok} 行${skipped ? ` · 跳过 ${skipped} 行` : ''}`);
    } catch { toast('CSV 解析失败'); }
    setImporting(false);
  };

  return (
    <>
      <PageHead k="benchmark" res={res} badge={`${list.length} 条`} />
      <div className="pad">
        <div className="crd-actions">
          <button className={`mini-btn ${industry === '' ? 'primary' : ''}`} onClick={() => setIndustry('')}>全部</button>
          {industries.map((ind) => (
            <button key={ind} className={`mini-btn ${industry === ind ? 'primary' : ''}`} onClick={() => setIndustry(ind)}>{ind}</button>
          ))}
        </div>
        <label className="add-btn full">
          <Icon name="up" size={15} /> {importing ? '导入中…' : 'CSV 批量导入（industry,revenueBand,metricKey,metricName,unit,p25,p50,p75,note,source）'}
          <input className="file-hidden" type="file" accept=".csv,text/csv" onChange={onImport} disabled={importing} />
        </label>
        {!adding ? (
          <button className="add-btn full" onClick={() => { setEditId(null); setForm({ ...BM_BLANK, industry }); setAdding(true); }}><Icon name="spark" size={15} /> 新增基准行</button>
        ) : (
          <div className="crd new-agent">
            <div className="ai-field"><div className="ai-fl">行业（与用户档案口径一致）</div><input className="ai-input" value={form.industry} onChange={(e) => set({ industry: e.target.value })} placeholder="如 美业/大健康" /></div>
            <div className="ai-field"><div className="ai-fl">营收段（* = 不分段）</div><input className="ai-input" value={form.revenueBand} onChange={(e) => set({ revenueBand: e.target.value })} placeholder="* 或 100-500万" /></div>
            <div className="ai-field"><div className="ai-fl">指标 key（与周报填报口径一致）</div><input className="ai-input" value={form.metricKey} onChange={(e) => set({ metricKey: e.target.value })} placeholder="如 repurchase_rate" /></div>
            <div className="ai-field"><div className="ai-fl">指标名</div><input className="ai-input" value={form.metricName} onChange={(e) => set({ metricName: e.target.value })} placeholder="如 复购率" /></div>
            <div className="ai-field"><div className="ai-fl">单位</div><input className="ai-input" value={form.unit} onChange={(e) => set({ unit: e.target.value })} placeholder="% / 元 / 天" /></div>
            <div className="ai-field"><div className="ai-fl">P25（留空即不填）</div><input className="ai-input" value={form.p25} onChange={(e) => set({ p25: e.target.value })} placeholder="留空 = 未核实" /></div>
            <div className="ai-field"><div className="ai-fl">P50 中位（空则该指标不注入）</div><input className="ai-input" value={form.p50} onChange={(e) => set({ p50: e.target.value })} placeholder="留空 = 未核实，不注入" /></div>
            <div className="ai-field"><div className="ai-fl">P75（留空即不填）</div><input className="ai-input" value={form.p75} onChange={(e) => set({ p75: e.target.value })} placeholder="留空 = 未核实" /></div>
            <div className="ai-field"><div className="ai-fl">口径说明 note</div><input className="ai-input" value={form.note} onChange={(e) => set({ note: e.target.value })} placeholder="如 待运营核实" /></div>
            <div className="ai-field"><div className="ai-fl">数据来源 source</div><input className="ai-input" value={form.source} onChange={(e) => set({ source: e.target.value })} placeholder="来源出处（可选）" /></div>
            <div className="ai-actions">
              <button className="ai-btn ghost" onClick={() => { setAdding(false); setForm(BM_BLANK); }}>取消</button>
              <button className="ai-btn primary" onClick={create}><Icon name="check" size={14} /> 保存</button>
            </div>
          </div>
        )}
        {shown.length === 0 && !adding && <div className="empty">暂无基准行。可手动新增或 CSV 导入。</div>}
        {shown.map((b) => editId === b.id ? (
          <div key={b.id} className="crd new-agent">
            <div className="ai-field"><div className="ai-fl">行业 · 营收段 · key（唯一键，改动即新增另一条）</div><input className="ai-input" value={`${form.industry} · ${form.revenueBand} · ${form.metricKey}`} disabled /></div>
            <div className="ai-field"><div className="ai-fl">指标名</div><input className="ai-input" value={form.metricName} onChange={(e) => set({ metricName: e.target.value })} /></div>
            <div className="ai-field"><div className="ai-fl">单位</div><input className="ai-input" value={form.unit} onChange={(e) => set({ unit: e.target.value })} /></div>
            <div className="ai-field"><div className="ai-fl">P25</div><input className="ai-input" value={form.p25} onChange={(e) => set({ p25: e.target.value })} placeholder="留空 = 未核实" /></div>
            <div className="ai-field"><div className="ai-fl">P50 中位（空则不注入）</div><input className="ai-input" value={form.p50} onChange={(e) => set({ p50: e.target.value })} placeholder="留空 = 未核实，不注入" /></div>
            <div className="ai-field"><div className="ai-fl">P75</div><input className="ai-input" value={form.p75} onChange={(e) => set({ p75: e.target.value })} placeholder="留空 = 未核实" /></div>
            <div className="ai-field"><div className="ai-fl">口径说明 note</div><input className="ai-input" value={form.note} onChange={(e) => set({ note: e.target.value })} /></div>
            <div className="ai-field"><div className="ai-fl">数据来源 source</div><input className="ai-input" value={form.source} onChange={(e) => set({ source: e.target.value })} /></div>
            <div className="ai-actions">
              <button className="ai-btn ghost" onClick={() => setEditId(null)}>取消</button>
              <button className="ai-btn ghost" onClick={() => remove(b)}><Icon name="alert" size={14} /> 删除</button>
              <button className="ai-btn primary" onClick={save}><Icon name="check" size={14} /> 保存</button>
            </div>
          </div>
        ) : (
          <div key={b.id} className="crd" onClick={() => { setAdding(false); setEditId(b.id); setForm(bmRowToForm(b)); }}>
            <div className="crd-row">
              <span className="crd-ic"><Icon name="trend" size={18} /></span>
              <div className="crd-b">
                <div className="ct">{b.metricName} <span className="tag">{b.industry}</span>{b.p50 == null && <span className="tag warn">未核实</span>}{!b.enabled && <span className="tag off">停用</span>}</div>
                <div className="cs">{b.metricKey}{b.revenueBand !== '*' ? ` · ${b.revenueBand}` : ''} · 中位 {b.p50 == null ? '—' : `${b.p50}${b.unit}`}{b.p25 != null && b.p75 != null ? `（P25 ${b.p25} / P75 ${b.p75}）` : ''}{b.note ? ` · ${b.note}` : ''}</div>
              </div>
              <span className="edit"><Icon name="pen" size={15} /></span>
            </div>
          </div>
        ))}
      </div>
      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
    </>
  );
}

/* ─────────── 短视频克隆定价（数字人 / 专属声音的钻石单价） ───────────
 *
 * 为什么是「功能开关」页的一段，而不是自己一屏：
 *   · nav.ts 的「配置」组已经是 8 项，DESIGN.md 写死了「一组超过 ~8 项就得拆组」——
 *     为四个数字开第 9 项，代价是把整组重排，不划算；
 *   · 本页的定位本来就是**平台级可写数值**（页头副标题：「合规一键降级与数值配置」），
 *     告警阈值、飞书 webhook 已经在这儿，克隆单价是同一类东西。
 *   短视频后续真长出任务台 / 供应商配置时，再连着这段一起搬去独立页（那时它够一屏了）。
 *
 * 定价为什么不能留在代码里：仓库铁律是「会影响真实用户的对外数据（定价 / 权益）归运营后台」。
 * 在这段 UI 出现之前，这四个价只存在于 pricing.ts 的 FALLBACK 常量 —— 运营没有任何入口能改，
 * `configured` 永远是 false，「定价归运营后台」只是纸面上的。
 */

/**
 * 四档的中文名与副文案。服务端 pricing.ts 有一份同名映射，那份只用于 422 错误文案，不下发。
 * `short` 是二次确认弹窗回显用的短名：ConfirmDialog 的字段名列很窄，六个字会折行成两行，
 * 而那正是运营按下「确认核定」前唯一要核对的一列。
 */
const CLONE_PRICE_FIELDS: { key: CloneKey; label: string; short: string; hint: string }[] = [
  {
    key: 'voiceCreate',
    label: '新建专属声音',
    short: '新建声音',
    hint: '供应商侧最贵的单次动作（一条音色 8000+ 算力）。这一档定低了，声音克隆就是在亏本跑。',
  },
  {
    key: 'voiceRetrain',
    label: '重训已有声音',
    short: '重训声音',
    hint: '供应商每条免费 4 次，但我方的上传 / 存储 / 审核 / 编排成本照付，所以按低价收而不是收 0。'
      + '应当明显低于「新建专属声音」，否则用户没有动力走这条省供应商权益的路径。',
  },
  { key: 'avatarVideo', label: '视频训练数字人', short: '视频训练', hint: '用户上传本人出镜视频训练形象。' },
  {
    key: 'avatarImage',
    label: '图片训练数字人',
    short: '图片训练',
    hint: '单张图片训练，成本远低于视频训练，是低成本入口，价格应低于「视频训练数字人」。'
      + '⚠️ 该能力目前只有上游网关就绪，尚未接通到军师小程序 —— 这一档现在还没有真实成交，'
      + '填的是「接通那天生效的价」。',
  },
];

type CloneKey = 'voiceCreate' | 'voiceRetrain' | 'avatarVideo' | 'avatarImage';
type CloneDraft = Record<CloneKey, number>;

const cloneDraftOf = (p: AdminClonePricing): CloneDraft => ({
  voiceCreate: p.voiceCreate, voiceRetrain: p.voiceRetrain, avatarVideo: p.avatarVideo, avatarImage: p.avatarImage,
});

const cloneDirty = (d: CloneDraft, p: AdminClonePricing): boolean =>
  CLONE_PRICE_FIELDS.some(({ key }) => d[key] !== p[key]);

/**
 * 两条业务序关系（pricing.ts 的注释与单测都写着）被打破时提示，但**不拦保存**。
 * 不做成硬校验：运营有做活动的正当理由把某一档临时打低（例如新建声音限时特价），
 * 后台不该替业务把这种决定判成非法。要的是「你正在反转一条我们自己写下的定价原则，确认一下」。
 */
function cloneOrderWarnings(d: CloneDraft): string[] {
  const out: string[] = [];
  if (d.voiceRetrain >= d.voiceCreate) {
    out.push(`重训（${d.voiceRetrain}）不低于新建（${d.voiceCreate}）：用户没有动力走省供应商权益的重训路径`);
  }
  if (d.avatarImage >= d.avatarVideo) {
    out.push(`图片训练（${d.avatarImage}）不低于视频训练（${d.avatarVideo}）：低成本入口比完整能力还贵`);
  }
  return out;
}

function ClonePricingSection({ toast, isSuper }: { toast: (m: string) => void; isSuper: boolean }) {
  const res = useResource(api.clonePricing, []);
  const [draft, setDraft] = useState<CloneDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const cur = res.data;
  // 服务端回包是唯一真源：加载完 / 保存完都用它重置草稿，运营不会对着一份「本地以为改上了」的数字操作。
  useEffect(() => { if (cur) setDraft(cloneDraftOf(cur)); }, [cur]);

  const set = (p: Partial<CloneDraft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const save = async (next: CloneDraft) => {
    setBusy(true);
    try {
      // 整份提交（不只发脏字段）：服务端要求首次核定四档一起给 —— 只发一档会把另外三档
      // 没人核定过的兜底价一并升格成「运营配过的价」。
      const saved = await api.saveClonePricing(next);
      res.setData(saved);
      setDraft(cloneDraftOf(saved));
      toast('克隆定价已保存 · 小程序侧最迟 1 分钟内按新价扣费');
    } catch (e) {
      toast((e as Error)?.message || '保存失败');
    }
    setBusy(false);
  };

  const submit = () => {
    if (!draft || !cur) return;
    const warns = cloneOrderWarnings(draft);
    setConfirmSpec({
      // 首次核定与日常改价是两件事：前者是把一组占位数字变成对外承诺，措辞必须说清。
      title: cur.configured ? '修改克隆定价' : '首次核定克隆定价',
      desc: cur.configured
        ? '保存后小程序侧最迟 1 分钟内按新价预扣钻石。已经在训练中的任务沿用下单时的价格，不重新计价。'
        : '当前四个数字是代码里的保守兜底价，没有任何商务结论背书。保存即把它们（或你改后的值）定为线上定价，'
          + '小程序侧随即按此扣费，并向用户按「已核定」的口径展示。',
      echo: CLONE_PRICE_FIELDS.map(({ key, short }) => ({
        k: short,
        v: cur[key] === draft[key] ? `💎 ${draft[key]}（未改）` : `💎 ${cur[key]} → ${draft[key]}`,
        amount: true,
      })),
      ...(warns.length ? { warn: warns.join('；') } : {}),
      confirmText: cur.configured ? '确认改价' : '确认核定',
      onConfirm: async () => { await save(draft); },
    });
  };

  return (
    <>
      <div className="sec-h">
        <span className="t">短视频克隆定价</span>
        <span className="s">数字人形象与专属声音的钻石单价 · 保存即生效，无需发版</span>
      </div>
      <ViewState res={res} skeleton="rows">
        {(p: AdminClonePricing) => !draft ? null : (
          <div className="pad">
            {!p.configured && (
              <div className="ai-note">
                <b>当前是代码兜底价，尚未经运营核定。</b>
                这四个数字由内测临时给定，没有按真实成本与毛利算过，小程序侧也据此把口径说软（不当承诺价）。
                正式开量前必须在这里定死一次 —— 保存之后 <code>configured</code> 才会为真。
              </div>
            )}
            {!isSuper && (
              <div className="ai-note">
                当前账户为普通运营：改价直接影响营收，需要超级管理员（owner / master）。这里只读，数字可以正常查看。
              </div>
            )}
            <div className="crd new-agent">
              {CLONE_PRICE_FIELDS.map(({ key, label, hint }) => (
                <div key={key} className="ai-field">
                  <div className="ai-fl">{label}（钻石 / 次 · 0–1000000 · 0 = 该档免费）</div>
                  <NumInput
                    className="ai-input" min={0} max={1_000_000} step={1}
                    value={draft[key]} disabled={!isSuper}
                    onChange={(n) => set({ [key]: n } as Partial<CloneDraft>)}
                  />
                  <div className="ai-note">{hint}</div>
                </div>
              ))}
              {cloneOrderWarnings(draft).map((w) => (
                <div key={w} className="ai-note"><b>提醒：</b>{w}。确认这是有意为之即可保存。</div>
              ))}
              {isSuper && (
                <div className="ai-actions">
                  <button
                    type="button" className="ai-btn ghost"
                    disabled={busy || !cloneDirty(draft, p)}
                    onClick={() => setDraft(cloneDraftOf(p))}
                  >
                    <Icon name="close" size={14} /> 撤销改动
                  </button>
                  <button
                    type="button" className="ai-btn primary"
                    // 未核定过时即便一个数字都没改也允许保存：那一次「保存」本身就是核定动作
                    // （把兜底价确认为线上价），不是空操作。
                    disabled={busy || (p.configured && !cloneDirty(draft, p))}
                    onClick={submit}
                  >
                    <Icon name="check" size={14} /> {busy ? '保存中…' : p.configured ? '保存定价' : '核定并保存'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </ViewState>
      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
    </>
  );
}

// 功能开关（P0-2）：命理等合规开关一键降级。关闭合规开关前二次确认，避免误触把全产品命理下线。
// 监控大盘二期：告警阈值也注册为 number 类开关（monitor.* 前缀），改动 ≤75s 喂给 Prometheus；
// 底部「告警通知」卡（仅 owner/master）配置飞书群机器人 webhook：非超管整卡不渲染，
// 别摆一个注定 403 的入口；万一 me() 拿不到角色而露了出来，403 也会照原文 toast 出来
// （api.ts 的 401/403 已分流，403 不再踢回登录页）。
// 「短视频克隆定价」是本页第三段：非超管**也渲染**（只读），与告警通知那卡的取舍不同 ——
// 值班运营需要答得出「训一个数字人扣多少钻」，看不到反而要去问人。
export function FlagsView({ toast, isSuper }: { toast: (m: string) => void; isSuper: boolean }) {
  const [list, setList] = useState<AdminFeatureFlag[]>([]);
  const [busy, setBusy] = useState('');
  const [draft, setDraft] = useState<Record<string, number>>({}); // number 类的编辑中数值
  const [notify, setNotify] = useState<AdminMonitorNotify | null>(null);
  const [hookUrl, setHookUrl] = useState('');
  const [hookSecret, setHookSecret] = useState('');
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const load = () => api.flags().then((rows) => {
    setList(rows);
    // 初始化 number 类草稿为当前值
    setDraft(Object.fromEntries(rows.filter((r) => r.kind === 'number').map((r) => [r.id, r.value ?? 0])));
    setErr('');
  }).catch((e: unknown) => setErr((e as Error)?.message || '开关加载失败'));
  useEffect(() => { load(); if (isSuper) api.monitorNotify().then(setNotify).catch(() => { /* 通知配置次要，失败不挡开关 */ }); }, [isSuper]);
  const saveNotify = async () => {
    setNotifyBusy(true);
    try {
      const st = await api.saveMonitorNotify(hookUrl.trim(), hookSecret.trim());
      setNotify(st); setHookUrl(''); setHookSecret('');
      toast(st.configured ? '告警通知已配置' : '已清除告警通知配置');
    } catch (e) { toast((e as Error)?.message || '保存失败'); }
    setNotifyBusy(false);
  };
  const testNotify = async () => {
    setNotifyBusy(true);
    try { await api.testMonitorNotify(); toast('测试消息已发出，去飞书群看一眼'); }
    catch (e) { toast((e as Error)?.message || '发送失败'); }
    setNotifyBusy(false);
  };
  const apply = async (f: AdminFeatureFlag, next: boolean) => {
    setBusy(f.id);
    try {
      await api.setFlag(f.id, next);
      await load();
      toast(next ? `已开启「${f.label}」` : `已关闭「${f.label}」`);
    } catch (e) {
      toast((e as Error)?.message || '操作失败');
    }
    setBusy('');
  };
  const toggle = (f: AdminFeatureFlag) => {
    const next = !f.enabled;
    // 关闭合规开关是「全产品降级」动作：要求手打开关名再确认，防止误触把全产品某能力下线。
    if (!next && f.compliance) {
      setConfirmSpec({
        title: `关闭「${f.label}」`,
        desc: '这是合规降级开关。关闭后全产品相关入口与端点立即下线，用户侧会立刻感知。',
        echo: [{ k: '开关', v: f.label }, { k: '影响', v: f.desc }],
        warn: '影响全产品，不是灰度。确认前请先确认这是当前要做的动作。',
        typed: f.label,
        confirmText: '确认关闭',
        danger: true,
        onConfirm: async () => { await apply(f, false); },
      });
      return;
    }
    void apply(f, next);
  };
  const saveValue = async (f: AdminFeatureFlag) => {
    const v = draft[f.id] ?? 0;
    setBusy(f.id);
    try {
      await api.setFlagValue(f.id, v);
      await load();
      toast(`已保存「${f.label}」= ${v}${f.unit ?? ''}`);
    } catch (e) {
      toast((e as Error)?.message || '保存失败');
    }
    setBusy('');
  };
  return (
    <>
      <PageHead k="flags" res={{ loading: false, reload: load, updatedAt: 0 }} badge={`${list.length} 项`} />
      <div className="pad">
        {err && <ErrorState msg={err} onRetry={load} />}
        {list.map((f) => f.kind === 'number' ? (
          <div key={f.id} className="say-row">
            <span className="grip"><Icon name="shield" size={15} /></span>
            <div className="sb">
              <div className="stx">{f.label}</div>
              <div className="smeta">当前 {f.value}{f.unit ?? ''} · {f.desc}（{f.min}-{f.max}）</div>
            </div>
            <NumInput className="ai-input flag-num" min={f.min} max={f.max} value={draft[f.id] ?? f.value ?? 0} onChange={(n) => setDraft((d) => ({ ...d, [f.id]: n }))} />
            <button className="mini-btn primary" disabled={busy === f.id || (draft[f.id] ?? f.value) === f.value} onClick={() => saveValue(f)}>保存</button>
          </div>
        ) : (
          <div key={f.id} className={`say-row ${f.enabled ? '' : 'say-today'}`}>
            <span className="grip"><Icon name="shield" size={15} /></span>
            <div className="sb">
              <div className="stx">{f.label}{f.compliance ? ' · 合规开关' : ''}</div>
              <div className="smeta">{f.enabled ? '已开启' : '已关闭 · 全产品下线'} · {f.desc}</div>
            </div>
            <div className={`sw ${f.enabled ? 'on' : ''}`} onClick={() => busy !== f.id && toggle(f)}><i /></div>
          </div>
        ))}
        {!list.length ? <div className="smeta">暂无可配置开关</div> : null}
      </div>
      {isSuper && (
        <>
          <div className="sec-h"><span className="t">告警通知</span><span className="s">Prometheus 告警推送到飞书群 · 保存即生效，无需发版</span></div>
          <div className="pad">
            <div className="say-row">
              <span className="grip"><Icon name="shield" size={15} /></span>
              <div className="sb">
                <div className="stx">飞书群机器人</div>
                <div className="smeta">
                  {notify?.configured
                    ? `已配置 ${notify.urlMasked}${notify.hasSecret ? ' · 已启用签名校验' : ''}`
                    : '未配置 · 告警目前只在 Grafana / Alertmanager 界面可见'}
                </div>
              </div>
              <button className="mini-btn" disabled={!notify?.configured || notifyBusy} onClick={testNotify}>发测试消息</button>
            </div>
            <div className="say-row">
              <span className="grip"><Icon name="shield" size={15} /></span>
              <input className="ai-input hook-url" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…（留空保存=清除配置）" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} />
              <input className="ai-input hook-secret" placeholder="签名密钥（选填）" value={hookSecret} onChange={(e) => setHookSecret(e.target.value)} />
              <button className="mini-btn primary" disabled={notifyBusy || (!hookUrl.trim() && !notify?.configured)} onClick={saveNotify}>保存</button>
            </div>
            <div className="smeta">群设置 → 群机器人 → 添加「自定义机器人」获取 webhook；安全设置勾「签名校验」则把密钥一并填入。告警阈值在上方「告警 ·」系列数值项里调。</div>
          </div>
        </>
      )}
      <ClonePricingSection toast={toast} isSuper={isSuper} />
      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
    </>
  );
}

export function SayingsView({ toast }: { toast: (m: string) => void }) {

  const [adding, setAdding] = useState('');
  const res = useResource(api.sayings, []);
  const list = res.data ?? [];
  const load = () => res.reload();
  const strip = (s: string) => s.replace(/<[^>]+>/g, '');
  return (
    <>
      <PageHead k="say" res={res} badge={`${list.filter((x) => x.enabled).length}/${list.length} 启用`} />
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

export function SurveyView() {
  const res = useResource(api.survey, []);
  const list = res.data ?? [];
  return (
    <>
      <PageHead k="form" res={res} badge={`${list.length} 题`} />
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

// 多运营账户管理（仅 owner 可见）：新增 operator、按 agent 授权、停用、重置密码。
export function AccountsView({ toast }: { toast: (m: string) => void }) {
  const [agents, setAgents] = useState<{ key: string; name: string }[]>([]);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', role: 'operator', agentKeys: [] as string[] });
  const [editId, setEditId] = useState<string | null>(null);
  const [editKeys, setEditKeys] = useState<string[]>([]);
  const res = useResource(api.accounts, []);
  const list = res.data ?? [];
  const load = async () => res.reload();
  useEffect(() => { api.agents().then((a) => setAgents(a.map((x) => ({ key: x.key, name: x.name })))).catch(() => { /* agent 列表失败只影响授权勾选 */ }); }, []);
  const toggleKey = (keys: string[], k: string) => keys.includes(k) ? keys.filter((x) => x !== k) : [...keys, k];

  const create = async () => {
    if (!/^[a-zA-Z0-9_.-]{2,40}$/.test(form.username)) return toast('账号 2-40 位字母/数字/._-');
    if (form.password.length < 6) return toast('密码至少 6 位');
    try {
      await api.createAccount({ username: form.username, password: form.password, role: form.role, agentKeys: form.role === 'owner' ? undefined : form.agentKeys });
      setAdding(false); setForm({ username: '', password: '', role: 'operator', agentKeys: [] }); await load(); toast('已新增账户');
    } catch (e) { toast((e as Error)?.message || '新增失败'); }
  };
  const toggleDisabled = async (a: AdminAccountItem) => { try { await api.updateAccount(a.id, { disabled: !a.disabled }); await load(); toast(a.disabled ? '已启用' : '已停用'); } catch (e) { toast((e as Error)?.message || '操作失败'); } };
  // 重置密码原先走 window.prompt：新密码以明文回显在系统弹窗里、无长度校验反馈、回车即提交。
  const resetPw = (a: AdminAccountItem) => setConfirmSpec({
    title: '重置登录密码',
    desc: '为该运营账户设置新密码（至少 6 位）。设置后需用新密码重新登录。',
    echo: [{ k: '账号', v: a.username }, { k: '角色', v: a.role }],
    reason: { label: '新密码（≥6 位）', required: true, maxLength: 64, secret: true },
    confirmText: '重置密码',
    onConfirm: async (pw) => {
      if (pw.length < 6) throw new Error('密码至少 6 位');
      await api.updateAccount(a.id, { password: pw });
      toast('密码已重置');
    },
  });
  const saveKeys = async (a: AdminAccountItem) => { try { await api.updateAccount(a.id, { agentKeys: editKeys }); setEditId(null); await load(); toast('负责 agent 已更新'); } catch (e) { toast((e as Error)?.message || '保存失败'); } };

  return (
    <>
      <PageHead k="account" res={res} badge={`${list.length} 个`} />
      <div className="pad">
        {/* GET /admin/accounts 本身就是 requireSuper：被降权的运营（或 me() 没取到角色时）
            会拿到 403，这里必须显示成「没有权限」而不是「加载失败」。 */}
        {res.error && <ErrorState msg={res.error} onRetry={res.reload} forbidden={res.forbidden} />}
        {!adding ? (
          <button className="add-btn full" onClick={() => setAdding(true)}><Icon name="spark" size={15} /> 新增运营账户</button>
        ) : (
          <div className="crd new-agent">
            <div className="ai-field"><div className="ai-fl">账号</div><input className="ai-input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="如 zhangsan" /></div>
            <div className="ai-field"><div className="ai-fl">初始密码（≥6 位）</div><input className="ai-input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
            <div className="ai-field"><div className="ai-fl">角色</div>
              <div className="bill-seg">{(['operator', 'owner'] as const).map((r) => <div key={r} className={`bill-opt ${form.role === r ? 'on' : ''}`} onClick={() => setForm({ ...form, role: r })}><div className="bo-t">{r === 'owner' ? 'owner 超管' : 'operator 运营'}</div><div className="bo-d">{r === 'owner' ? '可管账户 · 见全部 agent' : '仅负责选定 agent'}</div></div>)}</div>
            </div>
            {form.role !== 'owner' && (
              <div className="ai-field"><div className="ai-fl">负责的 agent（可多选）</div>
                <div className="mem-list">{agents.map((a) => <div key={a.key} className="mem-card"><div className="mb"><div className="mt">{a.name}</div><div className="mm">{a.key}</div></div><div className={`sw ${form.agentKeys.includes(a.key) ? 'on' : ''}`} onClick={() => setForm({ ...form, agentKeys: toggleKey(form.agentKeys, a.key) })}><i /></div></div>)}</div>
              </div>
            )}
            <div className="ai-actions"><button className="ai-btn ghost" onClick={() => setAdding(false)}>取消</button><button className="ai-btn primary" onClick={create}><Icon name="check" size={14} /> 创建</button></div>
          </div>
        )}
        {list.map((a) => (
          <div key={a.id} className="crd">
            <div className="crd-row">
              <span className="crd-ic"><Icon name="user" size={18} /></span>
              <div className="crd-b">
                <div className="ct">{a.username} <span className="tag">{a.role}</span> {a.disabled && <span className="tag off">停用</span>}</div>
                <div className="cs">{a.role === 'owner' ? '全部 agent' : (a.agentKeys.length ? `负责 ${a.agentKeys.length} 个 agent` : '未分配 agent')} · {a.lastLoginAt ? '最近登录 ' + fmtTime(a.lastLoginAt) : '从未登录'}</div>
              </div>
            </div>
            {a.role !== 'owner' && (editId === a.id ? (
              <div style={{ marginTop: 8 }}>
                <div className="mem-list">{agents.map((ag) => <div key={ag.key} className="mem-card"><div className="mb"><div className="mt">{ag.name}</div><div className="mm">{ag.key}</div></div><div className={`sw ${editKeys.includes(ag.key) ? 'on' : ''}`} onClick={() => setEditKeys(toggleKey(editKeys, ag.key))}><i /></div></div>)}</div>
                <div className="ai-actions"><button className="ai-btn ghost" onClick={() => setEditId(null)}>取消</button><button className="ai-btn primary" onClick={() => saveKeys(a)}><Icon name="check" size={14} /> 保存</button></div>
              </div>
            ) : (
              <div className="crd-actions" style={{ marginTop: 8 }}>
                <button className="mini-btn" onClick={() => { setEditId(a.id); setEditKeys(a.agentKeys); }}>分配 agent</button>
                <button className="mini-btn" onClick={() => resetPw(a)}>重置密码</button>
                <button className={`mini-btn ${a.disabled ? 'primary' : 'danger'}`} onClick={() => toggleDisabled(a)}>{a.disabled ? '启用' : '停用'}</button>
              </div>
            ))}
          </div>
        ))}
      </div>
      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
    </>
  );
}
