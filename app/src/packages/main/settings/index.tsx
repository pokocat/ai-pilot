import { useEffect, useState } from 'react';
import { View, Text, Input, Button, Image } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '../../../components/Icon';
import Picker from '../../../components/Picker';
import SafeHeader from '../../../components/SafeHeader';
import ImpersonateSheet from '../../../components/ImpersonateSheet';
import { useStore } from '../../../hooks/useStore';
import { store } from '../../../services/store';
import { api } from '../../../services/api';
import { checkUpload } from '../../../services/uploadGuard';
import { APP_BUILD_SHA, APP_MODE, APP_VERSION } from '../../../services/config';
import './index.scss';

const isWeapp = process.env.TARO_ENV === 'weapp';
const VERSION = `v${APP_VERSION} · ${APP_MODE === 'mock' ? 'MOCK' : '正式'} · ${APP_BUILD_SHA}`;


// 设置：个人资料编辑（称呼/公司）+ 关于 + 退出登录。
export default function Settings() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const me = s.me();
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [saving, setSaving] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [showPhoneBind, setShowPhoneBind] = useState(false);
  const [bindPhone, setBindPhone] = useState('');
  const [bindCode, setBindCode] = useState('');
  const [bindCountdown, setBindCountdown] = useState(0);
  const [bindBusy, setBindBusy] = useState(false);
  const [showImp, setShowImp] = useState(false); // 换身注入弹层（长按版本号呼出，运营排查）
  const [showPicker, setShowPicker] = useState(false); // 本命色选择（从老板 tab 菜单并入）
  const avatarUrl = me?.user.avatarUrl || '';

  const onChooseAvatar = async (e: { detail?: { avatarUrl?: string } }) => {
    const path = e?.detail?.avatarUrl;
    if (!path || avatarUploading) return;
    // B8：复用 chat 上传前置校验（体积/格式），避免放行后被服务端 413 拒绝、只留一句无信息量报错。
    try {
      const info = await Taro.getFileInfo({ filePath: path }) as { size?: number };
      const chk = checkUpload({ name: path, size: info?.size });
      if (!chk.ok) { Taro.showToast({ title: chk.desc || '头像不符合上传要求', icon: 'none' }); return; }
    } catch { /* 拿不到文件信息则跳过体积校验，继续上传 */ }
    setAvatarUploading(true);
    try {
      await api.uploadAvatar(path);
      await store.loadMe();
      Taro.showToast({ title: '头像已更新', icon: 'success' });
    } catch (err) {
      s.handleApiError(err, { fallbackTitle: '头像更新失败，请重试' });
    } finally {
      setAvatarUploading(false);
    }
  };

  useEffect(() => {
    setName(me?.user.name ?? '');
    setCompany(me?.tenant.name ?? '');
  }, [me?.user.name, me?.tenant.name]);

  useEffect(() => {
    if (bindCountdown <= 0) return;
    const timer = setTimeout(() => setBindCountdown((n) => Math.max(0, n - 1)), 1000);
    return () => clearTimeout(timer);
  }, [bindCountdown]);

  const dirty = (name.trim() !== (me?.user.name ?? '')) || (company.trim() !== (me?.tenant.name ?? ''));

  const save = async () => {
    if (saving || !dirty) return;
    if (!name.trim()) { Taro.showToast({ title: '请填写称呼', icon: 'none' }); return; }
    setSaving(true);
    try {
      await api.updateIdentity({ name: name.trim(), company: company.trim() });
      await store.loadMe();
      Taro.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      s.handleApiError(e, { fallbackTitle: '保存失败，请重试' });
    } finally {
      setSaving(false);
    }
  };

  const openDoc = (doc: 'agreement' | 'privacy' | 'refund') =>
    Taro.navigateTo({ url: `/packages/main/legal/index?doc=${doc}` });

  const sendBindCode = async () => {
    const phone = bindPhone.trim();
    if (!/^1\d{10}$/.test(phone)) { Taro.showToast({ title: '请填写 11 位手机号', icon: 'none' }); return; }
    if (bindBusy || bindCountdown > 0) return;
    setBindBusy(true);
    try {
      await api.sendSmsCode(phone, 'bind');
      setBindCountdown(60);
      Taro.showToast({ title: '验证码已发送', icon: 'none' });
    } catch (e) { s.handleApiError(e, { fallbackTitle: '验证码发送失败' }); }
    finally { setBindBusy(false); }
  };

  const confirmBindPhone = async () => {
    const phone = bindPhone.trim();
    const code = bindCode.trim();
    if (!/^1\d{10}$/.test(phone) || !/^\d{4,8}$/.test(code)) { Taro.showToast({ title: '请填写正确的手机号和验证码', icon: 'none' }); return; }
    if (bindBusy) return;
    setBindBusy(true);
    try {
      await api.bindPhone(phone, code);
      await store.loadMe();
      setShowPhoneBind(false);
      setBindPhone('');
      setBindCode('');
      Taro.showToast({ title: '手机号已绑定', icon: 'success' });
    } catch (e) { s.handleApiError(e, { fallbackTitle: '绑定失败，请重试' }); }
    finally { setBindBusy(false); }
  };

  // 非 weapp 环境（H5）没有微信客服组件，明确引导回小程序联系，不展示虚构渠道。
  const contactFallback = () =>
    Taro.showModal({ title: '联系客服', content: '请在微信小程序「军师」的设置页点击“联系客服”，进入微信客服会话。', showCancel: false, confirmText: '我知道了' });

  const logout = () =>
    Taro.showModal({ title: '退出登录', content: '确定退出当前账号？' }).then((r) => {
      if (r.confirm) { store.logout(); Taro.reLaunch({ url: '/pages/sessions/index' }); }
    });

  const deleteAccount = () =>
    Taro.showModal({
      title: '注销账号',
      content: '注销将永久删除你的账号、对话、方案库与全部数据，且不可恢复。确定继续？',
      confirmText: '永久注销',
      confirmColor: '#9C4A38', // = var(--danger)，showModal 仅接受 hex
    }).then(async (r) => {
      if (!r.confirm) return;
      try {
        await api.deleteAccount();
        store.logout();
        Taro.reLaunch({ url: '/pages/sessions/index' });
        Taro.showToast({ title: '账号已注销', icon: 'none' });
      } catch (e) {
        s.handleApiError(e, { fallbackTitle: '注销失败，请重试' });
      }
    });

  return (
    <View className={`page settings ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="设置" onBack={() => Taro.navigateBack()} titleClassName="set-title" />

      <View className="pad">
        <Text className="set-sec">个人资料</Text>
        <View className="set-card">
          <View className="set-field set-avatar-row">
            <Text className="set-label">头像</Text>
            {isWeapp ? (
              <Button className="set-avatar-btn" openType="chooseAvatar" onChooseAvatar={onChooseAvatar}>
                {avatarUrl
                  ? <Image className="set-avatar" src={avatarUrl} mode="aspectFill" />
                  : <View className="set-avatar set-avatar-ph" style={{ background: accent }}><Icon name="user" size={18} color="#fff" /></View>}
                <Text className="set-avatar-edit" style={{ color: accent }}>{avatarUploading ? '上传中…' : '更换'}</Text>
              </Button>
            ) : (
              avatarUrl
                ? <Image className="set-avatar" src={avatarUrl} mode="aspectFill" />
                : <View className="set-avatar set-avatar-ph" style={{ background: accent }}><Icon name="user" size={18} color="#fff" /></View>
            )}
          </View>
          <View className="set-field">
            <Text className="set-label">称呼</Text>
            <Input className="set-input" value={name} maxlength={20} placeholder="怎么称呼你？" onInput={(e) => setName(e.detail.value)} />
          </View>
          <View className="set-field">
            <Text className="set-label">公司 / 品牌</Text>
            <Input className="set-input" value={company} maxlength={40} placeholder="选填，用于让产出更贴合你的业务" onInput={(e) => setCompany(e.detail.value)} />
          </View>
        </View>
        <View className={`set-save ${dirty ? '' : 'off'}`} style={{ background: accent }} onClick={save}>
          <Text>{saving ? '保存中…' : '保存'}</Text>
        </View>

        <Text className="set-sec">账号联系信息</Text>
        <View className="set-card">
          {me?.user.phone ? (
            <View className="set-row static"><Text className="set-rt">手机号</Text><Text className="set-rv">{me.user.phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')}</Text></View>
          ) : (
            <>
              <View className="set-row" onClick={() => setShowPhoneBind((v) => !v)}>
                <View className="set-phone-title"><Text className="set-rt">绑定手机号（可选）</Text><Text className="set-phone-note">用于短信登录与重要服务联系，不影响当前使用</Text></View>
                <Text className="set-go">{showPhoneBind ? '⌃' : '›'}</Text>
              </View>
              {showPhoneBind ? (
                <View className="set-phone-form">
                  <Input className="set-phone-input" type="number" maxlength={11} value={bindPhone} placeholder="手机号" onInput={(e) => setBindPhone(e.detail.value)} />
                  <View className="set-code-row">
                    <Input className="set-phone-input code" type="number" maxlength={8} value={bindCode} placeholder="短信验证码" onInput={(e) => setBindCode(e.detail.value)} />
                    <Text className="set-code-send" style={{ color: accent }} onClick={sendBindCode}>{bindCountdown > 0 ? `${bindCountdown}s` : bindBusy ? '发送中…' : '发送验证码'}</Text>
                  </View>
                  <View className="set-bind-action" style={{ background: accent }} onClick={confirmBindPhone}><Text>{bindBusy ? '处理中…' : '确认绑定'}</Text></View>
                  <Text className="set-bind-cancel" onClick={() => setShowPhoneBind(false)}>取消</Text>
                </View>
              ) : null}
            </>
          )}
        </View>

        {/* 偏好：本命色从老板 tab 菜单并入（老板 tab 菜单收敛）——主题偏好本来就该住在设置里 */}
        <Text className="set-sec">偏好</Text>
        <View className="set-card">
          <View className="set-row" onClick={() => setShowPicker(true)}>
            <Text className="set-rt">我的本命色</Text>
            <View className="set-sw" style={{ background: accent }} />
            <Text className="set-rv">{s.color().short}</Text>
            <Text className="set-go">›</Text>
          </View>
        </View>

        <Text className="set-sec">关于</Text>
        <View className="set-card">
          {/* 长按版本号：呼出换身注入弹层——运营凭主公令牌直接切到目标身份排查（无需先退出）。 */}
          <View className="set-row static" onLongPress={() => setShowImp(true)}>
            <Text className="set-rt">当前版本</Text>
            <Text className={`set-rv ${APP_MODE === 'mock' ? 'is-mock' : ''}`}>{VERSION}</Text>
          </View>
          <View className="set-row" onClick={() => openDoc('agreement')}>
            <Text className="set-rt">用户协议</Text>
            <Text className="set-go">›</Text>
          </View>
          <View className="set-row" onClick={() => openDoc('privacy')}>
            <Text className="set-rt">隐私政策</Text>
            <Text className="set-go">›</Text>
          </View>
          <View className="set-row" onClick={() => openDoc('refund')}>
            <Text className="set-rt">退款政策</Text>
            <Text className="set-go">›</Text>
          </View>
        </View>

        <Text className="set-sec">帮助与客服</Text>
        <View className="set-card">
          {isWeapp ? (
            <Button className="set-row set-contact-btn" openType="contact">
              <Text className="set-rt">联系客服</Text>
              <Text className="set-go">›</Text>
            </Button>
          ) : (
            <View className="set-row" onClick={contactFallback}>
              <Text className="set-rt">联系客服</Text>
              <Text className="set-go">›</Text>
            </View>
          )}
        </View>

        <View className="set-logout" onClick={logout}>
          {/* Icon 烘焙场景需 hex：#9C4A38 = var(--danger) */}
          <Icon name="lock" size={15} color="#9C4A38" /><Text> 退出登录</Text>
        </View>
        <Text className="set-danger" onClick={deleteAccount}>注销账号</Text>
      </View>

      <Picker open={showPicker} first={false} onClose={() => setShowPicker(false)} onConfirm={() => setShowPicker(false)} />

      {/* 换身注入弹层：校验通过后已覆盖 token 为新身份，reLaunch 回首页 tab 让各页按新身份重拉。 */}
      <ImpersonateSheet
        open={showImp}
        onClose={() => setShowImp(false)}
        onDone={() => { setShowImp(false); Taro.reLaunch({ url: '/pages/sessions/index' }); }}
      />
    </View>
  );
}
