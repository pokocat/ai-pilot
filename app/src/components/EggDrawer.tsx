import { useEffect, useState } from 'react';
import { View, Text, Input } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useStore } from '../hooks/useStore';
import { api, type ChartSummary, type ProphecyView } from '../services/api';

// 主公 tab 三彩蛋弹层（底部抽屉 · 顶 3px 本命色边）——对齐原型 MODAL 段：
//  fortune 送你一卦（生辰输入 + 同意勾选 + 起卦 → 命盘卡片，即算即走不留存）
//  calendar 天时日历（12 月攻守宫格，接 myChart；无盘用原型示例兜底并标注）
//  ledger 天机记账（预言对账列表，接 prophecies；已应验/待验证状态色）
// 独立页 gift/calendar/ledger 数据接口原样复用，逻辑搬进弹层。命理类保留合规说明。

export type EggKind = 'fortune' | 'calendar' | 'ledger' | null;

// —— 起卦卦象池（原型 castFortune 四卦文案，即算即走、本地随机、不落库、无公开链接）——
const GUA_POOL = [
  { gua: '☰', name: '乾 · 天行健 · 大有卦', text: '今岁宜主动出击，贵人在东南。三月、九月为拐点，宜攻不宜守。' },
  { gua: '☵', name: '坎 · 习坎 · 蓄势卦', text: '上半年宜潜龙勿用，先修内功；下半年水到渠成，忌急躁冒进。' },
  { gua: '☶', name: '艮 · 艮为山 · 守正卦', text: '守住主业则稳，贪多则乱。今岁财在守不在攻，静待其时。' },
  { gua: '☲', name: '离 · 离为火 · 明察卦', text: '名声渐起，宜借势传播。谨防口舌，合作重在识人。' },
];

// 原型示例月份（无命盘时兜底展示，附「示例」标注）
const SAMPLE_MONTHS: { m: string; act: '攻' | '守' | '等'; note: string }[] = [
  { m: '一月', act: '守', note: '稳住现金流' }, { m: '二月', act: '等', note: '观望蓄力' }, { m: '三月', act: '攻', note: '旺季主动出击' },
  { m: '四月', act: '攻', note: '乘胜追击' }, { m: '五月', act: '守', note: '复盘调整' }, { m: '六月', act: '等', note: '半年小结' },
  { m: '七月', act: '守', note: '淡季修内功' }, { m: '八月', act: '等', note: '筹备秋季' }, { m: '九月', act: '攻', note: '旺季再冲' },
  { m: '十月', act: '攻', note: '黄金窗口' }, { m: '十一月', act: '守', note: '稳中收官' }, { m: '十二月', act: '等', note: '规划来年' },
];

const CN_MONTH = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];

// 攻守色板（等/攻用本命色系，守用固定丹红以示对立）
function actStyle(act: '攻' | '守' | '等'): { tc: string; bg: string } {
  if (act === '攻') return { tc: 'var(--ac)', bg: 'var(--acg)' };
  if (act === '守') return { tc: '#BC4A31', bg: 'rgba(188,74,49,.08)' };
  return { tc: 'var(--faint)', bg: 'var(--surf)' };
}
// 排盘引擎 phase（进攻/防守/平稳）→ 攻守等
function phaseToAct(phase: string): '攻' | '守' | '等' {
  if (/攻/.test(phase)) return '攻';
  if (/守/.test(phase)) return '守';
  return '等';
}

