// 沙盘区：经营战局 / 时运策 / 命盘分析。
//
// 经营结论只读 /me.understanding 与战略案卷；三势只读 battleForces；命理只读
// /profile/chart，并且先过 /me.features.fortune。桌面稿没有覆盖的两张命理工作台延续同一套
// 「深色判断卡 + 证据卡 + 行动落点」语言，但不编任何结论填空。

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../hooks/useStore';
import {
  api, type BattleForce, type ChartSummary, type DecisionView, type ForceKind,
} from '../../services/api';
import { pickDecisionToVerify } from '../../services/decisionPick';
import { platform } from '../../services/platform';
import { refreshDossier, today, type Dossier } from '../../services/dossier';
import { requireAuth } from '../authBridge';
import { Empty } from '../Chrome';
import type { PcState } from '../state';
import { chatKeyOf } from './sessions';
import './sand.scss';

export const SAND_REFRESH_EVENT = 'junshi:pc-sand-refresh';

const FORCE_KIND: Record<ForceKind, string> = { sky: '天势', market: '市势', people: '人势' };
const FORCE_LEVEL: Record<BattleForce['level'], string> = { strong: '强', mid: '中', weak: '弱' };
const PHASE_WORD: Record<string, string> = { 进攻: '攻', 防守: '守', 平稳: '稳中蓄力' };

function currentMonth(chart: ChartSummary) {
  const month = new Date().getMonth() + 1;
  return chart.monthlyOutlook.months.find((x) => x.month === month) ?? null;
}

function pillars(chart: ChartSummary): string[] {
  const p = chart.pillars;
  const rows = [p.year.ganZhi, p.month.ganZhi, p.day.ganZhi];
  if (chart.hourKnown && p.time) rows.push(p.time.ganZhi);
  return rows;
}

function forceSynthesis(forces: BattleForce[]) {
  const strong = forces.find((f) => f.level === 'strong');
  const weak = forces.find((f) => f.level === 'weak');
  const head = [strong ? `${FORCE_KIND[strong.kind]}可借` : '', weak ? `${FORCE_KIND[weak.kind]}宜守` : '']
    .filter(Boolean).join('，');
  return {
    title: `合参结论：${head || '因势而动'}`,
    body: `${forces.map((f) => `${FORCE_KIND[f.kind]}${f.tactic}`).join('；')}。先把优势用足，别在弱项上硬扩。`,
  };
}

function openGeneral(st: PcState, fresh = false) {
  st.go('sessions');
  st.setChatKey(chatKeyOf({ kind: fresh ? 'fresh' : 'agent', agentKey: 'general' }));
}

function Metric({ value, label, onClick }: { value: string; label: string; onClick?: () => void }) {
  const body = <><span className="pc-sand-metric-v">{value}</span><span className="pc-sand-metric-l">{label}</span></>;
  return onClick
    ? <button type="button" className="pc-sand-metric" onClick={onClick}>{body}</button>
    : <div className="pc-sand-metric">{body}</div>;
}

function SectionHead({ kicker, title, aside }: { kicker: string; title: string; aside?: React.ReactNode }) {
  return (
    <div className="pc-sand-section-head">
      <div><div className="pc-sand-section-k">{kicker}</div><h2>{title}</h2></div>
      {aside}
    </div>
  );
}

function Forces({ rows, st }: { rows: BattleForce[]; st: PcState }) {
  const openAll = () => {
    const synth = forceSynthesis(rows);
    st.setDrawer({
      kicker: '三 势 全 解',
      title: '天势 · 市势 · 人势',
      quote: '三势只调打法与节奏，不替代经营事实。',
      blocks: rows.map((f) => ({
        label: `${FORCE_KIND[f.kind]} · ${FORCE_LEVEL[f.level]}`,
        title: `${f.conclusion}，${f.tactic}`,
        body: f.note,
        tactic: `打法：${f.tactic}`,
      })),
      synthesis: synth,
      actions: [{ t: '带着结论问总军师', primary: true, go: () => { st.closeDrawer(); openGeneral(st); } }],
    });
  };

  if (!rows.length) {
    return (
      <div className="pc-sand-card pc-sand-force-empty">
        <span className="pc-sand-watermark">势</span>
        <strong>三势还没有形成</strong>
        <p>案卷与经营事实还不够，先补一轮关键访谈，再让军师重算。</p>
        <button type="button" className="pc-btn pc-primary" onClick={() => openGeneral(st, true)}>开始补问</button>
      </div>
    );
  }

  return (
    <div className="pc-sand-forces">
      {rows.map((f) => (
        <button type="button" className={`pc-sand-force pc-${f.tacticTone}`} key={f.kind} onClick={openAll}>
          <span className="pc-sand-force-top"><b>{FORCE_KIND[f.kind]}</b><em>{FORCE_LEVEL[f.level]}</em></span>
          <span className="pc-sand-force-title">{f.conclusion}</span>
          <span className="pc-sand-force-note">{f.note}</span>
          <span className="pc-sand-force-track"><i style={{ width: `${Math.max(0, Math.min(100, f.strength))}%` }} /></span>
          <span className="pc-sand-force-tactic">{f.tactic} <i>→</i></span>
        </button>
      ))}
    </div>
  );
}

