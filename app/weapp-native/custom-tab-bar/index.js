// 底栏渲染壳。tab 表与主题态图标解析已抽到 services/tabbar.js，
// 与问策终态浮岛里那排自绘 tab 同源（见该文件顶部说明）。
const { TABS, visualTabs } = require('../services/tabbar');

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
