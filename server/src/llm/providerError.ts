import type { LlmStreamDiagnostic } from '../../../shared/contracts';
import type { Usage } from './schema.js';

/** 内部错误元数据跨 provider / gateway / Worker 传递，不进入面向用户的错误文案。 */
export type ProviderFailure = Error & {
  code?: string;
  generationUsage?: Usage;
  streamDiagnostics?: LlmStreamDiagnostic[];
};

export function providerFailure(error: unknown, usage?: Usage, diagnostics?: LlmStreamDiagnostic[]): ProviderFailure {
  const failure = error instanceof Error ? error : new Error('Provider stream failed');
  return Object.assign(failure, {
    ...(usage ? { generationUsage: { ...usage } } : {}),
    ...(diagnostics ? { streamDiagnostics: diagnostics } : {}),
  });
}
