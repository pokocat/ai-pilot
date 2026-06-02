import { useEffect, useState } from 'react';
import { View, Text, Input } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import Picker from '../../components/Picker';
import Login from '../../components/Login';
import { useStore } from '../../hooks/useStore';
import { api } from '../../services/api';
import './index.scss';

const INSIGHTS = [
  { ic: 'target', tag: '智库 · 推荐产出', tagType: 'opp', ttl: '建议先出一份战略诊断报告', desc: '军师可基于你的业务现状，直接产出诊断 + 行动清单。', act: '让智库产出', send: '战略体检' },
  { ic: 'trend', tag: '机会 · 增长', tagType: 'opp', ttl: '高价值客群尚未被单独运营', desc: '腰部客群复购集中，具备做会员 / 订阅制的基础。', act: '生成增长方案', send: '增长方案' },
  { ic: 'shield', tag: '待办 · 股权', tagType: 'todo', ttl: '期权池预留可能偏紧', desc: '结合你的融资计划，建议尽早梳理股权与期权结构。', act: '让军师拆解', send: '融资准备' },
];

const TOOLS = [
  { agent: 'strat', ic: 'target', h: '战略诊断官', p: '产出诊断报告' },
  { agent: 'growth', ic: 'trend', h: '增长操盘手', p: '产出增长方案' },
  { agent: 'fund', ic: 'doc', h: '融资参谋', p: '产出商业计划书' },
  { agent: 'brand', ic: 'image', h: '品牌营销官', p: '产出营销内容' },
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
  const [showLogin, setShowLogin] = useState(false);
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

  const goChat = (params: string) => Taro.navigateTo({ url: `/pages/chat/index?${params}` });
  const send = () => {
    const v = input.trim() || '帮我做一次战略体检';
    goChat(`send=${encodeURIComponent(v)}`);
    setInput('');
  };

  return (
    <Screen>
      <View className="pad">
        {/* 品牌行 —— 与微信胶囊顶端对齐（本命色切换已移至「我的」） */}
        <View className="brandrow" style={navTop ? { paddingTop: `${navTop}px` } : undefined}>
          <View className="brand">
            <View className="brand-mk serif" style={{ background: accent }}>军</View>
            <View>
              <Text className="brand-nm serif">军师</Text>
              <Text className="brand-sub">AI STRATEGIST</Text>
            </View>
          </View>
        </View>

        {/* 问候 —— 招呼语 + 精简提示同行 */}
        <View className="greet">
          <Text className="greet-h serif">{greetWord()}，{me?.user.name ?? '王总'}</Text>
          <Text className="greet-tip">今天有 {INSIGHTS.length} 条新洞察</Text>
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
              <Icon name="chat" size={18} color="#fff" />
            </View>
            <View className="ask-id">
              <Text className="nm">军师</Text>
              <View className="st"><View className="dot" style={{ background: accent }} /><Text>在线 · 随时为你出谋</Text></View>
            </View>
          </View>
          <Text className="ask-q serif">今天，想破解哪一局？</Text>
          <View className="ask-field">
            <Input
              className="ask-input"
              value={input}
              placeholder="说说你的处境，或直接提问…"
              confirmType="send"
              onInput={(e) => setInput(e.detail.value)}
              onConfirm={send}
            />
            <View className="ask-send" style={{ background: accent }} onClick={send}>
              <Icon name="send" size={16} color="#fff" />
            </View>
          </View>
          <View className="chips">
            {[['target', '战略体检'], ['trend', '增长方案'], ['shield', '融资准备']].map(([ic, q]) => (
              <View key={q} className="chip" onClick={() => goChat(`send=${encodeURIComponent(q)}`)}>
                <Icon name={ic} size={13} color="var(--accent-ink)" />
                <Text>{q}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* 项目工作台入口 */}
        <View className="home-proj card" onClick={() => Taro.navigateTo({ url: '/pages/projects/index' })}>
          <View className="hp-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="grid" size={18} color={accent} /></View>
          <View className="hp-b">
            <Text className="hp-t">项目工作台</Text>
            <Text className="hp-s">把融资、新品、组织调整建成项目，对话 / 报告 / 知识有序归拢</Text>
          </View>
          <Text className="hp-go" style={{ color: accent }}>›</Text>
        </View>

        {/* 军师为你发现 */}
        <View className="sec-head">
          <Text className="sec-title">军师为你发现</Text>
          <Text className="sec-more">全部 3 条 ›</Text>
        </View>
        {INSIGHTS.map((it) => (
          <View key={it.send} className="insight card" onClick={() => goChat(`send=${encodeURIComponent(it.send)}`)}>
            <View className={`ins-ic ${it.tagType}`} style={{ background: 'var(--accent-soft)' }}>
              <Icon name={it.ic} size={18} color={accent} />
            </View>
            <View className="ins-body">
              <Text className="ins-tag" style={{ color: accent }}>{it.tag}</Text>
              <Text className="ins-ttl">{it.ttl}</Text>
              <Text className="ins-desc">{it.desc}</Text>
              <View className="ins-act" style={{ color: accent }}><Text>{it.act}</Text><Text> ›</Text></View>
            </View>
          </View>
        ))}

        {/* 智库赠送顾问 */}
        <View className="sec-head">
          <Text className="sec-title">智库 · 赠送顾问</Text>
          <Text className="sec-more" onClick={() => Taro.switchTab({ url: '/pages/thinktank/index' })}>全部 8 位 ›</Text>
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
