import type { SessionMessage } from '../../../shared/contracts';

/**
 * liveGenCore —— 一轮生成「收尾裁决」的纯逻辑核（无 Taro / 网络依赖，供 node 单测）。
 *
 * 病灶回顾（2026-07-28 假完成修复）：断流对账把本轮交回页面轮询（handoff）后，drive 的
 * P0-5 双保险仍会调用 finishReport，把还在生成的报告卡收成「已生成」——页面顶着「正在梳理
 * 上下文」的思考态，卡片却已开放查看/存入/认可，且 messageId 为空。收尾裁决从此收拢到这里：
 * 谁接管、怎么收、能不能装「已生成」，一律查表，不再靠散落的双保险各自兜底。
 */

/**
 * 本轮回复是否已落库：末条不是用户消息，且其前最近的那条用户消息正是本轮原文。
 * 后半个条件不可省——请求根本没送达服务端时，末条会是上一轮的回复，只看角色会把它误判成「本轮已完成」。
 */
export function storedReplyFor(messages: SessionMessage[], userText: string): SessionMessage | null {
  const last = messages.length ? messages[messages.length - 1] : null;
  if (!last || last.role === 'user') return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    return String((messages[i].content as { text?: string } | null)?.text ?? '') === userText ? last : null;
  }
  return null;
}

export type ReconcileTick =
  | { verdict: 'stored'; stored: SessionMessage } // 已落库：以服务端消息为准整体重绘
  | { verdict: 'handoff' }                        // 服务端仍在生成且页面在场：交回页面轮询
  | { verdict: 'pending' };                       // 尚无定论：用完剩余对账次数再判生死

/**
 * 断流对账单次判定。handoff 需要页面在场（hasView）——无人可交时继续等落库：
 * 报告落库通常比 generating 落幕早一步，多等一轮就能等到，进而完成自动入库。
 */
export function classifyReconcileTick(p: {
  messages: SessionMessage[];
  generating: boolean;
  userText: string;
  hasView: boolean;
}): ReconcileTick {
  const stored = storedReplyFor(p.messages, p.userText);
  if (stored) return { verdict: 'stored', stored };
  if (p.generating && p.hasView) return { verdict: 'handoff' };
  return { verdict: 'pending' };
}

export type ReconcileOutcome = 'stored' | 'handoff' | 'dead' | null;

export type ReportClose =
  | 'finish'    // 有真实落库 messageId：按正常完成收尾
  | 'interrupt' // 无落库 id、也没人接管：按中断收尾（保留已流出分段 + 重试），绝不伪装「已生成」
  | 'none';     // 别动卡片：轮询已接管（handoff）/ 服务端真值已重绘（stored）/ 错误路径已收尾

/**
 * 报告卡最终怎么收——drive 收尾汇合处的唯一裁决（取代旧 P0-5「无脑 finishReport」双保险）。
 * 硬规则：没有 messageId 就没有「已生成」。
 */
export function reportCloseAction(p: {
  kind: 'chat' | 'report' | null;
  reconciled: ReconcileOutcome;
  messageId?: string;
  streamErrored: boolean; // 错误路径（fatal / 对账判死）已把卡收成中断态，不重复收
}): ReportClose {
  if (p.kind !== 'report') return 'none';
  if (p.reconciled === 'handoff' || p.reconciled === 'stored') return 'none';
  if (p.messageId) return 'finish';
  return p.streamErrored ? 'none' : 'interrupt';
}

/**
 * 流被连接层收掉（clean close / 客户端超时）但从未收到 done/error 终态事件时，是否需要断流对账。
 * 旧行为是就地补发 onDone(undefined)——服务端多半仍在生成（反代切流、weapp 180s 总超时），
 * 这正是「假已生成」的另一半源头；已渲染却无终态 = 一律按断流交对账，不合成完成。
 */
export function streamClosedWithoutVerdict(state: { rendered: boolean; finished: boolean }): boolean {
  return state.rendered && !state.finished;
}
