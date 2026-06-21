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
const DEFAULT_SURVEY: SurveyQ[] = [
  { key: 'industry', title: '你的行业？', options: ['SaaS / 软件', '消费 / 零售', '制造', '服务 / 咨询', '其他'] },
  { key: 'stage', title: '当前阶段？', options: ['起步 / 验证', 'A 轮前后', '规模化', '稳定盈利'] },
  { key: 'pain', title: '最头疼的事？', options: ['增长乏力', '现金流', '融资', '组织 / 团队', '定位 / 竞争'] },
];

// 入场仪式：选本命色 →（首登）30 秒建档 → 入局。对齐原型 picker 流程。
export default function Picker({ open, first, onClose, onConfirm }: Props) {
  const s = useStore();
  const [sel, setSel] = useState(colorIndex(s.colorKey()));
  const [step, setStep] = useState<'color' | 'profile'>('color');
  const [survey, setSurvey] = useState<SurveyQ[]>(DEFAULT_SURVEY);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [company, setCompany] = useState('');

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
              <Text>完成 · 进入军师</Text>
            </View>
            <Text className="pk-skip" onClick={confirmColor}>暂时跳过</Text>
          </>
        )}
      </View>
    </View>
  );
}
