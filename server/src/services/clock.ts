// 可注入时钟（D9 可测性预留）。业务侧一切「到期判断 / 月度锚点重置 / 剩余天数折算」都读这里的 now()，
// 不直接用 new Date()，以便沙箱下用 x-test-now 头快进时间、离线端到端验证有效期与降级。
//
// 实现：用 AsyncLocalStorage 把「本次请求的现在」挂在异步上下文里，默认回退真实时钟。
// 仅沙箱（sandboxEnabled）模式下，app.ts 的 onRequest hook 才会注入覆盖值；生产恒为真实时钟。
//
// 注意：微信 v3 请求签名 / paySign 的时间戳仍用真实 Date.now()（那是对外签名，不能被业务时钟篡改）——
// 本时钟只服务于「我方记账的有效期 / 重置」语义。

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<Date>();

/** 服务端可信「现在」（UTC 语义）。沙箱可覆盖；生产恒为真实时钟。 */
export function now(): Date {
  return store.getStore() ?? new Date();
}

/** 在固定时刻 at 内同步/异步执行 fn（脚本、测试构造时间用）。 */
export function runWithNow<T>(at: Date, fn: () => T): T {
  return store.run(at, fn);
}

/** 把「当前异步上下文（如一次 HTTP 请求）」的现在固定为 at。供 Fastify onRequest hook 注入。 */
export function enterNow(at: Date): void {
  store.enterWith(at);
}
