# 智能体接入（Per-Agent Provider / Dify）

> 每个智能体可以单独指定后端，而不必都共用「模型配置」里那一套全局大模型。
> 三种接入方式：**跟随全局模型（inherit）**、**自定义 OpenAI 兼容端点（openai）**、**绑定 Dify 应用（dify）**。
> 全局模型配置见运营后台「模型配置」页（`AiSetting` 单例）；本篇讲的是**智能体级**的接入覆盖。

---

## 一、为什么要 per-agent 接入

「模型配置」是全局单例：所有智能体共用一个 provider/baseUrl/model/key，靠各自的 System 提示词区分。
但有些智能体是在 **Dify** 上独立编排好的应用（自带提示词、工具、知识库、工作流），每个应用有自己专属的
`api_key` 和 base URL —— 这类智能体没法塞进全局那一套配置。于是给 `Agent` 增加了「接入方式」：

| 模式 | 取值 | 说明 |
| --- | --- | --- |
| 跟随全局模型 | `inherit`（默认） | 走「模型配置」里的统一大模型，行为同以前 |
| 自定义模型端点 | `openai` | 这个智能体单独用一套 OpenAI 兼容 `baseUrl`/`model`/`key`，覆盖全局；提示词/记忆/上下文工程仍照常 |
| Dify 应用 | `dify` | 绑定一个 Dify 应用，走 `chat-messages` 接口；提示词/编排在 Dify 侧，本地只传问题 + 上下文变量 |

> 现有智能体默认 `inherit`，升级后行为不变，直到你在后台把某个智能体改成 `openai`/`dify`。

---

## 二、数据模型

`server/prisma/schema.prisma`：

```prisma
model Agent {
  // …既有字段…
  providerMode String  @default("inherit") // inherit | openai | dify
  // 自定义 OpenAI 兼容端点（providerMode=openai 时生效）
  apiBaseUrl   String?  // 如 https://api.deepseek.com/v1
  apiModel     String?  // 如 deepseek-chat
  apiKey       String?  @db.Text
  // Dify 应用（providerMode=dify 时生效）
  difyBaseUrl  String?  // 如 http://ai.aibuzz.cn/v1
  difyApiKey   String?  @db.Text  // 每个 Dify 应用专属 key
  difyInputs   Json?    // { Dify输入变量名: "{企业档案}" } 本地上下文 → Dify inputs 的映射
}

model Session {
  // …既有字段…
  difyConversationId String? // Dify 多轮上下文 id，首次对话由 Dify 返回后回写
}
```

字段是新增的，需要把表结构推到数据库（本项目用 `db push`，无迁移文件）：

```bash
cd server && npm run db:push
```

---

## 三、调用链与路由

```
/generate-sync (routes/sessions.ts)
  └─ buildGenContext (services/context.ts)
        └─ resolveAgentRuntime(agent)  →  ctx.runtime  (inherit → null)
  └─ generateDeliverable / chatComplete (llm/gateway.ts)
        ├─ ctx.runtime 存在 → runtimeDeliverable / runtimeChat（绕过全局 provider 与结果缓存）
        │     ├─ mode=dify    → providers/dify.ts，回写 conversation_id
        │     └─ mode=openai  → providers/openai.ts（用覆盖后的 baseUrl/model/key）
        └─ ctx.runtime 为 null → 既有全局逻辑（claude/openai/mock）
```

要点（`services/context.ts` 的 `resolveAgentRuntime`、`llm/gateway.ts`）：

- **配置不全自动回退全局**：`openai` 模式缺 `apiBaseUrl` 或 `apiKey`、`dify` 模式缺 `difyBaseUrl` 或 `difyApiKey` 时，
  `resolveAgentRuntime` 返回 `null`，等同 `inherit`，绝不会因为半配好而崩。
- **失败兜底 mock**：per-agent 调用抛错时，gateway 捕获并降级到本地模板（`mockChat`/`mockDeliverable`），保证可用。
- **绕过结果缓存**：per-agent 路径不进全局内存缓存（端点/会话因人/因智能体而异，缓存会串味）。
- **openai 覆盖仍需真实 key**：`openai` 模式若 key 非真实（占位/空），直接走 mock，不会空打远端。

