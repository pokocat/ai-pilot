import { useEffect, useState } from 'react';
import { View, Text, Input, Button, Image } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { api } from '../../services/api';
import Icon from '../Icon';
import ImpersonateSheet from '../ImpersonateSheet';
import logo from '../../assets/logo.png';
import { store } from '../../services/store';
import './index.scss';

interface Props {
  open: boolean;
  // 登录成功回调：onboarded=该账号是否已建档
  onLoggedIn: (onboarded: boolean) => void;
}

type Stage = 'wechat' | 'phone' | 'bindphone' | 'complete';

const phoneRe = /^1\d{10}$/;
const codeRe = /^\d{4,8}$/;

// 微信「手机号实时验证」(getRealtimePhoneNumber) 仅对非个人主体且已开通该能力的小程序可用，
// 个人主体真机会报 `jsapi has no permission`。已开通 → 置 true 启用一键获取手机号；
// 短信验证码始终保留为兜底，故即使个别机型一键失败也能正常绑定。
// 实时验证与旧版「快速验证」返回同样的一次性 code，后端换号接口(getuserphonenumber)完全一致，
// 区别仅在于每次都向运营商实时核验号码，规避「换号后仍返回旧号」。
const WX_PHONE_ONETAP = true;

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
  const [agreed, setAgreed] = useState(false); // 合规：登录前必须主动勾选同意协议/隐私

  // 完善资料（微信登录后）
  const [showImp, setShowImp] = useState(false); // 附身注入弹层（长按印记呼出，运营排查）
  const [avatarLocal, setAvatarLocal] = useState('');
  const [nick, setNick] = useState('');
  const [nickFocus, setNickFocus] = useState(false); // 选完头像后自动聚焦昵称，引出微信键盘「使用微信昵称」
  const [bindPhone, setBindPhone] = useState('');
  const [bindCode, setBindCode] = useState('');
  const [bindSent, setBindSent] = useState(0);
  const [bindSending, setBindSending] = useState(false);
  const [bindLoading, setBindLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // 打开时隐藏底栏（复用 overlay 标志）。已登录但未绑手机 → 直接进强制绑定页；否则回默认微信登录态。
  useEffect(() => {
    store.setOverlay(open, 'login');
    if (open) {
      const me = store.me();
      setStage(store.isAuthed() && me && !me.user.phone ? 'bindphone' : 'wechat');
    }
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
  // getUserProfile 仅在 PC/Mac 端微信返回真实头像昵称；手机端/模拟器一律匿名，故「一键填入」只在 PC/Mac 显示，
  // 手机端直接用下方 chooseAvatar（使用微信头像）+ 昵称填充，避免点了却提示「不支持」。
  const wxPlatform = isWeapp ? (() => { try { return Taro.getDeviceInfo().platform; } catch { return ''; } })() : '';
  const canOneTapWx = isWeapp && (wxPlatform === 'windows' || wxPlatform === 'mac');
  const phoneOk = phoneRe.test(phone);
  const codeOk = codeRe.test(code);
  const busy = loading || wechatLoading || saving;

  const openDoc = (doc: 'agreement' | 'privacy') =>
    Taro.navigateTo({ url: `/packages/main/legal/index?doc=${doc}` });
  // 合规门槛：登录/注册前必须已勾选同意。未勾选则提示并阻断（把「登录即同意」的被动式改为主动勾选）。
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

  // 微信登录成功后：未绑手机 → 进「绑定手机号」页（可跳过）；
  // 已绑但缺名字 → 进「完善资料」（名字必填、头像可选、不可跳过）；都齐 → 直接进入。
  const afterAuthed = (r: { isNew: boolean; onboarded: boolean; user: { wechatLinked?: boolean } }) => {
    const me = store.me();
    if (r.user.wechatLinked && !me?.user.phone) {
      setStage('bindphone');
    } else if (!me?.user.name) {
      // 名字必填：缺名字一律进「完善资料」；头像可选，不因缺头像而拦。
      setNick(me?.user.name || '');
      setAvatarLocal('');
      setStage('complete');
    } else {
      onLoggedIn(r.onboarded);
    }
  };

  // 绑定/跳过后：刷新 me，缺名字去「完善资料」（名字必填，头像可选），否则直接进入。
  const proceedAfterBind = async () => {
    await store.loadMe();
    const me = store.me();
    if (!me?.user.name) { setNick(me?.user.name || ''); setAvatarLocal(''); setStage('complete'); }
    else onLoggedIn(store.isOnboarded());
  };

  // 微信一键绑定手机号：getRealtimePhoneNumber 返回一次性 code，后端换号并绑定到当前账号。
  const onGetBindPhone = async (e: { detail?: { code?: string; errMsg?: string } }) => {
    const detail = e?.detail || {};
    if (!detail.code) {
      const em = detail.errMsg || '';
      // 用户主动取消不打扰；其它失败把真实 errMsg 显出来，便于定位（无权限/未开通/主体不支持等）
      if (!/deny|cancel|fail:?\s*用户/i.test(em)) {
        Taro.showModal({ title: '一键绑定失败', content: em || '未返回手机号 code，请用短信绑定', showCancel: false });
      }
      return;
    }
    if (bindLoading) return;
    setBindLoading(true);
    try {
      await api.bindPhoneByWechat(detail.code);
      await proceedAfterBind();
    } catch (err) {
      Taro.showToast({ title: (err as Error)?.message || '绑定失败，请重试', icon: 'none' });
    } finally {
      setBindLoading(false);
    }
  };

  // 短信兜底绑定。
  const submitBind = async () => {
    if (!phoneRe.test(bindPhone)) { Taro.showToast({ title: '请输入正确手机号', icon: 'none' }); return; }
    if (!codeRe.test(bindCode)) { Taro.showToast({ title: '请输入短信验证码', icon: 'none' }); return; }
    if (bindLoading) return;
    setBindLoading(true);
    try {
      await api.bindPhone(bindPhone, bindCode);
      await proceedAfterBind();
    } catch (err) {
      Taro.showToast({ title: (err as Error)?.message || '绑定失败，请重试', icon: 'none' });
    } finally {
      setBindLoading(false);
    }
  };

  // 绑定页的退出：退登回到微信登录。logout 会清掉 overlay 标志（露出底部 tabBar），
  // 但登录层仍开着，需重新置上 overlay 把 tabBar 重新藏住。
  const logoutEscape = () => {
    if (bindLoading) return;
    store.logout();
    store.setOverlay(true, 'login');
    setBindPhone(''); setBindCode(''); setBindSent(0);
    setStage('wechat');
  };

  const submitWechat = async () => {
    if (busy) return;
    if (!ensureAgreed()) return;
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

  // 手机号登录页的「微信一键登录」：getRealtimePhoneNumber 拿手机号 code + wx.login 拿 loginCode（关联 openid）→ 一键登录/注册。
  // 与绑定不同：此处用户尚未登录，走 /auth/wechat-phone 直接换号建/取账号。
  const onGetLoginPhone = async (e: { detail?: { code?: string; errMsg?: string } }) => {
    const detail = e?.detail || {};
    if (!detail.code) {
      const em = detail.errMsg || '';
      // 用户取消不打扰；其它失败把真实 errMsg 显出来（无权限/未开通/主体不支持等），并提示改用验证码。
      if (!/deny|cancel|fail:?\s*用户/i.test(em)) {
        Taro.showModal({ title: '一键登录失败', content: em || '未返回手机号，请用下方验证码登录', showCancel: false });
      }
      return;
    }
    if (busy) return;
    if (!ensureAgreed()) return;
    setLoading(true);
    try {
      const loginCode = await getWechatCode().catch(() => undefined); // 关联 openid，拿不到也不阻断登录
      const r = await api.wechatPhoneLogin(detail.code, loginCode);
      await store.afterLogin(r.token, r.onboarded, r.user.benmingColor);
      // 名字必填：新账号若还没称呼，先去完善（头像可选）。
      const me = store.me();
      if (!me?.user.name) { setNick(''); setAvatarLocal(''); setStage('complete'); }
      else onLoggedIn(r.onboarded);
    } catch (err) {
      Taro.showToast({ title: (err as Error)?.message || '登录失败，请重试', icon: 'none' });
    } finally {
      setLoading(false);
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
    if (!ensureAgreed()) return;
    setLoading(true);
    try {
      const r = await api.login(phone, undefined, code);
      await store.afterLogin(r.token, r.onboarded, r.user.benmingColor);
      // 名字必填：手机号登录的账号若还没称呼，也要先完善（头像可选）。
      const me = store.me();
      if (!me?.user.name) { setNick(''); setAvatarLocal(''); setStage('complete'); }
      else onLoggedIn(r.onboarded);
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
    if (url) {
      setAvatarLocal(url);
      // 选完头像紧接着聚焦昵称：微信键盘上方会出现「使用微信昵称」，一点即填 → 接近一键。
      if (!nick) { setNickFocus(false); setTimeout(() => setNickFocus(true), 60); }
    }
  };

  // 一键填入：先试 wx.getUserProfile。PC/Mac/旧基础库能拿到真实头像昵称就直接填；
  // 现代手机端被微信匿名化（昵称「微信用户」+灰头像）则回退到 chooseAvatar + 昵称填充。
  const useWechatProfile = async () => {
    if (saving) return;
    try {
      const res = await Taro.getUserProfile({ desc: '用于完善你的资料' });
      const info = (res as { userInfo?: { nickName?: string; avatarUrl?: string } })?.userInfo || {};
      const anon = !info.nickName || info.nickName === '微信用户';
      if (anon) {
        Taro.showToast({ title: '当前微信不支持一键获取，请点头像/昵称选用', icon: 'none' });
        return;
      }
      if (info.avatarUrl) setAvatarLocal(info.avatarUrl);
      if (info.nickName) setNick(info.nickName);
      Taro.showToast({ title: '已填入微信头像昵称', icon: 'success' });
    } catch {
      // 用户取消授权或接口不可用：不打扰，仍可手动用下方头像/昵称。
    }
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
    const name = nick.trim();
    // 名字必填：为空则留在本屏并聚焦输入，不放行。
    if (!name) {
      Taro.showToast({ title: '请填写你的称呼', icon: 'none' });
      setNickFocus(false); setTimeout(() => setNickFocus(true), 60);
      return;
    }
    setSaving(true);
    try {
      // 名字必填：保存失败抛错 → 落到 catch，留在本屏重试，不放行。
      if (name !== (store.me()?.user.name || '')) await api.updateIdentity({ name });
      // 头像可选：chooseAvatar 给本地临时文件 → 传 OSS 持久化；getUserProfile 给微信远程 URL → 直接存。
      // 头像失败仅提示，不阻断进入。
      if (avatarLocal) {
        try {
          if (/^https?:\/\//.test(avatarLocal)) await api.updateIdentity({ avatarUrl: avatarLocal });
          else await api.uploadAvatar(avatarLocal);
        } catch { Taro.showToast({ title: '头像稍后可在「设置」中重试', icon: 'none' }); }
      }
      await store.loadMe();
      onLoggedIn(store.isOnboarded());
    } catch {
      Taro.showToast({ title: '称呼保存失败，请重试', icon: 'none' });
    } finally {
      setSaving(false);
    }
  };

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
            {/* 长按印记（logo）：呼出附身注入弹层——运营凭主公签发的令牌以其身份登入排查。 */}
            <Image className="lg-mk" src={logo} mode="aspectFit" onLongPress={() => setShowImp(true)} />
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
        </View>
      )}

      {stage === 'phone' && (
        <View className="lg-content">
          <View className="lg-form">
            <Text className="lg-kicker">AI 军师</Text>
            <Text className="lg-h serif">手机号登录</Text>
            <Text className="lg-sub">未注册的手机号将自动创建账号</Text>

            {isWeapp && WX_PHONE_ONETAP && (
              <>
                <Button className={`lg-wechat lg-bind-onetap ${loading ? 'off' : ''}`} openType="getRealtimePhoneNumber" onGetRealTimePhoneNumber={onGetLoginPhone}>
                  <Icon name="wechat" size={20} color="#07C160" />
                  <Text className="lg-wechat-t">{loading ? '登录中…' : '微信一键登录'}</Text>
                </Button>
                <View className="lg-sep"><Text>或用短信验证码登录</Text></View>
              </>
            )}

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
        </View>
      )}

      {stage === 'bindphone' && (
        <View className="lg-content">
          <View className="lg-form">
            <Text className="lg-kicker">AI 军师</Text>
            <Text className="lg-h serif">绑定手机号</Text>
            <Text className="lg-sub">绑定后体验更完整，也可稍后在「设置」中绑定</Text>

            {isWeapp && WX_PHONE_ONETAP && (
              <>
                <Button className={`lg-wechat lg-bind-onetap ${bindLoading ? 'off' : ''}`} openType="getRealtimePhoneNumber" onGetRealTimePhoneNumber={onGetBindPhone}>
                  <Icon name="wechat" size={20} color="#07C160" />
                  <Text className="lg-wechat-t">{bindLoading ? '绑定中…' : '微信一键绑定手机号'}</Text>
                </Button>
                <View className="lg-sep"><Text>或用短信验证码绑定</Text></View>
              </>
            )}

            <View className="lg-field">
              <Text className="lg-pre">+86</Text>
              <Input className="lg-input" type="number" maxlength={11} value={bindPhone} placeholder="请输入手机号" placeholderClass="lg-ph" onInput={(e) => setBindPhone(e.detail.value)} />
            </View>
            <View className="lg-field">
              <Input className="lg-input" type="number" maxlength={6} value={bindCode} placeholder="验证码" placeholderClass="lg-ph" onInput={(e) => setBindCode(e.detail.value)} />
              <Text className={`lg-code ${bindSent > 0 || bindSending ? 'off' : ''}`} onClick={sendBindCode}>
                {bindSent > 0 ? `${bindSent}s` : bindSending ? '发送中…' : '获取验证码'}
              </Text>
            </View>
            <View className={`lg-cta ${bindLoading ? 'off' : ''}`} onClick={submitBind}>
              <Text>{bindLoading ? '绑定中…' : '完成绑定'}</Text>
            </View>
          </View>

          <View className="lg-actions">
            <Text className="lg-skip lg-skip-weak" onClick={logoutEscape}>退出登录</Text>
          </View>
        </View>
      )}

      {stage === 'complete' && (
        <View className="lg-content">
          <View className="lg-form lg-complete">
            <Text className="lg-h serif">完善你的资料</Text>
            <Text className="lg-sub">取个称呼（必填），头像可选 · 点头像/昵称可选用微信资料，均可随时修改</Text>

            {canOneTapWx && (
              <View className="lg-onetap-wx" onClick={useWechatProfile}>
                <Icon name="wechat" size={18} color="#07C160" />
                <Text className="lg-onetap-wx-t">一键填入微信头像昵称</Text>
              </View>
            )}

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
              <Text className="lg-av-tip">点头像 · 使用微信头像（可选）</Text>
            </View>

            <View className="lg-field">
              <Input className="lg-input" type="nickname" maxlength={20} value={nick} focus={nickFocus} placeholder="填写称呼（必填，点此可用微信昵称）" placeholderClass="lg-ph" onInput={(e) => setNick(e.detail.value)} onBlur={(e) => { setNick(e.detail.value); setNickFocus(false); }} />
            </View>

            <View className={`lg-cta ${saving ? 'off' : ''}`} onClick={finishComplete}>
              <Text>{saving ? '保存中…' : '完成并进入'}</Text>
            </View>
            <Text className="lg-skip lg-skip-weak" onClick={() => !saving && logoutEscape()}>退出登录</Text>
          </View>
        </View>
      )}

      {/* 附身注入弹层：校验通过后与正常登录同路——交回宿主 onLoggedIn 按 onboarded 分支。 */}
      <ImpersonateSheet
        open={showImp}
        onClose={() => setShowImp(false)}
        onDone={(onboarded) => { setShowImp(false); onLoggedIn(onboarded); }}
      />
    </View>
  );
}
