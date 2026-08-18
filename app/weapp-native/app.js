const store = require('./services/store');
const { loadAppFont } = require('./services/font');
const { captureInvite } = require('./services/invite');

App({
  globalData: {
    launchedAt: Date.now(),
  },

  /**
   * 冷启动。
   *
   * 邀请码捕获放在最前面：分享卡带的 `?ic=` 与小程序码的 scene 都只在这一次启动参数里出现，
   * 后面任何一步抛错都不该把它丢掉（见 services/invite.js）。
   *
   * **这里刻意没有任何跳转或登录弹层**——2026-08-05 微信审核整改后启动一律落首页、游客可浏览
   * （驳回原因正是「未浏览体验服务即要求授权登录」）。捕获到邀请码只是记一笔，
   * 什么时候登录仍然完全由用户的动作决定；**不要在这里加回任何自动跳转**。
   */
  onLaunch(options) {
    captureInvite(options || {});
    store.bootstrap();
    loadAppFont(); // 自带衬线字体，异步加载、失败静默（见 services/font.js）
  },

  /**
   * 每次回到前台也捕获一次：小程序已在后台时，用户从另一张分享卡再次进入走的是 onShow
   * 而不是 onLaunch，只在 onLaunch 捕获会漏掉这条路径。
   */
  onShow(options) {
    captureInvite(options || {});
  },
});
