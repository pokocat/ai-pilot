# 短信验证码登录 / 本机号一键登录

军师小程序的账号体系支持四条登录路径，全部归一到「按手机号登录或注册」：

| 路径 | 入口 | 说明 |
| --- | --- | --- |
| **本机号一键登录** | `POST /api/auth/wechat-phone` | 小程序 `getPhoneNumber` 取号，最顺滑，**推荐主路径** |
| **短信验证码登录** | `POST /api/auth/sms/send` + `POST /api/auth/login` | 通用兜底，任何主体/任何端可用 |
| 微信账号登录 | `POST /api/auth/wechat-login` | 用 openid 建号（无手机号），补充路径 |
| 运营商一键登录 | `POST /api/auth/carrier-onetap` | **预留**，仅原生 App 可用，见文末 |

新账号自动建独立租户（Tenant）+ 用户（User），业务数据按 `tenantId/userId` 行级隔离。
token 当前复用 `userId`（演示用），生产应替换为 JWT —— 与既有约定一致。

---

## 一、短信验证码登录

### 流程

```
前端                         后端                       短信通道
 │  POST /auth/sms/send {phone}                          │
 │ ─────────────────────────▶ 限频校验                    │
 │                            生成 6 位码 → sha256 落库     │
 │                            sendSmsCode ───────────────▶ 发送
 │ ◀───────────────────────── {cooldownSec,expiresInSec,  │
 │                             devCode?}                   │
 │  POST /auth/login {phone,name?,code}                   │
 │ ─────────────────────────▶ verifySmsCode（命中即消费）   │
 │ ◀───────────────────────── {token,isNew,onboarded,user}│
```

### 接口

- `POST /api/auth/sms/send` — body `{ phone }`，返回 `{ cooldownSec, expiresInSec, devCode? }`
  - `devCode` 仅在「演示口径」回传（`SMS_PROVIDER=console` 且非生产，或显式 `SMS_RETURN_CODE=true`），用于前端自动回填，**生产不返回**。
- `POST /api/auth/login` — body `{ phone, name?, code? }`
  - 传了 `code` 就校验；`SMS_REQUIRE_CODE=true` 时即便不传也强制要求。
  - 默认不强制（兼容演示/测试免码登录与既有 `login()` 测试辅助）。

### 安全口径

- **明文验证码不落库**：只存 `sha256(phone:code)`，校验时同法比对。
- **限频**（`SmsCode` 表实时统计，见 [schema.prisma](../server/prisma/schema.prisma)）：
  - 同号两次发送最小间隔 `SMS_RESEND_COOLDOWN_SEC`（默认 60s）→ 命中返回 `429 SMS_TOO_FREQUENT`。
  - 同号每小时上限 `SMS_MAX_PER_HOUR`（默认 5）→ `429 SMS_RATE_LIMITED`。
- **一次性 + 防爆破**：命中即写 `consumedAt`（不可重放）；错误累加 `attempts`，超 `SMS_MAX_ATTEMPTS`（默认 5）作废。
- **有效期** `SMS_CODE_TTL_SEC`（默认 300s），过期不校验通过。
- 错误码：`SMS_CODE_REQUIRED` / `SMS_CODE_INVALID`（400）。

### 发送 provider

实现见 [server/src/services/sms.ts](../server/src/services/sms.ts)，`SMS_PROVIDER` 切换：

- `console`（默认）— 开发/演示，不接真实通道，仅打印（脱敏）+ 经响应回传 `devCode`。
- `aliyun` — 阿里云短信 Dysmsapi（`SendSms`，RPC 风格 HMAC-SHA1 签名）。需在控制台报备**签名**与**模板**，模板变量名须为 `code`（如「您的验证码为 ${code}，请勿泄露」），并补全 `ALIYUN_SMS_*` 环境变量。
  - 接新 provider（腾讯云等）：在 `sendSmsCode()` 里加分支即可，发放/校验/限频逻辑无需改动。

---

## 二、本机号一键登录（微信 getPhoneNumber）

> 小程序里的「本机号码一键登录」用微信官方 `getPhoneNumber` 实现 —— 返回**微信绑定的手机号**，对绝大多数用户即本机号。这是小程序沙箱里唯一可行的一键登录方案。

### 流程

