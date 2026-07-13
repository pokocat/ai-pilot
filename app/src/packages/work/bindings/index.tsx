import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { DATA_BINDINGS } from '../../../data/operatingSystem';
import { navTo } from '../../../services/nav';
import './index.scss';

// 数据源绑定：让军师从真实经营事实出发。授权类数据源接入尚未上线（引导态），
// 财务与经营表可直接走资料库上传（真实能力）。
export default function Bindings() {
  const s = useStore();
  const accent = s.color().vars['--accent'];

  const tap = (id: string, status: string) => {
    if (id === 'finance' || status.includes('上传')) {
      navTo('/packages/work/knowledge/index');
      return;
    }
    Taro.showToast({ title: '数据源授权接入即将开放，可先上传相关资料', icon: 'none' });
  };

  return (
    <View className={`page bindings-page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="数据源绑定" onBack={() => Taro.navigateBack()} />
      <View className="pad" style={{ paddingTop: '12px' }}>
        <View className="db-hero card">
          <Text className="kicker">Data Context</Text>
          <Text className="h1">数据源绑定</Text>
          <Text className="db-p">军师会在对话中判断需要哪些数据。绑定后，增长、IP、经营复盘等军师能基于真实情况给判断、拆动作。</Text>
        </View>

        <View className="db-security card">
          <View className="db-lock" style={{ background: 'var(--accent-soft)' }}><Icon name="lock" size={18} color={accent} /></View>
          <View className="db-sec-b">
            <Text className="db-sec-t">数据只用于诊断与执行</Text>
            <Text className="db-sec-d">敏感资料可只以摘要入库；深度分析会明确提示额度消耗。</Text>
          </View>
        </View>

        {DATA_BINDINGS.map((b) => (
          <View key={b.id} className="binding card" onClick={() => tap(b.id, b.status)}>
            <View className="binding-ic" style={{ background: 'var(--accent-soft)' }}><Icon name={b.icon} size={18} color={accent} /></View>
            <View className="binding-b">
              <View className="binding-top">
                <Text className="binding-provider">{b.provider}</Text>
                <Text className="binding-price" style={{ color: accent }}>{b.price}</Text>
              </View>
              <Text className="binding-t">{b.title}</Text>
              <Text className="binding-d">{b.desc}</Text>
            </View>
            <View className="binding-btn" style={{ borderColor: accent }}>
              <Text style={{ color: accent }}>{b.status.includes('上传') ? '上传' : b.status}</Text>
            </View>
          </View>
        ))}

        <View
          className="db-action"
          style={{ background: accent }}
          onClick={() => navTo(`/packages/main/chat/index?agentKey=general&fresh=1&send=${encodeURIComponent('结合我的情况，判断我现在最应该先补充哪类数据或资料，按优先级排一下。')}`)}
        >
          <Icon name="spark" size={16} color="#FBFAF6" />
          <Text>让军师判断绑定优先级</Text>
        </View>
        <View style={{ height: '32px' }} />
      </View>
    </View>
  );
}
