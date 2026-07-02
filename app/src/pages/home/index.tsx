import { useEffect, useState } from 'react';
import { View, Text, Image } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import logo from '../../assets/logo.png';
import Icon from '../../components/Icon';
import Picker from '../../components/Picker';
import Login from '../../components/Login';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api } from '../../services/api';
import { MODULE_MARKET, THREE_FORCES } from '../../data/operatingSystem';
import { loadDossier, todayProgress, type Dossier } from '../../services/dossier';
import './index.scss';

function greetWord() {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '傍晚好';
}

function todayLabel() {
  const d = new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// 把 "<em>...</em>" 渲染为强调色片段（跨端，避免 dangerouslySetInnerHTML）
function SayingLine({ html, accent }: { html: string; accent: string }) {
  const parts = html.split(/(<em>.*?<\/em>)/g).filter(Boolean);
  return (
    <Text className="say-line serif">
      {parts.map((p, i) => {
        const m = p.match(/^<em>(.*?)<\/em>$/);
        return m ? (
          <Text key={i} style={{ color: accent, fontWeight: 700 }}>{m[1]}</Text>
        ) : (
          <Text key={i}>{p}</Text>
        );
      })}
    </Text>
  );
}

// 战局页：只回答老板最关心的事——当前判断、还缺什么线索、下一步怎么落。
// 判断内容一律来自真实军师档案（me.understanding），资料不足时引导进入对话访谈，不预置结论。
export default function Home() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [showLogin, setShowLogin] = useState(() => !s.isAuthed());
  const [showPicker, setShowPicker] = useState(false);
  const [pickerFirst, setPickerFirst] = useState(false);
  const [saying, setSaying] = useState<{ text: string; date: string }>({ text: '先把自己<em>立于不败</em>，再等对手露出破绽。', date: todayLabel() });
  const [navTop, setNavTop] = useState<number>();
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const me = s.me();
  const und = me?.understanding;

  useDidShow(() => {
    s.setTab(1);
    Taro.getCurrentInstance().page?.getTabBar?.();
    setDossier(loadDossier());
    if (s.isAuthed()) {
      store.loadMe(); // 刷新军师档案（对话/资料变化后战局判断随之更新）
    }
  });

  useEffect(() => {
    // 登录门：未登录先登录；已登录但未建档再走本命色/建档
    if (!s.isAuthed()) {
      setShowLogin(true);
    } else if (!s.isOnboarded()) {
      setPickerFirst(true);
      setShowPicker(true);
    }
    api.todaySaying().then((r) => setSaying({ text: r.text, date: r.date || todayLabel() })).catch(() => {});
    // 自定义导航：品牌行与微信胶囊（右上角 ••• ⊙）顶端对齐，左侧本就空着，不浪费纵向空间
    try {
      const r = Taro.getMenuButtonBoundingClientRect?.();
      if (r && r.top) setNavTop(r.top);
    } catch { /* H5 无胶囊，走 CSS 兜底 */ }
  }, []);

  const requireLogin = () => {
    if (s.isAuthed()) return true;
    setShowLogin(true);
    Taro.showToast({ title: '请先登录后再开始对话', icon: 'none' });
    return false;
  };
  const goChat = (params: string) => {
    if (!requireLogin()) return false;
    Taro.navigateTo({ url: `/pages/chat/index?${params}` });
    return true;
  };

  const gapCount = und?.nextQuestions.length ?? 0;
  const riskCount = dossier?.risks.length ?? 0;
  const progress = todayProgress(dossier);
  // 案卷完整度：军师档案成熟度（真实状态，不编百分比）
  const maturityLabel = !s.isAuthed() || !und ? '—' : und.maturity === 'ready' ? '可用' : und.maturity === 'forming' ? '整理中' : '待建档';

  const startInterview = () =>
    goChat(`agentKey=general&fresh=1&send=${encodeURIComponent('帮我补齐军师档案：你先问我最关键的 1-3 个问题，我来答。')}`);
  const startForces = () =>
    goChat(`agentKey=strat&fresh=1&send=${encodeURIComponent('用三势判断（天势、市势、人势）帮我看一遍当前局势，并给出该攻、该守还是该等的结论。')}`);
  const askRisks = () =>
    goChat(`agentKey=strat&fresh=1&send=${encodeURIComponent('基于我当前的情况，给我 2-3 条「现在不能做」的风险锁，并说明原因。')}`);

  return (
    <Screen className="home">
      <View className="pad">
        {/* 品牌行 —— 与微信胶囊顶端对齐（本命色切换已移至「我的」） */}
        <View className="brandrow" style={navTop ? { paddingTop: `${navTop}px` } : undefined}>
          <View className="brand">
            <Image className="brand-mk" src={logo} mode="aspectFit" />
            <View>
              <Text className="brand-nm serif">AI 军师</Text>
              <Text className="brand-sub">AI STRATEGIST</Text>
            </View>
          </View>
        </View>

        {/* 问候 —— 招呼语 + 战局速览提示 */}
        <View className="greet">
          <Text className="greet-h serif">{greetWord()}{me?.user.name ? `，${me.user.name}` : ''}</Text>
          <Text className="greet-tip">这里是你的当前战局</Text>
        </View>

        {/* 每日献策 */}
        <View className="say-strip">
          <Text className="say-k" style={{ color: accent }}>今日献策 · {saying.date}</Text>
          <SayingLine html={saying.text} accent={accent} />
        </View>

        {/* 当前案卷行：认可方案后生成，直达执行 */}
        <View className="dossier-strip" onClick={() => dossier ? Taro.switchTab({ url: '/pages/studio/index' }) : Taro.switchTab({ url: '/pages/sessions/index' })}>
          <Icon name="layers" size={13} color={accent} />
          <Text className="ds-t">
            {dossier
              ? `当前案卷 · ${dossier.title}${progress.total ? ` · 今日军令 ${progress.done}/${progress.total}` : ''}`
              : '还没有战略案卷 · 认可军师方案后自动生成'}
          </Text>
          <Text className="ds-go" style={{ color: accent }}>{dossier ? '去执行 ›' : '去对话 ›'}</Text>
        </View>

        {/* 军师判断卡（对齐设计稿：纯展示的深色大字判断，点按进入总军师对话） */}
        <View className="ask card" onClick={() => goChat('agentKey=general&continue=1')}>
          <View className="ask-top">
            <View className="ask-av" style={{ background: accent }}>
              <Icon name="target" size={18} color="#FBFAF6" />
            </View>
            <View className="ask-id">
              <Text className="nm">军师判断 · 主要矛盾</Text>
              <View className="st"><View className="dot" style={{ background: accent }} /><Text>由对话、档案与资料共同刷新</Text></View>
            </View>
          </View>
          <Text className="ask-q serif">
            {und?.summary || dossier?.judgment || '先和军师聊聊当前处境，判断会沉淀在这里'}
          </Text>
          <View className="ask-go">
            <Text style={{ color: 'rgba(255,255,255,.66)' }}>{und?.summary ? '有变化？和军师更新判断' : '进入对话，开始首次诊断'}</Text>
            <Text style={{ color: 'var(--accent-bright)' }}>去对话 ›</Text>
          </View>
        </View>

        {/* 战局信号：案卷完整度 / 待补资料 / 风险锁（全部真实状态） */}
        <View className="signal-grid">
          <View className="signal-card card" onClick={() => requireLogin() && Taro.navigateTo({ url: '/pages/brief/index' })}>
            <Text className="signal-v serif" style={{ color: accent }}>{maturityLabel}</Text>
            <Text className="signal-l">案卷完整度</Text>
          </View>
          <View className="signal-card card" onClick={startInterview}>
            <Text className={`signal-v serif ${gapCount ? 'warn' : ''}`}>{s.isAuthed() && und ? gapCount : '—'}</Text>
            <Text className="signal-l">待补资料</Text>
          </View>
          <View className="signal-card card" onClick={askRisks}>
            <Text className={`signal-v serif ${riskCount ? 'danger' : ''}`}>{riskCount || '—'}</Text>
            <Text className="signal-l">风险锁</Text>
          </View>
        </View>

        {/* 下一步动作：军师档案里真实的待补问题 → 进入访谈补齐 */}
        <View className="sec-head">
          <Text className="sec-title">下一步动作</Text>
          <Text className="sec-more" onClick={startInterview}>进入访谈 ›</Text>
        </View>
        <View className="goal-panel card">
          {(und?.nextQuestions.length ? und.nextQuestions.slice(0, 3) : []).map((q) => (
            <View key={q} className="goal-row" onClick={startInterview}>
              <Text className="goal-p" style={{ color: accent }}>补线索</Text>
              <View className="goal-b">
                <Text className="goal-t">{q}</Text>
                <Text className="goal-m">答完后军师会更新当前判断</Text>
              </View>
              <Text className="goal-go">›</Text>
            </View>
          ))}
          {!und?.nextQuestions.length ? (
            <View className="goal-row" onClick={() => goChat('agentKey=general&continue=1')}>
              <Text className="goal-p" style={{ color: accent }}>先对话</Text>
              <View className="goal-b">
                <Text className="goal-t">和军师聊聊当前处境</Text>
                <Text className="goal-m">对话后，下一步动作会拆解到这里和执行页</Text>
              </View>
              <Text className="goal-go" style={{ color: accent }}>›</Text>
            </View>
          ) : null}
        </View>

        {/* 现在不能做：认可方案中提取的风险锁（无则不占版面，可从「风险锁」信号发起） */}
        {dossier?.risks.length ? (
          <View className="dont-card card">
            <Text className="dont-k">现 在 不 能 做</Text>
            {dossier.risks.map((r) => (
              <View key={r} className="dont-row">
                <Text className="dont-x">✕</Text>
                <Text className="dont-t">{r}</Text>
              </View>
            ))}
            <Text className="dont-src">来自你认可的《{dossier.title}》</Text>
          </View>
        ) : null}

        {/* 三势判断：方法框架（结论由真实对话产出，不预置） */}
        <View className="sec-head">
          <Text className="sec-title">三势判断</Text>
          <Text className="sec-more" onClick={startForces}>发起判断 ›</Text>
        </View>
        <View className="force-grid">
          {THREE_FORCES.map((f) => (
            <View key={f.key} className="force-card card" onClick={startForces}>
              <View className="force-ic" style={{ background: 'var(--accent-soft)' }}>
                <Icon name={f.icon} size={15} color={accent} />
              </View>
              <Text className="force-k">{f.key}</Text>
              <Text className="force-v">{f.desc}</Text>
            </View>
          ))}
        </View>

        {/* 关联模块：军师方案的功能化承接（详情在模块市场） */}
        <View className="sec-head">
          <Text className="sec-title">关联模块</Text>
          <Text className="sec-more" onClick={() => Taro.navigateTo({ url: '/packages/work/market/index' })}>模块市场 ›</Text>
        </View>
        <View className="module-panel card">
          {MODULE_MARKET.slice(0, 3).map((m) => {
            const owner = m.agentKey ? s.agents().find((a) => a.key === m.agentKey)?.name : undefined;
            return (
              <View key={m.id} className="module-line" onClick={() => Taro.navigateTo({ url: '/packages/work/market/index' })}>
                <Text className="module-name">{m.title}</Text>
                <Text className="module-mini">{owner || m.category}</Text>
                <Text className={`module-tier tier-${m.tier}`}>{m.price}</Text>
              </View>
            );
          })}
        </View>

        {/* 主行动：有案卷 → 去执行；没有 → 先认可判断生成军令 */}
        <View
          className="war-cta"
          style={{ background: accent }}
          onClick={() => dossier ? Taro.switchTab({ url: '/pages/studio/index' }) : goChat('agentKey=general&continue=1')}
        >
          <Icon name="check" size={16} color="#FBFAF6" />
          <Text>{dossier ? '今日执行 · 军令与回填' : '认可判断 · 生成军令与报告'}</Text>
        </View>
      </View>

      <Login
        open={showLogin}
        onLoggedIn={(onboarded) => {
          setShowLogin(false);
          if (!onboarded) {
            setPickerFirst(true);
            setShowPicker(true);
          }
        }}
      />

      <Picker
        open={showPicker}
        first={pickerFirst}
        onClose={() => setShowPicker(false)}
        onConfirm={() => setShowPicker(false)}
      />
    </Screen>
  );
}
