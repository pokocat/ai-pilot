import { apiErrorCode, apiErrorPresentation } from './apiError';

export type ChatErrorAction = 'plans' | 'credits';

export interface ChatErrorPresentation {
  message: string;
  retryable: boolean;
  action?: ChatErrorAction;
}

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string') return error.trim() || fallback;
  return String((error as any)?.message || fallback).trim();
}

function isQuotaMessage(message: string): boolean {
  return /(?:本月|当前).*(?:token|方案)?(?:额度|用量).*(?:用尽|耗尽|不足)/i.test(message);
}

/** 只有原样重试可能恢复的失败才提供重试；额度/方案门禁改为给可执行入口。 */
export function chatErrorPresentation(error: unknown, fallback = '军师暂时没有接上，请重试'): ChatErrorPresentation {
  const code = apiErrorCode(error);
  const message = errorMessage(error, fallback);
  if (code === 'INSUFFICIENT_QUOTA' || isQuotaMessage(message)) {
    return {
      message: '本月方案用量已用完。可前往「方案与权益」查看恢复时间或更换方案。',
      retryable: false,
      action: 'plans',
    };
  }
  if (code === 'PLAN_REQUIRED') {
    return { message: '尚未开通方案，开通后即可继续对话。', retryable: false, action: 'plans' };
  }
  if (code === 'PLAN_EXPIRED') {
    return { message: '当前方案已到期，续费后即可继续对话。', retryable: false, action: 'plans' };
  }
  if (code === 'INSUFFICIENT_CREDITS') {
    return { message: '当前算力不足，可前往「算力明细」查看。', retryable: false, action: 'credits' };
  }
  const view = apiErrorPresentation(error, fallback);
  if (view.kind === 'moderation' || /审核/.test(message)) return { message: view.message || message, retryable: false };
  const action = view.action === 'plans' || view.action === 'credits' ? view.action : undefined;
  return {
    message: view.message || message,
    retryable: view.retryable,
    ...(action ? { action } : {}),
  };
}
