import { useState, useEffect } from 'react';
import { View, Text, Input, Canvas, Image } from '@tarojs/components';
import Taro from '@tarojs/taro';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { store } from '../../../services/store';
import { api, type FateCardContent } from '../../../services/api';
import { renderCardToImage, shareCardImage, saveCardImage, wrapText, roundRect } from '../../../services/canvasCard';
import './index.scss';

// 送你一卦（天命速写卡 · 裂变）——合规打磨版（AUDIT P-4）：
// 朋友生辰 → 服务端现算命盘（不落库、无公开链接）→ 返回卡文本 → 小程序端 canvas 画卡导出**图片**。
// 图片由用户自己发给朋友/存相册（文件点对点，无可爬取的公开 URL）；采集第三人生辰前必须勾选「已获对方同意」（PIPL）。

const SHICHEN: { label: string; hour: number | null }[] = [
  { label: '不确定', hour: null },
  { label: '子 23-1', hour: 0 }, { label: '丑 1-3', hour: 2 }, { label: '寅 3-5', hour: 4 },
  { label: '卯 5-7', hour: 6 }, { label: '辰 7-9', hour: 8 }, { label: '巳 9-11', hour: 10 },
  { label: '午 11-13', hour: 12 }, { label: '未 13-15', hour: 14 }, { label: '申 15-17', hour: 16 },
  { label: '酉 17-19', hour: 18 }, { label: '戌 19-21', hour: 20 }, { label: '亥 21-23', hour: 22 },
];

// 卡片逻辑尺寸（画布按 dpr 放大）
const CW = 600;
const CH = 880;

