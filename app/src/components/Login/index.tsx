import { useEffect, useState } from 'react';
import { View, Text, Input, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { api } from '../../services/api';
import { store } from '../../services/store';
import { useStore } from '../../hooks/useStore';
import './index.scss';

interface Props {
  open: boolean;
  // 登录成功回调：onboarded=该账号是否已建档
  onLoggedIn: (onboarded: boolean) => void;
}

// 小程序 weapp：本机号一键登录（getPhoneNumber）为主，短信验证码为通用兜底，微信账号登录为补充。
export default function Login({ open, onLoggedIn }: Props) {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(0); // 验证码倒计时
  const [codeSending, setCodeSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [wechatLoading, setWechatLoading] = useState(false);
  const [onetapLoading, setOnetapLoading] = useState(false);

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
  const codeOk = /^\d{4,8}$/.test(code);
  const isWeapp = process.env.TARO_ENV === 'weapp';
  const busy = loading || wechatLoading || onetapLoading;

  const getWechatCode = () => new Promise<string>((resolve, reject) => {
    Taro.login({
      success: (res) => (res.code ? resolve(res.code) : reject(new Error(res.errMsg || 'wx.login 未返回 code'))),
      fail: (err) => reject(new Error(err.errMsg || 'wx.login 失败')),
    });
  });

  // 本机号一键登录：getPhoneNumber 返回一次性 code，后端换号建号；顺带带上 wx.login 的 code 关联 openid。
  const onGetPhone = async (e: { detail?: { code?: string; errMsg?: string } }) => {
    const detail = e?.detail || {};
    if (!detail.code) {
      if (!/deny|cancel|fail:?\s*用户/i.test(detail.errMsg || '')) {
        Taro.showToast({ title: '一键登录不可用，请用短信登录', icon: 'none' });
      }
      return;
    }
    if (busy) return;
    setOnetapLoading(true);
    try {
      let loginCode: string | undefined;
      try { loginCode = await getWechatCode(); } catch { /* 关联 openid 失败不阻断登录 */ }
      const r = await api.wechatPhoneLogin(detail.code, loginCode);
      await store.afterLogin(r.token, r.onboarded, r.user.benmingColor);
      onLoggedIn(r.onboarded);
    } catch (err) {
      Taro.showToast({ title: (err as Error)?.message || '一键登录失败', icon: 'none' });
    } finally {
      setOnetapLoading(false);
    }
  };

  const submitWechat = async () => {
    if (busy) return;
    setWechatLoading(true);
    try {
      const wxCode = await getWechatCode();
      const r = await api.wechatLogin(wxCode);
      await store.afterLogin(r.token, r.onboarded, r.user.benmingColor);
      onLoggedIn(r.onboarded);
    } catch (e) {
      const err = e as Error & { data?: { code?: string } };
      const message = err?.data?.code === 'WECHAT_CONFIG_MISSING'
        ? '本地未配置微信登录，请用手机号登录'
        : err?.message || '微信登录失败';
      Taro.showToast({ title: message, icon: 'none' });
    } finally {
      setWechatLoading(false);
    }
  };

  const sendCode = async () => {
    if (!phoneOk) { Taro.showToast({ title: '请输入正确手机号', icon: 'none' }); return; }
    if (sent > 0 || codeSending) return;
    setCodeSending(true);
    try {
      const r = await api.sendSmsCode(phone);
      setSent(r.cooldownSec || 60);
      if (r.devCode) { setCode(r.devCode); Taro.showToast({ title: `演示验证码已填入：${r.devCode}`, icon: 'none' }); }
      else Taro.showToast({ title: '验证码已发送', icon: 'none' });
    } catch (e) {
      Taro.showToast({ title: (e as Error)?.message || '验证码发送失败，请稍后再试', icon: 'none' });
    } finally {
      setCodeSending(false);
    }
  };

  const submit = async () => {
    if (!phoneOk) { Taro.showToast({ title: '请输入正确手机号', icon: 'none' }); return; }
    if (!codeOk) { Taro.showToast({ title: '请输入短信验证码', icon: 'none' }); return; }
    if (busy) return;
    setLoading(true);
    try {
      const r = await api.login(phone, undefined, code);
      await store.afterLogin(r.token, r.onboarded, r.user.benmingColor);
      onLoggedIn(r.onboarded);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === 'NETWORK_ERROR') {
        // 后端不可达：离线兜底，保证无后端也能进入（与全站离线兜底一致）
        const onboarded = store.isOnboarded();
        await store.afterLogin(`local-${phone}`, onboarded);
        onLoggedIn(onboarded);
      } else {
        Taro.showToast({ title: err?.message || '登录失败，请重试', icon: 'none' });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <View className="login">
      <View className="lg-card">
        <View className="lg-mk serif" style={{ background: accent }}>军</View>
        <Text className="lg-h serif">军师</Text>
        <Text className="lg-sub">AI 商业军师 · {isWeapp ? '本机号一键登录' : '手机号登录'}</Text>

        {isWeapp && (
          <>
            <Button
              className={`lg-onetap ${onetapLoading ? 'off' : ''}`}
              style={{ background: accent }}
              openType="getPhoneNumber"
              onGetPhoneNumber={onGetPhone}
            >
              {onetapLoading ? '登录中…' : '本机号码一键登录'}
            </Button>
            <Text className="lg-wx-link" onClick={submitWechat}>
              {wechatLoading ? '微信登录中…' : '用微信账号登录'}
            </Text>
            <View className="lg-sep"><Text>或用短信验证码登录</Text></View>
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
            className={`lg-code ${sent > 0 || codeSending ? 'off' : ''}`}
            style={sent > 0 || codeSending ? {} : { color: accent }}
            onClick={sendCode}
          >
            {sent > 0 ? `${sent}s` : codeSending ? '发送中…' : '获取验证码'}
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
