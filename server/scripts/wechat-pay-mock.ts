// 独立启动本地 mock 微信支付服务器：npm run pay:mock
//
// 首次启动在 server/.paymock/ 生成并持久化商户/平台密钥与 APIv3 密钥（已 gitignore），
// 之后重启复用同一套密钥；启动时打印可直接粘贴进 server/.env 的 WECHAT_PAY_* 配置块。
// 本地联调步骤：
//   1) npm run pay:mock                         # 起 mock（默认 :9860）
//   2) 把打印的配置块粘进 server/.env → npm run dev  # 后端指向 mock，payConfigured()=true
//   3) 前端/接口 POST /api/plans/:id/order 下单
//   4) curl -X POST http://127.0.0.1:9860/mock/pay/<outTradeNo>   # 模拟用户付款 → 真实格式回调入账
//   5) GET /api/pay/orders/<outTradeNo> 轮询到 appliedAt 有值 = 权益到账
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWechatPayMock, generateWechatPayMockKeys, type WechatPayMockKeys } from '../src/services/wechatPayMock.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.paymock');
mkdirSync(dir, { recursive: true });

function loadOrInit(file: string, init: () => string): string {
  const p = path.join(dir, file);
  if (existsSync(p)) return readFileSync(p, 'utf8');
  const v = init();
  writeFileSync(p, v);
  return v;
}

const keys: WechatPayMockKeys = JSON.parse(loadOrInit('keys.json', () => JSON.stringify(generateWechatPayMockKeys(), null, 2)));
const apiV3Key = loadOrInit('apiv3key.txt', () => randomBytes(16).toString('hex')); // 32 字符
const appId = process.env.WECHAT_MINI_APPID || 'wxmockappid00001';
const mchId = process.env.WECHAT_PAY_MCHID || '1900000001';
const port = Number(process.env.WECHAT_PAY_MOCK_PORT ?? 9860);
const apiPort = Number(process.env.PORT ?? 4000);

const mock = buildWechatPayMock({ appId, mchId, apiV3Key: apiV3Key.trim(), keys, logger: true });

const esc = (pem: string) => pem.trim().replace(/\n/g, '\\n');
mock.app.listen({ port, host: '127.0.0.1' }).then(() => {
  console.log(`\n✅ mock 微信支付服务器已启动：http://127.0.0.1:${port}（密钥持久化于 server/.paymock/）\n`);
  console.log('—— 粘贴进 server/.env 让后端指向本 mock ——');
  console.log(`WECHAT_PAY_BASE=http://127.0.0.1:${port}`);
  console.log(`WECHAT_MINI_APPID=${appId}`);
  console.log(`WECHAT_PAY_MCHID=${mchId}`);
  console.log(`WECHAT_PAY_APIV3_KEY=${apiV3Key.trim()}`);
  console.log(`WECHAT_PAY_CERT_SERIAL=${keys.merchantSerial}`);
  console.log(`WECHAT_PAY_PRIVATE_KEY=${esc(keys.merchantPrivateKeyPem)}`);
  console.log(`WECHAT_PAY_PLATFORM_CERT=${esc(keys.platformPublicKeyPem)}`);
  console.log(`WECHAT_PAY_NOTIFY_URL=http://127.0.0.1:${apiPort}/api/pay/wechat/notify`);
  console.log('\n—— 模拟用户付款 ——');
  console.log(`curl -X POST http://127.0.0.1:${port}/mock/pay/<outTradeNo>`);
  console.log(`curl http://127.0.0.1:${port}/mock/orders   # 查看 mock 侧订单\n`);
}).catch((err) => { console.error(err); process.exit(1); });
