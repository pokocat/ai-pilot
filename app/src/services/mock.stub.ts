// 生产构建替身：config/index.ts 在 TARO_APP_MODE=server 下用 NormalModuleReplacementPlugin
// 把 './mock' 换成本文件，避免 874 行 mock 数据被打进生产包（IS_MOCK 恒 false，运行时永不触达）。
// 留 Proxy 兜底：一旦生产误调 mock.*，立即抛错暴露 bug，而不是静默。
export const mock: any = new Proxy(
  {},
  {
    get() {
      throw new Error('[prod] mock provider is stubbed out — IS_MOCK 应为 false，不应调用 mock.*');
    },
  },
);
