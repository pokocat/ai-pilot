/**
 * 后台路由的产品闸：按 URL 前缀判定「这一屏属于哪个产品」，在一个 preHandler 里统一拦。
 *
 * 在这之前，产品授权只挡住了爱速拍那几条新路由，军师自己那 40 多条（智能体、话术、
 * 邀请体系、内容池…）服务端一道闸都没有 —— 前端的产品视角只是视图过滤，
 * 拿 curl 直接打就绕过去了。运营后台管着真钱和用户数据，「前端看不见」不是访问控制。
 *
 * ## 为什么按前缀，不是逐路由标注
 *
 * 逐个标注 40 多条的问题不在工作量，在**新增路由默认是敞开的**：半年后有人加一条
 * `/admin/whatever`，忘了标就是无闸。前缀表反过来 —— 未列入的前缀落到
 * {@link DEFAULT_PRODUCT}，也就是默认归军师、默认要授权。想敞开必须显式写进 SHARED，
 * 那是一次有人会看见的改动。
 *
 * ## 三类前缀
 *
 * - `SHARED`：平台面，任何运营都能看。钱包是一个、账号中心是一个、审计是一处 ——
 *   把它们按产品切开，另一边就查不了账、找不了人。
 * - `QUICKREEL`：爱速拍专属。这些路由自己内部**还会再查一次** requireProductAccess
 *   （有的要 editor、有的叠加 requireSuper），这里这一道是兜底，不是替代。
 * - 其余：军师专属，要 `junshi` 授权。
 *
 * ## 超管
 *
 * `isSuperActor`（owner 账号 / master token）隐式拥有全部产品，这一闸对他空转。
 * 今天全平台只有一个超管，所以上线这一闸对现有运营零成本 —— 这是**现在**做的理由：
 * 等有了第二个运营，同样的改动就得先发授权、再切换，变成一次要协调的迁移。
 */
import type { FastifyRequest } from 'fastify';
import { PRODUCT } from './products.js';
import { requireProductAccess, isSuperActor, type AdminActor } from './adminAuth.js';

/** 未列入任何表的前缀归谁。默认军师 = 默认要授权，新增路由不会悄悄敞开。 */
export const DEFAULT_PRODUCT: string = PRODUCT.junshi;

/**
 * 平台共享面，不按产品切。
 *
 * 每一条都有具体理由，不是「看着像公共的」：
 *   users / payments / usage / credits  一个钱包、一个账号中心，切开另一边就查不了账
 *   audit / moderation / observability  审计是一处，按产品切等于谁都查不全
 *   ai-* / model                        模型与端点池是平台基建，两个产品共用同一批 key
 *   accounts / auth                     运营账号本身；按产品切会变成「改不了自己的密码」
 *   plans / skus / pricing-tiers        付费商品目录，一个钱包一套 SKU
 *   products                            产品分区面自己。它内部按 accessibleProductCodes 逐行过滤
 *   overview / reports / meta / flags   平台级概览与开关
 */
const SHARED = [
  '/admin/users', '/admin/payments', '/admin/usage', '/admin/credits',
  '/admin/audit', '/admin/audit-logs', '/admin/moderation-logs', '/admin/observability',
  '/admin/ai-', '/admin/model', '/admin/accounts', '/admin/auth',
  '/admin/plans', '/admin/skus', '/admin/sku', '/admin/pricing-tiers',
  '/admin/products', '/admin/overview', '/admin/reports', '/admin/meta',
  '/admin/flags', '/admin/monitor-notify', '/admin/tool-stats',
];

/** 爱速拍专属。路由内部还会再查一次（有的要 editor），这里是兜底。 */
const QUICKREEL = ['/admin/video/', '/admin/clip/'];

/** 这条路径归哪个产品；null = 共享面，不拦。 */
export function productOfAdminPath(path: string): string | null {
  const p = (path.split('?')[0] ?? path).toLowerCase();
  if (!p.startsWith('/admin/') && p !== '/admin') return null; // 不是后台路由，不归这一闸管
  if (QUICKREEL.some((prefix) => p.startsWith(prefix))) return PRODUCT.quickreel;
  if (SHARED.some((prefix) => p.startsWith(prefix))) return null;
  return DEFAULT_PRODUCT;
}

/**
 * preHandler：非共享面一律要对应产品的 viewer。
 *
 * 只要 viewer，不区分读写 —— 写操作各自的 requireSuper / requireProductAccess('editor')
 * 一条都没动。这一闸解决的是「完全没有这个产品授权的人能不能碰它」，
 * 不是「能不能改」，两件事不要混在一处收口。
 */
export async function enforceAdminProductAccess(req: FastifyRequest, actor: AdminActor): Promise<void> {
  if (isSuperActor(actor)) return; // 超管隐式拥有全部产品，空转
  const url = (req.raw.url ?? '').replace(/^\/api/, '');
  const product = productOfAdminPath(url);
  if (!product) return;
  await requireProductAccess(actor, product, 'viewer');
}
