// 可测性沙箱总开关 + 生产硬护栏（D9：双控门禁、生产关死）。
//
// 沙箱三件套（mock 下单 / 仿真回调 /pay/sandbox/notify / x-test-now 时钟覆盖）只在 sandboxEnabled() 为真时启用，
// 且 /pay/sandbox/* 仍要求 admin 鉴权（见 routes/pay.ts）。启动期再加一道：生产环境误开沙箱直接拒绝启动，
// 确保可测 seam 绝不漏到线上。
//
// ⚠️ 仓库里一共有四套「不花真钱也能拿到权益」的通道，别混淆（每套的边界都不同）：
//   ① services/wechatPayMock.ts —— 本地 mock 微信网关（走真加解密，scripts/pay:e2e:mock 用）；
//   ② 本文件的 PAY_SANDBOX 沙箱 —— /pay/sandbox/notify 仿真回调，admin 鉴权 + 生产启动期硬禁；
//   ③ 本文件的 demoPurchaseEnabled() —— /plans/:id/purchase 演示发放，**整条绕过支付管线**；
//   ④ PAY_MOCK_SUCCESS —— 真实下单 + 真实 markPaidAndApply，只把「调微信」那一步换成本地模拟。
//      ④ 的开关判定放在 services/wechatPay.ts 的 payMockSuccessEnabled()：它必须与 payConfigured()
//      组合（真凭据一配齐即自动让位），而 payConfigured 住在 wechatPay.ts，放这里会与
//      「wechatPay.ts → sandbox.ts」形成模块循环依赖。生产启动守卫会直接拒绝该开关。

/** 沙箱可测性是否启用：显式 PAY_SANDBOX=true 且非生产环境。 */
export function sandboxEnabled(): boolean {
  return process.env.PAY_SANDBOX === 'true' && process.env.NODE_ENV !== 'production';
}

/**
 * 是否允许「演示发放」付费套餐（/purchase 不经支付直接到账）。**默认拒绝（fail-safe）**：
 * 仅自动化测试（NODE_ENV=test）或显式 `ALLOW_DEMO_PURCHASE=true` 的环境才放行。
 *
 * production 恒 false；启动守卫还会拒绝显式配置，防止环境误配被静默忽略。
 */
export function demoPurchaseEnabled(): boolean {
  return process.env.NODE_ENV === 'test'
    || (process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEMO_PURCHASE === 'true');
}

/**
 * 启动期硬护栏：生产环境若误开任何免支付权益通道 → 抛错拒绝启动。
 * 在 buildApp() 最早期调用，覆盖 listen 与测试两条入口。
 */
export function assertSandboxSafe(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const unsafe = ['PAY_SANDBOX', 'PAY_MOCK_SUCCESS', 'ALLOW_DEMO_PURCHASE'].filter((key) => process.env[key] === 'true');
  if (unsafe.length) {
    throw new Error(
      `[安全] 生产环境禁止开启免支付权益通道：${unsafe.join(', ')}。请移除后再启动。`,
    );
  }
}
