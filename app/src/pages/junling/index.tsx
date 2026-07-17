import { useState } from 'react';
import { View, Text, Input } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import { ProtoHeader } from '../../components/proto';
import { useStore } from '../../hooks/useStore';
import {
  refreshDossier, ordersOf, todayProgress, today, toggleOrder, saveBackfill,
  type Dossier, type DossierOrder, type DailyBackfill,
} from '../../services/dossier';
import { ADVISOR_ALIAS } from '../../data/council';
import { capabilityFor } from '../../data/capabilities';
import './index.scss';

// 军令（tab2）—— 直角案卷「今日战役」：把判断拆成今天能打的仗，逐条打卡、回填、督战。
// 结构对齐原型 isJunling 段（done/total 双格 + 今日战役任务卡 + 数据回填内联 + 总军师督战）。
// 数据全部走真后端案卷（GET /casefile、PATCH /casefile/orders/:id、PUT /casefile/backfill）。
export default function Junling() {
  const s = useStore();
  const col = s.color();
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [openFillId, setOpenFillId] = useState<string | null>(null);
  const [bf, setBf] = useState<DailyBackfill>({ leads: '', consults: '', deals: '' });
  const [saved, setSaved] = useState(false);
  const und = s.me()?.understanding;

  const hydrateBackfill = (d: Dossier | null) => {
    const cur = d?.backfill?.[today()];
    if (cur) setBf({ leads: cur.leads || '', consults: cur.consults || '', deals: cur.deals || '' });
  };

  const load = () => {
    refreshDossier().then((d) => { setDossier(d); hydrateBackfill(d); }).catch(() => setDossier(null));
  };

  useDidShow(() => {
    s.setTab(2);
    Taro.getCurrentInstance().page?.getTabBar?.();
    load();
  });

  const goCounsel = () => Taro.switchTab({ url: '/pages/counsel/index' });
  const goJunqing = () => Taro.switchTab({ url: '/pages/home/index' });
  const goStudio = () => Taro.navigateTo({ url: '/pages/studio/index' });

  const todayDate = today();
  const orders = ordersOf(dossier, todayDate);
  const progress = todayProgress(dossier);
  const doneCount = progress.done;
  const taskTotal = progress.total;
  const doneRate = progress.percent;

  // 打卡：乐观更新 + 服务端 PATCH（失败回滚重拉）。
  const onToggle = (id: string) => {
    setDossier((cur) => (cur ? { ...cur, orders: cur.orders.map((o) => (o.id === id ? { ...o, done: !o.done } : o)) } : cur));
    toggleOrder(id).then((d) => { if (d) setDossier(d); }).catch(() => refreshDossier().then(setDossier));
  };

  // 数据回填：每卡「点开」共享的今日经营三数（线索/咨询/成交），复用 saveBackfill。
  const toggleFill = (id: string) => {
    setSaved(false);
    setOpenFillId((cur) => (cur === id ? null : id));
  };
  const onSaveFill = () => {
    saveBackfill(bf).then((d) => {
      if (d) { setDossier(d); hydrateBackfill(d); }
      setSaved(true);
      Taro.showToast({ title: '已回填', icon: 'none' });
    }).catch(() => Taro.showToast({ title: '回填失败，稍后再试', icon: 'none' }));
  };

  // 能力去办：军令带 capabilityKey → 站内对应创作军师线程，带承接开场语。
  const dispatchOrder = (o: DossierOrder) => {
    const cap = capabilityFor(o.capabilityKey);
    if (!cap) return;
    Taro.navigateTo({ url: `/pages/chat/index?agentKey=${cap.agentKey}&fresh=1&send=${encodeURIComponent(`${cap.prompt}\n军令：「${o.text}」`)}` });
  };

  // 督战语：确定性文案（据主要矛盾轻度派生），不预置业务结论。
  const marshalNote = und?.mainContradiction
    ? '做完记得回填数据，我据此修正下一轮判断——盯住主要矛盾，令出必行，行必有果。'
    : '做完记得回填数据，我据此修正下一轮判断——令出必行，行必有果。';

  const stat = { fontFamily: 'var(--serif)', fontSize: '34px', fontWeight: 600 as const, lineHeight: 1 };
  const statSub = { display: 'block' as const, fontSize: '12px', color: 'var(--mut)', letterSpacing: '.1em', marginTop: '4px' };

  return (
    <Screen tab topInset className="junling">
      <View className="pad" style={{ paddingTop: '12px' }}>
        <ProtoHeader kicker="做今天的事" title="军令" watermark="令" />

        {orders.length ? (
          <>
            {/* done/total + 战役进度% 双格 */}
            <View style={{ display: 'flex', border: '1px solid var(--hair-2)', marginTop: '22px' }}>
              <View style={{ flex: 1, padding: '18px 20px', borderRight: '1px solid var(--hair-2)' }}>
                <Text style={{ ...stat, color: col.hex }}>
                  {doneCount}<Text style={{ fontSize: '17px', color: 'var(--faint)' }}> / {taskTotal}</Text>
                </Text>
                <Text style={statSub}>今日已办</Text>
              </View>
              <View style={{ flex: 1, padding: '18px 20px' }}>
                <Text style={{ ...stat, color: 'var(--tx)' }}>
                  {doneRate}<Text style={{ fontSize: '17px', color: 'var(--faint)' }}>%</Text>
                </Text>
                <Text style={statSub}>战役进度</Text>
              </View>
            </View>

            {/* 今日战役任务卡列表 */}
            <Text className="proto-kicker" style={{ color: 'var(--faint)', letterSpacing: '.24em', margin: '24px 2px 14px', display: 'block' }}>
              今 日 战 役
            </Text>
            <View style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {orders.map((o) => {
                const cap = capabilityFor(o.capabilityKey);
                const fillOpen = openFillId === o.id;
                return (
                  <View
                    key={o.id}
                    className="proto-card"
                    style={{
                      borderColor: o.done ? 'var(--hair-2)' : 'var(--hair)',
                      borderLeft: `3px solid ${o.done ? col.hex : 'var(--hair-2)'}`,
                      padding: '16px 18px',
                    }}
                  >
                    <View style={{ display: 'flex', gap: '13px', alignItems: 'flex-start' }}>
                      <View
                        onClick={() => onToggle(o.id)}
                        style={{
                          flex: 'none', width: '24px', height: '24px', borderRadius: '50%',
                          border: `1.5px solid ${o.done ? col.hex : 'var(--hair-2)'}`,
                          background: o.done ? col.hex : 'transparent',
                          display: 'grid', placeItems: 'center', marginTop: '2px',
                          color: 'var(--onac)', fontSize: '12px', fontWeight: 600,
                        }}
                      >
                        {o.done ? <Text>✓</Text> : null}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text
                          style={{
                            display: 'block', fontFamily: 'var(--serif)', fontSize: '15.5px', fontWeight: 600, lineHeight: 1.55,
                            color: o.done ? 'var(--mut)' : 'var(--tx)',
                            textDecoration: o.done ? 'line-through' : 'none',
                          }}
                        >
                          {o.text}
                        </Text>
                        <View style={{ display: 'flex', gap: '14px', marginTop: '9px', fontSize: '12px', color: 'var(--mut)', flexWrap: 'wrap' }}>
                          <Text>{o.from}</Text>
                          {o.tag ? <Text>{o.tag}</Text> : null}
                          {o.aligned ? <Text style={{ color: col.hex }}>对齐主要矛盾</Text> : null}
                        </View>
                      </View>
                      {o.done ? (
                        <Text style={{ flex: 'none', fontSize: '12px', color: col.hex, border: `1px solid ${col.hex}`, padding: '2px 8px' }}>已办</Text>
                      ) : null}
                    </View>

                    {/* 卡内操作行：数据回填 + 能力去办 */}
                    <View style={{ display: 'flex', gap: '10px', marginTop: '12px', paddingLeft: '37px', flexWrap: 'wrap' }}>
                      <View className="jl-mini-btn" onClick={() => toggleFill(o.id)}>
                        <Text>{fillOpen ? '收起回填' : '数据回填'}</Text>
                      </View>
                      {cap ? (
                        <View className="jl-mini-btn jl-mini-btn--ac" style={{ borderColor: col.hex, color: col.hex }} onClick={() => dispatchOrder(o)}>
                          <Text>去办 · {ADVISOR_ALIAS[cap.agentKey] || cap.label}</Text>
                        </View>
                      ) : null}
                    </View>

                    {/* 数据回填内联（今日经营三数，复用 saveBackfill） */}
                    {fillOpen ? (
                      <View style={{ marginTop: '14px', paddingTop: '14px', borderTop: '1px dashed var(--hair-2)' }}>
                        <Text className="proto-kicker" style={{ marginBottom: '10px', letterSpacing: '.14em' }}>数 据 回 填 · 今日做出多少</Text>
                        <View style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                          {([['leads', '线索'], ['consults', '咨询'], ['deals', '成交']] as const).map(([key, label]) => (
                            <View key={key} style={{ flex: 1 }}>
                              <Text style={{ display: 'block', fontSize: '11px', color: 'var(--faint)', marginBottom: '4px' }}>{label}</Text>
                              <Input
                                className="jl-fill-input"
                                type="number"
                                value={bf[key]}
                                placeholder="__"
                                onInput={(e) => { setSaved(false); setBf((cur) => ({ ...cur, [key]: e.detail.value })); }}
                              />
                            </View>
                          ))}
                          <View className="jl-fill-commit" style={{ background: col.hex }} onClick={onSaveFill}>
                            <Text>{saved ? '已存' : '回填'}</Text>
                          </View>
                        </View>
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>

            {/* 总军师督战卡 */}
            <View className="proto-card" style={{ marginTop: '18px', display: 'flex', alignItems: 'flex-start', gap: '13px', padding: '16px 18px' }}>
              <View style={{ width: '36px', height: '36px', borderRadius: '50%', background: col.acg, color: col.hex, display: 'grid', placeItems: 'center', fontFamily: 'var(--serif)', fontSize: '17px', fontWeight: 600, flex: 'none' }}>
                <Text>师</Text>
              </View>
              <Text style={{ fontSize: '13px', lineHeight: 1.7, color: 'var(--mut)' }}>
                <Text style={{ color: 'var(--tx)', fontWeight: 600 }}>总军师督战 · </Text>{marshalNote}
              </Text>
            </View>

            {/* 次级入口：回填汇总 · 周计划 · 复盘 → studio */}
            <View className="jl-more" onClick={goStudio}>
              <Text className="jl-more-t">回填汇总 · 周计划 · 复盘</Text>
              <Text className="jl-more-go">›</Text>
            </View>
          </>
        ) : (
          // 空态：今日无军令 → 引导去问策拆军令 / 回军情看判断
          <View className="proto-card proto-card--lead" style={{ marginTop: '24px', padding: '24px 22px', position: 'relative', overflow: 'hidden' }}>
            <View className="proto-watermark" style={{ top: '-6px', right: '-4px', opacity: 0.08 }}>
              <Text style={{ fontFamily: 'var(--serif)', fontWeight: 900, fontSize: '88px', lineHeight: 1, color: col.hex }}>令</Text>
            </View>
            <Text className="proto-kicker" style={{ marginBottom: '12px' }}>今 日 无 军 令</Text>
            <Text style={{ display: 'block', fontFamily: 'var(--serif)', fontSize: '17px', lineHeight: 1.8, color: 'var(--tx)', position: 'relative' }}>
              {dossier ? '主公，今天还没立军令。' : '主公，尚未建档立卷。'}{'\n'}
              先{dossier ? '回军情看判断，' : '入帐一叙，'}让军师把它拆成今天能打的仗。
            </Text>
            <View style={{ display: 'flex', gap: '10px', marginTop: '18px' }}>
              <View className="proto-btn" style={{ background: col.hex, flex: 1 }} onClick={goCounsel}>
                <Text>去 问 策</Text>
              </View>
              <View className="proto-btn proto-btn--ghost" style={{ borderColor: col.hex, color: col.hex, flex: 1 }} onClick={goJunqing}>
                <Text>看 军 情</Text>
              </View>
            </View>
          </View>
        )}
      </View>
    </Screen>
  );
}
