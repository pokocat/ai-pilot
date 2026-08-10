const { apiErrorPresentation, errorCode } = require('./api-error');

function errorMessage(error, fallback) {
  if (typeof error === 'string') return error.trim() || fallback;
  return String((error && error.message) || fallback || '').trim();
}

function isQuotaMessage(message) {
  return /(?:本月|当前).*(?:token|方案)?(?:额度|用量).*(?:用尽|耗尽|不足)/i.test(String(message || ''));
}

/**
 * 对话失败卡的唯一语义入口：只有“原样重试有机会成功”的错误才给重新回答。
 * 额度/方案门禁需要先改变账户状态，继续重试只会重复撞同一个 402/403。
 */
function chatErrorPresentation(error, fallback) {
  const code = errorCode(error);
  const message = errorMessage(error, fallback || '军师暂时没有接上，请重试');
  if (code === 'INSUFFICIENT_QUOTA' || isQuotaMessage(message)) {
    return {
      title: '本月方案用量已用完',
      note: '可前往「方案与权益」查看恢复时间或更换方案。原问题和引用已保留。',
      action: 'plans',
      retryable: false,
    };
  }
  if (code === 'PLAN_REQUIRED') {
    return {
      title: '尚未开通方案',
      note: '开通方案后即可继续对话，原问题和引用已保留。',
      action: 'plans',
      retryable: false,
    };
  }
  if (code === 'PLAN_EXPIRED') {
    return {
      title: '当前方案已到期',
      note: '续费后即可继续对话，原问题和引用已保留。',
      action: 'plans',
      retryable: false,
    };
  }
  if (code === 'INSUFFICIENT_CREDITS') {
    return {
      title: '当前算力不足',
      note: '可前往「算力明细」查看。原问题和引用已保留。',
      action: 'credits',
      retryable: false,
    };
  }
  const view = apiErrorPresentation(error, fallback || '军师暂时没有接上，请重试');
  if (view.kind === 'moderation') {
    return {
      title: view.message || '这条内容暂时无法处理',
      note: '请调整内容后重新发送。',
      action: '',
      retryable: false,
    };
  }
  if (!view.retryable) {
    const note = view.kind === 'rate_limited' ? '请稍后再发，原问题和引用已保留。'
      : view.kind === 'conflict' || view.kind === 'not_found' ? '请返回刷新后重新发起，原问题和引用已保留。'
        : '请按提示处理后重新发送，原问题和引用已保留。';
    return {
      title: view.message,
      note,
      action: view.action === 'plans' || view.action === 'credits' ? view.action : '',
      retryable: false,
    };
  }
  return {
    title: view.message || message,
    note: '原问题和引用都已保留，不用重新输入。',
    action: '',
    retryable: view.retryable,
  };
}

module.exports = { chatErrorPresentation, errorCode, isQuotaMessage };
