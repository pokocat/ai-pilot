// 爱速拍的脚本 AI —— **全部走军师自己的 LLM 网关**（契约 ai-quickreel `docs/WORKPLAN_2026-09-05.md`
// §1.3 与 WP-A3）。本文件覆盖三条产出：
//   · 一句话生成全片（§1.3，`POST /video/projects/:id/script/generate`）
//   · 全篇改写 / 润色（`script/ai-rewrite` 的 `scope:'all'`）
//   · 单句改写（`script/ai-rewrite` 的 `scope:'segment'`）
//
// **为什么不复用 aidrama 的 `script/ai-rewrite`**：读过上游实现
// （`AIStarEcosystem/.../clip/service/ClipScriptService.rewrite`）——方法第一行就是
// 「非 mock 网关 → 503 `CLIP_SCRIPT_ENGINE_NOT_CONFIGURED`」，clip 域**根本没有接 LLM**，
// 只有确定性占位引擎（`scope:'segment'` 是给原文拼一句固定尾巴，`scope:'all'` 是把指令切成短句轮流塞）。
// 生产环境调它拿到的是 503，不是降级文案。所以三条产出一律在 BFF 这一层实现。
//
// **只在模板骨架内写**：段数、role、hint 全部沿用项目现有 segments（模板骨架），
// 模型只负责逐段填 / 换 `text`。这样不会把模板的节奏结构改掉，也不给模型自由加段的机会。
import { z } from 'zod';
import type { ClipProject, ClipSegment, ClipShot } from '../../../../shared/contracts';
import { structuredMetered } from '../../llm/gateway.js';
import { PRODUCT } from '../products.js';
import { defaultClipShots } from './scriptChat.js';

/** 一句话上限（与端上输入框一致）。 */
export const BRIEF_MAX_CHARS = 500;
/** 单句改写的原文与全篇改写指令的上限（与 aidrama 旧口径一致，避免端上被无声收紧）。 */
export const REWRITE_MAX_CHARS = 500;

/**
 * 脚本 AI 引擎开关。
 *
 * · `bff`（**默认**）：`script/ai-rewrite` 的两个 scope 都在军师自己的 LLM 网关里实现。
 * · `aidrama`：退回历史透传。**生产环境这条路必然 503 `CLIP_SCRIPT_ENGINE_NOT_CONFIGURED`**
 *   （上游 clip 域没接 LLM，只在 `AEP_CLIP_FORCE_MOCK=true` 的确定性引擎下才有返回），
 *   只留给「要拿上游确定性输出对拍」的联调场景，不要配到生产。
 */
export function videoScriptEngine(): 'bff' | 'aidrama' {
  return (process.env.VIDEO_SCRIPT_ENGINE ?? '').trim().toLowerCase() === 'aidrama' ? 'aidrama' : 'bff';
}

const SYSTEM = `你是“爱速拍”的短视频口播文案写手，服务对象是实体店老板。
老板会用一句话说明他的生意和他想说的事，你要按给定的段落骨架逐段写口播稿。
硬性要求：
1. 段数、每段的 role 与画面提示都已经定好，你**只能**逐段填文案，不许增删段落、不许改 role。
2. 每段一个完整语义节拍，字数贴近给定的目标字数（上下浮动三成以内）。
3. 只用老板真的说过的信息。**绝不编造**销量、年份、门店数、荣誉、顾客评价或任何经营数字；
   信息不够就把那一段写成朴素的自我介绍或邀请，不要填充虚构细节。
4. 用口语中文，像人在镜头前说话，不写书面语、不写旁白式解说、不加表情符号。
5. role=avatar 的段落是本人出镜说话；role=broll 的段落是画面承接，文案仍是同一个人的旁白。
只输出 JSON：{"segments":[{"no":1,"text":"这一段的口播文案"}]}`;

/** 单句改写：骨架只有一段，且必须守住这一段在整稿里的位置与语气。 */
const SEGMENT_SYSTEM = `你是“爱速拍”的短视频口播文案写手，服务对象是实体店老板。
老板正在逐段打磨口播稿，这次只改其中一段。
硬性要求：
1. **只重写给定的这一段**，不许写成两段、不许顺带续写下一段、不许加旁白式解说。
2. 这一段的角色（本人出镜 / 画面承接）、画面提示和它在整稿里的位置都已经定好，你不许改，
   只换措辞。字数贴近给定的目标字数（上下浮动三成以内）。
3. 只用原文与上下文里已经有的信息。**绝不编造**销量、年份、门店数、荣誉、顾客评价或任何经营数字。
4. 用口语中文，和上下段是同一个人在说话；不写书面语、不加表情符号、不加引号或段号。
5. 如果原文已经很好，也要给出一版更像本人说话的表达，不要原样退回。
只输出 JSON：{"text":"改写后的这一段"}`;

