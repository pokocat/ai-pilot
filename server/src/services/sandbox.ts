// 可测性沙箱总开关 + 生产硬护栏（D9：双控门禁、生产关死）。
//
// 沙箱三件套（mock 下单 / 仿真回调 /pay/sandbox/notify / x-test-now 时钟覆盖）只在 sandboxEnabled() 为真时启用，
// 且 /pay/sandbox/* 仍要求 admin 鉴权（见 routes/pay.ts）。启动期再加一道：生产环境误开沙箱直接拒绝启动，
// 确保可测 seam 绝不漏到线上。

/** 沙箱可测性是否启用：显式 PAY_SANDBOX=true 且非生产环境。 */
export function sandboxEnabled(): boolean {
  return process.env.PAY_SANDBOX === 'true' && process.env.NODE_ENV !== 'production';
}

/**
 * 启动期硬护栏：生产环境若误开 PAY_SANDBOX → 抛错拒绝启动。
 * 在 buildApp() 最早期调用，覆盖 listen 与测试两条入口。
 */
export function assertSandboxSafe(): void {
  if (process.env.NODE_ENV === 'production' && process.env.PAY_SANDBOX === 'true') {
    throw new Error(
      '[安全] 生产环境禁止开启 PAY_SANDBOX —— 可测性沙箱（mock 下单 / 仿真回调 / x-test-now 时钟）绝不能漏到线上。请移除 PAY_SANDBOX=true 后再启动。',
    );
  }
}
