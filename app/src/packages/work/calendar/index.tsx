import { useState } from 'react';
import { View, Text, Input, Canvas, Image } from '@tarojs/components';
import Taro, { useDidShow, useShareAppMessage } from '@tarojs/taro';
import Login from '../../../components/Login';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { store } from '../../../services/store';
import { api, type ChartSummary } from '../../../services/api';
import { renderCardToImage, shareCardImage, saveCardImage, wrapText, roundRect } from '../../../services/canvasCard';
import './index.scss';

// 天时日历卡逻辑尺寸（画布按 dpr 放大）
const CW = 600;
const CH = 940;

// 全年天时（战局「天势」卡的落地页）：排盘引擎算好的 12 个月攻守直接原生展示——
// 不引导对话、不跳网页；右上角微信转发可分享（朋友打开看自己的天时，没命盘就地补生辰）。
// 网页打印版（publishCard calendar）降级为页脚次要入口，供打印贴办公室。
// 转发落地约束：被转发者是冷启动直达本页——未登录不外弹（本页自己承接 Login），
// 401 一律 silent 处理不跳走；返回键无页面栈时兜底切回战局 tab。

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

// D6：按月份/闰年校验非法日（阳历用格里历月长；农历大小月 29/30，无历表时按 30 保守放行）。
function isLeap(y: number): boolean { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function monthDays(cal: 'solar' | 'lunar', y: number, m: number): number {
  if (cal === 'lunar') return 30;
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 31;
}
function validBirth(cal: 'solar' | 'lunar', y: number, m: number, d: number): boolean {
  return y >= 1930 && y <= new Date().getFullYear() && m >= 1 && m <= 12 && d >= 1 && d <= monthDays(cal, y, m);
}

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
  const [showLogin, setShowLogin] = useState(false);
  const [imgPath, setImgPath] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false); // P0-2：命理下线（/me 或端点 403 FEATURE_DISABLED）→ 友好降级

  const authed = s.isAuthed();
  const errCode = (e: unknown) => String((e as { code?: string; data?: { code?: string } })?.code || (e as { data?: { code?: string } })?.data?.code || '');
  const loadChart = () => {
    api.myChart().then((r) => { setChart(r.chart); setLoaded(true); }).catch((e) => {
      setLoaded(true);
      if (errCode(e) === 'FEATURE_DISABLED') { setDisabled(true); setChart(null); return; } // 命理下线：静默降级，不弹错
      // 转发冷启动可能带着过期 token：静默处理，留在本页走登录承接，绝不弹走
      if (s.handleApiError(e, { silent: true }) === 'unauthorized') setChart(null);
    });
  };
  useDidShow(() => {
    if (!s.isAuthed()) { setLoaded(true); return; }
    store.loadMe().catch(() => {}); // 拉最新命理开关（合规态可能已变）
    loadChart();
  });

  // 命理总开关关闭：全年天时属命理能力，直接降级（不渲染命盘/排盘表单）。
  const fortuneOff = authed && (disabled || !s.fortuneOn());

  // 冷启动（被转发者直达本页）无页面栈：返回键兜底切回战局 tab
  const goBack = () => {
    if (Taro.getCurrentPages().length > 1) Taro.navigateBack();
    else Taro.switchTab({ url: '/pages/home/index' }).catch(() => Taro.reLaunch({ url: '/pages/home/index' }));
  };

  useShareAppMessage(() => ({
    title: chart ? `我的 ${chart.monthlyOutlook.year} 年天时日历——看看你全年该攻还是守` : '看看你全年哪几个月该攻、哪几个月该守',
    path: '/packages/work/calendar/index',
  }));

  // 例行 QA 2026-07-08：出生年上限曾写死 2020（早于当前年份的过时常量），与
  // server/src/routes/profile.ts 的动态上限（now().getFullYear()）及主入口 Picker（无年份上限）不一致，
  // 2021 年及以后出生年份会被前端静默拦下（按钮置灰无提示）。改为跟随当前年份。
  const valid = validBirth(calendar, +year, +month, +day);
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
      if (errCode(e) === 'FEATURE_DISABLED') { setDisabled(true); Taro.showToast({ title: '命理能力已下线', icon: 'none' }); }
      else if (s.handleApiError(e, { silent: true }) === 'unauthorized') setShowLogin(true);
      else Taro.showToast({ title: '排盘失败，请重试', icon: 'none' });
    }
    setBusy(false);
  };

  // 出图：把天时日历卡画到 canvas 导出图片——发好友/存相册（存相册即可打印贴办公室），无公开链接
  const makeImage = async () => {
    if (!chart || busy) return;
    setBusy(true);
    setImgPath(null);
    Taro.showLoading({ title: '生成天时日历图…' });
    try {
      const path = await renderCardToImage('tcalCanvas', CW, CH, (ctx) => paintCalendarCard(ctx, chart));
      Taro.hideLoading();
      setImgPath(path);
      Taro.showToast({ title: '图已生成 · 存相册或发给朋友', icon: 'none' });
    } catch {
      Taro.hideLoading();
      Taro.showToast({ title: '生成失败，请重试', icon: 'none' });
    }
    setBusy(false);
  };
  const shareImage = () => imgPath && shareCardImage(imgPath);
  const saveImage = () => imgPath && saveCardImage(imgPath);

  const nowMonth = new Date().getMonth() + 1;
  const months = chart?.monthlyOutlook?.months ?? [];
  const current = months.find((m) => m.month === nowMonth);
  const turningMonths = months.filter((m) => m.turning).map((m) => `${m.month}月`).join('、');

  return (
    <View className={`page tcal ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="全年天时" onBack={goBack} />
      <View className="pad">
        {fortuneOff ? (
          <View className="tc-hero">
            <Text className="tc-year serif">全年天时暂不可用</Text>
            <Text className="tc-sub">军师已按当前策略暂停命理视角的经营节奏推演。你的战略判断、军令与复盘不受影响，可继续在参谋室与军师对话。</Text>
          </View>
        ) : !authed ? (
          <>
            <View className="tc-hero">
              <Text className="tc-year serif">看看你全年该攻还是守</Text>
              <Text className="tc-sub">军师按你的生辰逐月推演经营节奏：哪几个月适合签约扩张、哪几个月该收缩保现金流、拐点在哪。登录后一分钟生成。</Text>
            </View>
            <View className="tc-btn" style={{ background: accent, marginTop: '26px' }} onClick={() => setShowLogin(true)}>
              <Text>登录 · 看我的全年天时</Text>
            </View>
          </>
        ) : chart ? (
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
              <Text className="tc-share-hint">点右上角「···」可把本页转发给朋友，让他也看看自己的全年节奏</Text>
              <View className={`tc-imgbtn ${busy ? 'off' : ''}`} style={!busy ? { background: accent } : {}} onClick={makeImage}>
                <Text>{busy ? '生成中…' : imgPath ? '重新生成图片' : '生成天时日历图片 · 存相册/发朋友'}</Text>
              </View>
            </View>

            {imgPath ? (
              <View className="tc-result">
                <Image className="tc-img" src={imgPath} mode="widthFix" showMenuByLongpress />
                <View className="tc-img-acts">
                  <View className="tc-img-act" style={{ background: accent }} onClick={shareImage}><Text>发给朋友</Text></View>
                  <View className="tc-img-act ghost" style={{ borderColor: accent }} onClick={saveImage}><Text style={{ color: accent }}>保存到相册</Text></View>
                </View>
                <Text className="tc-img-tip">也可长按图片保存或转发。</Text>
              </View>
            ) : null}
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
        {/* 离屏画布：仅用于生成图片 */}
        <Canvas type="2d" id="tcalCanvas" className="tc-canvas" style={{ width: `${CW}px`, height: `${CH}px` }} />

        <Text className="tc-foot">命理内容为文化视角的经营节奏参考，不构成决策依据；「人谋可以改命」。</Text>
      </View>
      <Login open={showLogin} onLoggedIn={() => { setShowLogin(false); loadChart(); }} />
    </View>
  );
}

// —— canvas 画天时日历卡（12 月攻守网格，固定军师参谋部品牌配色，不随本命色）——
function paintCalendarCard(ctx: CanvasRenderingContext2D, chart: ChartSummary) {
  const W = CW;
  const months = chart.monthlyOutlook.months;
  const yr = chart.monthlyOutlook.year;

  // 底：暖纸
  ctx.fillStyle = '#FBFAF6';
  ctx.fillRect(0, 0, W, CH);

  // 封面（深绿渐变）
  const headH = 188;
  const g = ctx.createLinearGradient(0, 0, W, headH);
  g.addColorStop(0, '#1E5A43');
  g.addColorStop(1, '#123C2C');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, headH);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#D9C48A';
  ctx.font = '22px sans-serif';
  ctx.fillText('◆ 军师参谋部 · 天势研判 ◆', W / 2, 52);
  ctx.fillStyle = '#FBFAF6';
  ctx.font = 'bold 48px serif';
  ctx.fillText(`${yr} 年天时日历`, W / 2, 112);
  ctx.fillStyle = 'rgba(251,250,246,.72)';
  ctx.font = '23px sans-serif';
  ctx.fillText(`${chart.pattern.name} · 引擎按你的命盘逐月推演`, W / 2, 154);

  // 12 月网格（3 列 × 4 行）
  const padX = 40, gap = 14, cols = 3;
  const cellW = (W - padX * 2 - gap * (cols - 1)) / cols;
  const cellH = 92;
  const gridTop = headH + 30;
  const phaseStyle: Record<string, { bg: string; fg: string }> = {
    进攻: { bg: 'rgba(30,90,67,.12)', fg: '#1E5A43' },
    防守: { bg: 'rgba(180,140,30,.16)', fg: '#8A6D1F' },
    平稳: { bg: '#F0EFEA', fg: '#565C63' },
  };
  months.forEach((m, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = padX + col * (cellW + gap);
    const y = gridTop + row * (cellH + gap);
    const st = phaseStyle[m.phase] || phaseStyle['平稳'];
    ctx.fillStyle = st.bg;
    roundRect(ctx, x, y, cellW, cellH, 14); ctx.fill();
    if (m.turning) {
      ctx.strokeStyle = '#6B4E9E'; ctx.lineWidth = 2;
      roundRect(ctx, x + 1, y + 1, cellW - 2, cellH - 2, 13); ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = st.fg;
    ctx.font = 'bold 30px serif';
    ctx.fillText(`${m.month}月`, x + cellW / 2, y + 42);
    ctx.font = '22px sans-serif';
    ctx.fillText(`${m.phase}${m.turning ? ' ·拐点' : ''}`, x + cellW / 2, y + 74);
  });

  let y = gridTop + 4 * (cellH + gap) + 8;

  // 图例
  ctx.textAlign = 'left';
  ctx.font = '21px sans-serif';
  const legends: [string, string][] = [['进攻月', '#1E5A43'], ['防守月', '#8A6D1F'], ['平稳月', '#565C63'], ['◆拐点', '#6B4E9E']];
  let lx = padX;
  legends.forEach(([label, color]) => {
    ctx.fillStyle = color;
    ctx.fillText(`■ ${label}`, lx, y);
    lx += ctx.measureText(`■ ${label}`).width + 22;
  });
  y += 40;

  // 口径行
  const turning = months.filter((m) => m.turning).map((m) => `${m.month}月`).join('、');
  ctx.fillStyle = '#16191D';
  ctx.font = '24px serif';
  y = wrapText(ctx, `日主 ${chart.dayMaster.gan}${chart.dayMaster.element} · ${chart.dayMaster.strength}${turning ? ` · 拐点在 ${turning}` : ''}`, padX, y + 6, W - padX * 2, 38);
  ctx.fillStyle = '#565C63';
  ctx.font = '22px sans-serif';
  y = wrapText(ctx, '进攻月宜主动布局，防守月宜收缩练功；重大动作尽量避开拐点月首尾。', padX, y + 6, W - padX * 2, 36);

  // 裂变位
  const boxY = CH - 176;
  ctx.fillStyle = '#F1F7F3';
  roundRect(ctx, padX, boxY, W - padX * 2, 96, 16); ctx.fill();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#969BA1';
  ctx.font = '21px sans-serif';
  ctx.fillText('想要完整的天势 × 战略诊断？', W / 2, boxY + 40);
  ctx.fillStyle = '#1E5A43';
  ctx.font = 'bold 28px serif';
  ctx.fillText('找军师参谋部', W / 2, boxY + 74);

  ctx.fillStyle = '#B4B8BE';
  ctx.font = '19px sans-serif';
  ctx.fillText('命理为文化视角的经营节奏参考，不构成决策依据', W / 2, CH - 38);
}
