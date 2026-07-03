// 意图与状态识别（M3 PR-11/PR-12/PR-13/PR-14）：全部确定性规则，可测可复算。
// 对应 V6.0 §3 入口识别 / §6 六轮与快速通道 / §7 阶段自适应 / §2 角色随内在状态演变。
// 识别结果只用于「给模型指路」（注入模式/角色/阶段指令）与「落对应账本」（复盘分层）——
// 不改变计费与智能体归属；识别不出就不注入，让 V6.0 提示词自身判断。

import type { ReviewLayer } from './reviewLog.js';

export type SessionMode =
  | 'strategy'      // 常规诊断/战略（默认）
  | 'review'        // 复盘（配 reviewLayer）
  | 'urgent'        // 紧急决策（4 步 + 择时）
  | 'timing'        // 决策择时
  | 'team_match'    // 命格×团队匹配
  | 'gift_bazi'     // 送你一卦（裂变）
  | 'mentor';       // 师父模式（情绪先行，再理性分析）

export interface IntentResult {
  mode: SessionMode;
  reviewLayer?: ReviewLayer;
}

// V6.0 §10 复盘触发词 → 层级（顺序：先长周期再短周期，避免「本季度的月度总结」误判）
const REVIEW_HINT = /复盘|战报|总结|回顾|汇报/;
const REVIEW_LAYERS: { layer: ReviewLayer; re: RegExp }[] = [
  { layer: 'team', re: /团队|人员|员工/ },
  { layer: 'year', re: /年度|年终|全年|今年.*(复盘|总结|回顾)/ },
  { layer: 'quarter', re: /季度|Q[1-4]|这一?季/ },
  { layer: 'month', re: /月度|这个月|本月|上个?月/ },
  { layer: 'week', re: /这周|本周|上周|周报|一周/ },
  { layer: 'day', re: /今天|今日|当天|6 ?件事|六件事/ },
];

/** 单轮输入 → 意图（识别不出返回 strategy 默认）。 */
export function detectIntent(text: string): IntentResult {
  const t = (text || '').trim();
  if (!t) return { mode: 'strategy' };

  // 复盘（含分层）：触发词 + 周期词；「帮我做 YYYY-MM-DD 的执行复盘」是执行页的确定性前缀
  if (/^帮我做 \d{4}-\d{2}-\d{2} 的执行复盘/.test(t)) return { mode: 'review', reviewLayer: 'day' };
  if (REVIEW_HINT.test(t)) {
    const hit = REVIEW_LAYERS.find((l) => l.re.test(t));
    if (hit) return { mode: 'review', reviewLayer: hit.layer };
  }

  // 送你一卦（裂变）：给别人算
  if (/送.{0,4}一?卦|[帮给替].{0,6}(朋友|兄弟|同学|客户|他|她).{0,8}算/.test(t)) return { mode: 'gift_bazi' };

  // 团队匹配：评估某个人适不适合
  if (/合伙人?.{0,10}(合适|靠谱|适合|能不能|行不行)|这个人.{0,8}(适合|能不能用|靠谱)|(招|用)这个人|团队匹配/.test(t)) return { mode: 'team_match' };

  // 择时：什么时候做某事
  if (/什么时候.{0,12}(签|开业|上线|发布|谈判|招人|投放|启动|搬|注册)|择时|挑个?(日子|时间)|吉日|时间窗口.{0,6}(选|定)/.test(t)) return { mode: 'timing' };

  // 紧急决策
  if (/紧急|来不及|火烧眉毛|马上要(定|决定|答复)|今晚?必须|出大?事了|突发/.test(t)) return { mode: 'urgent' };

  // 情绪状态（师父模式先接住，再理性分析）
  if (/焦虑|迷茫|撑不住|扛不住|想放弃|自我怀疑|睡不着.{0,6}(愁|想)|没有?意义|很空虚|好累.{0,4}(坚持|意义)/.test(t)) return { mode: 'mentor' };

  return { mode: 'strategy' };
}

const MODE_DIRECTIVES: Record<SessionMode, string | null> = {
  strategy: null, // 默认不注入，走提示词自身的诊断流程
  review: null,   // 复盘的注入按层级单独拼（见 modeDirective）
  urgent: '进入紧急战况模式：按「快速摸底 → ABC 利弊推演 → 对齐总战略 → 天势择时」四步给出果断建议，节奏快、先给结论。',
  timing: '进入决策择时模式：先确认要择时的事项类型，再结合命盘流月给最佳时间窗口 + 备选窗口 + 要避开的时段（白话表达，不堆术语）。',
  team_match: '进入团队匹配模式：先采集对方生辰（至少年月日），做五行互补与十神关系分析，输出 互补指数/合作模式建议/摩擦点/分工/需警惕时段。',
  gift_bazi: '进入「送你一卦」模式：采集朋友的生辰后输出简版天命速写（命格一句话 + 今年大势 + 一条核心建议），结尾自然引导对方找军师参谋部做完整诊断。',
  mentor: '客户当前情绪需要先被接住：先以师父口吻做心理层面的回应与稳定，再回到理性分析；不要一上来就拆解问题。',
};

const LAYER_CN: Record<ReviewLayer, string> = { day: '日', week: '周', month: '月', quarter: '季', year: '年', team: '团队' };

