export default defineAppConfig({
  lazyCodeLoading: 'requiredComponents',
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
        'bindings/index',
        'market/index',
        'community/index',
        'gift/index',
        'calendar/index',
        'dossier/index',
        'ledger/index',
        'quickscan/index',
        'brandkit/index',
        'webview/index',
        'command/index',
        'reminders/index',
      ],
    },
  ],
  preloadRule: {
    // chat 已迁入 packages/main：从入口 tab 预下载 main 分包，保证「问策/军情」进对话不卡首屏。
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
      { pagePath: 'pages/home/index', text: '军情' },
      { pagePath: 'pages/studio/index', text: '军令' },
      { pagePath: 'pages/thinktank/index', text: '锦囊' },
      { pagePath: 'pages/profile/index', text: '老板' },
    ],
  },
});
