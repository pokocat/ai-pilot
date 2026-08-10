// 动作级登录门的调度通道。
//
// 业务代码（各区的按钮、发送、上传）不该知道登录弹层住在哪、由谁渲染，
// 只需要问一句「现在能做这件事吗」。App 挂载时把真正的开弹层函数注册进来。
//
// 与 toastBridge 同一手法：单向、无 React 依赖，避免 UI 与业务互相 import 成环。

import { store } from '../services/store';
import type { AuthReason } from '../services/authGate';

let opener: ((reason?: AuthReason) => void) | null = null;

export function bindLoginGate(fn: (reason?: AuthReason) => void): void {
  opener = fn;
}

/** 主动唤起登录（已登录时什么也不做）。 */
export function promptLogin(reason?: AuthReason): void {
  if (store.isAuthed()) return;
  opener?.(reason);
}

/**
 * 动作前置闸：已登录返回 true，未登录弹登录并返回 false。
 * 用法：`if (!requireAuth('chat')) return;`
 */
export function requireAuth(reason?: AuthReason): boolean {
  if (store.isAuthed()) return true;
  opener?.(reason);
  return false;
}