function Business({ st, data, refresh, refreshing }: {
  st: PcState;
  data: ReturnType<typeof useSandData>;
  refresh: () => Promise<void>;
  refreshing: boolean;
}) {
  const s = useStore();
  const me = s.me();
  const und = me?.understanding;
  const { dossier, decision, saying } = data;
  const judgment = und?.mainContradiction || und?.summary || dossier?.judgment || '';
  const forces = und?.battleForces ?? [];
  const gaps = und?.nextQuestions ?? [];
  const risks = dossier?.risks ?? [];
  const maturity = !und ? '—' : und.maturity === 'ready' ? '可用' : und.maturity === 'forming' ? '整理中' : '待建档';
  const evidence = und?.evidenceCount;
  const evidenceRows = [
    { k: '会话', v: evidence?.sessions ?? 0, go: () => openGeneral(st) },
    { k: '档案', v: evidence?.profile ?? 0, go: () => platform.navigate('/packages/main/brief/index') },
    { k: '项目', v: evidence?.projects ?? 0, go: () => st.go('think') },
    { k: '知识', v: evidence?.knowledge ?? 0, go: () => { st.go('think'); st.setView('assets'); } },
    { k: '记忆', v: evidence?.memories ?? 0, go: () => platform.navigate('/packages/main/brief/index?tab=memory') },
  ];
  const backfill = dossier?.backfill[today()];
  const [committing, setCommitting] = useState(false);

  const commit = async () => {
    if (!requireAuth('execute') || committing) return;
    setCommitting(true);
    try {
      const result = await api.battleCommit();
      await Promise.all([s.loadMe(), refreshDossier()]);
      st.say(result.alreadyDone ? '今天的判断已经生成过军令' : `已生成 ${result.newOrders} 条军令`);
      st.go('exec');
    } catch (e) {
      s.handleApiError(e, { fallbackTitle: '生成军令失败，请重试' });
    } finally { setCommitting(false); }
  };

  if (!s.isAuthed()) {
    return (
      <div className="pc-page pc-sand-page">
        <div className="pc-sand-guest">
          <span className="pc-sand-watermark">盘</span>
          <div className="pc-sand-eyebrow">经营战局 · 个人判断</div>
          <h1>先让军师认得你，沙盘才会有真结论</h1>
          <p>登录后读取你的案卷、会话与经营回填，形成主要矛盾和三势判断。</p>
          <button type="button" className="pc-btn pc-primary" onClick={() => requireAuth('profile')}>登录查看我的沙盘</button>
        </div>
      </div>
    );
  }

  return (
    <div className="pc-page pc-sand-page">
      <section className="pc-sand-hero">
        <div className="pc-sand-hero-copy">
          <div className="pc-sand-eyebrow">主要矛盾 · {dossier?.title || und?.title || '战略案卷'}</div>
          <h1>{judgment || '还缺足够证据，暂不下判断'}</h1>
          <p>{judgment ? '这是军师基于当前案卷形成的阶段判断，资料与经营结果变化后会随之调整。' : '先回答案卷里最关键的缺口，军师再给出三势与打法。'}</p>
          <div className="pc-sand-hero-actions">
            <button type="button" className="pc-sand-link-light" onClick={() => openGeneral(st)}>带着判断继续问 →</button>
            <button type="button" className="pc-sand-link-light" onClick={() => { void refresh(); }} disabled={refreshing}>{refreshing ? '正在刷新…' : '重新推演'}</button>
          </div>
        </div>
        <div className="pc-sand-hero-seal">军师<br />参谋部</div>
      </section>

      <section className="pc-sand-metrics">
        <Metric value={maturity} label="案卷成熟度" onClick={() => platform.navigate('/packages/main/brief/index')} />
        <Metric value={String(gaps.length)} label="待补关键事实" onClick={() => openGeneral(st, true)} />
        <Metric value={String(risks.length)} label="当前风险锁" />
      </section>

      <div className="pc-sand-grid pc-sand-grid-main">
        <section>
          <SectionHead kicker="THREE FORCES" title="三势判断" aside={<button type="button" className="pc-sand-text-btn" onClick={() => { void refresh(); }}>刷新判断</button>} />
          <Forces rows={forces} st={st} />
        </section>
        <section>
          <SectionHead kicker="EVIDENCE" title="判断依据" />
          <div className="pc-sand-card pc-sand-evidence">
            <div className="pc-sand-chips">
              {evidenceRows.map((it) => <button type="button" key={it.k} onClick={it.go}><b>{it.v}</b>{it.k}</button>)}
            </div>
            <div className="pc-sand-divider" />
            <div className="pc-sand-card-label">现在最该补</div>
            {gaps.length ? gaps.slice(0, 3).map((q, i) => (
              <button type="button" className="pc-sand-question" key={q} onClick={() => openGeneral(st, true)}>
                <span>{String(i + 1).padStart(2, '0')}</span><b>{q}</b><i>→</i>
              </button>
            )) : <p className="pc-sand-muted">关键事实已够用，继续用经营回填验证判断。</p>}
          </div>
        </section>
      </div>

      <div className="pc-sand-grid pc-sand-grid-low">
        <section className="pc-sand-card pc-sand-decision">
          <div className="pc-sand-card-label">决策日志 · 待验证</div>
          {decision ? <>
            <h3>{decision.decision}</h3>
            <p>{decision.verifyStandard || decision.expected}</p>
            <div><span>{decision.verifyByDate ? `验证日 ${decision.verifyByDate}` : '尚未设置验证日'}</span><button type="button" onClick={() => platform.navigate('/packages/work/ledger/index')}>去验证 →</button></div>
          </> : <>
            <h3>当前没有待验证决策</h3>
            <p>认可判断后，重要决策会进入账本等待结果验证。</p>
            <div><span>让判断经得起结果</span><button type="button" onClick={() => platform.navigate('/packages/work/ledger/index')}>打开账本 →</button></div>
          </>}
        </section>
        <section className="pc-sand-card pc-sand-kpi">
          <div className="pc-sand-card-label">今日经营回填</div>
          <div className="pc-sand-kpi-row">
            <div><b>{backfill?.leads || '—'}</b><span>线索</span></div>
            <div><b>{backfill?.consults || '—'}</b><span>咨询</span></div>
            <div><b>{backfill?.deals || '—'}</b><span>成交</span></div>
          </div>
          <button type="button" className="pc-sand-text-btn" onClick={() => st.go('exec')}>{backfill?.savedAt ? '查看今日执行 →' : '去点兵回填 →'}</button>
        </section>
      </div>

      {risks.length > 0 && (
        <section className="pc-sand-risk">
          <div className="pc-sand-card-label">现在不能做</div>
          <div>{risks.slice(0, 3).map((r) => <span key={r}>× {r}</span>)}</div>
        </section>
      )}

      <section className="pc-sand-commit">
        <div><span>{saying?.date || today()}</span><q>{saying?.text?.replace(/<\/?em>/g, '') || '先立于不败，再等对手露出破绽。'}</q></div>
        <button type="button" onClick={() => { void commit(); }} disabled={committing || !judgment}>{committing ? '正在生成…' : '认可此判断，生成今日军令'} <i>→</i></button>
      </section>
    </div>
  );
}

