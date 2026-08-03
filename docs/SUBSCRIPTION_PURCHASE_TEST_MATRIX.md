---
matrixVersion: 1
source: docs/SUBSCRIPTION_PURCHASE_UX_PLAN.md#11
snapshotDate: 2026-08-02
statusValues: [covered, partial, missing, manual]
rows:
  - { id: SUB-AC-01, status: partial, target: app/src/services/planViewModel.test.ts }
  - { id: SUB-AC-02, status: partial, target: server/test/planOptions.test.ts }
  - { id: SUB-AC-03, status: partial, target: server/test/pricingOperatorOwned.test.ts }
  - { id: SUB-AC-04, status: covered, target: app/src/services/planViewModel.test.ts }
  - { id: SUB-AC-05, status: partial, target: app/src/services/planViewModel.test.ts }
  - { id: SUB-AC-06, status: covered, target: server/test/planPurchaseRoutes.test.ts }
  - { id: SUB-AC-07, status: covered, target: app/src/services/paymentFeedback.test.ts }
  - { id: SUB-AC-08, status: partial, target: app/src/services/pay.test.ts }
  - { id: SUB-AC-09, status: partial, target: app/src/services/planViewModel.test.ts }
  - { id: SUB-AC-10, status: partial, target: app/src/services/planViewModel.test.ts }
  - { id: SUB-AC-11, status: partial, target: server/test/planOptions.test.ts }
  - { id: SUB-AC-12, status: partial, target: server/test/wechatPayMockFlow.test.ts }
  - { id: SUB-AC-13, status: partial, target: server/test/pricingOperatorOwned.test.ts }
  - { id: SUB-AC-14, status: covered, target: server/test/planEntitlement.test.ts }
  - { id: SUB-AC-15, status: covered, target: server/test/planEntitlement.test.ts }
  - { id: SUB-AC-16, status: partial, target: server/test/planPurchaseRoutes.test.ts }
  - { id: SUB-AC-17, status: covered, target: server/test/wechatRefund.test.ts }
  - { id: SUB-AC-18, status: partial, target: server/test/wechatPaySafety.test.ts }
  - { id: SUB-AC-19, status: partial, target: server/test/paymentProductionGuard.test.ts }
  - { id: SUB-AC-20, status: partial, target: server/test/planOptions.test.ts }
  - { id: SUB-AC-21, status: covered, target: server/test/monthlyCredits.test.ts }
---

# 方案购买与权益测试矩阵

本文是 `SUBSCRIPTION_PURCHASE_UX_PLAN.md` §11 的测试实施清单。YAML front matter 是机器可读索引，正文是评审与执行口径。状态只表示**当前仓库已有自动化是否足以证明该条验收成立**，不表示业务代码是否已完成。

状态定义：

- `covered`：已有自动化完整覆盖，不依赖人工补证。
- `partial`：已有相邻覆盖，但缺少本方案新增的关键断言。
- `missing`：没有能证明该条验收的自动化。
- `manual`：只能通过真机、微信支付或线上配置核验的项目；仍需尽量补服务端/纯逻辑自动化。

当前快照：`covered=7`、`partial=14`、`missing=0`。本轮已补齐支付反馈、降档只读、报价一致性、不同订单并发到账、续期/同档转年不刷新当月权益、年付 12 个锚点周期钻石恰好一次发放，以及退款状态机/来源回收；首屏视觉、完整 options 关系矩阵、支付成功后刷新失败和真机支付仍需继续补证。

## 1. §11 验收映射

