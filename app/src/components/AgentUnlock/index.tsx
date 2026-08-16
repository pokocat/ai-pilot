import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '../Icon';
import Sheet from '../Sheet';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api, type Agent, type ActivationSource } from '../../services/api';
import { paymentErrorMessage } from '../../services/paymentFeedback';
import './index.scss';

interface Props {
  agent: Agent | null;          // 待启用的专项智能体（billing=unlock）。null 则不展示
  onClose: () => void;
  onUnlocked: (agent: Agent) => void; // 启用成功（含已拥有）后回调，通常用于进入对话
  source?: ActivationSource;    // D-1 开通来源归因（缺省 catalog）
  refId?: string;               // source=prescription 时的处方 id
}

// 专项智能体启用弹层：确认即启用，不收费。free/metered 不会进入这里。
export default function AgentUnlock({ agent, onClose, onUnlocked, source = 'catalog', refId }: Props) {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [busy, setBusy] = useState(false);

  if (!agent) return null;

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.purchaseAgent(agent.key, { source, refId });
      await store.refreshAfterPurchase();
      Taro.showToast({ title: r.alreadyOwned ? '已启用' : '已加入工作台', icon: 'success' });
      const fresh = store.agents().find((a) => a.key === agent.key) ?? { ...agent, owned: true };
      onUnlocked(fresh);
    } catch (e) {
      if (s.handleApiError(e, { silent: true }) !== 'unauthorized') {
        Taro.showToast({ title: paymentErrorMessage(e, 'entitlement'), icon: 'none' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      visible={!!agent}
      onClose={onClose}
      overlayKey="agent-unlock"
      align="center"
      panelClassName="au-pad"
      footer={
        <View className="au-btns">
          <View className="btn btn-ghost au-btn ghost" onClick={onClose}><Text>暂不启用</Text></View>
          <View
            className={`btn btn-primary au-btn primary ${busy ? 'disabled' : ''}`}
            style={{ background: accent }}
            onClick={confirm}
          >
            <Text>{busy ? '启用中…' : '确认启用'}</Text>
          </View>
        </View>
      }
    >
      <View className="au-ic" style={{ background: 'var(--accent-soft)' }}>
        <Icon name={agent.icon} size={26} color={accent} />
      </View>
      <Text className="au-name">{agent.name}</Text>
      <Text className="au-role">{agent.role}</Text>
      {agent.deliverableKey && <Text className="au-deliver" style={{ color: accent }}>擅长 · {agent.deliverableKey}</Text>}

      <Text className="au-note">启用后会加入你的工作台，永久可用；对话与深度产出按你当前方案的额度另行计算。</Text>
    </Sheet>
  );
}
