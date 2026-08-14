// 主公区：账户总览 + 方案概览 + 算力账本。
// 账户、统计、谶语、档案完整度均来自真实接口；微信支付仍交给既有移动 H5 支付页处理。

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../hooks/useStore';
import {
  api, type Me, type MyCreditItem, type PlanOption, type ProgressView, type StrategicProfileView, type WorkbenchView,
} from '../../services/api';
import { platform } from '../../services/platform';
import { requireAuth } from '../authBridge';
import { Empty } from '../Chrome';
import { mobileHashUrl } from '../mobile';
import type { PcState } from '../state';
import { chatKeyOf } from './sessions';
import './lord.scss';

const TIAN_GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const DI_ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];

function ganZhiYear(y?: number | null) {
  if (typeof y !== 'number' || !Number.isFinite(y)) return '';
  return `${TIAN_GAN[((y - 4) % 10 + 10) % 10]}${DI_ZHI[((y - 4) % 12 + 12) % 12]}`;
}

function verseLines(verse: string): string[] {
  const out: string[] = [];
  verse.split(/[，,。.；;、！!？?｜|/\s]+/).forEach((seg) => {
    const chars = Array.from(seg.trim());
    if (!chars.length) return;
    if (chars.length > 8) for (let i = 0; i < chars.length; i += 7) out.push(chars.slice(i, i + 7).join(''));
    else out.push(chars.join(''));
  });
  return out.slice(0, 4);
}

function maturityPct(m?: string) {
  if (m === 'ready') return 85;
  if (m === 'forming') return 55;
  return 20;
}

function maskPhone(phone?: string) {
  return phone && /^1\d{10}$/.test(phone) ? `${phone.slice(0, 3)}****${phone.slice(7)}` : '未绑定';
}

function powerLine(me: Me | null) {
  if (!me) return '—';
  if (me.usage?.unlimited) return '不限量';
  const balance = me.creditBalance < 0 ? '余不限量' : `余 ${me.creditBalance}`;
  return `已用 ${me.usage?.usagePercent ?? 0}% · ${balance}`;
}

function openMobile(path: string) {
  window.open(mobileHashUrl(path), '_blank', 'noopener');
}

// 大数展示（与手机端算力明细同口径）：1 万起走「万」、1 亿起走「亿」，去掉无意义的 .0。
function fmtBig(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n >= 1e8) return `${(n / 1e8).toFixed(1).replace(/\.0$/, '')}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1).replace(/\.0$/, '')}万`;
  return String(Math.round(n));
}

function openGeneral(st: PcState, prompt?: string) {
  if (prompt) st.setChatDraft(prompt);
  st.go('sessions');
  st.setChatKey(chatKeyOf({ kind: 'agent', agentKey: 'general' }));
}

interface LordData {
  library: number;
  projects: number;
  reports: number;
  progress: ProgressView | null;
  strategic: StrategicProfileView | null;
  workbench: WorkbenchView | null;
  loading: boolean;
  failed: boolean;
  load: () => Promise<void>;
}

function useLordData(): LordData {
  const s = useStore();
  const authed = s.isAuthed();
  const [library, setLibrary] = useState(0);
  const [projects, setProjects] = useState(0);
  const [reports, setReports] = useState(0);
  const [progress, setProgress] = useState<ProgressView | null>(null);
  const [strategic, setStrategic] = useState<StrategicProfileView | null>(null);
  const [workbench, setWorkbench] = useState<WorkbenchView | null>(null);
  const [loading, setLoading] = useState(authed);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!s.isAuthed()) { setLoading(false); return; }
    setLoading(true); setFailed(false);
    const settled = await Promise.allSettled([
      api.library(), api.projects(), api.reports(), api.progress(), api.strategicProfile(), api.workbench(), s.loadMe(),
    ]);
    const [lib, proj, rep, prog, strategicResult, wb] = settled;
    if (lib.status === 'fulfilled') setLibrary(lib.value.length);
    if (proj.status === 'fulfilled') setProjects(proj.value.length);
    if (rep.status === 'fulfilled') setReports(rep.value.length);
    if (prog.status === 'fulfilled') setProgress(prog.value.progress);
    if (strategicResult.status === 'fulfilled') setStrategic(strategicResult.value.strategic);
    if (wb.status === 'fulfilled') setWorkbench(wb.value);
    const essentialOk = [lib, proj, rep].some((x) => x.status === 'fulfilled');
    if (!essentialOk) setFailed(true);
    setLoading(false);
  }, [s]);

  useEffect(() => { void load(); }, [load, authed]);
  return { library, projects, reports, progress, strategic, workbench, loading, failed, load };
}

