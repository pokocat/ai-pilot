// PR-0a 禁用词检查（V6.0 §17 语气风格）：AI 输出后扫描咨询黑话，命中只记一笔、绝不打断回复。
// 挂在 gateway 的 traced() 成功路径上 —— 所有 provider 的 chat/deliverable 输出都恰好经过一次。
import { recordAudit } from './audit.js';

export const BANNED_WORDS = ['赋能', '抓手', '底层逻辑', '颗粒度', '范式转移'] as const;

/** 扫描文本，返回命中的禁用词（去重）。 */
export function scanBannedWords(text: string): string[] {
  if (!text) return [];
  return BANNED_WORDS.filter((w) => text.includes(w));
}

/** 命中则落审计日志（action=ai.banned_words）+ 控制台一行；失败静默，绝不影响主流程。 */
export async function auditBannedWords(args: {
  tenantId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  agentKey?: string;
  kind: string; // chat | deliverable
  text: string;
}): Promise<string[]> {
  const hits = scanBannedWords(args.text);
  if (!hits.length) return hits;
  console.warn(`[banned-words] agent=${args.agentKey ?? '-'} kind=${args.kind} session=${args.sessionId ?? '-'} hits=${hits.join(',')}`);
  await recordAudit({
    tenantId: args.tenantId ?? null,
    userId: args.userId ?? null,
    action: 'ai.banned_words',
    payload: { agentKey: args.agentKey ?? null, kind: args.kind, sessionId: args.sessionId ?? null, words: hits },
  }).catch(() => {});
  return hits;
}
