import { useEffect, useState } from 'react';
import { View, Text, Input, Button, Image } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '../../components/Icon';
import SafeHeader from '../../components/SafeHeader';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api } from '../../services/api';
import './index.scss';

const isWeapp = process.env.TARO_ENV === 'weapp';

const VERSION = 'v1.0.0';

const AGREEMENT = '军师为创始人/管理者提供 AI 商业参谋服务。AI 产出仅供参考，重大经营决策请结合专业意见与自身判断；你对账号下的内容与决策负责。我们按约定提供服务并保障可用性。';
const PRIVACY = '我们仅收集为你提供服务所必需的信息（账号标识、你主动填写的企业档案与对话内容），用于生成与你相关的产出，不向第三方出售。你可随时在「设置」中修改资料，或联系我们删除账号与数据。';

// 设置：个人资料编辑（称呼/公司）+ 关于 + 退出登录。
export default function Settings() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const me = s.me();
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [saving, setSaving] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const avatarUrl = me?.user.avatarUrl || '';

  const onChooseAvatar = async (e: { detail?: { avatarUrl?: string } }) => {
    const path = e?.detail?.avatarUrl;
    if (!path || avatarUploading) return;
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

  const showDoc = (title: string, content: string) =>
    Taro.showModal({ title, content, showCancel: false, confirmText: '我知道了' });

  const logout = () =>
    Taro.showModal({ title: '退出登录', content: '确定退出当前账号？' }).then((r) => {
      if (r.confirm) { store.logout(); Taro.reLaunch({ url: '/pages/counsel/index' }); }
    });

  const deleteAccount = () =>
    Taro.showModal({
      title: '注销账号',
      content: '注销将永久删除你的账号、对话、方案库与全部数据，且不可恢复。确定继续？',
      confirmText: '永久注销',
      confirmColor: '#c0392b',
    }).then(async (r) => {
      if (!r.confirm) return;
      try {
        await api.deleteAccount();
        store.logout();
        Taro.reLaunch({ url: '/pages/counsel/index' });
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

        <Text className="set-sec">关于</Text>
        <View className="set-card">
          <View className="set-row static">
            <Text className="set-rt">当前版本</Text>
            <Text className="set-rv">{VERSION}</Text>
          </View>
          <View className="set-row" onClick={() => showDoc('用户协议', AGREEMENT)}>
            <Text className="set-rt">用户协议</Text>
            <Text className="set-go">›</Text>
          </View>
          <View className="set-row" onClick={() => showDoc('隐私政策', PRIVACY)}>
            <Text className="set-rt">隐私政策</Text>
            <Text className="set-go">›</Text>
          </View>
        </View>

        <View className="set-logout" onClick={logout}>
          <Icon name="lock" size={15} color="#9C4A38" /><Text> 退出登录</Text>
        </View>
        <Text className="set-danger" onClick={deleteAccount}>注销账号</Text>
      </View>
    </View>
  );
}
