import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Icon from '../Icon';
import MarkdownText from '../MarkdownText';
import { useStore } from '../../hooks/useStore';
import type { Deliverable } from '../../services/api';
import './index.scss';

interface Props {
  data: Deliverable;
  animate?: boolean; // 渐进式呈现（新产出）vs 直接展示（历史还原）
  saved?: boolean;
  onSave?: () => void;
  onExport?: () => void;
  onShare?: () => void; // 生成网页版（OSS 托管）并复制分享链接
}

// 结构化成果卡 —— 对齐原型 renderReport：骨架 → 分段渐显 → 可信赖页脚 + 操作。
export default function ReportCard({ data, animate = false, saved = false, onSave, onExport, onShare }: Props) {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [revealed, setRevealed] = useState(animate ? 0 : data.sections.length);
  const [done, setDone] = useState(!animate);
  const [isSaved, setIsSaved] = useState(saved);

  useEffect(() => {
    if (!animate) return;
    let i = 0;
    const timers: any[] = [];
    const tick = () => {
      i += 1;
      setRevealed(i);
      if (i < data.sections.length) {
        timers.push(setTimeout(tick, 640));
      } else {
        timers.push(setTimeout(() => setDone(true), 360));
      }
    };
    timers.push(setTimeout(tick, 900));
    return () => timers.forEach(clearTimeout);
  }, [animate, data.sections.length]);

  return (
    <View className="report">
      <View className="rh">
        <View className="ic-wrap" style={{ background: 'var(--accent-soft)' }}>
          <Icon name={data.icon} size={18} color={accent} />
        </View>
        <View className="tt">
          <Text className="t">{data.title}</Text>
          <Text className="m">{data.meta}</Text>
        </View>
        {done ? (
          <Text className="status">已生成</Text>
        ) : (
          <View className="gen">
            <View className="spin" style={{ borderTopColor: accent }} />
            <Text>产出中</Text>
          </View>
        )}
      </View>

      <View className="rb">
        {revealed === 0 && (
          <View className="skeleton">
            <View className="skl h" />
            <View className="skl w90" />
            <View className="skl w70" />
            <View className="skl w50" />
          </View>
        )}
        {data.sections.slice(0, revealed).map((sec, i) => (
          <View key={i} className="rsec reveal">
            <View className="sh">
              <Text className="no" style={{ background: accent }}>{i + 1}</Text>
              <Text className="sh-t">{sec.h}</Text>
            </View>
            {sec.b && <MarkdownText text={sec.b} className="sb" />}
            {sec.list && (
              <View className="slist">
                {sec.list.map((x, j) => (
                  <View key={j} className="sli">
                    <View className="dot" style={{ background: accent }} />
                    <MarkdownText text={x} className="sli-t" />
                  </View>
                ))}
              </View>
            )}
          </View>
        ))}
      </View>

      {done && (
        <>
          <View className="foot">
            <Icon name="shield" size={13} color="#969BA1" />
            <Text className="foot-t">{data.trust}</Text>
          </View>
          <View className="acts">
            <View
              className={`act ${isSaved ? 'saved' : 'primary'}`}
              style={isSaved ? {} : { background: accent }}
              onClick={() => {
                if (isSaved) return;
                setIsSaved(true);
                onSave?.();
              }}
            >
              <Icon name={isSaved ? 'check' : 'layers'} size={14} color={isSaved ? accent : '#fff'} />
              <Text>{isSaved ? '已存入方案库' : '存入方案库'}</Text>
            </View>
            {onShare && (
              <View className="act ghost" onClick={() => onShare()}>
                <Icon name="up" size={14} color="#565C63" />
                <Text>网页版</Text>
              </View>
            )}
            <View className="act ghost" onClick={() => onExport?.()}>
              <Icon name="doc" size={14} color="#565C63" />
              <Text>复制全文</Text>
            </View>
          </View>
        </>
      )}
    </View>
  );
}
