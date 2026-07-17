import { View, Text } from '@tarojs/components';
import Watermark from './Watermark';

// 直角案卷页头 —— 对齐原型 APP header：右侧水印巨字 + 题眉 kicker + 30px 标题 + 行业 tag pill + 底 hairline。
// Phase 2 各 tab 页统一用它：<ProtoHeader kicker="有事问军师" title="问策" watermark="谋" tag="咖啡" />

interface ProtoHeaderProps {
  kicker: string;     // 题眉小字
  title: string;      // 30px 主标题
  watermark: string;  // 右侧水印单字
  tag?: string;       // 右侧行业 tag pill（可选）
  className?: string;
}

export default function ProtoHeader({ kicker, title, watermark, tag, className = '' }: ProtoHeaderProps) {
  return (
    <View className={`proto-header ${className}`} style={{ position: 'relative' }}>
      <Watermark char={watermark} size={130} opacity={0.06} top={-6} right={-4} />
      <View style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', position: 'relative' }}>
        <View>
          <Text className="proto-kicker" style={{ marginBottom: '5px' }}>{kicker}</Text>
          <Text style={{ display: 'block', fontFamily: 'var(--serif)', fontSize: '30px', fontWeight: 600, letterSpacing: '.03em', color: 'var(--tx)' }}>
            {title}
          </Text>
        </View>
        {tag ? (
          <View style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--mut)', border: '1px solid var(--hair-2)', padding: '6px 12px', borderRadius: '2px' }}>
            <View style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--ac)' }} />
            <Text>{tag}</Text>
          </View>
        ) : null}
      </View>
      <View className="proto-hairline" style={{ marginTop: '16px' }} />
    </View>
  );
}