function FortuneGate({ st }: { st: PcState }) {
  const s = useStore();
  return (
    <div className="pc-page pc-sand-page">
      <div className="pc-sand-guest pc-sand-fortune-gate">
        <span className="pc-sand-watermark">时</span>
        <div className="pc-sand-eyebrow">命理视角 · 由你决定是否启用</div>
        <h1>{s.isAuthed() ? '当前未启用命理视角' : '登录后查看你的时运与命盘'}</h1>
        <p>命理只用来调节经营节奏，不替代经营数据与现实判断。</p>
        <button type="button" className="pc-btn pc-primary" onClick={() => s.isAuthed() ? platform.navigate('/packages/main/settings/index') : requireAuth('profile')}>
          {s.isAuthed() ? '去设置' : '登录'}
        </button>
        <button type="button" className="pc-sand-text-btn" onClick={() => st.setView('business')}>回经营战局</button>
      </div>
    </div>
  );
}

function NoChart({ st }: { st: PcState }) {
  return (
    <div className="pc-sand-card pc-sand-no-chart">
      <span className="pc-sand-watermark">命</span>
      <div className="pc-sand-eyebrow">待补生辰</div>
      <h1>还没有可用命盘</h1>
      <p>补全出生日期、时辰与出生地后，系统才会生成确定性的排盘结果。</p>
      <button type="button" className="pc-btn pc-primary" onClick={() => platform.navigate('/packages/work/mingpan/index')}>补录并排盘</button>
      <button type="button" className="pc-sand-text-btn" onClick={() => st.setView('business')}>先看经营战局</button>
    </div>
  );
}

