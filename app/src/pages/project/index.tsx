import { useState } from 'react';
import { View, Text, Input } from '@tarojs/components';
import Taro, { useRouter, useDidShow } from '@tarojs/taro';
import Icon from '../../components/Icon';
import SafeHeader from '../../components/SafeHeader';
import { useStore } from '../../hooks/useStore';
import { api, type ProjectDetail } from '../../services/api';
import './index.scss';

type Tab = 'sessions' | 'reports' | 'knowledge';

function fmt(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// 项目详情：一个项目里的 会话 / 报告 / 知识 一站式归拢。
export default function Project() {
  const router = useRouter();
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const id = (router.params as Record<string, string>).id || '';
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [tab, setTab] = useState<Tab>('sessions');
  const [kInput, setKInput] = useState('');

  const load = () => { if (id) api.project(id).then(setDetail).catch(() => setDetail(null)); };
  useDidShow(load);

  const addKnowledge = async () => {
    const v = kInput.trim();
    if (!v) return;
    setKInput('');
    await api.createKnowledge({ text: v, projectId: id, kind: 'document', sourceType: 'manual' }).catch(() => {});
    load();
    Taro.showToast({ title: '已加入知识库', icon: 'none' });
  };

  if (!detail) {
    return (
      <View className={`page project ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
        <SafeHeader title="项目" onBack={() => Taro.navigateBack()} titleClassName="pd-title" />
        <View className="pd-loading"><Text>加载中…</Text></View>
      </View>
    );
  }

  const tabs: [Tab, string, number][] = [
    ['sessions', '会话', detail.counts.sessions],
    ['reports', '报告', detail.counts.reports],
    ['knowledge', '知识', detail.counts.knowledge],
  ];

  return (
    <View className={`page project ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title={detail.name} onBack={() => Taro.navigateBack()} titleClassName="pd-title" />

      <View className="pad">
        {detail.summary ? (
          <View className="pd-summary card"><Icon name="insight" size={15} color={accent} /><Text className="pd-sum-t">{detail.summary}</Text></View>
        ) : null}

        <View className="pd-cta" style={{ background: accent }} onClick={() => Taro.navigateTo({ url: `/pages/chat/index?projectId=${id}&fresh=1` })}>
          <Icon name="spark" size={16} color="#fff" /><Text>在本项目里开新对话</Text>
        </View>

        <View className="pd-seg">
          {tabs.map(([k, label, n]) => (
            <View key={k} className={`seg ${tab === k ? 'on' : ''}`} style={tab === k ? { background: accent } : {}} onClick={() => setTab(k)}>
              <Text>{label}</Text><Text className="seg-n">{n}</Text>
            </View>
          ))}
        </View>

        {tab === 'sessions' && (
          <View className="pd-list">
            {detail.sessions.length === 0 ? <Text className="pd-empty">还没有归属本项目的对话。</Text> :
              detail.sessions.map((it) => (
                <View key={it.id} className="pd-item card" onClick={() => Taro.navigateTo({ url: `/pages/chat/index?sessionId=${it.id}` })}>
                  <View className="pd-ic" style={{ background: 'var(--accent-soft)' }}><Icon name={it.agentIcon || 'chat'} size={16} color={accent} /></View>
                  <View className="pd-ib"><Text className="pd-it">{it.title}</Text><Text className="pd-im">{it.agentName} · {it.snippet}</Text></View>
                  <Text className="pd-go">›</Text>
                </View>
              ))}
          </View>
        )}

        {tab === 'reports' && (
          <View className="pd-list">
            {detail.reports.length === 0 ? <Text className="pd-empty">还没有报告。在对话里产出成果并「存入方案库」，即在此版本化。</Text> :
              detail.reports.map((r) => (
                <View key={r.id} className="pd-item card" onClick={() => Taro.navigateTo({ url: `/pages/report/index?id=${r.id}` })}>
                  <View className="pd-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="doc" size={16} color={accent} /></View>
                  <View className="pd-ib"><Text className="pd-it">{r.title}</Text><Text className="pd-im">{r.type} · 更新于 {fmt(r.updatedAt)}</Text></View>
                  <View className="pd-ver" style={{ borderColor: accent, color: accent }}><Text>v{r.currentVersion}</Text></View>
                </View>
              ))}
          </View>
        )}

        {tab === 'knowledge' && (
          <View className="pd-list">
            <View className="pd-kadd">
              <Input className="pd-kinput" value={kInput} placeholder="记一条知识/决策，回车入库（可被对话引用）" confirmType="done" onInput={(e) => setKInput(e.detail.value)} onConfirm={addKnowledge} />
              <View className="pd-kbtn" style={{ background: accent }} onClick={addKnowledge}><Icon name="check" size={15} color="#fff" /></View>
            </View>
            {detail.knowledge.length === 0 ? <Text className="pd-empty">知识库为空。对话「生成纪要」或在此手动记录，都会沉淀到这里。</Text> :
              detail.knowledge.map((k) => (
                <View key={k.id} className="pd-kitem card">
                  <View className="pd-ktag" style={{ background: 'var(--accent-soft)', color: accent }}><Text>{kindLabel(k.kind)}</Text></View>
                  <View className="pd-kb">
                    {k.title ? <Text className="pd-kt">{k.title}</Text> : null}
                    <Text className="pd-kx">{k.text}</Text>
                  </View>
                </View>
              ))}
          </View>
        )}
      </View>
      <View style={{ height: '24px' }} />
    </View>
  );
}

function kindLabel(kind: string): string {
  return ({ insight: '洞察', document: '资料', decision: '决策', todo: '待办', report_ref: '报告' } as Record<string, string>)[kind] || '资料';
}
