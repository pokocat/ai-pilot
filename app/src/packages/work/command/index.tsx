import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { ordersOf, refreshDossier, type Dossier, type DossierOrder } from '../../../services/dossier';
import type { OrderActionType } from '../../../services/api';
import './index.scss';

// V7-05 军令详情屏（对齐设计稿 §5.4 commandDetailHtml）：
// 头部（第 N 号军令 · 截止 / 标题 / 负责人·耗时）+ 来源引用 + 准备/处理/回写三步 + 指标三格 + 下一步动作卡。
// 数据来自服务端案卷军令的结构化字段（缺省不渲染），主令内容全部为真实成果，不预置结论。

// 三步固定角色标签（steps[0/1/2] → 准备/处理/回写）。
const STEP_ROLES = ['准备', '处理', '回写'];

// 下一步动作卡文案（按 actionType 派生 label/hint；DossierOrder 只带 actionType）。
const ACTION_LABEL: Record<OrderActionType, string> = {
  upload: '去智库上传',
  backfill: '回填面板',
  review: '发起复盘',
  topics: '智库能力',
  none: '去执行',
};
const ACTION_HINT: Record<OrderActionType, string> = {
  upload: '上传后进入智库待整理区，再回写到军师判断。',
  backfill: '记录线索、咨询、成交，提交后进入今日复盘。',
  review: '填入完成数据，生成今日复盘并校准明日军令。',
  topics: '进入能力页调用对应军师，把军令落到工具。',
  none: '按步骤推进这条军令，完成后回执行页打卡。',
};

export default function Command() {
  const router = useRouter();
  const s = useStore();
  const id = (router.params as Record<string, string>).id || '';
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [order, setOrder] = useState<DossierOrder | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!id) { setFailed(true); return; }
    setFailed(false);
    refreshDossier()
      .then((d) => {
        setDossier(d);
        const found = d?.orders.find((o) => o.id === id) || null;
        setOrder(found);
        if (!found) setFailed(true);
      })
      .catch((e) => { s.handleApiError(e); setFailed(true); });
  }, [id]);

  if (!order) {
    return (
      <View className={`page command-page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
        <SafeHeader title="军令详情" onBack={() => Taro.navigateBack()} />
        <View className="cmd-loading">
          <Text>{failed ? '军令加载失败，请返回重试' : '加载中…'}</Text>
        </View>
      </View>
    );
  }

  // 第 N 号军令：取该军令在当天军令中的 1-based 序位。
  const no = Math.max(1, ordersOf(dossier, order.date).findIndex((o) => o.id === order.id) + 1);
  const actionType: OrderActionType = order.actionType || 'none';
  const steps = (order.steps ?? []).slice(0, 3);
  const metrics = order.metrics ?? [];
  // 头部 desc：负责人 / 预计耗时（截止已在 kicker，避免重复）。
  const headMeta = [
    order.ownerName ? `负责人 ${order.ownerName}` : '',
    order.etaMinutes != null ? `预计 ${order.etaMinutes} 分钟` : '',
  ].filter(Boolean).join(' · ');

  // 去执行此军令：upload/topics 去智库承接，其余回执行页打卡。
  const runAction = () => {
    if (actionType === 'upload' || actionType === 'topics') Taro.switchTab({ url: '/pages/thinktank/index' });
    else Taro.navigateBack();
  };

  return (
    <View className={`page command-page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title={`第 ${no} 号军令`} onBack={() => Taro.navigateBack()} />

      <View className="pad">
        <View className="command-detail">
          {/* 头部：第 N 号军令 · 截止 / 标题 / 负责人·耗时 */}
          <View className="command-detail-head">
            <Text className="cd-kicker">{order.dueAt ? `第 ${no} 号军令 · ${order.dueAt}` : `第 ${no} 号军令`}</Text>
            <Text className="cd-title serif">{order.text}</Text>
            {headMeta ? <Text className="cd-desc">{headMeta}</Text> : null}
          </View>

          {/* 来源引用（3px 绿左边框） */}
          {order.sourceQuote ? <Text className="command-source">{order.sourceQuote}</Text> : null}

          {/* 准备 / 处理 / 回写 三步 */}
          {steps.length ? (
            <View className="command-step-list">
              {steps.map((step, i) => (
                <View key={i} className="command-step">
                  <View className="cs-no"><Text>{i + 1}</Text></View>
                  <View className="cs-body">
                    <Text className="cs-role">{STEP_ROLES[i] || `步骤 ${i + 1}`}</Text>
                    <Text className="cs-text">{step}</Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          {/* 指标三格 */}
          {metrics.length ? (
            <View className="command-metrics">
              {metrics.map((m, i) => (
                <View key={i} className="cm-cell">
                  <Text className="cm-v serif">{m.value}</Text>
                  <Text className="cm-l">{m.label}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {/* 下一步动作卡（按 actionType 派生） */}
          <View className="command-action-card" onClick={runAction}>
            <Text className="ca-tag">下一步</Text>
            <Text className="ca-label">{ACTION_LABEL[actionType]}</Text>
            <Text className="ca-hint">{ACTION_HINT[actionType]}</Text>
          </View>

          {/* 主行动 */}
          <View className="command-cta" onClick={runAction}>
            <Icon name="check" size={16} color="#FBFAF6" />
            <Text>去执行此军令</Text>
          </View>
        </View>
      </View>
      <View style={{ height: '24px' }} />
    </View>
  );
}
