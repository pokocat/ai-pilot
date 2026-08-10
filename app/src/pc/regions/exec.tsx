// 点兵区：今日军令 / 周计划 / 复盘。
// 真实写入全部复用 services/dossier 与现有账本接口；唯一缺口是「军令改期」，界面明确标施工中。

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../hooks/useStore';
import {
  api, type BizMetricTemplateItem, type DecisionView, type ForceKind, type ReminderItem,
  type ReviewLogItem,
} from '../../services/api';
import { pickDecisionToVerify } from '../../services/decisionPick';
import { platform } from '../../services/platform';
import {
  addOrder, buildReviewPrompt, ordersOf, recentOrders, refreshDossier, removeOrder, saveBackfill,
  saveBizMetrics, saveGoals, setOrderResult, startReview, thisMonday, today, todayProgress, toggleOrder,
  type DailyBackfill, type Dossier, type DossierOrder,
} from './execModel';
import { requireAuth } from '../authBridge';
import { Empty } from '../Chrome';
import type { PcState } from '../state';
import { portraitOf } from '../portraits';
import { chatKeyOf } from './sessions';
import './exec.scss';

export const EXEC_EXPORT_EVENT = 'junshi:pc-exec-export';

const FORCE_LABEL: Record<ForceKind, string> = { sky: '天势', market: '市势', people: '人势' };
type ForceVerdict = 'on' | 'off';

function dateLabel(iso: string) {
  if (iso === today()) return '今天';
  const [, m, d] = iso.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

function dueLabel(raw?: string | null) {
  if (!raw) return '—';
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function openChat(st: PcState, agentKey: string, prompt?: string, fresh = false) {
  if (prompt) st.setChatDraft(prompt);
  st.go('sessions');
  st.setChatKey(chatKeyOf({ kind: fresh ? 'fresh' : 'agent', agentKey }));
}

function SectionHead({ kicker, title, aside }: { kicker: string; title: string; aside?: React.ReactNode }) {
  return <div className="pc-exec-section-head"><div><span>{kicker}</span><h2>{title}</h2></div>{aside}</div>;
}

interface ExecData {
  dossier: Dossier | null;
  reminders: ReminderItem[];
  reviews: ReviewLogItem[];
  streak: number;
  decision: DecisionView | null;
  metricTemplate: BizMetricTemplateItem[];
  metricValues: Record<string, string>;
  setMetricValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  loading: boolean;
  failed: boolean;
  load: () => Promise<void>;
  setDossier: React.Dispatch<React.SetStateAction<Dossier | null>>;
  setDecision: React.Dispatch<React.SetStateAction<DecisionView | null>>;
}

function useExecData(): ExecData {
  const s = useStore();
  const authed = s.isAuthed();
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [reminders, setReminders] = useState<ReminderItem[]>([]);
  const [reviews, setReviews] = useState<ReviewLogItem[]>([]);
  const [streak, setStreak] = useState(0);
  const [decision, setDecision] = useState<DecisionView | null>(null);
  const [metricTemplate, setMetricTemplate] = useState<BizMetricTemplateItem[]>([]);
  const [metricValues, setMetricValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(authed);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!s.isAuthed()) {
      setDossier(null); setReminders([]); setReviews([]); setDecision(null); setLoading(false); return;
    }
    setLoading(true); setFailed(false);
    try {
      const [d, reminderView, reviewView, decisions, tmpl, series] = await Promise.all([
        refreshDossier(), api.reminders(), api.reviews(), api.decisions(), api.bizMetricTemplate(), api.bizMetricSeries(8),
      ]);
      setDossier(d);
      setReminders(reminderView.items);
      setReviews(reviewView.items);
      setStreak(reviewView.streak);
      setDecision(pickDecisionToVerify(decisions.items));
      setMetricTemplate(tmpl.items);
      const current = series.items.find((x) => x.weekStart === thisMonday());
      setMetricValues(Object.fromEntries(tmpl.items.map((m) => [m.metricKey, current?.metrics[m.metricKey] == null ? '' : String(current.metrics[m.metricKey])] )));
    } catch (e) {
      s.handleApiError(e, { silent: true }); setFailed(true);
      // 案卷是点兵主数据。联表接口中一个失败时再单独抢救它，不能让提醒挂了拖成整屏空白。
      const d = await refreshDossier();
      setDossier(d);
    } finally { setLoading(false); }
  }, [s]);

  useEffect(() => { void load(); }, [load, authed]);
  return { dossier, reminders, reviews, streak, decision, metricTemplate, metricValues, setMetricValues, loading, failed, load, setDossier, setDecision };
}

