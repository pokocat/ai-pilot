// WO-13 品牌资产包：从战略档案 + 企业档案生成「IP 人设 / 话术库 / 视觉调性」，作为数字人/短剧产品的预填输入。
// 生成走统一 structured()（Zod 三段强约束）；无 provider → 确定性模板。生成门槛：journey 已进 executing（有方案才有定位）。
import { z } from 'zod';
import { prisma } from '../db.js';
import { now } from './clock.js';
import { structured } from '../llm/gateway.js';
import { loadStrategicProfile } from './strategicProfile.js';
import type { BrandKitView } from '../../../shared/contracts';

export class BrandKitLockedError extends Error {
  statusCode = 403; code = 'BRANDKIT_LOCKED';
  constructor() { super('先和军师聊定一份方案并认可（进入执行），再生成品牌资产包'); }
}

const StrArr = z.array(z.string().trim().min(1)).catch([]).default([]);
const BrandKitSchema = z.object({
  persona: z.object({ name: z.string().catch('').default(''), tagline: z.string().catch('').default(''), tone: z.string().catch('').default(''), story: z.string().catch('').default(''), doNots: StrArr }),
  voice: z.object({ hooks: StrArr, openers: StrArr, ctas: StrArr, taboos: StrArr }),
  theme: z.object({ keywords: StrArr, colorHint: z.string().catch('').default(''), styleRefs: StrArr }),
});
type BrandKitData = z.infer<typeof BrandKitSchema>;

const BRANDKIT_SYS =
  '你是「军师参谋部」的品牌参谋。基于老板的行业、战略定位、主要矛盾，产出一套可直接喂给数字人/短视频的「品牌资产包」，只输出 JSON：' +
  '{"persona":{"name":"IP 名/人设称呼","tagline":"一句话定位","tone":"语气风格","story":"来历故事一两句","doNots":["人设禁忌"]},' +
  '"voice":{"hooks":["开头钩子"],"openers":["开场白"],"ctas":["行动号召"],"taboos":["话术禁忌"]},' +
  '"theme":{"keywords":["视觉关键词"],"colorHint":"主色调建议","styleRefs":["风格参考"]}}。' +
  '要具体、能直接用，不说空话；不用八字/命理/玄学措辞。';

function mockBrandKit(industry: string, contradiction: string): BrandKitData {
  return {
    persona: { name: '老张', tagline: `${industry}里最懂一线的操盘手`, tone: '实在、有分寸、不画饼', story: `从一线做起，靠${contradiction || '复购'}把生意做扎实。`, doNots: ['不吹牛', '不承诺做不到的效果'] },
    voice: { hooks: ['同行不会告诉你的一件事', '我踩过的那个坑'], openers: ['先说结论', '今天只讲一件事'], ctas: ['想聊聊你的情况就扣 1', '私信「诊断」两个字'], taboos: ['低俗', '攻击同行'] },
    theme: { keywords: ['务实', '专业', '接地气'], colorHint: '深绿 + 暖金', styleRefs: ['纪实口播', '干货白板'] },
  };
}

async function stageOf(userId: string): Promise<string> {
  const j = await prisma.userJourney.findUnique({ where: { userId }, select: { stage: true } });
  return j?.stage ?? 'new';
}

function toView(row: { personaJson: unknown; voiceJson: unknown; themeJson: unknown; version: number; approvedAt: Date | null; generatedAt: Date }): BrandKitView {
  return {
    persona: row.personaJson as BrandKitView['persona'],
    voice: row.voiceJson as BrandKitView['voice'],
    theme: row.themeJson as BrandKitView['theme'],
    version: row.version,
    approved: !!row.approvedAt,
    generatedAt: row.generatedAt.toISOString(),
  };
}

/**
 * 生成（或重生成 version+1）品牌资产包。门槛：journey ∈ {executing, reviewing}，否则 403。
 * 计费/限流在 routes/brandKit.ts；本函数回传 billable（真实 provider 出结果=true，走 mock 模板=false），
 * 供路由据此结算 token 额度（对齐 quickscan 口径：mock 兜底不实扣）。
 */
export async function generateBrandKit(userId: string, tenantId: string): Promise<{ view: BrandKitView; billable: boolean }> {
  const stage = await stageOf(userId);
  if (stage !== 'executing' && stage !== 'reviewing') throw new BrandKitLockedError();

  const sp = await loadStrategicProfile(userId);
  const profile = await prisma.profile.findFirst({ where: { tenantId }, orderBy: { updatedAt: 'desc' } });
  const industry = profile?.industry || '你的行业';
  const input = `行业：${industry}\n战略定位：${sp?.positioning ?? ''}\n主要矛盾：${sp?.mainContradiction ?? ''}\n主攻赛道：${sp?.track ?? ''}\n老板故事：${sp?.narrative ?? ''}`;
  const ai = await structured(BrandKitSchema, { system: BRANDKIT_SYS, user: input, maxChars: 2000 });
  const data = ai ?? mockBrandKit(industry, sp?.mainContradiction ?? '');

  const existing = await prisma.brandKit.findUnique({ where: { userId }, select: { version: true } });
  const version = (existing?.version ?? 0) + 1;
  const row = await prisma.brandKit.upsert({
    where: { userId },
    update: { personaJson: data.persona, voiceJson: data.voice, themeJson: data.theme, version, generatedAt: now(), approvedAt: null },
    create: { userId, tenantId, personaJson: data.persona, voiceJson: data.voice, themeJson: data.theme, version },
  });
  return { view: toView(row), billable: !!ai };
}

export async function getBrandKit(userId: string): Promise<BrandKitView | null> {
  const row = await prisma.brandKit.findUnique({ where: { userId } });
  return row ? toView(row) : null;
}

/** 用户确认无误 → 打 approvedAt（生态产品只读取 approved 的资产包）。 */
export async function approveBrandKit(userId: string): Promise<boolean> {
  const r = await prisma.brandKit.updateMany({ where: { userId }, data: { approvedAt: now() } });
  return r.count > 0;
}
