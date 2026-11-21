export type StudioKind = 'image' | 'video';

const VIDEO = /视频|短片|短剧|成片|出片/;
const IMAGE = /图片|图像|海报|生图|出图|主视觉|商品图|插画|画一张|一张图/;
const ACTION = /(?:^|[，,。；;！!\s])(?:请你|请|帮我|给我|我想|我需要|麻烦|直接|现在|就|把|用|拿|根据|按照|按|请帮我)*[\s]*(?:生成|制作|创建|建|做成|做|保存|导入|送到|发到|出片|出图|生图|画|出(?:一条|一张|一段|个)|来一张)/;
const USE_THEN_MAKE = /^(?:请|帮我|就|直接|现在)*[\s]*(?:用|使用|把|将|拿|根据|按照|按|以)[^。！？\n]{0,70}(?:生成|制作|创建|做成?|转成|变成|保存|导入|送到|发到|出片|出图|生图|画|出(?:一条|一张|一段|个)|来一张)/;
const IMAGE_TO_VIDEO = /^(?:请你|请|帮我|给我|我想|我需要|麻烦|直接|现在|就|做个|做|来个|来|用|使用|生成|制作|\s)*图生视频(?=$|[，,。；;！!\s]|[:：])/;
const DIRECT_IMAGE_TO_MEDIA = /^(?:(?:请你|请|帮我|给我|就|直接|现在|\s))*(?:(?:这|那|第\s*[一二两三四五六七八九1-9]\s*)张(?:图片|图|照片)|图\s*[1-9])\s*(?:做成?|生成|制作|转成|变成)/;
const USE_VERSION_WITH_SPEC = /^(?:请|帮我|就)*用(?:这[一二两]?版|上一版|最新(?:一)?版|第\s*[一二两三四五六七八九十1-9]\s*版)[，,\s].*(?:竖屏|横屏|作.{0,8}参考|作为.{0,8}参考)/;
const WRITING = /(?:写|起草|撰写|润色|修改|改写|优化|分析|构思|策划|看|读|描述|解读|拟)[^，,。；;！？!?\n]{0,24}(?:脚本|剧本|文案|稿|提示词|计划|建议|方案|点子|图片|图像|参考图)/;
const WRITING_OBJECT = /(?:生成|制作|创建|建|做)[^，,。；;！？!?\n]{0,24}(?:脚本|剧本|文案|提示词|计划|建议|方案|策划|构思|草图说明)/;

function commandOf(text: string) { return text.split(/(?<!\d)[:：]|[:：](?!\d)|\n/, 1)[0].trim(); }

export function studioIntent(text: string): { kind: StudioKind | 'previous' } | null {
  const instruction = commandOf(text);
  if (!instruction || /快出片|爱速拍|数字人口播|只写|只看|仅写|仅看|暂不|不要.{0,5}(?:生成|制作|出片|出图)|(?:能不能|如何|怎么|可以吗)|[?？]$/.test(instruction)) return null;
  const clauses = instruction.split(/[，,。；;！!]/);
  if (clauses.some((part) => {
    const currentAction = part.replace(/(?:刚才|先前|已经)?(?:看过的?|读过的?|分析过的?|写好的?|写过的?)/g, '');
    return WRITING.test(currentAction) || WRITING_OBJECT.test(currentAction);
  })) return null;
  if (USE_VERSION_WITH_SPEC.test(instruction) && !VIDEO.test(instruction) && !IMAGE.test(instruction)) return { kind: 'previous' };
  if (IMAGE_TO_VIDEO.test(instruction)) return { kind: 'video' };
  if (!ACTION.test(instruction) && !USE_THEN_MAKE.test(instruction) && !DIRECT_IMAGE_TO_MEDIA.test(instruction)) return null;
  if (VIDEO.test(instruction) && IMAGE.test(instruction.replace(/参考图|参考图片|商品图(?=作|作为)/g, ''))) {
    const target = /(?:生成|制作|创建|做成?|转成|变成)\s*(?:一(?:条|个|段|张|组)|\d+秒)?[^，,。；;!?！？]{0,8}?(视频|短片|短剧|成片|图片|图像|海报|商品图)/.exec(instruction)?.[1];
    return target ? { kind: VIDEO.test(target) ? 'video' : 'image' } : null;
  }
  if (VIDEO.test(instruction)) return { kind: 'video' };
  if (IMAGE.test(instruction)) return { kind: 'image' };
  return null;
}

