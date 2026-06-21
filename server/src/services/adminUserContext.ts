// 运营端「用户上下文中心」聚合：某用户的 个人档案 + 长期记忆（按顾问）+ 知识库文档。
// 把分散在 understanding / memory / knowledge 三处的用户信息合到一次查询，供后台用户详情面板观测与纠偏。

import { prisma } from '../db.js';
import { buildClientUnderstanding } from './understanding.js';
import { listUserMemories } from './memory.js';
import { listKnowledgeDocs } from './knowledge.js';
import type { AdminUserContext } from '../../../shared/contracts';

export async function userContextView(userId: string): Promise<AdminUserContext | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  const [understanding, memories, knowledge] = await Promise.all([
    buildClientUnderstanding({ id: user.id, tenantId: user.tenantId, name: user.name }),
    listUserMemories(user.tenantId, user.id),
    listKnowledgeDocs(user.tenantId, user.id),
  ]);
  return { understanding, memories, knowledge };
}
