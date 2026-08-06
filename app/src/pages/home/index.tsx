import { useEffect, useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import TabHeader from '../../components/TabHeader';
import Login from '../../components/Login';
import GuestNotice from '../../components/GuestNotice';
import AsyncState from '../../components/AsyncState';
import PaySheet from '../../components/PaySheet';
import ExceptionSheet from '../../components/ExceptionSheet';
import Sheet from '../../components/Sheet';
import CoachMarks from '../../components/CoachMarks';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api, type BattleForce, type ForceKind, type ChartSummary, type DecisionView } from '../../services/api';
import type { AuthReason } from '../../services/authGate';
import { MODULE_MARKET } from '../../data/operatingSystem';
import { refreshDossier, type Dossier } from '../../services/dossier';
import { navTo, switchTo } from '../../services/nav';
import { REVIEW_TIME } from '../../data/constants';
import { ARCHIVE_INTERVIEW_PROMPT, archiveAnswerPrompt } from '../../data/intents';
import { pickDecisionToVerify } from '../../services/decisionPick';
import './index.scss';

function todayLabel() {
  const d = new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// 本地「今天」key（按天幂等：认可判断一天一次，返回首页即回显已生成态）
function dayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}
const COMMIT_KEY = 'junshi.battleCommitted';

// 把 "<em>...</em>" 渲染为强调色片段（跨端，避免 dangerouslySetInnerHTML）
function SayingLine({ html, accent }: { html: string; accent: string }) {
  const parts = html.split(/(<em>.*?<\/em>)/g).filter(Boolean);
  return (
    <Text className="say-line serif">
      {parts.map((p, i) => {
        const m = p.match(/^<em>(.*?)<\/em>$/);
        return m ? (
          <Text key={i} style={{ color: accent, fontWeight: 700 }}>{m[1]}</Text>
        ) : (
          <Text key={i}>{p}</Text>
        );
      })}
    </Text>
  );
}

// V7-04 三势结构化渲染的静态映射（天势/市势/人势 · 强/中/弱）。
const FORCE_KIND_LABEL: Record<ForceKind, string> = { sky: '天势', market: '市势', people: '人势' };
const FORCE_LEVEL_LABEL: Record<BattleForce['level'], string> = { strong: '强', mid: '中', weak: '弱' };
// 三势全解逐条：一律从真实 BattleForce 字段派生，不预置任何结论文案（P0-3：资料不足走空态引导对话）。
function forceRead(f: BattleForce): { label: string; title: string; body: string; tactic: string } {
  const label = `${FORCE_KIND_LABEL[f.kind]} · ${FORCE_LEVEL_LABEL[f.level]}`;
  return { label, title: `${f.conclusion}，${f.tactic}`, body: f.note, tactic: `打法：${f.tactic}` };
}
// 天势接命盘（三势·天势）：攻守词表 —— phase 短古风词，克制不抢戏。
const PHASE_WORD: Record<string, string> = { 进攻: '攻', 防守: '守', 平稳: '稳中蓄力' };
// 当前公历月的攻守（monthlyOutlook 按 month 匹配；跨年也只认月号）。
function currentMonthOutlook(chart: ChartSummary): ChartSummary['monthlyOutlook']['months'][number] | null {
  const m = new Date().getMonth() + 1;
  return chart.monthlyOutlook.months.find((x) => x.month === m) ?? null;
}
// 天势卡尾行：格局 · 本月宜攻/守/稳中蓄力（· 拐点月）。
function chartCardLine(chart: ChartSummary): string {
  const mo = currentMonthOutlook(chart);
  const word = mo ? PHASE_WORD[mo.phase] ?? mo.phase : '';
  return `${chart.pattern.name}${word ? ` · 本月宜${word}` : ''}${mo?.turning ? ' · 拐点月' : ''}`;
}
// 四柱一行（缺时辰只显示三柱）。
function chartFourPillars(chart: ChartSummary): string {
  const p = chart.pillars;
  const arr = [p.year.ganZhi, p.month.ganZhi, p.day.ganZhi];
  if (chart.hourKnown && p.time) arr.push(p.time.ganZhi);
  return arr.join(' ');
}
// 全年拐点月列表（无则「无」）。
function chartTurningMonths(chart: ChartSummary): string {
  const t = chart.monthlyOutlook.months.filter((m) => m.turning).map((m) => `${m.month}`);
  return t.length ? `${t.join('/')}月` : '无';
}

// 三视角 tab（新设计稿 battle-mode-tabs）：经营战局是主视角，另两个只调节奏，命理关时不渲染。
type BattleMode = 'business' | 'timing' | 'destiny';
const BATTLE_MODES: { key: BattleMode; label: string }[] = [
  { key: 'business', label: '经营战局' },
  { key: 'timing', label: '时运策' },
  { key: 'destiny', label: '命盘分析' },
];

function forceSynthesis(forces: BattleForce[]): { title: string; body: string } {
  const strong = forces.find((f) => f.level === 'strong');
  const weak = forces.find((f) => f.level === 'weak');
  const head = [strong ? `${FORCE_KIND_LABEL[strong.kind]}可借` : '', weak ? `${FORCE_KIND_LABEL[weak.kind]}宜守` : ''].filter(Boolean).join('，');
  return {
    title: `合参结论：${head || '因势而动'}`,
    body: `${forces.map((f) => `${FORCE_KIND_LABEL[f.kind]}${f.tactic}`).join('；')}。先把优势用足，别在弱项上硬扩。`,
  };
}

