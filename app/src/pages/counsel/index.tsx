import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
// CSS chunk 顺序：Screen 先、ChatView 次（其内部按 Icon→Login→…→SafeHeader→AdvisorAvatar 注册，
// 与 sessions 页一致），Icon/Login/AdvisorAvatar 复用其登记、不另立顺序，避免 common chunk order 冲突。
import Screen from '../../components/Screen';
import ChatView from '../../components/ChatView';
import Icon from '../../components/Icon';
import Login from '../../components/Login';
import AdvisorAvatar from '../../components/AdvisorAvatar';
import ProtoHeader from '../../components/proto/ProtoHeader';
import SealKicker from '../../components/proto/SealKicker';
import AgentUnlock from '../../components/AgentUnlock';
import Onboarding from '../../components/Onboarding';
import CoachMarks from '../../components/CoachMarks';
import { useStore } from '../../hooks/useStore';
import { api, getUserId, type Agent, type SessionItem } from '../../services/api';
import { refreshDossier } from '../../services/dossier';
import { ADVISOR_ALIAS, CORE_SPECIALISTS } from '../../data/council';
import './index.scss';

// 问策（tab0）—— 军师名录 + 就地对话中枢（原型 isZhance），并承载入帐引导 + 功能点亮导览。
// noThread：总军师置顶卡 + 专业军师·分线出策名录；hasThread：内嵌 ChatView（一比一复用）。
// 未登录 → 入帐 splash + Login；已登录未建档 → 入帐流；建档后 → 名录/对话 + 首访 coach。

interface Thread { agentKey: string }

const dutyOf = (key: string) => CORE_SPECIALISTS.find((c) => c.agentKey === key)?.duty || '';
const roleLabel = (a: Agent) => (a.type === 'creative' ? '出活 · 创作' : '出谋 · 顾问');
const coachKey = () => `junshi.coach.${getUserId() || 'guest'}`;
const coachSeen = () => { try { return !!Taro.getStorageSync(coachKey()); } catch { return false; } };
const markCoachSeen = () => { try { Taro.setStorageSync(coachKey(), '1'); } catch { /* noop */ } };

export default function Counsel() {
  const s = useStore();
  const authed = s.isAuthed();
  const onboarded = s.isOnboarded();

  const [thread, setThread] = useState<Thread | null>(null);
  const [buying, setBuying] = useState<Agent | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [conflict, setConflict] = useState('');
  const [coachOn, setCoachOn] = useState(false);

  useDidShow(() => {
    s.setTab(0);
    Taro.getCurrentInstance().page?.getTabBar?.();
    if (s.isAuthed()) {
      s.loadAgents();
      api.sessions().then(setSessions).catch(() => setSessions([]));
      if (s.isOnboarded()) loadConflict();
    }
  });

  // 建档后首访 → 点亮导览（每用户一次）。
  useEffect(() => {
    if (authed && onboarded && !coachSeen()) setCoachOn(true);
  }, [authed, onboarded]);

  async function loadConflict() {
    const d = await refreshDossier().catch(() => null);
    if (d?.judgment) setConflict(d.judgment);
  }

  const goSessions = () => Taro.navigateTo({ url: '/pages/sessions/index' });
  const latestOf = (key: string) => sessions.find((x) => x.agentKey === key);

  const openGeneral = () => setThread({ agentKey: 'general' });
  const openSpecialist = (a: Agent) => {
    if (a.billing === 'unlock' && !a.owned) { setBuying(a); return; }
    setThread({ agentKey: a.key });
  };

  const closeCoach = () => { markCoachSeen(); setCoachOn(false); };
  const onOnboardDone = () => {
    setThread(null);
    loadConflict();
    api.sessions().then(setSessions).catch(() => {});
    if (!coachSeen()) setCoachOn(true);
  };

  const industryTag = s.me()?.tenant?.industry || undefined;

  // —— 入帐（未登录 splash+Login / 已登录未建档 入帐流）——
  if (!authed || !onboarded) {
    return (
      <Screen scroll={false} tab={false} className="counsel">
        <Onboarding authed={authed} onNeedLogin={() => setLoginOpen(true)} onDone={onOnboardDone} />
        <Login
          open={!authed && loginOpen}
          onLoggedIn={() => { setLoginOpen(false); api.sessions().then(setSessions).catch(() => {}); }}
        />
      </Screen>
    );
  }

  // —— hasThread：内嵌 ChatView ——
  if (thread) {
    return (
      <Screen scroll={false} tab={false} topInset className="counsel counsel--thread">
        <View className="counsel-back" onClick={() => setThread(null)}>
          <Icon name="chevron" size={16} color="#6B6456" />
          <Text>返回问策</Text>
        </View>
        <ChatView agentKey={thread.agentKey} continueThread embedded />
        <CoachMarks active={coachOn} onClose={closeCoach} />
      </Screen>
    );
  }

  // —— noThread：名录 ——
  const specialists = s.agents().filter((a) => a.key !== 'general');
  const unread = s.satchelDot();

  return (
    <Screen tab topInset className="counsel">
      <ProtoHeader kicker="有事问军师" title="问策" watermark="谋" tag={industryTag} />

      <View className="counsel-body">
        <View className="counsel-history" onClick={goSessions}>
          <Icon name="chat" size={13} color="#A79E8C" />
          <Text>往来 · 历史会话</Text>
        </View>

        {/* 总军师置顶卡 */}
        <View className="zong-card proto-card proto-card--top" onClick={openGeneral}>
          <View className="zong-row">
            <AdvisorAvatar agentKey="general" size={46} online />
            <View className="zong-id">
              <View className="zong-name-row">
                <Text className="zong-name">总军师</Text>
                <Text className="zong-pill">统筹</Text>
              </View>
              <Text className="zong-sub">调度全体 · 收拢主判断</Text>
            </View>
            {unread ? <View className="zong-dot"><Text>·</Text></View> : null}
          </View>
          <View className="zong-conflict">
            <Text>{conflict ? `主公，眼下的主要矛盾是「${conflict}」——点开我细说。` : '主公，先把主要矛盾理清——点开，我与你从头说起。'}</Text>
          </View>
        </View>

        {/* 专业军师名录 */}
        <SealKicker text="专 业 军 师 · 分 线 出 策" style={{ margin: '26px 2px 6px' }} />
        <View className="roster-list">
          {specialists.map((a) => {
            const last = latestOf(a.key);
            const preview = last?.snippet || dutyOf(a.key) || a.role;
            const locked = a.billing === 'unlock' && !a.owned;
            return (
              <View key={a.key} className="roster-row" onClick={() => openSpecialist(a)}>
                <AdvisorAvatar agentKey={a.key} size={44} />
                <View className="rr-body">
                  <View className="rr-top">
                    <Text className="rr-name serif">{ADVISOR_ALIAS[a.key] || a.name}</Text>
                    <Text className="rr-role">{roleLabel(a)}</Text>
                    {locked ? <Text className="rr-lock">未启用</Text> : null}
                  </View>
                  <Text className="rr-preview">{preview}</Text>
                </View>
              </View>
            );
          })}
        </View>
      </View>

      <AgentUnlock agent={buying} onClose={() => setBuying(null)} onUnlocked={(a) => { setBuying(null); setThread({ agentKey: a.key }); }} />
      <CoachMarks active={coachOn} onClose={closeCoach} />
    </Screen>
  );
}
