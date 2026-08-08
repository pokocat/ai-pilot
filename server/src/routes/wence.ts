// 问策入口 WP1：提示词池下发 + 客户端埋点入口。
//
// 两条路由都刻意**不要求登录**——问策 tab 对游客完整可浏览（微信整改红线，AGENTS §6 登录门口径），
// 提示 pill 与 wence_enter 埋点都发生在登录之前。带了 token 的请求仍按严格口径解析（无效 token 不静默降级，
// 与 GET /modules 同一约定：只有「压根没带 token」才算游客）。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { listHints } from '../services/wence.js';

/** 埋点事件白名单（对齐 shared/contracts.d.ts 的 ClientEventName）。非白名单 400，不写库。 */
const EVENT_NAMES = new Set([
  'wence_enter', 'proactive_show', 'chip_tap', 'hint_tap',
  'first_message_send', 'drawer_open', 'attach_open', 'tab_switch',
]);

/** props 序列化上限：2KB。超限只留截断标记 + 前 2KB 原文，绝不整条丢弃（漏斗分母不能因为脏 props 缺口）。 */
const PROPS_MAX_BYTES = 2048;

export async function wenceRoutes(app: FastifyInstance) {
  // 提示问题 pill 词池：只回 enabled 的 hint 模板（id+text，按 sort）。
  // 空池合法 → { hints: [] }，端上回退本地兜底池；不做鉴权、不按用户排序（画像排序留待后续包）。
  app.get('/wence/hints', async () => ({ hints: await listHints() }));

  // 客户端埋点：鉴权可选。已登录带 userId/tenantId，游客 userId 为空。
  // 只写不查（无读端点，运营取数直接查库/BI），因此这里不做任何聚合与二次校验。
  app.post<{ Body: { name?: unknown; props?: unknown } }>('/events', async (req, reply) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    if (!EVENT_NAMES.has(name)) return reply.code(400).send({ error: '未知事件名', code: 'BAD_EVENT_NAME' });

    // 鉴权可选：没带 token = 游客；带了 token 就必须有效（无效 token 直接 401，不伪装成游客事件，
    // 否则掉登录态的用户会被静默记成游客，把漏斗的 user_state 维度污染掉）。
    const token = req.headers['x-user-id'] as string | undefined;
    let userId: string | null = null;
    let tenantId: string | null = null;
    if (token) {
      const user = await resolveUser(token);
      userId = user.id;
      tenantId = user.tenantId;
    }

    await prisma.clientEvent.create({
      data: { userId, tenantId, name, propsJson: clampProps(req.body?.props) ?? undefined },
    });
    return { ok: true };
  });
}

/** props 归一：非对象一律丢弃；序列化后超 2KB 只留截断标记 + 截断原文。 */
function clampProps(raw: unknown): object | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let json: string;
  try { json = JSON.stringify(raw); } catch { return null; } // 循环引用等：宁可丢 props 也不丢事件
  if (typeof json !== 'string') return null;
  if (Buffer.byteLength(json, 'utf8') <= PROPS_MAX_BYTES) return raw as object;
  return { truncated: true, raw: Buffer.from(json, 'utf8').subarray(0, PROPS_MAX_BYTES).toString('utf8') };
}