function GuestExec() {
  return (
    <div className="pc-page pc-exec-page">
      <div className="pc-exec-guest">
        <span>兵</span><div className="pc-exec-eyebrow">今日军令 · 私人执行台</div>
        <h1>登录后再点兵</h1><p>军令、经营回填与复盘都属于你的战略案卷，不在游客态展示。</p>
        <button type="button" className="pc-btn pc-primary" onClick={() => requireAuth('execute')}>登录查看军令</button>
      </div>
    </div>
  );
}

function CampaignDeck({ data, st }: { data: ExecData; st: PcState }) {
  const progress = todayProgress(data.dossier);
  const todayRows = ordersOf(data.dossier, today());
  const first = todayRows.find((x) => !x.done);
  const reminder = data.reminders.find((x) => x.kind === 'review');
  return (
    <section className="pc-exec-deck">
      <article className="pc-exec-campaign pc-main-campaign">
        <span className="pc-exec-card-glyph">战</span><div className="pc-exec-eyebrow">今日战役 · {dateLabel(today())}</div>
        <h2>{data.dossier?.title || '还没有战略案卷'}</h2>
        <div className="pc-exec-progress"><i style={{ width: `${progress.percent}%` }} /></div>
        <p>{progress.done}/{progress.total} 条已完成 · {progress.percent}%</p>
      </article>
      <article className="pc-exec-campaign">
        <div className="pc-exec-eyebrow">军师献策</div><h3>{first ? '先拿下第一条未办军令' : '今天的军令已清'}</h3>
        <p>{first?.text || '把战果回填进去，就可以开始复盘。'}</p>
        <button type="button" onClick={() => first ? openChat(st, 'general', `请帮我把这条军令拆成执行步骤：${first.text}`) : st.setView('review')}>{first ? '帮我拆解 →' : '开始复盘 →'}</button>
      </article>
      <article className="pc-exec-campaign">
        <div className="pc-exec-eyebrow">今日主令</div><h3>{first?.text || '回填战果，结束今日执行'}</h3>
        <p>{first ? [first.ownerName && `负责人 ${first.ownerName}`, first.etaMinutes && `预计 ${first.etaMinutes} 分钟`].filter(Boolean).join(' · ') || first.from : '别让已完成的动作停在勾选框里。'}</p>
        <button type="button" onClick={() => first ? openChat(st, 'ip', `围绕这条军令帮我写可直接使用的执行脚本：${first.text}`) : st.setView('review')}>{first ? '帮我写脚本 →' : '去复盘 →'}</button>
      </article>
      <article className="pc-exec-campaign pc-remind-campaign">
        <div className="pc-exec-eyebrow">提醒节奏</div><h3>{reminder?.time || '每日复盘'}</h3>
        <p>{reminder?.desc || '收工前记录经营数据，再把今日偏差交给军师。'}</p>
        <button type="button" onClick={() => platform.navigate('/packages/work/reminders/index')}>管理提醒 →</button>
      </article>
    </section>
  );
}

