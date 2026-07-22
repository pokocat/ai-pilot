import { useEffect, useRef, useState } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import SafeHeader from '../../../components/SafeHeader';
import { COLORS, colorIndex } from '../../../data/colors';
import { api, type SurveyQ } from '../../../services/api';
import { store } from '../../../services/store';
import { switchTo } from '../../../services/nav';
import { useStore } from '../../../hooks/useStore';
import './index.scss';

// 本地兜底问卷：与 components/Picker 保持同一份口径（后端不可达/未播种时仍完整问三题）。
// 真相源在服务端 /survey；此处离线兜底，需与 Picker 同步维护。
const DEFAULT_SURVEY: SurveyQ[] = [
  { key: 'industry', title: '你的行业？', options: ['SaaS / 软件', '电商 / 跨境', '餐饮 / 食品', '美业 / 医美', '大健康 / 养生', '教育 / 培训', '医疗 / 医药', '制造 / 工业', '专业服务 / 咨询', '本地生活服务', '文旅 / 酒店', '房产 / 家居', '消费 / 零售', '其他'] },
  { key: 'stage', title: '年营收大概在？', options: ['100 万以下', '100-500 万', '500 万-5000 万', '5000 万以上'] },
  { key: 'pain', title: '最头疼的事？', options: ['增长乏力', '现金流', '融资', '组织 / 团队', '定位 / 竞争'] },
];

type Step = 'color' | 'casefile' | 'judge';

