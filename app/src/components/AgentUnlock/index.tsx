import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '../Icon';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api, type Agent } from '../../services/api';
import './index.scss';

interface Props {
  agent: Agent | null;          // 待启用的专项智能体（billing=unlock）。null 则不展示
  onClose: () => void;
  onUnlocked: (agent: Agent) => void; // 启用成功（含已拥有）后回调，通常用于进入对话
}

// 专项智能体启用弹层：用产出额度启用。free/metered 不会进入这里。
export default function AgentUnlock({ agent, onClose, onUnlocked }: Props) {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    store.setOverlay(!!agent, 'agent-unlock');
    return () => store.setOverlay(false, 'agent-unlock');
  }, [agent]);

  if (!agent) return null;
  const balance = s.me()?.creditBalance ?? 0;
  const unlimited = balance < 0;
  const enough = unlimited || balance >= agent.price;

  const confirm = async () => {
    if (busy) return;
    if (!enough) {
      Taro.showToast({ title: '产出额度不足，请先调整方案', icon: 'none' });
      return;
    }
    setBusy(true);
    try {
      const r = await api.purchaseAgent(agent.key);
      await store.refreshAfterPurchase();
      Taro.showToast({ title: r.alreadyOwned ? '已启用' : '已加入工作台', icon: 'success' });
      const fresh = store.agents().find((a) => a.key === agent.key) ?? { ...agent, owned: true };
      onUnlocked(fresh);
    } catch (e) {
      const code = (e as any)?.code || (e as any)?.data?.code;
      if (code === 'INSUFFICIENT_CREDITS') {
        Taro.showToast({ title: '产出额度不足，请先调整方案', icon: 'none' });
      } else {
        s.handleApiError(e, { fallbackTitle: '启用失败，请重试' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="agent-unlock-mask" onClick={onClose} catchMove>
      <View className="au-sheet" onClick={(e) => e.stopPropagation()}>
        <View className="au-grip" />
        <View className="au-ic" style={{ background: 'var(--accent-soft)' }}>
          <Icon name={agent.icon} size={26} color={accent} />
        </View>
        <Text className="au-name">{agent.name}</Text>
        <Text className="au-role">{agent.role}</Text>
        {agent.deliverableKey && <Text className="au-deliver" style={{ color: accent }}>擅长 · {agent.deliverableKey}</Text>}

        <View className="au-price card">
          <View className="au-pl">
            <Text className="au-pk">启用所需额度</Text>
            <Text className="au-pv serif" style={{ color: accent }}>{agent.price} <Text className="unit">次</Text></Text>
          </View>
          <View className="au-divider" />
          <View className="au-pl">
            <Text className="au-pk">当前额度</Text>
            <Text className="au-bal" style={{ color: enough ? 'var(--ink-2)' : '#c0392b' }}>{unlimited ? '不限量' : `${balance} 次`}</Text>
          </View>
        </View>

        <Text className="au-note">启用后会加入你的工作台；后续深度产出按当前方案消耗额度。</Text>

        {!enough && (
          <View className="au-low">
            <Icon name="alert" size={13} color="#c0392b" />
            <Text> 当前额度不足，请到「我的 · 方案与额度」调整</Text>
          </View>
        )}

        <View className="au-btns">
          <View className="au-btn ghost" onClick={onClose}><Text>暂不启用</Text></View>
          <View
            className={`au-btn primary ${!enough || busy ? 'disabled' : ''}`}
            style={{ background: accent }}
            onClick={confirm}
          >
            <Icon name="crown" size={15} color="#fff" />
            <Text>{busy ? '启用中…' : `用 ${agent.price} 次额度启用`}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}