---

## 四、Dify 接入详解

### 4.1 接口与请求

调 Dify 官方 **chat-messages** 接口（`server/src/llm/providers/dify.ts`），**blocking** 模式贴合现有同步产出流：

```
POST {difyBaseUrl}/chat-messages
Authorization: Bearer {difyApiKey}
Content-Type: application/json

{
  "inputs": { ... },              // 见 4.2，本地上下文按映射注入
  "query": "用户这轮的问题",
  "response_mode": "blocking",
  "conversation_id": "",          // 多轮：见 4.3
  "user": "<userId>"              // 末端用户标识，做多用户隔离
}
```

- `difyBaseUrl` 末尾多余的 `/` 会被裁掉再拼 `/chat-messages`。
- `user` 取值优先级：`userId` → `sessionId` → `agentKey`（保证非空）。
- 响应取 `answer`（去首尾空白）作为回复正文；`conversation_id` 用于多轮续接。
- 非 2xx 抛错 `Dify {status}: {message|code|请求失败}`，由 gateway 兜底 mock。

### 4.2 上下文注入（inputs 占位符映射）★

每个用户的「企业档案 / 长期记忆 / 引用资料 …」各不相同，**无法**预先写死在 Dify 应用里。
所以本地把这些上下文按一张映射表注入 Dify 的 `inputs` 变量：

`difyInputs` 是一个 `{ Dify输入变量名: 模板 }` 对象，**值里可写占位符**，运行时用本轮真实上下文填充
（复用 System 提示词里同一套 `{占位符}` 约定，见 `llm/schema.ts` 的 `fillPlaceholders`）。

示例（键名 = 你在 Dify 应用「对话输入」里声明的变量名）：

```json
{
  "client_profile": "{企业档案}",
  "long_memory": "{长期记忆}",
  "company": "{客户名}"
}
```

可用占位符：

| 占位符 | 内容 |
| --- | --- |
| `{企业档案}` | 行业 / 阶段 / 最关注（无则「暂无企业档案」） |
| `{长期记忆}` | 召回的长期记忆，多条以「；」连接 |
| `{引用资料}` | 用户显式 @ 引用的资料 |
| `{知识库}` | 知识库混合检索自动召回 |
| `{军师档案}` / `{经营底稿}` | 结构化客户理解 |
| `{客户名}` | 公司/品牌名 |
| `{项目背景}` | 当前项目摘要 |
| `{行业基准}` | 行业基准 |
| `{本命色}` | 本命色 |
| `{用户消息}` | 本轮用户原文 |

> ⚠️ Dify 侧必须先**声明同名输入变量**，inputs 才会被应用消费；空 key 会被忽略，空映射 `{}` 即不传任何变量。

### 4.3 多轮对话

Dify 用 `conversation_id` 维持服务端会话状态。首次对话传空串，Dify 返回新的 `conversation_id`，
gateway 通过 `persistDifyConversation` 回写到 `Session.difyConversationId`；之后同一会话自动带上它续接。

### 4.4 产出（deliverable）

绑定 Dify 的智能体若是「产出型」（有 `deliverableKey`），Dify 返回的 markdown 文本会被包装成单段成果：
标题/图标取自产出模板（缺省用智能体名 + `spark` 图标），整段文本落入 `sections[0].b`，前端按 markdown 渲染。

---

## 五、自定义 OpenAI 兼容端点（openai 模式）

适合「同样的提示词/记忆，只是换个模型后端」的场景。填 `apiBaseUrl` / `apiModel` / `apiKey`，
走标准 `/chat/completions`（`providers/openai.ts`），System 提示词、上下文注入、结构化产出（function calling）
都和全局 openai 一致 —— 只是 baseUrl/model/key 被这个智能体覆盖。

---

## 六、后台操作

运营后台 → 智能体 → 进入某个智能体详情 → **「接入方式 / API」** 区块（`admin/src/AgentDetailPanel.tsx`）：