const LEAD = '军师正在核阅你的案卷，研判当前处境……';
const FALLBACK_TODO = '先把最近 7 天的关键数（线索 / 咨询 / 成交）拉齐——军师入局后据此为你定策。';

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export default function Onboarding() {
  const s = useStore();
  const c = s.color();

  const [step, setStep] = useState<Step>('color');
  const [sel, setSel] = useState(() => colorIndex(store.colorKey()));

  const [survey, setSurvey] = useState<SurveyQ[]>(DEFAULT_SURVEY);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({}); // 选「其他」时的自填内容，按题存
  const [company, setCompany] = useState('');
  const submittingRef = useRef(false);

  // 首判（打字机 + 主要矛盾卡）
  const [typed, setTyped] = useState('');
  const [settled, setSettled] = useState(false); // api.generate 已定局（成功或降级）
  const [mainConflict, setMainConflict] = useState('');
  const [todoOne, setTodoOne] = useState('');
  const targetRef = useRef('');

  useEffect(() => {
    // 后端有问卷就用后端的，否则保留本地兜底（内容不变，与 Picker 一致）
    api.survey().then((qs) => { if (qs?.length) setSurvey(qs); }).catch(() => {});
  }, []);

  // 择色：整页立即换主题（store 状态驱动 themeClass）+ 持久化（store.setColor→api.setColor）。
  const pick = (i: number) => {
    setSel(i);
    store.setColor(COLORS[i].key, true);
  };

  const isOtherOpt = (v?: string) => v === '其他' || v === '其它';
  // 有效答案：选「其他」时以自填内容替换标签落库（自填为空则视为未答）。
  const effectiveAnswers = () => {
    const out: Record<string, string> = {};
    for (const q of survey) {
      const a = answers[q.key];
      if (!a) continue;
      out[q.key] = isOtherOpt(a) ? (custom[q.key] || '').trim() : a;
    }
    return out;
  };
  const surveyDone = survey.length > 0 && survey.every((q) => {
    const a = answers[q.key];
    if (!a) return false;
    return isOtherOpt(a) ? !!(custom[q.key] || '').trim() : true; // 选「其他」必须补自填
  });

  // 打字机：进入 judge 后持续朝 targetRef 逐字推进。
  useEffect(() => {
    if (step !== 'judge') return;
    const id = setInterval(() => {
      setTyped((t) => (t.length >= targetRef.current.length ? t : targetRef.current.slice(0, t.length + 1)));
    }, 55);
    return () => clearInterval(id);
  }, [step]);

  // 首判请求：进入 judge 步骤时即发出，走 api.quickScan（POST /quickscan，每日 3 次限流）。
  // stage 答案 = revenueBand（与 quickscan 页一致，营收段选项即 band）；pain 答案作痛点入参。
  // 失败 / 超限（RATE_LIMITED）/ 空 → 优雅降级为一句兜底，仍可入局。
  const runJudge = async (ans: Record<string, string>) => {
    targetRef.current = LEAD;
    setTyped('');
    setSettled(false);
    const industry = ans.industry || '你所在的行业';
    const pain = ans.pain || '眼下的难处';
    const degrade = () => {
      setMainConflict(pain);
      setTodoOne(FALLBACK_TODO);
      targetRef.current = `${LEAD}\n\n「${industry}」这一行，眼下最吃紧的是「${pain}」。此为初步军情——正式入局后，军师再与你逐条对策。`;
    };
    try {
      const res = await withTimeout(
        api.quickScan({ industry: ans.industry || industry, revenueBand: ans.stage || '', pain }),
        18000,
      );
      const judgment = (res.judgement || '').trim();
      if (judgment) {
        setMainConflict((res.contradiction || '').trim() || pain);
        setTodoOne((res.firstMove || '').trim() || FALLBACK_TODO);
        targetRef.current = `${LEAD}\n\n${judgment}`;
      } else {
        degrade();
      }
    } catch {
      degrade();
    }
    setSettled(true);
  };

  // 立案卷 → 首判：等价于 Picker.finishProfile（company + 问卷）+ completeOnboarding。
  const submitCasefile = async () => {
    if (submittingRef.current || !surveyDone) return;
    submittingRef.current = true;
    const eff = effectiveAnswers();
    try {
      if (company.trim()) await api.updateIdentity({ company: company.trim() }).catch(() => {});
      if (Object.keys(eff).length) await api.saveProfile(eff).catch(() => {});
      await store.loadMe();
      store.completeOnboarding(); // 建档即视为已入局（本地标记 + 后端 Profile 已落）
    } finally {
      // 无论后端是否成功，都进入首判（首判只读展示，不再写档）。
      setStep('judge');
      runJudge(eff);
    }
  };

  const enterHQ = () => {
    store.completeOnboarding();
    switchTo('/pages/home/index');
  };

  const judgeDone = settled && typed.length >= targetRef.current.length && targetRef.current.length > 0;

  return (
    <View className={`page onboarding ${s.themeClass()}`}>
      {/* 顶部安全区统一走 SafeHeader（AGENTS.md §7.2：页面内不得自测胶囊）；仪式页无返回键、无标题，纯让位。 */}
      <SafeHeader className="ob-head" left={<View />} rightReserve={false} />
      <ScrollView scrollY className="ob-scroll" enhanced showScrollbar={false}>
        {step === 'color' && (
          <View className="ob-step" key="color">
            <Text className="ob-kicker">壹 · 入 部</Text>
            <Text className="ob-title serif">择一枚本命色</Text>
            <Text className="ob-lead">一色一势。选中此后与你并肩的那一枚——军师的判词，也会随之落墨。</Text>

            <View className="ob-grid">
              {COLORS.map((cc, i) => (
                <View
                  key={cc.key}
                  className={`ob-color ${i === sel ? 'on' : ''}`}
                  onClick={() => pick(i)}
                >
                  <View className="oc-head">
                    <View className="oc-dot" style={{ background: cc.vars['--accent'] }} />
                    <Text className="oc-name serif">{cc.cn}</Text>
                    {i === sel && <Text className="oc-check">✓</Text>}
                  </View>
                  <Text className="oc-motto">{cc.verdict}</Text>
                </View>
              ))}
            </View>

            {/* 默认选中项也要出批语：批曰块常驻，内容随当前选色而变 */}
            <View className="ob-quote" key={c.key}>
              <Text className="oq-label">军 师 批 曰</Text>
              <Text className="oq-body serif">「{c.verdict}」</Text>
            </View>

            <View className="ob-cta serif" onClick={() => setStep('casefile')}>
              <Text>落 定 · 下 一 步</Text>
            </View>
          </View>
        )}

        {step === 'casefile' && (
          <View className="ob-step" key="casefile">
            <Text className="ob-kicker">贰 · 立 案 卷</Text>
            <Text className="ob-title serif">先给军师交个底</Text>
            <Text className="ob-lead">三两下说清你的营生，答得越实，军师判得越准。</Text>

            {/* 全部问题统一为紧凑 chip 云（含行业），去掉编号、尽量收进一屏；选「其他」就地展开自填框 */}
            {survey.map((q) => (
              <View key={q.key} className="ob-field">
                <Text className="of-label">{q.title}</Text>
                <View className="of-chips">
                  {q.options.map((opt) => (
                    <View
                      key={opt}
                      className={`of-chip ${answers[q.key] === opt ? 'on' : ''}`}
                      onClick={() => setAnswers((a) => ({ ...a, [q.key]: opt }))}
                    >
                      <Text>{opt}</Text>
                    </View>
                  ))}
                </View>
                {isOtherOpt(answers[q.key]) && (
                  <Input
                    className="of-input of-other"
                    value={custom[q.key] || ''}
                    maxlength={20}
                    placeholder={`请补一句你的${q.title.replace(/[？?]/g, '')}`}
                    onInput={(e) => setCustom((m) => ({ ...m, [q.key]: e.detail.value }))}
                  />
                )}
              </View>
            ))}

            <View className="ob-field">
              <Text className="of-label">公司 / 品牌名</Text>
              <Input
                className="of-input"
                value={company}
                maxlength={40}
                placeholder="选填，便于军师称呼与建档"
                onInput={(e) => setCompany(e.detail.value)}
              />
            </View>

            <View
              className={`ob-cta serif ${surveyDone ? '' : 'disabled'}`}
              onClick={submitCasefile}
            >
              <Text>{surveyDone ? '请 军 师 首 判' : '先答完上面几题'}</Text>
            </View>
          </View>
        )}

        {step === 'judge' && (
          <View className="ob-step" key="judge">
            <View className="ob-marshal">
              <View className="om-seal serif"><Text>师</Text></View>
              <View className="om-meta">
                <Text className="om-title serif">总军师 · {judgeDone ? '研判已毕' : '正在研判'}</Text>
                {!judgeDone && (
                  <View className="om-dots">
                    <View className="omd" /><View className="omd" /><View className="omd" />
                  </View>
                )}
              </View>
            </View>

            <Text className="ob-kicker">初 步 军 情</Text>
            <Text className="ob-judge serif">
              {typed}
              {!judgeDone && <Text className="ob-caret">▍</Text>}
            </Text>

            {judgeDone && (
              <>
                <View className="ob-conflict" key="conflict">
                  <Text className="ocf-label">主 要 矛 盾</Text>
                  <Text className="ocf-body serif">{mainConflict}</Text>
                </View>
                {!!todoOne && (
                  <View className="ob-todo" key="todo">
                    <Text className="ot-label">今 日 一 事</Text>
                    <Text className="ot-body">{todoOne}</Text>
                  </View>
                )}
                <View className="ob-cta serif" onClick={enterHQ}>
                  <Text>进 入 参 谋 部</Text>
                </View>
              </>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
