// 历史点兵路径的过渡跳转页：接住老分享卡与外链，统一落到执行 tab 今日段；
// 留一个发布周期后可连注册一起删（app.json pages 里它已排在 tabBar 之外）。
Page({
  onShow() { require('../../services/nav').gotoExecution('today'); },
});