function Guest({ st }: { st: PcState }) {
  const rows = [
    ['方案与价格', () => st.setView('plans')],
    ['军师能力目录', () => { st.go('think'); st.setView('modules'); }],
    ['用户协议', () => platform.navigate('/packages/main/legal/index?doc=agreement')],
    ['隐私政策', () => platform.navigate('/packages/main/legal/index?doc=privacy')],
  ] as const;
  return (
    <div className="pc-page pc-lord-page">
      <section className="pc-lord-guest"><span>公</span><div className="pc-lord-eyebrow">账户 · 权益 · 战略档案</div><h1>这里放你自己的东西</h1><p>登录后查看会员权益、年度谶语、战略段位和个人档案。</p><button type="button" className="pc-btn pc-primary" onClick={() => requireAuth('profile')}>登录</button></section>
      <section className="pc-lord-guest-links">{rows.map(([t, go]) => <button type="button" key={t} onClick={go}><b>{t}</b><span>→</span></button>)}</section>
    </div>
  );
}

function VerseBand({ strategic, fortuneOn }: { strategic: StrategicProfileView | null; fortuneOn: boolean }) {
  if (!fortuneOn) return null;
  const verse = (strategic?.verse || '').trim();
  const moments = strategic?.verseMoments ?? [];
  const last = moments[moments.length - 1];
  return verse ? (
    <div className="pc-lord-verse">
      <div className="pc-lord-verse-head"><span>年 度 谶 语</span><em>{ganZhiYear(strategic?.verseYear) ? `${ganZhiYear(strategic?.verseYear)}年 · 军师赠` : '军师赠'}</em></div>
      <div className="pc-lord-verse-lines">{verseLines(verse).map((x) => <b key={x}>{x}</b>)}</div>
      <small>{last ? `已点谶 ${moments.length} 次 · 最近：${last.note}` : '岁末逐句对账'}</small>
    </div>
  ) : (
    <button type="button" className="pc-lord-verse pc-lord-verse-empty" onClick={() => platform.navigate('/packages/work/mingpan/index')}><b>年度谶语 · 你还没有今年的谶</b><span>去命盘领一句 →</span></button>
  );
}

function AccountCard({ data, st }: { data: LordData; st: PcState }) {
  const s = useStore();
  const me = s.me();
  const svc = me?.service;
  const copyWechat = async () => {
    if (!svc?.teacherWechat) { st.say('服务老师分配后开放'); return; }
    try { await navigator.clipboard.writeText(svc.teacherWechat); st.say('老师微信号已复制'); }
    catch { st.say(`老师微信：${svc.teacherWechat}`); }
  };
  return (
    <section className="pc-lord-account-card">
      <div className="pc-lord-user-row">
        <button type="button" className="pc-lord-avatar" onClick={() => platform.navigate('/packages/main/settings/index')} style={me?.user.avatarUrl ? { backgroundImage: `url(${me.user.avatarUrl})` } : undefined}>{!me?.user.avatarUrl && (me?.user.name?.[0] || '公')}</button>
        <div className="pc-lord-user-copy"><h1>{me?.user.name || '完善你的资料'}</h1><p>{[me?.tenant.name, me?.tenant.industry].filter(Boolean).join(' · ') || '公司与行业待补'}</p></div>
        <button type="button" className="pc-lord-member" onClick={() => st.setView('plans')}>{me?.plan?.name || '尚未开通'} <span>→</span></button>
      </div>
      <div className="pc-lord-meta"><span>手机 <b>{maskPhone(me?.user.phone)}</b></span><span>邀请码 <b>{me?.inviteCode || '—'}</b></span>{me?.planStatus?.expiresAt && <span>有效期 <b>{new Date(me.planStatus.expiresAt).toLocaleDateString('zh-CN')}</b></span>}</div>
      <div className="pc-lord-benefits">
        <button type="button" onClick={() => st.setView('credits')}><b>算力</b><span>{powerLine(me)}</span></button>
        <button type="button" onClick={() => platform.navigate('/packages/work/dossier/index')}><b>深度报告</b><span>军师执笔 · 完整履历</span></button>
        <button type="button" onClick={() => platform.navigate('/packages/work/enterprise/index')}><b>企业服务</b><span>工商 / 财税 / 商标</span></button>
      </div>
      <div className="pc-lord-service-row">
        <button type="button" onClick={() => { void copyWechat(); }}><i>微</i><span><b>{svc ? `${svc.teacherName}微信` : '老师微信'}</b><small>{svc?.teacherWechat || '待分配 · 去申请分班'}</small></span><em>{svc ? '复制' : '→'}</em></button>
        <button type="button" onClick={() => platform.navigate('/packages/work/community/index')}><i>群</i><span><b>班级群</b><small>{svc ? `${svc.className} · 服务中` : '待分配 · 去申请分班'}</small></span><em>→</em></button>
      </div>
      <VerseBand strategic={data.strategic} fortuneOn={s.fortuneOn()} />
    </section>
  );
}

