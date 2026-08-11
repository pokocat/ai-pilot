// 屏 07 · 第 3 步 出片确认。
//
// 这一屏是扣费前的最后一道闸。方案 §8.0 要求：preflight 不过 → **不 hold、不建单、不产假数据**。
// 端上先跑一遍 model.preflight 省一次往返，服务端仍会再校验一次（端上校验不是安全边界）。
const host = require('../host');
const api = require('../api');
const model = require('../model');

Page({
  data: host.hostBaseData({
    projectId: '',
    loading: true,
    project: null,
    avatar: null,
    estimate: null,
    quoteReady: false,
    quoteError: '',
    summary: null,
    totalText: '0:00',
    balance: null,
    afterBalance: null,
    problems: [],
    submitting: false,
    showLogin: false,
  }),

  onLoad(options) {
    const projectId = String((options && options.projectId) || '');
    if (!projectId) { host.toast('缺少项目参数'); host.back(); return; }
    this.setData({ projectId });
    this.renderRequestId = `clip:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    this.load();
  },

  load() {
    Promise.all([
      api.project(this.data.projectId),
      api.avatar().catch(() => null),
    ]).then(([project, avatar]) => {
      const check = model.preflight(project, avatar);
      const local = model.estimateCredits(project.segments);
      const me = host.currentUser();
      const mockBalance = api.mockCreditBalance();
      const balance = mockBalance != null
        ? mockBalance
        : (me && typeof me.creditBalance === 'number' ? me.creditBalance : null);

      this.setData({
        loading: false,
        project,
        avatar,
        estimate: null,
        quoteReady: false,
        quoteError: '',
        summary: local.summary,
        totalText: model.formatDuration(local.summary.totalSec),
        problems: check.problems,
        balance,
        afterBalance: null,
      });

      // 服务端报价才是扣费口径，端上这份只用于首屏即时显示；拿到服务端结果后覆盖
      api.estimate(this.data.projectId, project.segments)
        .then((remote) => {
          if (!remote || typeof remote.total !== 'number') return;
          this.setData({
            estimate: remote,
            quoteReady: true,
            quoteError: '',
            summary: remote.summary || this.data.summary,
            totalText: model.formatDuration((remote.summary || this.data.summary).totalSec),
            afterBalance: balance == null ? null : balance - remote.total,
          });
        })
        .catch((error) => {
          this.setData({
            estimate: null,
            quoteReady: false,
            quoteError: error && error.message ? error.message : '暂时无法取得服务端报价，请重试',
          });
        });
    }).catch((error) => {
      this.setData({ loading: false });
      host.toast(error && error.message ? error.message : '打开失败');
    });
  },

  submit() {
    if (!host.requireLogin(this, 'execute')) return;
    if (this.data.loading || this.data.submitting) return;
    if (!this.data.quoteReady || !this.data.estimate) { host.toast(this.data.quoteError || '还在核算价格，稍等一下'); return; }
    if (this.data.problems.length) { host.toast(this.data.problems[0].message); return; }

    const total = this.data.estimate ? this.data.estimate.total : 0;
    if (this.data.afterBalance != null && this.data.afterBalance < 0) {
      host.confirm({
        title: '积分不够',
        content: `这条片子需要 ${total} 积分，你还有 ${this.data.balance}。去充值吗？`,
        confirmText: '去充值',
      }).then((ok) => { if (ok) host.goHost('/packages/work/credits/index'); });
      return;
    }

    this.setData({ submitting: true });
    api.render(this.data.projectId, this.renderRequestId, total)
      .then((job) => {
        host.clearDraft(this.data.projectId);
        // redirectTo：出片已提交，不该让用户按返回again回到确认页重复下单
        wx.redirectTo({
          url: `${host.ROOT}/rendering/index?jobId=${encodeURIComponent(job.jobId)}&projectId=${encodeURIComponent(this.data.projectId)}`,
        });
      })
      .catch((error) => {
        this.setData({ submitting: false });
        host.toast(error && error.message ? error.message : '提交失败');
      });
  },

  prev() { host.back(); },
  back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
});
