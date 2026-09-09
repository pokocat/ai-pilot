// 一句话提取主体 / 目标 / 受众 / 称呼（契约 ai-quickreel `docs/WORKPLAN_2026-09-05.md` §1.4）。
//
// 四个字段都是字符串，**拿不准就给空串，绝不编造** —— 端上把它当事实卡展示且可改，
// 编出来的「主体」会被用户当成系统已经知道的事实，比空着有害得多。
import { z } from 'zod';
import type { ClipIntakeExtract } from '../../../../shared/contracts';
import { structuredMetered } from '../../llm/gateway.js';

/** 一句话上限（与端上输入框一致）。 */
export const INTAKE_MAX_CHARS = 500;

const SYSTEM = `你从实体店老板的一句话里，抽取四件事，用于后面写口播稿。
subject：这条视频要讲的主体（店名、手艺、产品或这门生意本身）。
goal：老板希望观众看完做什么或记住什么。
audience：他想让谁看到。
salutation：老板希望别人怎么称呼他（如“张姐”“老李”“王师傅”）。
规则：
1. **只抽原话里有的信息**。没有说到、或需要靠猜才能填的字段，一律给空字符串 ""。
2. 不要替老板扩写、美化或补充营销话术；尽量用他自己的说法，最多做最小的通顺整理。
3. 每个字段不超过 30 个字。
只输出 JSON：{"subject":"","goal":"","audience":"","salutation":""}`;

const Schema = z.object({
  subject: z.string().max(60).default(''),
  goal: z.string().max(60).default(''),
  audience: z.string().max(60).default(''),
  salutation: z.string().max(60).default(''),
});

const clean = (value: unknown) => String(value ?? '').trim().slice(0, 30);

/**
 * 抽取。模型不可用或产出不合法时抛错——不返回一张全空的卡片冒充「什么都没说」，
 * 那会让端上把「服务不可用」显示成「你这句话里没有信息」。
 */
export async function extractClipIntake(text: string, templateId?: string): Promise<ClipIntakeExtract> {
  const outcome = await structuredMetered(Schema, {
    system: SYSTEM,
    user: [templateId ? `模板：${templateId}` : '', `老板这句话：${text}`].filter(Boolean).join('\n'),
    maxChars: 4_000,
    maxTokens: 600,
    // 用户正盯着确认页等这张事实卡，不能落到 aux 小模型（见 gateway.ts allowAux 注释）。
    allowAux: false,
  });
  const data = outcome.data as ClipIntakeExtract | null;
  if (!data) {
    throw Object.assign(new Error('这次没能读懂这句话，请再说一次或换个说法'), {
      statusCode: 502, code: 'CLIP_INTAKE_AI_INVALID',
    });
  }
  return {
    subject: clean(data.subject),
    goal: clean(data.goal),
    audience: clean(data.audience),
    salutation: clean(data.salutation),
  };
}
