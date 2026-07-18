export default defineAppConfig({
  lazyCodeLoading: 'requiredComponents',
  pages: [
    'pages/counsel/index',
    'pages/home/index',
    'pages/junling/index',
    'pages/satchel/index',
    'pages/profile/index',
    'pages/sessions/index',
    'pages/studio/index',
  ],
  subpackages: [
    {
      // 主包瘦身：chat（最大单页）/brief/settings 三个非 tabBar 高频页迁入分包，主包只保留 5 个 tabBar 页。
      root: 'packages/main',
      pages: [
        'chat/index',
        'brief/index',
        'settings/index',
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
    // chat 已迁入 packages/main：从入口 tab 预下载 main 分包，保证「问策/军情/往来」进对话不卡首屏。
    'pages/counsel/index': {
      network: 'wifi',
      packages: ['packages/main'],
    },
    'pages/sessions/index': {
      network: 'wifi',
      packages: ['packages/main'],
    },
    'pages/home/index': {
      network: 'wifi',
      packages: ['packages/main', 'packages/work'],
    },
    'pages/junling/index': {
      network: 'wifi',
      packages: ['packages/work'],
    },
    'pages/satchel/index': {
      network: 'all',
      packages: ['packages/work'],
    },
    'pages/profile/index': {
      network: 'all',
      packages: ['packages/work', 'packages/main'],
    },
  },
  window: {
    backgroundTextStyle: 'dark',
    navigationBarBackgroundColor: '#FAF7EF',
    navigationBarTitleText: 'AI 军师',
    navigationBarTextStyle: 'black',
    backgroundColor: '#EBE4D5',
  },
  tabBar: {
    custom: true,
    color: '#A79E8C',
    selectedColor: '#211F1A',
    backgroundColor: '#FAF7EF',
    list: [
      { pagePath: 'pages/counsel/index', text: '问策' },
      { pagePath: 'pages/home/index', text: '军情' },
      { pagePath: 'pages/junling/index', text: '军令' },
      { pagePath: 'pages/satchel/index', text: '锦囊' },
      { pagePath: 'pages/profile/index', text: '主公' },
    ],
  },
});