const clean = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max);

interface SkeletonRow {
  no: number;
  role: ClipSegment['role'];
  hint: string;
  targetChars: number;
  /** 骨架原文。生成（brief）时不进提示词，改写 / 润色时必须进——那是改写的底稿。 */
  originText: string;
}

/** 从项目现有 segments 取模板骨架（尾卡不参与生成，出片时由系统保留）。 */
function skeletonOf(project: ClipProject): { rows: SkeletonRow[]; content: ClipSegment[]; tail: ClipSegment[] } {
  const content = (project.segments ?? []).filter((item) => item.role !== 'tail').map((item) => ({ ...item }));
  const tail = (project.segments ?? []).filter((item) => item.role === 'tail').map((item) => ({ ...item }));
  const rows = content.map((item, index) => ({
    no: index + 1,
    role: item.role,
    hint: clean(item.hint, 60),
    // 目标字数优先按骨架原文，其次按时长估（约 4.5 字/秒），都没有就给 40。
    targetChars: item.text?.trim().length
      || (item.durationSec ? Math.round(item.durationSec * 4.5) : 0)
      || 40,
    originText: clean(item.text, 180),
  }));
  return { rows, content, tail };
}

const roleLabel = (role: ClipSegment['role']) => (role === 'avatar' ? '本人出镜' : '画面承接');

/**
 * 整稿产出的三种意图。`brief` 是从零按一句话写；另外两种都是在**现有文案**上动，
 * 提示词里必须带原文，否则模型会把「润色」做成「重写一份没见过的稿」。
 */
export type ScriptAllMode =
  | { kind: 'brief'; brief: string }
  | { kind: 'rewrite'; instruction: string }
  | { kind: 'polish' };

function promptOf(project: ClipProject, rows: SkeletonRow[], mode: ScriptAllMode): string {
  const withOrigin = mode.kind !== 'brief';
  const skeleton = rows.map((row) => {
    const head = `第 ${row.no} 段 · ${roleLabel(row.role)} · 目标 ${row.targetChars} 字${row.hint ? ` · 画面：${row.hint}` : ''}`;
    return withOrigin && row.originText ? `${head}\n  原文：${row.originText}` : head;
  }).join('\n');
  const tailLine = mode.kind === 'brief'
    ? `老板这句话：${mode.brief}`
    : mode.kind === 'rewrite'
      ? `老板这次的要求：${mode.instruction}\n请在保留原文真实信息的前提下，按这个要求逐段重写。`
      : '老板没有提具体要求，请逐段润色：保留全部事实与信息量，只让它更像本人在镜头前说话。';
  return [
    `模板：${project.templateName ?? project.title ?? '未命名'}`,
    `段落骨架（共 ${rows.length} 段，必须逐段对应）：`,
    skeleton,
    tailLine,
  ].join('\n');
}

/**
 * 整稿产出（生成 / 全篇改写 / 润色共用一条链路）。返回**已经落好序号**的 segments 与 shots，
 * 交给调用方写回上游项目。模型没给出可用结果时抛错，绝不悄悄回落成「原稿没变但提示成功」。
 */