function OrderTable({ data, st }: { data: ExecData; st: PcState }) {
  const s = useStore();
  const rows = ordersOf(data.dossier, today());
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [newOrder, setNewOrder] = useState('');
  const [filling, setFilling] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const ids = rows.filter((o) => selected[o.id]).map((o) => o.id);
  const all = rows.length > 0 && ids.length === rows.length;

  const reload = async () => data.setDossier(await refreshDossier());
  const toggle = async (o: DossierOrder) => {
    data.setDossier((cur) => cur ? { ...cur, orders: cur.orders.map((x) => x.id === o.id ? { ...x, done: !x.done } : x) } : cur);
    try { data.setDossier(await toggleOrder(o.id)); }
    catch (e) { s.handleApiError(e, { fallbackTitle: '军令状态未保存' }); await reload(); }
  };
  const add = async () => {
    if (!newOrder.trim()) return;
    if (!data.dossier) { st.say('先认可一份判断，生成战略案卷'); return; }
    setBusy(true);
    try { data.setDossier(await addOrder(newOrder)); setNewOrder(''); st.say('军令已加入今天'); }
    catch (e) { s.handleApiError(e, { fallbackTitle: '添加失败，请重试' }); }
    finally { setBusy(false); }
  };
  const remove = async (o: DossierOrder) => {
    const ok = await platform.confirm({ title: '删除军令', content: `确定删除“${o.text}”？`, confirmText: '删除' });
    if (!ok) return;
    try { data.setDossier(await removeOrder(o.id)); st.say('军令已删除'); }
    catch (e) { s.handleApiError(e, { fallbackTitle: '删除失败，请重试' }); }
  };
  const batchDone = async () => {
    const targets = rows.filter((o) => ids.includes(o.id) && !o.done);
    if (!targets.length) { st.say('选中的军令都已完成'); return; }
    setBusy(true);
    try { for (const o of targets) await toggleOrder(o.id); await reload(); setSelected({}); st.say(`已完成 ${targets.length} 条军令`); }
    catch (e) { s.handleApiError(e, { fallbackTitle: '部分军令未完成，请重试' }); await reload(); }
    finally { setBusy(false); }
  };
  const batchRemove = async () => {
    if (!ids.length) return;
    const ok = await platform.confirm({ title: '批量删除军令', content: `确定删除选中的 ${ids.length} 条军令？`, confirmText: '删除' });
    if (!ok) return;
    setBusy(true);
    try { for (const id of ids) await removeOrder(id); await reload(); setSelected({}); st.say(`已删除 ${ids.length} 条军令`); }
    catch (e) { s.handleApiError(e, { fallbackTitle: '部分军令未删除，请重试' }); await reload(); }
    finally { setBusy(false); }
  };
  const submitResult = async (id: string) => {
    const note = (filling[id] || '').trim();
    if (!note) { st.say('先填一句做完的量'); return; }
    try {
      data.setDossier(await setOrderResult(id, note));
      setFilling((cur) => { const n = { ...cur }; delete n[id]; return n; }); st.say('战果已回填');
    } catch (e) { s.handleApiError(e, { fallbackTitle: '战果未保存，请重试' }); }
  };
  const open = (o: DossierOrder) => st.setDrawer({
    kicker: '军 令 详 情', title: o.text, quote: o.sourceQuote || `来源：${o.from}`,
    blocks: [
      { label: '执 行 信 息', title: o.tag, body: [`负责人：${o.ownerName || '未指定'}`, `截止：${dueLabel(o.dueAt)}`, `预计：${o.etaMinutes == null ? '—' : `${o.etaMinutes} 分钟`}`].join('\n') },
      ...(o.steps?.length ? [{ label: '执 行 步 骤', title: `${o.steps.length} 步`, body: o.steps.map((x, i) => `${i + 1}. ${x}`).join('\n') }] : []),
      ...(o.metrics?.length ? [{ label: '验 收 指 标', title: '做完要留下结果', body: o.metrics.map((x) => `${x.label}：${x.value}`).join('\n') }] : []),
      ...(o.resultNote ? [{ label: '已 回 填 战 果', title: o.resultNote, body: '这条事实会进入复盘。' }] : []),
    ],
    actions: [
      { t: o.done ? '取消完成' : '标记完成', primary: !o.done, go: () => { st.closeDrawer(); void toggle(o); } },
      { t: '顺延到明天 · 施工中', go: () => st.say('顺延能力施工中，当前不会改动军令') },
      { t: '删除军令', danger: true, go: () => { st.closeDrawer(); void remove(o); } },
    ],
  });

  return (
    <section className="pc-exec-orders">
      <SectionHead kicker="COMMAND TABLE" title="今日军令" aside={<span className="pc-exec-count">{rows.filter((x) => !x.done).length} 条待执行</span>} />
      {ids.length > 0 && <div className="pc-exec-batch"><b>已选 {ids.length} 条</b><button type="button" onClick={() => { void batchDone(); }} disabled={busy}>批量完成</button><button type="button" onClick={() => st.say('顺延能力施工中，当前不会改动军令')}>顺延到明天 <em>施工中</em></button><button type="button" className="pc-danger" onClick={() => { void batchRemove(); }} disabled={busy}>删除</button><button type="button" onClick={() => setSelected({})}>取消选择</button></div>}
      <div className="pc-exec-table-wrap">
        <table className="pc-exec-table">
          <thead><tr><th><input type="checkbox" checked={all} onChange={(e) => setSelected(Object.fromEntries(rows.map((o) => [o.id, e.target.checked])))} /></th><th>军令</th><th>来源</th><th>负责人</th><th>截止</th><th>预计</th><th>状态</th><th /></tr></thead>
          <tbody>
            {rows.map((o) => <tr key={o.id} className={o.done ? 'pc-done' : ''} onDoubleClick={() => open(o)}>
              <td><input type="checkbox" checked={!!selected[o.id]} onChange={(e) => setSelected((cur) => ({ ...cur, [o.id]: e.target.checked }))} /></td>
              <td><button type="button" className="pc-exec-order-title" onClick={() => open(o)}>{o.text}</button>{o.resultNote && <small>战果：{o.resultNote}</small>}</td>
              <td><span className="pc-exec-tag">{o.from}</span></td><td>{o.ownerName || '—'}</td><td>{dueLabel(o.dueAt)}</td><td>{o.etaMinutes == null ? '—' : `${o.etaMinutes}m`}</td>
              <td><button type="button" className={`pc-exec-status${o.done ? ' pc-ok' : ''}`} onClick={() => { void toggle(o); }}>{o.done ? '已完成' : '待执行'}</button></td>
              <td><button type="button" className="pc-exec-more" onClick={(e) => st.openCtx(e, o.text, [
                { t: '查看详情', go: () => open(o) },
                { t: o.done ? '填写战果' : '标记完成', go: () => o.done ? setFilling((cur) => ({ ...cur, [o.id]: o.resultNote || '' })) : void toggle(o) },
                { t: '顺延到明天 · 施工中', go: () => st.say('顺延能力施工中，当前不会改动军令') },
                { t: '删除', danger: true, go: () => { void remove(o); } },
              ])}>•••</button></td>
            </tr>)}
            {!rows.length && <tr><td colSpan={8}><div className="pc-exec-table-empty">今天还没有军令。认可沙盘判断，或在下面手动加一条。</div></td></tr>}
          </tbody>
        </table>
      </div>
      {Object.entries(filling).map(([id, value]) => <div className="pc-exec-result" key={id}><b>回填战果</b><input value={value} maxLength={200} placeholder="例如：邀约发出 30 条，到店 12 人" onChange={(e) => setFilling((cur) => ({ ...cur, [id]: e.target.value }))} /><button type="button" className="pc-btn pc-primary" onClick={() => { void submitResult(id); }}>保存</button><button type="button" className="pc-btn" onClick={() => setFilling((cur) => { const n = { ...cur }; delete n[id]; return n; })}>取消</button></div>)}
      <div className="pc-exec-add"><span>＋</span><input value={newOrder} maxLength={120} placeholder="手动补一条今天要办的军令" onChange={(e) => setNewOrder(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} /><button type="button" className="pc-btn pc-primary" disabled={busy || !newOrder.trim()} onClick={() => { void add(); }}>加入今日</button></div>
    </section>
  );
}

function Backfill({ data, st }: { data: ExecData; st: PcState }) {
  const s = useStore();
  const saved = data.dossier?.backfill[today()];
  const [form, setForm] = useState<DailyBackfill>(() => saved || { leads: '', consults: '', deals: '' });
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (saved) setForm(saved); }, [saved?.savedAt]);
  const save = async () => {
    if (!data.dossier) { st.say('先生成战略案卷'); return; }
    setSaving(true);
    try { data.setDossier(await saveBackfill(form)); st.say('今日经营数据已记录'); }
    catch (e) { s.handleApiError(e, { fallbackTitle: '数据未保存，请重试' }); }
    finally { setSaving(false); }
  };
  return (
    <section className="pc-exec-backfill">
      <div><div className="pc-exec-eyebrow">今日经营回填</div><h2>留事实，不靠感觉复盘</h2><p>{saved?.savedAt ? '今天的数据已保存，可继续修正。' : '填 0 也比空着更有用。'}</p></div>
      {(['leads', 'consults', 'deals'] as const).map((k) => <label key={k}><span>{{ leads: '线索', consults: '咨询', deals: '成交' }[k]}</span><input inputMode="numeric" value={form[k]} placeholder="0" onChange={(e) => setForm((cur) => ({ ...cur, [k]: e.target.value.replace(/[^0-9.]/g, '') }))} /></label>)}
      <button type="button" className="pc-btn pc-primary" onClick={() => { void save(); }} disabled={saving}>{saving ? '保存中…' : '保存数据'}</button>
      <button type="button" className="pc-btn" onClick={() => st.setView('review')}>去复盘</button>
    </section>
  );
}

