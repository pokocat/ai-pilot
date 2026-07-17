import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import { ProtoHeader, Watermark, ShiRadar } from '../../components/proto';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api, type ChartSummary } from '../../services/api';
import { refreshDossier, pendingOrdersOf, today, type Dossier } from '../../services/dossier';
import { cjkOrd } from '../../components/proto/ordinals';
import './index.scss';

// 军情（tab1）—— 直角案卷：看今日判断。
// 结构对齐原型 isJunqing 段：今日主要矛盾 hero + 三势研判（雷达+meter）+ 下一步就做/现在别做 双栏 + 拆军令 CTA。
// 数据全部来自真实产物：案卷 judgment/orders/risks（GET /casefile）+ 军师档案 forces/mainContradiction + 命盘天时。

// 研判结论 → 0-100 势值（无真值时给确定性兜底 50 并标「待研判」）。
function verdictScore(v?: string | null): number {
  if (!v) return 50;
  if (v.includes('攻')) return 80;
  if (v.includes('守') || v.includes('防')) return 52;
  if (v.includes('撤')) return 28;
  if (v.includes('等') || v.includes('观')) return 42;
  return 55;
}
function phaseScore(phase?: string | null): number {
  if (!phase) return 50;
  if (phase.includes('攻')) return 80;
  if (phase.includes('平') || phase.includes('稳')) return 55;
  if (phase.includes('守') || phase.includes('防')) return 48;
  if (phase.includes('撤')) return 28;
  return 55;
}

