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

/**
 * 挂在共享前缀**下面**、但其实是某个产品专属的路径。比 SHARED 先判。
 *
 * `/admin/users` 整族标共享是过宽的（codex 2026-09-11 审出）：用户列表、余额、套餐、
 * token 额度确实是平台面 —— 但同一前缀下还挂着这个用户的**智能体记忆、知识库切片、
 * 对话上下文、能力模块**，那些是军师的内容。只被授予爱速拍的运营不该能翻一个用户
 * 在军师里说过什么、传过什么文档。
 *
 * `*` 匹配一个路径段（用户 id）。
 */
const PRODUCT_SUBPATHS: Array<{ pattern: string; product: string }> = [
  { pattern: '/admin/users/*/agents', product: PRODUCT.junshi },
  { pattern: '/admin/users/*/context', product: PRODUCT.junshi },
  { pattern: '/admin/users/*/knowledge', product: PRODUCT.junshi },
  { pattern: '/admin/users/*/memories', product: PRODUCT.junshi },
  { pattern: '/admin/users/*/modules', product: PRODUCT.junshi },
];

/** 段级通配匹配：`*` 吃一个段，模式短于路径时按前缀算（`/x/*​/y` 命中 `/x/1/y/z`）。 */
function matchesPattern(path: string, pattern: string): boolean {
  const ps = pattern.split('/').filter(Boolean);
  const xs = path.split('/').filter(Boolean);
  if (xs.length < ps.length) return false;
  return ps.every((seg, i) => seg === '*' || seg === xs[i]);
}

/**
 * 归一化成可比的路径。
 *
 * 每一步都对应一种绕法：
 *   · 去 query / hash —— `?` 之后的东西不参与路由
 *   · 解一次百分号编码 —— `/admin/%76ideo/...`。只解一次：解两次等于把 `%2525` 也当成有效编码，
 *     那是另一类洞（double-decode）。解不开就用原串，不抛。
 *   · 折叠重复斜杠 —— `//admin/agents` 不能因为多一个斜杠就不像后台路径
 *   · 去尾斜杠、转小写
 */
function normalizePath(raw: string): string {
  let p = (raw.split(/[?#]/)[0] ?? raw);
  try { p = decodeURIComponent(p); } catch { /* 非法编码：按原串比，落到默认产品（拦） */ }
  p = p.replace(/\/{2,}/g, '/').toLowerCase();
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * 前缀匹配要落在**路径段边界**上。
 *
 * `startsWith('/admin/users')` 会把 `/admin/usersomething` 也认成共享面。今天没有这样的路由，
 * 但这一闸的价值就在于「以后新加的路由默认被拦」，靠「今天恰好没有」撑着等于没有闸。
 */
function underPrefix(path: string, prefix: string): boolean {
  const p = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (!path.startsWith(p)) return false;
  const next = path.charAt(p.length);
  // prefix 本身以 `-` 收尾（`/admin/ai-`）时，后面接什么都算同一族，不要求边界
  return next === '' || next === '/' || p.endsWith('-');
}

/** 看着像不像一条后台路由。归一化之后判断。 */
export function looksLikeAdminPath(path: string): boolean {
  const p = normalizePath(path);
  return p === '/admin' || p.startsWith('/admin/');
}

/** 这条路径归哪个产品；null = 共享面或根本不是后台路由，两者都不拦。 */
export function productOfAdminPath(path: string): string | null {
  const p = normalizePath(path);
  if (!looksLikeAdminPath(p)) return null; // 不是后台路由，不归这一闸管
  if (QUICKREEL.some((prefix) => underPrefix(p, prefix))) return PRODUCT.quickreel;
  // 先判「共享前缀下的产品专属子路径」，再判共享 —— 顺序反了就等于没有这张表
  const sub = PRODUCT_SUBPATHS.find((r) => matchesPattern(p, r.pattern));
  if (sub) return sub.product;
  if (SHARED.some((prefix) => underPrefix(p, prefix))) return null;
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
  const url = (req.raw.url ?? '').replace(/^\/api(?=\/)/, '');

  // **异常路径一律按「要授权」处理，不是放行。**
  // 这个函数只会被 requireAdmin 调到，而 requireAdmin 只挂在后台路由插件上 ——
  // 也就是说，走到这里的请求本来就该长成 /admin/...。长得不像，说明要么路径被做了手脚，
  // 要么以后有人把这个 hook 挂到了别处。两种情况下「看不懂就放行」都是错的方向。
  if (!looksLikeAdminPath(url)) {
    await requireProductAccess(actor, DEFAULT_PRODUCT, 'viewer');
    return;
  }

  const product = productOfAdminPath(url);
  if (!product) return; // 共享面
  await requireProductAccess(actor, product, 'viewer');
}
