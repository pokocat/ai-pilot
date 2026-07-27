import type { AiProvider } from './api';

export interface ModelGatewayField {
  visible: boolean;
  label: string;
  placeholder: string;
  note?: string;
}

export function modelGatewayField(provider: AiProvider): ModelGatewayField {
  if (provider === 'mock') {
    return { visible: false, label: '', placeholder: '' };
  }
  if (provider === 'claude') {
    return {
      visible: true,
      label: 'Anthropic 网关 baseUrl（官方直连可留空）',
      placeholder: '如 https://api.qnaigc.com/bypass/anthropic',
      note: 'Claude 使用 Anthropic 原生 /v1/messages 协议；若厂商只提供 /v1/chat/completions，请把 provider 选为 openai。',
    };
  }
  return {
    visible: true,
    label: 'OpenAI 兼容网关 baseUrl（通常带 /v1）',
    placeholder: 'https://apihub.agnes-ai.com/v1',
    note: '适用于 OpenAI 兼容接口，包括使用 Claude 模型但请求路径为 /v1/chat/completions 的网关。',
  };
}

/** Anthropic 原生或 OpenAI 兼容 Claude 模型都可显示 Thinking 配置。 */
export function modelSupportsThinking(provider: AiProvider, model: string): boolean {
  return provider === 'claude' || /claude/i.test(model);
}
