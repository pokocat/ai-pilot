import { useEffect, useState, type CSSProperties } from 'react';
import { View, Text, Input, Image, Button } from '@tarojs/components';
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
  // 登录成功回调：onboarded=该账号是否已建档。新账号先完成称呼，再自动进入入局仪式。
  onLoggedIn: (onboarded: boolean) => void;
}

type Stage = 'wechat' | 'phone' | 'complete';
type LoginChromeStyle = CSSProperties & {
  '--lg-close-top'?: string;
  '--lg-close-right'?: string;
};

const phoneRe = /^1\d{10}$/;
const codeRe = /^\d{4,8}$/;

// 手机号仍可作为替代登录方式；微信新账号在首次身份页完成手机号绑定（称呼/手机号必填、头像可选），
// 未建档的新账号随后自动进入本命色与首判仪式。
export default function Login({ open, reason, onClose, onLoggedIn }: Props) {
  const [stage, setStage] = useState<Stage>('wechat');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(0);
  const [codeSending, setCodeSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [wechatLoading, setWechatLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [avatarLocal, setAvatarLocal] = useState('');
  const [nick, setNick] = useState('');
  const [nickFocus, setNickFocus] = useState(false);
  const [pendingOnboarded, setPendingOnboarded] = useState(false);
  const [phoneBound, setPhoneBound] = useState(false);
  const [boundPhone, setBoundPhone] = useState('');
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
  const busy = loading || wechatLoading || saving;

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

  const finishAuth = (onboarded: boolean) => {
    onLoggedIn(onboarded);
    if (onboarded) return;
    setTimeout(() => {
      const pages = Taro.getCurrentPages();
      if (pages.some((page) => String(page.route || '').includes('packages/main/onboarding'))) return;
      Taro.navigateTo({ url: '/packages/main/onboarding/index' });
    }, 80);
  };

  const presentAfterAuth = (onboarded: boolean) => {
    const user = store.me()?.user;
    if (!String(user?.name || '').trim()) {
      setAvatarLocal('');
      setNick('');
      setNickFocus(false);
      setPendingOnboarded(onboarded);
      const currentPhone = String(user?.phone || '').trim();
      setPhoneBound(phoneRe.test(currentPhone));
      setBoundPhone(currentPhone);
      setStage('complete');
      return;
    }
    finishAuth(onboarded);
  };

  const submitWechat = async () => {
    if (busy || !ensureAgreed()) return;
    setWechatLoading(true);
    try {
      const wxCode = await getWechatCode();
      const result = await api.wechatLogin(wxCode);
      await store.afterLogin(result.token, result.onboarded, result.user.benmingColor);
      presentAfterAuth(result.onboarded);
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
      const result = await api.sendSmsCode(phone, stage === 'complete' ? 'bind' : 'login');
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
      presentAfterAuth(result.onboarded);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === 'NETWORK_ERROR') {
        const onboarded = store.isOnboarded();
        await store.afterLogin(`local-${phone}`, onboarded);
        presentAfterAuth(onboarded);
      } else {
        Taro.showToast({ title: err?.message || '登录失败，请重试', icon: 'none' });
      }
    } finally {
      setLoading(false);
    }
  };

  const onChooseAvatar = (e: { detail?: { avatarUrl?: string } }) => {
    const filePath = e.detail?.avatarUrl;
    if (!filePath) return;
    setAvatarLocal(filePath);
    if (!nick.trim()) setTimeout(() => setNickFocus(true), 60);
  };

  const finishComplete = async () => {
    if (saving) return;
    const name = nick.trim();
    if (!name) {
      Taro.showToast({ title: '请填写你的称呼', icon: 'none' });
      setNickFocus(false);
      setTimeout(() => setNickFocus(true), 60);
      return;
    }
    if (!phoneBound && !phoneOk) { Taro.showToast({ title: '请输入正确手机号', icon: 'none' }); return; }
    if (!phoneBound && !codeOk) { Taro.showToast({ title: '请输入短信验证码', icon: 'none' }); return; }
    setSaving(true);
    try {
      if (!phoneBound) {
        const result = await api.bindPhone(phone, code);
        setPhoneBound(true);
        setBoundPhone(result.phone || phone);
      }
      await api.updateIdentity({ name });
      if (avatarLocal) {
        try {
          if (/^https?:\/\//.test(avatarLocal)) await api.updateIdentity({ avatarUrl: avatarLocal });
          else await api.uploadAvatar(avatarLocal);
        } catch {
          Taro.showToast({ title: '头像稍后可在设置中重试', icon: 'none' });
        }
      }
      await store.loadMe();
      finishAuth(pendingOnboarded);
    } catch (e) {
      store.handleApiError(e, { fallbackTitle: '称呼保存失败，请重试' });
    } finally {
      setSaving(false);
    }
  };

  const logoutComplete = () => {
    if (saving) return;
    store.logout();
    store.setOverlay(true, 'login');
    setAvatarLocal(''); setNick(''); setNickFocus(false); setPendingOnboarded(false); setPhoneBound(false); setBoundPhone(''); setPhone(''); setCode(''); setStage('wechat');
  };

  const stop = (e: { stopPropagation?: () => void }) => e.stopPropagation?.();

  return (
    <View className="login" onClick={() => !busy && stage !== 'complete' && onClose()}>
      <View className="lg-bg">
        <View className="lg-blob lg-b1" />
        <View className="lg-blob lg-b2" />
        <View className="lg-blob lg-b3" />
        <Text className="lg-wm serif">謀</Text>
      </View>

      <View className="lg-content" style={chromeStyle} onClick={stop}>
        {stage !== 'complete' && <View className="lg-close" role="button" aria-label="关闭登录" onClick={() => !busy && onClose()}><Text>×</Text></View>}

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
        ) : stage === 'phone' ? (
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
        ) : (
          <View className="lg-form lg-complete">
            <Text className="lg-kicker">初 次 入 部</Text>
            <Text className="lg-h serif">先让军师认得你</Text>
            <Text className="lg-sub">称呼和手机号用于识别、找回账号；头像可选，之后都可以修改。</Text>

            <View className="lg-av-wrap">
              {process.env.TARO_ENV === 'weapp' ? (
                <Button className="lg-av-btn" openType="chooseAvatar" onChooseAvatar={onChooseAvatar}>
                  {avatarLocal
                    ? <Image className="lg-av" src={avatarLocal} mode="aspectFill" />
                    : <View className="lg-av lg-av-ph"><Icon name="user" size={27} color="rgba(243,240,230,.78)" /></View>}
                  <View className="lg-av-cam"><Icon name="image" size={13} color="#0E2A1E" /></View>
                </Button>
              ) : (
                <View className="lg-av lg-av-ph"><Icon name="user" size={27} color="rgba(243,240,230,.78)" /></View>
              )}
              <Text className="lg-av-tip">点头像可使用微信头像（可选）</Text>
            </View>

            <View className="lg-field">
              <Input className="lg-input" type="nickname" maxlength={20} value={nick} focus={nickFocus} placeholder="填写称呼，点此可使用微信昵称" placeholderClass="lg-ph" onInput={(e) => setNick(e.detail.value)} onBlur={(e) => { setNick(e.detail.value); setNickFocus(false); }} />
            </View>
            {phoneBound ? (
              <View className="lg-phone-bound"><Icon name="check" size={15} color="#143726" /><Text>手机号已绑定 {boundPhone}</Text></View>
            ) : (
              <View className="lg-phone-complete">
                <Text className="lg-phone-or">绑定手机号</Text>
                <View className="lg-field compact"><Text className="lg-pre">+86</Text><Input className="lg-input" type="number" maxlength={11} value={phone} placeholder="请输入手机号" placeholderClass="lg-ph" onInput={(e) => setPhone(e.detail.value)} /></View>
                <View className="lg-field compact"><Input className="lg-input" type="number" maxlength={6} value={code} placeholder="验证码" placeholderClass="lg-ph" onInput={(e) => setCode(e.detail.value)} /><Text className={`lg-code ${sent > 0 || codeSending ? 'off' : ''}`} onClick={sendCode}>{sent > 0 ? `${sent}s` : codeSending ? '发送中…' : '获取验证码'}</Text></View>
              </View>
            )}
            <View className={`lg-cta ${saving ? 'off' : ''}`} onClick={finishComplete}><Text>{saving ? '保存中…' : '完成并开始入局'}</Text></View>
            <Text className="lg-skip lg-skip-weak" onClick={logoutComplete}>退出登录</Text>
          </View>
        )}
      </View>
    </View>
  );
}
