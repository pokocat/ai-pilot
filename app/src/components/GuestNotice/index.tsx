import { View, Text } from '@tarojs/components';
import Icon from '../Icon';
import './index.scss';

interface Props {
  title: string;
  desc: string;
  action?: string;
  onAction: () => void;
  compact?: boolean;
}

export default function GuestNotice({ title, desc, action = '登录', onAction, compact = false }: Props) {
  return (
    <View className={`guest-notice card ${compact ? 'is-compact' : ''}`}>
      <View className="guest-notice-icon"><Icon name="user" size={17} color="var(--accent)" /></View>
      <View className="guest-notice-body">
        <Text className="guest-notice-title serif">{title}</Text>
        <Text className="guest-notice-desc">{desc}</Text>
      </View>
      <View className="guest-notice-action" onClick={onAction}><Text>{action}</Text></View>
    </View>
  );
}
