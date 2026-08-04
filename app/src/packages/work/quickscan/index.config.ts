export default {
  navigationStyle: 'custom',
  navigationBarTitleText: '速诊',
  // 本页有 useShareAppMessage + <Button openType="share">，必须显式开启转发能力：
  // Taro 运行时只在页面 config 带此标记时才注册 onShareAppMessage，缺了它自定义的
  // 转发标题/路径全部失效（转发出去是默认标题与当前路径）。calendar / mingpan 早已带上，
  // 本页漏了 —— 页内那颗「转发给朋友」按钮此前是坏的。
  enableShareAppMessage: true,
};
