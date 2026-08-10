// 业务层 → UI 的单向提示通道。
// services/store 报错时调 platform.toast（不认识 React），App 挂载时把自己的 Toast 注册进来。
// 单独成模块是为了避免 main.tsx（注册 platform）与 App.tsx（渲染 Toast）互相 import 成环。

let sink: ((message: string) => void) | null = null;

export function bindToast(fn: (message: string) => void): void {
  sink = fn;
}

export function pushToast(message: string): void {
  sink?.(message);
}
