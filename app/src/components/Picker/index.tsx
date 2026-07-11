import { useEffect, useState } from 'react';
import { View, Text, Input } from '@tarojs/components';
import { COLORS, colorIndex } from '../../data/colors';
import { api, type SurveyQ } from '../../services/api';
import { store } from '../../services/store';
import { useStore } from '../../hooks/useStore';
import './index.scss';

interface Props {
  open: boolean;
  first: boolean; // 首登强制选择（无关闭按钮 + 带建档）
  onClose: () => void;
  onConfirm: () => void;
}

// 本地兜底问卷：后端不可达 / 未播种时也能完整展示 3 个问题（内容与服务端 seed 对齐）。
// 行业选项真相源在服务端 server/src/data/industryPacks.ts 的 industryOptionLabels()；此处为离线兜底，需同步维护。
const DEFAULT_SURVEY: SurveyQ[] = [
  { key: 'industry', title: '你的行业？', options: ['SaaS / 软件', '电商 / 跨境', '餐饮 / 食品', '美业 / 医美', '大健康 / 养生', '教育 / 培训', '医疗 / 医药', '制造 / 工业', '专业服务 / 咨询', '本地生活服务', '文旅 / 酒店', '房产 / 家居', '消费 / 零售', '其他'] },
  { key: 'stage', title: '年营收大概在？', options: ['100 万以下', '100-500 万', '500 万-5000 万', '5000 万以上'] },
  { key: 'pain', title: '最头疼的事？', options: ['增长乏力', '现金流', '融资', '组织 / 团队', '定位 / 竞争'] },
];

// 十二时辰（含「不确定」）：值为代表小时，用于服务端排盘；子时按早子 0 点计。
const SHICHEN: { label: string; hour: number | null }[] = [
  { label: '不确定', hour: null },
  { label: '子 23-1', hour: 0 }, { label: '丑 1-3', hour: 2 }, { label: '寅 3-5', hour: 4 },
  { label: '卯 5-7', hour: 6 }, { label: '辰 7-9', hour: 8 }, { label: '巳 9-11', hour: 10 },
  { label: '午 11-13', hour: 12 }, { label: '未 13-15', hour: 14 }, { label: '申 15-17', hour: 16 },
  { label: '酉 17-19', hour: 18 }, { label: '戌 19-21', hour: 20 }, { label: '亥 21-23', hour: 22 },
];

