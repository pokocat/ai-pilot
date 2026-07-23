import { useState } from 'react';
import { View, Text, Image } from '@tarojs/components';
import { shareReportImageToFriend, saveReportImageToAlbum } from '../../services/reportShareCard';
import './index.scss';

interface Props {
  /** 已生成的分享图临时路径 */
  path: string;
  /** 收起预览 */
  onClose: () => void;
}

// 分享图预览层（去黑盒）：出图后先给主公过目，再决定发好友 / 存相册。
// 全屏遮罩 + 直角案卷风图片（无圆角）+ 底部动作行。catchMove 防滚动穿透，z-index 高于两页现有浮层。
export default function SharePreview({ path, onClose }: Props) {
  const [busy, setBusy] = useState(false);

  const toFriend = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await shareReportImageToFriend(path);
      onClose();
    } catch { /* 失败已在 service 内提示，留在预览可长按保存 */ }
    finally { setBusy(false); }
  };
  const toAlbum = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await saveReportImageToAlbum(path);
      onClose();
    } catch { /* 未获权限已提示，留在预览 */ }
    finally { setBusy(false); }
  };

  return (
    <View className="sp-mask" onClick={onClose} catchMove>
      <View className="sp-panel" onClick={(e) => e.stopPropagation()}>
        <Image className="sp-img" src={path} mode="widthFix" />
        <Text className="sp-note">数字机密已自动隐去，可安心示人</Text>
        <View className="sp-acts">
          <View className="sp-btn primary" onClick={toFriend}><Text>发给好友</Text></View>
          <View className="sp-btn ghost" onClick={toAlbum}><Text>存入相册</Text></View>
          <View className="sp-btn text" onClick={onClose}><Text>收起</Text></View>
        </View>
      </View>
    </View>
  );
}
