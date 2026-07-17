import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import { ProtoHeader } from '../../components/proto';
import { useStore } from '../../hooks/useStore';
import { api, type ReportItem, type ReportVersionItem } from '../../services/api';
import './index.scss';

function relTime(iso: string): string {
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec < 3600) return '刚刚';
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  const d = Math.floor(sec / 86400);
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  const dt = new Date(iso);
  return `${dt.getMonth() + 1} 月 ${dt.getDate()} 日`;
}

interface Vault { ini: string; name: string; count: string; onClick: () => void }

// 锦囊 tab（原型 isJinnang）—— 存你的家底：
//  两枚置顶常设卷宗（完整履历 / 全年天时）+ 四宫格库（资料库/方法论/历次报告/创作成品）
//  + 某案卷方案的 v1→vN 版本时间线（真实 reports 版本链）。进页清朱砂点。
export default function Satchel() {
  const s = useStore();
  const accent = s.color().hex;
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [knowledgeCount, setKnowledgeCount] = useState(0);
  const [libCount, setLibCount] = useState(0);
  // 方案版本时间线（挑版本链最长的一份案卷展示 v1→vN）
  const [verReport, setVerReport] = useState<ReportItem | null>(null);
  const [versions, setVersions] = useState<ReportVersionItem[]>([]);

  const loadTimeline = (list: ReportItem[]) => {
    if (!list.length) { setVerReport(null); setVersions([]); return; }
    // 取版本号最高（长得最久）的一份，退而取最新一份
    const target = [...list].sort((a, b) => b.currentVersion - a.currentVersion)[0] || list[0];
    setVerReport(target);
    api.report(target.id)
      .then((d) => setVersions([...d.versions].sort((a, b) => b.version - a.version)))
      .catch(() => setVersions([]));
  };

  useDidShow(() => {
    s.setTab(3);
    Taro.getCurrentInstance().page?.getTabBar?.();
    s.loadAgents();
    if (!s.isAuthed()) { setReports([]); setKnowledgeCount(0); setLibCount(0); s.setSatchelDot(false); return; }
    api.reports().then((list) => {
      setReports(list);
      s.markReportsSeen(list[0]?.updatedAt); // 进锦囊即清朱砂点（list 按 updatedAt desc）
      loadTimeline(list);
    }).catch((e) => { s.handleApiError(e, { silent: true }); setReports([]); s.markReportsSeen(); });
    api.knowledge().then((k) => setKnowledgeCount(k.length)).catch(() => setKnowledgeCount(0));
    api.library().then((l) => setLibCount(l.length)).catch(() => setLibCount(0));
  });

  // 在役军师（方法论/框架的近似真实计数）：非创作型顾问军师
  const advisorCount = s.agents().filter((a) => a.type !== 'creative').length;

  const nav = (url: string) => Taro.navigateTo({ url });
  const vaults: Vault[] = [
    { ini: '料', name: '资料库', count: knowledgeCount ? `${knowledgeCount} 份文件` : '待上传', onClick: () => nav('/packages/work/knowledge/index') },
    { ini: '法', name: '方法论', count: advisorCount ? `${advisorCount} 位军师` : '待点将', onClick: () => nav('/packages/work/market/index') },
    { ini: '报', name: '历次报告', count: reports.length ? `${reports.length} 份` : '待出策', onClick: () => nav('/packages/work/library/index') },
    { ini: '创', name: '创作成品', count: libCount ? `${libCount} 件` : '待创作', onClick: () => nav('/packages/work/library/index') },
  ];

  const openVersion = (v: number) => {
    if (!verReport) return;
    Taro.navigateTo({ url: `/packages/work/report/index?id=${verReport.id}&version=${v}` });
  };

  return (
    <Screen tab topInset className="satchel">
      <View className="pad" style={{ paddingTop: '12px' }}>
        <ProtoHeader kicker="存你的家底" title="锦囊" watermark="囊" />

        {/* 两枚置顶常设卷宗（完整履历 / 全年天时） */}
        <View style={{ marginTop: '22px', display: 'flex', gap: '1px', background: 'var(--hair)', border: '1px solid var(--hair)' }}>
          <View style={{ flex: 1, background: 'var(--surf)', padding: '18px 16px' }} onClick={() => nav('/packages/work/dossier/index')}>
            <View style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <View style={{ width: '34px', height: '34px', border: '1px solid var(--ac)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 600, color: accent, fontFamily: 'var(--serif)' }}>履</View>
            </View>
            <Text style={{ display: 'block', fontSize: '15.5px', fontWeight: 600, color: 'var(--tx)', fontFamily: 'var(--serif)', marginBottom: '3px' }}>完整履历</Text>
            <Text style={{ display: 'block', fontSize: '11.5px', color: 'var(--mut)', lineHeight: 1.5 }}>军师执笔的创始人战略档案</Text>
          </View>
          <View style={{ flex: 1, background: 'var(--surf)', padding: '18px 16px' }} onClick={() => nav('/packages/work/calendar/index')}>
            <View style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <View style={{ width: '34px', height: '34px', border: '1px solid var(--ac)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 600, color: accent, fontFamily: 'var(--serif)' }}>时</View>
            </View>
            <Text style={{ display: 'block', fontSize: '15.5px', fontWeight: 600, color: 'var(--tx)', fontFamily: 'var(--serif)', marginBottom: '3px' }}>全年天时</Text>
            <Text style={{ display: 'block', fontSize: '11.5px', color: 'var(--mut)', lineHeight: 1.5 }}>按命盘逐月推演，何时宜攻宜守</Text>
          </View>
        </View>

        {/* 四宫格库（2x2 无缝 hairline 网格） */}
        <View style={{ marginTop: '14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1px', background: 'var(--hair)', border: '1px solid var(--hair)' }}>
          {vaults.map((v) => (
            <View key={v.name} style={{ background: 'var(--surf)', padding: '20px 18px' }} onClick={v.onClick}>
              <View style={{ width: '40px', height: '40px', border: '1px solid var(--ac)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '17px', fontWeight: 600, color: accent, marginBottom: '14px', fontFamily: 'var(--serif)' }}>{v.ini}</View>
              <Text style={{ display: 'block', fontSize: '16px', fontWeight: 600, color: 'var(--tx)', fontFamily: 'var(--serif)', marginBottom: '4px' }}>{v.name}</Text>
              <Text style={{ display: 'block', fontSize: '12px', color: 'var(--mut)' }}>{v.count}</Text>
            </View>
          ))}
        </View>

        {/* 方案版本时间线（v1 → vN，真实版本链） */}
        {verReport && versions.length ? (
          <View>
            <Text className="proto-kicker" style={{ display: 'block', color: 'var(--faint)', letterSpacing: '.24em', margin: '26px 2px 14px' }}>
              方 案 版 本 · 从 v1 长 到 v{verReport.currentVersion}
            </Text>
            <View className="proto-card" style={{ padding: '22px' }}>
              <Text style={{ display: 'block', fontSize: '16px', fontWeight: 600, color: 'var(--tx)', fontFamily: 'var(--serif)' }}>{verReport.title}</Text>
              <View style={{ marginTop: '18px', position: 'relative', paddingLeft: '22px' }}>
                <View style={{ position: 'absolute', left: '4px', top: '6px', bottom: '6px', width: '1px', background: 'var(--hair-2)' }} />
                {versions.map((v, i) => (
                  <View key={v.id} style={{ position: 'relative', paddingBottom: i === versions.length - 1 ? 0 : '18px' }} onClick={() => openVersion(v.version)}>
                    <View style={{ position: 'absolute', left: '-22px', top: '4px', width: '9px', height: '9px', borderRadius: '50%', background: i === 0 ? accent : 'var(--hair-2)', border: '2px solid var(--surf)' }} />
                    <View style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
                      <Text style={{ fontSize: '13px', fontWeight: 600, color: i === 0 ? accent : 'var(--mut)', fontFamily: 'var(--serif)' }}>v{v.version}</Text>
                      <Text style={{ fontSize: '13.5px', color: 'var(--tx)', flex: 1 }}>{v.changeSummary || v.title}</Text>
                    </View>
                    <Text style={{ display: 'block', fontSize: '11px', color: 'var(--faint)', marginTop: '2px' }}>{relTime(v.at)}{v.authorKind === 'user' ? ' · 主公修订' : ' · 军师执笔'}</Text>
                  </View>
                ))}
              </View>
            </View>
          </View>
        ) : (
          <View className="proto-card" style={{ marginTop: '26px', padding: '22px' }}>
            <Text className="proto-kicker" style={{ display: 'block', marginBottom: '8px' }}>方 案 版 本</Text>
            <Text style={{ display: 'block', fontSize: '13.5px', color: 'var(--mut)', lineHeight: 1.8 }}>
              与军师聊过、认可了方案，锦囊里就会长出可追溯的 v1→vN 版本链。
            </Text>
            <View className="proto-btn proto-btn--ghost" style={{ marginTop: '16px' }} onClick={() => Taro.switchTab({ url: '/pages/counsel/index' })}>
              <Text>去问策</Text>
            </View>
          </View>
        )}
      </View>
    </Screen>
  );
}
