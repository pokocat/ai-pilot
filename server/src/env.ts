import 'dotenv/config';

export const env = {
  port: Number(process.env.PORT ?? 4000),
  aiProvider: (process.env.AI_PROVIDER ?? 'mock') as 'mock' | 'claude',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  claudeModel: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
  moderationEnabled: (process.env.MODERATION_ENABLED ?? 'true') === 'true',
};
