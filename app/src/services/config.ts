// 运行模式：mock（本地开发，纯前端数据源，不连后端）| server（真实连后端）。
// 由构建期环境变量 TARO_APP_MODE 决定；默认 mock，便于本地零依赖开发。
//   本地 mock：    npm run dev:weapp                （默认）
//   连真实后端：   TARO_APP_MODE=server TARO_APP_API=https://api.xxx/api npm run build:weapp
export type AppMode = 'mock' | 'server';

export const APP_MODE: AppMode = (process.env.TARO_APP_MODE as AppMode) || 'mock';

export const IS_MOCK = APP_MODE === 'mock';

// server 模式后端基址（微信小程序需在后台配置合法域名后替换为线上 https 域名）。
export const BASE_URL =
  process.env.TARO_APP_API || 'http://localhost:4000/api';

// P1-B3：聊天流式渲染开关（默认开）。H5 走 fetch ReadableStream；
// 微信小程序走 wx.request enableChunked + RequestTask.onChunkReceived。
// 如需临时回退非流式，构建时置 TARO_APP_STREAM=0。
export const STREAM_CHAT = process.env.TARO_APP_STREAM !== '0';
