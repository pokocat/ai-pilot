import { useEffect, useRef, useState } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import Icon from '../../components/Icon';
import ReportCard from '../../components/ReportCard';
import { useStore } from '../../hooks/useStore';
import { api, type Agent, type Deliverable, type ChatReplyT } from '../../services/api';
import { agentForText } from '../../data/intents';
import './index.scss';

type Msg =
  | { role: 'greet'; agent: Agent }
  | { role: 'user'; text: string }
  | { role: 'assistant'; reply: ChatReplyT }
  | { role: 'report'; deliverable: Deliverable; animate: boolean; saved?: boolean }
  | { role: 'memory'; agentName: string };

export default function Chat() {
  const router = useRouter();
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [agent, setAgent] = useState<Agent | null>(null);
  const [sessionId, setSessionId] = useState<string>('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const logRef = useRef<Msg[]>([]);
  logRef.current = msgs;

  const findAgent = (key: string): Agent | undefined => s.agents().find((a) => a.key === key);

  const scrollToEnd = () => setScrollTop((t) => t + 100000);

  // 初始化：根据路由参数还原会话 / 打开顾问线程 / 新会话
  useEffect(() => {
    (async () => {
      let agents = s.agents(); // 已含离线兜底，基本不为空
      if (!agents.length) {
        await s.loadAgents();
        agents = s.agents();
      }
      const { sessionId: sid, agentKey, send, fresh } = router.params as Record<string, string>;
      const key = agentKey || (send ? agentForText(decodeURIComponent(send)) : 'general');
      const fallbackAgent = agents.find((a) => a.key === key) || agents.find((a) => a.key === 'general') || agents[0];

      try {
        if (sid) {
          const detail = await api.session(sid);
          const ag = agents.find((a) => a.key === detail.agentKey) || (detail.agent as any) || fallbackAgent;
          setAgent(ag);
          setSessionId(sid);
          restore(ag, detail.messages);
          return;
        }

        setAgent(fallbackAgent);

        // continue：找该顾问最近会话续聊；fresh/new：开新
        if (!fresh) {
          const list = await api.sessions().catch(() => []);
          const latest = list.find((x) => x.agentKey === fallbackAgent.key);
          if (latest) {
            const detail = await api.session(latest.id);
            setSessionId(latest.id);
            restore(fallbackAgent, detail.messages);
            if (send) setTimeout(() => doSend(decodeURIComponent(send), latest.id, fallbackAgent.key), 300);
            return;
          }
        }
        // 全新会话：仅渲染问候（不落库），首条消息时后端创建
        setMsgs([{ role: 'greet', agent: fallbackAgent }]);
        if (send) setTimeout(() => doSend(decodeURIComponent(send), '', fallbackAgent.key), 350);
      } catch {
        // 任何拉取失败都不让对话页空白：至少给出问候
        if (fallbackAgent) {
          setAgent(fallbackAgent);
          setMsgs([{ role: 'greet', agent: fallbackAgent }]);
        }
      }
    })();
  }, []);

  function restore(ag: Agent, messages: { role: string; content: any }[]) {
    const out: Msg[] = [{ role: 'greet', agent: ag }];
    messages.forEach((m) => {
      if (m.role === 'user') out.push({ role: 'user', text: m.content.text });
      else if (m.role === 'report') out.push({ role: 'report', deliverable: m.content, animate: false, saved: false });
      else out.push({ role: 'assistant', reply: m.content });
    });
    setMsgs(out);
    setTimeout(scrollToEnd, 60);
  }

  async function doSend(text: string, sid: string, agentKey: string) {
    if (busy) return;
    setBusy(true);
    setMsgs((m) => [...m, { role: 'user', text }]);
    setTimeout(scrollToEnd, 30);
    try {
      const res = await api.generate({ text, sessionId: sid || undefined, agentKey });
      if (res.sessionId && !sid) setSessionId(res.sessionId);
      if (res.kind === 'report' && res.deliverable) {
        setMsgs((m) => [...m, { role: 'report', deliverable: res.deliverable!, animate: true }]);
        if (res.memory?.learned) {
          setTimeout(() => {
            setMsgs((m) => [...m, { role: 'memory', agentName: res.memory!.agentName }]);
            scrollToEnd();
          }, data_delay(res.deliverable!));
        }
      } else if (res.reply) {
        setMsgs((m) => [...m, { role: 'assistant', reply: res.reply! }]);
      }
      setTimeout(scrollToEnd, 80);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', reply: { text: '抱歉，产出失败了，请稍后再试。' } }]);
    } finally {
      setBusy(false);
    }
  }

  const onSend = () => {
    const v = input.trim();
    if (!v || !agent) return;
    setInput('');
    doSend(v, sessionId, agent.key);
  };

  const saveDeliverable = async (d: Deliverable) => {
    if (!agent) return;
    await api.saveToLibrary({
      title: d.title, type: agent.deliverableKey || d.title, agentKey: agent.key,
      sessionId: sessionId || undefined, content: d as any,
    }).catch(() => {});
    Taro.showToast({ title: '已存入方案库', icon: 'none' });
  };

  return (
    <View className={`page chat ${s.themeClass()}`}>
      {/* 顾问身份头 */}
      <View className="chat-head">
        <View className="hbtn" onClick={() => Taro.switchTab({ url: '/pages/sessions/index' })}>
          <Icon name="grid" size={20} color="#565C63" />
        </View>
        <View className="chat-id">
          <Text className="cn">{agent?.name ?? '军师'}</Text>
          <Text className="cr">· {agent?.role ?? '通用商业军师'}</Text>
        </View>
        <View className="hbtn" onClick={() => Taro.redirectTo({ url: '/pages/chat/index?fresh=1' })}>
          <Icon name="spark" size={20} color="#565C63" />
        </View>
      </View>

      {/* 记忆条 */}
      {agent && (
        <View className="mem-bar">
          <Icon name="layers" size={14} color={accent} />
          <Text className="mt"> {stripTags(agent.memText)}</Text>
          <View className="mlearn"><View className="dot" style={{ background: accent }} /><Text>{agent.learnText}</Text></View>
        </View>
      )}

      {/* 对话流 */}
      <ScrollView scrollY className="chat-log" scrollTop={scrollTop} scrollWithAnimation enhanced showScrollbar={false}>
        {msgs.map((m, i) => {
          if (m.role === 'greet') {
            return (
              <View key={i} className="msg a">
                <View className="who"><View className="d" style={{ background: accent }}><Icon name={m.agent.icon} size={13} color="#fff" /></View><Text>{m.agent.name}</Text></View>
                <View className="bubble">
                  <Text>{m.agent.greet}</Text>
                  <View className="acts">
                    {m.agent.chips.map(([ic, label]) => (
                      <View key={label} className="act-chip" onClick={() => doSend(label, sessionId, m.agent.key)}>
                        <Icon name={ic} size={13} color={accent} /><Text>{label}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              </View>
            );
          }
          if (m.role === 'user') {
            return <View key={i} className="msg u"><View className="ubub" style={{ background: accent }}><Text>{m.text}</Text></View></View>;
          }
          if (m.role === 'assistant') {
            return (
              <View key={i} className="msg a">
                <View className="who"><View className="d" style={{ background: accent }}><Icon name={agent?.icon ?? 'spark'} size={13} color="#fff" /></View><Text>{agent?.name}</Text></View>
                <View className="bubble">
                  <Text>{m.reply.text}</Text>
                  {m.reply.points && (
                    <View className="points">
                      {m.reply.points.map((p, j) => <View key={j} className="pt"><View className="pd" style={{ background: accent }} /><Text>{p}</Text></View>)}
                    </View>
                  )}
                </View>
              </View>
            );
          }
          if (m.role === 'memory') {
            return (
              <View key={i} className="mem-learned">
                <Icon name="spark" size={13} color={accent} />
                <Text>记忆已更新：{m.agentName} 已从本次对话学到你的业务偏好，下次产出会更贴合。</Text>
              </View>
            );
          }
          // report
          return (
            <View key={i} className="msg a">
              <View className="who"><View className="d" style={{ background: accent }}><Icon name={agent?.icon ?? 'spark'} size={13} color="#fff" /></View><Text>{agent?.name}</Text></View>
              <ReportCard data={m.deliverable} animate={m.animate} onSave={() => saveDeliverable(m.deliverable)} onExport={() => Taro.showToast({ title: '正在生成 PDF…', icon: 'none' })} />
            </View>
          );
        })}
        <View style={{ height: '20px' }} />
      </ScrollView>

      {/* 输入区 */}
      <View className="composer">
        <View className="box">
          <Icon name="attach" size={18} color="#969BA1" />
          <Input className="cinput" value={input} placeholder="向顾问提问…" confirmType="send" onInput={(e) => setInput(e.detail.value)} onConfirm={onSend} />
          <Icon name="mic" size={18} color="#969BA1" />
        </View>
        <View className={`csend ${busy ? 'busy' : ''}`} style={{ background: accent }} onClick={onSend}>
          <Icon name="send" size={18} color="#fff" />
        </View>
      </View>
    </View>
  );
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}
function data_delay(d: Deliverable): number {
  return 900 + d.sections.length * 640 + 500;
}