export async function generateClipScriptAll(project: ClipProject, mode: ScriptAllMode): Promise<{
  segments: ClipSegment[];
  shots: ClipShot[];
}> {
  const { rows, content, tail } = skeletonOf(project);
  if (!rows.length) {
    throw Object.assign(new Error('这套模板还没有段落骨架，请换一套模板再试'), {
      statusCode: 422, code: 'CLIP_SCRIPT_SKELETON_EMPTY',
    });
  }

  const schema = z.object({
    segments: z.array(z.object({
      no: z.number().int().min(1).max(rows.length),
      text: z.string().min(1).max(180),
    })).min(rows.length).max(rows.length),
  });

  const outcome = await structuredMetered(schema, {
    system: SYSTEM,
    user: promptOf(project, rows, mode),
    maxChars: 12_000,
    // 与 scriptChat 同因：辅助档默认 700 token 会把整稿 JSON 拦腰截断。
    maxTokens: 2_400,
    // 这是用户正盯着等的生成，不是后台抽取——不许落到 aux 小模型（见 gateway.ts allowAux 注释）。
    allowAux: false,
    // 成本归属：AI 写稿是爱速拍烧的钱。不标的话它会以 kind='aux' 落进「非用户用量消耗」，
    // 和军师的嵌入 / 重排 / 探活混成一桶，独立运营就答不出「爱速拍的 AI 成本是多少」。
    usageMeta: { productCode: PRODUCT.quickreel },
  });
  const data = outcome.data as { segments: { no: number; text: string }[] } | null;
  if (!data) {
    throw Object.assign(new Error('这次没有生成出可用的文案，请再说一次或换个说法'), {
      statusCode: 502, code: 'CLIP_SCRIPT_AI_INVALID',
    });
  }

  const byNo = new Map<number, string>();
  for (const row of data.segments) {
    const text = clean(row.text, 180);
    if (text && !byNo.has(row.no)) byNo.set(row.no, text);
  }
  if (byNo.size !== rows.length) {
    throw Object.assign(new Error('这次没有生成出可用的文案，请再说一次或换个说法'), {
      statusCode: 502, code: 'CLIP_SCRIPT_AI_INVALID',
    });
  }

  // 只换 text：role / hint / 素材绑定 / 时长等骨架字段原样保留。
  const filled: ClipSegment[] = content.map((item, index) => ({ ...item, text: byNo.get(index + 1) as string, actualDurationSec: 0 }));
  const segments = filled.concat(tail).map((item, index) => ({ ...item, no: index + 1 }));
  return { segments, shots: defaultClipShots(segments) };
}

/** §1.3 的入口，保持原签名（`script/generate` 与既有测试在用）。 */
export function generateClipScriptFromBrief(project: ClipProject, brief: string) {
  return generateClipScriptAll(project, { kind: 'brief', brief });
}

/**
 * 单句改写（`scope:'segment'`）。
 *
 * 保留该段的 `role`、`hint` 与字数目标，并把相邻两段原文一起给模型做语气参照——
 * 单句改写最容易翻车的地方就是改出来的那一句和上下文不是同一个人在说话。
 *
 * **不落库**：与历史行为（aidrama 的 `scope:'segment'` 只回文案、不写项目）一致。端上把结果放进
 * 编辑框，用户可能还要改、也可能放弃，落库交给端上现有的 `saveProject` 防抖。
 */
export async function rewriteClipSegment(project: ClipProject, no: number | null, source: string): Promise<{ no: number; text: string }> {
  const { rows } = skeletonOf(project);
  // 端上传的是编辑框里的当前文案（可能还没保存），所以正文以 `source` 为准；
  // `no` 只用来取骨架约束。取不到（例如端上新增了尚未保存的段）就按这句话自身兜底，
  // 不因为一次序号对不上就把用户的改写请求直接打回。
  const row = rows.find((item) => item.no === no) ?? null;
  const role: ClipSegment['role'] = row?.role ?? 'avatar';
  const hint = row?.hint ?? '';
  const targetChars = row?.targetChars || source.trim().length || 40;
  const before = row ? rows.find((item) => item.no === row.no - 1)?.originText ?? '' : '';
  const after = row ? rows.find((item) => item.no === row.no + 1)?.originText ?? '' : '';

  const outcome = await structuredMetered(z.object({ text: z.string().min(1).max(180) }), {
    system: SEGMENT_SYSTEM,
    user: [
      `模板：${project.templateName ?? project.title ?? '未命名'}`,
      row ? `整稿共 ${rows.length} 段，这次改第 ${row.no} 段。` : '这次只改一段。',
      `这一段 · ${roleLabel(role)} · 目标 ${targetChars} 字${hint ? ` · 画面：${hint}` : ''}`,
      before ? `上一段（不要改，只作语气参照）：${before}` : '',
      after ? `下一段（不要改，只作语气参照）：${after}` : '',
      `这一段的原文：${source}`,
    ].filter(Boolean).join('\n'),
    maxChars: 8_000,
    // 单段 JSON 短，但仍显式给预算：辅助档 700 的默认值遇到长句 + 纠错轮会截断。
    maxTokens: 900,
    // 用户正盯着编辑框等这一句，不许落到 aux 小模型（见 gateway.ts allowAux 注释）。
    allowAux: false,
    usageMeta: { productCode: PRODUCT.quickreel },
  });
  const data = outcome.data as { text: string } | null;
  const text = clean(data?.text, 180);
  if (!text) {
    throw Object.assign(new Error('这次没有改出可用的文案，原句没有改动，请再试一次'), {
      statusCode: 502, code: 'CLIP_SCRIPT_AI_INVALID',
    });
  }
  return { no: row?.no ?? (typeof no === 'number' ? no : 0), text };
}
