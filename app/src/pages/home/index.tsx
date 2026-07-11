import { useEffect, useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Login from '../../components/Login';
import Picker from '../../components/Picker';
import PaySheet from '../../components/PaySheet';
import ExceptionSheet from '../../components/ExceptionSheet';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api, type JourneyView, type BattleForce, type ForceKind } from '../../services/api';
import { MODULE_MARKET } from '../../data/operatingSystem';
import { EMPTY_STATES } from '../../data/emptyStates';
import { refreshDossier, todayProgress, type Dossier } from '../../services/dossier';
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
  const [showLogin, setShowLogin] = useState(() => !s.isAuthed());
  const [showPicker, setShowPicker] = useState(false);
  const [pickerFirst, setPickerFirst] = useState(false);
  const [saying, setSaying] = useState<{ text: string; date: string }>({ text: '先把自己<em>立于不败</em>，再等对手露出破绽。', date: todayLabel() });
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [journey, setJourney] = useState<JourneyView | null>(null); // WO-07：下一步卡数据源（初诊后 new→scanned，不再重复「开始初诊」）
  // V7-04：认可判断 CTA 三态机 + 三势全解 / 付费 / 异常 弹层开关
  const [cta, setCta] = useState<'idle' | 'generating' | 'done'>('idle');
  const [forcesOpen, setForcesOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [exceptionOpen, setExceptionOpen] = useState(false);
  const me = s.me();
  const und = me?.understanding;
  // 三势一律来自真实军师档案（und.battleForces）；为空时走 force-empty 空态引导对话，绝不预置结论（P0-3）。
  const forces: BattleForce[] = und?.battleForces ?? [];

  useDidShow(() => {
    s.setTab(1);
    Taro.getCurrentInstance().page?.getTabBar?.();
    refreshDossier().then(setDossier); // 案卷已服务端化（含一次性本地迁移）
    // 今日是否已认可判断（本地按天幂等）→ 直接回显已生成态
    try { if (Taro.getStorageSync(COMMIT_KEY) === dayKey()) setCta('done'); } catch { /* noop */ }
    if (s.isAuthed()) {
      store.loadMe(); // 刷新军师档案（对话/资料变化后战局判断与三势随之更新）
      api.journey().then(setJourney).catch(() => setJourney(null)); // WO-07：返回首页即刷新 journey，初诊后不再显示「开始初诊」
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
  }, []);

  // 三势全解弹层：底栏协调（overlay key）+ 卸载清理（对齐 playbook §3 recipe）
  useEffect(() => {
    store.setOverlay(forcesOpen, 'forces-detail');
    return () => store.setOverlay(false, 'forces-detail');
  }, [forcesOpen]);

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
    if (s.isAuthed()) {
      api.refreshForces().then(() => store.loadMe()).catch(s.handleApiError); // V7-04：刷新结构化三势后回读 /me
    }
    Taro.showToast({ title: '军情已刷新', icon: 'none' });
  };
  const startInterview = () =>
    goChat(`agentKey=general&fresh=1&send=${encodeURIComponent('帮我补齐军师档案：你先问我最关键的 1-3 个问题，我来答。')}`);
  const askRisks = () =>
    goChat(`agentKey=strat&fresh=1&send=${encodeURIComponent('基于我当前的情况，给我 2-3 条「现在不能做」的风险锁，并说明原因。')}`);
  // 速诊（WO-06）：初诊 CTA 进 3 问速诊分包页。
  const goQuickScan = () => Taro.navigateTo({ url: '/packages/work/quickscan/index' });

  // 三势全解：点整卡/小框 → 半屏 sheet（看全解）。无三势时不弹。
  const openForces = () => { if (forces.length) setForcesOpen(true); };

  // 认可判断 → 生成军令与报告（三态机）：idle→generating→done。
  const handleBattleCta = () => {
    if (cta === 'generating') return; // 生成中锁定
    if (cta === 'done') { Taro.switchTab({ url: '/pages/studio/index' }); return; } // 已生成 → 去执行页看军令与报告
    if (!requireLogin()) return;
    setCta('generating');
    api.battleCommit()
      .then(() => {
        try { Taro.setStorageSync(COMMIT_KEY, dayKey()); } catch { /* noop */ }
        setCta('done');
        store.loadMe();
        refreshDossier().then(setDossier); // 认可即建案卷、拆军令 → 刷新下一步/不能做
        Taro.showToast({ title: '军令与报告已生成', icon: 'none' });
      })
      .catch((e: unknown) => {
        setCta('idle');
        const code = String((e as { code?: string; data?: { code?: string } })?.code || (e as { data?: { code?: string } })?.data?.code || '');
        if (code === 'PLAN_EXPIRED') { setPayOpen(true); return; } // 套餐过期 → 续费付费屏
        if (code === 'INSUFFICIENT_QUOTA' || code === 'INSUFFICIENT_CREDITS' || code === 'SKU_REQUIRED') { setExceptionOpen(true); return; } // 额度/算力不足 → 异常屏
        s.handleApiError(e);
      });
  };

  // 下一步（WO-07 Journey 状态机占位）：先按本地案卷/档案派生，后续替换为服务端 /journey。
  const nextStep = (() => {
    if (!s.isAuthed()) return { title: '先登录，和军师开聊', desc: '登录后军师开始为你建档、诊断、排军令。', cta: '去登录', act: () => setShowLogin(true) };
    if (dossier) {
      return progress.total && progress.done < progress.total
        ? { title: `今日执行 · 军令 ${progress.done}/${progress.total}`, desc: '完成今日军令并录入战果，晚间即可复盘。', cta: '去执行', act: () => Taro.switchTab({ url: '/pages/studio/index' }) }
        : { title: '录入今日战果 · 生成复盘', desc: '把线索 / 咨询 / 成交录进去，军师据此定明日军令。', cta: '去执行', act: () => Taro.switchTab({ url: '/pages/studio/index' }) };
    }
    if (und?.summary) return { title: '认可一份方案，生成军令', desc: '和军师把打法聊定，认可后自动拆成今日军令。', cta: '去对话', act: () => goChat('agentKey=general&continue=1') };
    if (journey?.nextStep && (journey.stage === 'scanned' || journey.stage === 'diagnosing')) {
      return { title: journey.nextStep.title, desc: journey.nextStep.desc, cta: '进参谋室', act: () => goChat('agentKey=general&continue=1') };
    }
    return { title: EMPTY_STATES.battle.title, desc: EMPTY_STATES.battle.desc, cta: EMPTY_STATES.battle.cta, act: goQuickScan };
  })();

  const ctaText = cta === 'generating'
    ? { t: '正在生成军令与报告…', s: '读取案卷、战局和执行建议', icon: '…' }
    : cta === 'done'
      ? { t: '已生成 → 查看军令与报告', s: '已同步到执行页、报告库和 20:30 复盘', icon: '✓' }
      : { t: '认可判断 → 生成军令与报告', s: '同步到执行页、报告库和 20:30 复盘', icon: '›' };

  return (
    <Screen topInset className="home">
      <View className="pad">
        {/* 页头（对齐设计稿）：左「案卷」· 中「军情」· 右刷新 */}
        <View className="battle-nav tab-page-head">
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
            {und?.mainContradiction || und?.summary || dossier?.judgment || '先和军师聊聊当前处境，判断会沉淀在这里'}
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

        {/* 三势判断（force-panel）：从 me.understanding.battleForces 真实渲染。整卡/小框 → 三势全解 sheet。 */}
        <View className="force-panel">
          <View className="force-head" onClick={forces.length ? openForces : undefined}>
            <Text className="battle-h2">三 势 判 断</Text>
            {forces.length ? (
              <Text className="force-hint"><Text className="fh-b">整卡</Text>看全解 · 小框看单势</Text>
            ) : null}
          </View>
          {forces.length ? (
            <View className="force-grid" onClick={openForces}>
              {forces.map((f) => (
                <View key={f.kind} className="force card">
                  <Text className="force-tag">{FORCE_KIND_LABEL[f.kind]} · {FORCE_LEVEL_LABEL[f.level]}</Text>
                  <Text className="force-concl serif">{f.conclusion}</Text>
                  <Text className={`force-tactic ${f.tacticTone}`}>打法：{f.tactic}</Text>
                  <Text className="force-note">{f.note}</Text>
                  <View className="force-bar"><View className={`force-fill ${f.kind}`} style={{ width: `${f.strength}%` }} /></View>
                </View>
              ))}
            </View>
          ) : (
            <View className="force-empty card" onClick={() => goChat('agentKey=general&continue=1')}>
              <Text className="fe-t serif">三势判断待生成</Text>
              <Text className="fe-d">先和军师聊清目标、现状和卡点，天势 / 市势 / 人势会显示在这里。</Text>
              <Text className="fe-go" style={{ color: accent }}>去对话 ›</Text>
            </View>
          )}
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

        {/* 固定底部 CTA 让位（内容不被浮层遮挡） */}
        <View className="battle-cta-spacer" />
      </View>

      {/* 认可判断 CTA（battle-cta 三态机）：固定底部，浮于底栏之上（设计 §4.5） */}
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

      {/* 三势全解 sheet（设计 §4.6 forces）：3 条 force-read + 合参结论 */}
      {forcesOpen ? (
        <View className="fs-mask" onClick={() => setForcesOpen(false)} catchMove>
          <View className="fs-sheet" onClick={(e) => e.stopPropagation()}>
            <View className="fs-grip" />
            <Text className="fs-kicker">三 势 合 参</Text>
            <Text className="fs-title serif">三势全解：先拆三势，再做合参</Text>
            <Text className="fs-quote">三势不是三个孤立指标。天势决定能不能借风，市势决定怎么差异化，人势决定能不能放大。</Text>
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
            <Text className="fs-close" onClick={() => setForcesOpen(false)}>收起</Text>
          </View>
        </View>
      ) : null}

      {/* 认可判断额度/套餐异常 → 付费 / 异常屏（V7-03 全局组件填充；此处按需挂载） */}
      <PaySheet
        open={payOpen}
        mode="member"
        title="续费会员，继续认可判断"
        desc="套餐已到期，续费后可继续一键生成军令与报告。"
        confirmText="去续费"
        onConfirm={() => setPayOpen(false)}
        onClose={() => setPayOpen(false)}
      />
      <ExceptionSheet
        open={exceptionOpen}
        kind="power"
        title="算力不足"
        desc="本月额度已用尽，补充算力或升级套餐后再生成军令与报告。"
        onPrimary={() => setExceptionOpen(false)}
        onClose={() => setExceptionOpen(false)}
      />

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
