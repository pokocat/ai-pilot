// 接入配置的互斥校验器（2026-08-07 · 重设计二期）。
//
// ── 为什么要收成一个函数 ───────────────────────────────────────────────────────
// 「保存端点」「加入分流池」「切换生效模型」「保存路由」「探活」这五处，此前各写各的 if：
// 端点池的协议校验在 routes/admin.ts 里抄了三遍（新增/编辑/切换各一份，判据还都是
// `AiSetting.provider` 这个**拷贝值**），而 thinking 的约束根本没有保存期校验——
// 后台能存下一份运行时必然 400 的配置，等到用户发消息才炸。
//
// 收口之后：**同一份判断，五个入口共用**。加一条新约束只改这一个文件。
//
// ── 分级口径 ─────────────────────────────────────────────────────────────────
//   error — 这份配置发出去必然失败（协议不允许 / 能力已被证伪）→ 拒绝保存
//   warn  — 能跑，但结果不是运营以为的那样（预算被忽略、成本记 0）→ 可保存，后台常驻黄标
//   info  — 提示性（方言还没固化）
// 全部是**纯函数**：需要的事实由调用方查好传进来（模型范围、同名模型的价格集合……）。
// 校验器不查库——它要能在保存前、探活前、单测里以同一种方式跑。
//
// ── 拦添乱，不锁死修复 ────────────────────────────────────────────────────────
// 路由校验还能收到「库里已存的这条路由」（`validateRoute` 的 `prior`）。已经坏了的池子，运营
// 的每个修复动作都不该被**剩下的成员**挡回去；而「开启分流」「加入不兼容的新成员」照旧拦死。
// 详见 validateRoute 里的长注释——这是 2026-08-27 那个「怎么改都保存不了」的成因。

import type { AiConfigIssue, AiProvider, AiThinkingMode } from './schema.js';
import { resolveDialect, type Dialect } from './dialects.js';
import { capOf, readCaps } from './configSchemas.js';
import { vendorCapsOf, vendorOf } from './vendors.js';
import { MAX_THINKING_BUDGET, MIN_THINKING_BUDGET, normalizeThinkingBudget } from './thinking.js';

export interface EndpointDraft {
  id?: string;
  label: string;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  dialect?: string | null;
  capsJson?: unknown;
  thinkingMode: AiThinkingMode;
  thinkingBudget: number;
  temperature?: number;
  hasKey: boolean;
  priceInput?: number;
  priceOutput?: number;
  priceCachedInput?: number;
  priceCacheWrite?: number;
  poolEnabled?: boolean;
}

/** 校验时需要、但只有调用方查得到的事实。全部可选：给不出就跳过对应规则，绝不臆断。 */
export interface EndpointFacts {
  /** 该 key 在上游被允许的模型清单（探活经 GET /v1/models 回填）。未探测过＝undefined，不报。 */
  modelScope?: string[];
  /** 同名模型在其它端点上的价格（用于同名一致性）。 */
  siblingPrices?: { priceInput: number; priceOutput: number; priceCachedInput: number; priceCacheWrite: number }[];
  /** 对话正文预算（用于 thinking 预算是否顶穿 max_tokens）。 */
  bodyMaxTokens?: number;
}

const issue = (level: AiConfigIssue['level'], code: string, message: string, field?: string): AiConfigIssue =>
  ({ level, code, message, ...(field ? { field } : {}) });

