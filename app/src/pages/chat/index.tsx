import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import Icon from '../../components/Icon';
import Login from '../../components/Login';
import MarkdownText from '../../components/MarkdownText';
import ReportCard from '../../components/ReportCard';
import SafeHeader from '../../components/SafeHeader';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api, type Agent, type Deliverable, type ChatReplyT, type MessageRef, type ProjectItem, type ReportItem, type KnowledgeItemT, type MemoryCandidate } from '../../services/api';
import { agentForText } from '../../data/intents';
import './index.scss';

type Msg =
  | { role: 'greet'; agent: Agent }
  | { role: 'user'; text: string; refs?: MessageRef[] }
  | { role: 'assistant'; reply: ChatReplyT; knowledgeUsed?: string[]; retryText?: string }
  | { role: 'report'; deliverable: Deliverable; animate: boolean; saved?: boolean; messageId?: string; knowledgeUsed?: string[] }
  | { role: 'memory'; agentName: string };

// 把结构化成果序列化为纯文本，复制到剪贴板（替代尚未实现的 PDF 导出）。
function deliverableToText(d: Deliverable): string {
  const lines: string[] = [d.title];
  if (d.meta) lines.push(d.meta);
  lines.push('');
  for (const sec of d.sections) {
    lines.push(`【${sec.h}】`);
    if (sec.b) lines.push(sec.b);
    if (sec.list) sec.list.forEach((x) => lines.push(`· ${x}`));
    lines.push('');
  }
  if (d.trust) lines.push(d.trust);
  return lines.join('\n').trim();
}
function copyDeliverable(d: Deliverable) {
  Taro.setClipboardData({
    data: deliverableToText(d),
    success: () => Taro.showToast({ title: '已复制全文', icon: 'success' }),
    fail: () => Taro.showToast({ title: '复制失败', icon: 'none' }),
  });
}

type ChatStyle = CSSProperties & {
  '--keyboard-height'?: string;
};

