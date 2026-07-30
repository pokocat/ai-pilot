// AI 排版引擎 · 阶段一：**视觉哲学宣言**（LLM #1）。
//
// 与 philosophy.ts 的关系：那份产出六个结构化维度，是**模板路径**的输入（模板只消费 palette + movement）；
// 这份产出一篇 4–6 段的中文长文，是**创作路径**的输入——下一步模型要读着它去写整页 HTML。
// 两者并存不是重复：模板需要可直接填空的字段，创作需要可被"读懂"的美学立场。回落到模板时用前者。
//
// 提示词是 `server/src/creative/canvas-design/SKILL.upstream.md` 的移植（Apache 2.0，见 NOTICE.md），
// 关键句式逐条对应上游原文（下方注释标了对应关系），并按 design-philosophy.md §1.4 做商业耦合改编。
// ⚠️ 运行时**不得**用 fs 读那两份 md（生产镜像只含 dist/）；改这里必须同步改 design-philosophy.md。
import { z } from 'zod';
import { structured } from '../../llm/gateway.js';
import { moderate } from '../moderation.js';
import type { NormalizedPosterBrief } from './schema.js';
import type { TemplateKey } from './config.js';
import type { BrandKitView } from '../../../../shared/contracts';

/* ───────────────── 提示词 ───────────────── */

const HEX = /^#[0-9a-fA-F]{6}$/;

// 上游 → 本提示词的移植对照（改动这段时保持这层对应关系可查）：
//   "Write a manifesto for an art movement"                  → 【产物】第一句
//   "Name the movement (1-2 words)"                          → movement 字段约束
//   "Articulate the philosophy (4-6 paragraphs)"              → manifesto 4–6 段
//   "Avoid redundancy: each design aspect mentioned once"     → 【避免冗余】
//   "Emphasize craftsmanship REPEATEDLY ... meticulously
//    crafted / product of deep expertise / painstaking
//    attention / master-level execution"                      → 【工艺感必须反复强调】四个词组直译
//   "Leave creative space ... room to make interpretive
//    choices also at an extremely high level of craft"        → 【留出创作空间】
//   "Information lives in design, not paragraphs"             → 【视觉优先】
//   "a subtle, niche reference embedded within the art
//    itself ... like a jazz musician quoting another song"    → 【隐性主题】爵士乐引用那句原样保留
const MANIFESTO_SYS = [
  '你是「军师参谋部」的视觉总监。为下面这一张商业海报**写一篇美学运动的宣言**——不是排版方案，',
  '不是执行清单，而是一套可被人读懂的美学立场：它信什么、拒绝什么、如何用空间与色彩说话。',
  '这篇宣言接下来会交给同一水准的设计师，由他直接用代码在画布上把它表达出来。',
  '',
  '【产物】',
  '- movement：1–2 个词的中文命名，像一场小型美学运动的名字（如「几何静默」「纸墨秩序」「留白宣言」）。',
  '  不得出现产品名、客户名、行业名，也不要写成形容词堆叠。',
  '- manifesto：4–6 段，每段 2–4 句。它要交代（每个方面**只讲一次**）：',
  '  空间与形 / 色彩与材质 / 尺度与节奏 / 构图与平衡 / 视觉层级 / 工艺感。',
  '- palette：3–5 个十六进制色值（含一个可作强调色的暖色或金属色）。',
  '- reference：一句话说明「这门生意的灵魂」将如何被藏进画面（见下方【隐性主题】）。它是给设计师的私语，',
  '  **不会**被印在海报上。',
  '',
  '【避免冗余】同一件事不要在多段里反复重申。色彩讲过就不要再讲一遍色彩理论，除非能补上新的深度。',
  '',
  '【工艺感必须反复强调】成品必须看起来像**花了很久**、由这一行最顶尖的人反复打磨过。',
  '宣言正文要多次落到这个要求上：精工细作、深厚专业积累的产物、近乎苛刻的推敲、大师级执行。',
  '这不是修辞，它是给下一步的质量下限——任何「一眼像自动生成」的画面都不合格。',
  '',
  '【留出创作空间】方向要具体，但不要替下一步做版式决定（不许出现「标题放左上」「用三栏网格」）。',
  '写到「读完就知道该往哪走，但还有的选」为止，且那些选择本身也必须是极高工艺水准的选择。',
  '',
  '【视觉优先】一张海报 ≈ 90% 视觉 + 10% 必要文字。信息活在设计里，不活在段落里。',
  '文字是视觉元素，不是段落容器；宣言要为「极少的字」立规矩，而不是给文案留位置。',
  '',
  '【隐性主题】把这门生意的灵魂（行业气质 / 目标客群 / 核心主张）作为隐晦线索织进画面——',
  '像一个爵士乐手在独奏里引用另一首曲子：懂的人会心一笑，不懂的人也只是听到一段好音乐。',
  '**不要直白复述卖点**；线索只能藏在纹理、色彩关系、重复母题这类不影响读取的层里。',
  '',
  '【商业耦合（本项目要求，上游没有）】宣言必须与这张海报的商业目标与客群气质一致：',
  '面向投资人的发布海报与面向社群的活动海报，不该共享同一套美学立场。',
  '海报的第一职责仍是让目标客群三秒内看懂「这是什么、为什么可信、下一步做什么」——',
  '艺术性不得牺牲主标题可读性、CTA 显著性或二维码可扫性。',
  '',
  '【红线】不得指名复刻任何在世创作者或其作品；只描述画面属性（结构/色彩/材质/光线/构图）。',
  '',
  '只输出 JSON：{"movement":"","manifesto":["段一","段二","段三","段四"],"palette":["#RRGGBB"],"reference":""}',
  '全部用中文，克制、具体、不说空话。',
].join('\n');

