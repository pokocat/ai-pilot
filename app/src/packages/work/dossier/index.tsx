import { useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { api, type DossierReport, type DossierBlock } from '../../../services/api';
import './index.scss';

export default function DossierPage() {
  const s = useStore();
  const [report, setReport] = useState<DossierReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const mountedRef = useRef(true);
  const loadingRef = useRef(false);

  const generate = async (allowBeforeReady = false) => {
    if (loadingRef.current || (!ready && !allowBeforeReady)) return;
    loadingRef.current = true;
    setLoading(true);
    setLoadError(false);
    try {
      const r = await api.generateDossier();
      if (mountedRef.current) setReport(r.report);
    } catch (e) {
      if (mountedRef.current) s.handleApiError(e);
    } finally {
      loadingRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  };

  const load = async () => {
    setReady(false);
    setLoadError(false);
    try {
      const r = await api.dossier();
      if (!mountedRef.current) return;
      setReady(true);
      if (r.report) { setReport(r.report); return; }
      setReport(null);
      // 首次自动立档必须绕过本轮 render 的 ready=false，不能被手动按钮门禁拦截。
      const maturity = s.me()?.understanding?.maturity;
      if (maturity && maturity !== 'empty') void generate(true);
    } catch (e) {
      if (!mountedRef.current) return;
      setReady(true);
      setLoadError(true);
      s.handleApiError(e);
    }
  };

  // D5：刷新履历会重新消耗额度重写，加一道轻确认防误触。
  const regenerate = () => {
    if (loading) return;
    Taro.showModal({
      title: '刷新完整履历',
      content: '将重新执笔生成一份履历（会消耗一次额度），覆盖当前这份。确定刷新？',
      confirmText: '刷新',
      cancelText: '再想想',
      success: (r) => { if (r.confirm) void generate(); },
    });
  };

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => { mountedRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View className={`page dossier-page ${s.themeClass()}`}>
      <SafeHeader title="完整履历" onBack={() => Taro.navigateBack()} titleClassName="ds-navtitle" />
      {!report ? (
        <View className="ds-empty">
          <Text className="ds-empty-t serif">创始人战略档案</Text>
          <Text className="ds-empty-d">{loadError ? '完整履历暂时没有加载成功，请检查网络后重试。' : '军师把你的资料——档案、对话、案卷、战略——蒸馏成一份完整履历。资料够了会自动为你立档，越全写得越透；也可以现在就手动生成。'}</Text>
          <View className={`ds-gen ${loading || !ready ? 'busy' : ''}`} onClick={loadError ? load : () => generate()}>
            <Text>{loading ? '军师执笔中…' : (!ready ? '加载中…' : loadError ? '重新加载' : '生成完整履历')}</Text>
          </View>
        </View>
      ) : (
        <ScrollView scrollY className="ds-scroll">
          <View className="ds-cover">
            <Text className="ds-cover-badge">军师参谋部 · 战略档案</Text>
            <Text className="ds-cover-name serif">{report.name}</Text>
            <Text className="ds-cover-head">{report.headline}</Text>
            {report.verse ? <Text className="ds-cover-verse serif">「{report.verse}」</Text> : null}
          </View>
          {report.sections.map((sec) => (
            <View key={sec.key} className="ds-sec">
              <View className="ds-sec-head">
                <Text className="ds-sec-no serif">{sec.no}</Text>
                <View className="ds-sec-tt">
                  <Text className="ds-sec-label">{sec.label}</Text>
                  {sec.eyebrow ? <Text className="ds-sec-eye">{sec.eyebrow}</Text> : null}
                </View>
              </View>
              {sec.blocks.map((b, i) => <Block key={i} b={b} />)}
            </View>
          ))}
          <View className="ds-foot">
            <Text className="ds-foot-brand serif">军师参谋部</Text>
            <Text className="ds-regen" onClick={regenerate}>{loading ? '刷新中…' : '刷新履历'}</Text>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

function Block({ b }: { b: DossierBlock }) {
  if (b.type === 'para') return <Text className="ds-para">{b.text}</Text>;
  if (b.type === 'quote') return <Text className="ds-quote serif">「{b.text}」</Text>;
  if (b.type === 'highlight') return (
    <View className={`ds-hl ds-hl-${b.tone || 'gold'}`}>
      {b.title ? <Text className="ds-hl-t">{b.title}</Text> : null}
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