/** 单个端点的自洽性。 */
export function validateEndpoint(ep: EndpointDraft, facts: EndpointFacts = {}): AiConfigIssue[] {
  const out: AiConfigIssue[] = [];
  const { dialect, explicit } = resolveDialect(ep);
  const caps = readCaps(ep.capsJson);
  const vendor = vendorOf(ep.baseUrl);

  // —— 基础完整性 ——
  if (!ep.label?.trim()) out.push(issue('error', 'LABEL_REQUIRED', '展示名不能为空', 'label'));
  if (ep.provider !== 'mock') {
    if (!ep.model?.trim()) out.push(issue('error', 'MODEL_REQUIRED', '模型 model 不能为空', 'model'));
    if (!ep.hasKey) out.push(issue('warn', 'KEY_MISSING', '未配置 API Key，该端点当前会降级为本地模板（mock）', 'apiKey'));
  }

  // provider 决定走哪套 SDK/接口形状，显式方言必须属于同一协议族。否则保存能过，运行时会拿
  // OpenAI SDK 去组 Anthropic 方言（或反过来），这类错配没有任何机会“自动兼容”。
  const expectedProtocol = ep.provider === 'claude' ? 'anthropic' : ep.provider === 'openai' ? 'openai_chat' : 'mock';
  if (dialect.protocol !== expectedProtocol) {
    out.push(issue('error', 'DIALECT_PROTOCOL_MISMATCH',
      `${dialect.label} 属于 ${dialect.protocol} 协议，与当前选择的 ${ep.provider} 请求协议不一致`, 'dialect'));
  }

  // —— baseUrl 形状 ——
  // 七牛官方 FAQ 点名过这两种错法：写成域名根、或把完整接口路径粘进来。两者都是「填完看起来没问题、
  // 一调用就 404」，而 404 的报错里看不出是 baseUrl 的锅，值得在保存时就说清楚。
  if (dialect.protocol === 'openai_chat' && ep.baseUrl.trim()) {
    const u = ep.baseUrl.trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(u)) {
      out.push(issue('error', 'BASEURL_HAS_ENDPOINT_PATH', 'baseUrl 不能包含 /chat/completions，只填到 /v1 为止', 'baseUrl'));
    } else if (!/\/v\d+$/.test(u) && !/\/compatible-mode\/v\d+$/.test(u)) {
      out.push(issue('warn', 'BASEURL_MISSING_VERSION', 'OpenAI 兼容网关的 baseUrl 通常要带版本段（如 …/v1）；确认过是自建网关可忽略', 'baseUrl'));
    }
  }

  // —— Thinking 互斥 ——
  const wantsThinking = ep.thinkingMode !== 'disabled';
  if (wantsThinking) {
    if (dialect.thinkingOff === 'unsupported') {
      out.push(issue('error', 'THINKING_UNSUPPORTED_DIALECT',
        `${dialect.label} 没有 thinking 字段，开启思考发不出去；请关闭思考或改用支持该扩展的网关`, 'thinkingMode'));
    }
    if (capOf(caps, 'thinking') === 'no') {
      out.push(issue('error', 'THINKING_CAP_NO',
        '探活已确认该模型不支持思考（部分模型确实不支持），不能开启', 'thinkingMode'));
    }
    if (dialect.protocol === 'openai_chat' && dialect.thinkingOff !== 'unsupported' && !/claude/i.test(ep.model)) {
      out.push(issue('warn', 'THINKING_OPENAI_NON_CLAUDE',
        'OpenAI 协议下 thinking 是网关私有扩展，通常只有 Claude 系模型认；请先用「测试连接」直测再开启', 'thinkingMode'));
    }
  }
  if (ep.thinkingMode === 'enabled') {
    const b = normalizeThinkingBudget(ep.thinkingBudget);
    if (b !== ep.thinkingBudget) {
      out.push(issue('warn', 'THINKING_BUDGET_CLAMPED',
        `思考预算会被夹到 ${MIN_THINKING_BUDGET}–${MAX_THINKING_BUDGET}，实际下发 ${b}`, 'thinkingBudget'));
    }
    if (!dialect.budgetHonored) {
      // DeepSeek 的 Anthropic 端点就是这一类：字段收下、取值忽略。不提示的话，运营会以为
      // 「调大预算 = 想得更深」，实际调了个寂寞。
      out.push(issue('warn', 'THINKING_BUDGET_IGNORED',
        `${dialect.label} 会忽略 budget_tokens：思考仍会开，但这个数字不生效`, 'thinkingBudget'));
    }
    const cap = caps.maxOutputTokens;
    const body = facts.bodyMaxTokens ?? 0;
    if (cap && body && b + body > cap) {
      // max_tokens 是「思考 + 正文」的总闸，撞上就断句——这正是 2026-08「回复未完整结束」的形状。
      out.push(issue('error', 'BUDGET_EXCEEDS_MAX_TOKENS',
        `思考预算 ${b} + 正文预算 ${body} 超过该端点实测上限 ${cap}，正文会被截断`, 'thinkingBudget'));
    }
  }

  // —— key 的模型范围（七牛 model groups）——
  if (facts.modelScope && facts.modelScope.length && ep.model && !facts.modelScope.includes(ep.model)) {
    out.push(issue('warn', 'MODEL_OUT_OF_KEY_SCOPE',
      `该 Key 的模型范围里没有 ${ep.model}${vendor?.caps.keyScoped ? '（需要在控制台把它加进 Key 的模型范围）' : ''}`, 'model'));
  }

  // —— 单价 ——
  const pin = ep.priceInput ?? 0;
  const pout = ep.priceOutput ?? 0;
  if (ep.provider !== 'mock') {
    if ((pin > 0) !== (pout > 0)) {
      out.push(issue('warn', 'PRICE_HALF_CONFIGURED',
        '输入价与输出价必须同时填，否则整个模型不校准（成本记 0、算力按裸 token）', 'priceInput'));
    } else if (pin === 0 && pout === 0) {
      out.push(issue('info', 'PRICE_MISSING', '未配单价：成本看板会记 0，算力按裸 token 扣', 'priceInput'));
    }
  }
  // 七牛的公开价目表只有「输入 / 输出 / 缓存输入」三档，**没有单独的缓存写档位**
  // （2026-08-07 核对模型广场，如 DeepSeek-V4-Pro 标的是「缓存输入 0.000025 元/K」）。
  // 我们的折算在 priceCacheWrite 留空时按 `输入价 × 1.25`（Anthropic 5m TTL 口径）推导——
  // 若七牛实际按输入价结算缓存写，这就是**系统性高估 25%**。证据还不足以改默认常量，
  // 但足以提醒运营把这一档显式填成与输入价相同。
  if (vendor?.id === 'qiniu' && pin > 0 && !(ep.priceCacheWrite ?? 0)) {
    out.push(issue('info', 'PRICE_CACHE_WRITE_UNSET_QINIU',
      '七牛公开价表只有「输入/输出/缓存输入」三档、未见单独的缓存写价；留空会按输入价 ×1.25 推导，可能高估成本。'
      + '建议向七牛确认后把「缓存写单价」显式填成与输入价相同（1×）', 'priceCacheWrite'));
  }

  for (const sib of facts.siblingPrices ?? []) {
    const same = sib.priceInput === pin && sib.priceOutput === pout
      && sib.priceCachedInput === (ep.priceCachedInput ?? 0)
      && sib.priceCacheWrite === (ep.priceCacheWrite ?? 0);
    if (!same) {
      out.push(issue('warn', 'PRICE_INCONSISTENT',
        `同名模型 ${ep.model} 在其它端点上的单价不一致 → 整个模型退回未校准。需要按端点分价请先把费率键升级为 endpointId`, 'priceInput'));
      break;
    }
  }

  // —— 七牛 Anthropic 入口的路径 ——
  // 官方给的取值是 ANTHROPIC_BASE_URL=https://api.qnaigc.com（见 qiniu/coding-helper），
  // 而我们生产用的是 /bypass/anthropic —— 这个路径在七牛任何公开文档里都查不到。
  // 两个都能跑不代表两个都对：中转路径不同，上游后端扇出与提示词缓存的归属可能不同，
  // 而 2026-07 那次「缓存 88% 未命中」的悬案至今没有别的解释。故提示而不阻断。
  if (vendor?.id === 'qiniu' && dialect.protocol === 'anthropic' && /\/bypass\//.test(ep.baseUrl)) {
    out.push(issue('info', 'QINIU_ANTHROPIC_UNDOCUMENTED_PATH',
      '该路径未见于七牛公开文档；官方 Anthropic 入口是 https://api.qnaigc.com。'
      + '两者都能调通不代表等价（后端扇出与提示词缓存归属可能不同），建议向七牛确认后统一', 'baseUrl'));
  }

  // —— 方言还在靠猜 ——
  if (!explicit && ep.provider !== 'mock') {
    out.push(issue('info', 'DIALECT_INFERRED',
      `协议方言当前按 ${dialect.label} 推断。确认无误后点「确认固化」，这个端点从此不靠猜`, 'dialect'));
  }
  return out;
}

