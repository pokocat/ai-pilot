import { useEffect, useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Login from '../../components/Login';
import Picker from '../../components/Picker';
import PaySheet from '../../components/PaySheet';
import ExceptionSheet from '../../components/ExceptionSheet';
import Sheet from '../../components/Sheet';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api, type BattleForce, type ForceKind } from '../../services/api';
import { MODULE_MARKET } from '../../data/operatingSystem';
import { refreshDossier, type Dossier } from '../../services/dossier';
import { navTo, switchTo } from '../../services/nav';
import { REVIEW_TIME } from '../../data/constants';
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
  // 首帧水合标记（C2）：未完成首轮拉取前，hero 与三势区渲染骨架，避免兜底文案闪一帧再跳变。
  const [hydrated, setHydrated] = useState(() => !s.isAuthed());
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
    // 今日是否已认可判断（本地按天幂等）→ 直接回显已生成态
    try { if (Taro.getStorageSync(COMMIT_KEY) === dayKey()) setCta('done'); } catch { /* noop */ }
    // 首轮拉取（案卷 + 军师档案）完成后再标记水合，hero/三势区据此收起骨架。
    const jobs: Promise<unknown>[] = [refreshDossier().then(setDossier)];
    if (s.isAuthed()) jobs.push(store.loadMe()); // 刷新军师档案（对话/资料变化后战局判断与三势随之更新）
    Promise.all(jobs).catch(() => {}).then(() => setHydrated(true));
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

  // 三势全解弹层底栏协调（setOverlay）已收敛至 Sheet 基座。

  const requireLogin = () => {
    if (s.isAuthed()) return true;
    setShowLogin(true);
    Taro.showToast({ title: '请先登录后再开始对话', icon: 'none' });
    return false;
  };
  const goChat = (params: string) => {
    if (!requireLogin()) return false;
    navTo(`/packages/main/chat/index?${params}`);
    return true;
  };

  const gapCount = und?.nextQuestions.length ?? 0;
  const riskCount = dossier?.risks.length ?? 0;
  // 案卷完整度：军师档案成熟度（真实状态，不编百分比）
  const maturityLabel = !s.isAuthed() || !und ? '—' : und.maturity === 'ready' ? '可用' : und.maturity === 'forming' ? '整理中' : '待建档';

  const refresh = () => {
    // C5：toast 移到全部刷新完成后再提示，避免「已刷新」抢在数据回来之前弹出。
    const jobs: Promise<unknown>[] = [refreshDossier().then(setDossier)];
    if (s.isAuthed()) {
      jobs.push(api.refreshForces().then(() => store.loadMe()).catch(s.handleApiError)); // V7-04：刷新结构化三势后回读 /me
    }
    Promise.all(jobs).then(() => Taro.showToast({ title: '军情已刷新', icon: 'none' }));
  };
  const startInterview = () =>
    goChat(`agentKey=general&fresh=1&send=${encodeURIComponent('帮我补齐军师档案：你先问我最关键的 1-3 个问题，我来答。')}`);
  const askRisks = () =>
    goChat(`agentKey=strat&fresh=1&send=${encodeURIComponent('基于我当前的情况，给我 2-3 条「现在不能做」的风险锁，并说明原因。')}`);

  // 三势全解：点整卡/小框 → 半屏 sheet（看全解）。无三势时不弹。
  const openForces = () => { if (forces.length) setForcesOpen(true); };

  // 认可判断 → 生成军令与报告（三态机）：idle→generating→done。
  const handleBattleCta = () => {
    if (cta === 'generating') return; // 生成中锁定
    if (cta === 'done') { switchTo('/pages/studio/index'); return; } // 已生成 → 去执行页看军令与报告
    if (!requireLogin()) return;
    setCta('generating');
    api.battleCommit()
      .then(() => {
        try { Taro.setStorageSync(COMMIT_KEY, dayKey()); } catch { /* noop */ }
        setCta('done');
        store.loadMe();
        refreshDossier().then(setDossier); // 认可即建案卷、拆军令 → 刷新下一步/不能做
        Taro.showToast({ title: '军令与方案已生成', icon: 'none' });
      })
      .catch((e: unknown) => {
        setCta('idle');
        const code = String((e as { code?: string; data?: { code?: string } })?.code || (e as { data?: { code?: string } })?.data?.code || '');
        if (code === 'PLAN_EXPIRED') { setPayOpen(true); return; } // 套餐过期 → 续费付费屏
        if (code === 'INSUFFICIENT_QUOTA' || code === 'INSUFFICIENT_CREDITS' || code === 'SKU_REQUIRED') { setExceptionOpen(true); return; } // 额度/算力不足 → 异常屏
        s.handleApiError(e);
      });
  };

  const ctaText = cta === 'generating'
    ? { t: '正在生成军令与方案…', s: '读取案卷、战局和执行建议', icon: '…' }
    : cta === 'done'
      ? { t: '已生成 → 查看军令与方案', s: `已同步到执行页、方案库和 ${REVIEW_TIME} 复盘`, icon: '✓' }
      : { t: '认可判断 → 生成军令与方案', s: `同步到执行页、方案库和 ${REVIEW_TIME} 复盘`, icon: '›' };

  return (
    <Screen topInset className="home">
      <View className="pad">
        {/* 页头（对齐设计稿）：左「案卷」· 中「军情」· 右刷新 */}
        <View className="battle-nav tab-page-head">
          <Text className="bn-side left serif" onClick={() => requireLogin() && navTo('/packages/work/projects/index')}>案卷</Text>
          <Text className="bn-title serif">军情</Text>
          <Text className="bn-side right" onClick={refresh}>↻</Text>
        </View>

        {/* 军师判断 hero：主题色主要矛盾 + 案卷来源行 */}
        <View className="battle-hero" onClick={() => goChat('agentKey=general&continue=1')}>
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
                {dossier ? `当前案卷 · ${dossier.title} · 军师持续推演，动态校准` : '还没有战略案卷 · 认可军师方案，即刻成卷'}
              </Text>
              <Text className="bh-title serif">
                {und?.mainContradiction || und?.summary || dossier?.judgment || '先和军师聊聊当前处境，判断会沉淀在这里'}
              </Text>
            </>
          )}
        </View>

        {/* 战局信号（metric-grid）：案卷完整度 / 待补资料 / 风险锁 —— 全部真实状态 */}
        <View className="metric-grid">
          <View className="metric card" onClick={() => requireLogin() && navTo('/packages/main/brief/index')}>
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
          <View className="force-head" onClick={forces.length ? openForces : undefined}>
            <Text className="battle-h2">三 势 判 断</Text>
            {forces.length ? (
              <Text className="force-hint"><Text className="fh-b">整卡</Text>看全解 · 小框看单势</Text>
            ) : null}
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
      </Sheet>

      {/* 认可判断额度/套餐异常 → 付费 / 异常屏（V7-03 全局组件填充；此处按需挂载） */}
      <PaySheet
        open={payOpen}
        mode="member"
        title="续费会员，继续认可判断"
        desc="套餐已到期，续费后可继续一键生成军令与方案。"
        confirmText="去续费"
        onConfirm={() => setPayOpen(false)}
        onClose={() => setPayOpen(false)}
      />
      <ExceptionSheet
        open={exceptionOpen}
        kind="power"
        title="算力不足"
        desc="本月额度已用尽，补充算力或升级套餐后再生成军令与方案。"
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