| ID | §11 | 当前状态 | 现有证据 | 关键缺口 | 建议自动化落点 |
|---|---:|---|---|---|---|
| SUB-AC-01 | 1 | partial | `planViewModel.test.ts` 已证明当前方案按稳定 id 命中、改名/到期不消失；正式 weapp 构建通过 | 首屏固定顺序、用量等级/有效期/manual 文案仍需真机视觉验收 | 保持纯状态测试，发布候选补真机截图 |
| SUB-AC-02 | 2 | partial | `/plans/options` 已返回 `PublicUsageView`，方案页只读取百分比/状态/恢复时间；`planExpiry.test.ts` 覆盖锚点重置 | 缺 `usagePercent` 0~100 clamp 与状态边界的服务端表驱动测试 | `server/test/planOptions.test.ts` 补百分比边界；旧 `/me.tokenQuota` 留兼容窗口 |
| SUB-AC-03 | 3 | partial | `DEV_PLANS` 与公开契约已含 `usageLevel/usageLabel`；`pricingOperatorOwned.test.ts` 覆盖 5x 最低倍率硬校验 | 缺 20x、custom 和标签直接来自 DB 的独立回归 | 扩展 `pricingOperatorOwned.test.ts` + options 读取测试 |
| SUB-AC-04 | 4 | covered | 服务端降档 409 且不落单；`planViewModel.test.ts` 证明 remind/不可购动作不能发起购买；`paymentFeedback.test.ts` 证明业务限制不会显示成支付失败 | 无 | 保持服务端守卫 + 客户端纯状态测试 |
| SUB-AC-05 | 5 | partial | options 路由已返回 relation/action；`planViewModel.test.ts` 覆盖 buy/renew/upgrade/change_billing/continue 与三种只读动作；隐藏支付档另有 options 回归 | 尚缺服务端完整 relation/action 表驱动矩阵 | 新建 `server/test/planOptions.test.ts` 覆盖无方案、续期、升级、转年、降档、企业、待支付、到账中 |
| SUB-AC-06 | 6 | covered | `planPurchaseRoutes.test.ts` 已覆盖只读报价、目标价格变化、来源权益版本变化、预期金额篡改均返回 `QUOTE_CHANGED`，重新报价后的订单金额与指纹落库一致 | 报价过期时间边界仍可作为增强项，但不影响条款重算安全性 | 继续保留在 `server/test/planPurchaseRoutes.test.ts` |
| SUB-AC-07 | 7 | covered | `paymentFeedback.test.ts` 覆盖用户取消、13 个业务错误码、报价/下单/支付/到账/启用五阶段兜底，并兼容顶层与嵌套 code | 无 | 保持 `app/src/services/paymentFeedback.test.ts` |
| SUB-AC-08 | 8 | partial | `payMockSuccess.test.ts`、`wechatPayMockFlow.test.ts` 覆盖 `paid/appliedAt`、轮询补账和卡单 | 未证明 `requestPayment` 成功后刷新失败不会走支付失败分支 | `app/src/services/pay.test.ts` 模拟支付成功后轮询超时；断言“到账处理中”，不抛支付失败 |
| SUB-AC-09 | 9 | partial | `planViewModel.test.ts` 已证明当前方案只按 id 匹配，运营改名不影响客户端当前卡 | 尚缺持有后改名再读 `/plans/options` 的服务端回归 | `server/test/planOptions.test.ts` 补改名端到端 |
| SUB-AC-10 | 10 | partial | 客户端已有支付反馈与方案纯状态测试；服务端已有完整支付/权益集成回归；正式 weapp 构建通过 | 真机支付与视觉证据未记录 | 按 §4 真机清单验收并记录版本/账号/订单号 |
| SUB-AC-11 | 11 | partial | `tierRank + planFamilyKey` 已成为 relation/折算/运营改档统一判定；`planEntitlement.test.ts` 覆盖同 family 月转年不重置当月 quota/钻石，降档 409 也有既有回归 | 尚缺“月付高档 → 年付低档”这一组显式路由用例，以及 options relation 表驱动全矩阵 | `server/test/planOptions.test.ts` 补上跨周期降档与完整 relation 表 |
| SUB-AC-12 | 12 | partial | 订单/options 已返回真实 `payableUntil`，方案页已展示“可在…前继续支付”；`wechatPayMockFlow.test.ts` 覆盖 created 可续付和 115 分钟后 `ORDER_EXPIRED` | `REPAY_SAFE_WINDOW_MS` 的 109m59s/110m00s 精确两侧边界尚无自动化 | 在现有 mock-flow 测试用可控时钟覆盖两侧边界，并断言 options/订单的 `payableUntil` |
| SUB-AC-13 | 13 | partial | `pricingOperatorOwned.test.ts` 已覆盖低于标准基线 5 倍时硬拒绝、达到 5 倍才允许建档；后台建改删与审计仍全绿 | 仍缺 20x、无 standard 基线、同 family 月年权益不一致与企业 custom 的独立负向用例 | 继续扩展 `server/test/pricingOperatorOwned.test.ts`；另加 admin 表单纯校验/UI 状态测试（若有合适测试基建） |
| SUB-AC-14 | 14 | covered | `planEntitlement.test.ts` 覆盖同 family 月/年额度一致、续期与转年不刷新 quota/钻石；`monthlyCredits.test.ts` 快进完整 12 个锚点周期并并发触发；`planExpiry.test.ts` 覆盖跨锚点周期 12 路并发预留只重置一次且不覆盖已扣额度 | 到期后的第 13 周期“不再发放”可作为额外负向用例 | 保持 `planEntitlement.test.ts` + `monthlyCredits.test.ts` + `planExpiry.test.ts` |
| SUB-AC-15 | 15 | covered | `planEntitlement.test.ts` 创建两笔不同订单并发 `markPaidAndApply`，断言两单 applied、有效期累计两期、权益账本两行、当月权益只发一次 | 无 | 保持现有测试 |
| SUB-AC-16 | 16 | partial | `planPurchaseRoutes.test.ts` 覆盖同用户同 `clientRequestId` 8 并发只产生同一订单，并覆盖换 plan/amount/quoteFingerprint 一律 `409 IDEMPOTENCY_CONFLICT`；该测试曾发现 P2002 与 closeStale 自关单竞态 | 仍缺关微信旧单失败/超时后的 fail-closed | 扩展 `planPurchaseRoutes.test.ts` 或新建 `wechatPayIdempotency.test.ts` |
| SUB-AC-17 | 17 | covered | `wechatRefund.test.ts` 覆盖 PROCESSING/CLOSED/ABNORMAL 均不写 `refundedAt` 且不撤权益，SUCCESS 幂等且只撤对应套餐来源；重复模块购买退款一单仍保留另一来源，最后一单退款才停用 | 部分退款与主动查退款 sweep 可作为增强项，但不影响本条终态与来源回收验收 | 保持 `server/test/wechatRefund.test.ts` |
| SUB-AC-18 | 18 | partial | 回调已 fail-closed，支持自动平台证书、匹配 serial 的静态证书与 `PUB_KEY_ID_*` 公钥，并强校验 5 分钟时窗、transactionId/appid/mchid/金额必填与一致；现有测试已覆盖篡改签名、金额错和证书轮换 | 尚缺将公钥模式、未知 serial、过期/未来时间戳、各必填字段缺失分别锁死的独立负向测试 | `server/test/wechatPaySafety.test.ts` 表驱动上述安全边界 |
| SUB-AC-19 | 19 | partial | `assertSandboxSafe` 已对 production 下的 `PAY_SANDBOX/PAY_MOCK_SUCCESS/ALLOW_DEMO_PURCHASE` 三个免支付开关统一拒绝启动，test/development 仍可用 | 三开关尚无同一个表驱动用例逐一证明 production 拒绝与 dev/test 放行 | `server/test/paymentProductionGuard.test.ts` 表驱动三开关与真支付缺配 fail-closed |
| SUB-AC-20 | 20 | partial | `PublicUsageView` 已增入 `/me` 和 `/plans/options`，方案页/profile/credits 已迁移到百分比视图；旧 `/me.tokenQuota` 原值仅为存量小程序兼容保留 | 尚缺“不提供 raw 字段时新页仍可工作”的静态/行为门禁；终态删 raw 仍需等旧版本占比衰减 | `server/test/planOptions.test.ts` 验证增量契约；app 测试用仅含新字段的夹具验证纯状态模型 |
| SUB-AC-21 | 21 | covered | `monthlyCredits.test.ts` 覆盖年付从激活周期到第 12 周期、同周期重复和并发触发均恰好一次；周期键始终跟随激活日 | 存量线上回填需另做发布后数据抽查，不属于单元测试缺口 | 保持现有测试并在发布验收抽查存量年付账号 |