1. 选模式：跟随全局模型 / 自定义模型端点 / Dify 应用。
2. 填对应字段；点 **测试连接** 验证（`POST /admin/agents/:key/test` → `pingAgentRuntime`，会用未保存的改动实测一次）。
3. 保存。

API（`server/src/routes/admin.ts`）：

- `GET /admin/agents/:key` —— 返回 `runtime`，key **脱敏**为 `hasApiKey` / `hasDifyKey`，不回明文。
- `PATCH /admin/agents/:key` —— 接受 `runtime` 更新。**key 留空 = 保留已存的**（避免脱敏回显把真实 key 覆盖成空）；
  传空串才是清空。
- `POST /admin/agents/:key/test` —— 测连接；提交未保存的改动，key 留空则用库里已存的 key。

> 你的例子：模式选 Dify，Base URL `http://ai.aibuzz.cn/v1`，应用 API Key 填该 Dify 应用的 key，
> inputs 映射按 Dify 里声明的变量名填，点测试连接 → 保存即可。

---

## 七、安全

- `apiKey` / `difyApiKey` 目前**明文存库**（与全局 `AiSetting` 一个口径，仅为演示便利）；对外一律脱敏（`has*`）。
- **生产建议**：密钥加密 / 接密管（KMS / Secrets Manager），并对 `/admin/*` 审计（已记 `admin.agent.update`，payload 含 `providerMode`/`runtimeChanged`，不含 key）。

---

## 八、故障排查

| 现象 | 排查 |
| --- | --- |
| 改了 Dify 但仍走全局/模板 | `difyBaseUrl` 或 `difyApiKey` 没配全 → 自动回退 inherit；或 key 失效导致调用抛错 → 兜底 mock。看服务端日志 `[gateway] runtime … fallback to mock`。 |
| Dify 返回内容里没用上企业档案 | `difyInputs` 的**键名**要和 Dify 应用里声明的输入变量**完全一致**；值里的占位符拼写要对。 |
| 多轮对话不连续 | 确认 `Session.difyConversationId` 有回写（`npm run db:push` 是否执行、该字段是否存在）。 |
| 测试连接报 `Dify 401` | 应用 API Key 错误或过期。 |
| 测试连接报 `Dify 404` | Base URL 不对（应以 `/v1` 结尾，代码会自动拼 `/chat-messages`）。 |

---

## 九、相关文件

| 层 | 文件 |
| --- | --- |
| 数据模型 | `server/prisma/schema.prisma`（`Agent` 接入字段、`Session.difyConversationId`） |
| 契约（SSOT） | `shared/contracts.d.ts`（`AgentProviderMode`/`AgentRuntimeView`/`AgentRuntimeUpdate`） |
| Dify 提供方 | `server/src/llm/providers/dify.ts` |
| 占位符填充 | `server/src/llm/schema.ts`（`fillPlaceholders` / `contextValues`） |
| 运行时解析 | `server/src/services/context.ts`（`resolveAgentRuntime`） |
| 路由/兜底 | `server/src/llm/gateway.ts`（`runtimeChat`/`runtimeDeliverable`/`persistDifyConversation`） |
| 运营 API | `server/src/routes/admin.ts`（GET/PATCH/`:key/test`） |
| 运营 UI | `admin/src/AgentDetailPanel.tsx`（「接入方式 / API」区块） |
| 单元测试 | `server/test/dify.test.ts`（纯单元，免 DB） |

---

## 十、测试

Dify 提供方有一套**纯单元测试**（stub `globalThis.fetch`，不连库、不联网），可单独跑：

```bash
cd server && node --import tsx --test test/dify.test.ts
```

覆盖：chat-messages 请求构造（URL/鉴权头/body/inputs 占位符映射）、响应解析（answer/conversation_id/
空值兜底/非 2xx 抛错/user 回退链）、`difyDeliverable` 成果包装、`difyPing` 各分支、`fillPlaceholders`。
集成测试（需 PostgreSQL）见 [TESTING.md](TESTING.md)。