function CreativeGrid({ st }: { st: PcState }) {
  const s = useStore();
  const rows = s.agents().filter((a) => a.type === 'creative');
  if (!rows.length) return null;
  return (
    <section className="pc-exec-creative">
      <SectionHead kicker="CONTENT OUTPUT" title="内容出品" aside={<button type="button" className="pc-exec-text-btn" onClick={() => platform.navigate('/packages/work/gallery/index')}>作品库 →</button>} />
      <div className="pc-exec-creative-grid">{rows.map((a) => <button type="button" key={a.key} onClick={() => openChat(st, a.key)}><span className="pc-exec-creative-av">{portraitOf(a.key) ? <i style={{ backgroundImage: `url(${portraitOf(a.key)})` }} /> : a.name.slice(0, 1)}</span><span><b>{a.name}</b><small>{a.role}</small></span><em>{a.billing === 'unlock' && !a.owned ? '待解锁' : '立即出品'} →</em></button>)}</div>
    </section>
  );
}

function TodayView({ data, st }: { data: ExecData; st: PcState }) {
  const und = useStore().me()?.understanding;
  return (
    <div className="pc-page pc-exec-page">
      <CampaignDeck data={data} st={st} />
      <section className="pc-exec-command-zero">
        <div><span>第 0 号军令</span><h2>{und?.nextQuestions?.[0] || '案卷关键事实已经够用'}</h2><p>{und?.nextQuestions?.length ? '先把这条补清，后面的执行才不会建立在假设上。' : '继续按今天的正式军令推进。'}</p></div>
        {und?.nextQuestions?.length ? <button type="button" className="pc-btn pc-primary" onClick={() => openChat(st, 'general', `请只追问并帮我补清这条案卷事实：${und.nextQuestions[0]}`, true)}>现在补清</button> : <span className="pc-exec-zero-ok">已对齐</span>}
      </section>
      <OrderTable data={data} st={st} />
      <Backfill data={data} st={st} />
      <CreativeGrid st={st} />
    </div>
  );
}

