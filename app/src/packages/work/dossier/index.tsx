import { useEffect, useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { api, type DossierReport, type DossierBlock } from '../../../services/api';
import './index.scss';

// 落款「军师 · {日期}」：中文月日，对齐设计语言 1.4 印章与落款
function markDate(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return `军师 · ${d.getMonth() + 1}月${d.getDate()}日`;
}

export default function DossierPage() {
  const s = useStore();
  const [report, setReport] = useState<DossierReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);

  const generate = async () => {
    if (loading) return;
    setLoading(true);
    try { const r = await api.generateDossier(); setReport(r.report); }
    catch (e) { s.handleApiError(e); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    let cancelled = false;
    api.dossier().then((r) => {
      if (cancelled) return;
      setReady(true);
      if (r.report) { setReport(r.report); return; }
      // 无缓存 + 资料够（个人档案非空）→ 首次进详情自动立档，免手动点；资料不足则留手动兜底
      const maturity = s.me()?.understanding?.maturity;
      if (maturity && maturity !== 'empty') void generate();
    }).catch(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View className="page dossier-page">
      <SafeHeader title="完整履历" onBack={() => Taro.navigateBack()} titleClassName="ds-navtitle" />
      {!report ? (
        <View className="ds-empty">
          <Text className="ds-empty-t t-title serif">创始人战略档案</Text>
          <Text className="ds-empty-d t-body">军师把你的资料——档案、对话、项目、战略——蒸馏成一份完整履历。资料够了会自动为你立档，越全写得越透；也可以现在就手动生成。</Text>
          <View className={`ds-gen ${loading ? 'busy' : ''}`} onClick={generate}>
            <Text>{loading ? '军师执笔中…' : (ready ? '生成完整履历' : '加载中…')}</Text>
          </View>
        </View>
      ) : (
        <ScrollView scrollY className="ds-scroll">
          <View className="ds-cover">
            <Text className="t-kicker">军师参谋部 · 战略档案</Text>
            <Text className="ds-cover-name t-display serif">{report.name}</Text>
            <Text className="ds-cover-head t-advisor">{report.headline}</Text>
            {report.verse ? <Text className="ds-cover-verse t-body serif">「{report.verse}」</Text> : null}
            <View className="ds-cover-mark">
              <View className="seal-dot" />
              <Text className="t-mark">{markDate(report.generatedAt)}</Text>
            </View>
          </View>
          {report.sections.map((sec) => (
            <View key={sec.key} className="chapter ds-sec">
              <View className="ds-sec-head">
                <Text className="ds-sec-no serif">{sec.no}</Text>
                <View className="ds-sec-tt">
                  <Text className="ds-sec-label t-title">{sec.label}</Text>
                  {sec.eyebrow ? <Text className="ds-sec-eye t-kicker">{sec.eyebrow}</Text> : null}
                </View>
              </View>
              <View className="rule ds-sec-rule" />
              {sec.blocks.map((b, i) => <Block key={i} b={b} />)}
            </View>
          ))}
          <View className="ds-foot">
            <View className="rule" />
            <Text className="ds-foot-brand t-kicker">军师参谋部</Text>
            <Text className="ds-regen pill" onClick={generate}>{loading ? '刷新中…' : '刷新履历'}</Text>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

function Block({ b }: { b: DossierBlock }) {
  if (b.type === 'para') return <Text className="ds-para t-body">{b.text}</Text>;
  if (b.type === 'quote') return <Text className="ds-quote t-body serif">「{b.text}」</Text>;
  if (b.type === 'highlight') return (
    <View className={`ds-hl ${b.tone === 'red' ? 'ds-hl-red' : ''}`}>
      {b.title ? <Text className="ds-hl-t t-kicker">{b.title}</Text> : null}
      <Text className="ds-hl-x">{b.text}</Text>
    </View>
  );
  if (b.type === 'stats') return (
    <View className="ds-stats">
      {b.items.map((it, i) => (
        <View key={i} className="ds-stat"><Text className="ds-stat-v serif">{it.value}</Text><Text className="ds-stat-l">{it.label}</Text></View>
      ))}
    </View>
  );
  if (b.type === 'timeline') return (
    <View className="ds-tl">
      {b.items.map((it, i) => (
        <View key={i} className="ds-ti">
          <Text className="ds-ti-time">{it.time}</Text>
          <Text className="ds-ti-title">{it.title}</Text>
          {it.desc ? <Text className="ds-ti-desc">{it.desc}</Text> : null}
        </View>
      ))}
    </View>
  );
  return null;
}