export default function Gift() {
  const s = useStore();
  const c = s.color();
  const accent = c.vars['--accent'];
  const [name, setName] = useState('');
  const [calendar, setCalendar] = useState<'solar' | 'lunar'>('solar');
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  const [day, setDay] = useState('');
  const [hourIdx, setHourIdx] = useState(0);
  const [gender, setGender] = useState<'male' | 'female'>('male');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imgPath, setImgPath] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false); // P0-2：命理下线 → 友好降级
  const errCode = (e: unknown) => String((e as { code?: string; data?: { code?: string } })?.code || (e as { data?: { code?: string } })?.data?.code || '');
  // 拉最新命理开关（深链直达也能拿到真态）
  useEffect(() => { if (s.isAuthed()) store.loadMe().catch(() => {}); }, []);
  const fortuneOff = disabled || !s.fortuneOn();

  // 例行 QA 2026-07-08：出生年上限曾写死 2020（早于当前年份的过时常量），与
  // server/src/routes/profile.ts 的动态上限（now().getFullYear()）及主入口 Picker（无年份上限）不一致，
  // 2021 年及以后出生年份会被前端静默拦下（按钮置灰无提示）。改为跟随当前年份。
  const dateOk = +year >= 1930 && +year <= new Date().getFullYear() && +month >= 1 && +month <= 12 && +day >= 1 && +day <= 31;
  const valid = !!name.trim() && dateOk && consent;

  const makeCard = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setImgPath(null);
    Taro.showLoading({ title: '排盘出卡中…' });
    try {
      const content = await api.fateCardPreview({
        friendName: name.trim(),
        friendBazi: { calendar, year: +year, month: +month, day: +day, hour: SHICHEN[hourIdx].hour, gender },
        consent: true,
      });
      const path = await renderCardToImage('fateCanvas', CW, CH, (ctx) => paintFateCard(ctx, content));
      Taro.hideLoading();
      setImgPath(path);
      Taro.showToast({ title: '卡已生成 · 保存或发给朋友', icon: 'none' });
    } catch (e) {
      Taro.hideLoading();
      if (errCode(e) === 'FEATURE_DISABLED') { setDisabled(true); Taro.showToast({ title: '命理能力已下线', icon: 'none' }); }
      else if (s.handleApiError(e) !== 'unauthorized') Taro.showToast({ title: '生成失败，请检查生辰后重试', icon: 'none' });
    }
    setBusy(false);
  };

  const shareImage = () => imgPath && shareCardImage(imgPath);
  const saveImage = () => imgPath && saveCardImage(imgPath);

  return (
    <View className={`page gift ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="送你一卦" onBack={() => Taro.navigateBack()} />
      {fortuneOff ? (
        <View className="pad">
          <View className="gf-hero">
            <Text className="gf-ht serif">天命速写卡暂不可用</Text>
            <Text className="gf-hd">军师已按当前策略暂停命理速写。你与军师的战略对话、方案与复盘不受影响。</Text>
          </View>
        </View>
      ) : (
      <View className="pad">
        <View className="gf-hero">
          <Text className="gf-ht serif">给朋友出一张「天命速写卡」</Text>
          <Text className="gf-hd">命格速写 · 今年大势 · 一条核心建议。生辰只用于本次现场排盘，服务器不保存、不生成公开链接——出的是一张图片，你自己发给朋友。</Text>
        </View>

        <View className="pf-q">
          <Text className="pf-qt">1. 朋友怎么称呼</Text>
          <Input className="pf-input" value={name} maxlength={12} placeholder="如：老王" onInput={(e) => setName(e.detail.value)} />
        </View>

        <View className="pf-q">
          <Text className="pf-qt">2. 出生日期</Text>
          <View className="pf-opts">
            {(['solar', 'lunar'] as const).map((cal) => (
              <View key={cal} className={`pf-opt ${calendar === cal ? 'on' : ''}`}
                style={calendar === cal ? { background: accent, borderColor: accent } : {}}
                onClick={() => setCalendar(cal)}>
                <Text>{cal === 'solar' ? '阳历' : '阴历'}</Text>
              </View>
            ))}
          </View>
          <View className="gf-date">
            <Input className="pf-input gf-y" type="number" value={year} maxlength={4} placeholder="年" onInput={(e) => setYear(e.detail.value)} />
            <Input className="pf-input gf-md" type="number" value={month} maxlength={2} placeholder="月" onInput={(e) => setMonth(e.detail.value)} />
            <Input className="pf-input gf-md" type="number" value={day} maxlength={2} placeholder="日" onInput={(e) => setDay(e.detail.value)} />
          </View>
        </View>

        <View className="pf-q">
          <Text className="pf-qt">3. 时辰（不确定也没关系）</Text>
          <View className="pf-opts">
            {SHICHEN.map((t, i) => (
              <View key={t.label} className={`pf-opt ${hourIdx === i ? 'on' : ''}`}
                style={hourIdx === i ? { background: accent, borderColor: accent } : {}}
                onClick={() => setHourIdx(i)}>
                <Text>{t.label}</Text>
              </View>
            ))}
          </View>
        </View>

        <View className="pf-q">
          <Text className="pf-qt">4. 性别</Text>
          <View className="pf-opts">
            {([['male', '男'], ['female', '女']] as const).map(([g, label]) => (
              <View key={g} className={`pf-opt ${gender === g ? 'on' : ''}`}
                style={gender === g ? { background: accent, borderColor: accent } : {}}
                onClick={() => setGender(g)}>
                <Text>{label}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* 同意声明（PIPL：采集第三人敏感生辰前必须确认已获授权） */}
        <View className="gf-consent" onClick={() => setConsent((v) => !v)}>
          <View className="gf-check" style={consent ? { background: accent, borderColor: accent } : {}}>
            {consent ? <Text className="gf-tick">✓</Text> : null}
          </View>
          <Text className="gf-consent-t">我已获得对方同意，使用其生辰为其出一张天命速写卡。</Text>
        </View>

        <View className={`gf-btn ${valid && !busy ? '' : 'off'}`} style={valid ? { background: accent } : {}} onClick={makeCard}>
          <Text>{busy ? '排盘中…' : imgPath ? '重新出卦' : '出卦 · 生成速写卡'}</Text>
        </View>

        {imgPath ? (
          <View className="gf-result">
            <Image className="gf-img" src={imgPath} mode="widthFix" showMenuByLongpress />
            <View className="gf-acts">
              <View className="gf-act" style={{ background: accent }} onClick={shareImage}><Text>发给朋友</Text></View>
              <View className="gf-act ghost" style={{ borderColor: accent }} onClick={saveImage}><Text style={{ color: accent }}>保存到相册</Text></View>
            </View>
            <Text className="gf-tip">也可长按上方图片保存或转发。</Text>
          </View>
        ) : null}

        {/* 离屏画布：仅用于生成图片，不直接展示 */}
        <Canvas type="2d" id="fateCanvas" className="gf-canvas" style={{ width: `${CW}px`, height: `${CH}px` }} />

        <Text className="gf-note">朋友的生辰只用于本次排盘，服务器不留档、不生成公开链接。命理内容为文化视角的经营参考，不构成决策依据。</Text>
      </View>
      )}
    </View>
  );
}

// —— canvas 画卡（深色描金封面 + 暖纸正文，对齐 renderFateCard 视觉体系）——
function paintFateCard(ctx: CanvasRenderingContext2D, content: FateCardContent) {
  const W = CW;
  // 底：暖纸
  ctx.fillStyle = '#FBFAF6';
  ctx.fillRect(0, 0, W, CH);

  // 封面（深色渐变）
  const headH = 210;
  const g = ctx.createLinearGradient(0, 0, W, headH);
  g.addColorStop(0, '#16191D');
  g.addColorStop(1, '#2A2333');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, headH);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#C9A227';
  ctx.font = '22px sans-serif';
  ctx.fillText('◆ 军师参谋部 · 天机速写 ◆', W / 2, 56);
  ctx.fillStyle = '#FBFAF6';
  ctx.font = 'bold 52px serif';
  ctx.fillText('天命速写', W / 2, 122);
  ctx.fillStyle = 'rgba(251,250,246,.72)';
  ctx.font = '24px sans-serif';
  ctx.fillText(content.subtitle, W / 2, 168);

  // 正文
  ctx.textAlign = 'left';
  let y = headH + 56;
  const padX = 48;
  const maxW = W - padX * 2;

  const section = (label: string, body: string, quote = false) => {
    ctx.fillStyle = quote ? '#1E5A43' : '#8A6D1F';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(label, padX, y);
    y += 38;
    ctx.fillStyle = quote ? '#1E5A43' : '#16191D';
    ctx.font = `${quote ? 'bold ' : ''}28px serif`;
    y = wrapText(ctx, body, padX, y, maxW, 42);
    y += 34;
  };

  section('命 格 速 写', content.sketch);
  section('今 年 大 势', content.trend);
  section('一 条 建 议', `「${content.advice}」`, true);

  // 裂变位
  const boxY = CH - 210;
  ctx.fillStyle = '#F1F7F3';
  roundRect(ctx, padX, boxY, maxW, 108, 16);
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#969BA1';
  ctx.font = '22px sans-serif';
  ctx.fillText('想要完整的天势 × 战略诊断？', W / 2, boxY + 46);
  ctx.fillStyle = '#1E5A43';
  ctx.font = 'bold 30px serif';
  ctx.fillText('找军师参谋部', W / 2, boxY + 84);

  ctx.fillStyle = '#B4B8BE';
  ctx.font = '20px sans-serif';
  ctx.fillText('命理为文化视角的经营参考，不构成决策依据', W / 2, CH - 44);
}
