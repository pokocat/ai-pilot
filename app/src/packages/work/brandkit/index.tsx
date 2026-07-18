// WO-13 品牌资产包：三段卡片展示（IP 人设 / 话术库 / 视觉调性）+ 生成/重生成 + 确认无误。
// 数据走 api.brandKit()/generateBrandKit()/approveBrandKit()；生成门槛在服务端（未进执行阶段 403）。
import { useEffect, useState, type ReactNode } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { api, type BrandKitView } from '../../../services/api';
import './index.scss';

function Sec({ title, children }: { title: string; children: ReactNode }) {
  return <View className="bk-sec"><Text className="bk-sec-t">{title}</Text>{children}</View>;
}
function Row({ k, v }: { k: string; v: string }) {
  if (!v) return null;
  return <View className="bk-row"><Text className="bk-k">{k}</Text><Text className="bk-v">{v}</Text></View>;
}
function Chips({ k, items }: { k: string; items: string[] }) {
  if (!items?.length) return null;
  return <View className="bk-row"><Text className="bk-k">{k}</Text><View className="bk-chips">{items.map((it, i) => <Text key={i} className="bk-chip">{it}</Text>)}</View></View>;
}

export default function BrandKitPage() {
  const s = useStore();
  const [bk, setBk] = useState<BrandKitView | null>(null);
  const [busy, setBusy] = useState('');

  useEffect(() => { api.brandKit().then(setBk).catch(() => {}); }, []);

  const generate = async () => {
    if (busy) return; setBusy('gen');
    try { setBk(await api.generateBrandKit()); }
    catch (e) { s.handleApiError(e); }
    finally { setBusy(''); }
  };
  const approve = async () => {
    if (busy || !bk) return; setBusy('appr');
    try { await api.approveBrandKit(); setBk({ ...bk, approved: true }); }
    catch (e) { s.handleApiError(e); }
    finally { setBusy(''); }
  };

  return (
    <View className="bk-page">
      <SafeHeader title="我的品牌资产" onBack={() => Taro.navigateBack()} />
      <ScrollView scrollY className="bk-scroll">
        {!bk ? (
          <View className="bk-empty">
            <Text className="bk-empty-t">还没有品牌资产包</Text>
            <Text className="bk-empty-d">军师根据你的定位，一键生成 IP 人设、话术库、视觉调性——数字人 / 短视频开箱即用。</Text>
            <View className="bk-btn" onClick={generate}><Text>{busy === 'gen' ? '生成中…' : '生成品牌资产包'}</Text></View>
          </View>
        ) : (
          <View className="bk-body">
            <View className="bk-head"><Text className="bk-ver">v{bk.version}{bk.approved ? ' · 已确认' : ''}</Text></View>
            <Sec title="IP 人设">
              <Row k="名称" v={bk.persona.name} />
              <Row k="定位" v={bk.persona.tagline} />
              <Row k="语气" v={bk.persona.tone} />
              <Row k="来历" v={bk.persona.story} />
              <Chips k="禁忌" items={bk.persona.doNots} />
            </Sec>
            <Sec title="话术库">
              <Chips k="钩子" items={bk.voice.hooks} />
              <Chips k="开场" items={bk.voice.openers} />
              <Chips k="号召" items={bk.voice.ctas} />
              <Chips k="禁忌" items={bk.voice.taboos} />
            </Sec>
            <Sec title="视觉调性">
              <Chips k="关键词" items={bk.theme.keywords} />
              <Row k="主色" v={bk.theme.colorHint} />
              <Chips k="风格" items={bk.theme.styleRefs} />
            </Sec>
            <View className="bk-actions">
              {!bk.approved && <View className="bk-btn" onClick={approve}><Text>{busy === 'appr' ? '确认中…' : '确认无误'}</Text></View>}
              <View className="bk-btn ghost" onClick={generate}><Text>{busy === 'gen' ? '重生成中…' : '重新生成'}</Text></View>
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
