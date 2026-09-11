// 问策对话分包页：只保留页面宿主专属的东西——导航参数解析、页头、返回键、页头菜单。
// 消息加载/发送/SSE 流式/生成态/粘贴归卷/asks 问答卡等对话核心全部来自主包 chat-core/behavior.js。
const { baseData, syncViewport } = require('../../../services/page');
const { chatCore, useStreamRenderer, decodeOption } = require('../../../chat-core/behavior');
const {
  setMdText,
  setStreamFinish,
  stopImmediatelyCb,
} = require('../vendor/towxml/globalCb');
const { withShare } = require('../../../services/share');

// towxml 留在本分包（packages/main/vendor/towxml），主包的 chat-core 不能反向引用它，
// 所以由同包的本页把流式打字机回调注入给对话核心。
useStreamRenderer({ setMdText, setStreamFinish, stopImmediatelyCb });

Page(withShare({
  behaviors: [chatCore],
  data: baseData({}),
  onLoad(options) {
    this.chatCoreLoad({
      sessionId: options.sessionId || '',
      agentKey: options.agentKey || 'general',
      projectId: options.projectId || '',
      continueLatest: options.continue === '1' && options.fresh !== '1',
      pendingPrompt: options.send ? decodeOption(options.send) : decodeOption(options.prompt),
    });
  },
  // 桌面窗口拉伸/最大化、iPad 旋转：与五个主 Tab 同一条官方链路，按窗口宽度重挂档位。
  // 这一页是问策侧栏里点任何一位军师之后落地的地方，没有它，对话在 1400px 的窗口里
  // 会一路铺满——正文行长比手机上宽三倍，谁都读不下去。
  onResize(event) { syncViewport(this, event && event.size); },
  // 这一页是 navigateTo 落地的普通页：点「查看报告」/海报/方案卡会 navTo 盖一页上来，
  // 只触发 onHide、不触发 onUnload。若不在这里停自动滚底，流式还没结束时那个每 180ms
  // 一次的 toBottom()+setData 会一直在被盖住的页上空转（微信后台 setData 告警 + 烧 CPU），
  // 直到流结束或页真正卸载。与 pages/sessions/index.js 同一套（chatCoreHide/Show 自带守卫）。
  onHide() { this.chatCoreHide(); },
  onShow() { this.chatCoreShow(); },
  onUnload() { this.chatCoreUnload(); },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/sessions/index' }) }); },
  openChatMenu() {
    wx.showActionSheet({ itemList: ['整理本轮为方案', '引用已有资产', '开启新对话'], success: (result) => { if (result.tapIndex === 0) this.summarizeChat(); else if (result.tapIndex === 1) this.openPicker(); else wx.redirectTo({ url: `/packages/main/chat/index?agentKey=${this._agentKey}&fresh=1` }); } });
  },
}));
