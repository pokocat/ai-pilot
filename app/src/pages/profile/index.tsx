import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import Plans from '../../components/Plans';
import EggDrawer, { type EggKind } from '../../components/EggDrawer';
import { ProtoHeader, PowerRing, CardSeal, CardCorners, SealKicker, Divider } from '../../components/proto';
import { useStore } from '../../hooks/useStore';
import { COLORS } from '../../data/colors';
import { api, type ProgressView } from '../../services/api';
import './index.scss';

// 主公 tab（原型 isZhugong）—— 你自己：
//  档案卡（顶 3px 边）+ 算力环 & 三行统计 + 本命色换色排 + 彩蛋三行（卦/历/机 → 弹层）
//  + 收纳的细行菜单 + 命理合规说明。
export default function Profile() {
  const s = useStore();
  const color = s.color();
  const accent = color.hex;
  const me = s.me();
  const [prog, setProg] = useState<ProgressView | null>(null);
  const [projCount, setProjCount] = useState(0);
  const [showPlans, setShowPlans] = useState(false);
  const [egg, setEgg] = useState<EggKind>(null);

  useDidShow(() => {
    s.setTab(4);
    Taro.getCurrentInstance().page?.getTabBar?.();
    s.loadMe();
    s.loadAgents();
    if (!s.isAuthed()) { setProg(null); setProjCount(0); return; }
    api.progress().then((r) => setProg(r.progress)).catch(() => setProg(null));
    api.projects().then((p) => setProjCount(p.length)).catch(() => setProjCount(0));
  });

  // 本月算力用量 %（不限量按满环处理）
  const q = me?.tokenQuota;
  const powerPct = !q ? 0 : q.unlimited || q.limit < 0 ? 100 : q.limit <= 0 ? 0 : Math.min(100, Math.round((q.used / q.limit) * 100));
  const agentCount = s.agents().filter((a) => a.type !== 'creative').length;

  const stats: { k: string; v: string; hot?: boolean }[] = [
    { k: '企业档案', v: `案卷 ${projCount} 卷` },
    { k: '在役军师', v: `${agentCount} 位`, hot: true },
    { k: '连续经营', v: `${prog?.usageDays ?? 0} 天` },
  ];

  const eggs: { mark: string; name: string; desc: string; kind: Exclude<EggKind, null> }[] = [
    { mark: '卦', name: '送你一卦', desc: '算一张可分享的命盘卡片', kind: 'fortune' },
    { mark: '历', name: '天时日历', desc: '全年攻守节奏一图看全', kind: 'calendar' },
    { mark: '机', name: '天机记账', desc: '把军师的预言记下来对账', kind: 'ledger' },
  ];

  const nav = (url: string) => Taro.navigateTo({ url });
  const menu: { ic: string; t: string; s: string; onClick: () => void }[] = [
    { ic: 'insight', t: '个人档案', s: briefLine(me?.understanding), onClick: () => nav('/pages/brief/index') },
    { ic: 'grid', t: '我的案卷', s: projCount ? `${projCount}` : '', onClick: () => nav('/packages/work/projects/index') },
    { ic: 'attach', t: '资料库', s: '', onClick: () => nav('/packages/work/knowledge/index') },
    { ic: 'chart', t: '数据源', s: '', onClick: () => nav('/packages/work/bindings/index') },
    { ic: 'doc', t: '钱粮明细', s: '', onClick: () => nav('/packages/work/credits/index') },
    { ic: 'layers', t: '战略账本', s: prog?.rank || '', onClick: () => nav('/packages/work/ledger/index') },
    { ic: 'user', t: '军师社群', s: '', onClick: () => nav('/packages/work/community/index') },
    { ic: 'shield', t: '设置', s: '', onClick: () => nav('/pages/settings/index') },
  ];

  const industry = me?.tenant.industry || me?.tenant.name || '待完善行业';

  return (
    <Screen tab topInset className="profile">
      <View className="pad" style={{ paddingTop: '12px' }}>
        <ProtoHeader kicker="你自己" title="主公" watermark="公" />

        {/* 档案卡（顶 3px 本命色边 + 装订角 + 主印） → 设置 */}
        <View className="proto-card proto-card--top" style={{ marginTop: '22px', padding: '22px', display: 'flex', alignItems: 'center', gap: '16px' }} onClick={() => nav('/pages/settings/index')}>
          <CardCorners />
          <View className="seal-circle" style={{ width: '60px', height: '60px', fontSize: '27px', flex: 'none' }}>
            {me?.user.name ? me.user.name[0] : '主'}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ display: 'block', fontSize: '20px', fontWeight: 600, color: 'var(--tx)', fontFamily: 'var(--serif)' }}>{me?.user.name || '完善你的资料'}</Text>
            <Text style={{ display: 'block', fontSize: '13px', color: 'var(--mut)', marginTop: '2px' }}>{industry}</Text>
            <View
              style={{ display: 'inline-flex', marginTop: '9px', fontSize: '11px', letterSpacing: '.08em', color: accent, background: color.acg, border: `1px solid ${accent}`, padding: '3px 11px' }}
              onClick={(e) => { e.stopPropagation(); setShowPlans(true); }}
            >
              <Text>{me?.plan?.name || '免费版'}</Text>
            </View>
          </View>
          <CardSeal char="主" size={22} />
        </View>

        {/* 算力环 + 三行统计（整块浮起，§1） */}
        <View className="proto-grid" style={{ marginTop: '14px', display: 'flex', gap: '1px', background: 'var(--hair)' }}>
          <View style={{ flex: 'none', width: '132px', background: 'var(--surf)', padding: '18px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <PowerRing percent={powerPct} value={powerPct} max={100} label="本月算力" size={78} />
          </View>
          <View style={{ flex: 1, background: 'var(--surf)', padding: '6px 20px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            {stats.map((st, i) => (
              <View key={st.k}>
                <View style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: '13.5px', padding: '9px 0' }}>
                  <Text style={{ color: 'var(--mut)' }}>{st.k}</Text>
                  <Text style={{ color: st.hot ? accent : 'var(--tx)', fontWeight: 600, fontFamily: 'var(--serif)' }}>{st.v}</Text>
                </View>
                {i < stats.length - 1 ? <View style={{ height: '1px', background: 'var(--hair)' }} /> : null}
              </View>
            ))}
          </View>
        </View>

        {/* 本命色换色排（6 色圆环，即点即全局换 --ac） */}
        <SealKicker text="本 命 色 · 随 时 更 换" style={{ margin: '26px 2px 14px' }} />
        <View style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          {COLORS.map((c) => {
            const on = c.key === color.key;
            return (
              <View
                key={c.key}
                onClick={() => s.setColor(c.key)}
                style={{
                  width: '44px', height: '44px', borderRadius: '50%', background: c.hex,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--onac)', fontSize: '14px',
                  boxShadow: on ? `0 0 0 2px var(--bg), 0 0 0 4px ${c.hex}` : 'none',
                }}
              >
                {on ? <Text>✓</Text> : null}
              </View>
            );
          })}
        </View>

        {/* 彩蛋三行 → 弹层（大分区：居中小菱分隔） */}
        <Divider gap={26} />
        <SealKicker text="彩 蛋 · 好 玩 的 小 心 思" style={{ margin: '0 2px 14px' }} />
        <View style={{ borderTop: '1px solid var(--hair)' }}>
          {eggs.map((e) => (
            <View key={e.kind} style={{ display: 'flex', alignItems: 'center', gap: '15px', borderBottom: '1px solid var(--hair)', padding: '16px 2px' }} onClick={() => setEgg(e.kind)}>
              <View className="seal-circle" style={{ width: '40px', height: '40px', fontSize: '19px', flex: 'none' }}>{e.mark}</View>
              <View style={{ flex: 1 }}>
                <Text style={{ display: 'block', fontSize: '15.5px', fontWeight: 600, color: 'var(--tx)' }}>{e.name}</Text>
                <Text style={{ display: 'block', fontSize: '12px', color: 'var(--mut)' }}>{e.desc}</Text>
              </View>
              <Text style={{ color: 'var(--faint)', fontSize: '18px' }}>›</Text>
            </View>
          ))}
        </View>
        <Text style={{ display: 'block', marginTop: '14px', fontSize: '11px', color: 'var(--faint)', textAlign: 'center', lineHeight: 1.9 }}>命理类玩法设有合规总开关 · 可按渠道整体关闭</Text>

        {/* 收纳的细行菜单（别丢功能，减到清爽） */}
        <View style={{ marginTop: '22px', borderTop: '1px solid var(--hair)' }}>
          {menu.map((r) => (
            <View key={r.t} style={{ display: 'flex', alignItems: 'center', gap: '13px', borderBottom: '1px solid var(--hair)', padding: '15px 2px' }} onClick={r.onClick}>
              <View style={{ width: '26px', display: 'flex', justifyContent: 'center' }}><Icon name={r.ic} size={14} color={accent} /></View>
              <Text style={{ flex: 1, fontSize: '14px', color: 'var(--tx)', fontFamily: 'var(--serif)' }}>{r.t}</Text>
              {r.s ? <Text style={{ fontSize: '11px', color: 'var(--faint)', fontFamily: 'var(--serif)', marginRight: '6px' }}>{r.s}</Text> : null}
              <Text style={{ color: 'var(--faint)', fontSize: '16px' }}>›</Text>
            </View>
          ))}
        </View>
      </View>

      <Plans open={showPlans} onClose={() => setShowPlans(false)} />
      <EggDrawer kind={egg} onClose={() => setEgg(null)} />
    </Screen>
  );
}

function briefLine(understanding?: { maturity: string; evidenceCount: { memories: number; projects: number; knowledge: number; sessions: number } }): string {
  if (!understanding) return '';
  if (understanding.maturity === 'ready') return '可用于咨询';
  const count = understanding.evidenceCount.memories + understanding.evidenceCount.projects + understanding.evidenceCount.knowledge + understanding.evidenceCount.sessions;
  return count ? `${count} 条线索` : '待补资料';
}