function Timing({ st, chart }: { st: PcState; chart: ChartSummary | null }) {
  if (!chart) return <div className="pc-page pc-sand-page"><NoChart st={st} /></div>;
  const month = currentMonth(chart);
  const turn = chart.monthlyOutlook.months.filter((m) => m.turning).map((m) => `${m.month}月`);
  const phase = month ? (PHASE_WORD[month.phase] || month.phase) : '稳';
  return (
    <div className="pc-page pc-sand-page">
      <section className="pc-sand-fortune-hero">
        <div className="pc-sand-eyebrow">时运策 · 已授权</div>
        <h1>本月宜{phase}</h1>
        <p>{chart.pattern.name} · {chart.pattern.traits}</p>
        <span>{new Date().getMonth() + 1}月节奏</span>
      </section>
      <div className="pc-sand-grid pc-sand-fortune-grid">
        <section className="pc-sand-card pc-sand-month-card">
          <div className="pc-sand-card-label">本月攻守</div>
          <b>{month?.phase || '平稳'}</b>
          <p>{month?.turning ? '当前正处在全年拐点月，重要动作先设验证点。' : '按当前排盘节奏推进，经营判断仍以真实数据为准。'}</p>
        </section>
        <section className="pc-sand-card pc-sand-turn-card">
          <div className="pc-sand-card-label">全年拐点</div>
          <b>{turn.length ? turn.join(' · ') : '暂无明显拐点月'}</b>
          <p>拐点代表节奏需要重看，不代表结果会自动发生。</p>
        </section>
      </div>
      <section className="pc-sand-card pc-sand-suits">
        <div><span>宜</span>{chart.pattern.suits.length ? chart.pattern.suits.map((x) => <b key={x}>{x}</b>) : <b>稳住主线</b>}</div>
        <div><span>避</span>{chart.pattern.avoid.length ? chart.pattern.avoid.map((x) => <b key={x}>{x}</b>) : <b>盲目扩张</b>}</div>
      </section>
      <section className="pc-sand-action-band">
        <div><div className="pc-sand-card-label">落到经营动作</div><h2>把时机判断带回今日军令</h2><p>时运只调顺序与强度，真正执行仍回到点兵台。</p></div>
        <button type="button" className="pc-btn pc-primary" onClick={() => st.go('exec')}>去点兵</button>
        <button type="button" className="pc-btn" onClick={() => platform.navigate('/packages/work/calendar/index')}>打开天时日历</button>
      </section>
    </div>
  );
}

