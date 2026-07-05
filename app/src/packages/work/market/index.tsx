import { useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { MODULE_MARKET, SKILL_MARKET } from '../../../data/operatingSystem';
import './index.scss';

const CATS = ['全部', '战略目标', '执行拆解', 'IP 增长', '个人成长', '企业经营', '组织管理', '知识资产', '数据增强'];

// 能力落地页（WO-02：不再从 tab/菜单进入，仅作军师处方跳转的落地页）。
// 处方跳转带 query `from=prescription&pid=xxx`（WO-12 预留）时，顶部显示来源上下文。
export default function Market() {
  const router = useRouter();
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [cat, setCat] = useState('全部');
  const fromPrescription = (router.params as Record<string, string>).from === 'prescription';
  const modules = cat === '全部' ? MODULE_MARKET : MODULE_MARKET.filter((m) => m.category === cat);

  const goChat = (agentKey: string, prompt: string) =>
    Taro.navigateTo({ url: `/pages/chat/index?agentKey=${agentKey}&fresh=1&send=${encodeURIComponent(prompt)}` });

  const tapModule = (m: typeof MODULE_MARKET[number]) => {
    if (m.id === 'knowledge-base') { Taro.navigateTo({ url: '/packages/work/knowledge/index' }); return; }
    if (m.id === 'data-bindings') { Taro.navigateTo({ url: '/packages/work/bindings/index' }); return; }
    if (m.agentKey && m.prompt) { goChat(m.agentKey, m.prompt); return; }
    Taro.showToast({ title: '该模块随方案认可后自动启用', icon: 'none' });
  };

  return (
    <View className={`page market-page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="军师开出的能力" onBack={() => Taro.navigateBack()} />
      <View className="pad" style={{ paddingTop: '12px' }}>
        {fromPrescription ? (
          <View className="mm-hero card" style={{ borderColor: accent }}>
            <Text className="kicker" style={{ color: accent }}>军师处方</Text>
            <Text className="h1">军师为你开出的能力</Text>
            <Text className="mm-p">这是军师在你的方案 / 军令里点名承接的能力。开通后回到军令卡即可继续执行。</Text>
          </View>
        ) : (
        <View className="mm-hero card">
          <Text className="kicker">Junshi OS</Text>
          <Text className="h1">能力承接</Text>
          <Text className="mm-p">能力不是商品货架，而是军师方案的长期承接：基础能力直接用，深度能力按 💎 额度或方案权益启用。</Text>
          <View className="mm-legend">
            {['基础可用', '💎 按次产出', '方案权益', '已启用'].map((label) => (
              <Text key={label} className="mm-tag">{label}</Text>
            ))}
          </View>
        </View>
        )}

        <ScrollView scrollX className="cat-scroll" enhanced showScrollbar={false}>
          {CATS.map((c) => (
            <View key={c} className={`cat ${cat === c ? 'on' : ''}`} style={cat === c ? { background: accent } : {}} onClick={() => setCat(c)}>
              <Text>{c}</Text>
            </View>
          ))}
        </ScrollView>

        <View className="sec-head">
          <Text className="sec-title">方案模块</Text>
          <Text className="sec-more">启用后由对应军师承接</Text>
        </View>
        {modules.map((m) => (
          <View key={m.id} className="module-card card" onClick={() => tapModule(m)}>
            <View className="module-ic" style={{ background: 'var(--accent-soft)' }}>
              <Icon name={m.icon} size={18} color={accent} />
            </View>
            <View className="module-b">
              <View className="module-top">
                <Text className="module-cat" style={{ color: accent }}>{m.category}</Text>
                <Text className={`module-tier tier-${m.tier}`}>{m.price}</Text>
              </View>
              <Text className="module-t">{m.title}</Text>
              <Text className="module-d">{m.desc}</Text>
              <View className="module-foot">
                <Text>{m.placement}</Text>
                <Text>{m.depth}</Text>
              </View>
            </View>
            <View className="module-btn" style={{ borderColor: accent }}>
              <Text style={{ color: accent }}>{m.status === '已启用' ? '使用' : '启用'}</Text>
            </View>
          </View>
        ))}

        <View className="sec-head">
          <Text className="sec-title">锦囊市场</Text>
          <Text className="sec-more">军师调用的方法能力包</Text>
        </View>
        <View className="skill-grid">
          {SKILL_MARKET.map((sk) => (
            <View key={sk.id} className="skill-card card" onClick={() => goChat('general', sk.prompt)}>
              <View className="skill-head">
                <View className="skill-ic" style={{ background: 'var(--accent-soft)' }}><Icon name={sk.icon} size={16} color={accent} /></View>
                <Text className={`module-tier tier-${sk.tier}`}>{sk.cost}</Text>
              </View>
              <Text className="skill-t">{sk.title}</Text>
              <Text className="skill-d">{sk.desc}</Text>
              <Text className="skill-s" style={{ color: accent }}>{sk.status}</Text>
            </View>
          ))}
        </View>

        <View
          className="mm-action"
          style={{ background: accent }}
          onClick={() => goChat('general', '根据我的情况，帮我判断现在最该启用哪些模块和锦囊，并说明先后顺序。')}
        >
          <Icon name="spark" size={16} color="#FBFAF6" />
          <Text>让总军师帮我编排模块</Text>
        </View>
        <View style={{ height: '32px' }} />
      </View>
    </View>
  );
}
