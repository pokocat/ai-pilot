// 会话标题自动总结：会话首轮用一次轻量模型调用把用户开场输入提炼成短标题，替代硬截断占位。
// 即发即忘（调用侧 void ... .catch）——绝不阻塞/影响对话主流程；无就绪模型（含测试/mock）时静默不动。

import { prisma } from '../db.js';
import { summarizeSessionTitle } from '../llm/gateway.js';

/**
 * 提炼并回写会话标题。
 * - firstText：用户首条输入（提炼素材）。
 * - placeholder：首轮写入的硬截断占位标题（如 text.slice(0, 18)）。
 * 回写用 updateMany 且 where 限定 title=placeholder——只在标题仍是本次占位值时覆盖，
 * 避免与用户改名/后续消息的竞态误覆盖。拿不到标题（无 live provider / 解析失败）即静默返回。
 */
export async function refineSessionTitle(sessionId: string, firstText: string, placeholder: string): Promise<void> {
  try {
    const title = await summarizeSessionTitle(firstText);
    if (!title || title === placeholder) return;
    await prisma.session.updateMany({
      where: { id: sessionId, title: placeholder },
      data: { title },
    });
  } catch (err) {
    console.error('[sessionTitle] refine failed:', (err as Error).message);
  }
}