## 2. 现有测试与夹具盘点

### 2.1 支付主链路

| 文件 | 当前覆盖 | 本方案实施时注意 |
|---|---|---|
| `server/test/wechatPay.test.ts` | 同一订单重复/并发成功回调幂等，非成功态、未知单、金额不一致 | 不能替代“不同订单并发到账”；安全字段校验需要扩展 |
| `server/test/wechatPayMockFlow.test.ts` | 真 v3 签名/加解密 mock 网关、下单、回调、查单补账、降级守卫、旧折算、快照、继续支付、退款 SUCCESS、证书轮换、后台对账 | 是主要集成测试载体；退款用例的 mock 网关固定即时 SUCCESS，不能证明 PROCESSING 状态机 |
| `server/test/payMockSuccess.test.ts` | `PAY_MOCK_SUCCESS` 在 test/dev 的全链路、同单幂等、mock/真单隔离、对账/营收隔离、openid 防伪 | production 已由 `assertSandboxSafe` 强制禁用；待增表驱动守卫测试，不能回退为“测试期可在生产免支付” |
| `server/test/planHidden.test.ts` | 隐藏档白名单可见/可购、非白名单 404、options 固定 available/buy、隐藏档绕过降档守卫 | 保持公开列表、用户态 options 与下单三层语义一致 |
| `server/test/planExpiryRoute.test.ts` | 过期门禁、额度耗尽、支付未配时 `/purchase` 保护、企业档不可自助 | 新 options/quote/order 仍需保持同样的过期与企业档口径 |

