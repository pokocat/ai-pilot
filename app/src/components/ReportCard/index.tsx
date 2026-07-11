import { useEffect, useRef, useState } from 'react';
import { View, Text, Canvas } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '../Icon';
import MarkdownText from '../MarkdownText';
import { useStore } from '../../hooks/useStore';
import type { Deliverable } from '../../services/api';
import { makeReportShareImage, presentReportShareImage } from '../../services/reportShareCard';
import './index.scss';

const IS_WEAPP = process.env.TARO_ENV === 'weapp';
let shareSeq = 0;

interface Props {
  data: Deliverable;
  animate?: boolean; // 渐进式呈现（新产出）vs 直接展示（历史还原）
  streaming?: boolean; // 服务端 SSE 仍在产出中：展示当前已到达分段，暂不开放操作
  saved?: boolean;
  onSave?: () => void;
  onExport?: () => void;
  onShare?: () => void; // 「网页版」：生成自有域名网页版并打开 web-view（本人自用查看）
}

// 结构化成果卡 —— 对齐原型 renderReport：骨架 → 分段渐显 → 可信赖页脚 + 操作。
export default function ReportCard({ data, animate = false, streaming = false, saved = false, onSave, onExport, onShare }: Props) {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  // D-3-4：每张卡一块隐藏 canvas，用于「分享图」出图（唯一 id 防列表内串扰）。
  const shareCanvasId = useRef(`rcshare-${(shareSeq += 1)}`).current;

  // D-3-4：对外分享 = 生成品牌分享图（标题+核心结论+落款，无全文/敏感数字）→ 发好友/存相册。
  const shareImage = async () => {
    if (!IS_WEAPP) { Taro.showToast({ title: '请在小程序内生成分享图', icon: 'none' }); return; }
    Taro.showLoading({ title: '生成分享图…' });
    try {
      const path = await makeReportShareImage(shareCanvasId, data);
      Taro.hideLoading();
      presentReportShareImage(path);
    } catch {
      Taro.hideLoading();
      Taro.showToast({ title: '生成分享图失败，请重试', icon: 'none' });
    }
  };
  const [revealed, setRevealed] = useState(animate ? 0 : data.sections.length);
  const [done, setDone] = useState(!animate);
  const [isSaved, setIsSaved] = useState(saved);
  const shown = streaming ? data.sections.length : revealed;
  const isDone = !streaming && done;

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
        {isDone ? (
          <Text className="status">已生成</Text>
        ) : (
          <View className="gen">
            <View className="spin" style={{ borderTopColor: accent }} />
            <Text>产出中</Text>
          </View>
        )}
      </View>

      <View className="rb">
        {shown === 0 && (
          <View className="skeleton">
            <View className="skl h" />
            <View className="skl w90" />
            <View className="skl w70" />
            <View className="skl w50" />
          </View>
        )}
        {data.sections.slice(0, shown).map((sec, i) => (
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

      {isDone && (
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
            <View className="act ghost" onClick={shareImage}>
              <Icon name="image" size={14} color="#565C63" />
              <Text>分享图</Text>
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
          {/* D-3-4 隐藏出图画布（屏外，仅点分享图时绘制导出） */}
          <Canvas type="2d" id={shareCanvasId} className="rc-share-canvas" style={{ width: '600px', height: '900px' }} />
        </>
      )}
    </View>
  );
}
