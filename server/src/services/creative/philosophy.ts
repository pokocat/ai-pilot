// 视觉哲学生成（阶段一）：先立美学立场，再作视觉表达。方法论底稿见
// `server/src/creative/canvas-design/design-philosophy.md`（人类可读解释来源）。
//
// ⚠️ 硬约束（P1 已核实）：**运行时不得用 fs 读那份 md**——生产镜像只含 dist/，不含 src/。
// 因此把需要进提示词的段落内联为下面的 TS 常量。**改提示词必须同步改那份 md**，
// 否则视为文档与代码不一致（AGENTS.md §0）。
//
// 形态抄 services/brandKit.ts：Zod 约束输出 + 无 provider / 校验失败 → 确定性回退（不阻塞任务）。
// 输出走 moderate('output', ...) 审核（fail-closed）：审核不过就用回退哲学继续出图，不让任务失败——
// 哲学只是中间产物，用户要的是那张图。
import { z } from 'zod';
import { structured } from '../../llm/gateway.js';
import { moderate } from '../moderation.js';
import type { NormalizedPosterBrief } from './schema.js';
import type { TemplateKey } from './config.js';
import type { BrandKitView, PosterScene } from '../../../../shared/contracts';

/* ───────────────── 提示词（design-philosophy.md 的核心段落内联） ───────────────── */

// 对应 md §0 + §1（阶段划分、产物形态、六维度、工艺感、商业耦合）。
const PHILOSOPHY_SYS = [
  '你是「军师参谋部」的视觉总监。任务是为一张商业海报先写出一套「视觉哲学」——一个可被人读懂的美学立场，',
  '而不是排版方案。哲学决定气质，模板只负责秩序；跳过哲学直接套模板，出来的就是模板感。',
  '',
  '【产物形态】',
  '- movement：1–2 个词的中文命名，像一场小型美学运动的名字（如「几何静默」「纸墨秩序」「留白宣言」）。',
  '  不得出现产品名、客户名、行业名，也不要写成形容词堆叠。',
  '- 六个维度各回答一次，不要在多处重申同一件事：',
  '  space（空间与形：画面靠块面/网格/轴线/虚空里的什么说话）、',
  '  color（色彩与材质：有限色板如何承担信息，纸感/墨迹/金属/哑光如何服务可信度）、',
  '  scale（尺度与节奏：什么放到极大、什么压到极小，重复与间隔如何形成呼吸）、',
  '  composition（构图与平衡：对称还是失衡，张力从哪来，视线如何被引导）、',
  '  hierarchy（视觉层级：第一眼看到什么，第二眼，第三眼才发现什么）、',
  '  craft（工艺感：哪些细节体现被反复打磨过——对齐、留白收口、字距、边缘处理）。',
  '- craft 必须落到「精工细作、反复推敲、专业级执行、每一处对齐都是选择」这个质量下限上：',
  '  任何一眼像自动生成的画面都不合格。',
  '',
  '【禁止】',
  '- 不写具体版式（不许出现「标题放左上」「用三栏网格」这类指令），那是模板与渲染器的职责；',
  '- 不写卖点原文，不替客户决定文案；',
  '- 不指名复刻任何在世创作者或其作品——只描述画面属性（结构/色彩/材质/光线/构图）。',
  '',
  '【商业耦合】哲学要与这张海报的商业目标和目标客群气质一致：面向投资人的发布海报与面向社群的活动海报，',
  '不该共享同一套美学立场。若信息量明显超出一张海报（多目标、多 CTA、卖点超过 3 条），',
  '在 note 里给出「建议拆成多张」的判断，而不是靠缩小字号硬塞。',
  '',
  '【视觉主体提示词】visualPrompt 是给图片模型的一句话（80 字内），只描述人物形象/背景/光影/材质/构图，',
  '并明确要求「在画面指定区域留出干净负空间供后续排版」。**其中绝不允许出现任何要它渲染的文字内容**',
  '（图片模型会写出错字与伪文字，全部中文文案由确定性渲染器排版）。',
  '',
  '只输出 JSON：{"movement":"","space":"","color":"","scale":"","composition":"","hierarchy":"","craft":"","palette":["#RRGGBB"],"mood":"","visualPrompt":"","note":""}',
  'palette 给 3–5 个十六进制色值（含一个可作强调色的暖色或金属色）。全部字段用中文，克制、具体、不说空话。',
].join('\n');

