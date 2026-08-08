// 问策对话分包页：只保留页面宿主专属的东西——导航参数解析、页头、返回键、页头菜单。
// 消息加载/发送/SSE 流式/生成态/粘贴归卷/asks 问答卡等对话核心全部来自主包 chat-core/behavior.js。
const { baseData } = require('../../../services/page');
const { chatCore, useStreamRenderer, decodeOption } = require('../../../chat-core/behavior');
const {
  setMdText,
  setStreamFinish,
  stopImmediatelyCb,
} = require('../vendor/towxml/globalCb');

// towxml 留在本分包（packages/main/vendor/towxml），主包的 chat-core 不能反向引用它，
// 所以由同包的本页把流式打字机回调注入给对话核心。
useStreamRenderer({ setMdText, setStreamFinish, stopImmediatelyCb });

Page({
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
  onUnload() { this.chatCoreUnload(); },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/sessions/index' }) }); },
  openChatMenu() {
    wx.showActionSheet({ itemList: ['整理本轮为方案', '引用已有资产', '开启新对话'], success: (result) => { if (result.tapIndex === 0) this.summarizeChat(); else if (result.tapIndex === 1) this.openPicker(); else wx.redirectTo({ url: `/packages/main/chat/index?agentKey=${this._agentKey}&fresh=1` }); } });
  },
});
