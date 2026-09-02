// 屏 07 · 第 3 步 出片确认。
//
// 这一屏是扣费前的最后一道闸。方案 §8.0 要求：preflight 不过 → **不 hold、不建单、不产假数据**。
// 端上先跑一遍 model.preflight 省一次往返，服务端仍会再校验一次（端上校验不是安全边界）。
const host = require('../host');
const api = require('../api');
const model = require('../model');
const { withShare } = require('../../../services/share');

Page(withShare({
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
    aiWatermark: false,
    watermarkSaving: false,
    coverSummary: { state: 'off', text: '不加封面' },
    submitting: false,
    showLogin: false,
  }),

  onLoad(options) {
    const projectId = String((options && options.projectId) || '');
    if (!projectId) { host.toast('打不开这个项目'); host.back(); return; }
    this.setData({ projectId });
    this.newRenderRequestId();
    this.load();
  },

  load() {
    Promise.all([
      api.project(this.data.projectId),
      api.avatars().catch(() => []),
    ]).then(([project, avatars]) => {
      const avatar = (Array.isArray(avatars) ? avatars : []).find((item) => item.id === project.avatarId) || null;
      const check = model.preflight(project, avatar);
      const local = model.estimateCredits(project.segments, project.shots);
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
        aiWatermark: !!(project.subtitleStyle && project.subtitleStyle.aiWatermark === true),
        watermarkSaving: false,
        coverSummary: model.coverSummary(project.cover),
      });

      // 服务端报价才是扣费口径，端上这份只用于首屏即时显示；拿到服务端结果后覆盖
      api.estimate(this.data.projectId, project.segments, project.shots)
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
            quoteError: error && error.message ? error.message : '价格核算失败，请重试',
          });
        });
    }).catch((error) => {
      this.setData({ loading: false });
      host.toast(error && error.message ? error.message : '打开失败');
    });
  },

  /**
   * 出片请求标识。
   *
   * 它的作用是幂等：同一次提交重试时服务端要认得出「这是同一单」，不能扣两次费。
   * 但**服务端对已退款的 hold 是拒绝复用的**（video.ts 的 CLIP_RENDER_REQUEST_CLOSED
   * 「该出片请求已经结束，请重新提交」）。以前这个 id 只在 onLoad 生成一次、失败后从不更新，
   * 于是提交撞上网络抖动后再点，就永远撞在那句话上 —— 这一页再也出不了片，
   * 用户只能退出确认页重新进来。这正是 2026-08-18 用户反馈里「提示…又要重新来一次」的同一类问题。
   *
   * 但**不是所有 HTTP 判决都是终态**：`CLIP_RENDER_CREATING`（409）说的是「原来那一单还在创建中」。
   * 这种时候换号，下一次点击就会再建一笔 hold、再建一个上游 job —— 正好是幂等机制要防的事。
   * 所以只有明确不可复用的状态才换号；仍在途的状态必须留着原标识。
   */
  /** 收到这些错误码时**保留**请求标识：原来那一单还活着，换号 = 重复下单。 */
  KEEP_REQUEST_ID_CODES: ['CLIP_RENDER_CREATING'],

  newRenderRequestId() {
    this.renderRequestId = `clip:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    return this.renderRequestId;
  },

  toggleAiWatermark(event) {
    if (this.data.watermarkSaving || !this.data.project) return;
    const previous = this.data.aiWatermark;
    const aiWatermark = !!(event && event.detail && event.detail.value);
    const subtitleStyle = Object.assign({}, this.data.project.subtitleStyle || {}, { aiWatermark });
    this.setData({ aiWatermark, watermarkSaving: true });
    api.saveProject(this.data.projectId, { subtitleStyle })
      .then((project) => {
        this.setData({
          project,
          aiWatermark: !!(project.subtitleStyle && project.subtitleStyle.aiWatermark === true),
          watermarkSaving: false,
        });
      })
      .catch((error) => {
        this.setData({ aiWatermark: previous, watermarkSaving: false });
        host.toast(error && error.message ? error.message : '水印设置保存失败');
      });
  },

  /** 封面是可选支线：去了再回来要把摘要刷新，不能还显示旧状态。 */
  goCover() {
    host.go(`/cover/index?projectId=${encodeURIComponent(this.data.projectId)}`);
  },

  onShow() {
    // 从封面页返回时只补摘要，不重跑 load()——那会把已拿到的服务端报价打回「核算中」
    if (this.data.loading || !this.data.project) return;
    api.project(this.data.projectId)
      .then((project) => this.setData({ project, coverSummary: model.coverSummary(project.cover) }))
      .catch(() => {});
  },

  submit() {
    if (!host.requireLogin(this, 'video')) return;
    if (this.data.loading || this.data.submitting || this.data.watermarkSaving) return;
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
        const code = (error && error.code) || '';
        const stillAlive = this.KEEP_REQUEST_ID_CODES.indexOf(code) >= 0;
        // 服务端给了明确判决、且这一单确实结束了 → 换新标识，用户再点一次就是干净的一单。
        // 纯网络失败（没有 statusCode）同样保留标识：那一单可能已经建上了，重试要能被认出来。
        if (error && error.statusCode && !stillAlive) this.newRenderRequestId();
        if (stillAlive) {
          host.toast('上一次提交还在处理，稍等一下再看「我的作品」');
          return;
        }
        if (code === 'CLIP_RENDER_REQUEST_CLOSED') {
          host.toast('刚才那次提交没成功，再点一次「确认出片」就行');
          return;
        }
        host.toast(error && error.message ? error.message : '提交失败');
      });
  },

  prev() { host.back(); },
  back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
}));