/** 嵌入 / 重排端点：协议与厂商两条都要判，少一条就漏。 */
export function validateAuxEndpoint(
  kind: 'embedding' | 'rerank',
  aux: { enabled: boolean; model: string; baseUrl: string; hasKey: boolean },
  chat: { provider: AiProvider; baseUrl: string; model: string; dialect?: string | null; hasKey: boolean },
): AiConfigIssue[] {
  if (!aux.enabled) return [];
  const out: AiConfigIssue[] = [];
  const name = kind === 'embedding' ? '嵌入' : '重排';
  if (!aux.model.trim()) out.push(issue('error', 'AUX_MODEL_REQUIRED', `${name}已开启但没填模型`, `${kind}Model`));

  // 留空＝复用对话端点。两条独立的否决理由：
  const reusingBase = !aux.baseUrl.trim();
  const reusingKey = !aux.hasKey;
  if (reusingBase || reusingKey) {
    const { dialect } = resolveDialect(chat);
    // ① 协议不符：Anthropic 协议根下没有 /embeddings 这个路径，与厂商是谁无关。
    if (!dialect.auxEndpointsSameOrigin) {
      out.push(issue('error', 'AUX_ORIGIN_PROTOCOL_MISMATCH',
        `对话端点走 ${dialect.label}，复用它拼出的 /${kind === 'embedding' ? 'embeddings' : 'rerank'} 路径不存在；${name}必须单独填网关与 Key`,
        `${kind}BaseUrl`));
    } else {
      // ② 厂商没有这个能力：协议合法也没用。七牛的 OpenAI 入口正是这一类，只判协议会漏掉。
      const caps = vendorCapsOf(chat.baseUrl);
      const has = kind === 'embedding' ? caps.embedding : caps.rerank;
      if (!has) {
        const v = vendorOf(chat.baseUrl);
        out.push(issue('error', 'AUX_VENDOR_UNSUPPORTED',
          `${v?.label ?? '当前接入商'}不提供${name}模型，复用对话端点必定失败；请指向其它厂商，或关掉开关用本地兜底`,
          `${kind}BaseUrl`));
      }
    }
  }
  return out;
}

