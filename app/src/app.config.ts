export default defineAppConfig({
  lazyCodeLoading: 'requiredComponents',
  // 普通接口沿用 60s；生成/订阅自身仍显式传 180s。这里补全微信全局网络上限，
  // 避免某些基础库忽略单请求 timeout 后先于服务端 150s 预算断开。
  networkTimeout: { request: 180000, connectSocket: 60000, uploadFile: 120000, downloadFile: 120000 },
  pages: [
    'pages/sessions/index',
    'pages/home/index',
    'pages/studio/index',
    'pages/thinktank/index',
    'pages/profile/index',
  ],
  subpackages: [
    {
      // 主包瘦身：chat（最大单页）/brief/settings 三个非 tabBar 高频页迁入分包，主包只保留 5 个 tabBar 页。
      root: 'packages/main',
      pages: [
        'chat/index',
        'brief/index',
        'settings/index',
        'onboarding/index',
        'legal/index',
      ],
    },
    {
      root: 'packages/work',
      pages: [
        'library/index',
        'knowledge/index',
        'knowledge/detail/index',
        'projects/index',
        'project/index',
        'report/index',
        'credits/index',
        'plans/index',
        'bindings/index',
        'market/index',
        'community/index',
        'gift/index',
        'calendar/index',
        'mingpan/index',
        'dossier/index',
        'ledger/index',
        'quickscan/index',
        'brandkit/index',
        'webview/index',
        'command/index',
        'reminders/index',
        'daily/index',
        // 海报成品图（canvas_design）：需求单确认页 + 任务详情页，入口在对话页的海报设计师成果卡。
        'poster/index',
        'posterJob/index',
        // 作品库：历史成品图网格（+ 文字成果跳方案库）。入口在主公 tab「资产」组与点兵 tab「内容出品」区块。
        'gallery/index',
        // 新设计稿新增的三个业务面，入口都在主公 tab（账户权益格 + 档案菜单组）：
        // architecture=公司与事业架构、relations=人脉圈与持续记忆、enterprise=企业服务办理台。
        'architecture/index',
        'relations/index',
        'enterprise/index',
      ],
    },
  ],
  preloadRule: {
    // chat 已迁入 packages/main：从入口 tab 预下载 main 分包，保证「问策/沙盘」进对话不卡首屏。
    'pages/sessions/index': {
      network: 'wifi',
      packages: ['packages/main'],
    },
    'pages/home/index': {
      network: 'wifi',
      packages: ['packages/main'],
    },
    'pages/profile/index': {
      network: 'all',
      packages: ['packages/work', 'packages/main'],
    },
    'pages/thinktank/index': {
      network: 'all',
      packages: ['packages/work'],
    },
    // 对话页是海报成品图的唯一入口（成果卡「生成成品图」→ packages/work 的确认页/详情页）：
    // 在这里预下载 work 分包，点按钮时不必等分包下载。
    'packages/main/chat/index': {
      network: 'all',
      packages: ['packages/work'],
    },
  },
  window: {
    backgroundTextStyle: 'dark',
    navigationBarBackgroundColor: '#FBFAF6',
    navigationBarTitleText: 'AI 军师',
    navigationBarTextStyle: 'black',
    backgroundColor: '#F4F2EC',
  },
  tabBar: {
    custom: true,
    color: '#969BA1',
    selectedColor: '#16191D',
    backgroundColor: '#FBFAF6',
    list: [
      { pagePath: 'pages/sessions/index', text: '问策' },
      { pagePath: 'pages/home/index', text: '沙盘' },
      { pagePath: 'pages/studio/index', text: '点兵' },
      { pagePath: 'pages/thinktank/index', text: '锦囊' },
      { pagePath: 'pages/profile/index', text: '主公' },
    ],
  },
});