/** 模板选择只作气质提示（AI 引擎不套模板，但用户挑的那套版式表达了他要的音量）。 */
const TEMPLATE_TENDENCY: Record<TemplateKey, string> = {
  person_hero: '用户偏好「人物主视觉」：画面重心在人，光与材质要服务可信度。',
  editorial: '用户偏好「编辑杂志」：大留白、强排印、克制的音量。',
  business_launch: '用户偏好「商业发布」：信息读取要快，同时不牺牲质感与工艺。',
};

const ManifestoSchema = z.object({
  movement: z.string().catch('').default(''),
  // 模型有时把 4 段写成一个带换行的长字符串——按空行/换行切开即可，不必为此判整份失败。
  manifesto: z.preprocess(
    (v) => (typeof v === 'string' ? v.split(/\n+/) : v),
    z.array(z.string()).catch([]),
  ),
  palette: z.array(z.string()).catch([]).default([]),
  reference: z.string().catch('').default(''),
});

export interface PosterManifesto {
  movement: string;
  /** 4–6 段（已 trim、去空段）。 */
  paragraphs: string[];
  palette: string[];
  /** 隐性主题私语（进提示词，不进画面）。 */
  reference: string;
}

/** 宣言全文（落 CreativeJob.promptSnapshot 可追溯；也是送审文本）。 */
export function manifestoText(m: PosterManifesto): string {
  return [
    `【${m.movement}】`,
    ...m.paragraphs,
    `色板：${m.palette.join(' ')}`,
    m.reference ? `隐性主题：${m.reference}` : '',
  ].filter(Boolean).join('\n');
}

function digest(brief: NormalizedPosterBrief, kit?: BrandKitView | null): string {
  const lines = [
    `场景：${brief.scene}`,
    `商业目标：${brief.goal}`,
    `目标客群：${brief.audience}`,
    `主标题：${brief.headline}`,
    brief.subheadline ? `副标题：${brief.subheadline}` : '',
    brief.proofPoints.length ? `卖点：${brief.proofPoints.join('；')}` : '',
    `行动号召：${brief.cta}`,
    brief.visualDirection ? `视觉方向：${brief.visualDirection}` : '',
    brief.negativePrompt ? `排除项（不要出现）：${brief.negativePrompt}` : '',
    TEMPLATE_TENDENCY[brief.templateKey],
    brief.portraitAssetId ? '用户提供了人物照片' : '没有人物照片（用图形与排印作画，不要留空的人物位）',
  ];
  if (kit) {
    lines.push(
      kit.persona?.tone ? `品牌语气：${kit.persona.tone}` : '',
      (kit.theme?.keywords ?? []).length ? `品牌视觉关键词：${(kit.theme!.keywords).join('、')}` : '',
      kit.theme?.colorHint ? `品牌主色建议（优先于自定色板）：${kit.theme.colorHint}` : '',
      (kit.voice?.taboos ?? []).length ? `品牌禁忌：${(kit.voice!.taboos).join('、')}` : '',
    );
  }
  return lines.filter(Boolean).join('\n');
}

