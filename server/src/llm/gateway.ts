// LLM Gateway（《投产开发指导》§5.1）：统一封装模型调用——
// 路由（mock/claude）、内容审核、Token 计量、结果缓存、故障兜底/降级。

import { env, isRealKey } from '../env.js';
import { prisma } from '../db.js';
import { mockChat, mockDeliverable } from './providers/mock.js';
import type { Deliverable, ChatReply, GenContext } from './schema.js';

// 当前提供方是否已就绪（key 真实）。未就绪一律走 mock 兜底，保证可用。
function liveProvider(): 'claude' | 'openai' | null {
  if (env.aiProvider === 'claude' && isRealKey(env.anthropicApiKey)) return 'claude';
  if (env.aiProvider === 'openai' && isRealKey(env.openaiApiKey)) return 'openai';
  return null;
}

// —— 内容审核（演示用关键词；生产替换为合规审核服务） ——
const BLOCK_WORDS = ['暴力', '违法集资', '赌博', '毒品'];

async function moderate(refType: 'input' | 'output', text: string): Promise<boolean> {
  if (!env.moderationEnabled) return true;
  const hit = BLOCK_WORDS.find((w) => text.includes(w));
  const verdict = hit ? 'block' : 'pass';
  await prisma.moderationLog
    .create({ data: { refType, verdict, detailJson: hit ? { word: hit } : {} } })
    .catch(() => {});
  return verdict === 'pass';
}

// —— Token 计量（演示用估算；生产接真实 usage） ——
async function meter(ctx: GenContext, kind: string, approxTokens: number) {
  // 真实系统在此写入 credit_ledger 扣减 / 成本归集（按租户×智能体）。
  return approxTokens;
}

// —— 结果缓存（演示用内存缓存；生产用 Redis） ——
const cache = new Map<string, { v: unknown; at: number }>();
const TTL = 5 * 60 * 1000;
function cacheKey(kind: string, ctx: GenContext): string {
  return `${kind}:${env.aiProvider}:${ctx.agentKey}:${ctx.deliverableKey ?? ''}:${ctx.userMessage}:${ctx.profile?.pain ?? ''}`;
}

export async function generateDeliverable(ctx: GenContext): Promise<Deliverable> {
  if (!(await moderate('input', ctx.userMessage))) {
    throw Object.assign(new Error('输入未通过内容审核'), { code: 'MODERATION_BLOCK' });
  }
  const ck = cacheKey('deliverable', ctx);
  const cached = cache.get(ck);
  if (cached && Date.now() - cached.at < TTL) return cached.v as Deliverable;

  let result: Deliverable;
  try {
    const live = liveProvider();
    if (live === 'claude') {
      const { claudeDeliverable } = await import('./providers/claude.js');
      result = await claudeDeliverable(ctx);
    } else if (live === 'openai') {
      const { openaiDeliverable } = await import('./providers/openai.js');
      result = await openaiDeliverable(ctx);
    } else {
      result = mockDeliverable(ctx);
    }
  } catch (err) {
    // 故障兜底：降级到模板，保证可用
    console.error('[gateway] deliverable fallback to mock:', (err as Error).message);
    result = mockDeliverable(ctx);
  }

  const outText = result.sections.map((s) => `${s.h} ${s.b ?? ''} ${(s.list ?? []).join(' ')}`).join('\n');
  if (!(await moderate('output', outText))) {
    throw Object.assign(new Error('产出未通过内容审核'), { code: 'MODERATION_BLOCK' });
  }
  await meter(ctx, 'deliverable', outText.length);
  cache.set(ck, { v: result, at: Date.now() });
  return result;
}

export async function chatComplete(ctx: GenContext): Promise<ChatReply> {
  if (!(await moderate('input', ctx.userMessage))) {
    throw Object.assign(new Error('输入未通过内容审核'), { code: 'MODERATION_BLOCK' });
  }
  try {
    const live = liveProvider();
    if (live) {
      const r =
        live === 'claude'
          ? await (await import('./providers/claude.js')).claudeChat(ctx)
          : await (await import('./providers/openai.js')).openaiChat(ctx);
      await moderate('output', r.text);
      await meter(ctx, 'chat', r.text.length);
      return r;
    }
  } catch (err) {
    console.error('[gateway] chat fallback to mock:', (err as Error).message);
  }
  return mockChat(ctx);
}

export function providerInfo() {
  const live = liveProvider();
  const model =
    env.aiProvider === 'claude' ? env.claudeModel : env.aiProvider === 'openai' ? env.openaiModel : 'template';
  return {
    provider: env.aiProvider,
    model: live ? model : 'template', // 未就绪时实际产出走 mock
    ready: !!live,
    // 向后兼容旧字段
    claudeReady: live === 'claude',
  };
}
