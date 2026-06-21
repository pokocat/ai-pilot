// 检索调试台：对某用户跑一次真实检索，把「黑盒上下文」摊开给运营看——
//   候选命中 + 融合分 + rerank 前后名次 + 该用户×顾问语义召回的记忆 + buildGenContext 实际注入的知识/个人档案。
// 放在 retrieval.ts 之外，避免与 context.ts 形成循环依赖（context → retrieval）。
//
// 注意：本调试会触发若干次 embed()（候选打分 / 记忆召回 / 上下文组装），真实远程嵌入时会被计入
// 「检索基建」用量——属运营主动排查产生的少量消耗，可接受。

import { prisma } from '../db.js';
import { getAiConfig } from './aiConfig.js';
import { resolveEmbedding, embeddingUsable, embeddingDim } from './embedding.js';
import { resolveRerank, rerankUsable } from './rerank.js';
import { hybridSearchDebug } from './retrieval.js';
import { recallMemories } from './memory.js';
import { buildGenContext } from './context.js';
import type { AdminRetrievalDebug } from '../../../shared/contracts';

export async function retrievalDebug(userId: string, query: string, agentKey = 'strat'): Promise<AdminRetrievalDebug | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  const q = query.trim();

  const cfg = await getAiConfig();
  const ec = resolveEmbedding(cfg);
  const rc = resolveRerank(cfg);
  const embedRemote = embeddingUsable(ec);

  const [dim, scan, memories, gen] = await Promise.all([
    embeddingDim(),
    hybridSearchDebug({ tenantId: user.tenantId, userId: user.id, query: q, topK: 8 }),
    recallMemories(user.id, agentKey, 5, q),
    buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey, userMessage: q }).catch(() => null),
  ]);

  return {
    query: q,
    agentKey,
    embedDim: dim,
    embedModel: embedRemote ? ec.model : '本地确定性嵌入',
    embedRemote,
    rerankEnabled: rc.enabled,
    rerankModel: rerankUsable(rc) ? rc.model : rc.enabled ? '(配置不全，未生效)' : '',
    rerankApplied: scan.rerankApplied,
    candidates: scan.candidates,
    memories,
    contextKnowledge: gen?.ctx.knowledge ?? [],
    understanding: gen?.ctx.understanding ?? [],
  };
}