function Stats({ data, st }: { data: LordData; st: PcState }) {
  const me = useStore().me();
  return <section className="pc-lord-stats"><button type="button" onClick={() => platform.navigate('/packages/work/projects/index')}><b>{data.projects}</b><span>案卷</span><em>战略项目</em></button><button type="button" onClick={() => { st.go('think'); st.setView('reports'); }}><b>{data.library + data.reports}</b><span>方案</span><em>历史版本</em></button><button type="button" onClick={() => { st.go('think'); st.setView('assets'); }}><b>{me?.understanding?.evidenceCount.knowledge ?? 0}</b><span>资料</span><em>已入知识库</em></button></section>;
}

interface MenuRow { ic: string; title: string; sub: string; value?: string; go: () => void }

function MenuGroup({ title, rows }: { title: string; rows: MenuRow[] }) {
  return <section className="pc-lord-menu-group"><div className="pc-lord-menu-label">{title}</div><div className="pc-lord-menu">{rows.map((r) => <button type="button" key={r.title} onClick={r.go}><i>{r.ic}</i><span><b>{r.title}</b><small>{r.sub}</small></span>{r.value && <em>{r.value}</em>}<strong>›</strong></button>)}</div></section>;
}

function Overview({ data, st }: { data: LordData; st: PcState }) {
  const s = useStore();
  const me = s.me();
  const completeness = data.workbench?.completeness ?? maturityPct(me?.understanding?.maturity);
  const missing = data.workbench?.missing ?? [];
  const openWorkbench = () => st.setDrawer({
    kicker: '案 卷 档 案', title: '个人 / 企业档案', quote: `当前档案完整度 ${completeness}%`,
    blocks: [
      ...(data.workbench?.sections ?? []).map((x) => ({ label: x.label, title: x.ready ? `${x.count} 份 · 可用` : `${x.count} 份 · 待补`, body: x.hint })),
      ...(missing.length ? [{ label: '当 前 最 该 补', title: `${missing.length} 项`, body: missing.map((x, i) => `${i + 1}. ${x.title}\n${x.desc}`).join('\n') }] : []),
    ],
    actions: [{ t: missing.some((x) => x.key.startsWith('next-')) ? '去回答关键问题' : '去案卷资产补资料', primary: true, go: () => {
      st.closeDrawer();
      const q = missing.find((x) => x.key.startsWith('next-'));
      if (q) openGeneral(st, `请只追问并帮我补清这条案卷事实：${q.title}`);
      else { st.go('think'); st.setView('assets'); }
    } }],
  });
  const fortune = s.fortuneOn();
  const menus: { title: string; rows: MenuRow[] }[] = [
    { title: '档 案', rows: [
      { ic: '档', title: '个人 / 企业档案', sub: '案卷完整度与待补事实', value: missing.length ? `待补 ${missing.length} 项` : `${completeness}%`, go: openWorkbench },
      { ic: '构', title: '公司与事业架构', sub: '多主体与业务关系', value: '待建立', go: () => platform.navigate('/packages/work/architecture/index') },
      ...(fortune ? [{ ic: '命', title: '命盘报告 · 八字紫微印证', sub: '命理只调节奏，不替代经营事实', go: () => platform.navigate('/packages/work/mingpan/index') }] : []),
      { ic: '脉', title: '人脉圈与持续记忆', sub: '关系与承诺清单', value: '未开通', go: () => platform.navigate('/packages/work/relations/index') },
      { ic: '账', title: '战略账本 · 决策与天机', sub: '判断结果持续验证', value: '决策记录', go: () => platform.navigate('/packages/work/ledger/index') },
    ] },
    { title: '资 产', rows: [
      { ic: '图', title: '我的作品库', sub: '历史成品图', value: '海报', go: () => platform.navigate('/packages/work/gallery/index') },
      { ic: '牌', title: '我的品牌资产', sub: '数字人 / 短视频素材', go: () => platform.navigate('/packages/work/brandkit/index') },
      { ic: '数', title: '数据授权与隐私', sub: '逐项授权、暂停与删除', go: () => platform.navigate('/packages/work/bindings/index') },
    ] },
    { title: '系 统', rows: [
      { ic: '醒', title: '提醒与日历', sub: '军令、复盘与周报节奏', value: me?.service ? '已配置' : '', go: () => platform.navigate('/packages/work/reminders/index') },
      { ic: '设', title: '设置 · 资料与偏好', sub: '资料、本命色与隐私', go: () => platform.navigate('/packages/main/settings/index') },
      { ic: '模', title: '模块管理', sub: '添加 / 隐藏能力', go: () => { st.go('think'); st.setView('modules'); } },
      { ic: '退', title: '退出登录', sub: '退出当前账号', go: async () => { const ok = await platform.confirm({ title: '退出登录', content: '确定退出当前账号？' }); if (ok) { s.logout(); st.go('sessions'); } } },
    ] },
  ];
  return (
    <div className="pc-page pc-lord-page">
      <AccountCard data={data} st={st} />
      <Stats data={data} st={st} />
      {data.progress && (data.progress.streak >= 3 || data.progress.usageDays >= 14) && <button type="button" className="pc-lord-rank" onClick={() => platform.navigate('/packages/work/ledger/index')}><i>{data.progress.rank.slice(0, 1)}</i><span><b>战略段位 · {data.progress.rank}</b><small>连续复盘 {data.progress.streak} 天 · 使用第 {data.progress.usageDays} 天{data.progress.decisionAccuracy !== null ? ` · 决策准确率 ${data.progress.decisionAccuracy}%` : ' · 先打满 5 个验证'}</small></span><em>{data.progress.nextRank ? `下一段位 ${data.progress.nextRank.rank}` : '查看战略账本'} →</em></button>}
      <div className="pc-lord-menu-grid">{menus.map((g) => <MenuGroup key={g.title} title={g.title} rows={g.rows} />)}</div>
    </div>
  );
}