const GOAL_FIELDS = [
  ['weekly', '本周'], ['quarterly', '季度'], ['annual', '年度'], ['longTerm', '3-5年'],
] as const;

function WeekView({ data, st }: { data: ExecData; st: PcState }) {
  const s = useStore();
  const groups = recentOrders(data.dossier);
  const [goals, setGoals] = useState<Record<string, string>>(() => Object.fromEntries(GOAL_FIELDS.map(([k]) => [k, data.dossier?.goals?.[k] || ''])));
  const [saving, setSaving] = useState(false);
  useEffect(() => setGoals(Object.fromEntries(GOAL_FIELDS.map(([k]) => [k, data.dossier?.goals?.[k] || '']))), [data.dossier?.goals?.updatedAt]);
  const save = async () => {
    if (!data.dossier) { st.say('先生成战略案卷'); return; }
    setSaving(true);
    try { data.setDossier(await saveGoals(goals)); st.say('目标阶梯已保存'); }
    catch (e) { s.handleApiError(e, { fallbackTitle: '目标未保存，请重试' }); }
    finally { setSaving(false); }
  };
  return (
    <div className="pc-page pc-exec-page">
      <section className="pc-exec-week-hero"><div><div className="pc-exec-eyebrow">目标阶梯</div><h1>从本周军令，一路对齐长期目标</h1><p>四层目标可直接编辑；保存后写回战略案卷。</p></div><button type="button" className="pc-btn pc-primary" onClick={() => { void save(); }} disabled={saving}>{saving ? '保存中…' : '保存目标'}</button></section>
      <div className="pc-exec-goals">{GOAL_FIELDS.map(([key, label], i) => <label key={key}><span>{String(i + 1).padStart(2, '0')} · {label}</span><textarea value={goals[key]} placeholder={`${label}目标待补`} onChange={(e) => setGoals((cur) => ({ ...cur, [key]: e.target.value }))} /></label>)}</div>
      <SectionHead kicker="LAST 7 DAYS" title="近 7 天军令记录" aside={<span className="pc-exec-count">{groups.reduce((n, g) => n + g.orders.length, 0)} 条</span>} />
      {groups.length ? <div className="pc-exec-week-list">{groups.map((g) => <section key={g.date}><header><div><b>{dateLabel(g.date)}</b><span>{g.date}</span></div><em>{g.orders.filter((o) => o.done).length}/{g.orders.length} 已完成</em></header>{g.orders.map((o) => <button type="button" key={o.id} onClick={() => st.setDrawer({ kicker: '军 令 记 录', title: o.text, quote: `${g.date} · ${o.from}`, blocks: [{ label: '执行结果', title: o.done ? '已完成' : '未完成', body: o.resultNote || '没有回填战果' }] })}><i className={o.done ? 'pc-on' : ''}>{o.done ? '✓' : ''}</i><span><b>{o.text}</b><small>{o.from}{o.resultNote ? ` · ${o.resultNote}` : ''}</small></span></button>)}</section>)}</div> : <div className="pc-exec-soft-empty">近 7 天还没有军令记录。</div>}
    </div>
  );
}

