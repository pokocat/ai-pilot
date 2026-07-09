// V7-14 跨域搜索：一个搜索框聚合四域命中——军师（内存注册表）/ 会话 / 报告 / 知识库。
//
// 铁律：
//   • 租户隔离——每个 prisma 查询按 tenantId + userId 过滤；hybridSearch 传 tenantId + userId。
//   • **知识库仅返回 stage='confirmed' 的条目**（staging 待整理 / optimized 已优化一律排除，
//     不进检索、不被搜索命中）。这是 V7-06 三段式管道的关键隔离断言：待整理资料对用户「不可搜」。
//   • 军师注册表是全局目录（非租户数据），按 name/role 子串大小写不敏感匹配，不做隔离。
//   • 前端只消费 route 字段做页面跳转；服务端给出规范化路由 + kind + id。
//
// 命中上限：每类至多 5 条；返回顺序按 kind 分组（agent → session → report → knowledge）。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { hybridSearch } from '../services/retrieval.js';
import { AGENTS } from '../data/agents.js';
import type { SearchHit, SearchResult } from '../../../shared/contracts';

const PER_KIND = 5;

export async function searchRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>('/search', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const q = (req.query.q ?? '').trim();
    // 空查询直接返回空结果（前端防抖首帧 / 清空搜索框）。
    if (!q) return { q: '', hits: [] } as SearchResult;
    const ql = q.toLowerCase();

    const hits: SearchHit[] = [];

    // 1) 军师：内存注册表按 name/role 子串匹配（大小写不敏感），最多 5 条。snippet = role。
    let agentCount = 0;
    for (const a of AGENTS) {
      if (!a.enabled) continue;
      if (a.name.toLowerCase().includes(ql) || a.role.toLowerCase().includes(ql)) {
        hits.push({
          kind: 'agent',
          id: a.key,
          title: a.name,
          snippet: a.role,
          route: `/pages/chat/index?agentKey=${a.key}&fresh=1`,
        });
        if (++agentCount >= PER_KIND) break;
      }
    }

    // 2) 会话：本人会话 title 命中，按更新时间倒序取 5 条。snippet = 最近一条消息预览，缺则用标题。
    const sessions = await prisma.session.findMany({
      where: { tenantId: user.tenantId, userId: user.id, title: { contains: q, mode: 'insensitive' } },
      orderBy: { updatedAt: 'desc' },
      take: PER_KIND,
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    for (const s of sessions) {
      const last = s.messages[0];
      let snippet = s.title;
      if (last) {
        const c = last.contentJson as { text?: string; title?: string };
        snippet = c.text || (c.title ? `已产出《${c.title}》` : '') || s.title;
      }
      hits.push({
        kind: 'session',
        id: s.id,
        title: s.title,
        snippet: snippet.slice(0, 120),
        route: `/pages/chat/index?sessionId=${s.id}`,
      });
    }

    // 3) 报告：本人报告 title 命中，按更新时间倒序取 5 条。snippet = 报告类型。
    const reports = await prisma.reportDoc.findMany({
      where: { tenantId: user.tenantId, userId: user.id, title: { contains: q, mode: 'insensitive' } },
      orderBy: { updatedAt: 'desc' },
      take: PER_KIND,
    });
    for (const r of reports) {
      hits.push({
        kind: 'report',
        id: r.id,
        title: r.title,
        snippet: r.type,
        route: `/packages/work/report/index?id=${r.id}`,
      });
    }

    // 4) 知识库：复用 hybridSearch（租户 + 用户隔离）取 topK 5，再**仅保留 stage='confirmed'**。
    //    staging 条目本就不切片嵌入（无 chunk，检索天然召不回）；此处再按 stage 显式过滤兜底，
    //    确保即便某 staging/optimized 条目残留 chunk，也绝不出现在搜索结果里（关键隔离）。
    const kHits = await hybridSearch({ tenantId: user.tenantId, userId: user.id, query: q, topK: PER_KIND });
    if (kHits.length) {
      const confirmed = await prisma.knowledgeItem.findMany({
        where: {
          id: { in: kHits.map((h) => h.item.id) },
          tenantId: user.tenantId,
          userId: user.id,
          stage: 'confirmed',
        },
        select: { id: true },
      });
      const ok = new Set(confirmed.map((c) => c.id));
      for (const h of kHits) {
        if (!ok.has(h.item.id)) continue;
        hits.push({
          kind: 'knowledge',
          id: h.item.id,
          title: h.item.title || h.item.kind,
          snippet: (h.snippet || h.item.text).slice(0, 120),
          route: '/pages/thinktank/index',
        });
      }
    }

    return { q, hits } as SearchResult;
  });
}
