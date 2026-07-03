import { useState } from 'react';
import { View, Text, Input } from '@tarojs/components';
import Taro, { useDidShow, useShareAppMessage } from '@tarojs/taro';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { api, type ChartSummary } from '../../../services/api';
import './index.scss';

// 全年天时（战局「天势」卡的落地页）：排盘引擎算好的 12 个月攻守直接原生展示——
// 不引导对话、不跳网页；右上角微信转发可分享（朋友打开看自己的天时，没命盘就地补生辰）。
// 网页打印版（publishCard calendar）降级为页脚次要入口，供打印贴办公室。

const SHICHEN: { label: string; hour: number | null }[] = [
  { label: '不确定', hour: null },
  { label: '子 23-1', hour: 0 }, { label: '丑 1-3', hour: 2 }, { label: '寅 3-5', hour: 4 },
  { label: '卯 5-7', hour: 6 }, { label: '辰 7-9', hour: 8 }, { label: '巳 9-11', hour: 10 },
  { label: '午 11-13', hour: 12 }, { label: '未 13-15', hour: 14 }, { label: '申 15-17', hour: 16 },
  { label: '酉 17-19', hour: 18 }, { label: '戌 19-21', hour: 20 }, { label: '亥 21-23', hour: 22 },
];

const PHASE_HINT: Record<string, string> = {
  进攻: '签约、扩张、上新动作放这几个月',
  平稳: '正常推进、练内功、补短板',
  防守: '收缩保现金流，不宜重大决策',
};