// 入场仪式：选本命色 →（首登）30 秒建档 → 天势档案（选填）→ 入局。对齐原型 picker 流程。
export default function Picker({ open, first, onClose, onConfirm }: Props) {
  const s = useStore();
  const fortuneOn = s.fortuneOn(); // P0-2：命理关 → 跳过天势档案（八字采集）步骤
  const [sel, setSel] = useState(colorIndex(s.colorKey()));
  const [step, setStep] = useState<'color' | 'profile' | 'bazi'>('color');
  const [survey, setSurvey] = useState<SurveyQ[]>(DEFAULT_SURVEY);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [company, setCompany] = useState('');
  const [bz, setBz] = useState<{ calendar: 'solar' | 'lunar'; year: string; month: string; day: string; hourIdx: number; gender: 'male' | 'female' | ''; place: string }>({
    calendar: 'solar', year: '', month: '', day: '', hourIdx: 0, gender: '', place: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setSel(colorIndex(s.colorKey()));
      setStep('color');
    }
  }, [open]);

  useEffect(() => {
    // 后端有数据就用后端的，否则保留本地兜底问卷
    if (first) api.survey().then((qs) => { if (qs?.length) setSurvey(qs); }).catch(() => {});
  }, [first]);

  // custom-tab-bar 是原生层、z-index 压不住；统一交给 store.setOverlay 桥接原生底栏和自定义底栏。
  useEffect(() => {
    store.setOverlay(open, 'benming-picker');
    return () => store.setOverlay(false, 'benming-picker');
  }, [open]);

  if (!open) return null;
  const c = COLORS[sel];

  const pick = (i: number) => {
    setSel(i);
    store.setColor(COLORS[i].key, false); // 实时预览，不持久化
  };

  const confirmColor = () => {
    store.setColor(c.key, true);
    store.completeOnboarding();
    onConfirm();
  };

  const next = () => {
    if (first) setStep('profile');
    else confirmColor();
  };

  const finishProfile = async () => {
    // 称呼已在登录时必填，这里不再重复采集；仅收公司（选填）与问卷。
    if (company.trim()) await api.updateIdentity({ company: company.trim() }).catch(() => {});
    if (Object.keys(answers).length) await api.saveProfile(answers).catch(() => {});
    await store.loadMe();
    if (first && fortuneOn) setStep('bazi'); // 命理关则不进天势档案，直接入局
    else confirmColor();
  };

  // 天势档案：生辰交给服务端排盘引擎；跳过/不用命理都放行，绝不卡入局。
  const finishBazi = async () => {
    const y = parseInt(bz.year, 10); const m = parseInt(bz.month, 10); const d = parseInt(bz.day, 10);
    if (!y || !m || !d) { confirmColor(); return; } // 没填完整视同跳过
    if (!bz.gender) return; // 排盘必须有性别（按钮态提示）
    setSaving(true);
    await api.saveBazi({
      calendar: bz.calendar, year: y, month: m, day: d,
      hour: SHICHEN[bz.hourIdx].hour, gender: bz.gender,
      birthPlace: bz.place.trim() || undefined,
    }).catch(() => {});
    setSaving(false);
    confirmColor();
  };
  const optOutBazi = async () => {
    await api.saveBazi({ believe: false }).catch(() => {});
    confirmColor();
  };

  return (
    <View className="picker">
      <View className="pk-card" style={{ borderColor: c.vars['--accent-soft'] }}>
        {!first && (
          <View className="pk-close" onClick={onClose}>
            <Text>✕</Text>
          </View>
        )}

        {step === 'color' && (
          <>
            <Text className="pk-idx">本命色 0{sel + 1} / 06</Text>
            <Text className="pk-headline serif">{first ? '入局之前，择一本命色' : '更换你的本命色'}</Text>

            <View className="pk-hero" style={{ background: c.vars['--accent'] }}>
              <Text className="pk-wm serif">{c.wm}</Text>
              <View className="pk-seal" style={{ borderColor: 'rgba(255,255,255,.5)' }}>
                <Text className="serif">{c.seal}</Text>
              </View>
              <Text className="pk-cn serif">{c.cn}</Text>
              <Text className="pk-en">{c.en}</Text>
            </View>

            <Text className="pk-verdict serif">「{c.verdict}」</Text>

            <View className="pk-swatches">
              {COLORS.map((cc, i) => (
                <View
                  key={cc.key}
                  className="pk-swatch"
                  onClick={() => pick(i)}
                >
                  <View className={`pk-disc ${i === sel ? 'on' : ''}`}>
                    <View className="disc-dot" style={{ background: cc.vars['--accent'] }} />
                  </View>
                  <Text className={i === sel ? 'on' : ''}>{cc.short}</Text>
                </View>
              ))}
            </View>

            <View className="pk-cta" style={{ background: c.vars['--accent'] }} onClick={next}>
              <Text>{first ? '下一步 · 完善档案' : `以${c.short}入局`}</Text>
            </View>
          </>
        )}

        {step === 'profile' && (
          <>
            <Text className="pk-idx">30 秒建档</Text>
            <Text className="pk-headline serif">让军师更懂你的处境</Text>
            <Text className="pk-sub">先认识一下你，产出会据此量身定制。</Text>

            <View className="pf-id">
              <Input
                className="pf-input"
                value={company}
                maxlength={40}
                placeholder="公司 / 品牌名（选填）"
                onInput={(e) => setCompany(e.detail.value)}
              />
            </View>

            <View className="pf-list">
              {survey.map((q, qi) => (
                <View key={q.key} className="pf-q">
                  <Text className="pf-qt">{qi + 1}. {q.title}</Text>
                  <View className="pf-opts">
                    {q.options.map((opt) => (
                      <View
                        key={opt}
                        className={`pf-opt ${answers[q.key] === opt ? 'on' : ''}`}
                        style={answers[q.key] === opt ? { background: c.vars['--accent'], borderColor: c.vars['--accent'] } : {}}
                        onClick={() => setAnswers((a) => ({ ...a, [q.key]: opt }))}
                      >
                        <Text>{opt}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              ))}
            </View>

            <View className="pk-cta" style={{ background: c.vars['--accent'] }} onClick={finishProfile}>
              <Text>{first && fortuneOn ? '下一步 · 天势档案' : '完成 · 进入军师'}</Text>
            </View>
            <Text className="pk-skip" onClick={confirmColor}>暂时跳过</Text>
          </>
        )}

        {step === 'bazi' && (
          <>
            <Text className="pk-idx">天势档案 · 选填</Text>
            <Text className="pk-headline serif">让军师看一眼你的天势</Text>
            <Text className="pk-sub">生辰用于判断你的命格打法与今年攻守节奏（系统排盘，可随时删除）；不想用命理视角，跳过即可。</Text>

            <View className="pf-list">
              <View className="pf-q">
                <Text className="pf-qt">1. 生日（{bz.calendar === 'solar' ? '阳历' : '阴历'}）</Text>
                <View className="pf-opts">
                  {(['solar', 'lunar'] as const).map((cal) => (
                    <View
                      key={cal}
                      className={`pf-opt ${bz.calendar === cal ? 'on' : ''}`}
                      style={bz.calendar === cal ? { background: c.vars['--accent'], borderColor: c.vars['--accent'] } : {}}
                      onClick={() => setBz((v) => ({ ...v, calendar: cal }))}
                    >
                      <Text>{cal === 'solar' ? '阳历' : '阴历'}</Text>
                    </View>
                  ))}
                </View>
                <View className="bz-date">
                  <Input className="pf-input bz-y" type="number" value={bz.year} maxlength={4} placeholder="年" onInput={(e) => setBz((v) => ({ ...v, year: e.detail.value }))} />
                  <Input className="pf-input bz-md" type="number" value={bz.month} maxlength={2} placeholder="月" onInput={(e) => setBz((v) => ({ ...v, month: e.detail.value }))} />
                  <Input className="pf-input bz-md" type="number" value={bz.day} maxlength={2} placeholder="日" onInput={(e) => setBz((v) => ({ ...v, day: e.detail.value }))} />
                </View>
              </View>

              <View className="pf-q">
                <Text className="pf-qt">2. 时辰（不确定也没关系）</Text>
                <View className="pf-opts">
                  {SHICHEN.map((t, i) => (
                    <View
                      key={t.label}
                      className={`pf-opt ${bz.hourIdx === i ? 'on' : ''}`}
                      style={bz.hourIdx === i ? { background: c.vars['--accent'], borderColor: c.vars['--accent'] } : {}}
                      onClick={() => setBz((v) => ({ ...v, hourIdx: i }))}
                    >
                      <Text>{t.label}</Text>
                    </View>
                  ))}
                </View>
              </View>

              <View className="pf-q">
                <Text className="pf-qt">3. 性别与出生地</Text>
                <View className="pf-opts">
                  {([['male', '男'], ['female', '女']] as const).map(([g, label]) => (
                    <View
                      key={g}
                      className={`pf-opt ${bz.gender === g ? 'on' : ''}`}
                      style={bz.gender === g ? { background: c.vars['--accent'], borderColor: c.vars['--accent'] } : {}}
                      onClick={() => setBz((v) => ({ ...v, gender: g }))}
                    >
                      <Text>{label}</Text>
                    </View>
                  ))}
                </View>
                <Input className="pf-input" value={bz.place} maxlength={20} placeholder="出生城市（选填，用于真太阳时校正）" onInput={(e) => setBz((v) => ({ ...v, place: e.detail.value }))} />
              </View>
            </View>

            <View
              className="pk-cta"
              style={{ background: c.vars['--accent'], opacity: saving || (!!bz.year && !bz.gender) ? 0.6 : 1 }}
              onClick={() => !saving && finishBazi()}
            >
              <Text>{saving ? '排盘中…' : bz.year && !bz.gender ? '请先选择性别' : '完成 · 进入军师'}</Text>
            </View>
            <Text className="pk-skip" onClick={optOutBazi}>不用命理视角（可在档案里改）</Text>
            <Text className="pk-skip" onClick={confirmColor}>暂时跳过</Text>
          </>
        )}
      </View>
    </View>
  );
}
