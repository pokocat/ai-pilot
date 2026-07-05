export default defineAppConfig({
  pages: [
    'pages/sessions/index',
    'pages/home/index',
    'pages/studio/index',
    'pages/thinktank/index',
    'pages/profile/index',
    'pages/chat/index',
    'pages/brief/index',
    'pages/settings/index',
  ],
  subpackages: [
    {
      root: 'packages/work',
      pages: [
        'library/index',
        'knowledge/index',
        'projects/index',
        'project/index',
        'report/index',
        'credits/index',
        'bindings/index',
        'market/index',
        'community/index',
        'gift/index',
        'calendar/index',
        'webview/index',
      ],
    },
  ],
  preloadRule: {
    'pages/profile/index': {
      network: 'all',
      packages: ['packages/work'],
    },
    'pages/thinktank/index': {
      network: 'all',
      packages: ['packages/work'],
    },
    'pages/chat/index': {
      network: 'wifi',
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
      { pagePath: 'pages/profile/index', text: '主公' },
    ],
  },
});