const PhilosophySchema = z.object({
  movement: z.string().catch('').default(''),
  space: z.string().catch('').default(''),
  color: z.string().catch('').default(''),
  scale: z.string().catch('').default(''),
  composition: z.string().catch('').default(''),
  hierarchy: z.string().catch('').default(''),
  craft: z.string().catch('').default(''),
  palette: z.array(z.string()).catch([]).default([]),
  mood: z.string().catch('').default(''),
  visualPrompt: z.string().catch('').default(''),
  note: z.string().catch('').default(''),
});
export type VisualPhilosophy = z.infer<typeof PhilosophySchema> & {
  /** 色板（已归一为合法 hex，至少 3 个）。 */
  palette: string[];
  /** 生成来源：llm=模型产出；fallback=确定性回退（无 provider / 校验失败 / 审核未过）。 */
  source: 'llm' | 'fallback';
};

/* ───────────────── 确定性回退（无 provider 或失败时用；绝不阻塞任务） ───────────────── */

// 按 scene 给一套成立的美学立场 + 色板。色板取自小程序设计体系（暖纸底 / 深绿 / 金），
// 保证回退产物与产品调性一致，而不是一版「明显是兜底」的灰模板。
const FALLBACK_BY_SCENE: Record<PosterScene, { movement: string; mood: string; palette: string[] }> = {
  personal_brand: { movement: '纸墨秩序', mood: '沉稳可信、有分量', palette: ['#16241E', '#1E5A43', '#9B7C3F', '#F4F2EC'] },
  event: { movement: '留白宣言', mood: '明确、有召集力', palette: ['#1A1D22', '#9C4A38', '#C9A227', '#F7F5EF'] },
  service: { movement: '几何静默', mood: '克制、专业、不喧哗', palette: ['#12171C', '#2B4A5E', '#B08A4A', '#F5F4F0'] },
  product: { movement: '实物光影', mood: '清晰、有质感、可触', palette: ['#181A1C', '#3A4A3C', '#C6A15B', '#FAF8F3'] },
};

const THEME_HINT_COLORS: [RegExp, string[]][] = [
  [/金|奢|贵|尊/, ['#1A1712', '#3E2F1C', '#C9A227', '#F8F4E9']],
  [/绿|自然|健康|生态/, ['#12241C', '#1E5A43', '#9B7C3F', '#F2F5F0']],
  [/蓝|科技|理性|数据/, ['#0F1720', '#1F3D5C', '#5B8FB9', '#F3F6F8']],
  [/红|热|活力|燃/, ['#1B1211', '#8C2F22', '#D9A15B', '#FBF4EF']],
  [/黑|极简|冷|高级/, ['#101113', '#2A2C30', '#B9B4A8', '#F6F5F2']],
];

function fallbackPalette(scene: PosterScene, kit?: BrandKitView | null): string[] {
  const hint = `${kit?.theme?.colorHint ?? ''} ${(kit?.theme?.keywords ?? []).join(' ')}`;
  for (const [re, palette] of THEME_HINT_COLORS) if (re.test(hint)) return palette;
  return FALLBACK_BY_SCENE[scene].palette;
}

/** 确定性回退哲学：同 scene + 同 BrandKit 恒定产出同一份（可复现、可测）。 */
export function fallbackPhilosophy(brief: NormalizedPosterBrief, kit?: BrandKitView | null): VisualPhilosophy {
  const base = FALLBACK_BY_SCENE[brief.scene];
  const tone = kit?.persona?.tone?.trim();
  return {
    movement: base.movement,
    space: '大面积虚空承担呼吸，实体沿一条主轴收拢；不靠堆元素撑满画面。',
    color: '有限色板：一个深色承重、一个中间色铺陈、一个金属色只用于点睛，材质取纸感与哑光。',
    scale: '主标题与辅助信息差出一个量级，不是差两号字；间隔成组，形成节奏而非平铺。',
    composition: '轻微失衡制造张力，视线自主标题落到 CTA，再收到二维码。',
    hierarchy: '第一眼主标题，第二眼卖点与 CTA，第三眼才发现落款与质感细节。',
    craft: '边距一致、基线对齐、字距成组、收口干净——每一处对齐都是选择，不允许一眼像自动生成。',
    palette: fallbackPalette(brief.scene, kit),
    mood: tone ? `${base.mood}（沿用品牌语气：${tone}）` : base.mood,
    visualPrompt: '',
    note: '',
    source: 'fallback',
  };
}

/* ───────────────── 生成 ───────────────── */

const HEX = /^#[0-9a-fA-F]{6}$/;

function normalizePalette(raw: string[], fallback: string[]): string[] {
  const ok = raw.map((c) => (c ?? '').trim()).filter((c) => HEX.test(c));
  // 少于 3 个色值撑不起「深/中/点睛」三层，直接用回退色板，避免半套色板出现随机默认色。
  return ok.length >= 3 ? ok.slice(0, 5) : fallback;
}

