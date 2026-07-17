import { useEffect, useState } from 'react';
import { View, Text, Input, Picker } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { api, type OnboardingStage, type OnboardingMsg, type OnboardingAdvanceBody, type BaziBody } from '../../services/api';
import { store } from '../../services/store';
import { useStore } from '../../hooks/useStore';
import { COLORS, colorByKey } from '../../data/colors';
import { cjkOrd, useTypewriter } from '../proto';
import './index.scss';

// 入帐引导（原型 splash/color/industry/judge/… 皮）—— 全程走真实 /onboarding 三接口（state/advance/result）。
// 顺序以后端 stage 为准（后端序：帅旗→营生→阶段→痛点→生辰→FORGE）——本命色第一问，贴原型「色在首」：
// 一进帐先择帅旗、满帐随色而变。视觉套原型皮，顺序听后端。

// 十二时辰（含「不确定」）——与 components/ChatView 的 SHICHEN 同源，供后端排盘。
const SHICHEN: { label: string; hour: number | null }[] = [
  { label: '不确定', hour: null },
  { label: '子 23-1', hour: 0 }, { label: '丑 1-3', hour: 2 }, { label: '寅 3-5', hour: 4 },
  { label: '卯 5-7', hour: 6 }, { label: '辰 7-9', hour: 8 }, { label: '巳 9-11', hour: 10 },
  { label: '午 11-13', hour: 12 }, { label: '未 13-15', hour: 14 }, { label: '申 15-17', hour: 16 },
  { label: '酉 17-19', hour: 18 }, { label: '戌 19-21', hour: 20 }, { label: '亥 21-23', hour: 22 },
];

// 每个 stage 的题眉序数 + 短名（按后端实际顺序 1→5：帅旗→营生→阶段→痛点→生辰）。
const STAGE_META: Partial<Record<OnboardingStage, { ord: number; kicker: string }>> = {
  ASK_COLOR: { ord: 1, kicker: '定帅旗' },
  ASK_INDUSTRY: { ord: 2, kicker: '立案卷' },
  ASK_STAGE: { ord: 3, kicker: '量阶段' },
  ASK_PAIN: { ord: 4, kicker: '究痛点' },
  ASK_BAZI: { ord: 5, kicker: '留生辰' },
};

type Phase = 'splash' | 'stage' | 'judge';

interface Props {
  authed: boolean;
  onNeedLogin: () => void;
  onDone: () => void;
}

