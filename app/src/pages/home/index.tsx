import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import AdvisorAvatar from '../../components/AdvisorAvatar';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api, type ChartSummary, type ReportItem, type SessionItem } from '../../services/api';
import { refreshDossier, pendingOrdersOf, doneOrdersOf, today, toggleOrder, type Dossier, type DossierOrder } from '../../services/dossier';
import { ADVISOR_ALIAS } from '../../data/council';
import { CAPABILITIES, capabilityFor } from '../../data/capabilities';
import './index.scss';

function markDate(): string {
  const d = new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function relTime(iso: string): string {
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec < 3600) return '刚刚';
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  const d = Math.floor(sec / 86400);
  return d === 1 ? '昨天' : `${d} 天前`;
}

// 军情（tab1）—— 沙盘：把「聊出来的东西」和「该做的事」陈列出来。
// 一屏五章（章法排版，非行动不设框）：①玄墨断语卡 ②三势 ③今日军令卡 ④各线督办 ⑤麾下。
// 数据全部来自真实对话产物（案卷/档案/命盘/会话），不预置结论；首登承接在问策页，此处不再触发建档弹层。
export default function Home() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [chart, setChart] = useState<ChartSummary | null>(null);
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const und = s.me()?.understanding;

  const load = () => {
    refreshDossier().then(setDossier).catch(() => setDossier(null));
    if (s.isAuthed()) {
      store.loadMe(); // 刷新军师档案（对话/资料变化后三势结论随之更新）
      api.myChart().then((r) => setChart(r.chart)).catch(() => setChart(null));
      api.reports().then(setReports).catch(() => setReports([]));
      api.sessions().then(setSessions).catch(() => setSessions([]));
    } else {
      setChart(null); setReports([]); setSessions([]);
    }
  };

  useDidShow(() => {
    s.setTab(1);
    Taro.getCurrentInstance().page?.getTabBar?.();
    load();
  });

  const goCounsel = () => Taro.switchTab({ url: '/pages/counsel/index' });
  const goStudio = () => Taro.navigateTo({ url: '/pages/studio/index' });
  const goRoster = () => Taro.navigateTo({ url: '/pages/roster/index' });
  const openReport = (id: string) => Taro.navigateTo({ url: `/packages/work/report/index?id=${id}` });
  const openThread = (agentKey: string) => Taro.navigateTo({ url: `/pages/chat/index?agentKey=${agentKey}&continue=1` });
  const openSession = (id: string) => Taro.navigateTo({ url: `/pages/chat/index?sessionId=${id}` });

  const refresh = () => {
    load();
    Taro.showToast({ title: '军情已更新', icon: 'none' });
  };

  // ① 断语：案卷主判断（真实成果内容）；无案卷时用档案主要矛盾兜底
  const verdict = dossier?.judgment || und?.mainContradiction || und?.summary || '';

  // ② 三势：天势=命盘当月；市/人=档案研判结论，报告反查。
  // 三行永远渲染（非 map/spread 派生，避免 forces 数据 shape 变化时行数跟着变）：
  // 每行独立取值——有真结论显真结论，没有则显预填文案 + 入帐引导。
  const forceReport = (match: string): ReportItem | undefined =>
    reports.find((r) => r.title.includes(match) || r.type.includes(match));
  const month = chart?.monthlyOutlook?.months?.find((x) => x.month === new Date().getMonth() + 1);
  const shishi = und?.forces?.shishi ?? null;
  const renshi = und?.forces?.renshi ?? null;
  const shishiRep = forceReport('市势');
  const renshiRep = forceReport('人势');
  const forces: { key: string; desc: string; act: () => void }[] = [
    {
      key: '天势',
      desc: month ? `本月宜${month.phase}，按命盘逐月推演` : '留个生辰，可多看一层天时',
      act: () => Taro.navigateTo({ url: '/packages/work/calendar/index' }),
    },
    {
      key: '市势',
      desc: shishi ? `${shishi.verdict}${shishi.note ? ` · ${shishi.note}` : ''}` : shishiRep ? `已研判 · ${shishiRep.title}` : '尚未研判，入帐一议',
      act: shishiRep ? () => openReport(shishiRep.id) : goCounsel,
    },
    {
      key: '人势',
      desc: renshi ? `${renshi.verdict}${renshi.note ? ` · ${renshi.note}` : ''}` : renshiRep ? `已研判 · ${renshiRep.title}` : '尚未研判，入帐一议',
      act: renshiRep ? () => openReport(renshiRep.id) : goCounsel,
    },
  ];

  // ③ 今日军令：≤3 条行内打卡（乐观更新）；命中能力映射的行给「去办」按钮
  const todayDate = today();
  const pending = pendingOrdersOf(dossier, todayDate);
  const done = doneOrdersOf(dossier, todayDate);
  const shownOrders = [...pending, ...done].slice(0, 3);
  const onToggle = (id: string) => {
    setDossier((cur) => (cur ? { ...cur, orders: cur.orders.map((o) => (o.id === id ? { ...o, done: !o.done } : o)) } : cur));
    toggleOrder(id).then(setDossier).catch(() => refreshDossier().then(setDossier));
  };
  const dispatchOrder = (o: DossierOrder) => {
    const cap = capabilityFor(o.capabilityKey);
    if (!cap) return;
    // external 配置就绪后走 navigateToMiniProgram / webview 外跳（届时补 app.config 白名单）；本期一律站内军师线程承接。
    Taro.navigateTo({ url: `/pages/chat/index?agentKey=${cap.agentKey}&fresh=1&send=${encodeURIComponent(`${cap.prompt}\n军令：「${o.text}」`)}` });
  };

  // ④ 各线督办：专业军师线程（非总军师）按 agentKey 取最新一条会话
  const lines = (() => {
    const seen = new Set<string>();
    const out: SessionItem[] = [];
    for (const it of sessions) {
      if (it.agentKey === 'general' || seen.has(it.agentKey)) continue;
      seen.add(it.agentKey);
      out.push(it);
    }
    return out.slice(0, 5);
  })();

  return (
    <Screen topInset className="battle">
      <View className="pad">
        {/* 页头：左「案卷」· 题「军情」· 右刷新 */}
        <View className="battle-nav tab-page-head">
          <Text className="bn-side left serif" onClick={() => Taro.navigateTo({ url: '/packages/work/projects/index' })}>案卷</Text>
          <Text className="bn-title serif">军情</Text>
          <Text className="bn-side right" onClick={refresh}>↻</Text>
        </View>

        {/* ① 玄墨断语卡（全站唯一深底） */}
        <View className="verdict-card ink-in" onClick={goCounsel}>
          <View className="vc-seal seal-dot" style={{ background: accent }} />
          {verdict ? (
            <>
              <Text className="vc-text t-display">{verdict}</Text>
              <Text className="vc-mark t-mark">军师 · {markDate()}</Text>
            </>
          ) : (
            <>
              <Text className="vc-text t-display empty">军师尚未为你立断。{'\n'}先入帐一叙。</Text>
              <Text className="vc-mark t-mark">去问策 ›</Text>
            </>
          )}
        </View>

        {/* ② 三势（题眉 + 细线 + 三行，非卡片） */}
        <View className="chapter">
          <View className="chapter-head">
            <Text className="t-kicker">三 势</Text>
            <View className="rule" />
          </View>
          {forces.map((f, i) => (
            <View key={f.key} className={`force-row ink-in ink-in-${i + 1}`} onClick={f.act}>
              <View className="seal-char" style={{ background: accent }}><Text>{f.key.slice(0, 1)}</Text></View>
              <Text className="fr-desc t-body">{f.desc}</Text>
              <Text className="fr-go">›</Text>
            </View>
          ))}
        </View>

        {/* ③ 今日军令卡（可操作故有卡） */}
        <View className="chapter">
          <View className="chapter-head">
            <Text className="t-kicker">今 日 军 令</Text>
            <View className="rule" />
          </View>
          {shownOrders.length ? (
            <View className="orders-card card ink-in">
              {shownOrders.map((o) => {
                const cap = capabilityFor(o.capabilityKey);
                return (
                  <View key={o.id} className="order-row">
                    <View className={`order-check ${o.done ? 'on' : ''}`} style={o.done ? { background: accent, borderColor: accent } : {}} onClick={() => onToggle(o.id)}>
                      {o.done ? <Icon name="check" size={12} color="#fff" /> : null}
                    </View>
                    <Text className={`order-text t-body ${o.done ? 'done' : ''}`}>{o.text}</Text>
                    {cap && !o.done ? (
                      <View className="order-dispatch pill" onClick={(e) => { e.stopPropagation?.(); dispatchOrder(o); }}>
                        <Text>去办 · {ADVISOR_ALIAS[cap.agentKey] || cap.label}</Text>
                      </View>
                    ) : null}
                  </View>
                );
              })}
              <View className="orders-foot" onClick={goStudio}>
                <Text className="of-t">回填 · 复盘 · 详</Text>
                <Text className="of-go">›</Text>
              </View>
            </View>
          ) : (
            <View className="orders-empty ink-in" onClick={goCounsel}>
              <Text className="oe-t t-body">军令未立。让军师为你拆一道。</Text>
              <Text className="oe-go">›</Text>
            </View>
          )}
        </View>

        {/* ④ 各线督办（题眉 + 行式；无则整章隐藏） */}
        {lines.length ? (
          <View className="chapter">
            <View className="chapter-head">
              <Text className="t-kicker">各 线 督 办</Text>
              <View className="rule" />
            </View>
            {lines.map((it, i) => (
              <View key={it.id} className={`line-row ink-in ink-in-${Math.min(i + 1, 5)}`} onClick={() => openSession(it.id)}>
                <AdvisorAvatar agentKey={it.agentKey} size={30} />
                <View className="lr-b">
                  <View className="lr-top">
                    <Text className="lr-name serif">{ADVISOR_ALIAS[it.agentKey] || it.agentName}</Text>
                    <Text className="lr-time t-mark">{relTime(it.updatedAt)}</Text>
                  </View>
                  <Text className="lr-snippet">{it.snippet || it.title}</Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {/* ⑤ 麾下（题眉 + 行式：五位创作军师，生态位） */}
        <View className="chapter">
          <View className="chapter-head">
            <Text className="t-kicker">麾 下</Text>
            <View className="rule" />
            <Text className="chapter-more" onClick={goRoster}>点将 ›</Text>
          </View>
          {CAPABILITIES.map((c, i) => {
            const a = s.agents().find((x) => x.key === c.agentKey);
            if (!a) return null;
            return (
              <View key={c.key} className={`line-row ink-in ink-in-${Math.min(i + 1, 5)}`} onClick={() => openThread(c.agentKey)}>
                <AdvisorAvatar agentKey={c.agentKey} size={30} />
                <View className="lr-b">
                  <View className="lr-top">
                    <Text className="lr-name serif">{ADVISOR_ALIAS[c.agentKey] || a.name}</Text>
                    <Text className="pill em" style={{ background: accent, borderColor: accent }}>生态</Text>
                  </View>
                  <Text className="lr-snippet">{a.name} · {c.label}</Text>
                </View>
                <Text className="lr-go">›</Text>
              </View>
            );
          })}
        </View>
      </View>
    </Screen>
  );
}
