export const CHAT_MAX_TOKENS = 8000;

const TRUNCATED_REASONS = new Set(['length', 'max_tokens']);

export function assertChatOutputComplete(
  provider: 'Claude' | 'OpenAI',
  finishReason: string | null | undefined,
  outputTokens: number,
): void {
  if (!finishReason || !TRUNCATED_REASONS.has(finishReason)) return;
  throw Object.assign(
    new Error(`${provider} 对话输出达到 ${outputTokens || CHAT_MAX_TOKENS} token 上限，回复未完整结束`),
    {
      code: 'AI_OUTPUT_TRUNCATED',
      statusCode: 503,
      finishReason,
      outputTokens,
    },
  );
}