// 战局页 —— 对齐设计稿 page-battle：军师判断 hero → 信号指标 → 下一步卡 → 三势（真渲染 + 全解） → 动作 → 模块 → 不能做 → 认可 CTA（三态机）。
// 判断内容一律来自真实军师档案（me.understanding，含结构化 battleForces）与案卷；资料不足时引导进入对话访谈，不预置结论。
export default function Home() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [showLogin, setShowLogin] = useState(false);
  const [loginReason, setLoginReason] = useState<AuthReason>('chat');
  const [saying, setSaying] = useState<{ text: string; date: string }>({ text: '先把自己<em>立于不败</em>，再等对手露出破绽。', date: todayLabel() });
  const [dossier, setDossier] = useState<Dossier | null>(null);
  // 首帧水合标记（C2）：未完成首轮拉取前，hero 与三势区渲染骨架，避免兜底文案闪一帧再跳变。
  const [hydrated, setHydrated] = useState(() => !s.isAuthed());
  // V7-04：认可判断 CTA 三态机 + 三势全解 / 付费 / 异常 弹层开关
  const [cta, setCta] = useState<'idle' | 'generating' | 'done'>('idle');
  const [forcesOpen, setForcesOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [exceptionOpen, setExceptionOpen] = useState(false);
  // 主要矛盾卡：点击就地展开/收起全文（有判断时），而非跳对话
  const [heroExpanded, setHeroExpanded] = useState(false);
  // 天势接命盘：实时拉命盘摘要（不落库）。无命盘/命理关/404 → null，静默不打扰。
  const [chartRaw, setChartRaw] = useState<ChartSummary | null>(null);
  // 三视角（新设计稿 battle-mode-tabs）：经营战局 / 时运策 / 命盘分析。
  // 时运与命盘原来只藏在三势全解 sheet 的天势小节里，设计稿把它们提为与经营判断并列的视角——
  // 口径不变：它们只调节奏与优先级，不替代经营数据下的判断。
  const [modePick, setModePick] = useState<BattleMode>('business');
  // 决策日志 · 待验证（真实决策账本的最近一条 pending）：设计稿把它放在三势结论下面，作为「判断→验证」的闭环提示。
  const [pendingDecision, setPendingDecision] = useState<DecisionView | null>(null);
  const me = s.me();
  const fortuneOn = s.isAuthed() && s.fortuneOn(); // 游客只看经营战局；个人命盘与时运均在登录后展示
  // 生效视角由开关推导，而不是让 modePick 自己管：用户停在时运策/命盘分析时后端把命理开关关掉
  // （下一次 /me 回读就会变），只藏 tab 会留下一个还在屏上的命理面板，而把 modePick 当真又会让
  // 三个面板同时不满足条件、整页空白。推导成 business 一次把两种情况都收住。
  const mode: BattleMode = fortuneOn ? modePick : 'business';
  // 命盘数据同样过一遍开关：原来只靠服务端在命理关时拒发 /profile/chart，客户端自己不判，
  // 于是「已取到的 chart 还留在内存里 + 开关刚关」这一帧，天势卡尾行仍会印格局与本月攻守。
  // 命理下线要求的是 UI 层立刻不见（P0-2），不能只依赖接口不给数据。
  const chart: ChartSummary | null = fortuneOn ? chartRaw : null;
  const und = me?.understanding;
  // 三势一律来自真实军师档案（und.battleForces）；为空时走 force-empty 空态引导对话，绝不预置结论（P0-3）。
  const forces: BattleForce[] = und?.battleForces ?? [];

  useDidShow(() => {
    s.setTab(1);
    Taro.getCurrentInstance().page?.getTabBar?.();
    // 今日是否已认可判断（本地按天幂等）→ 直接回显已生成态
    try { if (Taro.getStorageSync(COMMIT_KEY) === dayKey()) setCta('done'); } catch { /* noop */ }
    void s.loadBadges(); // 底栏角标（问策未读 / 军令待复盘）搭车刷新：内部 15 秒节流 + 未登录直返
    if (s.isAuthed()) {
      // 首轮拉取（案卷 + 军师档案）完成后再标记水合，hero/三势区据此收起骨架。
      const jobs: Promise<unknown>[] = [refreshDossier().then(setDossier)];
      jobs.push(store.loadMe()); // 刷新军师档案（对话/资料变化后战局判断与三势随之更新）
      // 天势接命盘：并行拉命盘摘要（失败/无盘/命理关静默兜底 null）。
      // 命理关时连请求都不发（省一次往返，也不把命盘留在内存里）。
      if (fortuneOn) jobs.push(api.myChart().then((r) => setChartRaw(r.chart)).catch(() => setChartRaw(null)));
      // 决策日志：取「现在最该验证」的那一条（pickDecisionToVerify 显式排序，不依赖接口返回顺序）；
      // 无账本/无 pending → null，区块整体不渲染，不摆空卡。
      jobs.push(
        api.decisions()
          .then((r) => setPendingDecision(pickDecisionToVerify(r.items)))
          .catch(() => setPendingDecision(null)),
      );
      Promise.all(jobs).catch(() => {}).then(() => setHydrated(true));
    } else {
      setDossier(null);
      setChartRaw(null);
      setPendingDecision(null);
      setHydrated(true);
    }
  });

  useEffect(() => {
    api.todaySaying().then((r) => setSaying({ text: r.text, date: r.date || todayLabel() })).catch(() => {});
  }, []);

  // 三势全解弹层底栏协调（setOverlay）已收敛至 Sheet 基座。

  const requireLogin = (reason: AuthReason) => {
    if (s.isAuthed()) return true;
    setLoginReason(reason);
    setShowLogin(true);
    return false;
  };
  const goChat = (params: string) => {
    // 军师人设和开场白公开；带 send 的游客入口由聊天页预填，真正发送时再登录。
    navTo(`/packages/main/chat/index?${params}`);
    return true;
  };
  // 首登入局仪式（择色 → 立案卷 → 首判）。防重复：页栈已有 onboarding 就不再跳（navTo 另有 800ms 防连点锁）。
  const goOnboarding = () => {
    const pages = (Taro.getCurrentPages?.() || []) as { route?: string }[];
    if (pages.some((p) => (p.route || '').includes('packages/main/onboarding'))) return;
    navTo('/packages/main/onboarding/index');
  };

  const gapCount = und?.nextQuestions.length ?? 0;
  const riskCount = dossier?.risks.length ?? 0;
  // 案卷完整度：军师档案成熟度（真实状态，不编百分比）
  const maturityLabel = !s.isAuthed() || !und ? '—' : und.maturity === 'ready' ? '可用' : und.maturity === 'forming' ? '整理中' : '待建档';

  const refresh = () => {
    if (!requireLogin('profile')) return;
    // C5：toast 移到全部刷新完成后再提示，避免「已刷新」抢在数据回来之前弹出。
    const jobs: Promise<unknown>[] = [refreshDossier().then(setDossier)];
    if (s.isAuthed()) {
      jobs.push(api.refreshForces().then(() => store.loadMe()).catch(s.handleApiError)); // V7-04：刷新结构化三势后回读 /me
    }
    Promise.all(jobs).then(() => Taro.showToast({ title: '军情已更新', icon: 'none' }));
  };
  // 聚合入口（「待补资料 N」指标格）：不指定哪条，让军师挑最关键的几条问。
  const startInterview = () =>
    goChat(`agentKey=general&continue=1&send=${encodeURIComponent(ARCHIVE_INTERVIEW_PROMPT)}`);
  // 具体某条待补证据：把用户点的那条原样带进去，军师只问这一条。
  // 原来每行都调 startInterview——行是分开的、动作却是同一个，点第 3 条也只会收到批量提问。
  const askArchive = (q: string) =>
    goChat(`agentKey=general&continue=1&send=${encodeURIComponent(archiveAnswerPrompt(q))}`);
  const askRisks = () =>
    goChat(`agentKey=strat&continue=1&send=${encodeURIComponent('基于我当前的情况，给我 2-3 条「现在不能做」的风险锁，并说明原因。')}`);

  // 三势全解：点整卡/小框 → 半屏 sheet（看全解）。无三势时不弹。
  const openForces = () => { if (forces.length) setForcesOpen(true); };
  // 天势 → 天时日历（逐月攻守落地页，自带补生辰表单）。先收全解再跳。
  const goCalendar = () => { setForcesOpen(false); navTo('/packages/work/calendar/index'); };

  // 认可判断 → 生成军令与报告（三态机）：idle→generating→done。
  const handleBattleCta = () => {
    if (cta === 'generating') return; // 生成中锁定
    if (cta === 'done') { switchTo('/pages/studio/index'); return; } // 已生成 → 去执行页看军令与报告
    if (!requireLogin('execute')) return;
    setCta('generating');
    api.battleCommit()
      .then(() => {
        try { Taro.setStorageSync(COMMIT_KEY, dayKey()); } catch { /* noop */ }
        setCta('done');
        store.loadMe();
        refreshDossier().then(setDossier); // 认可即建案卷、拆军令 → 刷新下一步/不能做
        Taro.showToast({ title: '军令和方案已出', icon: 'none' });
      })
      .catch((e: unknown) => {
        setCta('idle');
        const code = String((e as { code?: string; data?: { code?: string } })?.code || (e as { data?: { code?: string } })?.data?.code || '');
        if (code === 'PLAN_EXPIRED') { setPayOpen(true); return; } // 套餐过期 → 续费付费屏
        if (code === 'INSUFFICIENT_QUOTA' || code === 'INSUFFICIENT_CREDITS' || code === 'SKU_REQUIRED') { setExceptionOpen(true); return; } // 额度/算力不足 → 异常屏
        s.handleApiError(e);
      });
  };

  if (!s.isAuthed()) {
    return (
      <Screen topInset className="home">
        <View className="pad">
          <TabHeader title="军情" kicker="看今日判断" glyph="势" />
          <View className="say-strip">
            <Text className="say-k" style={{ color: accent }}>今日献策 · {saying.date}</Text>
            <SayingLine html={saying.text} accent={accent} />
          </View>
          <AsyncState
            empty
            emptyText="还没有战局判断"
            emptyAction={{ text: '去问策', onClick: () => switchTo('/pages/sessions/index') }}
          />
        </View>
        <Login
          open={showLogin}
          reason={loginReason}
          onClose={() => setShowLogin(false)}
          onLoggedIn={() => {
            setShowLogin(false);
            setHydrated(false);
            Promise.all([
              store.loadMe(),
              refreshDossier().then(setDossier),
              api.decisions().then((r) => setPendingDecision(pickDecisionToVerify(r.items))).catch(() => setPendingDecision(null)),
            ]).finally(() => setHydrated(true));
          }}
        />
      </Screen>
    );
  }

  const ctaText = cta === 'generating'
    ? { t: '正在翻你的案卷，排兵布阵…', s: '梳理战局、拆解任务、拟定军令', icon: '…' }
    : cta === 'done'
      ? { t: '军令已出 · 去看看', s: `已更新到执行页和方案库，今晚 ${REVIEW_TIME} 复盘`, icon: '✓' }
      : { t: '就按这个来 · 出军令与方案', s: `军师拆成军令和方案，更新到执行页和方案库，今晚 ${REVIEW_TIME} 复盘`, icon: '›' };

  return (
    <Screen topInset className="home">
      <View className="pad">
        {/* 页头（TabHeader）：小字用途 + 大字「军情」+ 背景「势」，不挂按钮。
            原页头右侧的「案卷」回归老板 tab；刷新不是简单重拉（它调 refreshForces 重算三势），
            所以下移到「三势判断」段头，动作与它的作用对上。 */}
        <TabHeader title="军情" kicker="看今日判断" glyph="势" />

        {/* 今日献策（每日批语）：从页尾提到页头，紧接标题区那条细线当一句眉批。
            放页尾时它一天一换却基本没人滚到，而且夹在「现在不能做」和认可 CTA 之间会打断
            「看完判断 → 认可判断」的动线；提到这里既天天被看见，也不跟任何功能区抢位置。
            它与三个视角无关（是当天的一句话），所以在 mode 切换之外，属页面级。 */}
        <View className="say-strip">
          <Text className="say-k" style={{ color: accent }}>今日献策 · {saying.date}</Text>
          <SayingLine html={saying.text} accent={accent} />
        </View>

        {!s.isOnboarded() ? (
          <GuestNotice
            title="你的战局还没有建档"
            desc="建档是自愿的；完成三问后，军师会把第一份判断写到这里。"
            action="开始建档"
            onAction={goOnboarding}
          />
        ) : null}

        {/* 三视角切换（新设计稿 battle-mode-tabs）：经营战局是主视角，时运策与命盘分析只调节奏。
            命理开关关闭时整条 tab 不出现（P0-2：命理下线要能一键全产品隐藏），页面回到单视角形态。 */}
        {fortuneOn ? (
          <View className="battle-mode-tabs">
            {BATTLE_MODES.map((m) => (
              <View
                key={m.key}
                className={`bmt ${mode === m.key ? 'on' : ''}`}
                style={mode === m.key ? { color: accent, borderColor: accent } : {}}
                onClick={() => setModePick(m.key)}
              >
                <Text>{m.label}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* ===================== 时运策（design battle-mode-panel[timing]） =====================
            只写命盘真实算出来的东西：本月攻守、全年拐点、格局宜/避。没有命盘就引导补生辰，不编节奏。
            这里必须再判一次 fortuneOn：只藏 tab 不够——用户停在本视角时后端把命理开关关掉（下一次 /me 回读），
            tab 会消失但面板还留在屏上，等于命理 UI 没下线（P0-2 要求一键全产品隐藏）。 */}
        {mode === 'timing' ? (
          <View className="mode-panel">
            <View className="timing-hero card">
              <Text className="th-k">时运策 · {chart ? '已授权' : '待补生辰'}</Text>
              <Text className="th-t serif">{chart ? `本月宜${PHASE_WORD[currentMonthOutlook(chart)?.phase ?? ''] ?? currentMonthOutlook(chart)?.phase ?? '稳中蓄力'}` : '录入生辰后再谈节奏'}</Text>
              <Text className="th-d">只调整行动节奏与优先级。经营判断仍以案卷、数据和执行回填为准。</Text>
            </View>

            {chart ? (
              <>
                <View className="timing-grid">
                  <View className="tg-cell card">
                    <Text className="tg-t">本月攻守</Text>
                    <Text className="tg-d">{chartCardLine(chart)}</Text>
                  </View>
                  <View className="tg-cell card">
                    <Text className="tg-t">全年拐点</Text>
                    <Text className="tg-d">{chartTurningMonths(chart)}</Text>
                  </View>
                </View>

                <View className="timing-band card">
                  <Text className="section-label">本 周 边 界</Text>
                  {/* suits/avoid 可能缺（旧版命盘只回基础字段，命盘报告页同样是 `pattern.suits?.length` 取值）——
                      直接 .join() 遇到 undefined 会抛在 render 里，把整个军情页打白，所以兜一层空数组。 */}
                  <Text className="tb-row"><Text className="tb-k" style={{ color: accent }}>宜</Text>{(chart.pattern.suits ?? []).join(' · ') || '按当前判断推进'}</Text>
                  <Text className="tb-row"><Text className="tb-k danger">避</Text>{(chart.pattern.avoid ?? []).join(' · ') || '暂无明确禁忌'}</Text>
                  <Text className="tb-src">格局：{chart.pattern.name} · {chart.pattern.traits}</Text>
                </View>

                <View className="mode-link card" onClick={() => navTo('/packages/work/calendar/index')}>
                  <Text className="ml-t">天时日历 · 逐月攻守</Text>
                  <Text className="ml-go" style={{ color: accent }}>打开 ›</Text>
                </View>
              </>
            ) : (
              <View className="force-empty card" onClick={() => navTo('/packages/work/calendar/index')}>
                <Text className="fe-t serif">还没有命盘</Text>
                <Text className="fe-d">录入生辰后，天势会参命盘给出本月攻守和全年拐点。它只调节奏，不替你做经营判断。</Text>
                <Text className="fe-go" style={{ color: accent }}>去录生辰 ›</Text>
              </View>
            )}

            <View className="mode-back" onClick={() => setModePick('business')}><Text>返回经营判断</Text></View>
          </View>
        ) : null}

        {/* ===================== 命盘分析（design battle-mode-panel[destiny]） =====================
            设计稿口径：命盘只用于识别工作节律、决策偏好与风险提醒，不替代经营数据。四柱/日主/格局全部取真实命盘。 */}
        {mode === 'destiny' ? (
          <View className="mode-panel">
            <View className="destiny-hero card">
              <Text className="th-k">命盘分析 · {chart ? '已授权' : '待补生辰'}</Text>
              <Text className="th-t serif">以节律校准判断，不替代判断</Text>
              <Text className="th-d">命盘只用来识别你的工作节律、决策偏好和风险提醒，不参与经营结论。</Text>
            </View>

            {chart ? (
              <>
                <View className="pillar-card card">
                  <Text className="section-label">命 盘 四 柱</Text>
                  <View className="pillar-row">
                    {([['年柱', chart.pillars.year.ganZhi, '根基'], ['月柱', chart.pillars.month.ganZhi, '节律'], ['日柱', chart.pillars.day.ganZhi, '自驱'],
                      ...(chart.hourKnown && chart.pillars.time ? [['时柱', chart.pillars.time.ganZhi, '表达'] as [string, string, string]] : [])] as [string, string, string][]).map(([k, v, tag]) => (
                      <View key={k} className="pillar-cell">
                        <Text className="pc-k">{k}</Text>
                        <Text className="pc-v serif">{v}</Text>
                        <Text className="pc-tag">{tag}</Text>
                      </View>
                    ))}
                  </View>
                  {!chart.hourKnown ? <Text className="pillar-note">时辰未录 · 补上后表达与外显判断会更准</Text> : null}
                </View>

                <View className="destiny-analysis card">
                  <Text className="section-label">对 应 分 析</Text>
                  <View className="da-row">
                    <Text className="da-t">日主 · {chart.dayMaster.gan}（{chart.dayMaster.element}）{chart.dayMaster.strength}</Text>
                    <Text className="da-d">{chart.favorableElements?.length ? `喜用：${chart.favorableElements.join(' · ')}` : '喜用五行待补全'}</Text>
                  </View>
                  <View className="da-row">
                    <Text className="da-t">格局 · {chart.pattern.name}</Text>
                    <Text className="da-d">{chart.pattern.traits}</Text>
                  </View>
                  {chart.ziwei?.soulMajorStars.length ? (
                    <View className="da-row">
                      <Text className="da-t">紫微 · 命宫主星</Text>
                      <Text className="da-d">{chart.ziwei.soulMajorStars.join(' · ')}</Text>
                    </View>
                  ) : null}
                </View>

                <View className="mode-link card" onClick={() => navTo('/packages/work/mingpan/index')}>
                  <Text className="ml-t">命盘报告 · 八字紫微印证</Text>
                  <Text className="ml-go" style={{ color: accent }}>打开 ›</Text>
                </View>
              </>
            ) : (
              <View className="force-empty card" onClick={() => navTo('/packages/work/mingpan/index')}>
                <Text className="fe-t serif">还没有命盘</Text>
                <Text className="fe-d">录入生辰后这里会显示四柱、日主和格局，用于校准你的工作节律。</Text>
                <Text className="fe-go" style={{ color: accent }}>去命盘 ›</Text>
              </View>
            )}

            <View className="mode-back" onClick={() => setModePick('business')}><Text>返回经营判断</Text></View>
          </View>
        ) : null}

        {/* ===================== 经营战局（design battle-mode-panel[business]）：原有全部内容 ===================== */}
        {mode !== 'business' ? null : (
        <>
        {/* 军师判断 hero：主要矛盾 —— 有判断时点击就地展开/收起全文；尚无判断时点击去对话 */}
        {(() => {
          const judgment = und?.mainContradiction || und?.summary || dossier?.judgment || '';
          const hasJudgment = !!judgment;
          return (
            <View
              className="battle-hero"
              onClick={() => (hasJudgment ? setHeroExpanded((v) => !v) : goChat('agentKey=general&continue=1'))}
            >
              <Text className="bh-kicker">军师判断 · 主要矛盾</Text>
              {!hydrated ? (
                /* C2：首帧骨架，等案卷/军师档案回来再落定，避免兜底文案闪跳 */
                <View className="bh-sk">
                  <View className="bh-sk-bar short" />
                  <View className="bh-sk-bar wide" />
                  <View className="bh-sk-bar" />
                </View>
              ) : (
                <>
                  <Text className="bh-source">
                    {dossier ? `当前案卷 · ${dossier.title} · 军师持续跟进，随变而调` : '还没有案卷 · 和军师聊一次，方案定了就成卷'}
                  </Text>
                  <Text className={`bh-title serif ${heroExpanded ? 'expanded' : ''}`}>
                    {judgment || '先说说你的处境，判断我会写在这里'}
                  </Text>
                  {hasJudgment ? (
                    <View className="bh-foot">
                      <Text className="bh-toggle">{heroExpanded ? '收起 ▲' : '展开全文 ▼'}</Text>
                      <Text className="bh-ask" onClick={(e) => { e.stopPropagation(); goChat('agentKey=general&continue=1'); }}>问军师 ›</Text>
                    </View>
                  ) : null}
                </>
              )}
            </View>
          );
        })()}

        {/* 战局信号（metric-grid）：案卷完整度 / 待补资料 / 风险锁 —— 全部真实状态 */}
        <View className="metric-grid">
          <View className="metric card" onClick={() => requireLogin('profile') && navTo('/packages/main/brief/index')}>
            <Text className="metric-v serif">{maturityLabel}</Text>
            <Text className="metric-l">案卷完整度</Text>
          </View>
          <View className="metric card" onClick={startInterview}>
            <Text className={`metric-v serif ${gapCount ? 'warn' : ''}`}>{s.isAuthed() && und ? gapCount : '—'}</Text>
            <Text className="metric-l">待补资料</Text>
          </View>
          <View className="metric card" onClick={askRisks}>
            <Text className={`metric-v serif ${riskCount ? 'danger' : ''}`}>{riskCount || '—'}</Text>
            <Text className="metric-l">风险锁</Text>
          </View>
        </View>

        {/* 三势判断（force-panel）：从 me.understanding.battleForces 真实渲染。整卡/小框 → 三势全解 sheet。 */}
        <View className="force-panel">
          {/* 段头：标题与提示点开三势全解；「重算」承接原页头的刷新（refreshForces 重算三势 + 回读档案），
              两个动作分别挂在自己的 Text 上，不再整行同一个 onClick，避免误触。 */}
          <View className="force-head">
            <Text className="battle-h2" onClick={forces.length ? openForces : undefined}>三 势 判 断</Text>
            <View className="force-tools">
              {forces.length ? (
                <Text className="force-hint" onClick={openForces}><Text className="fh-b">整卡</Text>看全解 · 小框看单势</Text>
              ) : null}
              <Text className="force-redo" onClick={refresh}>刷新判断</Text>
            </View>
          </View>
          {!hydrated ? (
            /* C2：三势区首帧骨架，区分「加载中」与「真空态」，不把空态当加载中显示 */
            <View className="force-grid">
              {[0, 1, 2].map((i) => (
                <View key={i} className="force card force-sk">
                  <View className="fsk-bar short" />
                  <View className="fsk-bar" />
                  <View className="fsk-bar wide" />
                </View>
              ))}
            </View>
          ) : forces.length ? (
            <View className="force-grid" onClick={openForces}>
              {forces.map((f) => (
                <View key={f.kind} className="force card">
                  <Text className="force-tag">{FORCE_KIND_LABEL[f.kind]} · {FORCE_LEVEL_LABEL[f.level]}</Text>
                  <Text className="force-concl serif">{f.conclusion}</Text>
                  <Text className={`force-tactic ${f.tacticTone}`}>打法：{f.tactic}</Text>
                  <Text className="force-note">{f.note}</Text>
                  {f.kind === 'sky' && chart ? <Text className="force-note chart">{chartCardLine(chart)}</Text> : null}
                  <View className="force-bar"><View className={`force-fill ${f.kind}`} style={{ width: `${f.strength}%` }} /></View>
                </View>
              ))}
            </View>
          ) : (
            <View className="force-empty card" onClick={() => goChat('agentKey=general&continue=1')}>
              <Text className="fe-t serif">三势还没断</Text>
              <Text className="fe-d">跟我聊透目标、现状和卡点，天势、市势、人势自然就清楚了。</Text>
              <Text className="fe-go" style={{ color: accent }}>去对话 ›</Text>
            </View>
          )}
        </View>

        {/* 判断依据（新设计稿 battle-panel[evidence]）：把「凭什么这么判」摊开成两组——
            已引用来自军师档案的真实证据计数，待补来自 nextQuestions（同一份缺口，和上面「待补资料」是一个来源）。
            两组都空（未建档）时整块不渲染，不摆空壳。 */}
        {(() => {
          const ec = und?.evidenceCount;
          // 每一项都要有去处：给不出去处的 chip 长得能点但点不动，比不显示更差。
          // 契约里 evidenceCount 是五类（profile/memories/projects/knowledge/sessions），五类都要列——
          // 少列一类，「已引用 N 类」就在真实证据面前撒谎。档案与军师记忆同落个人档案页。
          const cited: [string, number, string][] = ec
            ? ([['对话问对', ec.sessions, 'tab:/pages/sessions/index'], ['档案', ec.profile, '/packages/main/brief/index'],
                ['案卷', ec.projects, '/packages/work/projects/index'], ['资料', ec.knowledge, '/packages/work/knowledge/index'],
                ['军师记忆', ec.memories, '/packages/main/brief/index']] as [string, number, string][])
              .filter(([, n]) => n > 0)
            : [];
          const missing = und?.nextQuestions ?? [];
          if (!cited.length && !missing.length) return null;
          return (
            <View className="evidence-card card">
              <View className="ev-head">
                <Text className="section-label">判 断 依 据</Text>
                <Text className="ev-sum">已引用 {cited.length} 类 · 待补 {missing.length} 项</Text>
              </View>
              {cited.length ? (
                <View className="ev-group">
                  <Text className="ev-gl">已引用证据</Text>
                  <View className="ev-chips">
                    {cited.map(([label, n, url]) => (
                      <Text
                        key={label}
                        className="ev-chip"
                        onClick={() => (url.startsWith('tab:') ? switchTo(url.slice(4)) : navTo(url))}
                      >{label} {n}</Text>
                    ))}
                  </View>
                </View>
              ) : null}
              {missing.length ? (
                <View className="ev-group">
                  <Text className="ev-gl">待补证据 · 按对判断的影响排序</Text>
                  {missing.map((q, i) => (
                    <View key={q} className="ev-row" onClick={() => askArchive(q)}>
                      <Text className="ev-i serif" style={{ background: 'var(--accent-soft)', color: accent }}>{i + 1}</Text>
                      <Text className="ev-q">{q}</Text>
                      <Text className="ev-go" style={{ color: accent }}>去补</Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          );
        })()}

        {/* 决策日志 · 待验证（新设计稿 three-force-decision）：真实决策账本里最近一条未验证的决策。
            设计稿把它挂在三势结论后面，作用是提醒「这条判断还没被结果验证」，避免把假设当结论用。 */}
        {pendingDecision ? (
          <View className="decision-card card" onClick={() => navTo('/packages/work/ledger/index')}>
            <View className="dc-head">
              <Text className="section-label">决 策 日 志 · 待验证</Text>
              <Text className="dc-seq">决策 #{pendingDecision.seq}</Text>
            </View>
            <Text className="dc-t serif">{pendingDecision.decision}</Text>
            {pendingDecision.verifyStandard ? <Text className="dc-d">验证标准：{pendingDecision.verifyStandard}</Text> : null}
            <Text className="dc-go" style={{ color: accent }}>
              {pendingDecision.verifyByDate ? `验证日 ${pendingDecision.verifyByDate} · 看战略账本 ›` : '看战略账本 ›'}
            </Text>
          </View>
        ) : null}

        {/* 关联模块（module-card）：军师方案的功能化承接 */}
        <View className="battle-actions module-card card">
          <Text className="section-label">关 联 模 块</Text>
          {MODULE_MARKET.slice(0, 3).map((m) => {
            const owner = m.agentKey ? s.agents().find((a) => a.key === m.agentKey)?.name : undefined;
            return (
              <View key={m.id} className="linkmod" onClick={() => navTo('/packages/work/market/index')}>
                <Text className="linkmod-name serif">{m.title}</Text>
                <Text className="linkmod-mini">{owner || m.category}</Text>
                <Text className={`module-tier tier-${m.tier}`}>{m.price}</Text>
              </View>
            );
          })}
        </View>

        {/* 经营数据 · 近 7 天回填（M4 PR-16 看板第一层 v1）：数据源=执行页回填，无回填不展示 */}
        {(() => {
          const days = Object.keys(dossier?.backfill ?? {}).sort().slice(-7);
          if (!days.length) return null;
          const sum = (k: 'leads' | 'consults' | 'deals') => days.reduce((acc, d) => acc + (parseInt(dossier!.backfill[d][k] || '0', 10) || 0), 0);
          const rows: [string, number][] = [['线索', sum('leads')], ['咨询', sum('consults')], ['成交', sum('deals')]];
          return (
            <View className="kpi-card card" onClick={() => switchTo('/pages/studio/index')}>
              <View className="kpi-head">
                <Text className="section-label">经 营 数 据</Text>
                <Text className="kpi-sub">近 {days.length} 天记录</Text>
              </View>
              <View className="kpi-row">
                {rows.map(([label, v]) => (
                  <View key={label} className="kpi-cell">
                    <Text className="kpi-v serif">{v}</Text>
                    <Text className="kpi-l">{label}</Text>
                  </View>
                ))}
              </View>
            </View>
          );
        })()}

        {/* 现在不能做（nono-card）：认可方案中提取的风险锁 */}
        {dossier?.risks.length ? (
          <View className="nono-card card">
            <Text className="section-label danger">现 在 不 能 做</Text>
            {dossier.risks.map((r) => (
              <Text key={r} className="nono">× {r}</Text>
            ))}
            <Text className="nono-src">来自你定下的《{dossier.title}》</Text>
          </View>
        ) : null}

        {/* 认可判断 CTA（battle-cta 三态机）：新设计稿把它从固定悬浮改回文档流内（position: static），
            落在经营战局的内容末尾——读完判断、依据和不能做，紧接着就是「认可它」，动线是顺的。
            悬浮版的问题是它常年压在内容上方，且与底栏胶囊叠在一起挤成两条。
            只在经营战局视角出现：在时运策/命盘分析里摆一个「确认当前战局」会让人以为是在认可命盘。 */}
        <View
          className={`battle-cta ${cta === 'generating' ? 'generating' : ''} ${cta === 'done' ? 'generated' : ''}`}
          onClick={handleBattleCta}
        >
          <View className="bc-b">
            <Text className="bc-t">{ctaText.t}</Text>
            <Text className="bc-s">{ctaText.s}</Text>
          </View>
          <View className="bc-arrow"><Text>{ctaText.icon}</Text></View>
        </View>
        </>
        )}
      </View>

      {/* 三势全解 sheet（设计 §4.6 forces）：3 条 force-read + 合参结论——迁入 Sheet 基座 */}
      <Sheet
        visible={forcesOpen}
        onClose={() => setForcesOpen(false)}
        overlayKey="forces-detail"
        align="center"
        panelClassName="fs-pad"
        footer={<Text className="fs-close" onClick={() => setForcesOpen(false)}>收起</Text>}
      >
        <Text className="fs-kicker">三 势 合 参</Text>
        <Text className="fs-title serif">三势全解：先拆三势，再做合参</Text>
        <Text className="fs-quote">三势不是三个孤立的数。天势看能不能借风，市势看怎么打出差异，人势看能不能放大。</Text>
        <ScrollView scrollY className="fs-body">
          <View className="forces-breakdown">
            {forces.map((f) => {
              const r = forceRead(f);
              return (
                <View key={f.kind} className={`force-read ${f.kind}`}>
                  <Text className="fr-label">{r.label}</Text>
                  <Text className="fr-title serif">{r.title}</Text>
                  <Text className="fr-body">{r.body}</Text>
                  <Text className={`fr-tactic ${f.tacticTone}`}>{r.tactic}</Text>
                  {/* 天势小节接命盘：有盘展开四柱/日主/格局/攻守 + 跳天时日历；无盘一行引导补生辰。
                      整段过 fortuneOn：无盘引导也是命理入口（指向天时日历），命理关时连引导都不能露。 */}
                  {f.kind === 'sky' && fortuneOn ? (chart ? (
                    <View className="fr-chart">
                      <Text className="frc-line">四柱：{chartFourPillars(chart)}</Text>
                      <Text className="frc-line">日主{chart.dayMaster.gan}{chart.dayMaster.element}·{chart.dayMaster.strength} · {chart.pattern.name}</Text>
                      <Text className="frc-line">{chartCardLine(chart)} · 全年拐点月 {chartTurningMonths(chart)}</Text>
                      <Text className="frc-go" onClick={goCalendar}>天时日历 · 逐月攻守 ›</Text>
                    </View>
                  ) : (
                    <Text className="frc-empty" onClick={goCalendar}>生辰未录 · 录入后天势可参命盘 ›</Text>
                  )) : null}
                </View>
              );
            })}
          </View>
          {(() => {
            const syn = forceSynthesis(forces);
            return (
              <View className="force-synthesis">
                <Text className="fsy-title serif">{syn.title}</Text>
                <Text className="fsy-body">{syn.body}</Text>
              </View>
            );
          })()}
        </ScrollView>
      </Sheet>

      {/* 认可判断额度/套餐异常 → 付费 / 异常屏（V7-03 全局组件填充；此处按需挂载） */}
      <PaySheet
        open={payOpen}
        mode="member"
        title="续费会员，继续出军令与方案"
        desc="套餐已到期，续费后可继续一键生成军令与方案。"
        confirmText="去续费"
        onConfirm={() => setPayOpen(false)}
        onClose={() => setPayOpen(false)}
      />
      <ExceptionSheet
        open={exceptionOpen}
        kind="power"
        title="算力不足"
        desc="本月额度已用尽，补充算力或升级套餐后再出军令与方案。"
        onPrimary={() => setExceptionOpen(false)}
        onClose={() => setExceptionOpen(false)}
      />

      <Login
        open={showLogin}
        reason={loginReason}
        onClose={() => setShowLogin(false)}
        onLoggedIn={() => {
          setShowLogin(false);
          setHydrated(false);
          Promise.all([
            store.loadMe(),
            refreshDossier().then(setDossier),
            api.decisions().then((r) => setPendingDecision(pickDecisionToVerify(r.items))).catch(() => setPendingDecision(null)),
          ]).finally(() => setHydrated(true));
        }}
      />
      <CoachMarks />
    </Screen>
  );
}