function MetricsForm({ data, st }: { data: ExecData; st: PcState }) {
  const s = useStore();
  const [saving, setSaving] = useState(false);
  if (!data.metricTemplate.length) return <div className="pc-exec-soft-empty">当前行业还没有配置经营周报指标。</div>;
  const save = async () => {
    setSaving(true);
    const values = Object.fromEntries(data.metricTemplate.map((m) => [m.metricKey, Number(data.metricValues[m.metricKey] || 0)]));
    try { await saveBizMetrics(thisMonday(), values); st.say('本周经营数据已保存'); }
    catch (e) { s.handleApiError(e, { fallbackTitle: '周报未保存，请重试' }); }
    finally { setSaving(false); }
  };
  return <div className="pc-exec-metric-form">{data.metricTemplate.map((m) => <label key={m.metricKey}><span>{m.metricName}<em>{m.unit}</em></span><input inputMode="decimal" value={data.metricValues[m.metricKey] || ''} placeholder="0" onChange={(e) => data.setMetricValues((cur) => ({ ...cur, [m.metricKey]: e.target.value.replace(/[^0-9.-]/g, '') }))} /></label>)}<button type="button" className="pc-btn pc-primary" onClick={() => { void save(); }} disabled={saving}>{saving ? '保存中…' : '保存本周数据'}</button></div>;
}