/**
 * 生成宣言。**返回 null 表示这条路走不通**（无 live provider / 内容不完整 / 未过审），
 * 由调用方（worker）回落模板路径 —— 宣言不做「确定性兜底长文」：一篇兜底长文喂给创作步，
 * 只会让模型照着一段谁都能写的话去自由发挥，画质反而不如三套调过版的模板。
 */
export async function generateManifesto(opts: {
  brief: NormalizedPosterBrief;
  brandKit?: BrandKitView | null;
  /** 色板兜底（模型给的色值不合法时用，通常传 philosophy.palette）。 */
  fallbackPalette: string[];
  tenantId?: string | null;
  userId?: string | null;
}): Promise<PosterManifesto | null> {
  let ai: z.infer<typeof ManifestoSchema> | null = null;
  try {
    ai = await structured(ManifestoSchema, {
      system: MANIFESTO_SYS,
      user: digest(opts.brief, opts.brandKit),
      maxChars: 4000,
      // ★ 必须显式给产出预算：provider 辅助档缺省 700 token，而 4-6 段中文宣言 + JSON 壳
      //   远超 700 —— 2026-07-30 生产实锤被拦腰截断，首轮与纠错轮一起截，structured 恒 null，
      //   AI 排版引擎 100% 静默回落模板（错误话术只说「产出不完整」，实际是这里）。
      maxTokens: 2600,
    });
  } catch (err) {
    console.warn('[creative] 宣言生成失败：', (err as Error).message);
  }
  if (!ai) {
    // structured 返回 null 有自己的沉默路径（无 live provider / 两轮 JSON 校验都不过）。
    // 这个分支曾经静默返回——生产回落时 journalctl 里一条痕迹都没有，排障只能靠猜。
    console.warn('[creative] 宣言生成未产出（无 provider 或两轮 JSON 校验失败），回落模板路径');
    return null;
  }

  const paragraphs = (ai.manifesto ?? []).map((p) => String(p ?? '').trim()).filter(Boolean).slice(0, 6);
  const body = paragraphs.join('');
  // 宽容但有底线：要求 ≥3 段且总量 ≥180 字。上游要 4–6 段，但为「差一段就整单退回模板」付出的
  // 代价（用户拿到模板图）比接受一篇 3 段但成立的宣言大得多。
  if (!ai.movement.trim() || paragraphs.length < 3 || body.length < 180) {
    console.warn('[creative] 宣言不完整，回落模板路径：', `movement=${!!ai.movement} 段数=${paragraphs.length} 字数=${body.length}`);
    return null;
  }
  const hex = ai.palette.map((c) => String(c ?? '').trim()).filter((c) => HEX.test(c));
  const out: PosterManifesto = {
    movement: ai.movement.trim().slice(0, 20),
    paragraphs,
    palette: hex.length >= 3 ? hex.slice(0, 5) : opts.fallbackPalette,
    reference: ai.reference.trim().slice(0, 200),
  };

  // 输出侧审核（fail-closed，同 philosophy）：宣言会进 promptSnapshot 并间接决定画面，必须过审。
  const pass = await moderate('output', manifestoText(out), {
    tenantId: opts.tenantId ?? null,
    userId: opts.userId ?? null,
  });
  if (!pass) {
    console.warn('[creative] 宣言未过审核，回落模板路径');
    return null;
  }
  return out;
}
