// 会话标题：建会话时先落「首问前 18 字」的硬截断占位，等**首轮问答真的完成**（已有第一条军师
// 回复）后，再用一次轻量模型调用把它换成 ≤12 字的短标题。
//
// 三条口径，改动前先看清楚：
//  ① **只在首轮改**。后续轮次一律不再动标题——用户能不能自己改名是另一个产品决定，在那之前
//     标题必须是稳的：一个每聊几句就自己变一次的历史列表比截断更难用。
//  ② **幂等靠「标题还是占位吗」判**，不另建标记列。占位只有三种形状：'新对话'、首条 user 文本
//     前 18 字、以及主动消息注入会话的模板文本前 18 字。不是这三种 = 已经生成过或被覆盖过 → 跳过。
//  ③ **即发即忘**。调用方一律 `void ... .catch()`，本函数自身也整体 try/catch：标题是锦上添花，
//     绝不允许它把回复链路拖慢或拖挂。
//
// 无真实 provider（测试 / 未配 key 的 mock 降级）时走确定性兜底，让这条路径在 mock 下可测、
// 也让降级环境仍比 18 字截断好读；真实模型在位但调用失败 → 静默保留现状，不拿兜底顶替真结果。

import { prisma } from '../db.js';
import { hasLiveProvider, summarizeSessionTitle, normalizeSessionTitle, SESSION_TITLE_MAX_CHARS } from '../llm/gateway.js';

/** 建会话时硬截断占位的长度。sessions.ts / generationJobs.ts 的 `text.slice(0, 18)` 与此同口径。 */
export const TITLE_PLACEHOLDER_CHARS = 18;
const NEW_SESSION_TITLE = '新对话';
/** 只需看清「首条 user + 它后面第一条回复」，取头几条即可，别把长会话整段拉进内存。 */
const HEAD_MESSAGES = 6;

function textOf(content: unknown): string {
  const c = (content ?? {}) as { text?: unknown; title?: unknown };
  // report 轮的正文在 title 上（结构化成果没有 text 字段）。
  const raw = typeof c.text === 'string' ? c.text : (typeof c.title === 'string' ? c.title : '');
  return raw.trim();
}

/** 占位标题的确定性兜底：无真实 provider 时用它替下 18 字截断（同输入恒同输出，可测）。 */
export function fallbackSessionTitle(userText: string): string | null {
  // 去掉开场虚词（「我想请教一下…」这类前缀在标题里只占位置不给信息），再取第一个语义片段。
  const stripped = String(userText ?? '')
    .replace(/\s+/g, '')
    .replace(/^(我想请教一下|我想问一下|想请教一下|我想请教|请教一下|想请教|我想问|请问一下|请问|麻烦你|麻烦|帮我看看|请帮我|帮我)/, '');
  const segment = stripped.split(/[。！？!?，,、；;：:\n]/).filter(Boolean)[0] ?? stripped;
  return normalizeSessionTitle(segment.slice(0, SESSION_TITLE_MAX_CHARS));
}

/**
 * 首轮完成后尝试把会话标题换成模型提炼的短标题。调用点 = 每条完成路径（持久任务的 title
 * post-effect + 内联 /generate-sync、/generate 的落库处），不满足条件时自身静默返回。
 */
export async function maybeGenerateTitle(sessionId: string): Promise<void> {
  try {
    const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { id: true, title: true } });
    if (!session) return;
    const current = session.title ?? '';

    const head = await prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      take: HEAD_MESSAGES,
      select: { role: true, contentJson: true },
    });

    // 首轮判定：全会话（头部窗口内）只有一条 user 消息，且它后面已经有回复落库。
    const userIndex = head.findIndex((m) => m.role === 'user');
    if (userIndex < 0) return;
    if (head.filter((m) => m.role === 'user').length !== 1) return;
    const askText = textOf(head[userIndex].contentJson);
    if (!askText) return;
    const answer = head.slice(userIndex + 1).find((m) => m.role === 'assistant' || m.role === 'report');
    if (!answer) return;

    // 幂等闸：标题必须仍是三种占位形状之一。首条 assistant 那一支覆盖主动消息注入的会话
    // （它的占位取自模板文本，不是用户首问）。
    const firstAssistant = head.find((m) => m.role === 'assistant' || m.role === 'report');
    const placeholders = [
      NEW_SESSION_TITLE,
      askText.slice(0, TITLE_PLACEHOLDER_CHARS),
      firstAssistant ? textOf(firstAssistant.contentJson).slice(0, TITLE_PLACEHOLDER_CHARS) : '',
    ].filter(Boolean);
    if (!placeholders.includes(current)) return;

    const generated = await summarizeSessionTitle(askText, textOf(answer.contentJson));
    // 真实模型在位却没拿到标题 = 本次失败，保留现状；无真实 provider 才用确定性兜底。
    const title = generated ?? (await hasLiveProvider() ? null : fallbackSessionTitle(askText));
    if (!title || title === current) return;

    // where 带上 current：只在标题仍是我们读到的那一份时才覆盖，避免与用户改名/并发轮次抢写。
    await prisma.session.updateMany({ where: { id: sessionId, title: current }, data: { title } });
  } catch (err) {
    console.error('[sessionTitle] generate failed:', (err as Error).message);
  }
}
