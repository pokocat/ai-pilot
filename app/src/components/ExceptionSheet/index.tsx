import { View, Text } from '@tarojs/components';
import Sheet from '../Sheet';
import { useStore } from '../../hooks/useStore';
import './index.scss';

export interface ExceptionSheetProps {
  open: boolean;
  kind?: 'upload' | 'power' | 'sku';
  title?: string;
  desc?: string;
  skuKey?: string;
  onPrimary?: () => void;
  onClose?: () => void;
}

interface KindMeta { kicker: string; next: string; primary: string; }
// 设计规格 §3：红色 kicker + 「下一步」四格首格 + 主按钮，按 kind 分派。
const KIND_META: Record<NonNullable<ExceptionSheetProps['kind']>, KindMeta> = {
  upload: { kicker: 'UPLOAD BLOCKED', next: '换格式或压缩后重传', primary: '重新选择资料' },
  power: { kicker: 'POWER NOT ENOUGH', next: '购买算力或改用免费能力', primary: '去购买算力' },
  sku: { kicker: 'PAYMENT REQUIRED', next: '改用微信支付完成本次开通', primary: '改用微信支付' },
};

// V7-03 ExceptionSheet：异常屏（上传失败 / 算力不足 / SKU 备选），红色 hero + 统一四格 + 主按钮。
// onPrimary 由调用方自持（upload=重开文件选择 / power=去能力页 / sku=改用微信支付）。
export default function ExceptionSheet({ open, kind = 'upload', title, desc, onPrimary, onClose }: ExceptionSheetProps) {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const meta = KIND_META[kind] || KIND_META.upload;

  return (
    <Sheet
      visible={open}
      onClose={onClose}
      overlayKey="exceptionsheet"
      footer={
        <View className="exception-actions">
          <View className="btn btn-ghost ex-secondary" onClick={onClose}><Text>返回</Text></View>
          <View className="btn btn-primary ex-primary" style={{ background: accent }} onClick={() => onPrimary?.()}><Text>{meta.primary}</Text></View>
        </View>
      }
    >
      <View className="exception-hero">
        <Text className="ex-kicker">{meta.kicker}</Text>
        <Text className="ex-title serif">{title || '需要处理一下'}</Text>
        {!!desc && <Text className="ex-desc">{desc}</Text>}
      </View>

      <View className="detail-mini-grid">
        <View className="dm-cell"><Text className="dm-k">下一步</Text><Text className="dm-v">{meta.next}</Text></View>
        <View className="dm-cell"><Text className="dm-k">保留状态</Text><Text className="dm-v">当前案卷不会丢失</Text></View>
        <View className="dm-cell"><Text className="dm-k">服务老师</Text><Text className="dm-v">可协助确认</Text></View>
        <View className="dm-cell"><Text className="dm-k">记录</Text><Text className="dm-v">不会直接扣费</Text></View>
      </View>
    </Sheet>
  );
}
