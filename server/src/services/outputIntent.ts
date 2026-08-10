import type { RequestedOutput } from '../../../shared/contracts';

const OUTPUT_NOUN = '(?:方案|报告|成果|卡片|纪要|计划|军令|文案|脚本|海报|全案|诊断报告)';

// 只收明确的交付动作；单纯讨论“报告/方案”不等于请求生成。
const POSITIVE_SOURCES = [
  `(?:生成|输出|整理|制作|出|形成|写)(?:一份|一个|个|份)?[^，。！？\\n]{0,8}${OUTPUT_NOUN}`,
  `(?:帮我|给我|请|麻烦)(?:生成|输出|整理|制作|做|出|写)?(?:一份|一个|个|份)?[^，。！？\\n]{0,8}${OUTPUT_NOUN}`,
  `(?:转成|整理成|形成)(?:一份|一个|个|份)?[^，。！？\\n]{0,6}${OUTPUT_NOUN}`,
  '(?:战略体检|转成军令|生成纪要)',
];

// 否定必须先于肯定判断。“只聊聊/先分析”也是明确要求保持聊天形态。
const NEGATIVE_SOURCES = [
  `(?:先|暂时|现在)?(?:别|不要|不用|无需|不需要|先不|暂不|别急着)[^，。！？\\n]{0,12}(?:生成|输出|整理|制作|做|出|形成|写|转成)?[^，。！？\\n]{0,8}${OUTPUT_NOUN}`,
  `(?:^|[，。！？\\s])(?:只|先)(?:聊聊|聊一聊|讨论|分析|说说|给建议)(?:就行|即可|一下)?`,
];

const OVERRIDE_SOURCE = '(?:但是|但|不过|改主意了|还是|现在|那就|直接|立即|马上)';

type MatchPos = { index: number; end: number };

function lastMatch(text: string, sources: string[]): MatchPos | null {
  let found: MatchPos | null = null;
  for (const source of sources) {
    const re = new RegExp(source, 'g');
    for (const match of text.matchAll(re)) {
      const index = match.index ?? -1;
      if (index >= 0 && (!found || index >= found.index)) found = { index, end: index + match[0].length };
    }
  }
  return found;
}

/**
 * 解析本轮用户明确要求的交付形态。
 *
 * - 否定优先，避免“先别出报告”误进报告链；
 * - 否定之后若用户用“但/改主意/那就/直接”等明确翻转，以最后的新指令为准；
 * - 没有动作词时返回 unspecified，交给智能体 deliverableMode 决定。
 */
export function resolveRequestedOutput(rawText: string): RequestedOutput {
  const text = String(rawText ?? '').trim();
  if (!text) return 'unspecified';

  const negative = lastMatch(text, NEGATIVE_SOURCES);
  if (negative) {
    const after = text.slice(negative.end);
    const override = new RegExp(`${OVERRIDE_SOURCE}[^，。！？\\n]{0,16}(?:${POSITIVE_SOURCES.join('|')})`).test(after);
    return override ? 'report' : 'chat';
  }

  return lastMatch(text, POSITIVE_SOURCES) ? 'report' : 'unspecified';
}

export function wantsDeliverableRequest(text: string): boolean {
  return resolveRequestedOutput(text) === 'report';
}
