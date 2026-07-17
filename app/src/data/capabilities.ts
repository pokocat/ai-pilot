// 能力直达（生态位地基）：军令行「去办 · {花名}」与军情·麾下章共用的创作能力映射。
// 与服务端同源常量对齐（server 侧 extractOrders 按 keywords 给军令打 capabilityKey 标）。
// external 为预留外跳配置位（打通外部生态产品后填入小程序 appId / 网页 url），本期全部 null，
// 命中即跳对应创作军师线程并带承接开场语。

export interface CapabilityExternal {
  type: 'miniprogram' | 'web';
  appId?: string;
  path?: string;
  url?: string;
}

export interface Capability {
  key: 'ip' | 'promo' | 'poster' | 'shortvideo' | 'copy';
  label: string;          // 能力名（麾下章副标）
  agentKey: string;       // 对应创作军师（同 key）
  keywords: string[];     // 军令文本命中词（服务端打标同源）
  prompt: string;         // 承接开场语（军师语声）
  external: CapabilityExternal | null; // 外跳配置位：本期 null，走站内军师线程
}

export const CAPABILITIES: Capability[] = [
  {
    key: 'ip',
    label: '企业 IP 打造',
    agentKey: 'ip',
    keywords: ['IP', '人设', '定位', '账号', '选题'],
    prompt: '这道军令交给你办：围绕它拆出定位、选题与发布任务，可直接执行。',
    external: null,
  },
  {
    key: 'promo',
    label: 'AI 宣传片',
    agentKey: 'promo',
    keywords: ['宣传片', '短片', '视频拍摄', '影片'],
    prompt: '这道军令交给你办：给我一份宣传片脚本与分镜，拍法一并说清。',
    external: null,
  },
  {
    key: 'poster',
    label: 'AI 海报设计',
    agentKey: 'poster',
    keywords: ['海报', '设计图', '主视觉', '物料'],
    prompt: '这道军令交给你办：出一版海报方案——主文案、构图与用色，一次讲透。',
    external: null,
  },
  {
    key: 'shortvideo',
    label: '短视频策划',
    agentKey: 'shortvideo',
    keywords: ['短视频', '抖音', '视频号', '快手', '脚本'],
    prompt: '这道军令交给你办：拆成可直接开拍的短视频选题与脚本。',
    external: null,
  },
  {
    key: 'copy',
    label: '商业文案',
    agentKey: 'copy',
    keywords: ['文案', '朋友圈', '推文', '话术', '软文'],
    prompt: '这道军令交给你办：把它写成可直接发出的文案，多备两版口吻。',
    external: null,
  },
];

export function capabilityFor(key?: string | null): Capability | undefined {
  if (!key) return undefined;
  return CAPABILITIES.find((c) => c.key === key);
}
