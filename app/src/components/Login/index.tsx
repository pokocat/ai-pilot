import { useEffect, useState } from 'react';
import { View, Text, Input, Button, Image } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { api } from '../../services/api';
import Icon from '../Icon';
import logo from '../../assets/logo.png';
import { store } from '../../services/store';
import './index.scss';

interface Props {
  open: boolean;
  // 登录成功回调：onboarded=该账号是否已建档
  onLoggedIn: (onboarded: boolean) => void;
}

type Stage = 'wechat' | 'phone' | 'complete';

const phoneRe = /^1\d{10}$/;
const codeRe = /^\d{4,8}$/;

// 登录：常见风格「微信登录为主，手机号验证码可切换」。
// 微信登录后进入「完善资料」：同步/编辑微信昵称与头像，并可选绑定手机号（可跳过）。
export default function Login({ open, onLoggedIn }: Props) {
  const [stage, setStage] = useState<Stage>('wechat');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(0); // 验证码倒计时
  const [codeSending, setCodeSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [wechatLoading, setWechatLoading] = useState(false);

  // 完善资料（微信登录后）
  const [avatarLocal, setAvatarLocal] = useState('');
  const [nick, setNick] = useState('');
  const [bindPhone, setBindPhone] = useState('');
  const [bindCode, setBindCode] = useState('');
  const [bindSent, setBindSent] = useState(0);
  const [bindSending, setBindSending] = useState(false);
  const [saving, setSaving] = useState(false);

  // 打开时隐藏底栏（复用 overlay 标志），并回到默认微信登录态
  useEffect(() => {
    store.setOverlay(open, 'login');
    if (open) setStage('wechat');
    return () => store.setOverlay(false, 'login');
  }, [open]);

  useEffect(() => {
    if (sent <= 0) return;
    const t = setTimeout(() => setSent((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [sent]);
  useEffect(() => {
    if (bindSent <= 0) return;
    const t = setTimeout(() => setBindSent((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [bindSent]);

  if (!open) return null;

  const isWeapp = process.env.TARO_ENV === 'weapp';
  const phoneOk = phoneRe.test(phone);
  const codeOk = codeRe.test(code);
  const busy = loading || wechatLoading || saving;

  const getWechatCode = () => new Promise<string>((resolve, reject) => {
    Taro.login({
      success: (res) => (res.code ? resolve(res.code) : reject(new Error(res.errMsg || 'wx.login 未返回 code'))),
      fail: (err) => reject(new Error(err.errMsg || 'wx.login 失败')),
    });
  });

  // 微信登录成功后：新账号 → 进「完善资料」同步昵称/头像；老账号直接进入。
  const afterAuthed = (r: { isNew: boolean; onboarded: boolean; user: { wechatLinked?: boolean } }) => {
    if (r.user.wechatLinked && r.isNew) {
      setNick(store.me()?.user.name || '');
      setAvatarLocal('');
      setStage('complete');
    } else {
      onLoggedIn(r.onboarded);
    }
  };

  const submitWechat = async () => {
    if (busy) return;
    setWechatLoading(true);
    try {
      const wxCode = await getWechatCode();
      const r = await api.wechatLogin(wxCode);
      await store.afterLogin(r.token, r.onboarded, r.user.benmingColor);
      afterAuthed(r);
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
      const r = await api.sendSmsCode(phone, 'login');
      setSent(r.cooldownSec || 60);
      if (r.devCode) { setCode(r.devCode); Taro.showToast({ title: `演示验证码已填入：${r.devCode}`, icon: 'none' }); }
      else Taro.showToast({ title: '验证码已发送', icon: 'none' });
    } catch (e) {
      Taro.showToast({ title: (e as Error)?.message || '验证码发送失败，请稍后再试', icon: 'none' });
    } finally {
      setCodeSending(false);
    }
  };

  const submitPhone = async () => {
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

  // —— 完善资料：头像 / 昵称 / 可选绑定手机 ——
  const onChooseAvatar = (e: { detail?: { avatarUrl?: string } }) => {
    const url = e?.detail?.avatarUrl;
    if (url) setAvatarLocal(url);
  };

  const sendBindCode = async () => {
    if (!phoneRe.test(bindPhone)) { Taro.showToast({ title: '请输入正确手机号', icon: 'none' }); return; }
    if (bindSent > 0 || bindSending) return;
    setBindSending(true);
    try {
      const r = await api.sendSmsCode(bindPhone, 'bind');
      setBindSent(r.cooldownSec || 60);
      if (r.devCode) { setBindCode(r.devCode); Taro.showToast({ title: `演示验证码已填入：${r.devCode}`, icon: 'none' }); }
      else Taro.showToast({ title: '验证码已发送', icon: 'none' });
    } catch (e) {
      Taro.showToast({ title: (e as Error)?.message || '验证码发送失败，请稍后再试', icon: 'none' });
    } finally {
      setBindSending(false);
    }
  };

  const finishComplete = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // 头像：先传到 OSS 持久化（失败仅提示，不阻断进入）
      if (avatarLocal) {
        try { await api.uploadAvatar(avatarLocal); }
        catch { Taro.showToast({ title: '头像稍后可在「设置」中重试', icon: 'none' }); }
      }
      const name = nick.trim();
      if (name && name !== (store.me()?.user.name || '')) {
        try { await api.updateIdentity({ name }); } catch { /* 可在设置补填，不阻断 */ }
      }
      // 可选绑定手机：两项都填了才校验提交；任一格式不对则提示并停留
      if (bindPhone || bindCode) {
        if (!phoneRe.test(bindPhone)) { Taro.showToast({ title: '请输入正确手机号', icon: 'none' }); return; }
        if (!codeRe.test(bindCode)) { Taro.showToast({ title: '请输入验证码', icon: 'none' }); return; }
        try {
          await api.bindPhone(bindPhone, bindCode);
        } catch (e) {
          Taro.showToast({ title: (e as Error)?.message || '绑定失败，请重试', icon: 'none' });
          return;
        }
      }
      await store.loadMe();
      onLoggedIn(store.isOnboarded());
    } finally {
      setSaving(false);
    }
  };

  const skipComplete = () => onLoggedIn(store.isOnboarded());

  const avatarShown = avatarLocal || store.me()?.user.avatarUrl || '';

  return (
    <View className="login">
      {/* 主体绿 · 流动背景 */}
      <View className="lg-bg">
        <View className="lg-blob lg-b1" />
        <View className="lg-blob lg-b2" />
        <View className="lg-blob lg-b3" />
        <Text className="lg-wm serif">謀</Text>
      </View>

      {stage === 'wechat' && (
        <View className="lg-content">
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
            <View className={`lg-wechat ${wechatLoading ? 'off' : ''}`} onClick={submitWechat}>
              <Icon name="wechat" size={21} color="#07C160" />
              <Text className="lg-wechat-t">{wechatLoading ? '登录中…' : '微信一键登录'}</Text>
            </View>
            <View className="lg-switch" onClick={() => !busy && setStage('phone')}>
              <Text>手机号登录</Text>
              <Icon name="arrow" size={13} color="rgba(243,240,230,.82)" />
            </View>
            <Text className="lg-agree">登录即同意《用户协议》与《隐私政策》</Text>
          </View>
        </View>
      )}

      {stage === 'phone' && (
        <View className="lg-content">
          <View className="lg-form">
            <Text className="lg-kicker">AI 军师</Text>
            <Text className="lg-h serif">手机号登录</Text>
            <Text className="lg-sub">未注册的手机号将自动创建账号</Text>

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
              <Text> 返回微信登录</Text>
            </View>
            <Text className="lg-agree">登录即同意《用户协议》与《隐私政策》</Text>
          </View>
        </View>
      )}

      {stage === 'complete' && (
        <View className="lg-content">
          <View className="lg-form lg-complete">
            <Text className="lg-h serif">完善你的资料</Text>
            <Text className="lg-sub">来自微信，可随时在「设置」中修改</Text>

            <View className="lg-av-wrap">
              {isWeapp ? (
                <Button className="lg-av-btn" openType="chooseAvatar" onChooseAvatar={onChooseAvatar}>
                  {avatarShown
                    ? <Image className="lg-av" src={avatarShown} mode="aspectFill" />
                    : <View className="lg-av lg-av-ph"><Icon name="user" size={26} color="rgba(243,240,230,.7)" /></View>}
                  <View className="lg-av-cam"><Icon name="image" size={13} color="#0E2A1E" /></View>
                </Button>
              ) : (
                avatarShown
                  ? <Image className="lg-av" src={avatarShown} mode="aspectFill" />
                  : <View className="lg-av lg-av-ph"><Icon name="user" size={26} color="rgba(243,240,230,.7)" /></View>
              )}
              <Text className="lg-av-tip">点击设置头像</Text>
            </View>

            <View className="lg-field">
              <Input className="lg-input" type="nickname" maxlength={20} value={nick} placeholder="填写昵称" placeholderClass="lg-ph" onInput={(e) => setNick(e.detail.value)} onBlur={(e) => setNick(e.detail.value)} />
            </View>

            <View className="lg-bindsec">
              <Text className="lg-bindsec-t">绑定手机号</Text>
              <Text className="lg-bindsec-opt">选填</Text>
            </View>
            <View className="lg-field">
              <Text className="lg-pre">+86</Text>
              <Input className="lg-input" type="number" maxlength={11} value={bindPhone} placeholder="手机号" placeholderClass="lg-ph" onInput={(e) => setBindPhone(e.detail.value)} />
            </View>
            <View className="lg-field">
              <Input className="lg-input" type="number" maxlength={6} value={bindCode} placeholder="验证码" placeholderClass="lg-ph" onInput={(e) => setBindCode(e.detail.value)} />
              <Text className={`lg-code ${bindSent > 0 || bindSending ? 'off' : ''}`} onClick={sendBindCode}>
                {bindSent > 0 ? `${bindSent}s` : bindSending ? '发送中…' : '获取验证码'}
              </Text>
            </View>

            <View className={`lg-cta ${saving ? 'off' : ''}`} onClick={finishComplete}>
              <Text>{saving ? '保存中…' : '完成并进入'}</Text>
            </View>
            <Text className="lg-skip" onClick={() => !saving && skipComplete()}>跳过，稍后再说</Text>
          </View>
        </View>
      )}
    </View>
  );
}
