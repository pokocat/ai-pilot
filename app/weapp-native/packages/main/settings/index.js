const env = require('../../../config/env');
const { api } = require('../../../services/api');
const store = require('../../../services/store');
const { navTo } = require('../../../services/nav');
const { baseData } = require('../../../services/page');
const { COLORS, colorByKey, colorIndex, isColorKey } = require('../../../services/colors');

function colorState(key) {
  const color = colorByKey(key);
  return {
    colorKey: color.key,
    colorName: color.short,
    selectedColor: color,
    colorNumber: colorIndex(color.key) + 1,
    themeClass: `theme-${color.key}`,
  };
}

Page({
  data: baseData({
    name: '',
    company: '',
    phone: '',
    phoneDisplay: '未绑定',
    wechatLinked: false,
    avatarUrl: '',
    saving: false,
    uploading: false,
    codeSending: false,
    sent: 0,
    binding: false,
    versionLabel: `v${env.VERSION} · ${env.APP_MODE === 'mock' ? 'MOCK' : '正式'} · ${env.GIT_SHA}`,
    isMockBuild: env.APP_MODE === 'mock',
    colors: COLORS,
    selectedColor: COLORS[0],
    colorName: COLORS[0].short,
    colorNumber: 1,
    showColorPicker: false,
    showImpersonation: false,
    impersonating: false,
    keyboardStyle: '',
  }),

  onLoad() {
    this._name = '';
    this._company = '';
    this._phone = '';
    this._code = '';
    this._impToken = '';
    this._originalColorKey = '';
    const snapshot = store.snapshot();
    this.setData(colorState(snapshot.colorKey));
    this.load();
  },

  onShow() {
    if (!this.data.showColorPicker) {
      const snapshot = store.snapshot();
      this.setData(colorState(snapshot.colorKey));
    }
  },

  onUnload() {
    if (this._timer) clearInterval(this._timer);
    if (this._originalColorKey) store.setColor(this._originalColorKey, false);
  },

  async load() {
    const me = await store.loadMe();
    if (!me) return;
    const user = me.user || {};
    const tenant = me.tenant || {};
    this._name = user.name || '';
    this._company = tenant.name || '';
    this.setData(Object.assign({
      name: user.name || '',
      company: tenant.name || '',
      phone: user.phone || '',
      phoneDisplay: user.phone || '未绑定',
      wechatLinked: Boolean(user.wechatLinked),
      avatarUrl: user.avatarUrl || '',
    }, colorState(store.snapshot().colorKey)));
  },

  back() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) });
  },

  openDoc(event) {
    const doc = String(event.currentTarget.dataset.doc || 'agreement');
    if (!['agreement', 'privacy', 'refund'].includes(doc)) return;
    if (!navTo(`/packages/main/legal/index?doc=${doc}`)) wx.showToast({ title: '页面正在打开，请稍候', icon: 'none' });
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '确定退出当前账号？',
      success: (result) => {
        if (!result.confirm) return;
        store.resetAuth();
        wx.reLaunch({ url: '/pages/sessions/index' });
      },
    });
  },

  inputName(event) { this._name = event.detail.value; },
  inputCompany(event) { this._company = event.detail.value; },
  inputPhone(event) { this._phone = event.detail.value; },
  inputCode(event) { this._code = event.detail.value; },

  async saveIdentity() {
    if (this.data.saving) return;
    const name = String(this._name || '').trim();
    const company = String(this._company || '').trim();
    if (!name) { wx.showToast({ title: '请输入称呼', icon: 'none' }); return; }
    this.setData({ saving: true });
    try {
      await api.updateIdentity({ name, company });
      await this.load();
      wx.showToast({ title: '已保存', icon: 'none' });
    } catch (error) {
      store.handleApiError(error, { fallbackTitle: error.message || '保存失败' });
    } finally {
      this.setData({ saving: false });
    }
  },

  async chooseAvatar(event) {
    if (this.data.uploading) return;
    const filePath = event && event.detail && event.detail.avatarUrl;
    if (!filePath) {
      wx.showToast({ title: '未取得头像，请重新选择', icon: 'none' });
      return;
    }
    this.setData({ uploading: true, avatarUrl: filePath });
    try {
      const value = await api.uploadAvatar(filePath);
      this.setData({ avatarUrl: value.avatarUrl || filePath });
      wx.showToast({ title: '头像已更新', icon: 'none' });
    } catch (error) {
      await this.load().catch(() => {});
      store.handleApiError(error, { fallbackTitle: error.message || '上传失败' });
    } finally {
      this.setData({ uploading: false });
    }
  },

  async sendCode() {
    const phone = String(this._phone || '').trim();
    if (!/^1\d{10}$/.test(phone)) { wx.showToast({ title: '请输入正确手机号', icon: 'none' }); return; }
    if (this.data.sent > 0 || this.data.codeSending) return;
    this.setData({ codeSending: true });
    try {
      const result = await api.sendSmsCode(phone, 'bind');
      if (result.devCode) this._code = result.devCode;
      this.setData({ codeSending: false, sent: Number(result.cooldownSec) || 60 });
      this._timer = setInterval(() => {
        const sent = Math.max(0, this.data.sent - 1);
        this.setData({ sent });
        if (!sent) { clearInterval(this._timer); this._timer = null; }
      }, 1000);
      wx.showToast({ title: result.devCode ? `演示验证码 ${result.devCode}` : '验证码已发送', icon: 'none' });
    } catch (error) {
      this.setData({ codeSending: false });
      wx.showToast({ title: error.message || '发送失败', icon: 'none' });
    }
  },

  async bindPhone() {
    const phone = String(this._phone || '').trim();
    const code = String(this._code || '').trim();
    if (!/^1\d{10}$/.test(phone) || !/^\d{4,8}$/.test(code)) {
      wx.showToast({ title: '请填写手机号和验证码', icon: 'none' });
      return;
    }
    this.setData({ binding: true });
    try {
      const result = await api.bindPhone(phone, code);
      this.setData({ phoneDisplay: result.phone || phone, wechatLinked: Boolean(result.wechatLinked) });
      wx.showToast({ title: '联系方式已更新', icon: 'none' });
    } catch (error) {
      store.handleApiError(error, { fallbackTitle: error.message || '绑定失败' });
    } finally {
      this.setData({ binding: false });
    }
  },

  openColorPicker() {
    const key = store.snapshot().colorKey;
    this._originalColorKey = key;
    this.setData(Object.assign({ showColorPicker: true }, colorState(key)));
  },

  selectColor(event) {
    const key = String(event.currentTarget.dataset.key || '');
    if (!isColorKey(key)) return;
    store.setColor(key, false);
    this.setData(colorState(key));
  },

  closeColorPicker() {
    const key = this._originalColorKey || store.snapshot().colorKey;
    store.setColor(key, false);
    this._originalColorKey = '';
    this.setData(Object.assign({ showColorPicker: false }, colorState(key)));
  },

  confirmColor() {
    const key = this.data.colorKey;
    store.setColor(key, true);
    this._originalColorKey = '';
    this.setData(Object.assign({ showColorPicker: false }, colorState(key)));
    wx.showToast({ title: '本命色已更新', icon: 'none' });
  },

  openImpersonation() {
    if (this.data.impersonating) return;
    this._impToken = '';
    this.setData({ showImpersonation: true, keyboardStyle: '' });
  },

  inputImpersonation(event) {
    this._impToken = event.detail.value;
  },

  impersonationKeyboard(event) {
    const height = Math.max(0, Number(event.detail && event.detail.height) || 0);
    this.setData({ keyboardStyle: height ? `margin-bottom:${height}px` : '' });
  },

  closeImpersonation() {
    if (this.data.impersonating) return;
    this._impToken = '';
    this.setData({ showImpersonation: false, keyboardStyle: '' });
  },

  async submitImpersonation() {
    const token = String(this._impToken || '').trim();
    if (!token) { wx.showToast({ title: '请先粘贴令牌', icon: 'none' }); return; }
    if (this.data.impersonating) return;
    this.setData({ impersonating: true });
    try {
      // 先隔离验令，成功后才覆盖 storage；失败绝不触碰当前身份。
      const me = await api.verifyImpersonation(token);
      if (!me || !me.user) throw Object.assign(new Error('令牌返回的身份不完整'), { code: 'INVALID_TOKEN' });
      const onboarded = typeof me.onboarded === 'boolean' ? me.onboarded : true;
      await store.afterLogin({ token, onboarded, user: me.user });
      this._impToken = '';
      this.setData({ showImpersonation: false, impersonating: false, keyboardStyle: '' });
      wx.reLaunch({ url: '/pages/sessions/index' });
    } catch (error) {
      const title = error && error.code === 'NETWORK_ERROR'
        ? (error.message || '网络不稳，稍后再试')
        : '令牌无效或已失效';
      wx.showToast({ title, icon: 'none' });
      this.setData({ impersonating: false });
    }
  },

  noop() {},

  deleteAccount() {
    wx.showModal({
      title: '删除账号',
      content: '账号、案卷、资料与历史方案将永久删除且无法恢复。确认继续？',
      confirmText: '删除账号',
      confirmColor: '#9C4A38',
      success: (first) => {
        if (!first.confirm) return;
        wx.showModal({
          title: '最后确认',
          content: '此操作不可恢复。再次确认删除全部账号数据。',
          confirmText: '永久删除',
          confirmColor: '#9C4A38',
          success: async (second) => {
            if (!second.confirm) return;
            try {
              await api.deleteAccount();
              store.resetAuth();
              wx.reLaunch({ url: '/pages/sessions/index' });
            } catch (error) {
              store.handleApiError(error, { fallbackTitle: error.message || '删除失败' });
            }
          },
        });
      },
    });
  },
});
