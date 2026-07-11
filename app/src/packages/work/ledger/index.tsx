import { useEffect, useState } from 'react';
import { View, Text, ScrollView, Input } from '@tarojs/components';
import Taro from '@tarojs/taro';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { api, type DecisionLedger, type ProphecyLedger, type DecisionView, type ProphecyView } from '../../../services/api';
import './index.scss';

type Tab = 'decision' | 'prophecy';

// disputeNote 尚未进入 SSOT 视图类型（服务端已落库），此处宽松读取，兼容后续下发。
function disputeNoteOf(x: { id: string }): string | undefined {
  return (x as unknown as { disputeNote?: string }).disputeNote;
}
function seedDisputed(prev: Set<string>, items: { id: string }[]): Set<string> {
  const next = new Set(prev);
  items.forEach((it) => { if (disputeNoteOf(it)) next.add(it.id); });
  return next;
}

export default function LedgerPage() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [tab, setTab] = useState<Tab>('decision');
  const [dec, setDec] = useState<DecisionLedger | null>(null);
  const [pro, setPro] = useState<ProphecyLedger | null>(null);
  const [busy, setBusy] = useState('');
  // 已提交异议（含服务端 disputeNote 回填 + 本次提交），条目显示「已反馈」标记。
  const [disputed, setDisputed] = useState<Set<string>>(new Set());
  const markDisputed = (id: string) => setDisputed((cur) => new Set(cur).add(id));

  useEffect(() => {
    api.decisions().then((r) => { setDec(r); setDisputed((cur) => seedDisputed(cur, r.items)); }).catch(() => {});
    api.prophecies().then((r) => { setPro(r); setDisputed((cur) => seedDisputed(cur, r.items)); }).catch(() => {});
  }, []);

  const verifyDec = async (id: string, outcome: 'correct' | 'revise') => {
    if (busy) return; setBusy(id);
    try { const r = await api.verifyDecision(id, outcome); setDec((c) => (c ? { items: c.items.map((i) => (i.id === id ? r.decision : i)), stats: r.stats } : c)); }
    catch (e) { s.handleApiError(e); } finally { setBusy(''); }
  };
  const verifyPro = async (id: string, outcome: 'hit' | 'miss') => {
    if (busy) return; setBusy(id);
    try { const r = await api.verifyProphecy(id, outcome); setPro((c) => (c ? { items: c.items.map((i) => (i.id === id ? r.prophecy : i)), stats: r.stats } : c)); }
    catch (e) { s.handleApiError(e); } finally { setBusy(''); }
  };

  const decStatLine = () => {
    if (!dec) return '加载中…';
    const v = dec.stats.correct + dec.stats.revise;
    if (dec.stats.accuracy !== null) return `准确率 ${dec.stats.accuracy}% · 正确 ${dec.stats.correct} / 需修正 ${dec.stats.revise} · 待验证 ${dec.stats.pending}`;
    if (v > 0) return `已验证 ${v} 条 · 先打满 5 条才出准确率 · 待验证 ${dec.stats.pending}`;
    return `共 ${dec.stats.total} 条 · 还没有已验证的决策`;
  };
  const proStatLine = () => {
    if (!pro) return '加载中…';
    const v = pro.stats.hit + pro.stats.miss;
    if (pro.stats.hitRate !== null) return `命中率 ${pro.stats.hitRate}% · 命中 ${pro.stats.hit} / 未中 ${pro.stats.miss} · 待验证 ${pro.stats.pending}`;
    if (v > 0) return `已验证 ${v} 条 · 先打满 5 条才出命中率 · 待验证 ${pro.stats.pending}`;
    return `共 ${pro.stats.total} 条 · 还没有已验证的预言`;
  };

  return (
    <View className="page ledger-page">
      <SafeHeader title="战略账本" onBack={() => Taro.navigateBack()} />
      <View className="lg-tabs">
        <Text className={`lg-tab ${tab === 'decision' ? 'on' : ''}`} onClick={() => setTab('decision')}>决策账本</Text>
        <Text className={`lg-tab ${tab === 'prophecy' ? 'on' : ''}`} onClick={() => setTab('prophecy')}>天机账本</Text>
      </View>
      <ScrollView scrollY className="lg-scroll">
        {tab === 'decision' ? (
          <>
            <View className="lg-stat card"><Text className="lg-stat-x">{decStatLine()}</Text></View>
            {(dec?.items ?? []).map((d) => (
              <DecisionRow key={d.id} d={d} busy={busy === d.id} onVerify={verifyDec} accent={accent} disputed={disputed.has(d.id)} onDisputed={markDisputed} />
            ))}
            {dec && !dec.items.length ? <Text className="lg-empty">还没有决策记账。认可方案 = 一次战略决策，军师会自动记进来。</Text> : null}
          </>
        ) : (
          <>
            <View className="lg-stat card"><Text className="lg-stat-x">{proStatLine()}</Text></View>
            {(pro?.items ?? []).map((p) => (
              <ProphecyRow key={p.id} p={p} busy={busy === p.id} onVerify={verifyPro} accent={accent} disputed={disputed.has(p.id)} onDisputed={markDisputed} />
            ))}
            {pro && !pro.items.length ? <Text className="lg-empty">还没有天机记账。{s.fortuneOn() ? '军师做八字判断时' : '军师做前瞻判断时'}会记成可验证的预言。</Text> : null}
          </>
        )}
        <View className="lg-note">
          <Text>验证是给自己算账：兑现了点「应验/正确」，没兑现点「没应验/需修正」。攒够 5 条，命中率和段位才开始算——不靠一两条撑门面。</Text>
        </View>
        <View style={{ height: '40px' }} />
      </ScrollView>
    </View>
  );
}

