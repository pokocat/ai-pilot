import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Login from '../../components/Login';
import Picker from '../../components/Picker';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api, type ChartSummary, type ReportItem } from '../../services/api';
import { MODULE_MARKET, THREE_FORCES, type ForceItem } from '../../data/operatingSystem';
import { EMPTY_STATES, QUICKSCAN_OPENER } from '../../data/emptyStates';
import { refreshDossier, todayProgress, type Dossier } from '../../services/dossier';
import './index.scss';

function todayLabel() {
  const d = new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

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

// 战局页 —— 对齐设计稿 page-battle：军师判断 hero → 信号指标 → 下一步卡（打磨）→ 三势 → 下一步动作 → 关联模块 → 不能做 → 认可 CTA。
// 判断内容一律来自真实军师档案（me.understanding）与案卷，资料不足时引导进入对话访谈，不预置结论。
export default function Home() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [showLogin, setShowLogin] = useState(() => !s.isAuthed());
  const [showPicker, setShowPicker] = useState(false);
  const [pickerFirst, setPickerFirst] = useState(false);
  const [saying, setSaying] = useState<{ text: string; date: string }>({ text: '先把自己<em>立于不败</em>，再等对手露出破绽。', date: todayLabel() });
  const [navTop, setNavTop] = useState<number>();
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [chart, setChart] = useState<ChartSummary | null>(null);
  const [reports, setReports] = useState<ReportItem[]>([]);
  const me = s.me();
  const und = me?.understanding;

  useDidShow(() => {
    s.setTab(1);
    Taro.getCurrentInstance().page?.getTabBar?.();
    refreshDossier().then(setDossier); // 案卷已服务端化（含一次性本地迁移）
    if (s.isAuthed()) {
      store.loadMe(); // 刷新军师档案（对话/资料变化后战局判断随之更新）
      api.myChart().then((r) => setChart(r.chart)).catch(() => setChart(null)); // 命盘（天时窗口）
      api.reports().then(setReports).catch(() => setReports([])); // 方案库（用于三势卡反查已研判方案）
    }
  });

  useEffect(() => {
    // 登录门：未登录先登录；已登录但未建档再走本命色/建档
    if (!s.isAuthed()) {
      setShowLogin(true);
    } else if (!s.isOnboarded()) {
      setPickerFirst(true);
      setShowPicker(true);
    }
    api.todaySaying().then((r) => setSaying({ text: r.text, date: r.date || todayLabel() })).catch(() => {});
    // 自定义导航：标题行与微信胶囊顶端对齐
    try {
      const r = Taro.getMenuButtonBoundingClientRect?.();
      if (r && r.top) setNavTop(r.top);
    } catch { /* H5 无胶囊，走 CSS 兜底 */ }
  }, []);

  const requireLogin = () => {
    if (s.isAuthed()) return true;
    setShowLogin(true);
    Taro.showToast({ title: '请先登录后再开始对话', icon: 'none' });
    return false;
  };
  const goChat = (params: string) => {
    if (!requireLogin()) return false;
    Taro.navigateTo({ url: `/pages/chat/index?${params}` });
    return true;
  };

  const gapCount = und?.nextQuestions.length ?? 0;
  const riskCount = dossier?.risks.length ?? 0;
  const progress = todayProgress(dossier);
  // 案卷完整度：军师档案成熟度（真实状态，不编百分比）
  const maturityLabel = !s.isAuthed() || !und ? '—' : und.maturity === 'ready' ? '可用' : und.maturity === 'forming' ? '整理中' : '待建档';

  const refresh = () => {
    refreshDossier().then(setDossier);
    if (s.isAuthed()) store.loadMe();
    Taro.showToast({ title: '军情已刷新', icon: 'none' });
  };
  const startInterview = () =>
    goChat(`agentKey=general&fresh=1&send=${encodeURIComponent('帮我补齐军师档案：你先问我最关键的 1-3 个问题，我来答。')}`);
  // 市势/人势各自独立研判（不再共用同一条指令）：各走自己的 prompt
  const startForce = (f: ForceItem) =>
    goChat(`agentKey=${f.agentKey || 'strat'}&fresh=1&send=${encodeURIComponent(f.prompt || '帮我做一次战略研判并给出该攻、该守还是该等的结论。')}`);
  // 反查方案库里该势已研判的方案（标题/类型含关键词，取最新一份）
  const forceReport = (f: ForceItem): ReportItem | undefined =>
    f.match ? reports.find((r) => r.title.includes(f.match!) || r.type.includes(f.match!)) : undefined;
  const openReport = (id: string) => Taro.navigateTo({ url: `/packages/work/report/index?id=${id}` });
  const askRisks = () =>
    goChat(`agentKey=strat&fresh=1&send=${encodeURIComponent('基于我当前的情况，给我 2-3 条「现在不能做」的风险锁，并说明原因。')}`);
  // 天势不再引导对话：排盘引擎已算好 → 直接进原生「全年天时」页（无命盘则页内就地补生辰）
  const openTianshi = () => Taro.navigateTo({ url: '/packages/work/calendar/index' });

  // 速诊（WO-06）未上线前，初诊 CTA 先跳对话 tab 并预填开场语。
  const goQuickScan = () => goChat(`agentKey=general&fresh=1&send=${encodeURIComponent(QUICKSCAN_OPENER)}`);

  // 下一步（WO-07 Journey 状态机占位）：先按本地案卷/档案派生，后续替换为服务端 /journey。
  // 冷启动（无案卷、无军师判断）走 WO-03 集中空态导流文案 → 初诊。
  const nextStep = (() => {
    if (!s.isAuthed()) return { title: '先登录，和军师开聊', desc: '登录后军师开始为你建档、诊断、排军令。', cta: '去登录', act: () => setShowLogin(true) };
    if (dossier) {
      return progress.total && progress.done < progress.total
        ? { title: `今日执行 · 军令 ${progress.done}/${progress.total}`, desc: '完成今日军令并录入战果，晚间即可复盘。', cta: '去执行', act: () => Taro.switchTab({ url: '/pages/studio/index' }) }
        : { title: '录入今日战果 · 生成复盘', desc: '把线索 / 咨询 / 成交录进去，军师据此定明日军令。', cta: '去执行', act: () => Taro.switchTab({ url: '/pages/studio/index' }) };
    }
    if (und?.summary) return { title: '认可一份方案，生成军令', desc: '和军师把打法聊定，认可后自动拆成今日军令。', cta: '去对话', act: () => goChat('agentKey=general&continue=1') };
    return { title: EMPTY_STATES.battle.title, desc: EMPTY_STATES.battle.desc, cta: EMPTY_STATES.battle.cta, act: goQuickScan };
  })();

  return (
    <Screen className="home">
      <View className="pad">
        {/* 页头（对齐设计稿）：左「案卷」· 中「军情」· 右刷新 */}
        <View className="battle-nav" style={navTop ? { paddingTop: `${navTop}px` } : undefined}>
          <Text className="bn-side left serif" onClick={() => requireLogin() && Taro.navigateTo({ url: '/packages/work/projects/index' })}>案卷</Text>
          <Text className="bn-title serif">军情</Text>
          <Text className="bn-side right" onClick={refresh}>↻</Text>
        </View>

        {/* 军师判断 hero：主题色主要矛盾 + 案卷来源行 */}
        <View className="battle-hero" onClick={() => goChat('agentKey=general&continue=1')}>
          <Text className="bh-kicker">军师判断 · 主要矛盾</Text>
          <Text className="bh-source">
            {dossier ? `当前案卷 · ${dossier.title} · 军师持续推演，动态校准` : '还没有战略案卷 · 认可军师方案，即刻成卷'}
          </Text>
          <Text className="bh-title serif">
            {und?.summary || dossier?.judgment || '先和军师聊聊当前处境，判断会沉淀在这里'}
          </Text>
        </View>

        {/* 战局信号（metric-grid）：案卷完整度 / 待补资料 / 风险锁 —— 全部真实状态 */}
        <View className="metric-grid">
          <View className="metric card" onClick={() => requireLogin() && Taro.navigateTo({ url: '/pages/brief/index' })}>
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

        {/* 下一步卡（打磨·WO-07 Journey 占位）：按案卷/档案派生一条明确动作，冷启动走空态导流 */}
        <View className="nextstep-card card" onClick={nextStep.act}>
          <Text className="section-label">下 一 步</Text>
          <Text className="ns-t serif">{nextStep.title}</Text>
          <Text className="ns-d">{nextStep.desc}</Text>
          <Text className="ns-go" style={{ color: accent }}>{nextStep.cta} ›</Text>
        </View>

        {/* 三势判断（force-grid）：天势=排盘引擎已算好 → 点开原生全年天时页（不引导对话）；
            市势/人势=各自独立研判开场（不再共用同一指令）→ 已研判（方案库有对应方案）则点开预览报告详情，否则发起研判。 */}
        <Text className="battle-h2">三 势 判 断</Text>
        <View className="force-grid">
          {THREE_FORCES.map((f) => {
            if (f.key === '天势') {
              const m = chart?.monthlyOutlook?.months?.find((x) => x.month === new Date().getMonth() + 1);
              const turning = chart?.monthlyOutlook?.months?.filter((x) => x.turning).map((x) => `${x.month}月`).slice(0, 2).join('、');
              return (
                <View key={f.key} className="force card" onClick={openTianshi}>
                  <Text className="force-tag serif">{f.key}</Text>
                  {m ? (
                    <Text className="force-desc">本月 <Text className={`force-phase ${m.phase === '进攻' ? 'atk' : m.phase === '防守' ? 'def' : ''}`}>{m.phase}</Text>{turning ? `，拐点在 ${turning}` : ''}。按你的命盘逐月推演。</Text>
                  ) : (
                    <Text className="force-desc">{f.desc}</Text>
                  )}
                  <Text className="force-go">{m ? '看全年天时 ›' : '解锁全年天时 ›'}</Text>
                </View>
              );
            }
            // 市势/人势：已研判（方案库有对应方案）→ 点开预览报告详情；否则各走独立 prompt 发起研判
            const rep = forceReport(f);
            return (
              <View key={f.key} className="force card" onClick={rep ? () => openReport(rep.id) : () => startForce(f)}>
                <Text className="force-tag serif">{f.key}</Text>
                <Text className="force-desc">{rep ? `已研判 · ${rep.title}` : f.desc}</Text>
                <Text className="force-go">{rep ? '查看研判 ›' : '发起判断 ›'}</Text>
              </View>
            );
          })}
        </View>

        {/* 下一步动作（battle-actions）：军师档案里真实的待补问题 */}
        <View className="battle-actions card">
          <Text className="section-label">下 一 步 动 作</Text>
          {(und?.nextQuestions.length ? und.nextQuestions.slice(0, 3) : []).map((qText) => (
            <View key={qText} className="battle-goal" onClick={startInterview}>
              <Text className="battle-tag">补线索</Text>
              <View className="bg-b">
                <Text className="bg-t serif">{qText}</Text>
                <Text className="bg-m">答完后军师会更新当前判断</Text>
              </View>
            </View>
          ))}
          {!und?.nextQuestions.length ? (
            <View className="battle-goal" onClick={() => goChat('agentKey=general&continue=1')}>
              <Text className="battle-tag">先对话</Text>
              <View className="bg-b">
                <Text className="bg-t serif">和军师聊聊当前处境</Text>
                <Text className="bg-m">对话之后，下一步动作自动排定</Text>
              </View>
            </View>
          ) : null}
        </View>

        {/* 关联模块（module-card）：军师方案的功能化承接 */}
        <View className="battle-actions module-card card">
          <Text className="section-label">关 联 模 块</Text>
          {MODULE_MARKET.slice(0, 3).map((m) => {
            const owner = m.agentKey ? s.agents().find((a) => a.key === m.agentKey)?.name : undefined;
            return (
              <View key={m.id} className="linkmod" onClick={() => Taro.navigateTo({ url: '/packages/work/market/index' })}>
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
            <View className="kpi-card card" onClick={() => Taro.switchTab({ url: '/pages/studio/index' })}>
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
            <Text className="nono-src">来自你认可的《{dossier.title}》</Text>
          </View>
        ) : null}

        {/* 今日献策：保留的每日批语（设计稿外的轻量存在，置于页尾） */}
        <View className="say-strip">
          <Text className="say-k" style={{ color: accent }}>今日献策 · {saying.date}</Text>
          <SayingLine html={saying.text} accent={accent} />
        </View>

        {/* 主行动 CTA（battle-cta）：认可判断 → 军令与方案 / 直达执行 */}
        <View
          className="battle-cta"
          onClick={() => dossier ? Taro.switchTab({ url: '/pages/studio/index' }) : goChat('agentKey=general&continue=1')}
        >
          <View className="bc-b">
            <Text className="bc-t">{dossier ? '今日执行 · 军令与打卡' : '认可判断，生成军令与方案'}</Text>
            <Text className="bc-s">{dossier ? `今日军令 ${progress.done}/${progress.total || 0} · 录入进展，即可复盘` : '认可即排期执行、生成方案与复盘'}</Text>
          </View>
          <View className="bc-arrow"><Text>›</Text></View>
        </View>
      </View>

      <Login
        open={showLogin}
        onLoggedIn={(onboarded) => {
          setShowLogin(false);
          if (!onboarded) {
            setPickerFirst(true);
            setShowPicker(true);
          }
        }}
      />

      <Picker
        open={showPicker}
        first={pickerFirst}
        onClose={() => setShowPicker(false)}
        onConfirm={() => setShowPicker(false)}
      />
    </Screen>
  );
}
