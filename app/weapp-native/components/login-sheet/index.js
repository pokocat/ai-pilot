const { api } = require('../../services/api');
const store = require('../../services/store');

const REASONS = {
  chat: '登录后才能发送消息，并把本次判断留在你的案卷里。',
  history: '登录后才能查看只属于你的历史会话。',
  search: '登录后才能搜索你的案卷、方案与资料。',
  upload: '登录后才能上传并整理你的经营资料。',
  save: '登录后才能保存方案。',
  execute: '登录后才能生成和跟进军令。',
  purchase: '登录后才能确认方案、查看折抵并发起支付。',
  profile: '登录后才能查看和维护你的个人档案。',
  'view-history': '登录后才能查看只属于你的历史记录。',
};

Component({
  properties: {
    open: { type: Boolean, value: false },
    reason: { type: String, value: 'chat' },
  },
  data: {
    stage: 'wechat', agreed: false, busy: false,
    phone: '', code: '', sent: 0, codeSending: false,
    avatarLocal: '', avatarShown: '', nickname: '', nameFocus: false, pendingOnboarded: false,
    closeTop: 18, closeRight: 18, reasonText: REASONS.chat,
  },
  observers: {
    'open,reason': function(open, reason) {
      store.setOverlay(Boolean(open), 'login-sheet');
      if (!open) return;
      let closeTop = 18; let closeRight = 18;
      try {
        const rect = wx.getMenuButtonBoundingClientRect();
        const win = wx.getWindowInfo();
        closeTop = Math.max(rect.top + ((rect.height || 32) - 36) / 2, (win.statusBarHeight || 0) + 2);
        closeRight = Math.max(win.windowWidth - rect.left + 12, 18);
      } catch (_) { /* 旧基础库走默认值 */ }
      this._onboardingScheduled = false;
      this.setData({
        stage: 'wechat', closeTop, closeRight, reasonText: REASONS[reason] || REASONS.chat,
        avatarLocal: '', avatarShown: '', nickname: '', nameFocus: false, pendingOnboarded: false,
        phone: '', code: '', sent: 0,
      });
    },
  },
  lifetimes: {
    detached() {
      if (this._timer) clearInterval(this._timer);
      if (this._onboardingTimer) clearTimeout(this._onboardingTimer);
      store.setOverlay(false, 'login-sheet');
    },
  },
  methods: {
    stop() {},
    close() { if (!this.data.busy && this.data.stage !== 'complete') this.triggerEvent('close'); },
    toggleAgree() { this.setData({ agreed: !this.data.agreed }); },
    switchPhone() { if (!this.data.busy) this.setData({ stage: 'phone' }); },
    switchWechat() { if (!this.data.busy) this.setData({ stage: 'wechat' }); },
    openAgreement() { wx.navigateTo({ url: '/packages/main/legal/index?doc=agreement' }); },
    openPrivacy() { wx.navigateTo({ url: '/packages/main/legal/index?doc=privacy' }); },
    inputPhone(event) { this.setData({ phone: event.detail.value }); },
    inputCode(event) { this.setData({ code: event.detail.value }); },
    ensureAgreed() {
      if (this.data.agreed) return true;
      wx.showToast({ title: '请先阅读并勾选同意用户协议与隐私政策', icon: 'none' });
      return false;
    },
    finishAuth(onboarded) {
      const done = Boolean(onboarded);
      this.triggerEvent('loggedin', { onboarded: done });
      if (done || this._onboardingScheduled) return;
      this._onboardingScheduled = true;
      this._onboardingTimer = setTimeout(() => {
        const pages = getCurrentPages();
        if (pages.some((page) => String(page.route || '').includes('packages/main/onboarding'))) return;
        wx.navigateTo({ url: '/packages/main/onboarding/index' });
      }, 80);
    },
    presentAfterAuth(result) {
      const me = store.snapshot().me;
      const user = me && me.user || {};
      const name = String(user.name || '').trim();
      if (!name) {
        this.setData({
          stage: 'complete', nickname: '', avatarLocal: '', avatarShown: user.avatarUrl || '',
          nameFocus: false, pendingOnboarded: Boolean(result && result.onboarded),
        });
        return;
      }
      this.finishAuth(result && result.onboarded);
    },
    async submitWechatPhone(event) {
      if (this.data.busy || !this.ensureAgreed()) return;
      const phoneCode = event && event.detail && event.detail.code;
      if (!phoneCode) {
        wx.showToast({ title: '未取得手机号，可改用短信验证码登录', icon: 'none' });
        return;
      }
      this.setData({ busy: true });
      try {
        const loginResult = await new Promise((resolve, reject) => wx.login({
          success: resolve,
          fail: reject,
        }));
        // 面向用户的文案一律不出现平台名（审核口径：登录页不得混淆腾讯官方元素，2026-08-08 驳回）。
        if (!loginResult.code) throw new Error('快捷登录未能取得凭证，请重试');
        const result = await api.wechatPhoneLogin(phoneCode, loginResult.code);
        await store.afterLogin(result);
        this.presentAfterAuth(result);
      } catch (error) {
        const code = error && error.data && error.data.code;
        wx.showToast({
          title: code === 'WECHAT_CONFIG_MISSING' ? '当前环境未开通快捷登录，请用短信验证码登录' : (error.message || '手机号快捷登录失败'),
          icon: 'none',
        });
      } finally { this.setData({ busy: false }); }
    },
    async sendCode() {
      if (!/^1\d{10}$/.test(this.data.phone)) {
        wx.showToast({ title: '请输入正确手机号', icon: 'none' }); return;
      }
      if (this.data.sent > 0 || this.data.codeSending) return;
      this.setData({ codeSending: true });
      try {
        const result = await api.sendSmsCode(this.data.phone, 'login');
        const sent = Number(result.cooldownSec) || 60;
        const next = { sent, codeSending: false };
        if (result.devCode) next.code = result.devCode;
        this.setData(next);
        wx.showToast({ title: result.devCode ? `演示验证码已填入：${result.devCode}` : '验证码已发送', icon: 'none' });
        this._timer = setInterval(() => {
          const value = Math.max(0, this.data.sent - 1);
          this.setData({ sent: value });
          if (!value) { clearInterval(this._timer); this._timer = null; }
        }, 1000);
      } catch (error) {
        this.setData({ codeSending: false });
        wx.showToast({ title: error.message || '验证码发送失败', icon: 'none' });
      }
    },
    async submitPhone() {
      if (!/^1\d{10}$/.test(this.data.phone)) { wx.showToast({ title: '请输入正确手机号', icon: 'none' }); return; }
      if (!/^\d{4,8}$/.test(this.data.code)) { wx.showToast({ title: '请输入短信验证码', icon: 'none' }); return; }
      if (this.data.busy || !this.ensureAgreed()) return;
      this.setData({ busy: true });
      try {
        const result = await api.login(this.data.phone, this.data.code);
        await store.afterLogin(result);
        this.presentAfterAuth(result);
      } catch (error) {
        const code = error && (error.code || (error.data && error.data.code));
        if (code === 'NETWORK_ERROR') {
          const snapshot = store.snapshot();
          const onboarded = Boolean(snapshot.onboarded);
          await store.afterLogin({
            token: `local-${this.data.phone}`,
            onboarded,
            user: { benmingColor: snapshot.colorKey || 'green' },
          });
          this.presentAfterAuth({ onboarded });
        } else {
          wx.showToast({ title: error.message || '登录失败，请重试', icon: 'none' });
        }
      } finally { this.setData({ busy: false }); }
    },
    chooseAvatar(event) {
      const filePath = event && event.detail && event.detail.avatarUrl;
      if (!filePath) return;
      this.setData({ avatarLocal: filePath, avatarShown: filePath, nameFocus: !String(this.data.nickname || '').trim() });
    },
    inputNickname(event) { this.setData({ nickname: event.detail.value }); },
    blurNickname(event) { this.setData({ nickname: event.detail.value, nameFocus: false }); },
    async finishComplete() {
      if (this.data.busy) return;
      const name = String(this.data.nickname || '').trim();
      if (!name) {
        wx.showToast({ title: '请填写你的称呼', icon: 'none' });
        this.setData({ nameFocus: true });
        return;
      }
      this.setData({ busy: true });
      try {
        await api.updateIdentity({ name });
        const avatar = String(this.data.avatarLocal || '');
        if (avatar) {
          try {
            if (/^https?:\/\//.test(avatar)) await api.updateIdentity({ avatarUrl: avatar });
            else await api.uploadAvatar(avatar);
          } catch (_) {
            wx.showToast({ title: '头像稍后可在设置中重试', icon: 'none' });
          }
        }
        await store.loadMe();
        this.finishAuth(this.data.pendingOnboarded);
      } catch (error) {
        store.handleApiError(error, { fallbackTitle: '称呼保存失败，请重试' });
      } finally { this.setData({ busy: false }); }
    },
    logoutComplete() {
      if (this.data.busy) return;
      store.resetAuth();
      store.setOverlay(true, 'login-sheet');
      this.setData({ stage: 'wechat', avatarLocal: '', avatarShown: '', nickname: '', nameFocus: false, pendingOnboarded: false, phone: '', code: '' });
    },
  },
});