/** 路由成员在校验里用得到的事实。判据一律是成员**自身**的方言，不是任何全局拷贝值。 */
export interface RouteMemberFacts {
  id: string;
  label: string;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  dialect?: string | null;
  hasKey: boolean;
}

/**
 * 路由 / 端点池的成员一致性。
 *
 * `prior` 是**库里已存的这条路由**（可选）。给了它，校验器才分得清两件事：
 * 「这次编辑添的乱」和「池子里本来就有、运营正在收拾的旧账」。见下方 leniency 段的长注释。
 */
export function validateRoute(
  route: { mode: 'single' | 'pool'; sticky?: boolean },
  members: RouteMemberFacts[],
  prior?: { mode: 'single' | 'pool'; members: RouteMemberFacts[] },
): AiConfigIssue[] {
  const out = routeShapeIssues(route, members);
  if (!prior) return out;

  // ── 为什么要拿「已存状态」再判一遍 ─────────────────────────────────────────
  // 拦错配是为了别让运营把池子改坏，**不是把已经坏了的池子锁死**。可一律按提议状态判 error，
  // 结果就是：混协议的池里，移出任何一个成员都会被**剩下的成员**挡住（剩下的还是混的），
  // 而「删端点」又要求先从路由移出——运营被夹死，唯一暗门是先把分流整个关掉。
  // 2026-08-27 线上正是这个形状：一次 409 同时报「池内混协议」和「某成员接入商未确认」，
  // 两条都指向别的成员，运营想动的那一下反而无论如何都保存不了。
  //
  // 规则：这次编辑**没有新增成员**、且报出来的问题**已存状态里就有**，就不阻断保存，只降为
  // 提醒。于是「收拾池子」的每一步都走得通；而「开分流」「加不兼容的新成员」照旧拦得死——
  // 那两种才是真的在添乱（已存状态是 single 时 routeShapeIssues 直接返回空，天然拦住开分流）。
  const priorErrors = new Set(routeShapeIssues({ mode: prior.mode }, prior.members)
    .filter((i) => i.level === 'error').map((i) => i.code));
  if (!priorErrors.size) return out;
  const priorIds = new Set(prior.members.map((m) => m.id));
  if (members.some((m) => !priorIds.has(m.id))) return out;
  return out.map((i) => (i.level === 'error' && priorErrors.has(i.code)
    ? issue('warn', i.code, `${i.message}（这次改动没让它更糟，故不阻断保存；仍要修完）`, i.field)
    : i));
}