### 2.2 套餐、额度与并发

| 文件 | 当前覆盖 | 本方案实施时注意 |
|---|---|---|
| `server/test/planExpiry.test.ts` | 激活/到期、锚点子周期、年付 token 逐月重置、跨期并发预留不重复刷满、续期叠加、旧价格折算、月末 clamp | 续期/同 family 月转年的余额保护由 `planEntitlement.test.ts` 补齐；credits 逐月发放由 `monthlyCredits.test.ts` 补齐 |
| `server/test/concurrency.test.ts` | credits 账户直接并发发放不丢失 | 只查余额/流水，不查套餐时长；需另测两个 PaymentOrder 的并发 applied |
| `server/test/integration.test.ts` | `/me` 旧 tokenQuota、额度扣减、演示购买、后台余额同步 | Z3 明确锁定 raw 字段，兼容期保留；终态删字段时必须有单独迁移窗口，不能直接改断言 |
| `server/test/adminOps.test.ts` | 后台 quota 查询/重置/设置、credits 调整、延长套餐、运营改档损失守卫 | 临时加额“增量 + 失效时间 + 原因 + 操作人”尚未覆盖；当前 set/reset 是覆盖式语义 |
| `server/test/pricingOperatorOwned.test.ts` | 套餐目录由运营维护、后台 CRUD、审计、禁止代码同步覆盖线上定价 | 新 family/tier/usage 字段和倍率校验应集中扩展在这里 |
| `server/test/planEntitlement.test.ts` | 两笔不同订单并发到账累计时长；续期与同 family 转年不刷新当月 quota/钻石 | 用户级权益锁和月度单周期权益核心回归 |
| `server/test/monthlyCredits.test.ts` | 年付完整 12 个激活锚点周期、同周期重复/并发触发钻石恰好一次 | 发布后仍需抽查存量年付账号的首个新周期 |
| `server/test/planPurchaseRoutes.test.ts` | `clientRequestId` 8 并发幂等；同 key 换 plan/amount/fingerprint 冲突；目标商业条款、来源权益版本、预期金额变化触发 `QUOTE_CHANGED` | 尚需补关旧单失败/超时后的 fail-closed |
| `server/test/wechatRefund.test.ts` | PROCESSING/CLOSED/ABNORMAL 不撤权益；SUCCESS 只撤对应来源并保留其它续期来源；重复模块购买按来源回收 | 尚需补部分退款与主动查退款 sweep |