export default function Onboarding({ authed, onNeedLogin, onDone }: Props) {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [phase, setPhase] = useState<Phase>('splash');
  const [stage, setStage] = useState<OnboardingStage>('ASK_COLOR');
  const [messages, setMessages] = useState<OnboardingMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [seatIntent, setSeatIntent] = useState(false);
  const [chosenColor, setChosenColor] = useState('');
  const [freeOpen, setFreeOpen] = useState(false);
  const [freeText, setFreeText] = useState('');
  const [judgeReady, setJudgeReady] = useState(false);

  // 军师首判（FORGE 文案）逐字揭示。
  const forgeText = phase === 'judge' ? (messages[0]?.text || '') : '';
  const { typed, done: typedDone } = useTypewriter(forgeText);

  // 当前问句所在消息（带 choices / widget 的那条），及其上方的铺垫语。
  const choiceMsg = messages.find((m) => m.choices || m.widget) || messages[messages.length - 1];
  const leadMsgs = messages.filter((m) => m !== choiceMsg && m.text);
  const promptText = choiceMsg?.text || messages[messages.length - 1]?.text || '';
  const choices = choiceMsg?.choices || [];
  const widget = choiceMsg?.widget;
  const meta = STAGE_META[stage];

  // 初次挂载：已登录则拉取当前 stage（支持断点续答，跳过 splash）。
  useEffect(() => {
    if (authed) bootstrap(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 登录完成（authed 由假变真）且此前已点「请主公落座」→ 直接进入流程。
  useEffect(() => {
    if (authed && seatIntent) { setSeatIntent(false); bootstrap(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, seatIntent]);

  async function bootstrap(fromSeat: boolean) {
    try {
      const st = await api.onboardingState();
      if (st.stage === 'DONE') { finish(); return; }
      setStage(st.stage);
      setMessages(st.messages);
      if (st.stage === 'FORGE') { setPhase('judge'); poll(); }
      else if (st.stage === 'ASK_COLOR') setPhase(fromSeat ? 'stage' : 'splash');
      else setPhase('stage'); // 断点续答直接落到对应问句
    } catch { /* 拉取失败：停在 splash，用户可再点 */ }
  }

  function onSeat() {
    if (!authed) { setSeatIntent(true); onNeedLogin(); return; }
    bootstrap(true);
  }

  async function advance(body: OnboardingAdvanceBody) {
    if (busy) return;
    setBusy(true);
    setFreeOpen(false);
    setFreeText('');
    try {
      const res = await api.onboardingAdvance(body);
      setStage(res.stage);
      setMessages(res.messages);
      setChosenColor('');
      if (res.stage === 'FORGE') { setPhase('judge'); poll(); }
      else if (res.stage === 'DONE') { finish(); }
      else setPhase('stage');
    } catch (e) {
      Taro.showToast({ title: (e as { message?: string })?.message || '稍后再试', icon: 'none' });
    } finally {
      setBusy(false);
    }
  }

  // FORGE 后轮询《初见断语》（2s 间隔，上限 90s；超时兜底放行进入 App）。
  function poll() {
    let tries = 0;
    const tick = async () => {
      tries += 1;
      try {
        const r = await api.onboardingResult();
        if (r.ready) { setJudgeReady(true); return; }
      } catch { /* 瞬态失败继续轮询 */ }
      if (tries * 2 < 90) setTimeout(tick, 2000);
      else setJudgeReady(true);
    };
    setTimeout(tick, 1500);
  }

  async function finish() {
    store.completeOnboarding();
    store.setSatchelDot(true); // 《初见断语》落锦囊 → 亮朱砂点
    await store.loadMe().catch(() => {});
    onDone();
  }

  // —— 选择笺 ——
  function onPickChoice(c: { label: string; value: string }) {
    if (busy) return;
    if (c.value === '__free__') { setFreeOpen(true); return; }
    if (c.value === '__skip__') { advance({ skip: true }); return; }
    advance({ answer: c.label });
  }
  function submitFree() {
    const v = freeText.trim();
    if (!v) { Taro.showToast({ title: '说一句给军师听', icon: 'none' }); return; }
    advance({ answer: v });
  }

  // —— 本命色（先预览、再落定）——
  function onPickColor(key: string) {
    setChosenColor(key);
    store.setColor(key, false); // 仅本地预览换色，落定时再持久化
  }
  function confirmColor() {
    if (!chosenColor || busy) return;
    store.setColor(chosenColor, true);
    advance({ color: chosenColor });
  }

  // —— 生辰笺 ——
  const onBaziSubmit = (b: BaziBody) => advance({ bazi: b });
  const onBaziSkip = () => advance({ skip: true });

  const kicker = meta ? `${cjkOrd(meta.ord)} · ${meta.kicker}` : '';

  return (
    <View className="onb">
      {/* ===================== SPLASH ===================== */}
      {phase === 'splash' && (
        <View className="onb-splash">
          <Text className="onb-vert" style={{ color: accent }}>运筹帷幄 · 决胜千里</Text>
          <Text className="onb-corner">壹 · 参 谋 部</Text>
          <View className="onb-logo-wrap">
            <View className="onb-logo-ring" style={{ borderColor: accent }} />
            <Text className="onb-logo serif">军<Text style={{ color: accent }}>师</Text></Text>
          </View>
          <View className="onb-rule" style={{ background: accent }} />
          <Text className="onb-slogan">装进微信里的{'\n'}AI 商业参谋部</Text>
          <View className="onb-tags">
            <Text>出谋 · 想清楚</Text>
            <View className="onb-tag-sep" />
            <Text>出活 · 做出来</Text>
          </View>
          <View className="onb-seat proto-btn proto-btn--lg" style={{ background: accent }} onClick={onSeat}>
            <Text>请 主 公 落 座</Text>
          </View>
          <Text className="onb-foot">面向创始人 · 主理人 · 小团队经营者</Text>
        </View>
      )}

      {/* ===================== 逐步问答 ===================== */}
      {phase === 'stage' && (
        <View className="onb-step nos">
          <Text className="proto-kicker onb-step-kicker">{kicker}</Text>
          {leadMsgs.map((m, i) => (
            <Text key={i} className="onb-lead">{m.text}</Text>
          ))}
          <Text className="onb-q">{promptText}</Text>

          {/* 本命色（6 色 2 宫格 + 军师批曰） */}
          {widget === 'color-pick' ? (
            <View className="onb-color-block">
              <Text className="onb-desc">界面随色而变，军师赠你一句批语。日后可在「主公」处更换。</Text>
              <View className="onb-color-grid">
                {COLORS.map((c) => {
                  const sel = c.key === chosenColor;
                  return (
                    <View
                      key={c.key}
                      className={`onb-color-cell ${sel ? 'on' : ''}`}
                      style={sel ? { background: c.acg } : {}}
                      onClick={() => onPickColor(c.key)}
                    >
                      {sel ? <Text className="onb-color-tick" style={{ color: c.hex }}>✓</Text> : null}
                      <View className="onb-color-disc" style={{ background: c.hex }} />
                      <Text className="onb-color-name">{c.name}</Text>
                      <Text className="onb-color-motto">{c.motto}</Text>
                    </View>
                  );
                })}
              </View>
              {chosenColor ? (
                <View className="onb-remark ink-in" style={{ borderLeftColor: accent, background: colorByKey(chosenColor).acg }}>
                  <Text className="proto-kicker">军 师 批 曰</Text>
                  <Text className="onb-remark-t">
                    {colorByKey(chosenColor).motto}。愿主公{colorByKey(chosenColor).name.split(' · ')[1]}字当头，运筹帷幄。
                  </Text>
                </View>
              ) : null}
              {chosenColor ? (
                <View className="onb-next proto-btn" style={{ background: accent, opacity: busy ? 0.6 : 1 }} onClick={confirmColor}>
                  <Text>落 定 · 下 一 步</Text>
                </View>
              ) : null}
            </View>
          ) : widget === 'bazi-form' ? (
            <BaziForm accent={accent} busy={busy} onSubmit={onBaziSubmit} onSkip={onBaziSkip} />
          ) : (
            /* 行业 / 阶段 / 痛点：壹贰叁列表 */
            <View className="onb-list">
              {choices.filter((c) => c.value !== '__free__' && c.value !== '__skip__').map((c, i) => (
                <View key={c.value + i} className="onb-list-row" onClick={() => onPickChoice(c)}>
                  <Text className="onb-idx">{cjkOrd(i + 1)}</Text>
                  <Text className="onb-list-name">{c.label}</Text>
                  <Text className="onb-arrow" style={{ color: accent }}>→</Text>
                </View>
              ))}
              {choices.some((c) => c.value === '__free__') ? (
                freeOpen ? (
                  <View className="onb-free ink-in">
                    <Input
                      className="onb-free-input"
                      value={freeText}
                      focus
                      maxlength={40}
                      placeholder="自己说一句…"
                      onInput={(e) => setFreeText(e.detail.value)}
                      onConfirm={submitFree}
                    />
                    <View className="onb-free-send proto-btn" style={{ background: accent }} onClick={submitFree}><Text>说给军师</Text></View>
                  </View>
                ) : (
                  <View className="onb-list-row" onClick={() => setFreeOpen(true)}>
                    <Text className="onb-idx onb-idx--free">他</Text>
                    <Text className="onb-list-name">{choices.find((c) => c.value === '__free__')?.label}</Text>
                    <Text className="onb-arrow" style={{ color: accent }}>→</Text>
                  </View>
                )
              ) : null}
            </View>
          )}
        </View>
      )}

      {/* ===================== 军师首判 ===================== */}
      {phase === 'judge' && (
        <View className="onb-judge">
          <View className="onb-judge-head">
            <View className="onb-judge-avatar" style={{ background: accent }}><Text className="serif">师</Text></View>
            <View className="onb-judge-id">
              <Text className="onb-judge-name">总军师</Text>
              <Text className="onb-judge-sub">{judgeReady ? '断语已成' : '正在研判 · 落笔《初见断语》'}</Text>
            </View>
            {!judgeReady ? (
              <View className="onb-judge-dots">
                <View className="onb-jd" style={{ background: accent }} />
                <View className="onb-jd d2" style={{ background: accent }} />
                <View className="onb-jd d3" style={{ background: accent }} />
              </View>
            ) : null}
          </View>
          <View className="onb-judge-body nos">
            <Text className="proto-kicker">初 见 军 情</Text>
            <Text className="onb-judge-typed">
              {typed}
              {!typedDone ? <Text className="onb-caret" style={{ background: accent }}> </Text> : null}
            </Text>
            {judgeReady ? (
              <View className="onb-judge-forged ink-in" style={{ borderTopColor: accent, background: colorByKey(s.colorKey()).acg }}>
                <Text className="proto-kicker">初 见 断 语</Text>
                <Text className="onb-judge-forged-t">《初见断语》已写就，收于锦囊——你我初见，我眼中你的局，尽在其中。</Text>
              </View>
            ) : null}
          </View>
          {judgeReady ? (
            <View className="onb-enter proto-btn proto-btn--lg" style={{ background: accent }} onClick={finish}>
              <Text className="onb-enter-t">进 入 参 谋 部</Text>
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

// 内嵌生辰笺（对齐后端 BaziBody；视觉走直角案卷皮）。
function BaziForm({ accent, busy, onSubmit, onSkip }: { accent: string; busy: boolean; onSubmit: (b: BaziBody) => void; onSkip: () => void }) {
  const today = new Date();
  const [calendar, setCalendar] = useState<'solar' | 'lunar'>('solar');
  const [date, setDate] = useState('');
  const [hourIdx, setHourIdx] = useState(0);
  const [gender, setGender] = useState<'male' | 'female' | ''>('');
  const [place, setPlace] = useState('');
  const dateEnd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const submit = () => {
    if (busy) return;
    const [y, m, dd] = date.split('-').map((x) => parseInt(x, 10));
    if (!y || !m || !dd) { Taro.showToast({ title: '先选个生日，或点「不看这层」', icon: 'none' }); return; }
    if (!gender) { Taro.showToast({ title: '排盘需先选性别', icon: 'none' }); return; }
    onSubmit({ calendar, year: y, month: m, day: dd, hour: SHICHEN[hourIdx].hour, gender, birthPlace: place.trim() || undefined });
  };

  return (
    <View className="onb-bazi ink-in">
      <View className="onb-bz-row">
        <Text className="onb-bz-lb">历法</Text>
        <View className="onb-bz-segs">
          {(['solar', 'lunar'] as const).map((cal) => (
            <Text key={cal} className={`onb-chip ${calendar === cal ? 'on' : ''}`} style={calendar === cal ? { background: accent, borderColor: accent } : {}} onClick={() => setCalendar(cal)}>{cal === 'solar' ? '阳历' : '阴历'}</Text>
          ))}
        </View>
      </View>
      <View className="onb-bz-row">
        <Text className="onb-bz-lb">生日</Text>
        <Picker mode="date" start="1930-01-01" end={dateEnd} value={date || '1990-06-18'} onChange={(e) => setDate(String(e.detail.value))}>
          <View className="onb-bz-date">{date ? <Text className="onb-bz-date-v">{date}</Text> : <Text className="onb-bz-date-ph">选择出生日期</Text>}</View>
        </Picker>
      </View>
      <View className="onb-bz-row col">
        <Text className="onb-bz-lb">时辰</Text>
        <View className="onb-bz-grid">
          {SHICHEN.map((t, i) => (
            <Text key={t.label} className={`onb-chip ${hourIdx === i ? 'on' : ''}`} style={hourIdx === i ? { background: accent, borderColor: accent } : {}} onClick={() => setHourIdx(i)}>{t.label}</Text>
          ))}
        </View>
      </View>
      <View className="onb-bz-row">
        <Text className="onb-bz-lb">性别</Text>
        <View className="onb-bz-segs">
          {([['male', '男'], ['female', '女']] as const).map(([g, label]) => (
            <Text key={g} className={`onb-chip ${gender === g ? 'on' : ''}`} style={gender === g ? { background: accent, borderColor: accent } : {}} onClick={() => setGender(g)}>{label}</Text>
          ))}
        </View>
      </View>
      <View className="onb-bz-row">
        <Text className="onb-bz-lb">出生城市</Text>
        <Input className="onb-bz-input" value={place} maxlength={20} placeholder="选填，用于真太阳时校正" onInput={(e) => setPlace(e.detail.value)} />
      </View>
      <View className="onb-bz-acts">
        <Text className="onb-bz-skip" onClick={() => !busy && onSkip()}>不看这层</Text>
        <View className="onb-bz-submit proto-btn" style={{ background: accent, opacity: busy ? 0.6 : 1 }} onClick={submit}>
          <Text>{busy ? '排盘中…' : '留下生辰'}</Text>
        </View>
      </View>
    </View>
  );
}
