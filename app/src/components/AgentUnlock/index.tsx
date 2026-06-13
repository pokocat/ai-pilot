import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '../Icon';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api, type Agent } from '../../services/api';
import './index.scss';

interface Props {
  agent: Agent | null;          // 待解锁的智能体（billing=unlock）。null 则不展示
  onClose: () => void;
  onUnlocked: (agent: Agent) => void; // 解锁成功（含已拥有）后回调，通常用于进入对话
}

// 付费智能体解锁弹层：用算力次数解锁。free/metered 不会进入这里。
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
      Taro.showToast({ title: '算力不足，请先充值', icon: 'none' });
      return;
    }
    setBusy(true);
    try {
      const r = await api.purchaseAgent(agent.key);
      await store.refreshAfterPurchase();
      Taro.showToast({ title: r.alreadyOwned ? '已解锁' : '解锁成功', icon: 'success' });
      const fresh = store.agents().find((a) => a.key === agent.key) ?? { ...agent, owned: true };
      onUnlocked(fresh);
    } catch (e) {
      const code = (e as any)?.code || (e as any)?.data?.code;
      Taro.showToast({ title: code === 'INSUFFICIENT_CREDITS' ? '算力不足，请先充值' : '解锁失败，请重试', icon: 'none' });
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
        {agent.deliverableKey && <Text className="au-deliver" style={{ color: accent }}>产出 · {agent.deliverableKey}</Text>}

        <View className="au-price card">
          <View className="au-pl">
            <Text className="au-pk">解锁价格</Text>
            <Text className="au-pv serif" style={{ color: accent }}>{agent.price} <Text className="unit">算力</Text></Text>
          </View>
          <View className="au-divider" />
          <View className="au-pl">
            <Text className="au-pk">我的算力</Text>
            <Text className="au-bal" style={{ color: enough ? 'var(--ink-2)' : '#c0392b' }}>{unlimited ? '不限量' : `${balance} 次`}</Text>
          </View>
        </View>

        <Text className="au-note">解锁后永久可用，本智能体的深度产出仍按常规算力计费。</Text>

        {!enough && (
          <View className="au-low">
            <Icon name="alert" size={13} color="#c0392b" />
            <Text> 算力不足，请到「我的 · 套餐与算力」充值</Text>
          </View>
        )}

        <View className="au-btns">
          <View className="au-btn ghost" onClick={onClose}><Text>再想想</Text></View>
          <View
            className={`au-btn primary ${!enough || busy ? 'disabled' : ''}`}
            style={{ background: accent }}
            onClick={confirm}
          >
            <Icon name="crown" size={15} color="#fff" />
            <Text>{busy ? '解锁中…' : `用 ${agent.price} 算力解锁`}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}
