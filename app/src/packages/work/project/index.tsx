import { useState } from 'react';
import { View, Text, Input } from '@tarojs/components';
import Taro, { useRouter, useDidShow } from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { navTo, switchTo } from '../../../services/nav';
import { api, type ProjectDetail } from '../../../services/api';
import './index.scss';

// 案卷详情三视图（WO-01）：战况=会话线索 / 方案=版本化报告 / 资料=知识库。
type Tab = 'situation' | 'plans' | 'materials';

function fmt(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// 案卷详情：一份案卷里的 战况（会话）/ 方案（报告）/ 资料（知识）一站式归拢。
export default function Project() {
  const router = useRouter();
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const id = (router.params as Record<string, string>).id || '';
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [tab, setTab] = useState<Tab>('situation');
  const [kInput, setKInput] = useState('');
  const [kBusy, setKBusy] = useState(false);
  const [failed, setFailed] = useState(false); // D2：失败态 + 重试，避免永久「加载中…」

  const load = () => {
    if (!id) { setFailed(true); return; }
    setFailed(false);
    api.project(id).then((d) => { setDetail(d); }).catch((e) => { s.handleApiError(e); setDetail(null); setFailed(true); });
  };
  useDidShow(load);

  const addKnowledge = async () => {
    const v = kInput.trim();
    if (!v || kBusy) return; // D5：busy 防重复提交
    setKBusy(true);
    const saved = await api.createKnowledge({ text: v, projectId: id, kind: 'document', sourceType: 'manual' }).catch((e) => {
      s.handleApiError(e, { fallbackTitle: '知识保存失败' });
      return null;
    });
    setKBusy(false);
    if (!saved) return; // D5：失败保留输入，不丢用户已敲的内容
    setKInput('');
    load();
    Taro.showToast({ title: '已加入知识库', icon: 'none' });
  };

  if (!detail) {
    return (
      <View className={`page project ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
        <SafeHeader title="案卷" onBack={() => Taro.navigateBack()} titleClassName="pd-title" />
        <View className="pd-loading">
          <Text>{failed ? '案卷加载失败' : '加载中…'}</Text>
          {failed ? <View className="pd-retry" onClick={load}><Text>重试</Text></View> : null}
        </View>
      </View>
    );
  }

  const tabs: [Tab, string, number][] = [
    ['situation', '战况', detail.counts.sessions],
    ['plans', '方案', detail.counts.reports],
    ['materials', '资料', detail.counts.knowledge],
  ];

  return (
    <View className={`page project ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title={detail.name} onBack={() => Taro.navigateBack()} titleClassName="pd-title" />

      <View className="pad">
        {detail.summary ? (
          <View className="pd-summary card"><Icon name="insight" size={15} color={accent} /><Text className="pd-sum-t">{detail.summary}</Text></View>
        ) : null}

        <View className="pd-cta" style={{ background: accent }} onClick={() => navTo(`/packages/main/chat/index?projectId=${id}&fresh=1`)}>
          <Icon name="spark" size={16} color="#fff" /><Text>在本案卷里开新对话</Text>
        </View>

        <View className="pd-seg">
          {tabs.map(([k, label, n]) => (
            <View key={k} className={`seg ${tab === k ? 'on' : ''}`} style={tab === k ? { background: accent } : {}} onClick={() => setTab(k)}>
              <Text>{label}</Text><Text className="seg-n">{n}</Text>
            </View>
          ))}
        </View>

        {tab === 'situation' && (
          <View className="pd-list">
            <View className="pd-item card" onClick={() => switchTo('/pages/studio/index')}>
              <View className="pd-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="check" size={16} color={accent} /></View>
              <View className="pd-ib"><Text className="pd-it">在「执行」承接军令与复盘</Text><Text className="pd-im">认可方案后拆成军令，打卡、回填、复盘都在执行页</Text></View>
              <Text className="pd-go">›</Text>
            </View>
            {detail.sessions.length === 0 ? <Text className="pd-empty">还没有归属本案卷的对话。</Text> :
              detail.sessions.map((it) => (
                <View key={it.id} className="pd-item card" onClick={() => navTo(`/packages/main/chat/index?sessionId=${it.id}`)}>
                  <View className="pd-ic" style={{ background: 'var(--accent-soft)' }}><Icon name={it.agentIcon || 'chat'} size={16} color={accent} /></View>
                  <View className="pd-ib"><Text className="pd-it">{it.title}</Text><Text className="pd-im">{it.agentName} · {it.snippet}</Text></View>
                  <Text className="pd-go">›</Text>
                </View>
              ))}
          </View>
        )}

        {tab === 'plans' && (
          <View className="pd-list">
            {detail.reports.length === 0 ? <Text className="pd-empty">还没有方案。在对话里产出方案并「存入方案库」，即在此版本化。</Text> :
              detail.reports.map((r) => (
                <View key={r.id} className="pd-item card" onClick={() => navTo(`/packages/work/report/index?id=${r.id}`)}>
                  <View className="pd-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="doc" size={16} color={accent} /></View>
                  <View className="pd-ib"><Text className="pd-it">{r.title}</Text><Text className="pd-im">{r.type} · 更新于 {fmt(r.updatedAt)}</Text></View>
                  <View className="pd-ver" style={{ borderColor: accent, color: accent }}><Text>v{r.currentVersion}</Text></View>
                </View>
              ))}
          </View>
        )}

        {tab === 'materials' && (
          <View className="pd-list">
            <View className="pd-kadd">
              <Input className="pd-kinput" value={kInput} placeholder="记一条资料/决策，回车入库（可被对话引用）" confirmType="done" onInput={(e) => setKInput(e.detail.value)} onConfirm={addKnowledge} />
              <View className={`pd-kbtn ${kBusy ? 'busy' : ''}`} style={{ background: accent }} onClick={addKnowledge}><Icon name="check" size={15} color="#fff" /></View>
            </View>
            {detail.knowledge.length === 0 ? <Text className="pd-empty">资料库为空。对话「生成纪要」或在此手动记录，都会沉淀到这里。</Text> :
              detail.knowledge.map((k) => (
                <View key={k.id} className="pd-kitem card" onClick={() => navTo(`/packages/work/knowledge/detail/index?id=${k.id}`)}>
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
  return ({ insight: '洞察', document: '资料', decision: '决策', todo: '待办', report_ref: '方案' } as Record<string, string>)[kind] || '资料';
}
