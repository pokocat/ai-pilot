/**
 * 服务档位：这个进程要对外提供哪些面。
 *
 * 为什么需要它 —— 爱速拍现在**没有自己的服务端**：军师 BFF 同时接受 `junshi-api` 和
 * `quickreel-api` 两个 audience，是代管形态。代价在 2026-09-10 那次发布上真实付过：
 * 为了把爱速拍的六条分段路由发上生产，不得不把军师落后的十个提交（还有 admin）一起发。
 * 爱速拍的可用性因此绑在军师的发布节奏上，这跟「独立运营」是矛盾的。
 *
 * 这里给出的是**进程级的边界**，不是仓库拆分：同一份代码，`SERVICE_PROFILE=quickreel`
 * 起出来的进程只注册爱速拍真正用到的那几组路由。好处有三：
 *   1. 可以单独起一个只服务爱速拍的进程、单独发布、单独重启，不牵动军师；
 *   2. 边界是**代码里可执行的事实**，不是文档里的约定 —— 有人往爱速拍的链路里塞军师的依赖，
 *      quickreel 档位下会当场起不来或路由缺失，而不是几个月后才发现又缠在一起；
 *   3. 仓库真要拆的时候，这份清单就是拆分边界，不用再考古一遍。
 *
 * 默认 `all`，与本档位上线之前的行为**逐字节一致**：现有部署不设这个变量，什么都不变。
 */
export type ServiceProfile = 'all' | 'quickreel';

export function serviceProfile(): ServiceProfile {
  const raw = (process.env.SERVICE_PROFILE ?? 'all').trim().toLowerCase();
  if (raw === 'quickreel') return 'quickreel';
  if (raw === '' || raw === 'all') return 'all';
  // 拼错一个字母就静默退回全量，等于这道边界形同虚设。宁可起不来。
  throw new Error(`未知的 SERVICE_PROFILE=${raw}，只允许 all / quickreel`);
}

/**
 * 爱速拍这一档要注册的路由组。
 *
 * 清单是**白名单**不是黑名单：军师以后新增路由组时，默认不会漏进爱速拍进程。
 * 每一项都对得上端上真实在调的接口（app/packages/video/api.js + app/services/api.js）：
 *   auth   登录换令牌、刷新（端上 services/auth.js）
 *   meta   /me、/me/credits —— 账号资料与钱包余额
 *   video  /video/* 全部业务面，43 条
 *   wechat /wechat/subscribe 订阅消息，出片完成要靠它通知
 * 外加运维面（health / metrics / alerts），否则这个进程没法被监控和告警。
 */
export const QUICKREEL_ROUTE_GROUPS = new Set([
  'auth', 'meta', 'metrics', 'alerts', 'video', 'wechat',
]);

/** 当前档位要不要注册这一组。 */
export function shouldRegister(group: string, profile: ServiceProfile = serviceProfile()): boolean {
  return profile === 'all' || QUICKREEL_ROUTE_GROUPS.has(group);
}

/**
 * 后台工作进程要不要在本进程里跑。
 *
 * 海报 worker 和成果生成 worker 都是军师的东西，爱速拍进程里跑它们只会白占连接、
 * 抢同一张队列表；更糟的是两个进程同时轮询同一队列时，行为取决于抢锁顺序，
 * 出了问题很难说清是哪个进程干的。爱速拍自己的轮询（段级生成、出片通知）在 scheduler 里，
 * 不在这两个 worker 里。
 */
export function shouldRunJunshiWorkers(profile: ServiceProfile = serviceProfile()): boolean {
  return profile === 'all';
}
