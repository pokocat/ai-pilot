import { useEffect, useState, type CSSProperties } from 'react';
import { View, Text, Input, Image } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { api } from '../../services/api';
import { authReasonText, type AuthReason } from '../../services/authGate';
import Icon from '../Icon';
import logo from '../../assets/logo.png';
import { store } from '../../services/store';
import './index.scss';

interface Props {
  open: boolean;
  reason?: AuthReason;
  onClose: () => void;
  // 登录成功回调：onboarded=该账号是否已建档。手机号、称呼和建档均不再阻塞登录完成。
  onLoggedIn: (onboarded: boolean) => void;
}

type Stage = 'wechat' | 'phone';
type LoginChromeStyle = CSSProperties & {
  '--lg-close-top'?: string;
  '--lg-close-right'?: string;
};

const phoneRe = /^1\d{10}$/;
const codeRe = /^\d{4,8}$/;

// 登录只负责建立账号身份。手机号登录是用户主动选择的替代方式；绑定手机、头像、称呼与建档都在登录后自愿完成。
export default function Login({ open, reason, onClose, onLoggedIn }: Props) {
  const [stage, setStage] = useState<Stage>('wechat');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(0);
  const [codeSending, setCodeSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [wechatLoading, setWechatLoading] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [chromeStyle, setChromeStyle] = useState<LoginChromeStyle>();

  useEffect(() => {
    store.setOverlay(open, 'login');
    if (open) setStage('wechat');
    return () => store.setOverlay(false, 'login');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    try {
      const rect = Taro.getMenuButtonBoundingClientRect?.();
      const win = Taro.getWindowInfo?.();
      if (!rect?.left || !rect?.top || !win?.windowWidth) return;
      const buttonSize = 36;
      const top = Math.max(rect.top + ((rect.height || 32) - buttonSize) / 2, (win.statusBarHeight || 0) + 2);
      const right = Math.max(win.windowWidth - rect.left + 12, 18);
      setChromeStyle({
        '--lg-close-top': `${top}px`,
        '--lg-close-right': `${right}px`,
      });
    } catch {
      // H5 与旧基础库没有微信胶囊，继续使用 CSS safe-area 兜底。
    }
  }, [open]);

  useEffect(() => {
    if (sent <= 0) return;
    const timer = setTimeout(() => setSent((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [sent]);

  if (!open) return null;

  const phoneOk = phoneRe.test(phone);
  const codeOk = codeRe.test(code);
  const busy = loading || wechatLoading;

  const openDoc = (doc: 'agreement' | 'privacy') =>
    Taro.navigateTo({ url: `/packages/main/legal/index?doc=${doc}` });

  const ensureAgreed = (): boolean => {
    if (agreed) return true;
    Taro.showToast({ title: '请先阅读并勾选同意《用户协议》与《隐私政策》', icon: 'none' });
    return false;
  };

  const getWechatCode = () => new Promise<string>((resolve, reject) => {
    Taro.login({
      success: (res) => (res.code ? resolve(res.code) : reject(new Error(res.errMsg || 'wx.login 未返回 code'))),
      fail: (err) => reject(new Error(err.errMsg || 'wx.login 失败')),
    });
  });

  const submitWechat = async () => {
    if (busy || !ensureAgreed()) return;
    setWechatLoading(true);
    try {
      const wxCode = await getWechatCode();
      const result = await api.wechatLogin(wxCode);
      await store.afterLogin(result.token, result.onboarded, result.user.benmingColor);
      onLoggedIn(result.onboarded);
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
      const result = await api.sendSmsCode(phone, 'login');
      setSent(result.cooldownSec || 60);
      if (result.devCode) {
        setCode(result.devCode);
        Taro.showToast({ title: `演示验证码已填入：${result.devCode}`, icon: 'none' });
      } else {
        Taro.showToast({ title: '验证码已发送', icon: 'none' });
      }
    } catch (e) {
      Taro.showToast({ title: (e as Error)?.message || '验证码发送失败，请稍后再试', icon: 'none' });
    } finally {
      setCodeSending(false);
    }
  };

  const submitPhone = async () => {
    if (!phoneOk) { Taro.showToast({ title: '请输入正确手机号', icon: 'none' }); return; }
    if (!codeOk) { Taro.showToast({ title: '请输入短信验证码', icon: 'none' }); return; }
    if (busy || !ensureAgreed()) return;
    setLoading(true);
    try {
      const result = await api.login(phone, undefined, code);
      await store.afterLogin(result.token, result.onboarded, result.user.benmingColor);
      onLoggedIn(result.onboarded);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === 'NETWORK_ERROR') {
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

  const stop = (e: { stopPropagation?: () => void }) => e.stopPropagation?.();

  return (
    <View className="login" onClick={() => !busy && onClose()}>
      <View className="lg-bg">
        <View className="lg-blob lg-b1" />
        <View className="lg-blob lg-b2" />
        <View className="lg-blob lg-b3" />
        <Text className="lg-wm serif">謀</Text>
      </View>

      <View className="lg-content" style={chromeStyle} onClick={stop}>
        <View className="lg-close" role="button" aria-label="关闭登录" onClick={() => !busy && onClose()}><Text>×</Text></View>

        {stage === 'wechat' ? (
          <>
            <View className="lg-hero">
              <Image className="lg-mk" src={logo} mode="aspectFit" />
              <View className="lg-name">
                <Text className="lg-name-ai">AI</Text>
                <Text className="lg-name-cn serif"> 军师</Text>
              </View>
              <View className="lg-rule" />
              <Text className="lg-slogan serif">谋定而后动，决胜千里之外</Text>
              <Text className="lg-tag">你的随身 AI 商业军师</Text>
            </View>

            <View className="lg-actions">
              <Text className="lg-reason">{authReasonText(reason)}</Text>
              <View className={`lg-wechat ${wechatLoading ? 'off' : ''}`} onClick={submitWechat}>
                <Icon name="wechat" size={21} color="#07C160" />
                <Text className="lg-wechat-t">{wechatLoading ? '登录中…' : '微信账号登录'}</Text>
              </View>
              <View className="lg-switch" onClick={() => !busy && setStage('phone')}>
                <Text>手机号验证码登录</Text>
                <Icon name="arrow" size={13} color="rgba(243,240,230,.82)" />
              </View>
              <View className="lg-consent">
                <View className={`lg-cbox ${agreed ? 'on' : ''}`} onClick={() => setAgreed((v) => !v)}>
                  {agreed ? <Text className="lg-cbox-tick">✓</Text> : null}
                </View>
                <Text className="lg-agree">
                  我已阅读并同意
                  <Text className="lg-link" onClick={() => openDoc('agreement')}>《用户协议》</Text>
                  与
                  <Text className="lg-link" onClick={() => openDoc('privacy')}>《隐私政策》</Text>
                </Text>
              </View>
            </View>
          </>
        ) : (
          <>
            <View className="lg-form">
              <Text className="lg-kicker">AI 军师</Text>
              <Text className="lg-h serif">手机号登录</Text>
              <Text className="lg-sub">仅在你主动选择此方式时收集手机号；未注册将自动创建账号</Text>
              <View className="lg-field">
                <Text className="lg-pre">+86</Text>
                <Input className="lg-input" type="number" maxlength={11} value={phone} placeholder="请输入手机号" placeholderClass="lg-ph" onInput={(e) => setPhone(e.detail.value)} />
              </View>
              <View className="lg-field">
                <Input className="lg-input" type="number" maxlength={6} value={code} placeholder="验证码" placeholderClass="lg-ph" onInput={(e) => setCode(e.detail.value)} />
                <Text className={`lg-code ${sent > 0 || codeSending ? 'off' : ''}`} onClick={sendCode}>
                  {sent > 0 ? `${sent}s` : codeSending ? '发送中…' : '获取验证码'}
                </Text>
              </View>
              <View className={`lg-cta ${loading ? 'off' : ''}`} onClick={submitPhone}>
                <Text>{loading ? '登录中…' : '登录 / 注册'}</Text>
              </View>
            </View>

            <View className="lg-actions">
              <View className="lg-switch" onClick={() => !busy && setStage('wechat')}>
                <Icon name="wechat" size={15} color="rgba(243,240,230,.82)" />
                <Text> 返回微信账号登录</Text>
              </View>
              <View className="lg-consent">
                <View className={`lg-cbox ${agreed ? 'on' : ''}`} onClick={() => setAgreed((v) => !v)}>
                  {agreed ? <Text className="lg-cbox-tick">✓</Text> : null}
                </View>
                <Text className="lg-agree">
                  我已阅读并同意
                  <Text className="lg-link" onClick={() => openDoc('agreement')}>《用户协议》</Text>
                  与
                  <Text className="lg-link" onClick={() => openDoc('privacy')}>《隐私政策》</Text>
                </Text>
              </View>
            </View>
          </>
        )}
      </View>
    </View>
  );
}
