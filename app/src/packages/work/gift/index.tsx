import { useState } from 'react';
import { View, Text, Input } from '@tarojs/components';
import Taro from '@tarojs/taro';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { api } from '../../../services/api';
import './index.scss';

// 送你一卦（V6.0 §11.4 裂变机制 · ⑩号天命速写卡）：
// 采集朋友生辰 → 服务端排盘引擎现算（不落库，隐私干净）→ 出可分享的天命速写卡链接。
// 卡片底部自带「想要完整的天势×战略诊断？找军师参谋部」引导，形成裂变闭环。

// 十二时辰（含「不确定」）：与建档 Picker 同口径；子时按早子 0 点计。
const SHICHEN: { label: string; hour: number | null }[] = [
  { label: '不确定', hour: null },
  { label: '子 23-1', hour: 0 }, { label: '丑 1-3', hour: 2 }, { label: '寅 3-5', hour: 4 },
  { label: '卯 5-7', hour: 6 }, { label: '辰 7-9', hour: 8 }, { label: '巳 9-11', hour: 10 },
  { label: '午 11-13', hour: 12 }, { label: '未 13-15', hour: 14 }, { label: '申 15-17', hour: 16 },
  { label: '酉 17-19', hour: 18 }, { label: '戌 19-21', hour: 20 }, { label: '亥 21-23', hour: 22 },
];

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
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  const valid = name.trim() && +year >= 1930 && +year <= 2020 && +month >= 1 && +month <= 12 && +day >= 1 && +day <= 31;

  const makeCard = async () => {
    if (!valid || busy) return;
    setBusy(true);
    Taro.showLoading({ title: '排盘出卡中…' });
    try {
      const r = await api.publishCard('fate', {
        friendName: name.trim(),
        friendBazi: { calendar, year: +year, month: +month, day: +day, hour: SHICHEN[hourIdx].hour, gender },
      });
      Taro.hideLoading();
      if (r.htmlUrl) {
        setUrl(r.htmlUrl);
        Taro.setClipboardData({ data: r.htmlUrl, success: () => Taro.showToast({ title: '速写卡链接已复制 · 转给朋友', icon: 'none' }) });
      } else {
        Taro.showToast({ title: '本地预览模式无卡片', icon: 'none' });
      }
    } catch (e) {
      Taro.hideLoading();
      if (s.handleApiError(e) !== 'unauthorized') Taro.showToast({ title: '生成失败，请检查生辰后重试', icon: 'none' });
    }
    setBusy(false);
  };

  const copyAgain = () => url && Taro.setClipboardData({ data: url, success: () => Taro.showToast({ title: '已复制', icon: 'none' }) });

  return (
    <View className={`page gift ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="送你一卦" onBack={() => Taro.navigateBack()} />
      <View className="pad">
        <View className="gf-hero">
          <Text className="gf-ht serif">给朋友出一张「天命速写卡」</Text>
          <Text className="gf-hd">命格速写 · 今年大势 · 一条核心建议。生辰只用来现场排盘，不会保存。</Text>
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

        <View className={`gf-btn ${valid && !busy ? '' : 'off'}`} style={valid ? { background: accent } : {}} onClick={makeCard}>
          <Text>{busy ? '排盘中…' : '出卦 · 生成速写卡'}</Text>
        </View>

        {url ? (
          <View className="gf-done card" onClick={copyAgain}>
            <Text className="gf-dt serif">卡已备好，链接在剪贴板</Text>
            <Text className="gf-dd">发给朋友或发群里。卡片末尾会替你带一句：想要完整的天势×战略诊断，找军师参谋部。</Text>
            <Text className="gf-dl">{url}</Text>
          </View>
        ) : null}

        <Text className="gf-note">朋友的生辰只用于本次排盘，军师不留档。命理内容为文化视角的经营参考，不构成决策依据。</Text>
      </View>
    </View>
  );
}
