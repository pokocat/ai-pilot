export default defineAppConfig({
  pages: [
    'pages/home/index',
    'pages/thinktank/index',
    'pages/sessions/index',
    'pages/studio/index',
    'pages/profile/index',
    'pages/chat/index',
  ],
  subpackages: [
    {
      root: 'packages/work',
      pages: [
        'library/index',
        'projects/index',
        'project/index',
        'report/index',
      ],
    },
  ],
  preloadRule: {
    'pages/profile/index': {
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
    navigationBarTitleText: '军师',
    navigationBarTextStyle: 'black',
    backgroundColor: '#F4F2EC',
  },
  tabBar: {
    custom: true,
    color: '#969BA1',
    selectedColor: '#16191D',
    backgroundColor: '#FBFAF6',
    list: [
      { pagePath: 'pages/home/index', text: '首页' },
      { pagePath: 'pages/thinktank/index', text: '智库' },
      { pagePath: 'pages/sessions/index', text: '对话' },
      { pagePath: 'pages/studio/index', text: '智能体' },
      { pagePath: 'pages/profile/index', text: '我的' },
    ],
  },
});