function Plans({ st }: { st: PcState }) {
  const s = useStore();
  const [rows, setRows] = useState<PlanOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setFailed(false);
    try { setRows((await api.planOptions()).options); }
    catch (e) { s.handleApiError(e, { silent: true }); setFailed(true); }
    finally { setLoading(false); }
  }, [s]);
  useEffect(() => { if (s.isAuthed()) void load(); else { api.plans().then((plans) => setRows(plans.map((plan) => ({ plan, relation: 'available', action: 'buy', canPurchase: true })))).catch(() => setFailed(true)).finally(() => setLoading(false)); } }, [load, s]);
  const action = (x: PlanOption) => ({ current: '当前方案', renew: '续费', upgrade: '升级', billing_change: '切换周期', downgrade: '调整方案', enterprise: '联系顾问', available: '选择方案' }[x.relation] || '查看方案');
  return (
    <div className="pc-page pc-lord-page">
      <section className="pc-lord-subhero"><div className="pc-lord-eyebrow">方案与权益</div><h1>按阶段选择军师的陪伴深度</h1><p>PC 先看清权益；涉及微信支付或签约时，会在新标签打开现有安全支付页。</p></section>
      {loading ? <div className="pc-lord-plan-grid pc-loading"><i /><i /><i /></div> : failed ? <Empty glyph="权" title="方案没有取到" sub="检查网络后重试" /> : <div className="pc-lord-plan-grid">{rows.map((x) => {
        const canAct = x.relation !== 'current' && (x.canPurchase || x.action === 'contact' || x.action === 'remind');
        return <article key={x.plan.id} className={`${x.recommended ? 'pc-recommended' : ''}${x.relation === 'current' ? ' pc-current' : ''}`}><div className="pc-lord-plan-top"><span>{x.recommended ? '推荐' : x.plan.period === 'year' ? '年付' : '月付'}</span>{x.relation === 'current' && <em>当前方案</em>}</div><h2>{x.plan.name}</h2><div className="pc-lord-price">{x.plan.price < 0 ? '面议' : <><b>¥{(x.plan.price / 100).toFixed(x.plan.price % 100 ? 2 : 0)}</b><span>/{x.plan.period === 'year' ? '年' : '月'}</span></>}</div><p>{x.plan.usageLabel} · {x.plan.agentCount} 位军师</p><ul>{x.plan.featuresJson.slice(0, 5).map((f) => <li key={f}>✓ {f}</li>)}</ul><button type="button" disabled={!canAct} onClick={() => x.relation === 'enterprise' ? openMobile('/packages/work/enterprise/index') : openMobile('/packages/work/plans/index')}>{canAct ? action(x) : x.relation === 'current' ? '当前方案' : '暂不可调整'}</button>{x.reason && <small>{x.reason}</small>}</article>;
      })}</div>}
      <button type="button" className="pc-lord-back" onClick={() => st.setView('overview')}>← 返回主公总览</button>
    </div>
  );
}