function prophecyDate(p: ProphecyView): string {
  const iso = p.dueDate || p.createdAt;
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function prophecyStatus(status: ProphecyView['status']): { t: string; c: string } {
  if (status === 'hit') return { t: '已应验', c: 'var(--ac)' };
  if (status === 'miss') return { t: '未应验', c: '#BC4A31' };
  return { t: '待验证', c: 'var(--faint)' };
}

interface EggDrawerProps {
  kind: EggKind;
  onClose: () => void;
}

export default function EggDrawer({ kind, onClose }: EggDrawerProps) {
  const s = useStore();
  const accent = s.color().hex;
  // 送你一卦
  const [date, setDate] = useState('');
  const [consent, setConsent] = useState(false);
  const [gua, setGua] = useState<typeof GUA_POOL[number] | null>(null);
  // 天时日历
  const [chart, setChart] = useState<ChartSummary | null>(null);
  const [chartLoaded, setChartLoaded] = useState(false);
  // 天机记账
  const [prophecies, setProphecies] = useState<ProphecyView[] | null>(null);

  // 打开即拉数据 / 关闭即重置起卦态（即算即走不留存）
  useEffect(() => {
    if (!kind) { setGua(null); setConsent(false); setDate(''); return; }
    s.setOverlay(true, 'egg-drawer');
    if (kind === 'calendar' && s.isAuthed()) {
      api.myChart().then((r) => { setChart(r.chart); setChartLoaded(true); })
        .catch((e) => { setChartLoaded(true); s.handleApiError(e, { silent: true }); });
    }
    if (kind === 'ledger' && s.isAuthed()) {
      api.prophecies().then((r) => setProphecies(r.items)).catch(() => setProphecies([]));
    }
    return () => { s.setOverlay(false, 'egg-drawer'); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  if (!kind) return null;

  const canCast = consent && !!date.trim();
  const cast = () => { if (!canCast) return; setGua(GUA_POOL[Math.floor(Math.random() * GUA_POOL.length)]); };
  const resetFortune = () => { setGua(null); };

  const meta: Record<Exclude<EggKind, null>, { kicker: string; title: string; desc: string }> = {
    fortune: { kicker: '彩 蛋 · 传 播 钩 子', title: '送你一卦', desc: '输入朋友的生辰，现算一张可分享的命盘卡片。即算即走、不留存。' },
    calendar: { kicker: '彩 蛋 · 全 年 一 图', title: '天时日历', desc: '一张图看全年的攻守节奏与拐点，适合发到朋友圈。' },
    ledger: { kicker: '彩 蛋 · 可 验 证 的 预 言', title: '天机记账', desc: '军师的前瞻判断记成「预言」，日后翻出来对账，准不准一目了然。' },
  };
  const m = meta[kind];

  // 天时日历月份视图：有盘按引擎排，无盘用示例
  const calMonths: { m: string; act: '攻' | '守' | '等'; note: string }[] = chart
    ? chart.monthlyOutlook.months.map((x) => ({
        m: CN_MONTH[(x.month - 1 + 12) % 12] || `${x.month}月`,
        act: phaseToAct(x.phase),
        note: x.turning ? '拐点 · 提前布局' : x.phase,
      }))
    : SAMPLE_MONTHS;

  return (
    <View
      className="egg-mask"
      style={{ position: 'fixed', left: 0, right: 0, top: 0, bottom: 0, zIndex: 900, background: 'rgba(28,22,12,.6)', display: 'flex', alignItems: 'flex-end' }}
      onClick={onClose}
      catchMove
    >
      <View
        className="egg-drawer"
        style={{ width: '100%', maxHeight: '86vh', overflowY: 'auto', background: 'var(--bg,var(--surf))', borderTop: '3px solid var(--ac)', padding: '24px 24px 34px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <View style={{ width: '38px', height: '3px', background: 'var(--hair-2)', margin: '0 auto 22px', borderRadius: '2px' }} />

        <Text className="proto-kicker" style={{ marginBottom: '10px', letterSpacing: '.24em' }}>{m.kicker}</Text>
        <Text style={{ display: 'block', fontFamily: 'var(--serif)', fontSize: '26px', fontWeight: 600, color: 'var(--tx)', marginBottom: '8px' }}>{m.title}</Text>
        <Text style={{ display: 'block', fontSize: '13.5px', color: 'var(--mut)', lineHeight: 1.8, marginBottom: '22px' }}>{m.desc}</Text>

        {/* —— 送你一卦 —— */}
        {kind === 'fortune' && (
          gua ? (
            <View>
              <View style={{ background: 'var(--acd)', color: 'var(--onac)', padding: '30px 26px', textAlign: 'center', animation: 'popIn .4s var(--ease) both' }}>
                <Text style={{ display: 'block', fontSize: '11px', letterSpacing: '.3em', opacity: 0.75, color: 'var(--onac)' }}>军 师 · 命 盘 卡 片</Text>
                <Text style={{ display: 'block', fontSize: '56px', fontWeight: 400, margin: '16px 0 8px', color: 'var(--onac)' }}>{gua.gua}</Text>
                <Text style={{ display: 'block', fontSize: '16px', fontWeight: 600, letterSpacing: '.08em', marginBottom: '18px', color: 'var(--onac)' }}>{gua.name}</Text>
                <Text style={{ display: 'block', fontSize: '15px', lineHeight: 2, opacity: 0.92, color: 'var(--onac)' }}>{gua.text}</Text>
                <View style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,.18)' }}>
                  <Text style={{ fontSize: '10px', letterSpacing: '.14em', opacity: 0.6, color: 'var(--onac)' }}>军师 · 即算即走 · 不留存</Text>
                </View>
              </View>
              <View className="proto-btn proto-btn--ghost" style={{ width: '100%', marginTop: '16px', boxSizing: 'border-box' }} onClick={resetFortune}>
                <Text>分享给朋友 · 再算一张</Text>
              </View>
            </View>
          ) : (
            <View>
              <Input
                className="egg-input"
                value={date}
                placeholder="例：1994 年 · 处女座"
                onInput={(e) => setDate(e.detail.value)}
                style={{ width: '100%', boxSizing: 'border-box', background: 'var(--surf)', border: '1px solid var(--hair-2)', padding: '15px 16px', color: 'var(--tx)', fontFamily: 'var(--serif)', fontSize: '15px', marginBottom: '16px' }}
              />
              <View style={{ display: 'flex', alignItems: 'center', gap: '11px', marginBottom: '22px' }} onClick={() => setConsent((v) => !v)}>
                <View style={{ width: '22px', height: '22px', border: `1.5px solid ${consent ? accent : 'var(--hair-2)'}`, background: consent ? accent : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
                  {consent ? <Text style={{ color: 'var(--onac)', fontSize: '12px', fontWeight: 600 }}>✓</Text> : null}
                </View>
                <Text style={{ fontSize: '12.5px', color: 'var(--mut)', lineHeight: 1.5 }}>我已知悉此为趣味娱乐，且已获得对方同意</Text>
              </View>
              <View className={`proto-btn ${canCast ? '' : 'proto-btn--disabled'}`} style={{ width: '100%', boxSizing: 'border-box' }} onClick={cast}>
                <Text>起 卦</Text>
              </View>
            </View>
          )
        )}

        {/* —— 天时日历 —— */}
        {kind === 'calendar' && (
          <View>
            {!chart && chartLoaded ? (
              <Text style={{ display: 'block', fontSize: '12px', color: 'var(--faint)', marginBottom: '12px' }}>
                示例月份 · 补生辰后按你的命盘逐月生成
              </Text>
            ) : null}
            <View style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '1px', background: 'var(--hair)', border: '1px solid var(--hair)' }}>
              {calMonths.map((mo, i) => {
                const st = actStyle(mo.act);
                return (
                  <View key={i} style={{ background: st.bg, padding: '14px 13px' }}>
                    <Text style={{ display: 'block', fontSize: '19px', fontWeight: 600, color: 'var(--tx)', fontFamily: 'var(--serif)' }}>{mo.m}</Text>
                    <Text style={{ display: 'block', fontSize: '16px', fontWeight: 600, color: st.tc, margin: '3px 0' }}>{mo.act}</Text>
                    <Text style={{ display: 'block', fontSize: '10.5px', color: 'var(--mut)', lineHeight: 1.4 }}>{mo.note}</Text>
                  </View>
                );
              })}
            </View>
            <View style={{ marginTop: '18px', display: 'flex', gap: '18px', justifyContent: 'center', fontSize: '12px', color: 'var(--mut)' }}>
              <Text><Text style={{ color: 'var(--ac)' }}>■</Text> 攻</Text>
              <Text><Text style={{ color: '#BC4A31' }}>■</Text> 守</Text>
              <Text><Text style={{ color: 'var(--faint)' }}>■</Text> 等</Text>
            </View>
            {!chart && chartLoaded ? (
              <View className="proto-btn proto-btn--ghost" style={{ width: '100%', marginTop: '18px', boxSizing: 'border-box' }} onClick={() => { onClose(); Taro.navigateTo({ url: '/packages/work/calendar/index' }); }}>
                <Text>补生辰 · 生成我的天时</Text>
              </View>
            ) : null}
          </View>
        )}

        {/* —— 天机记账 —— */}
        {kind === 'ledger' && (
          <View style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {prophecies === null ? (
              <Text style={{ fontSize: '13px', color: 'var(--faint)' }}>加载中…</Text>
            ) : prophecies.length === 0 ? (
              <Text style={{ fontSize: '13px', color: 'var(--faint)', lineHeight: 1.8 }}>还没有天机记账。军师做前瞻判断时会记成可验证的预言，日后翻出来对账。</Text>
            ) : (
              prophecies.map((p) => {
                const st = prophecyStatus(p.status);
                return (
                  <View key={p.id} style={{ background: 'var(--surf)', border: '1px solid var(--hair)', borderLeft: `3px solid ${st.c}`, padding: '16px 18px' }}>
                    <View style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '9px' }}>
                      <Text style={{ fontSize: '11px', color: 'var(--faint)' }}>{prophecyDate(p)}</Text>
                      <Text style={{ fontSize: '11px', fontWeight: 600, color: st.c, border: `1px solid ${st.c}`, padding: '2px 9px' }}>{st.t}</Text>
                    </View>
                    <Text style={{ display: 'block', fontSize: '14px', lineHeight: 1.7, color: 'var(--tx)' }}>{p.prophecy}</Text>
                  </View>
                );
              })
            )}
          </View>
        )}

        <View className="proto-btn proto-btn--ghost" style={{ width: '100%', marginTop: '22px', boxSizing: 'border-box', color: 'var(--mut)', borderColor: 'var(--hair-2)' }} onClick={onClose}>
          <Text>收 起</Text>
        </View>
      </View>
    </View>
  );
}
