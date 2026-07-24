import { useEffect, useState } from 'react';
import { View, Text, Textarea } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { api } from '../../services/api';
import { store } from '../../services/store';
import './index.scss';

interface Props {
  open: boolean;
  onClose: () => void;
  // 校验通过并已 store.afterLogin 落地后回调：由宿主决定后续路由
  //（登录页按 onboarded 分支；换身场景 reLaunch 回首页）。onboarded 已按 /me 或已建档兜底算好。
  onDone: (onboarded: boolean) => void;
}

// 附身登录注入弹层（运营排查，双端共用）：粘贴主公签发的短时令牌 → 先验后登。
// 关键坑：登录浮层 z-index=950（见 Login/index.scss），故本弹层用 960，确保能盖在登录页之上。
// 键盘遮挡：浮层贴底，随 onKeyboardHeightChange 抬高整卡（margin-bottom，非 transform；见 MEMORY 键盘避让）。
export default function ImpersonateSheet({ open, onClose, onDone }: Props) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [kbH, setKbH] = useState(0);

  // 借用全局 overlay 标志隐藏底栏（与其它弹层一致；Set 叠加，不影响已开的 login 标志）。
  useEffect(() => {
    store.setOverlay(open, 'impersonate');
    return () => store.setOverlay(false, 'impersonate');
  }, [open]);

  if (!open) return null;

  const close = () => {
    if (busy) return;
    setToken('');
    setKbH(0);
    onClose();
  };

  const submit = async () => {
    const t = token.trim();
    if (!t) { Taro.showToast({ title: '请先粘贴令牌', icon: 'none' }); return; }
    if (busy) return;
    setBusy(true);
    try {
      // 先用该 token 调一次 /me 验证有效（无效则抛错，不落 storage）。
      const me = await api.verifyImpersonation(t);
      // /me 带 onboarded 则照常传给 afterLogin；附身目标基本都已建档，缺该字段时按已建档处理，
      // 避免把已建档用户误导进入局仪式。
      const onboarded = typeof me.onboarded === 'boolean' ? me.onboarded : true;
      await store.afterLogin(t, onboarded, me.user.benmingColor);
      setToken('');
      setKbH(0);
      onClose();
      onDone(onboarded);
    } catch (e) {
      const err = e as Error & { code?: string };
      // 网络异常给出可辨识提示；其余（含 401）一律古风口吻的「令牌无效」。
      const title = err?.code === 'NETWORK_ERROR' ? (err.message || '网络不稳，稍后再试') : '令牌无效或已失效';
      Taro.showToast({ title, icon: 'none' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="imp-mask" catchMove onClick={close}>
      <View
        className="imp-card"
        style={kbH ? { marginBottom: `${kbH}px` } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <View className="imp-grip" />
        <Text className="imp-title serif">代主公巡视</Text>
        <Text className="imp-desc">粘贴主公签发的令牌，即以其身份入局排查。仅供巡视，用后即弃。</Text>
        <Textarea
          className="imp-input"
          value={token}
          placeholder="在此粘贴附身令牌"
          placeholderClass="imp-ph"
          maxlength={-1}
          adjustPosition={false}
          autoHeight
          onInput={(e) => setToken(e.detail.value)}
          onKeyboardHeightChange={(e) => setKbH(e.detail?.height || 0)}
        />
        <View className={`imp-cta ${busy ? 'off' : ''}`} onClick={submit}>
          <Text>{busy ? '验令中…' : '登入'}</Text>
        </View>
        <Text className="imp-cancel" onClick={close}>取消</Text>
      </View>
    </View>
  );
}
