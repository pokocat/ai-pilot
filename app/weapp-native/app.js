const store = require('./services/store');

App({
  globalData: {
    launchedAt: Date.now(),
  },

  onLaunch() {
    store.bootstrap();
  },
});