export default function TianshiCalendar() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [chart, setChart] = useState<ChartSummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  // 就地补生辰（老用户建档时跳过了天势档案 → 不用回炉重建档）
  const [calendar, setCalendar] = useState<'solar' | 'lunar'>('solar');
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  const [day, setDay] = useState('');
  const [hourIdx, setHourIdx] = useState(0);
  const [gender, setGender] = useState<'male' | 'female'>('male');
  const [busy, setBusy] = useState(false);

  useDidShow(() => {
    api.myChart().then((r) => { setChart(r.chart); setLoaded(true); }).catch((e) => { setLoaded(true); s.handleApiError(e); });
  });

  useShareAppMessage(() => ({
    title: chart ? `我的 ${chart.monthlyOutlook.year} 年天时日历——看看你全年该攻还是守` : '看看你全年哪几个月该攻、哪几个月该守',
    path: '/packages/work/calendar/index',
  }));

  const valid = +year >= 1930 && +year <= 2020 && +month >= 1 && +month <= 12 && +day >= 1 && +day <= 31;
  const saveBirth = async () => {
    if (!valid || busy) return;
    setBusy(true);
    Taro.showLoading({ title: '排盘中…' });
    try {
      const r = await api.saveBazi({ calendar, year: +year, month: +month, day: +day, hour: SHICHEN[hourIdx].hour, gender });
      Taro.hideLoading();
      if (r.chart) { setChart(r.chart); Taro.showToast({ title: '命盘已生成', icon: 'none' }); }
      else Taro.showToast({ title: '生成失败，请检查生辰', icon: 'none' });
    } catch (e) {
      Taro.hideLoading();
      if (s.handleApiError(e) !== 'unauthorized') Taro.showToast({ title: '排盘失败，请重试', icon: 'none' });
    }
    setBusy(false);
  };

  const printVersion = async () => {
    Taro.showLoading({ title: '生成打印版…' });
    try {
      const r = await api.publishCard('calendar');
      Taro.hideLoading();
      if (r.htmlUrl) Taro.setClipboardData({ data: r.htmlUrl, success: () => Taro.showToast({ title: '打印版链接已复制', icon: 'none' }) });
      else Taro.showToast({ title: '本地预览模式无打印版', icon: 'none' });
    } catch {
      Taro.hideLoading();
      Taro.showToast({ title: '生成失败，请重试', icon: 'none' });
    }
  };

  const nowMonth = new Date().getMonth() + 1;
  const months = chart?.monthlyOutlook?.months ?? [];
  const current = months.find((m) => m.month === nowMonth);
  const turningMonths = months.filter((m) => m.turning).map((m) => `${m.month}月`).join('、');

  return (
    <View className={`page tcal ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="全年天时" onBack={() => Taro.navigateBack()} />
      <View className="pad">
        {chart ? (
          <>
            <View className="tc-hero">
              <Text className="tc-year serif">{chart.monthlyOutlook.year} 年天时日历</Text>
              <Text className="tc-sub">{chart.pattern.name} · 排盘引擎按你的命盘逐月推演{chart.hourKnown ? '' : ' · 时辰未定，按三柱推演'}</Text>
              {current ? <Text className="tc-now-line">本月（{nowMonth}月）：<Text className="tc-now-phase">{current.phase}</Text> —— {PHASE_HINT[current.phase] || ''}</Text> : null}
            </View>

            <View className="tc-grid">
              {months.map((m) => (
                <View key={m.month} className={`tc-cell ${m.phase === '进攻' ? 'atk' : m.phase === '防守' ? 'def' : ''} ${m.turning ? 'turn' : ''} ${m.month === nowMonth ? 'now' : ''}`}>
                  <Text className="tc-m serif">{m.month}月</Text>
                  <Text className="tc-p">{m.phase}{m.turning ? ' · 拐点' : ''}</Text>
                </View>
              ))}
            </View>

            <View className="tc-legend">
              <Text className="lg atk">■ 进攻月</Text>
              <Text className="lg def">■ 防守月</Text>
              <Text className="lg">■ 平稳月</Text>
              <Text className="lg turn">◆ 拐点提前布局</Text>
            </View>

            {turningMonths ? (
              <View className="tc-note card">
                <Text className="tc-nt serif">年度关键节点</Text>
                <Text className="tc-nd">{turningMonths} 是运势转换的拐点月：拐点前后少押重注，提前一个月布局，等势明朗再发力。</Text>
              </View>
            ) : null}

            <View className="tc-actions">
              <Text className="tc-share-hint">点右上角「···」可转发给朋友，让他也看看自己的全年节奏</Text>
              <Text className="tc-print" onClick={printVersion}>生成网页打印版（贴办公室）›</Text>
            </View>
          </>
        ) : loaded ? (
          <>
            <View className="tc-hero">
              <Text className="tc-year serif">先补生辰，解锁你的全年天时</Text>
              <Text className="tc-sub">排盘在服务端引擎完成，只算一次长期使用；只用于经营节奏参考。</Text>
            </View>
            <View className="tc-form">
              <View className="pf-opts">
                {(['solar', 'lunar'] as const).map((cal) => (
                  <View key={cal} className={`pf-opt ${calendar === cal ? 'on' : ''}`}
                    style={calendar === cal ? { background: accent, borderColor: accent } : {}}
                    onClick={() => setCalendar(cal)}>
                    <Text>{cal === 'solar' ? '阳历' : '阴历'}</Text>
                  </View>
                ))}
              </View>
              <View className="tc-date">
                <Input className="pf-input tc-y" type="number" value={year} maxlength={4} placeholder="年" onInput={(e) => setYear(e.detail.value)} />
                <Input className="pf-input tc-md" type="number" value={month} maxlength={2} placeholder="月" onInput={(e) => setMonth(e.detail.value)} />
                <Input className="pf-input tc-md" type="number" value={day} maxlength={2} placeholder="日" onInput={(e) => setDay(e.detail.value)} />
              </View>
              <View className="pf-opts" style={{ marginTop: '10px' }}>
                {SHICHEN.map((t, i) => (
                  <View key={t.label} className={`pf-opt ${hourIdx === i ? 'on' : ''}`}
                    style={hourIdx === i ? { background: accent, borderColor: accent } : {}}
                    onClick={() => setHourIdx(i)}>
                    <Text>{t.label}</Text>
                  </View>
                ))}
              </View>
              <View className="pf-opts" style={{ marginTop: '10px' }}>
                {([['male', '男'], ['female', '女']] as const).map(([g, label]) => (
                  <View key={g} className={`pf-opt ${gender === g ? 'on' : ''}`}
                    style={gender === g ? { background: accent, borderColor: accent } : {}}
                    onClick={() => setGender(g)}>
                    <Text>{label}</Text>
                  </View>
                ))}
              </View>
              <View className={`tc-btn ${valid && !busy ? '' : 'off'}`} style={valid ? { background: accent } : {}} onClick={saveBirth}>
                <Text>{busy ? '排盘中…' : '生成我的天时日历'}</Text>
              </View>
            </View>
          </>
        ) : null}
        <Text className="tc-foot">命理内容为文化视角的经营节奏参考，不构成决策依据；「人谋可以改命」。</Text>
      </View>
    </View>
  );
}