### 2.3 客户端纯状态

| 文件 | 当前覆盖 | 本方案实施时注意 |
|---|---|---|
| `app/src/services/paymentFeedback.test.ts` | 用户取消、业务错误码、五阶段未知错误兜底 | 支付成功后的轮询/刷新编排仍需在 `pay.test.ts` 用 stub 覆盖 |
| `app/src/services/planViewModel.test.ts` | 稳定 id 当前态、到期边界、周期筛选、动作是否可购买、原始额度文案过滤 | 组件布局与微信支付调起仍走真机验收 |

### 2.4 测试夹具与可测 seam

- `server/test/helpers.ts#seedBaseline` 每次从 `server/src/data/seedConfig.ts#DEV_PLANS` 重建套餐；该数组只是本地/测试夹具，不是线上真相源。
- 当前 `DEV_PLANS` 提供：入门月付、决策月付、决策年付、企业面议、隐藏 1 分支付档，并已带 `planFamilyKey/tierRank/usageLevel/usageLabel`；`seedBaseline` 会完整写入这些字段。
- `server/src/services/clock.ts#runWithNow` 已能无等待快进锚点周期，适合月度 token/credits、报价边界和续期测试。
- `server/src/services/wechatPayMock.ts` 模拟微信 v3 下单、查单、关单和退款；当前退款固定返回 `SUCCESS`。测试 PROCESSING/CLOSED/ABNORMAL 应直接 stub fetch 或增强 mock 网关为可配置状态，避免用真实网络。
- `server/test/hermeticEnv.mjs` 是出站隔离基线；新增支付测试继续使用 `.env.test + hermeticEnv + tsx + --test-concurrency=1`。
- app 当前只有少量纯逻辑测试，没有 React/Taro 组件测试基建。优先把“关系 → 动作/文案”“支付阶段 → 反馈”抽成无 Taro 依赖的纯函数，用 `node:test` 覆盖；视觉布局走真机验收。
- admin 当前也以纯逻辑测试为主。倍率和 family 一致性必须先由服务端强校验；表单 UI 再补最小纯校验测试与人工验收。

## 3. 推荐测试分层与执行顺序

1. **P0-0 回归**：`monthlyCredits.test.ts`、`paymentFeedback.test.ts`、`planViewModel.test.ts`。
2. **P0 后端**：`planOptions.test.ts`、`wechatPayIdempotency.test.ts`、`wechatRefund.test.ts`、`wechatPaySafety.test.ts`、`paymentProductionGuard.test.ts`。
3. **P0 客户端**：保持 `planViewModel.test.ts`、`paymentFeedback.test.ts`，补 `pay.test.ts`，然后 H5/真机查看当前方案首屏和低档禁购。
4. **P1 后端**：`planEntitlement.test.ts`、`planQuote.test.ts`、后台倍率与临时加额测试。
5. **P1 客户端**：报价确认、QUOTE_CHANGED、继续支付、到账处理中。
6. **最终回归**：现有 payment/plan/expiry/admin tests + 三端构建 + 真机支付测试档。

建议服务端定向命令（测试文件落地后将新文件加入列表）：