function badgeOf(status: string): { t: string; c: string } {
  if (status === 'correct') return { t: '正确', c: 'ok' };
  if (status === 'hit') return { t: '命中', c: 'ok' };
  if (status === 'revise') return { t: '需修正', c: 'bad' };
  if (status === 'miss') return { t: '未中', c: 'bad' };
  return { t: '待验证', c: 'wait' };
}

function DecisionRow({ d, busy, onVerify, accent, disputed, onDisputed }: { d: DecisionView; busy: boolean; onVerify: (id: string, o: 'correct' | 'revise') => void; accent: string; disputed: boolean; onDisputed: (id: string) => void }) {
  const b = badgeOf(d.status);
  return (
    <View className="lg-item card">
      <View className="lg-item-h">
        <Text className="lg-seq serif">决策 #{d.seq}</Text>
        <Text className={`lg-badge b-${b.c}`}>{b.t}</Text>
      </View>
      <Text className="lg-text">{d.decision}</Text>
      {d.status === 'pending' ? (
        <View className="lg-acts">
          <Text className="lg-act ok" style={{ borderColor: accent, color: accent }} onClick={() => onVerify(d.id, 'correct')}>{busy ? '…' : '判断正确'}</Text>
          <Text className="lg-act bad" onClick={() => onVerify(d.id, 'revise')}>需修正</Text>
        </View>
      ) : d.verifyByDate ? <Text className="lg-due">验证期 {d.verifyByDate}</Text> : null}
      <DisputeArea id={d.id} kind="decision" disputed={disputed} onDisputed={onDisputed} accent={accent} />
    </View>
  );
}

function ProphecyRow({ p, busy, onVerify, accent, disputed, onDisputed }: { p: ProphecyView; busy: boolean; onVerify: (id: string, o: 'hit' | 'miss') => void; accent: string; disputed: boolean; onDisputed: (id: string) => void }) {
  const b = badgeOf(p.status);
  return (
    <View className="lg-item card">
      <View className="lg-item-h">
        <Text className="lg-seq serif">预言 #{p.seq}</Text>
        <Text className={`lg-badge b-${b.c}`}>{b.t}</Text>
      </View>
      <Text className="lg-text">{p.prophecy}</Text>
      {p.status === 'pending' ? (
        <View className="lg-acts">
          <Text className="lg-act ok" style={{ borderColor: accent, color: accent }} onClick={() => onVerify(p.id, 'hit')}>{busy ? '…' : '应验了'}</Text>
          <Text className="lg-act bad" onClick={() => onVerify(p.id, 'miss')}>没应验</Text>
        </View>
      ) : p.dueDate ? <Text className="lg-due">到期 {p.dueDate}</Text> : null}
      <DisputeArea id={p.id} kind="prophecy" disputed={disputed} onDisputed={onDisputed} accent={accent} />
    </View>
  );
}

// WO-11 异议入口：展开区「有出入？」→ 输入框提交异议 → 成功后条目显示对账标记。
// 已有异议（disputeNote 回填 / 本次已提交）直接显示标记，不再暴露入口。
function DisputeArea({ id, kind, disputed, onDisputed, accent }: { id: string; kind: 'decision' | 'prophecy'; disputed: boolean; onDisputed: (id: string) => void; accent: string }) {
  const s = useStore();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  if (disputed) return <Text className="lg-disputed">已反馈，复盘时军师与你对账</Text>;

  const submit = async () => {
    const note = text.trim();
    if (!note || sending) return;
    setSending(true);
    try {
      if (kind === 'decision') await api.disputeDecision(id, note);
      else await api.disputeProphecy(id, note);
      onDisputed(id);
      setOpen(false);
      setText('');
    } catch (e) {
      s.handleApiError(e, { fallbackTitle: '提交失败，请重试' });
    } finally {
      setSending(false);
    }
  };

  if (!open) return <Text className="lg-dispute-entry" onClick={() => setOpen(true)}>有出入？</Text>;
  return (
    <View className="lg-dispute">
      <Input
        className="lg-dispute-input"
        value={text}
        placeholder="说说哪里对不上，军师复盘时与你对账"
        focus
        onInput={(e) => setText(e.detail.value)}
        onConfirm={submit}
      />
      <View className="lg-dispute-acts">
        <Text className="lg-dispute-cancel" onClick={() => { setOpen(false); setText(''); }}>取消</Text>
        <Text className="lg-dispute-send" style={{ color: accent }} onClick={submit}>{sending ? '提交中…' : '提交异议'}</Text>
      </View>
    </View>
  );
}
