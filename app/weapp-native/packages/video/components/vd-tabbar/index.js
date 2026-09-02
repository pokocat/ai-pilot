// 快出片自己的四 tab 底栏（设计稿 Home / Profile 底部）。
// 军师的 tabBar 是宿主的五个 tab，本分包在里面没有位置；独立形态下这一条会换成真 tabBar，
// 所以把它做成组件、只依赖 host.replace，抽走时零改动。
const host = require('../../host');
const TABS = [
  { key: 'home', label: '创作', path: 'home/index?tab=1' },
  { key: 'assets', label: '资料库', path: 'assets/index?tab=1' },
  { key: 'works', label: '作品', path: 'works/index?tab=1' },
  { key: 'profile', label: '我的', path: 'profile/index' },
];
Component({
  properties: { current: { type: String, value: 'home' } },
  data: { tabs: TABS },
  methods: {
    tap(e) {
      const key = e.currentTarget.dataset.key;
      if (key === this.data.current) return;
      const tab = TABS.find((t) => t.key === key); if (!tab) return;
      // 资料库 / 作品 / 我的 都要登录；创作对游客开放
      if (key !== 'home' && !host.isLoggedIn()) { this.triggerEvent('needlogin'); return; }
      host.replace(tab.path);
    },
  },
});
