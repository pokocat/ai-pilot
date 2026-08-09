const store = require('./services/store');
const { loadAppFont } = require('./services/font');

App({
  globalData: {
    launchedAt: Date.now(),
  },

  onLaunch() {
    store.bootstrap();
    loadAppFont(); // 自带衬线字体，异步加载、失败静默（见 services/font.js）
  },
});
