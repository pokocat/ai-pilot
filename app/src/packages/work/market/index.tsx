import { useEffect, useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import AgentUnlock from '../../../components/AgentUnlock';
import { useStore } from '../../../hooks/useStore';
import { navTo } from '../../../services/nav';
import { api, type PrescriptionView, type Agent } from '../../../services/api';
import { MODULE_MARKET, SKILL_MARKET } from '../../../data/operatingSystem';
import './index.scss';

const CATS = ['全部', '战略目标', '执行拆解', 'IP 增长', '个人成长', '企业经营', '组织管理', '知识资产', '数据增强'];

// 模块市场 + Skill 市场：模块是军师方案的功能化承接，不是商品货架。
// 「启用」= 由对应军师在对话中承接（真实产出）；深度版随权益体系逐步开放。
export default function Market() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [cat, setCat] = useState('全部');
  const modules = cat === '全部' ? MODULE_MARKET : MODULE_MARKET.filter((m) => m.category === cat);

  // WO-12：处方落地——从军令处方条跳来（from=prescription&pid），展示开方上下文 + 记曝光/开通埋点。
  const pid = Taro.getCurrentInstance().router?.params?.pid || '';
  const [rx, setRx] = useState<PrescriptionView | null>(null);
  const [buying, setBuying] = useState<Agent | null>(null);
  useEffect(() => {
    if (!pid) return;
    api.prescriptions().then((r) => {
      const found = r.items.find((i) => i.id === pid) ?? null;
      setRx(found);
      if (found) api.prescriptionAction(pid, 'seen').catch(() => {});
    }).catch(() => {});
  }, [pid]);

  // 记为开通（模块/已拥有/未识别 agent 的兜底确认）。
  const ackRx = () => {
    if (!rx) return;
    api.prescriptionAction(rx.id, 'activated').catch(() => {});
    Taro.showToast({ title: '已记为开通', icon: 'success' });
    setTimeout(() => Taro.navigateBack(), 600);
  };
  // D-1/D-3-7：处方开通——若开的是可解锁专项军师且未拥有，走真实解锁弹层（带 source:'prescription'+refId=处方 id，
  // 用户在弹层内确认额度消耗）；否则按兜底记为开通。
  const activateRx = () => {
    if (!rx) return;
    const agent = s.agents().find((a) => a.key === rx.toolKey);
    if (agent && agent.billing === 'unlock' && !agent.owned) { setBuying(agent); return; }
    ackRx();
  };

  const goChat = (agentKey: string, prompt: string) =>
    navTo(`/packages/main/chat/index?agentKey=${agentKey}&fresh=1&send=${encodeURIComponent(prompt)}`);

  const tapModule = (m: typeof MODULE_MARKET[number]) => {
    if (m.id === 'knowledge-base') { navTo('/packages/work/knowledge/index'); return; }
    if (m.id === 'data-bindings') { navTo('/packages/work/bindings/index'); return; }
    if (m.agentKey && m.prompt) { goChat(m.agentKey, m.prompt); return; }
    Taro.showToast({ title: '该能力随方案认可后自动启用', icon: 'none' });
  };

  return (
    <View className={`page market-page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="能力市场" onBack={() => Taro.navigateBack()} />
      <View className="pad" style={{ paddingTop: '12px' }}>
        {rx && (
          <View className="card" style={{ padding: '16px', marginBottom: '12px', borderLeft: `3px solid ${accent}` }}>
            <Text style={{ display: 'block', fontSize: '12px', color: 'var(--ink-3)', marginBottom: '6px' }}>军师为「{rx.problem}」开出</Text>
            <Text style={{ display: 'block', fontSize: '15px', fontWeight: 600, color: 'var(--ink)', marginBottom: '12px' }}>{rx.playbook}</Text>
            <View style={{ height: '40px', borderRadius: '10px', background: accent, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={activateRx}>
              <Text style={{ color: '#fff', fontSize: '14px' }}>开通完成 · 回执行</Text>
            </View>
          </View>
        )}
        <View className="mm-hero card">
          <Text className="kicker">Junshi OS</Text>
          <Text className="h1">能力市场</Text>
          <Text className="mm-p">能力不是商品货架，而是军师方案的长期承接：基础能力直接用，深度能力按 💎 额度或方案权益启用。</Text>
          <View className="mm-legend">
            {['基础可用', '💎 按次产出', '方案权益', '已启用'].map((label) => (
              <Text key={label} className="mm-tag">{label}</Text>
            ))}
          </View>
        </View>

        <ScrollView scrollX className="cat-scroll" enhanced showScrollbar={false}>
          {CATS.map((c) => (
            <View key={c} className={`cat ${cat === c ? 'on' : ''}`} style={cat === c ? { background: accent } : {}} onClick={() => setCat(c)}>
              <Text>{c}</Text>
            </View>
          ))}
        </ScrollView>

        <View className="sec-head">
          <Text className="sec-title">方案能力</Text>
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
              {/* D6：无 agentKey 的模块点按仅提示、不真正启用 → 用「了解」语义，不做假「启用」按钮。 */}
              <Text style={{ color: accent }}>{m.status === '已启用' ? '使用' : (m.agentKey ? '启用' : '了解')}</Text>
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
          onClick={() => goChat('general', '根据我的情况，帮我判断现在最该启用哪些能力和锦囊，并说明先后顺序。')}
        >
          <Icon name="spark" size={16} color="#FBFAF6" />
          <Text>让总军师帮我编排能力</Text>
        </View>
        <View style={{ height: 'calc(32px + env(safe-area-inset-bottom))' }} />
      </View>

      {/* D-1：处方位/生态市场开通归因——处方落地传 prescription+refId；市场常规浏览传 market。 */}
      <AgentUnlock
        agent={buying}
        source={pid ? 'prescription' : 'market'}
        refId={pid || undefined}
        onClose={() => setBuying(null)}
        onUnlocked={() => {
          if (rx) api.prescriptionAction(rx.id, 'activated').catch(() => {});
          setBuying(null);
          Taro.showToast({ title: '已启用，回执行', icon: 'success' });
          setTimeout(() => Taro.navigateBack(), 600);
        }}
      />
    </View>
  );
}
