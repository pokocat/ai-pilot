import { ReactNode } from 'react';
import { View, Text } from '@tarojs/components';
import './index.scss';

interface Props {
  /** 大字 tab 名（左侧主标题，用底栏同名） */
  title: string;
  /** 标题上方一行小字：这个 tab 是干什么的 */
  kicker: string;
  /** 压在标题区背景的单字（印章感） */
  glyph: string;
  /** 右侧文字入口（可选）。设计稿里的行业 tag 已去掉，这里只放本页真入口，用 `.th-act` */
  right?: ReactNode;
}

/**
 * 五个 tab 页共用标题区 —— 对齐设计稿 header：
 * 小字用途（本命色）+ 大字 tab 名 + 背景一枚大字 + 底部一条细线。
 * 安全区让位仍只由 `Screen topInset` 的 `.nav-inset` 负责（AGENTS.md §7.2）。
 */
export default function TabHeader({ title, kicker, glyph, right }: Props) {
  return (
    <View className="tab-head tab-page-head">
      <Text className="th-glyph serif">{glyph}</Text>
      <View className="th-row">
        <View className="th-titles">
          <Text className="th-kicker">{kicker}</Text>
          <Text className="th-title serif">{title}</Text>
        </View>
        {right ? <View className="th-acts">{right}</View> : null}
      </View>
      <View className="th-rule" />
    </View>
  );
}
