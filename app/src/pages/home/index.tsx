import { useEffect, useState } from 'react';
import { View, Text, Input, Image } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import logo from '../../assets/logo.png';
import Icon from '../../components/Icon';
import Picker from '../../components/Picker';
import Login from '../../components/Login';
import { useStore } from '../../hooks/useStore';
import { api } from '../../services/api';
import './index.scss';

// 常见起手式（非"为你发现"——不臆造用户尚未提供的业务结论）。点开即把该主题发给军师。
const INSIGHTS = [
  { ic: 'target', ttl: '做一次战略诊断', desc: '定位、增长卡点与下一步，整理成可执行报告。', act: '开始诊断', send: '战略体检' },
  { ic: 'trend', ttl: '理清增长杠杆', desc: '从获客、转化、复购、定价里找到发力点。', act: '梳理增长', send: '增长方案' },
  { ic: 'doc', ttl: '梳理融资准备', desc: '把增长逻辑、单位经济与资金用途讲清楚。', act: '准备材料', send: '融资准备' },
];

// 首页快捷入口：展示当前可直接使用的常用顾问，避免把首屏写成权益售卖区。
const TOOLS = [
  { agent: 'strat', ic: 'target', h: '战略诊断官', p: '卡点判断与行动清单' },
  { agent: 'growth', ic: 'trend', h: '增长操盘手', p: '获客、转化与复购路径' },
  { agent: 'fund', ic: 'doc', h: '融资参谋', p: '融资叙事与问答准备' },
  { agent: 'general', ic: 'spark', h: '军师', p: '随时为你出谋' },
];

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

export default function Home() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [showLogin, setShowLogin] = useState(() => !s.isAuthed());
  const [showPicker, setShowPicker] = useState(false);
  const [pickerFirst, setPickerFirst] = useState(false);
  const [saying, setSaying] = useState<{ text: string; date: string }>({ text: '先把自己<em>立于不败</em>，再等对手露出破绽。', date: todayLabel() });
  const [input, setInput] = useState('');
  const [navTop, setNavTop] = useState<number>();
  const me = s.me();

  useDidShow(() => {
    s.setTab(0);
    Taro.getCurrentInstance().page?.getTabBar?.();
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
  const send = () => {
    const v = input.trim() || '帮我做一次战略体检';
    if (goChat(`send=${encodeURIComponent(v)}`)) setInput('');
  };

  return (
    <Screen className="home">
      <View className="pad">
        {/* 品牌行 —— 与微信胶囊顶端对齐（本命色切换已移至「我的」） */}
        <View className="brandrow" style={navTop ? { paddingTop: `${navTop}px` } : undefined}>
          <View className="brand">
            <Image className="brand-mk" src={logo} mode="aspectFit" />
            <View>
              <Text className="brand-nm serif">军师</Text>
              <Text className="brand-sub">AI STRATEGIST</Text>
            </View>
          </View>
        </View>

        {/* 问候 —— 招呼语 + 精简提示同行 */}
        <View className="greet">
          <Text className="greet-h serif">{greetWord()}{me?.user.name ? `，${me.user.name}` : ''}</Text>
          <Text className="greet-tip">{INSIGHTS.length} 个常见议题，可直接开始</Text>
        </View>

        {/* 每日献策 */}
        <View className="say-strip">
          <Text className="say-k" style={{ color: accent }}>今日献策 · {saying.date}</Text>
          <SayingLine html={saying.text} accent={accent} />
        </View>

        {/* 对话入口卡 */}
        <View className="ask card">
          <View className="ask-top">
            <View className="ask-av" style={{ background: accent }}>
              <Icon name="chat" size={18} color="#FBFAF6" />
            </View>
            <View className="ask-id">
              <Text className="nm">军师</Text>
              <View className="st"><View className="dot" style={{ background: accent }} /><Text>在线 · 随时为你出谋</Text></View>
            </View>
          </View>
          <Text className="ask-q serif">先说一件最想推进的事</Text>
          <View className="ask-field">
            <Input
              className="ask-input"
              value={input}
              placeholder="例如：增长停滞、融资故事、组织卡点"
              confirmType="send"
              onInput={(e) => setInput(e.detail.value)}
              onConfirm={send}
            />
            <View className="ask-send" style={{ background: accent }} onClick={send}>
              <Icon name="send" size={16} color="#FBFAF6" />
            </View>
          </View>
          <View className="chips">
            {[['target', '定位卡点', '战略体检'], ['trend', '获客变慢', '增长方案'], ['shield', '融资故事', '融资准备']].map(([ic, label, q]) => (
              <View key={q} className="chip" onClick={() => goChat(`send=${encodeURIComponent(q)}`)}>
                <Icon name={ic} size={13} color={s.color().vars['--accent-ink']} />
                <Text>{label}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* 可以先做：单组列表承载多个起手式，避免首屏连续同构卡片抢主行动。 */}
        <View className="sec-head">
          <Text className="sec-title">可以先做</Text>
          <Text className="sec-more">定位 · 增长 · 融资</Text>
        </View>
        <View className="focus-panel card">
          {INSIGHTS.map((it, i) => (
            <View key={it.send} className={`focus-row ${i === INSIGHTS.length - 1 ? 'last' : ''}`} onClick={() => goChat(`send=${encodeURIComponent(it.send)}`)}>
              <Text className="focus-no">0{i + 1}</Text>
              <View className="focus-ic" style={{ background: 'var(--accent-soft)' }}>
                <Icon name={it.ic} size={17} color={accent} />
              </View>
              <View className="focus-main">
                <Text className="focus-ttl">{it.ttl}</Text>
                <Text className="focus-desc">{it.desc}</Text>
              </View>
              <View className="focus-act" style={{ color: accent }}>
                <Text>{it.act}</Text>
                <Text> ›</Text>
              </View>
            </View>
          ))}
        </View>

        {/* 常用顾问 */}
        <View className="sec-head">
          <Text className="sec-title">常用顾问</Text>
          <Text className="sec-more" onClick={() => Taro.switchTab({ url: '/pages/thinktank/index' })}>去智库 ›</Text>
        </View>
        <View className="tools">
          {TOOLS.map((t) => (
            <View key={t.agent} className="tool card" onClick={() => goChat(`agentKey=${t.agent}&continue=1`)}>
              <View className="tool-ic" style={{ background: 'var(--accent-soft)' }}>
                <Icon name={t.ic} size={18} color={accent} />
              </View>
              <Text className="tool-h">{t.h}</Text>
              <Text className="tool-p">{t.p}</Text>
            </View>
          ))}
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