function ReviewView({ data, st }: { data: ExecData; st: PcState }) {
  const s = useStore();
  const forces = s.me()?.understanding?.battleForces ?? [];
  const [verdict, setVerdict] = useState<Record<string, ForceVerdict>>({});
  const [decisionNote, setDecisionNote] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [starting, setStarting] = useState(false);
  const verify = async (outcome: 'correct' | 'revise') => {
    if (!data.decision || verifying) return;
    setVerifying(true);
    try { await api.verifyDecision(data.decision.id, outcome, decisionNote); data.setDecision(null); st.say(outcome === 'correct' ? '已记为应验' : '已记为需要修正'); }
    catch (e) { s.handleApiError(e, { fallbackTitle: '验证未保存，请重试' }); }
    finally { setVerifying(false); }
  };
  const begin = async () => {
    if (!data.dossier) { st.say('先生成战略案卷'); return; }
    setStarting(true);
    const extra = forces.flatMap((f) => verdict[f.kind] ? [`${FORCE_LABEL[f.kind]}复盘自评：${verdict[f.kind] === 'on' ? '今日动作符合判断' : '今日动作偏离判断'}（当前判断：${f.conclusion}，打法：${f.tactic}）`] : []);
    await startReview('day');
    const prompt = buildReviewPrompt(data.dossier, extra);
    setStarting(false);
    openChat(st, 'operations', prompt);
  };
  const latest = [...data.reviews].sort((a, b) => a.date < b.date ? 1 : -1).slice(0, 5);
  return (
    <div className="pc-page pc-exec-page">
      <section className="pc-exec-review-hero"><div><div className="pc-exec-eyebrow">复盘台 · 连续 {data.streak} 天</div><h1>先对势，再对事，最后看结果</h1><p>三势自评、决策验证和经营数据都会带进经营参谋的复盘上下文。</p></div><button type="button" className="pc-btn pc-primary" onClick={() => { void begin(); }} disabled={starting}>{starting ? '准备中…' : '带着事实开始复盘'}</button></section>
      <div className="pc-exec-review-grid">
        <section className="pc-exec-review-card"><SectionHead kicker="FORCE CHECK" title="三势检查" />{forces.length ? forces.map((f) => <div className="pc-exec-force-check" key={f.kind}><div><b>{FORCE_LABEL[f.kind]} · {f.conclusion}</b><span>{f.tactic}</span></div><button type="button" className={verdict[f.kind] === 'on' ? 'pc-on' : ''} onClick={() => setVerdict((cur) => ({ ...cur, [f.kind]: 'on' }))}>符合</button><button type="button" className={verdict[f.kind] === 'off' ? 'pc-off' : ''} onClick={() => setVerdict((cur) => ({ ...cur, [f.kind]: 'off' }))}>偏了</button></div>) : <p className="pc-exec-muted">沙盘还没有三势判断，本次复盘只看执行与经营结果。</p>}</section>
        <section className="pc-exec-review-card"><SectionHead kicker="DECISION VERIFY" title="决策验证" />{data.decision ? <><div className="pc-exec-decision-title">{data.decision.decision}</div><p>{data.decision.verifyStandard || data.decision.expected}</p><textarea value={decisionNote} placeholder="补一句验证依据（可选）" onChange={(e) => setDecisionNote(e.target.value)} /><div className="pc-exec-review-actions"><button type="button" className="pc-btn pc-primary" onClick={() => { void verify('correct'); }} disabled={verifying}>应验</button><button type="button" className="pc-btn" onClick={() => { void verify('revise'); }} disabled={verifying}>需修正</button></div></> : <p className="pc-exec-muted">当前没有待验证决策。</p>}</section>
      </div>
      <section className="pc-exec-review-card pc-exec-metrics-card"><SectionHead kicker={`WEEKLY DATA · ${thisMonday()}`} title="本周经营数据" /><MetricsForm data={data} st={st} /></section>
      <div className="pc-exec-review-grid pc-exec-review-low">
        <section className="pc-exec-review-card"><SectionHead kicker="RECENT REVIEWS" title="最近复盘" />{latest.length ? latest.map((r) => <div className="pc-exec-review-row" key={r.id || `${r.date}-${r.layer}`}><span>{r.date}</span><b>{r.ordersDone ?? 0}/{r.ordersTotal ?? 0} 军令</b><em>{r.hasBackfill ? '有数据' : '未回填'}</em></div>) : <p className="pc-exec-muted">还没有复盘记录，今天可以开始第一轮。</p>}</section>
        <section className="pc-exec-review-card"><SectionHead kicker="RHYTHM" title="提醒节奏" />{data.reminders.length ? data.reminders.map((r) => <button type="button" className="pc-exec-reminder-row" key={r.key} onClick={() => platform.navigate('/packages/work/reminders/index')}><span>{r.time}</span><b>{r.title}</b><em>{r.subscribed ? '已订阅' : '未订阅'}</em></button>) : <p className="pc-exec-muted">提醒尚未配置。</p>}</section>
      </div>
    </div>
  );
}

function downloadOrders(dossier: Dossier | null, st: PcState) {
  const rows = ordersOf(dossier, today());
  if (!rows.length) { st.say('今天没有可导出的军令'); return; }
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['军令,来源,负责人,截止,预计分钟,状态,战果', ...rows.map((o) => [o.text, o.from, o.ownerName || '', o.dueAt || '', o.etaMinutes ?? '', o.done ? '已完成' : '待执行', o.resultNote || ''].map(esc).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `军师-今日军令-${today()}.csv`; a.click(); URL.revokeObjectURL(url);
  st.say('今日军令已导出');
}

export default function ExecMain({ st }: { st: PcState }) {
  const s = useStore();
  const data = useExecData();
  useEffect(() => {
    const fn = () => downloadOrders(data.dossier, st);
    window.addEventListener(EXEC_EXPORT_EVENT, fn);
    return () => window.removeEventListener(EXEC_EXPORT_EVENT, fn);
  }, [data.dossier, st]);

  if (!s.isAuthed()) return <GuestExec />;
  if (data.loading && !data.dossier) return <div className="pc-page pc-exec-page"><div className="pc-exec-skeleton"><i /><i /><i /><i /></div></div>;
  if (data.failed && !data.dossier) return <div className="pc-page pc-exec-page"><Empty glyph="兵" title="点兵台没有取到" sub="检查网络后再试" /><button type="button" className="pc-btn pc-primary pc-exec-retry" onClick={() => { void data.load(); }}>重新加载</button></div>;
  const body = st.view === 'week' ? <WeekView data={data} st={st} /> : st.view === 'review' ? <ReviewView data={data} st={st} /> : <TodayView data={data} st={st} />;
  return body;
}
