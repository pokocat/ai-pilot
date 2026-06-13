import { useEffect, useState } from 'react';
import { View, Text, Input } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { api } from '../../services/api';
import { IS_MOCK } from '../../services/config';
import { store } from '../../services/store';
import { useStore } from '../../hooks/useStore';
import './index.scss';

interface Props {
  open: boolean;
  // 登录成功回调：onboarded=该账号是否已建档
  onLoggedIn: (onboarded: boolean) => void;
}

// 小程序 server 模式优先微信登录；手机号 + fake 验证码保留为演示/兜底。
export default function Login({ open, onLoggedIn }: Props) {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(0); // 验证码倒计时
  const [loading, setLoading] = useState(false);
  const [wechatLoading, setWechatLoading] = useState(false);

  // 打开时隐藏底栏（复用 overlay 标志）
  useEffect(() => {
    store.setOverlay(open, 'login');
    return () => store.setOverlay(false, 'login');
  }, [open]);

  useEffect(() => {
    if (sent <= 0) return;
    const t = setTimeout(() => setSent((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [sent]);

  if (!open) return null;

  const phoneOk = /^1\d{10}$/.test(phone);
  const canWechatLogin = !IS_MOCK && process.env.TARO_ENV === 'weapp';

  const getWechatCode = () => new Promise<string>((resolve, reject) => {
    Taro.login({
      success: (res) => {
        if (res.code) resolve(res.code);
        else reject(new Error(res.errMsg || 'wx.login 未返回 code'));
      },
      fail: (err) => reject(new Error(err.errMsg || 'wx.login 失败')),
    });
  });

  const submitWechat = async () => {
    if (loading || wechatLoading) return;
    setWechatLoading(true);
    try {
      const wxCode = await getWechatCode();
      const r = await api.wechatLogin(wxCode);
      await store.afterLogin(r.token, r.onboarded, r.user.benmingColor);
      onLoggedIn(r.onboarded);
    } catch (e) {
      const err = e as Error & { data?: { code?: string } };
      const message = err?.data?.code === 'WECHAT_CONFIG_MISSING'
        ? '本地未配置微信登录，请用手机号演示登录'
        : err?.message || '微信登录失败';
      Taro.showToast({ title: message, icon: 'none' });
    } finally {
      setWechatLoading(false);
    }
  };

  const sendCode = () => {
    if (!phoneOk) { Taro.showToast({ title: '请输入正确手机号', icon: 'none' }); return; }
    setSent(60);
    setCode('888888'); // fake：直接回填演示验证码
    Taro.showToast({ title: '验证码已发送（演示：888888）', icon: 'none' });
  };

  const submit = async () => {
    if (!phoneOk) { Taro.showToast({ title: '请输入正确手机号', icon: 'none' }); return; }
    if (loading || wechatLoading) return;
    setLoading(true);
    try {
      let onboarded: boolean;
      try {
        // 在线：真实账号 + 数据隔离
        const r = await api.login(phone);
        await store.afterLogin(r.token, r.onboarded, r.user.benmingColor);
        onboarded = r.onboarded;
      } catch {
        // 后端不可达：离线 fake 登录，保证无后端也能进入（与全站离线兜底一致）
        onboarded = store.isOnboarded();
        await store.afterLogin(`local-${phone}`, onboarded);
      }
      onLoggedIn(onboarded);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View className="login">
      <View className="lg-card">
        <View className="lg-mk serif" style={{ background: accent }}>军</View>
        <Text className="lg-h serif">军师</Text>
        <Text className="lg-sub">AI 商业军师 · {canWechatLogin ? '微信账号登录' : '手机号登录'}</Text>

        {canWechatLogin && (
          <>
            <View className={`lg-wx ${wechatLoading ? 'off' : ''}`} onClick={submitWechat}>
              <Text>{wechatLoading ? '微信登录中…' : '微信账号登录'}</Text>
            </View>
            <View className="lg-sep"><Text>或使用手机号演示登录</Text></View>
          </>
        )}

        <View className="lg-field">
          <Text className="lg-pre">+86</Text>
          <Input
            className="lg-input"
            type="number"
            maxlength={11}
            value={phone}
            placeholder="请输入手机号"
            onInput={(e) => setPhone(e.detail.value)}
          />
        </View>

        <View className="lg-field">
          <Input
            className="lg-input"
            type="number"
            maxlength={6}
            value={code}
            placeholder="验证码"
            onInput={(e) => setCode(e.detail.value)}
          />
          <Text
            className={`lg-code ${sent > 0 ? 'off' : ''}`}
            style={sent > 0 ? {} : { color: accent }}
            onClick={() => sent <= 0 && sendCode()}
          >
            {sent > 0 ? `${sent}s` : '获取验证码'}
          </Text>
        </View>

        <View className={`lg-cta ${loading ? 'off' : ''}`} style={{ background: accent }} onClick={submit}>
          <Text>{loading ? '登录中…' : '登录 / 注册'}</Text>
        </View>
        <Text className="lg-tip">未注册的手机号将自动创建账号 · 数据相互隔离</Text>
      </View>
    </View>
  );
}