function routeShapeIssues(
  route: { mode: 'single' | 'pool'; sticky?: boolean },
  members: RouteMemberFacts[],
): AiConfigIssue[] {
  const out: AiConfigIssue[] = [];
  if (route.mode !== 'pool') return out;

  if (members.length === 0) {
    out.push(issue('error', 'POOL_EMPTY', '池内没有已启用的端点，开启分流等于把 AI 关了'));
    return out;
  }

  const mock = members.filter((m) => m.provider === 'mock');
  if (mock.length) {
    out.push(issue('error', 'POOL_HAS_MOCK', `本地模板不能入池：${mock.map((m) => m.label).join('、')}`));
  }

  // 协议必须一致——Anthropic 的 messages 请求发到 OpenAI 的 chat/completions 端点必错。
  // 判据是**成员自身的方言**，不是 AiSetting.provider 那个拷贝值：拷贝值会漂移，
  // 而且它回答的是「当前生效模型是什么协议」，跟池自不自洽根本是两个问题。
  const byProtocol = new Map<string, string[]>();
  for (const m of members) {
    const p = resolveDialect(m).dialect.protocol;
    byProtocol.set(p, [...(byProtocol.get(p) ?? []), m.label]);
  }
  if (byProtocol.size > 1) {
    const desc = [...byProtocol.entries()].map(([p, labels]) => `${p}（${labels.join('、')}）`).join(' vs ');
    // 措辞按运行时的**实际**行为写，别照抄「请求形状对不上」——`resolveCandidates` 只在与本次
    // 生效协议相同的成员里选（llmPool 的 compatible 过滤，有单测钉死），所以混池不会发错形状。
    // 真正的后果是**少数协议的那批成员永远收不到流量**：运营以为有 3 路冗余、实际只有同协议的
    // 那几个在分流，某个端点被限流时可转移的范围也比看上去小。仍然判 error——这不是「能跑但
    // 要知道」，而是这份配置压根表达不了运营的意图。
    out.push(issue('error', 'POOL_PROTOCOL_MISMATCH',
      `池内混用了不同协议：${desc}。运行时只在与生效端点同协议的成员之间分流，另一批永远收不到流量；`
      + '请统一协议，或把它们拆到两个用途下'));
  }

  const noKey = members.filter((m) => m.provider !== 'mock' && !m.hasKey);
  if (noKey.length) {
    out.push(issue('error', 'POOL_MEMBER_NO_KEY',
      `没配 Key 的端点在池里只会稳定失败并白白消耗一次故障转移配额：${noKey.map((m) => m.label).join('、')}`));
  }

  // 方言不同但协议相同是允许的（比如官方直连 + 兼容网关混池），但关闭思考的写法不一样，
  // 值得提示一句——这不是错误，是运营该知道的事实。
  const dialects = new Set(members.map((m) => resolveDialect(m).dialect.id));
  if (dialects.size > 1 && byProtocol.size === 1) {
    out.push(issue('info', 'POOL_MIXED_DIALECTS',
      `池内有 ${dialects.size} 种方言，请求细节（如关闭思考的写法）各自组装，属正常；确认这是有意为之即可`));
  }
  return out;
}

/** 有没有 error 级问题（调用方据此决定拒绝还是放行）。 */
export function hasBlocking(issues: AiConfigIssue[]): boolean {
  return issues.some((i) => i.level === 'error');
}

/** 拼成给运营看的一行报错。 */
export function blockingMessage(issues: AiConfigIssue[]): string {
  return issues.filter((i) => i.level === 'error').map((i) => i.message).join('；');
}
