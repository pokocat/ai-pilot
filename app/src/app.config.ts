export default defineAppConfig({
  pages: [
    'pages/counsel/index',
    'pages/home/index',
    'pages/junling/index',
    'pages/satchel/index',
    'pages/profile/index',
    'pages/chat/index',
    'pages/sessions/index',
    'pages/studio/index',
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
        'dossier/index',
        'ledger/index',
        'webview/index',
      ],
    },
  ],
  preloadRule: {
    'pages/profile/index': {
      network: 'all',
      packages: ['packages/work'],
    },
    'pages/satchel/index': {
      network: 'all',
      packages: ['packages/work'],
    },
    'pages/home/index': {
      network: 'wifi',
      packages: ['packages/work'],
    },
    'pages/junling/index': {
      network: 'wifi',
      packages: ['packages/work'],
    },
    'pages/chat/index': {
      network: 'wifi',
      packages: ['packages/work'],
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
