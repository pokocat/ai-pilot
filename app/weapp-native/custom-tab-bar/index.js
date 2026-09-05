// 底栏渲染壳。tab 表、主题态图标解析与切换动作已全部抽到 services/tabbar.js，
// 与桌面左导航 components/nav-rail、问策终态浮岛里那排自绘 tab 同源（见该文件顶部说明）。
const { visualTabs, switchToTab } = require('../services/tabbar');

Component({
  data: { tabs: visualTabs('theme-green'), selected: 0, themeClass: 'theme-green', unread: 0, reviewDue: false, overlay: false },
  methods: {
    syncState(next) {
      const themeClass = (next && next.themeClass) || this.data.themeClass;
      this.setData(Object.assign({}, next || {}, { themeClass, tabs: visualTabs(themeClass) }));
    },
    switchTab(event) {
      switchToTab(Number(event.currentTarget.dataset.index), this.data.selected);
    },
  },
});
