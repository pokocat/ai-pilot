const TABS = [
  { path: '/pages/sessions/index', icon: 'conversation', text: '问策' },
  { path: '/pages/home/index', icon: 'flag', text: '军情' },
  { path: '/pages/studio/index', icon: 'token', text: '军令' },
  { path: '/pages/thinktank/index', icon: 'pouch', text: '锦囊' },
  { path: '/pages/profile/index', icon: 'crown', text: '老板' },
];

function toneOf(themeClass) {
  const tone = String(themeClass || '').replace(/^theme-/, '');
  return ['gold', 'green', 'red', 'blue', 'purple', 'iron'].includes(tone) ? tone : 'green';
}

function visualTabs(themeClass) {
  const activeTone = toneOf(themeClass);
  return TABS.map((item) => Object.assign({}, item, {
    iconNormal: `/assets/native-icons/${item.icon}-neutral.svg`,
    iconActive: `/assets/native-icons/${item.icon}-${activeTone}.svg`,
  }));
}

Component({
  data: { tabs: visualTabs('theme-green'), selected: 0, themeClass: 'theme-green', unread: 0, reviewDue: false, overlay: false },
  methods: {
    syncState(next) {
      const themeClass = (next && next.themeClass) || this.data.themeClass;
      this.setData(Object.assign({}, next || {}, { themeClass, tabs: visualTabs(themeClass) }));
    },
    switchTab(event) {
      const index = Number(event.currentTarget.dataset.index);
      if (index === this.data.selected) return;
      wx.switchTab({ url: TABS[index].path });
    },
  },
});