```
前端 <button open-type="getPhoneNumber" @getphonenumber>      后端
 │  e.detail.code（一次性，5min 有效）                          │
 │  + 可选 wx.login() → loginCode（用于关联 openid）            │
 │  POST /auth/wechat-phone {phoneCode, loginCode?, name?}     │
 │ ──────────────────────────────────────────────▶ getAccessToken（稳定版，缓存）
 │                                                  getPhoneNumberByCode → 手机号
 │                                                  loginOrRegisterByPhone
 │                                                  （可选）best-effort 关联 openid
 │ ◀────────────────────────────────────────────── {token,isNew,onboarded,user}
```

实现见 [server/src/services/wechat.ts](../server/src/services/wechat.ts)（`getAccessToken` 走稳定版 `stable_token` 接口并缓存，`getPhoneNumberByCode` 调 `wxa/business/getuserphonenumber`）与 [server/src/routes/auth.ts](../server/src/routes/auth.ts)。

### 前置条件（重要）

- 小程序须为**企业/组织**主体，且已在微信公众平台开通「**手机号快速验证组件**」能力（按条计费）。
- 个人主体或未开通时，按钮会回调错误 —— 前端已降级提示「请用短信登录」。
- 开发者工具可用**模拟数据**联调；真机需真实能力。

---

## 三、前端集成

- API：[app/src/services/api.ts](../app/src/services/api.ts) — `sendSmsCode` / `login(phone,name,code)` / `wechatPhoneLogin`。
- 登录组件：[app/src/components/Login/index.tsx](../app/src/components/Login/index.tsx) — 一键登录主按钮（`getPhoneNumber`）+ 短信验证码倒计时表单 + 微信账号登录补充入口。
- Mock：[app/src/services/mock.ts](../app/src/services/mock.ts) — `TARO_APP_MODE=mock` 时纯前端模拟（`sendSmsCode` 固定回填 `888888`，可演示「错码」拦截）。

---

## 四、预留：原生 App 运营商「本机号码一键登录」

真正的三大运营商（移动/联通/电信）SDK 一键登录**只能用于原生 App（iOS/Android）**，小程序沙箱接不了。后端已留好统一入口：

- 路由 `POST /api/auth/carrier-onetap`（[auth.ts](../server/src/routes/auth.ts)）当前返回 `501 CARRIER_ONETAP_NOT_IMPLEMENTED`。
- 接入步骤（未来做原生端时）：
  1. App 端集成「阿里云号码认证 / 极光认证 / 运营商 SDK」，一键取得一次性 `token`。
  2. `POST /auth/carrier-onetap { provider, token, name? }`。
  3. 后端实现 `verifyCarrierToken(provider, token) → phone`（调对应运营商服务端「取号」接口）。
  4. 复用现成的 `loginOrRegisterByPhone(phone, name)` + `loginResult(...)` —— 与短信/微信一键登录同一套建号与隔离逻辑，**无需重复实现**。

即：所有登录路径都汇聚到 `loginOrRegisterByPhone`，新增运营商通道只是多一个「token → 手机号」的换号函数。

---

## 五、环境变量

见 [server/.env.example](../server/.env.example) 的「短信验证码登录」段。关键项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SMS_PROVIDER` | `console` | `console` / `aliyun` |
| `SMS_REQUIRE_CODE` | `false` | 生产置 `true` 强制校验验证码 |
| `SMS_RETURN_CODE` | `false` | 强制回传验证码（生产+aliyun 勿开） |
| `SMS_CODE_TTL_SEC` | `300` | 有效期 |
| `SMS_RESEND_COOLDOWN_SEC` | `60` | 重发冷却 |
| `SMS_MAX_PER_HOUR` | `5` | 每小时上限 |
| `SMS_MAX_ATTEMPTS` | `5` | 单码最多校验次数 |
| `ALIYUN_SMS_*` | — | 阿里云短信凭证/签名/模板/地域 |

当前生产短信验证码模板固定使用 `ALIYUN_SMS_TEMPLATE_CODE=SMS_508120103`；切换模板前需先确认阿里云控制台模板变量仍为 `code`。

> 改 schema 后需 `npm run db:push` 建 `sms_code` 表。

---

## 六、测试

[server/test/integration.test.ts](../server/test/integration.test.ts) `TC-F` 覆盖：发送+回传 devCode、正确码登录建号、错误码拦截、一次性消费、冷却 429、免码兼容、微信一键登录取号（mock fetch）、运营商入口 501、阿里云签名工具确定性。`npm test` 全绿（112/112）。
