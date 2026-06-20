// 内容审核：可插拔 provider。默认 keyword（演示用关键词，零依赖）；
// 配 MODERATION_PROVIDER=http + MODERATION_API_URL 时调外部合规审核服务（脚手架，按你的服务商对接）。
//
// 统一出口 moderate()：落 moderation_log（verdict + 命中详情）并返回是否放行。
// 审核服务不可达时按 MODERATION_FAIL_OPEN 决定放行/拦截（默认放行，避免审核抖动阻断业务；
// 强合规场景置 MODERATION_FAIL_OPEN=false 改为拦截）。

import { env } from '../env.js';
import { prisma } from '../db.js';

// 演示用关键词表（生产用合规审核服务替代）。
const BLOCK_WORDS = ['暴力', '违法集资', '赌博', '毒品'];

export type ModerationVerdict = { pass: boolean; provider: string; detail?: Record<string, unknown> };

function moderationProvider(): 'keyword' | 'http' {
  return (process.env.MODERATION_PROVIDER ?? 'keyword') === 'http' ? 'http' : 'keyword';
}
function failOpen(): boolean {
  return (process.env.MODERATION_FAIL_OPEN ?? 'true') === 'true';
}

function keywordCheck(text: string): ModerationVerdict {
  const hit = BLOCK_WORDS.find((w) => text.includes(w));
  return { pass: !hit, provider: 'keyword', detail: hit ? { word: hit } : undefined };
}

// 外部合规审核服务（脚手架）：POST { text } → 期望 { pass: boolean, label?, score? }。
// 不同服务商字段不一，这里给出通用约定，接入时按需改 body/响应解析。
async function httpCheck(text: string): Promise<ModerationVerdict> {
  const url = (process.env.MODERATION_API_URL ?? '').trim();
  const key = (process.env.MODERATION_API_KEY ?? '').trim();
  if (!url) return keywordCheck(text); // 未配地址 → 退回关键词
  const timeoutMs = Number(process.env.MODERATION_TIMEOUT_MS ?? 3000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`审核服务 HTTP ${res.status}`);
    const data = (await res.json()) as { pass?: boolean; block?: boolean; label?: string; score?: number };
    // 兼容两种约定：pass=true 放行 / block=true 拦截。
    const pass = typeof data.pass === 'boolean' ? data.pass : !data.block;
    return { pass, provider: 'http', detail: { label: data.label, score: data.score } };
  } catch (err) {
    console.error('[moderation] http provider 失败：', (err as Error).message);
    // 审核服务抖动：按 fail-open 策略决定，并记下来源便于排查。
    return { pass: failOpen(), provider: 'http', detail: { error: (err as Error).message, failOpen: failOpen() } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 审核一段文本。关闭审核（MODERATION_ENABLED=false）时直接放行。
 * 落 moderation_log 后返回是否放行。
 */
export async function moderate(refType: 'input' | 'output', text: string): Promise<boolean> {
  if (!env.moderationEnabled) return true;
  const verdict = moderationProvider() === 'http' ? await httpCheck(text) : keywordCheck(text);
  await prisma.moderationLog
    .create({
      data: {
        refType,
        verdict: verdict.pass ? 'pass' : 'block',
        detailJson: { provider: verdict.provider, ...(verdict.detail ?? {}) },
      },
    })
    .catch(() => {});
  return verdict.pass;
}
