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

// 入场仪式：选本命色 →（首登）30 秒建档 → 入局。对齐原型 picker 流程。
export default function Picker({ open, first, onClose, onConfirm }: Props) {
  const s = useStore();
  const [sel, setSel] = useState(colorIndex(s.colorKey()));
  const [step, setStep] = useState<'color' | 'profile'>('color');
  const [survey, setSurvey] = useState<SurveyQ[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      setSel(colorIndex(s.colorKey()));
      setStep('color');
    }
  }, [open]);

  useEffect(() => {
    if (first) api.survey().then(setSurvey).catch(() => {});
  }, [first]);

  // custom-tab-bar 是原生层、z-index 压不住，wx.hideTabBar 对自定义底栏又不可靠；
  // 改用全局 overlay 标志让底栏自己隐藏，弹层按钮不再被遮挡。
  useEffect(() => {
    store.setOverlay(open);
    return () => store.setOverlay(false);
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

  const finishProfile = () => {
    if (Object.keys(answers).length) api.saveProfile(answers).catch(() => {});
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

            <View className="pk-discs">
              {COLORS.map((cc, i) => (
                <View
                  key={cc.key}
                  className={`pk-disc ${i === sel ? 'on' : ''}`}
                  onClick={() => pick(i)}
                >
                  <View className="disc-dot" style={{ background: cc.vars['--accent'] }} />
                </View>
              ))}
            </View>
            <View className="pk-discnames">
              {COLORS.map((cc, i) => (
                <Text key={cc.key} className={i === sel ? 'on' : ''}>{cc.short}</Text>
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
            <Text className="pk-sub">3 个问题，产出会据此为你量身定制。</Text>

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