/** 总军师按对话交付用于制作的稿件，用户明确需要报告时仍遵循原交付形态。 */
export function studioScriptWritingIntent(text: string): boolean {
  const instruction = commandOf(text);
  return (VIDEO.test(instruction) || IMAGE.test(instruction)) && !/快出片|爱速拍|军令|方案卡|报告|纪要/.test(instruction)
    && /(?:生成|写|起草|润色|修改|改写|优化|拟)[^，,。！？!?\n]{0,36}(?:脚本|剧本|稿件|文案|提示词)/.test(instruction);
}

export function studioSpecifications(text: string, kind: StudioKind) {
  const instruction = commandOf(text);
  const ratio = instruction.match(/(?:^|[^\d])(9:16|16:9|1:1|3:4|4:3|2:3|3:2|21:9)(?!\d)/)?.[1]
    ?? (/竖屏/.test(instruction) ? '9:16' : /横屏/.test(instruction) ? '16:9' : undefined);
  const duration = Number(instruction.match(/(\d{1,3})\s*秒/)?.[1]) || undefined;
  const count = Number(instruction.match(/([1-4])\s*张(?:图|图片|海报)/)?.[1]) || undefined;
  return { ...(ratio ? { ratio } : {}), ...(kind === 'video' ? { duration } : { count }) };
}

