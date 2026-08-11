import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ClipProject, ClipScriptMessage, ClipSegment, ClipShot } from '../../../../shared/contracts';
import { structuredMetered } from '../../llm/gateway.js';

type AiDraft = { reply: string; applied: boolean; segments?: ClipSegment[] };

const SYSTEM = `你是“快出片”的短视频文案搭档，和实体店老板用自然中文一起把口播稿写出来。
你不是一次性改写按钮：信息不够时只追问一个最关键的问题；信息足够或用户明确要求改稿时，直接给可用初稿。
写稿要求：
1. 每一段是一个完整语义节拍，不要把每个标点或短句都拆成独立段；通常 6-10 段，每段约 15-70 个汉字。
2. role 只用 avatar 或 broll。需要人物直接建立信任时用 avatar，需要门头、手艺、产品、顾客、环境等实拍承接时用 broll。
3. hint 用一句很短的画面建议。不要生成结尾品牌尾卡，系统会自动保留。
4. 保留真实信息，不编造销量、年份、荣誉、顾客评价或经营数字。
5. 用户在继续对话时，要结合现有稿和前文修改，不要重新问已经回答过的问题。
6. 用户说“换成 / 改成某个行业、门店或产品”就是明确改稿指令：必须立刻重写整稿，删除旧行业、旧商品和旧动作，不得只整理段落后声称已经修改。
只输出 JSON：
信息不足：{"action":"question","reply":"一个具体问题","segments":[]}
可以成稿：{"action":"draft","reply":"简短说明这版怎么改的","segments":[{"text":"完整语义段","role":"avatar","hint":"正面口播"}]}`;

const SegmentSchema = z.object({
  text: z.string().min(1).max(180),
  role: z.enum(['avatar', 'broll']),
  hint: z.string().max(60).nullable().optional(),
});

const ScriptTurnSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('question'), reply: z.string().min(1).max(800), segments: z.array(SegmentSchema).max(0).default([]) }),
  z.object({ action: z.literal('draft'), reply: z.string().min(1).max(800), segments: z.array(SegmentSchema).min(2).max(12) }),
]);

const text = (value: unknown, max = 4000) => String(value ?? '').trim().slice(0, max);

function joinForPrompt(project: ClipProject, message: string) {
  const history = (project.scriptChat ?? []).slice(-10).map((item) => `${item.role === 'user' ? '老板' : '文案搭档'}：${item.content}`).join('\n');
  const script = project.segments.filter((item) => item.role !== 'tail').map((item) => `${item.no}. ${item.text}`).join('\n');
  return `模板：${project.templateName ?? project.title}\n变量：${JSON.stringify(project.variables ?? {})}\n当前口播稿：\n${script}\n最近对话：\n${history || '暂无'}\n老板这次说：${message}`;
}

function compactSegments(rows: ClipSegment[]): ClipSegment[] {
  const result: ClipSegment[] = [];
  for (const row of rows) {
    const value = text(row.text, 180);
    if (!value) continue;
    const role = row.role === 'avatar' ? 'avatar' : 'broll';
    const previous = result[result.length - 1];
    if (previous && previous.role === role && `${previous.text}${value}`.replace(/\s/g, '').length <= 70) {
      previous.text += value;
      if (!previous.hint && row.hint) previous.hint = text(row.hint, 60);
      continue;
    }
    result.push({ no: result.length + 1, text: value, role, hint: text(row.hint, 60) || null, actualDurationSec: 0 });
  }
  return result.slice(0, 10).map((row, index) => ({ ...row, no: index + 1 }));
}

function fallbackDraft(project: ClipProject, message: string): AiDraft {
  if (message.replace(/\s/g, '').length < 6 && !(project.scriptChat?.length)) {
    return { reply: '你最想让谁看完这条视频，又希望他看完以后做什么？', applied: false };
  }
  return {
    reply: '这次 AI 没有生成出可用新稿，原稿没有改动。请再发一次，我会接着当前内容修改。',
    applied: false,
  };
}

export function defaultClipShots(segments: ClipSegment[]): ClipShot[] {
  const result: ClipShot[] = [];
  for (let index = 0; index < segments.length;) {
    const first = segments[index];
    let endIndex = index;
    if (first.role === 'broll') {
      while (endIndex + 1 < segments.length && segments[endIndex + 1].role === 'broll' && endIndex - index + 1 < 3) endIndex += 1;
    }
    const last = segments[endIndex];
    result.push({
      id: `shot_${first.no}_${last.no}`,
      startNo: first.no,
      endNo: last.no,
      role: first.role,
      assetId: first.assetId ?? null,
      assetLabel: first.assetLabel ?? null,
      brollSource: first.brollSource ?? null,
      hint: first.hint ?? null,
    });
    index = endIndex + 1;
  }
  return result;
}

export function normalizeClipScriptAi(raw: Record<string, unknown> | null, project: ClipProject, message: string): AiDraft {
  if (!raw) return fallbackDraft(project, message);
  const reply = text(raw.reply, 800);
  const action = raw.action === 'draft' ? 'draft' : 'question';
  const source = Array.isArray(raw.segments) ? raw.segments : [];
  const segments = compactSegments(source.map((item) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return {
      no: 0,
      text: text(row.text, 180),
      role: row.role === 'avatar' ? 'avatar' : 'broll',
      hint: text(row.hint, 60) || null,
    } satisfies ClipSegment;
  }));
  if (action !== 'draft' || segments.length < 2) {
    return { reply: reply || '你最想让谁看完这条视频，又希望他看完以后做什么？', applied: false };
  }
  return { reply: reply || '我按你的要求整理了一版，可以继续告诉我哪里还不像你。', applied: true, segments };
}

export async function generateClipScriptTurn(project: ClipProject, message: string): Promise<{
  reply: string;
  applied: boolean;
  segments: ClipSegment[];
  shots: ClipShot[];
  scriptChat: ClipScriptMessage[];
}> {
  const outcome = await structuredMetered(ScriptTurnSchema, {
    system: SYSTEM,
    user: joinForPrompt(project, message),
    maxChars: 12_000,
    // 辅助模型默认 700 token 会把 6-10 段 JSON 拦腰截断；改稿必须给足完整稿预算。
    maxTokens: 2_400,
  });
  if (outcome.live && !outcome.data) {
    throw Object.assign(new Error('AI 改稿结果不完整，原稿没有改动，请再试一次'), {
      code: 'CLIP_SCRIPT_AI_INVALID', statusCode: 502,
    });
  }
  const draft = normalizeClipScriptAi(outcome.data as Record<string, unknown> | null, project, message);
  const tail = project.segments.filter((item) => item.role === 'tail').map((item) => ({ ...item }));
  const content = draft.applied && draft.segments?.length ? draft.segments : project.segments.filter((item) => item.role !== 'tail').map((item) => ({ ...item }));
  const segments = content.concat(tail).map((item, index) => ({ ...item, no: index + 1 }));
  const now = new Date().toISOString();
  const scriptChat = (project.scriptChat ?? []).concat([
    { id: `csm_${randomUUID().replaceAll('-', '').slice(0, 16)}`, role: 'user', content: message, at: now },
    { id: `csm_${randomUUID().replaceAll('-', '').slice(0, 16)}`, role: 'assistant', content: draft.reply, at: now, applied: draft.applied },
  ] as ClipScriptMessage[]).slice(-40);
  return {
    reply: draft.reply,
    applied: draft.applied,
    segments,
    shots: draft.applied ? defaultClipShots(segments) : (project.shots?.length ? project.shots : defaultClipShots(segments)),
    scriptChat,
  };
}