export default function Home() {
  const s = useStore();
  const col = s.color();
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [chart, setChart] = useState<ChartSummary | null>(null);
  const und = s.me()?.understanding;

  const load = () => {
    refreshDossier().then(setDossier).catch(() => setDossier(null));
    if (s.isAuthed()) {
      store.loadMe(); // 刷新军师档案（对话/资料变化后三势结论随之更新）
      api.myChart().then((r) => setChart(r.chart)).catch(() => setChart(null));
    } else {
      setChart(null);
    }
  };

  useDidShow(() => {
    s.setTab(1);
    Taro.getCurrentInstance().page?.getTabBar?.();
    load();
  });

  const goCounsel = () => Taro.switchTab({ url: '/pages/counsel/index' });
  const goJunling = () => Taro.switchTab({ url: '/pages/junling/index' });
  const goCalendar = () => Taro.navigateTo({ url: '/packages/work/calendar/index' });

  // ① 今日主要矛盾：案卷主判断优先，兜底军师档案主要矛盾/摘要。
  const mainConflict = dossier?.judgment || und?.mainContradiction || und?.summary || '';

  // ② 三势研判：天势=命盘当月；市/人=档案 forces 研判结论。无真值时确定性兜底 + 「待研判」。
  const month = chart?.monthlyOutlook?.months?.find((x) => x.month === new Date().getMonth() + 1);
  const shishi = und?.forces?.shishi ?? null;
  const renshi = und?.forces?.renshi ?? null;
  const forces: { key: string; label: string; sub: string; score: number; hasData: boolean; desc: string; act: () => void }[] = [
    {
      key: 'tian', label: '天势', sub: '外部趋势',
      score: phaseScore(month?.phase), hasData: !!month,
      desc: month ? `本月宜${month.phase}${month.turning ? ' · 转折之月' : ''}` : '留个生辰，可多看一层天时',
      act: goCalendar,
    },
    {
      key: 'shi', label: '市势', sub: '竞争市场',
      score: verdictScore(shishi?.verdict), hasData: !!shishi,
      desc: shishi ? `${shishi.verdict}${shishi.note ? ` · ${shishi.note}` : ''}` : '尚未研判，入帐一议',
      act: goCounsel,
    },
    {
      key: 'ren', label: '人势', sub: '自身家底',
      score: verdictScore(renshi?.verdict), hasData: !!renshi,
      desc: renshi ? `${renshi.verdict}${renshi.note ? ` · ${renshi.note}` : ''}` : '尚未研判，入帐一议',
      act: goCounsel,
    },
  ];
  const radarValues: [number, number, number] = [forces[0].score, forces[1].score, forces[2].score];

  // ③ 下一步就做：今日未办军令摘要，兜底军师档案待答问题。
  const pending = pendingOrdersOf(dossier, today());
  const nextSteps = (pending.length
    ? pending.map((o) => o.text)
    : (und?.nextQuestions || [])
  ).slice(0, 3);

  // ④ 现在别做：案卷风险/禁区（casefile risks）。
  const avoidList = (dossier?.risks || []).slice(0, 3);

  const kicker = (letter: string, wide = '.28em', color = 'var(--ac)') =>
    ({ display: 'block' as const, fontFamily: 'var(--serif)', fontSize: '12px', letterSpacing: wide, color, marginBottom: '14px' });

  return (
    <Screen tab topInset className="junqing">
      <View className="pad" style={{ paddingTop: '12px' }}>
        <ProtoHeader kicker="看今日判断" title="军情" watermark="势" />

        {mainConflict ? (
          <>
            {/* ① 今日主要矛盾 hero（水印「势」+ 左 3px 边大字） */}
            <View className="proto-card" style={{ marginTop: '22px', padding: '24px 22px', position: 'relative', overflow: 'hidden', borderColor: 'var(--hair-2)' }}>
              <Watermark char="势" size={88} opacity={0.1} top={4} right={16} />
              <Text style={kicker('势')}>今 日 主 要 矛 盾</Text>
              <Text style={{ display: 'block', fontFamily: 'var(--serif)', fontSize: '26px', fontWeight: 600, lineHeight: 1.5, position: 'relative', borderLeft: `3px solid ${col.hex}`, paddingLeft: '16px' }}>
                {mainConflict}
              </Text>
            </View>

            {/* ② 三势研判：雷达 + 三条 meter */}
            <View className="proto-card" style={{ marginTop: '18px', padding: '20px 22px' }}>
              <Text style={kicker('势', '.28em', 'var(--mut)')}>三 势 研 判</Text>
              <View style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                <ShiRadar values={radarValues} />
                <View style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '15px' }}>
                  {forces.map((f) => (
                    <View key={f.key} onClick={f.act}>
                      <View style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px' }}>
                        <Text style={{ fontSize: '13px', fontWeight: 600, color: 'var(--tx)' }}>
                          {f.label}<Text style={{ fontSize: '11px', color: 'var(--faint)', marginLeft: '6px', fontWeight: 400 }}>{f.sub}</Text>
                        </Text>
                        {f.hasData
                          ? <Text style={{ fontSize: '16px', fontWeight: 600, color: col.hex }}>{f.score}</Text>
                          : <Text style={{ fontSize: '11px', color: 'var(--faint)' }}>待研判</Text>}
                      </View>
                      <View style={{ height: '5px', background: 'var(--surf-3)', overflow: 'hidden' }}>
                        <View style={{ height: '100%', width: `${f.score}%`, background: f.hasData ? col.hex : 'var(--hair-2)' }} />
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            </View>

            {/* ③④ 下一步就做 / 现在别做 双栏 */}
            <View style={{ display: 'flex', gap: '14px', marginTop: '16px' }}>
              <View className="proto-card" style={{ flex: 1, padding: '18px' }}>
                <Text style={kicker('做', '.16em')}>下 一 步 就 做</Text>
                <View style={{ display: 'flex', flexDirection: 'column', gap: '13px' }}>
                  {nextSteps.length ? nextSteps.map((t, i) => (
                    <View key={i} style={{ display: 'flex', gap: '9px', fontSize: '13.5px', lineHeight: 1.55 }}>
                      <Text style={{ color: col.hex, fontWeight: 600, flex: 'none' }}>{cjkOrd(i + 1)}</Text>
                      <Text style={{ color: 'var(--tx)' }}>{t}</Text>
                    </View>
                  )) : (
                    <Text style={{ fontSize: '13px', lineHeight: 1.6, color: 'var(--mut)' }} onClick={goCounsel}>尚无待办 · 入帐一议 ›</Text>
                  )}
                </View>
              </View>
              <View className="proto-card" style={{ flex: 'none', width: '130px', padding: '18px' }}>
                <Text style={{ ...kicker('别', '.16em', '#BC4A31') }}>现 在 别 做</Text>
                <View style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {avoidList.length ? avoidList.map((t, i) => (
                    <Text key={i} style={{ fontSize: '12.5px', lineHeight: 1.55, color: 'var(--mut)' }}>{t}</Text>
                  )) : (
                    <Text style={{ fontSize: '12.5px', lineHeight: 1.55, color: 'var(--faint)' }}>暂无禁区</Text>
                  )}
                </View>
              </View>
            </View>

            {/* ⑤ 把判断拆成今天的军令 CTA */}
            <View
              onClick={goJunling}
              style={{ marginTop: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', border: `1px solid ${col.hex}`, padding: '16px 18px', background: col.acg }}
            >
              <Text style={{ fontSize: '14.5px', fontWeight: 600, color: 'var(--tx)' }}>把判断拆成今天的军令</Text>
              <Text style={{ color: col.hex, fontSize: '20px' }}>→</Text>
            </View>
          </>
        ) : (
          // 空态（未建档）：引导入帐
          <View className="proto-card proto-card--lead" style={{ marginTop: '22px', padding: '24px 22px', position: 'relative', overflow: 'hidden' }}>
            <Watermark char="势" size={88} opacity={0.08} top={4} right={16} />
            <Text style={kicker('势')}>军 情 未 立</Text>
            <Text style={{ display: 'block', fontFamily: 'var(--serif)', fontSize: '18px', lineHeight: 1.8, color: 'var(--tx)', position: 'relative' }}>
              主公，军师尚未为你立断。{'\n'}先入帐一叙，我为你研判三势、点出主要矛盾。
            </Text>
            <View className="proto-btn" style={{ background: col.hex, marginTop: '18px', width: '100%' }} onClick={goCounsel}>
              <Text>去 问 策</Text>
            </View>
          </View>
        )}
      </View>
    </Screen>
  );
}
