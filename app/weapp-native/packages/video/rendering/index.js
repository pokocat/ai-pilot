// 屏 08 · 正在出片。
//
// 石榴与 aidrama 都是**纯轮询、无回调**（方案 §3.1），所以这一屏靠 setInterval 拉进度。
// 两条必须遵守的小程序坑（见 apps/miniprogram/agent.md 网络段）：
//   1. onUnload / onHide 必须 clearInterval —— 否则页面切走任务还在跑，
//      还会触发「后台 setData 报警」。
//   2. 轮询要能被用户离开打断而不影响服务端出片 —— 文案明确「关掉小程序也不影响出片」。
const host = require('../host');
const api = require('../api');
const model = require('../model');
const { POLL_INTERVAL_MS } = require('../config');
const { withShare } = require('../../../services/share');

Page(withShare({
  data: host.hostBaseData({
    jobId: '',
    projectId: '',
    status: 'queued',
    progress: 0,
    stage: 'tts',
    stageRows: model.stageRows('tts', 0),
    etaText: '',
    failed: false,
    errorMessage: '',
    /* 出片完成的微信订阅。没有这一步的话，服务端按 scene='clip' 查额度永远查不到，
       通知一条也发不出去（额度是按 scene 存的，avatar 的额度不能被 clip 命中）。 */
    notifyTemplate: null,
    notifyRequesting: false,
    notifySubscribed: false,
  }),

  onLoad(options) {
    const jobId = String((options && options.jobId) || '');
    if (!jobId) { host.toast('缺少任务参数'); host.back(); return; }
    this.setData({ jobId, projectId: String((options && options.projectId) || '') });
    this.poll();
    this.startPolling();
    this.loadNotifyTemplate();
  },

  /** 模板没配就整块不显示 —— 摆一个点了没反应的按钮比没有更糟。 */
  loadNotifyTemplate() {
    api.subscribeTemplates()
      .then((result) => {
        const scenes = (result && result.scenes) || [];
        const template = scenes.find((item) => item && item.scene === 'clip') || null;
        this.setData({ notifyTemplate: template });
      })
      .catch(() => this.setData({ notifyTemplate: null }));
  },

  /**
   * 「出好了通知我」。
   *
   * 用户原话是「能不能看到大概什么时候完成」。准确 ETA 要先攒够各 stage 的耗时样本才敢给，
   * 但「不用一直盯着」这件事今天就能兑现：授权一次订阅，出好了微信推给他。
   * requestSubscribeMessage 必须由点击直接触发，不能放在 then 里，否则微信会拒。
   */
  requestNotify() {
    const template = this.data.notifyTemplate;
    if (!template || !template.templateId || this.data.notifyRequesting) return;
    this.setData({ notifyRequesting: true });
    wx.requestSubscribeMessage({
      tmplIds: [template.templateId],
      success: (res) => {
        const status = res && res[template.templateId] === 'accept' ? 'accept' : 'reject';
        api.recordSubscribeChoice({ scene: 'clip', templateId: template.templateId, status })
          .then(() => this.setData({ notifyRequesting: false, notifySubscribed: status === 'accept' }))
          .catch(() => this.setData({ notifyRequesting: false }));
        if (status !== 'accept') host.toast('没关系，留在这一页也能看到进度');
      },
      fail: () => {
        this.setData({ notifyRequesting: false });
        host.toast('这次没能开启通知，留在这一页也能看到进度');
      },
    });
  },

  onShow() { if (!this.timer && !this.data.failed && this.data.status !== 'succeeded') this.startPolling(); },
  onHide() { this.stopPolling(); },
  onUnload() { this.stopPolling(); },

  startPolling() {
    this.stopPolling();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  },

  stopPolling() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  },

  poll() {
    api.job(this.data.jobId)
      .then((job) => {
        if (!job) return;
        this.setData({
          status: job.status,
          stage: job.stage || this.data.stage,
          progress: job.progress || 0,
          stageRows: model.stageRows(job.stage || this.data.stage, job.progress || 0),
        });

        if (job.status === 'succeeded') {
          this.stopPolling();
          // redirectTo：出片完成后不该还能返回到进度页
          wx.redirectTo({ url: `${host.ROOT}/work/index?workId=${encodeURIComponent(job.workId || '')}` });
          return;
        }

        if (job.status === 'failed') {
          this.stopPolling();
          this.setData({ failed: true, errorMessage: job.errorMessage || '出片失败，积分已退回。' });
        }
      })
      .catch(() => {
        // 单次轮询失败不终止：网络抖动很常见，下一轮再试。
        // 真失败会由服务端把 job 置为 failed，走上面的分支。
      });
  },

  leave() {
    host.toast('出好了会在「我的作品」里');
    this.stopPolling();
    wx.redirectTo({ url: `${host.ROOT}/works/index` });
  },

  retry() {
    if (!this.data.projectId) { host.back(); return; }
    wx.redirectTo({ url: `${host.ROOT}/confirm/index?projectId=${encodeURIComponent(this.data.projectId)}` });
  },

  back() { host.back(); },
}));
