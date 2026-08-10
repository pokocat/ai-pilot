# 用户可见错误处理规范

本文件是错误语义与交互的工程清单。目标不是把每个异常都写成一句不同文案，而是保证任何失败都能回答四件事：**发生了什么、用户现在能做什么、原操作是否值得重试、技术细节放在哪里**。

## 1. 传输层约定

- 服务端业务失败统一返回 `{ error, code, ...context }`；前端按 `code` 决策，不能只看 402/403/409。
- 原生小程序的 `enableChunked` 可能把 4xx JSON 作为 `ArrayBuffer` 返回，必须先 UTF-8 解码再取 `code`。
- 401 要保留“请求发出时是否携带 token”：有 token 才是登录态失效并触发全局退出；游客无 token 是动作级登录门。
- 408/504 显示超时，429 显示稍后再试，5xx 统一显示“服务暂时不可用”。服务端异常、数据库错误、堆栈和供应商原文只进入 `technicalMessage`/日志，不直接展示。
- JSON 请求与 multipart 上传必须走同一套 HTTP 错误降级，上传不能丢 `code/statusCode/data/technicalMessage`。

实现入口：

- 原生：`app/weapp-native/services/request.js`、`services/api-error.js`、`services/store.js`
- H5：`app/src/services/api.ts`、`services/apiError.ts`、`services/store.ts`
- 对话错误卡：`app/weapp-native/services/chat-error.js`、`app/src/services/chatError.ts`
- 支付领域补充：`app/src/services/paymentFeedback.ts`（报价、建单、支付、到账阶段文案）

## 2. 错误语义矩阵

| 类别 | 典型 code | 是否原样重试 | 用户动作 |
|---|---|---:|---|
| 登录 | `UNAUTHORIZED` | 否 | 老 token 失效则重新登录；游客留在原页打开动作级登录层 |
| 方案/用量 | `PLAN_REQUIRED`、`PLAN_EXPIRED`、`INSUFFICIENT_QUOTA`、`KNOWLEDGE_QUOTA`、HTTP 402 兜底 | 否 | 查看方案与权益 |
| 算力 | `INSUFFICIENT_CREDITS` | 否 | 查看算力明细 |
| 能力门禁 | `AGENT_LOCKED`、`SKU_REQUIRED`、`FEATURE_DISABLED` | 否 | 按业务页启用/购买，或明确告知暂未开放 |
| 内容与输入 | `MODERATION_BLOCK`、`IMAGE_MODERATION_BLOCKED`、`BAD_*`、`EMPTY_*`、`*_REQUIRED`、413/415/422 | 否 | 修改输入或更换文件，保留未提交内容 |
| 频率限制 | `RATE_LIMITED`、`FORCES_RATE_LIMIT`、`ORDER_RATE_LIMITED`、HTTP 429 | 否（不能立即重试） | 告知稍后/次日再试；服务端有具体恢复时间时优先保留 |
| 状态冲突 | `GENERATION_IN_PROGRESS`、`IDEMPOTENCY_CONFLICT`、`QUOTE_CHANGED`、`ORDER_CREATING`、HTTP 409 | 否 | 接管在途任务、刷新状态或重新确认，禁止重复建单/生成 |
| 资源不存在 | `SESSION_NOT_FOUND`、`GENERATION_NOT_FOUND`、`*_NOT_FOUND`、HTTP 404 | 否 | 返回/刷新后重新进入，不展示无意义重试 |
| 暂时不可用 | `AI_BUSY`、`AI_UNAVAILABLE`、`AI_EMPTY_RESPONSE`、渲染/上传失败、408/5xx、`NETWORK_ERROR` | 是 | 保留原输入与引用，提供重试 |
| 用户取消 | `CANCELLED` | 否 | 静默收口或显示已取消，不弹“失败” |

规则优先级：业务 `code` > HTTP 状态 > 可读中文业务原因 > 页面动作 fallback。未知英文/技术文本不能越过 fallback 直接进入 C 端。

## 3. 对话错误卡

- 只有网络、超时、AI 暂时不可用等“同样请求稍后可能成功”的错误才显示“重新回答”。
- 方案/额度/算力门禁显示对应入口；审核、参数、限流、冲突、资源不存在均不提供原样重试。
- 用户原问题与引用在失败后继续保留。修改账户状态或输入后可重新发送，不需要重新录入。
- `GENERATION_IN_PROGRESS` 有 `generationId` 时优先接管轮询，不落错误卡。

## 4. 运营后台

- 401 是登录失效；403 是权限不足。403 必须保留服务端 `e.message`，不能踢登录，也不能盖成“操作失败”。
- 主数据取数必须区分加载中、加载失败、确实为空，并提供重试；次要信息若选择静默降级，要在代码中说明不阻断的原因。
- 写操作 catch 必须展示 `(e as Error).message || 领域 fallback`。本地 JSON/CSV 解析错误可以使用确定性的本地文案。
- 删除、退款、额度/套餐调整等高风险操作仍走 `ConfirmDialog`；错误处理不能把失败状态伪装成成功或空态。

## 5. 新增错误码检查清单

1. 服务端返回稳定的机器码和面向业务的中文 `error`，需要客户端决策的上下文放结构化字段。
2. 在原生/H5 `api-error` 镜像中决定类别、文案、`retryable` 与 `action`；对话特例再进入 `chat-error`。
3. 若属于支付阶段，在 `paymentFeedback.ts` 补报价/建单/支付/到账的阶段文案。
4. 至少补一条“不可重试”和一条“可重试”测试；涉及微信 chunked/upload 时补传输层用例。
5. 运营端写操作透出 `e.message`，读操作明确失败态与空态。
6. 更新 `AGENTS.md` 与 `docs/CHANGELOG.md`，再跑 app 测试、原生/H5 构建；后台有改动时跑 `lint:ui` 与 build。