```bash
cd server
node --env-file=.env.test --import ./test/hermeticEnv.mjs --import tsx --test --test-concurrency=1 \
  test/wechatPay.test.ts \
  test/wechatPayMockFlow.test.ts \
  test/payMockSuccess.test.ts \
  test/planExpiry.test.ts \
  test/planExpiryRoute.test.ts \
  test/planHidden.test.ts \
  test/concurrency.test.ts \
  test/monthlyCredits.test.ts \
  test/planEntitlement.test.ts \
  test/planPurchaseRoutes.test.ts \
  test/pricingOperatorOwned.test.ts \
  test/adminOps.test.ts \
  test/wechatRefund.test.ts
  test/wechatPapay.test.ts
```

### 3.1 自动续费专项矩阵

| 场景 | 自动化断言 | 真机/商户平台断言 |
|---|---|---|
| 默认购买方式 | 每次打开确认页均为单次购买 | 微信支付页不会默认开启自动续费 |
| 配置降级 | APIv2 Key、回调、套餐开关或模板缺一即 `autoRenewAvailable=false` | 只显示单次购买且可正常付款 |
| 支付中签约 | XML 签名及各报文实际携带的 openid/模板/协议号/appid/mchid 不一致均拒绝 | 主动选择后收到 ADD 回调，当前卡显示已开启 |
| 签约首单幂等/继续支付 | 同 `clientRequestId` 仅在套餐、金额、报价指纹、条款哈希完全一致且仍为支付窗口内的 `created` 单时复用；并发仅一次微信外呼；终态/过期/载荷变化返回 409 | 网络重试复用原单，退出支付页后可继续支付；已关闭、过期或已变更报价不能再次调起 |
| 只付款未签约 | 初始支付仍发当前周期权益；无 ADD 且查关系未签约时，已付款 pending 保留完整 6 小时窗口后清理 | 当前卡不把“确认中”冒充“已开启” |
| 周期扣款 | 到期前 24h 只创建一笔 PAP 申请；回调重复只发一次权益 | 商户平台可见扣款前通知与最终续期订单 |
| 签约回调丢失 | `/papay/querycontract` 按模板 ID + 商户协议号补激活，回包身份不一致时保持 pending | 断开签约回调后恢复，当前卡仍能进入“已开启” |
| 扣款回调丢失 | 获灰度权限后由 `/pay/paporderquery` 补账；ACCEPT 不提前发权益 | 断开扣款回调后恢复仍能到账；未获查单权限时以平台订单人工核对 |
| 失败重试 | 同周期最多两次；只有明确业务失败才重试，网络超时/SYSTEMERROR/验签解析失败保留原单且重复扫描不换单 | 余额不足等明确失败可二次尝试，结果不确定时不得形成双单 |
| 关闭/微信侧解约 | DELETE 回调幂等，`nextBillingAt=null`；解约请求结果不确定时保持 `cancel_pending` 停扣并重试 | 当前周期继续用，后续不再扣款；网络抖动时先显示“关闭中” |
| 改价/换档/退款 | 本地先停扣并由 scheduler 补做微信侧解约 | 旧授权不得按新价格或旧套餐扣款 |

## 4. 真机与线上配置验收记录模板

自动化不能替代以下证据；每次候选发布至少记录一次：

| 项目 | 记录 |
|---|---|
| 小程序版本 / commit |  |
| 测试账号（脱敏） |  |
| 当前方案 / 目标方案 ID |  |
| clientRequestId / outTradeNo |  |
| 场景 | 新购 / 续期 / 升级 / 转年付 / 单次购买 / 自动续费签约 / 自动扣款 / 解约 / 继续支付 / 取消 / 退款 |
| 微信是否调起 / 是否真实扣款 |  |
| 页面最终状态与文案 |  |
| 后台订单状态 / entitlement / quota period |  |
| 退款状态与最终回收结果 |  |
| 截图或日志位置 |  |

真机最小场景集：无方案新购、当前方案续期、同 family 月转年、跨 tier 升级、有效期内降档、用户取消、支付成功但轮询暂时失败、created 订单继续支付、退款 PROCESSING 后 SUCCESS。涉及真实扣款时只使用隐藏 1 分测试档或经明确批准的测试商户环境。
