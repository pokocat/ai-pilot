/**
 * 程序性写入原生输入框的「时机」判定（纯函数，供聊天页 writeInput 用，可单测）。
 *
 * 背景（2026-08-03 H5 走查复现）：聊天页的 Textarea 已解除受控，程序性写入（草稿恢复 / 粘贴归卷回填 /
 * 发送清空）走 ref 直写 value。但 h5 下 Taro <Textarea> 是 Stencil 组件，其 value 的
 * `@Watch('value') watchValue` 直读 `this.textareaRef.value` —— 没有空判（同文件上一个
 * watchAutoFocus 用的是 `?.`）。而 Stencil 首帧渲染是异步的：内部 <textarea> 尚未挂上时写 value，
 * watchValue 立刻抛 `TypeError: Cannot read properties of undefined (reading 'value')`。
 * 该异常被 Stencil 自己 catch 成一行 console.error（外层 try/catch 兜不住），表现是
 * 「带草稿进聊天页，控制台必留一条看着像崩溃的报错」——loadDraft 在 initChat 里跑，本就早于首帧。
 *
 * 故写入前先判一次：原生节点没就绪就下一帧重试，不硬写。值此刻已在 React state 里，不会丢。
 */
export type NativeWriteStep = 'write' | 'retry' | 'drop';

export interface NativeWriteInput {
  /** ref 是否已挂上元素 */
  hasEl: boolean;
  /** 原生节点是否已就绪：h5 看 Stencil 是否渲染出内部 <textarea>；weapp 的 FormElement 无此结构，恒 true */
  elRendered: boolean;
  /** 本次写入是否已作废（期间用户又输入 / 又有一次程序性写入） */
  stale: boolean;
  /** 已重试次数 */
  tries: number;
  /** 重试上限；等不到就放弃，不无限排定时器 */
  maxTries: number;
}

export function nativeWriteStep({ hasEl, elRendered, stale, tries, maxTries }: NativeWriteInput): NativeWriteStep {
  // 作废优先：陈旧的重试写回去会把用户新敲的字覆盖掉。
  if (stale) return 'drop';
  if (!hasEl || !elRendered) return tries >= maxTries ? 'drop' : 'retry';
  return 'write';
}