function briefDigest(brief: NormalizedPosterBrief, kit?: BrandKitView | null): string {
  const lines = [
    `场景：${brief.scene}`,
    `商业目标：${brief.goal}`,
    `目标客群：${brief.audience}`,
    `主标题：${brief.headline}`,
    brief.subheadline ? `副标题：${brief.subheadline}` : '',
    brief.proofPoints.length ? `卖点：${brief.proofPoints.join('；')}` : '',
    `行动号召：${brief.cta}`,
    brief.visualDirection ? `视觉方向：${brief.visualDirection}` : '',
    brief.negativePrompt ? `排除项：${brief.negativePrompt}` : '',
    `版式：${brief.templateKey}（3:4 竖版）`,
    brief.portraitAssetId ? '已提供人物照片（渲染器会把它放进主视觉区）' : '无人物照片',
  ];
  if (kit) {
    lines.push(
      `品牌语气：${kit.persona?.tone ?? ''}`,
      `品牌视觉关键词：${(kit.theme?.keywords ?? []).join('、')}`,
      `品牌主色建议：${kit.theme?.colorHint ?? ''}`,
      (kit.voice?.taboos ?? []).length ? `品牌禁忌：${(kit.voice!.taboos).join('、')}` : '',
    );
  }
  return lines.filter(Boolean).join('\n');
}

/** 模板对哲学的额外偏好（让同一份 brief 在三套模板下的哲学不至于雷同）。 */
const TEMPLATE_HINT: Record<TemplateKey, string> = {
  person_hero: '这一版以人物为主视觉：哲学要交代人物如何占据画面、光如何塑造可信度，以及文字在人物之外的呼吸空间。',
  editorial: '这一版是编辑杂志式大留白：哲学要交代虚空的结构性作用与排印的克制音量。',
  business_launch: '这一版是商业发布：哲学要交代信息如何被快速读取，同时不牺牲质感与工艺。',
};

/**
 * 生成视觉哲学。**永不抛错**：无 provider / 模型不合规 / 审核未过一律回退确定性哲学，
 * 让任务继续走排版（哲学是中间产物，不是交付件；用户要的是那张图）。
 */
export async function generatePhilosophy(opts: {
  brief: NormalizedPosterBrief;
  brandKit?: BrandKitView | null;
  tenantId?: string | null;
  userId?: string | null;
}): Promise<VisualPhilosophy> {
  const { brief, brandKit } = opts;
  const fb = fallbackPhilosophy(brief, brandKit);
  let ai: z.infer<typeof PhilosophySchema> | null = null;
  try {
    ai = await structured(PhilosophySchema, {
      system: `${PHILOSOPHY_SYS}\n\n【本次版式提示】${TEMPLATE_HINT[brief.templateKey]}`,
      user: briefDigest(brief, brandKit),
      maxChars: 1800,
    });
  } catch (err) {
    console.warn('[creative] 视觉哲学生成失败，回退确定性哲学：', (err as Error).message);
  }
  // 六维度只要缺任意一维就整份回退：半份哲学喂给下游会让画面比确定性回退更糟。
  const complete = !!ai && !!ai.movement && !!ai.space && !!ai.color && !!ai.scale
    && !!ai.composition && !!ai.hierarchy && !!ai.craft;
  if (!complete) return fb;

  const out: VisualPhilosophy = {
    ...ai!,
    palette: normalizePalette(ai!.palette, fb.palette),
    source: 'llm',
  };

  // 输出侧审核（fail-closed）：模型产出的哲学文本要过审才用；不过审不失败，静默回退。
  const pass = await moderate('output', philosophyText(out), {
    tenantId: opts.tenantId ?? null,
    userId: opts.userId ?? null,
  });
  if (!pass) {
    console.warn('[creative] 视觉哲学未过审核，回退确定性哲学');
    return fb;
  }
  return out;
}

/** 哲学正文（落 CreativeJob.promptSnapshot 可追溯；也是送审文本）。 */
export function philosophyText(p: VisualPhilosophy): string {
  return [
    `【${p.movement}】`,
    `空间与形：${p.space}`,
    `色彩与材质：${p.color}`,
    `尺度与节奏：${p.scale}`,
    `构图与平衡：${p.composition}`,
    `视觉层级：${p.hierarchy}`,
    `工艺感：${p.craft}`,
    `色板：${p.palette.join(' ')}`,
    p.mood ? `气质：${p.mood}` : '',
    p.visualPrompt ? `主视觉提示词：${p.visualPrompt}` : '',
    p.note ? `备注：${p.note}` : '',
  ].filter(Boolean).join('\n');
}
