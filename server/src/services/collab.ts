// V7-15 会话协同披露：跨军师「派单 / 内部同步」时向目标会话写一条 system 消息，
// 前端渲染为 sys-card（居中窄卡「军师已同步内部判断：…」，见设计规格 §12.1），
// 用户只见一条连续对话，不需要切换多个军师窗口。
// 本工单只做展示层落库 helper；完整的总军师自动派单引擎（AGENTS §13.5.6 consult_specialist）另行立项。
import { prisma } from '../db.js';

/** sys-card 文案前缀（设计规格 §12.1）：跨军师内部同步披露。调用方拼成「{前缀}：{一句摘要}」。 */
export const SYNC_DISCLOSURE_PREFIX = '军师已同步内部判断';

/**
 * 向指定会话写入一条系统消息（role='system'，contentJson={text}）。
 * 说明：Message 无 tenantId/userId 列，行级隔离经 session 关系；调用方（如 battle/commit 认可判断、
 * chat 现有协同导轨的派单动作）自行保证 sessionId 属于当前用户，再调用本 helper。
 * @returns 新建 Message 的 id
 */
export async function writeSystemMessage(args: { sessionId: string; text: string }): Promise<string> {
  const { sessionId, text } = args;
  const msg = await prisma.message.create({
    data: { sessionId, role: 'system', contentJson: { text } },
  });
  return msg.id;
}
