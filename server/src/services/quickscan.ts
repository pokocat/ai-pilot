// 3 问速诊（WO-06）核心：行业 + 年营收段 + 最痛的一件事 → 初诊卡（主要矛盾 / 军师判断 / 今天能做的一件事）。
// LLM 走统一 structured() 原语（Zod schema 强约束三字段）；无真实 provider（测试/mock）→ 确定性模板兜底。
// 计费/限流/回填在 routes/quickscan.ts；本模块只负责「三问 → 三字段」的确定性可测转换。
import { z } from 'zod';
import { structuredMetered } from '../llm/gateway.js';
import type { QuickScanRequest, QuickScanResult } from '../../../shared/contracts';

// 专用小 prompt（≤2KB，不加载总军师 V6 全文）：只吃三条输入，只吐三字段，禁玄学/空话。
const QUICKSCAN_SYS =
  '你是「军师参谋部」的速诊参谋。老板只给了三条信息：所在行业、年营收段、当前最痛的一件事。' +
  '请像资深商业顾问那样，基于这三条给出一张「初诊卡」，只输出 JSON：' +
  '{"contradiction":"主要矛盾假设，一句话，点破当前最该解决的那个结构性矛盾",' +
  '"judgement":"军师判断，2-3 句，说清根因与不解决的代价，可给出方向",' +
  '"firstMove":"今天就能动手的一件事，具体、可执行、当天可完成，一条"}。' +
  '硬约束：① 不用八字/命理/玄学措辞；② 不说正确的废话（如「做好私域」），要落到动作；' +
  '③ 信息少也要给最可能的假设，不要反问；④ 只输出这三个字段。';

// 三字段 schema = 校验 + 类型 + 归一化（trim + 截断）；空字段 → 校验失败 → structured 触发修复一轮。
const QuickScanSchema = z.object({
  contradiction: z.string().trim().min(1).transform((s) => s.slice(0, 120)),
  judgement: z.string().trim().min(1).transform((s) => s.slice(0, 400)),
  firstMove: z.string().trim().min(1).transform((s) => s.slice(0, 200)),
});

/** 确定性模板兜底（mock / 无 provider）：不编经营数字，只给基于三输入的结构化引导，保证 mock 全链路可走通。 */
export function mockQuickScan(req: QuickScanRequest): QuickScanResult {
  const pain = req.pain.trim().slice(0, 40) || '增长乏力';
  return {
    contradiction: `你把力气压在「${pain}」的表象上，真正卡住的是获客与复购的结构没打通。`,
    judgement: `${req.industry}·${req.revenueBand}这个体量，"${pain}"多半是结果不是原因。先别急着补动作，本周把「谁来、为什么复购、一单挣多少」三笔账摊开——矛盾会自己浮出来；拖着不看，投入越多亏得越快。`,
    firstMove: '今天挑出近 30 天成交的 10 位客户，逐个打电话问「为什么选你、还会不会再来」，把答案记成一页纸。',
    cardUrl: null,
  };
}

/**
 * 跑一次速诊：真实 provider 就绪 → structured() 出三字段；否则 → 确定性模板。cardUrl 由 PR-B2 的分享卡链路补，暂 null。
 * P1-3 计费口径：回传 { ok, attempts }——ok=真实模型出了合规结果；attempts=已发生的真实调用轮次。
 * 路由据此结算：成功按定额、校验失败按 attempts 保守扣（不再因 mock 兜底而全额退款掩盖已花的真实调用）。
 */
export async function runQuickScan(
  req: QuickScanRequest,
): Promise<{ result: QuickScanResult; ok: boolean; attempts: number }> {
  const user = `行业：${req.industry}\n年营收段：${req.revenueBand}\n最痛的一件事：${req.pain.trim().slice(0, 300)}`;
  const { data: ai, attempts } = await structuredMetered(QuickScanSchema, { system: QUICKSCAN_SYS, user, maxChars: 1000 });
  if (!ai) return { result: mockQuickScan(req), ok: false, attempts };
  return { result: { contradiction: ai.contradiction, judgement: ai.judgement, firstMove: ai.firstMove, cardUrl: null }, ok: true, attempts };
}