export default function Chat() {
  const router = useRouter();
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [agent, setAgent] = useState<Agent | null>(null);
  const [sessionId, setSessionId] = useState<string>('');
  const [projectId, setProjectId] = useState<string>('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [inputFocus, setInputFocus] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [refs, setRefs] = useState<MessageRef[]>([]);
  const [showLogin, setShowLogin] = useState(() => !store.isAuthed());
  const [picker, setPicker] = useState(false);
  const [pick, setPick] = useState<{ projects: ProjectItem[]; reports: ReportItem[]; knowledge: KnowledgeItemT[]; memories: MemoryCandidate[] }>({ projects: [], reports: [], knowledge: [], memories: [] });
  const logRef = useRef<Msg[]>([]);
  logRef.current = msgs;

  const findAgent = (key: string): Agent | undefined => s.agents().find((a) => a.key === key);

  const scrollToEnd = () => setScrollTop((t) => t + 100000);

  useEffect(() => {
    if (busy) setTimeout(scrollToEnd, 40);
  }, [busy]);

  useEffect(() => () => store.setOverlay(false, 'ref-picker'), []);

  const isUnauthorized = (e: unknown) =>
    (e as any)?.code === 'UNAUTHORIZED' || String((e as any)?.message || '').includes('未登录');

  const errorReply = (e: unknown): string => {
    if (isUnauthorized(e)) return '登录态已失效，请重新登录后再发送。';
    if ((e as any)?.data?.code === 'AGENT_LOCKED') return '该专项顾问尚未启用，请到「智库 / 工坊」查看可用方案。';
    if ((e as any)?.data?.code === 'INSUFFICIENT_QUOTA') return '本月 token 额度已用尽，请在「我的」升级套餐或下月再用。';
    if ((e as any)?.data?.code === 'INSUFFICIENT_CREDITS') return '钻石不足，请在「我的」充值或解锁后再继续。';
    const msg = String((e as any)?.message || '');
    if (msg && msg !== 'undefined') return msg;
    return '抱歉，产出失败了，请稍后再试。';
  };

  const promptLogin = (title = '请先登录后再开始对话') => {
    setShowLogin(true);
    Taro.showToast({ title, icon: 'none' });
  };

  async function primeGuestThread() {
    let agents = s.agents(); // 已含离线兜底，基本不为空
    if (!agents.length) {
      await s.loadAgents();
      agents = s.agents();
    }
    const { agentKey, send, projectId: pid } = router.params as Record<string, string>;
    if (pid) setProjectId(pid);
    const key = agentKey || (send ? agentForText(decodeURIComponent(send)) : 'general');
    const fallbackAgent = agents.find((a) => a.key === key) || agents.find((a) => a.key === 'general') || agents[0];
    if (fallbackAgent) {
      setAgent(fallbackAgent);
      setMsgs([{ role: 'greet', agent: fallbackAgent }]);
    }
    return fallbackAgent;
  }

  // 初始化：根据路由参数还原会话 / 打开顾问线程 / 新会话
  async function initChat() {
    let agents = s.agents(); // 已含离线兜底，基本不为空
    if (!agents.length) {
      await s.loadAgents();
      agents = s.agents();
    }
    const { sessionId: sid, agentKey, send, fresh, projectId: pid } = router.params as Record<string, string>;
    if (pid) setProjectId(pid);
    const key = agentKey || (send ? agentForText(decodeURIComponent(send)) : 'general');
    const fallbackAgent = agents.find((a) => a.key === key) || agents.find((a) => a.key === 'general') || agents[0];

    if (!store.isAuthed()) {
      if (fallbackAgent) {
        setAgent(fallbackAgent);
        setMsgs([{ role: 'greet', agent: fallbackAgent }]);
      } else {
        await primeGuestThread();
      }
      promptLogin();
      return;
    }

    try {
      if (sid) {
        const detail = await api.session(sid);
        const ag = agents.find((a) => a.key === detail.agentKey) || (detail.agent as any) || fallbackAgent;
        setAgent(ag);
        setSessionId(sid);
        if (detail.projectId) setProjectId(detail.projectId);
        restore(ag, detail.messages);
        return;
      }

      setAgent(fallbackAgent);

      // continue：找该顾问最近会话续聊；fresh/new：开新
      if (!fresh) {
        const list = await api.sessions().catch((e) => {
          if (isUnauthorized(e)) throw e;
          return [];
        });
        const latest = list.find((x) => x.agentKey === fallbackAgent.key);
        if (latest) {
          const detail = await api.session(latest.id);
          setSessionId(latest.id);
          if (detail.projectId) setProjectId(detail.projectId);
          restore(fallbackAgent, detail.messages);
          if (send) setTimeout(() => doSend(decodeURIComponent(send), latest.id, fallbackAgent.key), 300);
          return;
        }
      }
      // 全新会话：仅渲染问候（不落库），首条消息时后端创建
      setMsgs([{ role: 'greet', agent: fallbackAgent }]);
      if (send) setTimeout(() => doSend(decodeURIComponent(send), '', fallbackAgent.key), 350);
    } catch (e) {
      if (isUnauthorized(e)) promptLogin('登录态已失效，请重新登录');
      // 任何拉取失败都不让对话页空白：至少给出问候
      if (fallbackAgent) {
        setAgent(fallbackAgent);
        setMsgs([{ role: 'greet', agent: fallbackAgent }]);
      }
    }
  }

  useEffect(() => {
    initChat();
  }, []);

  function restore(ag: Agent, messages: { id: string; role: string; content: any; refs?: MessageRef[] }[]) {
    const out: Msg[] = [{ role: 'greet', agent: ag }];
    messages.forEach((m) => {
      if (m.role === 'user') out.push({ role: 'user', text: m.content.text, refs: m.refs });
      else if (m.role === 'report') out.push({ role: 'report', deliverable: m.content, animate: false, saved: false, messageId: m.id });
      else out.push({ role: 'assistant', reply: m.content });
    });
    setMsgs(out);
    setTimeout(scrollToEnd, 60);
  }

  async function doSend(text: string, sid: string, agentKey: string, sendRefs: MessageRef[] = [], echo = true) {
    if (busy) return;
    if (!store.isAuthed()) {
      promptLogin();
      setMsgs((m) => [...m, { role: 'assistant', reply: { text: '请先登录后再继续对话。' } }]);
      setTimeout(scrollToEnd, 30);
      return;
    }
    setBusy(true);
    // P2-15：重试（echo=false）不重复回显用户气泡（用户消息已在首次尝试时显示）。
    if (echo) setMsgs((m) => [...m, { role: 'user', text, refs: sendRefs.length ? sendRefs : undefined }]);
    setTimeout(scrollToEnd, 30);
    try {
      const res = await api.generate({ text, sessionId: sid || undefined, agentKey, projectId: projectId || undefined, refs: sendRefs.length ? sendRefs : undefined });
      if (res.sessionId && !sid) setSessionId(res.sessionId);
      if (res.kind === 'report' && res.deliverable) {
        setMsgs((m) => [...m, { role: 'report', deliverable: res.deliverable!, animate: true, messageId: res.messageId, knowledgeUsed: res.knowledgeUsed }]);
        if (res.memory?.learned) {
          setTimeout(() => {
            setMsgs((m) => [...m, { role: 'memory', agentName: res.memory!.agentName }]);
            scrollToEnd();
          }, data_delay(res.deliverable!));
        }
      } else if (res.reply) {
        setMsgs((m) => [...m, { role: 'assistant', reply: res.reply!, knowledgeUsed: res.knowledgeUsed }]);
      }
      setTimeout(scrollToEnd, 80);
    } catch (e) {
      if (isUnauthorized(e)) promptLogin('登录态已失效，请重新登录');
      setMsgs((m) => [...m, { role: 'assistant', reply: { text: errorReply(e) }, retryText: text }]); // P2-15：保留原文供重试
    } finally {
      setBusy(false);
    }
  }

  const handleInput = (e: { detail: { value: string } }) => {
    const v = e.detail.value;
    setInput(v);
    return v;
  };

  const onSend = (raw?: string) => {
    const v = (typeof raw === 'string' ? raw : input).trim();
    if (!v || !agent) return;
    setInput('');
    setInputFocus(false);
    const sending = refs;
    setRefs([]);
    doSend(v, sessionId, agent.key, sending);
  };

  const onKeyboardHeightChange = (e: { detail?: { height?: number } }) => {
    const next = Math.max(0, Number(e.detail?.height || 0));
    setKeyboardHeight(next);
    if (next > 0) setTimeout(scrollToEnd, 40);
  };

  const saveDeliverable = async (d: Deliverable) => {
    if (!agent) return;
    await api.saveToLibrary({
      title: d.title, type: agent.deliverableKey || d.title, agentKey: agent.key,
      sessionId: sessionId || undefined, content: d as any, projectId: projectId || undefined,
    }).catch(() => {});
    Taro.showToast({ title: '已存入方案库', icon: 'none' });
  };

  // 生成网页版报告（render_report → OSS 托管），复制可分享链接
  const shareReport = async (messageId?: string) => {
    if (!sessionId || !messageId) { Taro.showToast({ title: '请先产出成果', icon: 'none' }); return; }
    Taro.showLoading({ title: '生成网页版…' });
    try {
      const r = await api.renderReport(sessionId, messageId);
      Taro.hideLoading();
      if (r.htmlUrl) {
        Taro.setClipboardData({ data: r.htmlUrl, success: () => Taro.showToast({ title: '网页版链接已复制 · 粘到聊天/浏览器打开', icon: 'none' }) });
      } else {
        Taro.showToast({ title: '本地预览模式无网页版', icon: 'none' });
      }
    } catch {
      Taro.hideLoading();
      Taro.showToast({ title: '生成失败，请重试', icon: 'none' });
    }
  };

  // 生成对话纪要 → 版本化报告 + 沉淀知识库
  const onSummarize = async () => {
    if (!sessionId) { Taro.showToast({ title: '先开始对话再生成纪要', icon: 'none' }); return; }
    Taro.showLoading({ title: '正在生成纪要…' });
    try {
      const r = await api.summarize(sessionId);
      Taro.hideLoading();
      Taro.showToast({ title: `已生成《${r.title}》v${r.version}`, icon: 'none' });
      setTimeout(() => Taro.navigateTo({ url: `/packages/work/report/index?id=${r.reportId}` }), 700);
    } catch {
      Taro.hideLoading();
      Taro.showToast({ title: '生成纪要失败', icon: 'none' });
    }
  };

  // 打开 @引用选择器：拉取可引用的 项目/报告/知识
  const openPicker = async () => {
    setInputFocus(false);
    if (!store.isAuthed()) {
      setShowLogin(true);
      Taro.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    setPicker(true);
    store.setOverlay(true, 'ref-picker');
    const [projects, reports, knowledge, memories] = await Promise.all([
      api.projects().catch(() => []),
      api.reports(projectId || undefined).catch(() => []),
      api.knowledge(projectId || undefined).catch(() => []),
      api.memories(agent?.key || undefined).catch(() => []),
    ]);
    setPick({ projects, reports, knowledge, memories });
  };
  const closePicker = () => { setPicker(false); store.setOverlay(false, 'ref-picker'); };
  const toggleRef = (r: MessageRef) => {
    setRefs((cur) => cur.some((x) => x.kind === r.kind && x.id === r.id) ? cur.filter((x) => !(x.kind === r.kind && x.id === r.id)) : [...cur, r]);
  };
  const hasRef = (kind: string, id: string) => refs.some((x) => x.kind === kind && x.id === id);
  const renderGroup = (title: string, items: { kind: MessageRef['kind']; id: string; label: string; sub?: string; version?: number }[]) => {
    if (!items.length) return null;
    return (
      <View className="ref-group">
        <Text className="ref-gt">{title}</Text>
        {items.map((it) => {
          const on = hasRef(it.kind, it.id);
          return (
            <View key={it.kind + it.id} className={`ref-item ${on ? 'on' : ''}`} style={on ? { borderColor: accent } : {}} onClick={() => toggleRef({ kind: it.kind, id: it.id, label: it.label, version: it.version })}>
              <View className="ref-ib"><Text className="ref-il">{it.label}</Text>{it.sub ? <Text className="ref-is">{it.sub}</Text> : null}</View>
              <View className="ref-ck" style={on ? { background: accent, borderColor: accent } : {}}>{on ? <Icon name="check" size={12} color="#fff" /> : null}</View>
            </View>
          );
        })}
      </View>
    );
  };

  return (
    <View className={`page chat ${s.themeClass()}`} style={{ '--keyboard-height': `${keyboardHeight}px` } as ChatStyle}>
      {/* 顾问身份头 */}
      <SafeHeader
        className="chat-head"
        left={<View className="safe-hbtn" onClick={() => Taro.switchTab({ url: '/pages/sessions/index' })}><Icon name="grid" size={20} color="#565C63" /></View>}
        right={<View className="safe-hbtn" onClick={() => Taro.redirectTo({ url: '/pages/chat/index?fresh=1' })}><Icon name="spark" size={20} color="#565C63" /></View>}
      >
        <View className="chat-id">
          <Text className="cn">{agent?.name ?? '军师'}</Text>
          <Text className="cr">· {agent?.role ?? '通用商业军师'}</Text>
        </View>
      </SafeHeader>

      {/* 记忆条 */}
      {agent && (
        <View className="mem-bar">
          <Icon name="layers" size={14} color={accent} />
          <Text className="mt">专属理解：{stripTags(agent.memText)}</Text>
          <View className="mlearn"><View className="dot" style={{ background: accent }} /><Text>{agent.learnText}</Text></View>
        </View>
      )}

      {/* 项目作用域 + 生成纪要 */}
      <View className="chat-tools">
        {projectId ? (
          <View className="ct-proj" style={{ background: 'var(--accent-soft)' }} onClick={() => Taro.navigateTo({ url: `/packages/work/project/index?id=${projectId}` })}>
            <Icon name="layers" size={12} color={accent} /><Text style={{ color: accent }}>项目内对话</Text>
          </View>
        ) : <View className="ct-spacer" />}
        <View className="ct-sum" onClick={onSummarize}><Icon name="doc" size={13} color="#565C63" /><Text>生成纪要</Text></View>
      </View>

      {/* 对话流 */}
      <ScrollView scrollY className="chat-log" scrollTop={scrollTop} scrollWithAnimation enhanced showScrollbar={false}>
        {msgs.map((m, i) => {
          if (m.role === 'greet') {
            return (
              <View key={i} className="msg a">
                <View className="who"><View className="d" style={{ background: accent }}><Icon name={m.agent.icon} size={13} color="#fff" /></View><Text>{m.agent.name}</Text></View>
                <View className="bubble">
                  <Text>{m.agent.greet}</Text>
                  <View className="memory-disclosure">
                    <View className="md-h">
                      <Icon name="layers" size={13} color={accent} />
                      <Text style={{ color: accent }}>专属理解</Text>
                    </View>
                    <Text className="md-copy">我会参考你在本账号沉淀的企业档案、历史偏好和本次引用资料，让建议保持同一套业务口径。</Text>
                    <View className="md-tags">
                      <Text>企业档案</Text>
                      <Text>对话偏好</Text>
                      <Text>引用资料</Text>
                    </View>
                  </View>
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
            return (
              <View key={i} className="msg u">
                <View className="ubub" style={{ background: accent }}><Text>{m.text}</Text></View>
                {m.refs?.length ? (
                  <View className="uref">{m.refs.map((r, j) => <Text key={j} className="uref-chip">@{r.label}</Text>)}</View>
                ) : null}
              </View>
            );
          }
          if (m.role === 'assistant') {
            return (
              <View key={i} className="msg a">
                <View className="who"><View className="d" style={{ background: accent }}><Icon name={agent?.icon ?? 'spark'} size={13} color="#fff" /></View><Text>{agent?.name}</Text></View>
                <View className="bubble">
                  <MarkdownText text={m.reply.text} />
                  {m.reply.points && (
                    <View className="points">
                      {m.reply.points.map((p, j) => <View key={j} className="pt"><View className="pd" style={{ background: accent }} /><MarkdownText text={p} className="pt-t" /></View>)}
                    </View>
                  )}
                </View>
                {m.retryText ? (
                  <Text style={{ marginTop: '6px', color: accent, fontSize: '13px' }} onClick={() => doSend(m.retryText!, sessionId, agent?.key ?? '', [], false)}>↻ 重试</Text>
                ) : null}
              </View>
            );
          }
          if (m.role === 'memory') {
            return (
              <View key={i} className="mem-learned">
                <Icon name="spark" size={13} color={accent} />
                <Text>专属理解已更新：{m.agentName} 已校准本次对话里的业务偏好和判断口径，后续产出会更贴合。</Text>
              </View>
            );
          }
          // report
          return (
            // P2-14：报告气泡用 messageId 作稳定 key，避免「延迟插入记忆」导致索引位移、ReportCard 渐显动画状态错位。
            <View key={m.messageId ?? `r-${i}`} className="msg a">
              <View className="who"><View className="d" style={{ background: accent }}><Icon name={agent?.icon ?? 'spark'} size={13} color="#fff" /></View><Text>{agent?.name}</Text></View>
              <ReportCard data={m.deliverable} animate={m.animate} onSave={() => saveDeliverable(m.deliverable)} onExport={() => copyDeliverable(m.deliverable)} onShare={() => shareReport(m.messageId)} />
              {m.deliverable.degraded ? (
                <View style={{ marginTop: '8px', fontSize: '12px', opacity: 0.7 }}>
                  <Text>本次为降级模板（未取得完整结构化产出），可重新发送以获取正式成果。</Text>
                </View>
              ) : null}
              {m.knowledgeUsed && m.knowledgeUsed.length ? (
                <View style={{ marginTop: '6px', fontSize: '12px', opacity: 0.6 }}>
                  <Text>参考了 {m.knowledgeUsed.length} 份资料：{m.knowledgeUsed.join('、')}</Text>
                </View>
              ) : null}
            </View>
          );
        })}
        {busy && agent ? (
          <View className="msg a thinking">
            <View className="who"><View className="d" style={{ background: accent }}><Icon name={agent.icon} size={13} color="#fff" /></View><Text>{agent.name}</Text></View>
            <View className="bubble think-bubble">
              <View className="think-dots">
                <View className="think-dot" style={{ background: accent }} />
                <View className="think-dot d2" style={{ background: accent }} />
                <View className="think-dot d3" style={{ background: accent }} />
              </View>
              <Text className="think-text">正在梳理上下文</Text>
            </View>
          </View>
        ) : null}
        <View style={{ height: '20px' }} />
      </ScrollView>

      {/* 已选引用 */}
      {refs.length ? (
        <View className="ref-row">
          {refs.map((r, j) => (
            <View key={j} className="ref-chip" style={{ borderColor: accent }} onClick={() => toggleRef(r)}>
              <Text style={{ color: accent }}>@{r.label}</Text><Text className="ref-x">✕</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* 输入区 */}
      <View className="composer">
        <View className="box" onClick={() => setInputFocus(true)}>
          <View className="cbtn" onClick={(e) => { e.stopPropagation?.(); openPicker(); }}><Icon name="attach" size={18} color={refs.length ? accent : '#969BA1'} /></View>
          <Input
            className="cinput"
            type="text"
            value={input}
            focus={inputFocus}
            maxlength={500}
            cursorSpacing={24}
            adjustPosition={false}
            alwaysEmbed
            placeholder="向顾问提问…（点 📎 引用项目/报告/知识）"
            confirmType="send"
            onFocus={() => setInputFocus(true)}
            onBlur={() => { setInputFocus(false); setKeyboardHeight(0); }}
            onInput={handleInput}
            onConfirm={(e) => onSend(e.detail.value)}
            onKeyboardHeightChange={onKeyboardHeightChange}
          />
          <Icon name="mic" size={18} color="#969BA1" />
        </View>
        <View className={`csend ${busy ? 'busy' : ''}`} style={{ background: accent }} onClick={() => onSend()}>
          <Icon name="send" size={18} color="#fff" />
        </View>
      </View>

      {/* @引用选择器 */}
      {picker && (
        <View className="ref-sheet">
          <View className="ref-mask" onClick={closePicker} />
          <View className="ref-panel">
            <View className="ref-ph">
              <Text className="ref-pt">引用资料</Text>
              <Text className="ref-done" style={{ color: accent }} onClick={closePicker}>完成{refs.length ? ` (${refs.length})` : ''}</Text>
            </View>
            <ScrollView scrollY className="ref-body" enhanced showScrollbar={false}>
              {renderGroup('项目', pick.projects.map((p) => ({ kind: 'project' as const, id: p.id, label: p.name, sub: `${p.counts.reports} 报告 · ${p.counts.knowledge} 知识` })))}
              {renderGroup('报告', pick.reports.map((r) => ({ kind: 'report' as const, id: r.id, label: `${r.title} v${r.currentVersion}`, version: r.currentVersion, sub: r.type })))}
              {renderGroup('知识', pick.knowledge.map((k) => ({ kind: 'knowledge' as const, id: k.id, label: k.title || k.text.slice(0, 14), sub: k.text.slice(0, 24) })))}
              {renderGroup('记忆', pick.memories.map((m) => ({ kind: 'memory' as const, id: m.id, label: m.text.slice(0, 18), sub: m.agentName || m.kind })))}
              {(!pick.projects.length && !pick.reports.length && !pick.knowledge.length && !pick.memories.length) ? (
                <Text className="ref-empty">还没有可引用的项目/报告/知识。先建项目、产出报告或记录知识，这里就能 @ 它们。</Text>
              ) : null}
              <View style={{ height: '12px' }} />
            </ScrollView>
          </View>
        </View>
      )}

      <Login
        open={showLogin}
        onLoggedIn={() => {
          setShowLogin(false);
          initChat();
        }}
      />
    </View>
  );
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}
function data_delay(d: Deliverable): number {
  return 900 + d.sections.length * 640 + 500;
}
