import { useEffect, useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { api, type DecisionLedger, type ProphecyLedger, type DecisionView, type ProphecyView } from '../../../services/api';
import './index.scss';

type Tab = 'decision' | 'prophecy';

export default function LedgerPage() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [tab, setTab] = useState<Tab>('decision');
  const [dec, setDec] = useState<DecisionLedger | null>(null);
  const [pro, setPro] = useState<ProphecyLedger | null>(null);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    api.decisions().then(setDec).catch(() => {});
    api.prophecies().then(setPro).catch(() => {});
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
              <DecisionRow key={d.id} d={d} busy={busy === d.id} onVerify={verifyDec} accent={accent} />
            ))}
            {dec && !dec.items.length ? <Text className="lg-empty">还没有决策记账。认可方案 = 一次战略决策，军师会自动记进来。</Text> : null}
          </>
        ) : (
          <>
            <View className="lg-stat card"><Text className="lg-stat-x">{proStatLine()}</Text></View>
            {(pro?.items ?? []).map((p) => (
              <ProphecyRow key={p.id} p={p} busy={busy === p.id} onVerify={verifyPro} accent={accent} />
            ))}
            {pro && !pro.items.length ? <Text className="lg-empty">还没有天机记账。军师做八字判断时会记成可验证的预言。</Text> : null}
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

function DecisionRow({ d, busy, onVerify, accent }: { d: DecisionView; busy: boolean; onVerify: (id: string, o: 'correct' | 'revise') => void; accent: string }) {
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
    </View>
  );
}

function ProphecyRow({ p, busy, onVerify, accent }: { p: ProphecyView; busy: boolean; onVerify: (id: string, o: 'hit' | 'miss') => void; accent: string }) {
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
    </View>
  );
}