const ORDINALS = '一二三四五六七八九';
export const STUDIO_SCRIPT_VERSION_HEADING = /^\s*(?:#{1,6}\s*)?(?:\*{1,2})?(?:第([一二两三四五六七八九1-9])版|版本\s*([一二两三四五六七八九1-9]))(?=[：:\s，、】）（)*]|$)/gm;
function ordinal(value: string) {
  return value === '两' ? 2 : /^[1-9]$/.test(value) ? Number(value) : ORDINALS.indexOf(value) + 1;
}

export function studioScriptVersion(text: string, version: number): string | undefined {
  const headings = [...text.matchAll(STUDIO_SCRIPT_VERSION_HEADING)];
  const index = headings.findIndex((heading) => ordinal(heading[1] ?? heading[2]) === version);
  return index < 0 ? undefined : text.slice(headings[index].index, headings[index + 1]?.index).trim();
}

export function studioScriptSelection(text: string): number | 'latest' | null {
  const selected = /(?:^|[，,。\s])(?:请|帮我|就|直接)*\s*(?:用|把|拿|按)第\s*([一二两三四五六七八九1-9])\s*版/.exec(text)?.[1];
  if (selected) return ordinal(selected);
  return /(?:用|把|拿|按)(?:这一?版|上一版|上面(?:那版|的?脚本)|最新(?:一)?版|刚才(?:那版|的?脚本)|你写的(?:那版|脚本))/.test(text) ? 'latest' : null;
}

export function studioReferenceSelection(text: string, available: number): number[] | 'clarify' {
  const instruction = commandOf(text);
  if (/(?:都|全部|所有)不(?:用|上传|进|传)|不用任何(?:参考|图片|素材)|不带(?:图|图片|参考图)/.test(instruction)) return [];
  const clauses = instruction.split(/[，,。；;！？!?]|但|另外|而且/);
  const styleOnly = /(?:只|仅)(?:是|作(?:为)?|做|用于)?(?:参考风格|风格参考)/;
  const excluded = /不要|不用|不上传|不传|不进|不入镜/;
  const isExcluded = (part: string) => styleOnly.test(part) || excluded.test(part);
  const indexes = (part: string) => Array.from(part.matchAll(/第\s*([一二两三四五六七八九1-9])\s*张|图\s*([1-9])/g),
    (match) => ordinal(match[1] ?? match[2]));
  if (clauses.some((part) => styleOnly.test(part) && !indexes(part).length)) return available > 1 ? 'clarify' : [];
  const blocked = new Set(clauses.filter(isExcluded).flatMap(indexes));
  const allowedParts = clauses.filter((part) => !isExcluded(part));
  const joined = allowedParts.join(' ');
  const all = /(?:全部|所有)(?:图片|图)?(?:都|一并)?(?:作(?:为)?|当).{0,8}参考|用(?:全部|所有)(?:图片|图).{0,12}(?:做|生成|制作)/;
  const group = /(?:用[^，,。]{0,6})?这([两二三四五六七八九2-9])张(?:图片|图)?(?:都|一并)?(?:(?:作(?:为)?|当).{0,8}参考|.{0,10}(?:做|生成|制作))/;
  const groupSize = group.exec(joined)?.[1];
  if (all.test(joined) || groupSize) {
    if (!available || (groupSize && ordinal(groupSize) !== available)) return 'clarify';
    if (clauses.some((part) => isExcluded(part) && !indexes(part).length)) return 'clarify';
    return Array.from({ length: available }, (_, index) => index + 1).filter((number) => !blocked.has(number));
  }
  const numbered = new Set<number>();
  let explicitNumber = false;
  for (const part of allowedParts) {
    const imageToVideoSelection = IMAGE_TO_VIDEO.test(instruction) && /^\s*(?:用|使用|选)\s*(?:第|图)/.test(part);
    if (!DIRECT_IMAGE_TO_MEDIA.test(part) && !imageToVideoSelection && !/(?:用|使用|把|将|拿|根据|按照|按|以)\s*(?:第\s*[一二两三四五六七八九1-9]\s*张|图\s*[1-9]).{0,24}(?:做|生成|制作|转成|变成)|(?:作(?:为)?|当)(?:.{0,8})参考|(?:作为|作|当).{0,8}素材|参考(?:第|图\s*[1-9])|(?:第\s*[一二两三四五六七八九1-9]\s*张|图\s*[1-9]).{0,10}(?:进视频|入镜)/.test(part)) continue;
    for (const number of indexes(part)) {
      explicitNumber = true;
      if (!blocked.has(number)) numbered.add(number);
    }
  }
  if (explicitNumber) return [...numbered];
  if (/(?:这张|附件|上传的|刚才的)(?:图片|图)?(?:作(?:为)?|当)(?:.{0,8})(?:参考|素材)|(?:用|使用|把|将|拿|根据|按照|按|以)\s*(?:这张|那张|刚上传的|刚才的|当前的)(?:图片|图|照片).{0,18}(?:做|生成|制作|转成|变成)/.test(joined)
    || allowedParts.some((part) => DIRECT_IMAGE_TO_MEDIA.test(part) || IMAGE_TO_VIDEO.test(part))) {
    return available === 1 && !blocked.has(1) ? [1] : 'clarify';
  }
  if (/(?:附件|上传|挑选|图片|图\s*[1-9]|第.{0,4}张).{0,12}(?:参考|素材)|(?:参考|使用)(?:附件|上传的图)/.test(joined)) return 'clarify';
  return [];
}

export const STUDIO_DRAFT_SKILL = 'studio_media_draft';

export function hasStudioDraftSkill(agentKey: string, config: unknown): boolean {
  const tools = (config as { tools?: unknown } | null)?.tools;
  return Array.isArray(tools) ? tools.includes(STUDIO_DRAFT_SKILL) : agentKey === 'general';
}