function Credits({ st }: { st: PcState }) {
  const s = useStore();
  const [items, setItems] = useState<MyCreditItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!s.isAuthed()) { setLoading(false); return; }
    api.myCredits().then((r) => setItems(r.items)).catch((e) => { s.handleApiError(e, { silent: true }); setFailed(true); }).finally(() => setLoading(false));
  }, [s]);
  const me = s.me();
  // 增购算力剩余（永久有效直到用完）：usage 与 tokenQuota 同义，旧服务端两处都缺 → 0 → 不显示。
  const packLeft = me?.usage?.packRemaining ?? me?.tokenQuota?.packRemaining ?? 0;
  if (!s.isAuthed()) return <Guest st={st} />;
  return (
    <div className="pc-page pc-lord-page">
      <section className="pc-lord-credit-hero"><div><div className="pc-lord-eyebrow">算力账本</div><h1>{me?.creditBalance && me.creditBalance < 0 ? '不限量' : me?.creditBalance ?? 0}</h1><p>当前可见算力余额 · 本月已用 {me?.usage?.usagePercent ?? 0}%{packLeft > 0 ? ` · 增购算力剩余 ${fmtBig(packLeft)}` : ''}</p></div><div className="pc-lord-credit-acts">{/* PC 只做展示与导流：增购下单仍走手机端安全支付页 */}<button type="button" className="pc-btn" onClick={() => openMobile('/packages/work/credits/index')}>去增购</button><button type="button" className="pc-btn" onClick={() => st.setView('plans')}>查看方案</button></div></section>
      <section className="pc-lord-credit-list"><header><span>时间</span><span>事由</span><span>变动</span><span>余额</span></header>{loading ? <div className="pc-lord-credit-empty">正在读取账本…</div> : failed ? <div className="pc-lord-credit-empty">账本没有取到，请稍后重试。</div> : items.length ? items.map((x, i) => <div key={`${x.at}-${i}`}><span>{new Date(x.at).toLocaleString('zh-CN', { hour12: false })}</span><b>{x.reason}</b><em className={x.delta >= 0 ? 'pc-plus' : ''}>{x.delta >= 0 ? '+' : ''}{x.delta}</em><strong>{x.balance < 0 ? '不限量' : x.balance}</strong></div>) : <div className="pc-lord-credit-empty">还没有算力变动记录。</div>}</section>
      <button type="button" className="pc-lord-back" onClick={() => st.setView('overview')}>← 返回主公总览</button>
    </div>
  );
}

export default function LordMain({ st }: { st: PcState }) {
  const s = useStore();
  const data = useLordData();
  if (st.view === 'plans') return <Plans st={st} />;
  if (st.view === 'credits') return <Credits st={st} />;
  if (!s.isAuthed()) return <Guest st={st} />;
  if (data.loading && !s.me()) return <div className="pc-page pc-lord-page"><div className="pc-lord-skeleton"><i /><i /><i /></div></div>;
  if (data.failed && !s.me()) return <div className="pc-page pc-lord-page"><Empty glyph="公" title="主公档案没有取到" sub="检查网络后再试" /><button type="button" className="pc-btn pc-primary pc-lord-retry" onClick={() => { void data.load(); }}>重新加载</button></div>;
  return <Overview data={data} st={st} />;
}