/** 模式 → 注入指令（strategy 返回 null 不注入）。 */
export function modeDirective(intent: IntentResult): string | null {
  if (intent.mode === 'review' && intent.reviewLayer) {
    const extra = intent.reviewLayer === 'month' || intent.reviewLayer === 'quarter'
      ? '本层复盘必须包含【天机验证】（逐条对照天机账本里的待验证预言）和【决策回顾】（对照决策账本）。'
      : '';
    return `进入${LAYER_CN[intent.reviewLayer]}复盘模式：按六层复盘中该层的流程执行，数据一律以系统注入的账本块为准。${extra}`;
  }
  return MODE_DIRECTIVES[intent.mode];
}

// ============ 内在状态 → 五角色语气（V6.0 §2/§17，M3 PR-14） ============

export type InnerState = '生存焦虑' | '增长兴奋' | '管理痛苦' | '瓶颈迷茫' | '意义追问';

const ROLE_OF: Record<InnerState, { role: string; tone: string }> = {
  生存焦虑: { role: '教官', tone: '别想太多，先活下来——直接告诉他下一步干什么' },
  增长兴奋: { role: '参谋长', tone: '好消息归好消息，帮他看有没有暗坑' },
  管理痛苦: { role: '大哥', tone: '这关每个老板都要过——讲清楚怎么回事、怎么走' },
  瓶颈迷茫: { role: '战略家', tone: '他需要的不是更努力，是看清势' },
  意义追问: { role: '师父', tone: '聊他的命盘与使命，先给意义感再谈生意' },
};

/** 识别老板当前内在状态（识别不出返回 null → 不注入，让提示词自行判断）。 */
export function detectInnerState(text: string): InnerState | null {
  const t = (text || '').trim();
  if (!t) return null;
  if (/发不出.{0,3}工资|工资.{0,6}发不出|现金流.{0,4}(断|快|撑|紧)|活不下去|快?撑不住|倒闭|生存/.test(t)) return '生存焦虑';
  if (/爆了|起飞|翻[了倍]|签了.{0,6}大单|增长很猛|涨得|太顺了/.test(t)) return '增长兴奋';
  if (/团队跟不上|员工.{0,6}(留不住|不行|带不动)|管理.{0,4}(累|乱|痛)|执行不下去|招不到人/.test(t)) return '管理痛苦';
  if (/卡住|瓶颈|不知道往哪|方向.{0,4}(迷|不清)|迷茫|增长停/.test(t)) return '瓶颈迷茫';
  if (/没有?意义|空虚|为了什么|图什么|赚了钱.{0,8}(不开心|空)/.test(t)) return '意义追问';
  return null;
}

/** 内在状态 → 角色语气注入行。 */
export function roleDirective(state: InnerState | null): string | null {
  if (!state) return null;
  const r = ROLE_OF[state];
  return `识别到客户当前内在状态：${state} → 本轮以「${r.role}」角色回应（${r.tone}）。`;
}

// ============ 营收阶段自适应（V6.0 §7，M3 PR-13） ============

export type Stage = 'survival' | 'start' | 'growth' | 'expansion';

/** 档案阶段标签 → 阶段（新问卷=营收区间；兼容旧标签：起步/验证→survival，A 轮前后→start…）。 */
export function stageOf(stageLabel?: string | null): Stage | null {
  const s = (stageLabel || '').trim();
  if (!s) return null;
  if (/100 ?万以下|<100|生存|起步 ?\/ ?验证/.test(s)) return 'survival';
  if (/100[-–~]500 ?万|起步期|A ?轮前后/.test(s)) return 'start';
  if (/500 ?万[-–~]5000 ?万|成长期|规模化/.test(s)) return 'growth';
  if (/5000 ?万|亿|扩张期|稳定盈利/.test(s)) return 'expansion';
  return null;
}

const STAGE_DIRECTIVES: Record<Stage, string> = {
  survival: '阶段适配=生存期（年营收<100万）：不做长期战略规划，只给短期战术与 30 天生存动作；天势只看当月窗口；看板只盯 营收/获客/转化 三个数。',
  start: '阶段适配=起步期（100-500万）：聚焦模式，快节奏收敛到一个主打法；天势看流年+性格操作手册。',
  growth: '阶段适配=成长期（500万-5000万）：完整模式，可做全套诊断与复盘体系。',
  expansion: '阶段适配=扩张期（5000万+）：高管模式，多业务线与博弈推演，配合团队匹配与决策择时。',
};

export function stageDirective(stageLabel?: string | null): string | null {
  const st = stageOf(stageLabel);
  return st ? STAGE_DIRECTIVES[st] : null;
}

// ============ 会话模式编码（Session.mode 粘性存储，M3 PR-11） ============

export function encodeMode(intent: IntentResult): string | null {
  if (intent.mode === 'strategy') return null;
  return intent.mode === 'review' && intent.reviewLayer ? `review:${intent.reviewLayer}` : intent.mode;
}

export function decodeMode(encoded?: string | null): IntentResult {
  if (!encoded) return { mode: 'strategy' };
  if (encoded.startsWith('review:')) {
    const layer = encoded.slice(7) as ReviewLayer;
    return { mode: 'review', reviewLayer: layer };
  }
  return { mode: encoded as SessionMode };
}

/** 路由用：本轮检测优先，检测不出沿用会话粘性模式。返回 [生效意图, 需要持久化的编码(变化才有)] */
export function resolveMode(text: string, sticky?: string | null): { intent: IntentResult; persist: string | null | undefined } {
  const detected = detectIntent(text);
  if (detected.mode !== 'strategy') {
    const enc = encodeMode(detected);
    return { intent: detected, persist: enc !== (sticky ?? null) ? enc : undefined };
  }
  return { intent: decodeMode(sticky), persist: undefined };
}
