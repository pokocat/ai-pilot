import 'dotenv/config';

// 占位/假 key 识别：fake 一个 token 时，不浪费网络往返，直接走 mock 兜底。
export function isRealKey(k: string): boolean {
  return !!k && !/fake|replace|your[-_]?key|xxxx|0{6,}|^sk-\.{3,}$/i.test(k.trim());
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  aiProvider: (process.env.AI_PROVIDER ?? 'mock') as 'mock' | 'claude' | 'openai',

  // Claude（Anthropic）
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  claudeModel: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',

  // OpenAI 通用协议（兼容 DeepSeek / Moonshot / 通义千问兼容模式 等）
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  openaiTimeoutMs: Number(process.env.OPENAI_TIMEOUT_MS ?? 20000),

  moderationEnabled: (process.env.MODERATION_ENABLED ?? 'true') === 'true',
};