function Destiny({ st, chart }: { st: PcState; chart: ChartSummary | null }) {
  if (!chart) return <div className="pc-page pc-sand-page"><NoChart st={st} /></div>;
  const ps = pillars(chart);
  const labels = ['年柱', '月柱', '日柱', '时柱'];
  return (
    <div className="pc-page pc-sand-page">
      <section className="pc-sand-destiny-hero">
        <div>
          <div className="pc-sand-eyebrow">命盘分析 · 已授权</div>
          <h1>{chart.dayMaster.gan}日主 · {chart.dayMaster.element}</h1>
          <p>{chart.pattern.name} · {chart.dayMaster.strengthLevel || chart.dayMaster.strength}</p>
        </div>
        <div className="pc-sand-pillar-row">{ps.map((p, i) => <div key={`${p}-${i}`}><span>{labels[i]}</span><b>{p}</b></div>)}</div>
      </section>
      <div className="pc-sand-grid pc-sand-destiny-grid">
        <section className="pc-sand-card"><div className="pc-sand-card-label">格局</div><h2>{chart.pattern.name}</h2><p>{chart.pattern.traits}</p>{chart.pattern.basis && <small>{chart.pattern.basis}</small>}</section>
        <section className="pc-sand-card"><div className="pc-sand-card-label">喜用与调候</div><h2>{chart.favorableElements?.join(' · ') || '待完整排盘'}</h2><p>{chart.tiaoHou?.gods?.length ? `调候：${chart.tiaoHou.gods.join('、')}` : '用于理解稳定偏好，不作为独立决策依据。'}</p></section>
        <section className="pc-sand-card"><div className="pc-sand-card-label">紫微印证</div><h2>{chart.ziwei?.soulMajorStars?.join(' · ') || '暂无紫微信息'}</h2><p>{chart.ziwei?.bodyMajorStars?.length ? `身宫：${chart.ziwei.bodyMajorStars.join('、')}` : '时辰未知时不展示紫微主星。'}</p></section>
      </div>
      <section className="pc-sand-action-band">
        <div><div className="pc-sand-card-label">完整命盘</div><h2>查看十神、宫位与综合印证</h2><p>详细命盘在独立页面展开，沙盘只保留经营所需摘要。</p></div>
        <button type="button" className="pc-btn pc-primary" onClick={() => platform.navigate('/packages/work/mingpan/index')}>打开完整命盘</button>
        <button type="button" className="pc-btn" onClick={() => st.setView('business')}>回经营战局</button>
      </section>
    </div>
  );
}

function useSandData() {
  const s = useStore();
  const authed = s.isAuthed();
  const fortune = authed && s.fortuneOn();
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [chart, setChart] = useState<ChartSummary | null>(null);
  const [decision, setDecision] = useState<DecisionView | null>(null);
  const [saying, setSaying] = useState<{ text: string; date: string } | null>(null);
  const [loading, setLoading] = useState(authed);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!s.isAuthed()) { setDossier(null); setChart(null); setDecision(null); setLoading(false); return; }
    setLoading(true); setFailed(false);
    const jobs: Promise<unknown>[] = [
      refreshDossier().then(setDossier),
      s.loadMe(),
      api.decisions().then((r) => setDecision(pickDecisionToVerify(r.items))).catch(() => setDecision(null)),
    ];
    if (s.fortuneOn()) jobs.push(api.myChart().then((r) => setChart(r.chart)).catch(() => setChart(null)));
    else setChart(null);
    try { await Promise.all(jobs); } catch (e) { s.handleApiError(e, { silent: true }); setFailed(true); }
    finally { setLoading(false); }
  }, [s]);

  useEffect(() => { void load(); }, [load, authed, fortune]);
  useEffect(() => { api.todaySaying().then(setSaying).catch(() => setSaying(null)); }, []);
  return { dossier, chart, decision, saying, loading, failed, load };
}

export default function SandMain({ st }: { st: PcState }) {
  const s = useStore();
  const data = useSandData();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    if (!requireAuth('profile') || refreshing) return;
    setRefreshing(true);
    try {
      await api.refreshForces();
      await data.load();
      st.say('沙盘已更新');
    } catch (e) { s.handleApiError(e, { fallbackTitle: '刷新失败，请重试' }); }
    finally { setRefreshing(false); }
  }, [data, refreshing, s, st]);

  useEffect(() => {
    const fn = () => { void refresh(); };
    window.addEventListener(SAND_REFRESH_EVENT, fn);
    return () => window.removeEventListener(SAND_REFRESH_EVENT, fn);
  }, [refresh]);

  if (data.loading && s.isAuthed() && !s.me()?.understanding) {
    return <div className="pc-page pc-sand-page"><div className="pc-sand-skeleton"><i /><i /><i /><i /></div></div>;
  }
  if (data.failed && !s.me()?.understanding) {
    return <div className="pc-page pc-sand-page"><Empty glyph="盘" title="沙盘没有取到" sub="检查网络后再试" /><button type="button" className="pc-btn pc-primary pc-sand-retry" onClick={() => { void data.load(); }}>重新加载</button></div>;
  }

  const view = st.view;
  let body: JSX.Element;
  if ((view === 'timing' || view === 'destiny') && (!s.isAuthed() || !s.fortuneOn())) body = <FortuneGate st={st} />;
  else if (view === 'timing') body = <Timing st={st} chart={data.chart} />;
  else if (view === 'destiny') body = <Destiny st={st} chart={data.chart} />;
  else body = <Business st={st} data={data} refresh={refresh} refreshing={refreshing} />;
  return body;
}
