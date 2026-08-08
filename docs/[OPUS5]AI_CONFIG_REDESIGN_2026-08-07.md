# 大模型接入配置 · 重设计（2026-08-07）

> 目标：把「模型配置」从**一堆平铺字段 + 一个拷贝式单例**，改成**厂商 / 协议方言 / 凭证 / 端点 / 路由 / 用途**六个正交维度的归一化结构；
> 把散在 `if` 里的互斥规则收成一张声明式表；把「测试连接」升级成可配置、可定时、可告警的**检测体系**；
> 并让七牛之外（DeepSeek / 火山方舟 / Anthropic 官方 / OpenAI 官方 / 任意兼容网关）的接入变成**填表**而不是**改代码**。
>
> 状态：**一 / 二 / 三期全部落地，含三期写路径（2026-08-08 收尾）**。后台只写归一化表，旧表已降为只读。
> 仍待运维动作：生产跑迁移脚本 → 看 `/admin/ai-v2-status`（读路径已默认 V2，无需再开开关）→ 观察一个发布周期后删旧列。§8 的五个决策点待拍板。
>
> 修订（2026-08-07 复核）：D1–D7 已第二轮独立对码确认，无一虚报，行号全部对得上。按复核结论修订四处：
> ① 一期 D5 判据从「厂商 caps」改为「协议事实」——一期根本没有 vendor 维度可依据（§7.1-5、§7.4-8）；
> ② 二期给 `AiModel` 加可空 `dialect` 列——否则「猜方言」只是被集中化，根因要拖到三期才消（§7.2-6、§7.4-14）；
> ③ 三期补齐凭证 `vendor` 推断规则——迁移脚本原本写到凭证表第一行就会卡住（§7.3-10）；
> ④ 新增决策点 5——§1.1 盘点了五处配置，目标结构只收编三处，Agent 第三套接入必须有明确去向（§8-5）。
> 另：Json 列强制 zod schema（§4.4）、定时探活用量单独记账可见（§6.3）。

---

## 0. 一句话结论

现在的 `provider: 'mock' | 'claude' | 'openai'` 这个三值枚举，**同时承担了四件互相独立的事**——厂商是谁、走什么线协议、用什么方言写请求、就绪与否。
四件事被压成一个字段之后，代码只能靠**猜**来补回丢掉的信息：

```ts
// server/src/llm/thinking.ts:69 —— 用「baseUrl 空不空」推断这是官方直连还是第三方网关
if (cfg.provider === 'claude' && !cfg.baseUrl?.trim()) return { temperature: cfg.temperature };
// server/src/llm/thinking.ts:41 —— 用模型名里有没有 "claude" 推断支不支持 thinking
return cfg.provider === 'claude' || /claude/i.test(cfg.model);
```

这两行就是「经常出问题 + 分类乱」的根。它们在只有七牛一家、只有一种模型时勉强成立；**多一家厂商就必错一次**（§3 的兼容矩阵给了三个现成反例）。

---

## 1. 现状盘点（已核对代码，不是推测）

### 1.1 配置实际散落在 5 个地方

| # | 载体 | 内容 | 谁能改 | 问题 |
|---|---|---|---|---|
| 1 | `AiSetting`（单例 `default`） | provider/label/baseUrl/model/apiKey/temperature/thinking\*、embedding\*、rerank\*、routingMode/stickyRouting、activeModelId | 后台 | **是 `AiModel` 某一行的拷贝**，双真相源 |
| 2 | `AiModel`（列表） | 同上对话字段 + preset + 三档单价 + 池参数 | 后台 | 每行各存一份 apiKey（同一把 key 复制 N 份） |
| 3 | `Agent` / `AgentVersion` | `providerMode=inherit\|openai\|dify` + apiBaseUrl/apiModel/apiKey/apiTemperature + dify\* | 后台 | 第三套接入模型，与 1/2 无共享校验、无池、无探活 |
| 4 | 环境变量 | `AI_PROVIDER` `OPENAI_*` `ANTHROPIC_*` `CLAUDE_MODEL` `EMBEDDING_*` `RERANK_*` **`AI_AUX_*`** `LLM_MAX_CONCURRENCY` `LLM_POOL_MAX_ATTEMPTS` `STREAM_*_IDLE_MS` | SSH+重启 | 辅助档（aux）是**唯一只能用 env 配的模型**，运营在后台看不见 |
| 5 | `FeatureFlag`（告警阈值） | 模型错误率/P95/成本红线 | 后台 | 与模型配置分属两屏，改端点时不会提示同步阈值 |

### 1.2 已确认的缺陷（逐条可复现）

**D1 · 「测试连接」在 `routingMode=pool` 下测的不是你正在编辑的端点。** 已实测。
`pingModel` → `claudeRaw/openaiRaw` → `withEndpoint` → `resolveCandidates`。传进去的表单配置**没有 `poolBypass`**，于是被 `llmPool.toCfg()` 整体改写：

```
输入（表单正在编辑）: baseUrl=https://being-edited/v1  model=model-being-edited  apiKey=sk-being-edited  temperature=0.3  thinking=enabled/4096
实际发出的第一候选  : baseUrl=https://pool-a/v1        model=pool-model-a        apiKey=sk-pool-a        temperature=0.9  thinking=disabled/1024
```

后果：① 刚粘错的 key/URL 照样显示「连通 ✓」；② 想验证某个端点是否恢复，测到的却是另一个；③ 因为探活没有 `affinityKey`，HRW 的 key 恒为 `'anon'`，**永远命中同一个池成员**，多测几次也发现不了。

> **现网影响更正（2026-08-08）**：登生产核对后发现，`ai_setting.routingMode` 确实是 `pool`，但**五个 `ai_model` 没有一个 `poolEnabled=true`**。`resolveCandidates` 在成员为空时直接回落单端点，所以**这个缺陷当前并没有在误导任何人**——它是潜伏的，任何人点一次「入池」就立刻生效。此前把它描述成「现在就在骗运营」是错的，紧迫性应按「潜伏但必炸」而不是「正在发生」来排。顺带一提：生产开着 pool 却零成员，等于端点池从未真正启用过，这本身也值得运营确认是不是本意。

**D2 · `POST /admin/ai-models` 静默丢弃池参数。** `routes/admin.ts:308` 会为 `poolEnabled` 做协议校验并可能返回 409，但 `aiConfig.addModel()` 的 `data` 里根本没有 `poolEnabled/weight/tier/maxConcurrency` 四个字段——校验通过后写库时被丢掉。API 契约（`AiModelUpsert`）声明支持，实际只有 `PATCH` 生效。

**D3 · `AiSetting` 是拷贝，直接编辑会被静默还原。** `syncActiveSetting()` 把 `AiModel` 的 8 个字段拷进 `AiSetting`。运营若走 `PUT /admin/ai-config` 改了 baseUrl/温度，下一次点「切换」到同一个模型就会被原值覆盖，且无任何提示。同理，端点池的协议校验读的是 `AiSetting.provider`（拷贝值）而不是池自身的一致性。

**D4 · 缓存写单价这一档在库里不存在。** `data/modelPrices.ts` 的 `ModelRate.cacheWrite` 有读取逻辑，注释写着「运营需显式填 `rate.cacheWrite`」——但 `AiModel` 没有这一列、后台没有这个输入框、`buildConfiguredRateMap()` 也不会产出这一档。实际永远走硬编码的 `CACHE_WRITE_MULTIPLIER = 1.25`，而这个 1.25 的前提（上游透传 Anthropic 缓存计价）**至今未向七牛确认**。

**D5 · 嵌入 / 重排的「留空＝复用对话模型」在当前生产是必错的默认值。** 两处回退都是 `cfg.xxxBaseUrl || cfg.baseUrl` + `cfg.xxxApiKey || cfg.apiKey`，而请求路径是 OpenAI 风格的 `${baseUrl}/embeddings`、`${baseUrl}/rerank`。当对话端点是 **Anthropic 协议**（生产正是如此）时，`baseUrl` 是 Anthropic 协议根，拼出来的路径**协议上就不存在**。更根本的是：[七牛官方 FAQ](https://developer.qiniu.com/aitokenapi/12897/how-to-use-ai-token-api) 明确「暂未提供文本向量/Embedding 模型」——**这个回退在七牛下无论如何都不可能成功**，而后台文案还在引导运营留空。

**D6 · 探活是手动的、单一的、不落库的。** 只有一个最小补全（`'ping'`，`max_tokens=700`）。不验证：thinking 写法是否被接受、工具调用是否可用、流式是否出 delta、`max_tokens` 上界、key 的模型范围、嵌入维度。没有定时探活、没有历史、没有指标、没有告警。**能力是靠猜的（正则匹配模型名），验证是靠人的（记得点按钮）。**

**D7 · 生产在用的厂商不在预设表里。** `AI_PRESETS` 有 Agnes/DeepSeek/Qwen/Moonshot/GLM/豆包/硅基/MiniMax/百川/OpenAI/Claude/mock 共 12 项，**没有七牛**。默认值（`AiSetting.baseUrl` 默认 `https://apihub.agnes-ai.com/v1`、默认 label「Agnes 2.0 Flash」）指向一个已不在用的厂商。运营接七牛只能手打 bypass 路径。

---

## 2. 互斥关系全清单

「模型接入的配置有没有互斥的情况」——有，而且现在**一条都没有被声明**，全部散在 6 个文件的 `if` 里。完整清单如下，重设计后它们全部收进 §5 的一张表。

### A. 协议 / 方言层（硬约束，违反即 4xx）

| 编号 | 规则 | 依据 | 现在落在哪 |
|---|---|---|---|
| A1 | `thinking` 只在 Anthropic 协议是标准字段；OpenAI 协议下是**网关私有扩展** | 七牛支持，OpenAI 官方不认 | `thinking.ts:57` |
| A2 | 关闭 thinking：**Anthropic 官方＝整体省略**；**七牛网关＝显式 `{type:'disabled'}`** | 网关默认可能开思考 | `thinking.ts:69`（用 baseUrl 空不空猜） |
| A3 | `thinking.disabled` **不得携带 `budget_tokens`** | 七牛带 `budget_tokens:0` 返回 400 | `thinking.ts:71` |
| A4 | `budget_tokens` 最小 1024、且 ≤ `max_tokens` | [七牛 Claude 兼容文档](https://developer.qiniu.com/aitokenapi/13000/claude-inference-api) | `thinking.ts:28`（另夹到 ≤7000） |
| A5 | `max_tokens` 是 **thinking + 正文的总闸**，正文预算必须是净额 | Anthropic 协议 | `thinking.ts:93` |
| A6 | thinking 开启 → `temperature` 强制 `1` | Anthropic 硬约束 | `thinking.ts:36` |
| A7 | thinking 开启 → `tool_choice` 只能 `auto/none` 且须跨轮保留 thinking block | Anthropic 硬约束 | 成果/工具路径强制关思考 |
| A8 | 仅 `GET /v1/models`，其余接口皆 POST | 七牛 FAQ | 无（未接入） |

### B. 厂商能力层（现在完全没有建模）

| 编号 | 规则 | 依据 |
|---|---|---|
| B1 | **七牛不提供 embedding** → 嵌入必须指向另一家；「留空复用对话模型」在七牛下非法 | 七牛 FAQ |
| B2 | 部分模型不支持 thinking；`grok-4-fast` **不支持关闭推理**，只能靠提示词引导 | 七牛 FAQ / Claude 兼容文档 |
| B3 | **API Key 有模型范围（model groups）**——key × model 是有效性组合，不是两个独立字段。范围外报 `model not available in your assigned model groups` | 七牛 FAQ |
| B4 | RPM/TPM/TPD 三种限额，且「随资源调度动态优化，不固定」→ 429 不能靠静态配额推算，只能撞了才知道 | 七牛 FAQ |
| B5 | DeepSeek 的 Anthropic 兼容端点**接受 `thinking` 但忽略 `budget_tokens`**；不支持 `anthropic-beta` / `top_k` / 图片与文档内容块 | [DeepSeek 文档](https://api-docs.deepseek.com/guides/anthropic_api/) |
| B6 | 同一厂商的两种协议是**两个不同的 baseUrl**，不是同一个（见 §3） | 各厂商文档 |

### C. 路由 / 池层

| 编号 | 规则 | 现状 |
|---|---|---|
| C1 | 池内端点必须同协议（Anthropic messages 不能发给 chat/completions） | 有，但判据是 `AiSetting.provider` 这个**拷贝值** |
| C2 | `mock` 不能入池 | 有 |
| C3 | 辅助档（`AI_AUX_*`）与主池互斥（`poolBypass`） | 有 |
| C4 | 同名 model 的三档单价必须完全一致，否则整组退回「未校准」 | 有（`buildConfiguredRateMap`） |
| C5 | 跨 tier 降级会改变回答质量 → 默认全 tier 0 | 有（仅文档约定） |
| C6 | **探活必须绕过池**（否则测的不是被测端点） | ❌ **没有** → D1 |

### D. 用途层（现在不存在这一层）

| 编号 | 规则 | 现状 |
|---|---|---|
| D1' | 结构化成果 / 多轮工具调用必须关 thinking（与 A7 互斥） | 硬编码在调用点 |
| D2' | 辅助抽取应走小模型、独立车道、短超时、低温度 | 只能用 env 配 |
| D3' | 对话 150s 下限 / 成果 300s / 辅助 20s —— 三种用途三种超时口径 | 常量，不可运营调 |
| D4' | 嵌入与既有语料**必须同源同维**，换嵌入模型要重嵌历史数据 | 仅文档约定，无闸门 |

---

## 3. 兼容矩阵：为什么三值枚举不够

同一个厂商同时提供两种协议，**且 baseUrl 不同**；同一个协议在不同厂商下**方言不同**。当前 `provider` 字段两个维度都表达不了。

| 厂商 | OpenAI 协议 baseUrl | Anthropic 协议 baseUrl | thinking 关闭写法 | `budget_tokens` | Embedding |
|---|---|---|---|---|---|
| **七牛** | `https://api.qnaigc.com/v1` | `https://api.qnaigc.com`（生产另用 `/bypass/anthropic`，**待与七牛核对哪个是权威路径**） | 显式 `{type:'disabled'}` | 生效；`disabled` 时**不得携带** | ❌ 无 |
| **DeepSeek** | `https://api.deepseek.com/v1` | `https://api.deepseek.com/anthropic` | — | **被忽略** | 有（另算） |
| **火山方舟** | `https://ark.cn-beijing.volces.com/api/v3`（标准 Chat API） | `https://ark.cn-beijing.volces.com/api/coding`（**Coding Plan 形态**，标准 Chat API 是否另有 Anthropic 入口未查到官方原文，接入前须直测） | — | — | 有 |
| **Anthropic 官方** | — | `https://api.anthropic.com` | **整体省略 thinking** | 生效 | ❌ 无 |
| **OpenAI 官方** | `https://api.openai.com/v1` | — | 无该字段 | — | 有 |

读法：**「协议」决定请求长什么样，「方言」决定同一协议下的细节写法，「厂商」决定有没有这个能力。** 三者正交，必须是三个字段。

---

## 4. 目标数据结构（归一化）

### 4.1 六个维度

```
厂商 Vendor ──┐                         静态代码表（接入形状，不含价格）
协议 Protocol ┼─→ 方言 Dialect ──┐      静态代码表（请求组装规则）
              │                  │
凭证 Credential ──────────────────┼─→ 端点 Endpoint ─→ 路由成员 RouteMember ─→ 路由 Route ─→ 用途 Purpose
模型 Model ───────────────────────┘        （入库）           （入库）            （入库）      （枚举）
```

- **Vendor / Dialect 是代码常量，不入库**——它们是「事实」，不是「运营数据」（与既有「定价归运营、接入形状归代码」的分工一致，见 `AGENTS.md` 定价条）。
- **Credential / Endpoint / Route 入库**——它们是运营资产。
- **Purpose 是枚举**：`chat | deliverable | aux | embedding | rerank | moderation`。

### 4.2 静态：方言表（新增 `server/src/llm/dialects.ts`）

把今天靠 `if` 猜的东西写成数据。**新接一家厂商 = 加一行，不改 provider 分支。**

```ts
export type WireProtocol = 'anthropic' | 'openai_chat' | 'dify' | 'mock';

export interface Dialect {
  id: string;                    // 'anthropic_official' | 'anthropic_gateway' | 'openai_chat' | ...
  protocol: WireProtocol;
  /** 关闭 thinking 的写法。omit=省略整个字段（Anthropic 官方）；explicit=发 {type:'disabled'}（七牛网关） */
  thinkingOff: 'omit' | 'explicit' | 'unsupported';
  /** disabled 时能否携带 budget_tokens。七牛=false（带了 400） */
  disabledAcceptsBudget: boolean;
  /** budget_tokens 是否真的被采纳。DeepSeek anthropic=false（接受但忽略） */
  budgetHonored: boolean;
  /** OpenAI 协议下是否支持非标 thinking 扩展。七牛=true；OpenAI 官方=false */
  openaiThinkingExtension: boolean;
  /** GET /models 是否可用（用于模型范围自省） */
  listModels: boolean;
  /** 嵌入 / 重排是否与对话同源（同 baseUrl + 同 key） */
  auxEndpointsSameOrigin: boolean;
}
```

`thinkingRequestTuning()` 从「三个 if 猜方言」改为「读方言表的四个字段」，行为完全可枚举、可测试。

### 4.3 静态：厂商预设表（重写 `AI_PRESETS`）

```ts
export interface VendorPreset {
  id: string;                  // 'qiniu' | 'deepseek' | 'volcengine' | 'anthropic' | 'openai' | 'custom'
  label: string;
  /** 一个厂商可有多个协议入口 */
  entries: { dialect: string; baseUrl: string; note?: string }[];
  /** 厂商级能力声明（端点级可覆盖） */
  caps: { embedding: boolean; rerank: boolean; thinking: boolean; tools: boolean; vision: boolean };
  /** key 是否有模型范围限制（七牛 model groups）→ 决定要不要跑 model_scope 检测 */
  keyScoped: boolean;
  modelHint?: string;          // 如火山：「model 填接入点 ID ep-xxx」
  docUrl?: string;
}
```

**必须补进去的第一条就是七牛**（D7）。预设表**不含单价**——单价是运营数据，只能在后台填（沿用既有约定）。

### 4.4 入库：四张表

```prisma
/// 凭证：一把上游 API Key。key 是「账号级」资产，不是「模型级」——同一把 key 可喂多个端点。
model AiCredential {
  id             String    @id @default(cuid())
  label          String                        // 「七牛-主账号」
  vendor         String                        // VendorPreset.id
  apiKey         String    @db.Text            // 明文（沿用 2026-08-05 明文化决定）
  /// 上游允许的模型范围（七牛 model groups）。由检测经 GET /v1/models 回填，运营不手填。
  modelScope     Json?
  scopeCheckedAt DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  endpoints      AiEndpoint[]
  @@map("ai_credential")
}

/// 端点：一次可用外呼的最小单位 = 凭证 × 方言 × baseUrl × 模型 × 请求参数。
/// 路由、并发车道、429 冷却、计价、探活——全部以它为单位。
model AiEndpoint {
  id             String  @id @default(cuid())
  label          String
  credentialId   String
  dialect        String                        // Dialect.id
  baseUrl        String                        // 允许覆盖预设（自建网关）
  model          String

  temperature    Float   @default(0.7)
  thinkingMode   String  @default("disabled")  // disabled | enabled | adaptive
  thinkingBudget Int     @default(1024)

  /// 能力三态覆盖：{ thinking:'yes'|'no'|'unknown', tools, streaming, vision, maxOutputTokens }
  /// 来源优先级：运营显式覆盖 > 探测回填 > 厂商预设声明
  capsJson       Json?

  // 单价（元 / 1M token）。四档齐全——补上今天缺的缓存写档（D4）。
  priceInput       Float @default(0)
  priceOutput      Float @default(0)
  priceCachedInput Float @default(0)
  priceCacheWrite  Float @default(0)   // 0 = 按 priceInput × CACHE_WRITE_MULTIPLIER

  // 探活结果（只读，检测写入）
  lastProbeAt     DateTime?
  lastProbeOk     Boolean?
  lastProbeJson   Json?

  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  credential     AiCredential @relation(fields: [credentialId], references: [id])
  members        AiRouteMember[]
  @@map("ai_endpoint")
}

/// 路由：某个「用途」怎么用一组端点。取代 activeModelId + routingMode + stickyRouting 这套单例字段。
model AiRoute {
  id      String  @id @default(cuid())
  purpose String  @unique   // chat | deliverable | aux | embedding | rerank | moderation
  mode    String  @default("single")  // single | pool
  sticky  Boolean @default(true)
  /// 用途级请求预算（今天是硬编码常量）：超时、正文 max_tokens、辅助档短超时…
  budgetJson Json?
  members AiRouteMember[]
  @@map("ai_route")
}

model AiRouteMember {
  routeId        String
  endpointId     String
  enabled        Boolean @default(true)
  primary        Boolean @default(false)  // single 模式下的唯一生效端点
  weight         Int     @default(1)
  tier           Int     @default(0)
  maxConcurrency Int     @default(0)      // 每实例上限（口径不变）
  route          AiRoute    @relation(fields: [routeId], references: [id], onDelete: Cascade)
  endpoint       AiEndpoint @relation(fields: [endpointId], references: [id], onDelete: Cascade)
  @@id([routeId, endpointId])
  @@map("ai_route_member")
}
```

> **Json 列不许裸奔**：`capsJson` / `budgetJson` / `modelScope` / `lastProbeJson` 四个 Json 列各配 zod schema（集中在 `llm/configSchemas.ts`），读取时解析失败一律按「未配置」处理并出 `warn`。本方案主张的就是声明式可校验——这四列若无 schema，声明式在自己家里先瓦解。

### 4.5 这样归一化解决了什么

| 老问题 | 新结构下 |
|---|---|
| `AiSetting` 是 `AiModel` 的拷贝（D3） | **没有拷贝**。「生效」＝ `AiRouteMember.primary`，一个指针，改不出漂移 |
| 同一把 key 复制 N 份，换 key 要改 N 行 | key 提到 `AiCredential`，端点引用它 |
| `provider` 一个字段扛四件事 | 拆成 `vendor`（凭证上）+ `dialect`（端点上）+ 能力表 |
| thinking 支持与否靠 `/claude/i` 正则猜 | `capsJson.thinking`，探测回填 + 可覆盖 |
| 辅助档只能 env 配、后台看不见（4-#4） | 就是 `purpose='aux'` 的一条路由，与主路由同一套 UI / 探活 / 池 |
| 嵌入 / 重排是 `AiSetting` 上的散字段、回退到 Anthropic 根（D5） | 同样是路由（`purpose='embedding'`），**没有「留空复用」这个选项**——协议不同就是不同端点 |
| 缺缓存写单价（D4） | `priceCacheWrite` 补齐四档 |
| 对话 / 成果 / 辅助共用一套超时与预算 | `AiRoute.budgetJson` 按用途分开 |
| `Agent`/`AgentVersion` 第三套接入（§1.1-#3） | **本方案未收编**——`AiRoute.purpose` 全局唯一，表达不了 per-agent 路由。去向见决策点 5；最低限度先共享校验器与探活（§7.2-8） |
| `FeatureFlag` 告警阈值（§1.1-#5） | 部分收编：探活告警并入 §6.3；错误率/成本红线仍留 `FeatureFlag`，属已知残债 |

---

## 5. 互斥校验：单一收口

§2 的全部规则实现为**一个纯函数**，保存端点、加入路由、探活前、组装请求前**共用同一份判断**（今天这四处各写各的，所以后台能存下运行时会 400 的组合）。

```ts
export type IssueLevel = 'error' | 'warn' | 'info';
export interface ConfigIssue { level: IssueLevel; code: string; field?: string; message: string; }

/** 端点自身的自洽性（A1–A8、B1–B6） */
export function validateEndpoint(ep: EndpointDraft, dialect: Dialect, vendor: VendorPreset): ConfigIssue[];
/** 路由 + 成员的一致性（C1–C6、D1'–D4'） */
export function validateRoute(route: RouteDraft, members: MemberDraft[], endpoints: AiEndpoint[]): ConfigIssue[];
```

规则示例（全部来自 §2，一一对应）：

| code | level | 触发条件 |
|---|---|---|
| `THINKING_UNSUPPORTED_DIALECT` | error | `thinkingMode!=='disabled'` 且 `dialect.thinkingOff==='unsupported'`（如 OpenAI 官方） |
| `THINKING_BUDGET_IGNORED` | **warn** | `mode==='enabled'` 且 `dialect.budgetHonored===false`（DeepSeek anthropic：能存，但要告诉运营预算不生效） |
| `THINKING_CAP_NO` | error | `caps.thinking==='no'`（探测已证明该模型不支持） |
| `BUDGET_EXCEEDS_MAX_TOKENS` | error | `thinkingBudget + 正文预算 > caps.maxOutputTokens` |
| `EMBEDDING_VENDOR_UNSUPPORTED` | error | `purpose==='embedding'` 的端点厂商 `caps.embedding===false`（**七牛**） |
| `AUX_ORIGIN_MISMATCH` | error | 嵌入/重排端点的方言 `protocol!=='openai_chat'`（`/embeddings` 只有 OpenAI 风格） |
| `POOL_PROTOCOL_MISMATCH` | error | 同一路由内成员 `dialect.protocol` 不一致（C1，判据改为**成员自身**而非单例拷贝） |
| `POOL_HAS_MOCK` | error | 池内含 mock 端点（C2） |
| `MODEL_OUT_OF_KEY_SCOPE` | **warn** | `vendor.keyScoped` 且 `model ∉ credential.modelScope`（B3，未探测过则不报） |
| `PRICE_INCONSISTENT` | warn | 同 model 名的多个端点单价不一致（C4，维持既有确定性回退） |
| `PRICE_MISSING` | warn | `priceInput/priceOutput` 未同时配置 → 成本记 0、算力按裸 token |
| `EMBEDDING_DIM_DRIFT` | error | 换嵌入模型但未重嵌历史语料（D4'，新增闸门） |

后台表现：`error` 直接拒绝保存并定位到字段；`warn` 可保存但在列表行常驻黄标（今天这类问题只有一次 `console.error`，运营永远看不到）。

---

## 6. 检测（探活）重设计

### 6.1 硬约束（先修 D1）

1. **探活必须 `poolBypass: true`。** 探活的语义是「测这一个端点」，任何路由改写都是错的。
2. **探活必须用被测端点自己的方言与参数组装**，与真实请求同一条代码路径（不是另写一份 mini 请求）。
3. **探活不占主车道。** 走独立 lane，避免手动点按钮把用户请求挤掉。

### 6.2 检测项（可勾选、可定时、独立记录）

| 项 | 验证什么 | 怎么测 | 默认 |
|---|---|---|---|
| `connectivity` | 网络 / 鉴权 / 模型名可达 | 最小补全（今天唯一有的） | 手动 + 10 min 定时 |
| `model_scope` | key 的模型范围是否含该 model（B3） | `GET {base}/v1/models`（方言声明 `listModels` 时） | 保存端点时 + 24 h |
| `thinking` | **方言写法是否被上游接受**（A2/A3 —— 2026-07-27 那次 400 正是这项） | 按当前 `thinkingMode` 真发一次 | 手动 + 1 h |
| `tools` | 函数调用可用（成果链路依赖） | 发一次强制 `tool_choice` 的小请求 | 手动 + 1 h |
| `streaming` | 建流并收到首个 delta | 建流 → 首 delta → 立即 abort | 手动 + 1 h |
| `long_output` | `max_tokens` 上界与实际出字速度 | 请求 N token 并测 token/s（校准 §`CHAT_TIMEOUT_MS`） | 手动 |
| `embedding` | 维度与既有语料是否同维（D4'） | 一次 `/embeddings`，比对 `EMBED_DIM` | 开启时 + 保存时 |
| `rerank` | `/rerank` 契约 | 一次两文档重排 | 开启时 |

### 6.3 结果与告警

- 结果落 `AiEndpoint.lastProbe*` + 一张按天保留的 `AiProbeResult`（趋势用）。
- 出指标 `junshi_ai_endpoint_probe_ok{endpoint,kind}` / `..._latency_seconds`，接入既有 Alertmanager → 飞书卡片（`services/alertCard.ts` 已有的那套）。
- **探测结果回填 `capsJson`**：`thinking` 项失败 → `caps.thinking='no'` → §5 的 `THINKING_CAP_NO` 立刻开始拦截，形成闭环。这就是「能力靠猜」变成「能力靠测」的关键一步。
- **探活是真实计费请求，用量必须可见**：按默认周期，每端点每天约 144 次 `connectivity`（10 min）+ 各 24 次功能项（1 h），token 量极小但不为零。探活用量按 `purpose='probe'` 单独记账、后台可见、可一键全停——不可见的定时消耗迟早变成下一桩成本悬案。

---

## 7. 迁移路径（三期，全程可回滚）

**要求**：`AiSetting`/`AiModel` 上有生产数据、`llmPool`/`llmGate`/计价/trace 全部依赖它们，因此不做一次性替换。

### 7.1 一期 · 纯加法 + 修已确认缺陷（不改数据结构语义，可立即上）— ✅ 已落地 2026-08-07
1. 修 **D1**：`mergedTestConfig()` 产出的配置带 `poolBypass: true`；补回归锁死「pool 开启时探活仍打表单端点」。
2. 修 **D2**：`addModel()` 补写四个池字段。
3. 补 **D4**：`AiModel` 加 `priceCacheWrite Float @default(0)`（纯加法列）+ 后台输入框 + `buildConfiguredRateMap` 产出该档。
4. 补 **D7**：`AI_PRESETS` 加七牛（两个协议入口）、火山补 Anthropic 入口、DeepSeek 补 Anthropic 入口；默认值从 Agnes 改为空/mock。
5. 修 **D5** 的引导。一期还没有 vendor/caps 维度，判据改用**协议事实**：对话端点 `provider==='claude'` 时，「留空复用」拼出的 `${baseUrl}/embeddings`、`${baseUrl}/rerank` 在协议上必然不存在——直接禁用留空、要求显式填写，与厂商是谁无关。
   **禁用条件是「协议不符 OR 厂商无该能力」两条，不是一条**：`provider==='openai'` + 七牛（`api.qnaigc.com/v1`）这个组合协议上完全合法、拼得出 `/embeddings`，但七牛没有嵌入模型，照样必败。故 baseUrl 域名命中 `qnaigc.com` 时**同样禁用留空**（而不只是叠加文案），文案为「七牛不提供 Embedding，请指向其它厂商或保持本地兜底」。域名清单是一期的临时兜底，二期由 `VendorPreset.caps.embedding` 取代。
   动手前先做决策点 3 的现状确认：若生产 `embeddingEnabled` 从未开启，D5 是陷阱而非现役故障，本条只加闸门与文案、不改任何现行行为。

> 一期不动表结构语义，`db push` 只加一列，风险等同于既有的加法迁移。

### 7.2 二期 · 引入方言表与校验器（加法列 + 代码重构，数据语义不动）— ✅ 已落地 2026-08-07
6. `AiModel` 加**可空 `dialect` 列**（纯加法，风险等同一期的价格列）。新增/编辑端点时由预设带出、可改、显式落库；存量行留空。**没有这一列，「猜方言」只是从三处 `if` 集中成一处推断，根因要拖到三期才消**——加了它，二期就把根因消掉。
7. 新增 `llm/dialects.ts` + `VendorPreset` 重写；`thinkingRequestTuning()` 改为「读端点 `dialect`，空值走唯一的 `inferDialect(provider, baseUrl, model)` 兜底」。推断只允许存在于这一个函数，可枚举、可测试；后台在端点行展示推断结果，运营确认一次即固化为显式值。行为对既有两条生产链路**逐位不变**（用现有 `claudeBaseUrl.test.ts` / thinking 回归锁住）。
8. 新增 `validateEndpoint/validateRoute`，在保存、入池、探活三处接上；后台展示 error/warn。`pingAgentRuntime`（Agent 自带接入的探活）同样过 `validateEndpoint`——这是决策点 5 里成本最低的半步，先做掉。
9. 检测体系落地（§6），先只做 `connectivity + thinking + model_scope` 三项 + 定时 + 指标。

### 7.3 三期 · 表结构归一化（需要迁移窗口）— ✅ 代码与写路径已于 2026-08-08 收尾，生产迁移待运维
10. 建 `ai_credential` / `ai_endpoint` / `ai_route` / `ai_route_member`，从 `ai_model` + `ai_setting` 做**一次性幂等迁移**：按 `(apiKey)` 去重生成凭证，每行 `AiModel` 生成一个端点，`activeModelId` → `purpose='chat'` 路由的 `primary` 成员，`routingMode/stickyRouting` → 该路由的 `mode/sticky`，`embedding*/rerank*` → 两条独立路由，`AI_AUX_*` → `purpose='aux'` 路由（env 保留一个版本作兜底）。
    凭证 `vendor` 推断规则（迁移脚本动手前必须定死，否则写到凭证表第一行就卡住）：① 端点行 `dialect`/`preset` 非空 → 直接映射预设 id；② 否则按 baseUrl 域名匹配 `VendorPreset.entries`（如 `qnaigc.com` → `qiniu`）；③ 仍无法判定 → `vendor='custom'` 并标黄待运营确认。
    **③ 的「标黄」在迁移期不得升级为阻断**：双写迁移必须把 `activeModelId` 指向的端点填进 `purpose='chat'` 路由，若该端点的凭证恰好落到 `custom`（存量 Agnes 行就有这个风险）而阻断生效，chat 路由会被迁成空的、直接把线上 AI 关掉。故：**迁移写入一律放行、只标黄；「未确认 vendor 的凭证不得加入路由」这条闸门只对迁移完成之后的新增/改动生效**。
11. 读路径默认切到新表（`getAiConfig` 改为 `resolveRoute(purpose)`），`AiSetting` / `AiModel` 降级为只读历史快照；用途没有可用路由时保留静默回落，显式 `AI_CONFIG_V2=false` 只作短时逃生。
12. 后台写路径直接操作四张新表：`primary` 是指针、凭证可复用、六用途路由与预算可编辑；删除旧 CRUD/投影/旧 admin 路由。迁移期 `needsReview` 可保留现有路由，但迁移后的新增/改路由必须先确认 vendor。
13. 观察一个发布周期后删除旧列。

---

### 7.4 文件级落地清单

**一期**（纯加法 + 修已确认缺陷）— ✅ 全部落地，`npm test` 1306/1306，admin `modelGateway.test.ts` 10/10

实际落地时相对本清单的两处调整：**① 第 2 条不是就地加一个字段**，而是把 `/admin/ai-config/test` 的整块合并逻辑提进 `aiConfig.mergedConfigTest()`——两个入口各写一份合并、只在其中一份加 `poolBypass` 迟早再分叉，收成同源纯函数顺带让它可回归。**② 第 3 条附带补了 `addModel` 后的 `__resetLlmPool()`**，与 `updateModel` 同口径；否则新建的池端点要等配置缓存的 5s TTL 才生效。

| # | 文件 | 改什么 | 回归 |
|---|---|---|---|
| 1 | `server/src/services/aiConfig.ts` `mergedTestConfig()` | 返回值加 `poolBypass: true` | 新增：pool 开启时 `resolveCandidates(探活配置)` 必须原样返回表单端点（见附录 A 的探针改成断言） |
| 2 | `server/src/routes/admin.ts` `/admin/ai-config/test` | 合并出的 `merged` 同样带 `poolBypass: true` | 同上 |
| 3 | `server/src/services/aiConfig.ts` `addModel()` | `data` 补 `poolEnabled/weight/tier/maxConcurrency`，与 `updateModel()` 同一套 clamp（`weight≥1`、`tier≥0`、`maxConcurrency≥0`） | POST 带池参数后 `listModels()` 应读回同值 |
| 4 | `server/prisma/schema.prisma` `AiModel` | 加 `priceCacheWrite Float @default(0)`（纯加法列，`db push` 安全） | — |
| 5 | `server/src/services/aiConfig.ts` `buildConfiguredRateMap()` + `RateRow` | 产出第四档 `cacheWrite`（0＝按 `in × CACHE_WRITE_MULTIPLIER`）；一致性校验把该档一并纳入 | 扩 `test/modelPrices.test.ts`：显式填 1h TTL 单价的用例改为走真实链路而非手造 rate |
| 6 | `shared/contracts.d.ts` + `admin/src/views/model.tsx` | `AiModel`/`AiModelUpsert` 加 `priceCacheWrite`；单价区加第四个输入框 | `admin` `tsc -b` + `lint:ui` |
| 7 | `server/src/services/aiConfig.ts` `AI_PRESETS` | 新增七牛（OpenAI `…/v1` + Anthropic 两个入口）；DeepSeek/火山补 Anthropic 入口；`AiSetting` 的 Agnes 默认值改为空 | — |
| 8 | `admin/src/views/model.tsx` 检索增强区 | 对话端点为 Anthropic 协议（`provider==='claude'`）时禁用「留空＝复用对话模型」（拼出的 `/embeddings` 协议上不存在，与厂商无关）；baseUrl 域名为 `qnaigc.com` 时叠加文案「七牛不提供嵌入，必须单独填网关与 Key」 | — |

> 第 1、2 条是同一个缺陷的两个入口，**必须一起改**——否则「模型表单探活」修好了、「全局配置探活」还是被劫持。

**二期**（方言表 + 校验器 + 检测体系）— ✅ 全部落地

落地时相对清单的补充：**① 关闭思考的写法是四种不是三种**——除「省略 / 显式 / 不支持」外，还有 OpenAI 协议独有的 `explicit_when_configured`（运营没开过就完全省略，开过则说明网关认这个扩展、工具与成果请求必须显式按下去）。漏掉这一档会破坏强制 `emit_deliverable` 的收口，`test/dialects.test.ts` 有专门一例钉住。**② 等价性用全矩阵 oracle 验，不是逐条断言**：把历史逻辑原样抄进测试当参照，315 组组合逐位比对，刻意差异登记进 `KNOWN_DELTAS` 并论证不可能命中存量配置。**③ 新增 `llm/vendors.ts`**——厂商能力（有没有嵌入）与方言（怎么写请求）是两个正交维度，合并会漏掉「七牛 OpenAI 入口协议合法但没有嵌入模型」这一类。

| # | 文件 | 改什么 |
|---|---|---|
| 9 | 新增 `server/src/llm/dialects.ts` | `WireProtocol` / `Dialect` / 方言表（§4.2）+ **唯一的 `inferDialect(provider, baseUrl, model)` 兜底**（存量行 `dialect` 为空时用；推断逻辑只允许存在于这一个函数） |
| 10 | `server/src/llm/thinking.ts` | `supportsThinkingConfig()` 与 `thinkingRequestTuning()` 改读端点 `dialect`（空值走 `inferDialect`）+ `capsJson`，删掉「baseUrl 空不空」和 `/claude/i` 两处散落推断 |
| 11 | 新增 `server/src/llm/validate.ts` | `validateEndpoint` / `validateRoute`（§5 的表逐条实现） |
| 12 | `server/src/routes/admin.ts` | 保存端点、入池、切换激活、保存路由四处改调 `validate*`，替换现有三段各写各的 409 分支；`pingAgentRuntime` 前也过 `validateEndpoint`（决策点 5 的 B 项） |
| 13 | 新增 `server/src/services/aiProbe.ts` | 8 项检测（§6.2），统一走 `poolBypass` + 独立车道 |
| 14 | `server/prisma/schema.prisma` | `AiModel` 加 **`dialect String?`**、`capsJson Json?` / `lastProbeAt` / `lastProbeOk` / `lastProbeJson`（仍为纯加法） |
| 15 | `admin/src/views/model.tsx` | 端点行展示方言：显式值直接显示；推断值标灰 + 「确认固化」一键写回 `dialect` 列 |
| 16 | `server/src/services/{scheduler,metrics}.ts` | 定时探活 + `junshi_ai_endpoint_probe_*` 指标；探活用量按 `purpose='probe'` 单独记账（§6.3） |
| 17 | `deploy/monitoring/` + `services/alertCard.ts` | 探活失败接入既有飞书告警卡片 |

**三期**（四表归一化）— ✅ 代码与写路径已落地，生产迁移待运维

| # | 文件 | 改什么 |
|---|---|---|
| 18 | `server/prisma/schema.prisma` | 新增 `ai_credential` / `ai_endpoint` / `ai_route` / `ai_route_member` 四表（纯新增，旧表一字未动） |
| 19 | 新增 `server/scripts/migrateAiConfig.ts` | 幂等迁移（`legacyModelId` 唯一键 + 凭证按 apiKey 去重）；`npm run ai:migrate` 预演 / `ai:migrate:apply` 写入 |
| 20 | 新增 `server/src/services/aiRoutes.ts` | `resolveRoute(purpose)` + `routeToConfig` + `v2Status`；`AI_CONFIG_V2` 开关与**回落**逻辑 |
| 21 | `server/src/services/aiConfig.ts` | `getAiConfig` 先试 chat 路由再回落旧路径；嵌入/重排路由投影回原字段（消费方零改动）；新增 `resolveAuxConfigAsync` |
| 22 | `server/src/services/llmPool.ts` | V2 下池成员来自 chat 路由；`__resetLlmPool` 一并清路由缓存 |
| 23 | `server/src/services/aiV2Admin.ts` | 端点 / 凭证 / 路由唯一写入口；事务化成员重建、primary 指针、凭证复用、缓存统一失效 |
| 24 | `server/src/routes/admin.ts` + `admin/src/views/model.tsx` | 删除旧 CRUD，V2 admin API 成为唯一入口；后台按接入点 / 六用途路由 / 凭证三层编辑，含用途预算与凭证确认 |
| 25 | `shared/contracts.d.ts` + `services/aiValidation.ts` | V2 契约补齐 vendor/预算/端点测试；端点更新、入池、切 primary、保存路由共用完整关系校验 |

**为什么仍保留环境变量而不做后台开关**：正常读路径已默认 V2；`AI_CONFIG_V2=false` 只用于切换当天、后台不可用时的短时逃生。它读的是不再更新的历史快照，不能冒充长期回滚。迁移与就绪检查仍需在发布窗口完成，避免后台开始写 V2 后两边分叉。

---

## 8. 决策点（需要你拍板）

1. **生产 Anthropic 协议的权威 baseUrl 到底是哪个？** ⬅ **证据已收窄（2026-08-07 二次核对）**：`/bypass/anthropic` 这个路径**在七牛任何公开文档里都查不到**——FAQ 只讲 `https://api.qnaigc.com/v1`（OpenAI 协议），官方 Claude Code 配置工具 [qiniu/coding-helper](https://github.com/qiniu/coding-helper) 写死 `ANTHROPIC_BASE_URL=https://api.qnaigc.com`。两个都能调通不代表等价：中转路径不同，上游后端扇出与提示词缓存的归属可能不同，而 2026-07 那条「缓存 88% 未命中」至今没有别的解释。**已落地的处置**：预设表 `qiniu-anthropic` 用官方值；校验器对 `/bypass/` 路径出 `QINIU_ANTHROPIC_UNDOCUMENTED_PATH`（info，提示不阻断）。**仍需人做的**：向七牛确认后统一，并观察缓存命中率是否变化——这个动作要改生产配置，不该由我替运营决定。
2. **七牛是否透传 Anthropic 的缓存计价？** ⬅ **证据已收窄（2026-08-07 核对模型广场）**：七牛的价目表**确实有「缓存输入」这一档**（如 DeepSeek-V4-Pro「缓存输入 0.000025 元/K」），说明缓存**读**是分开计价的；但公开价表里**没有单独的缓存写档位**，只有「输入 / 输出 / 缓存输入」三档。若七牛按输入价结算缓存写，我们默认的 `× 1.25`（Anthropic 5m TTL 口径）就是**系统性高估 25%**。**已落地的处置**：`priceCacheWrite` 已建列可填；校验器对七牛端点出 `PRICE_CACHE_WRITE_UNSET_QINIU`（info），建议确认后显式填成与输入价相同。**没做的**：没有据此改 `CACHE_WRITE_MULTIPLIER` 常量——「公开价表没列」是推断不是确认，拿推断去改一个正在记账的常量不合适。
3. ~~**嵌入 / 重排换到哪一家？**~~ ✅ **已查明（2026-08-08，预发从生产复制配置后实测）**：生产**已开启**嵌入与重排，且**显式指向硅基流动**——`BAAI/bge-m3` / `BAAI/bge-reranker-v2-m3`，`baseUrl=https://api.siliconflow.cn/v1`，没有走「留空复用对话模型」那条在七牛下必错的回退。**结论：D5 确实是陷阱不是现役故障**，一期加的闸门只防将来有人把它清空，不改变任何现行行为。本条无需再向任何人确认。~~七牛没有 embedding，当前生产的嵌入实际是本地确定性兜底还是指向别家，需要确认~~——这直接决定 §7.1 第 5 条与 §7.4 第 8 条的文案怎么写。确认动作很便宜：生产库查一眼 `AiSetting.embeddingEnabled / embeddingBaseUrl` 即可；若从未开启，一期第 5 条只加闸门与文案、不动行为。
4. **三期要不要做。** 一期 + 二期（**含 §7.2-6 的 `dialect` 列**）就能消掉全部已确认缺陷和「猜方言」的根因——注意该结论以 dialect 列为前提，若二期砍掉这一列，推断只是被集中化，根因要拖到三期。三期解决的是「双真相源 / key 复制 / 用途混用」这类结构债，收益真实、代价也真实：迁移窗口之外，四张表 + 六条路由对「一家厂商、一位运营」的现状是不小的心智成本。建议：一二期立即排期；三期挂起到第二家厂商真正要接入时再启动——届时 dialect 列已把最难的地基打好。
5. **Agent 第三套接入（§1.1-#3）与 FeatureFlag 阈值（#5）的去向。** 目标结构只收编了五处配置里的 #1/#2/#4：`Agent.providerMode/dify` 在新结构中没有位置（`AiRoute.purpose` 全局唯一，表达不了 per-agent 路由），告警阈值也仍与模型配置分屏。三个选项：
   - **A · 收编**：路由加作用域维度（`purpose` 唯一约束改为 `(purpose, scope)`，`scope: 'global' | 'agent:<id>'`），Agent 覆盖变成一条 scoped 路由。最彻底，但把三期的迁移面再扩一圈。
   - **B · 共享地基**：Agent 接入维持独立字段，但强制过同一套 `validateEndpoint` + 探活（§7.2-8 / §7.4-12 已含）。消掉「无共享校验、无探活」这半条债，成本近零。
   - **C · 明确不管**，在 §1.1 表格里标为已知残债。
   **已按 B 落地（2026-08-07）**：`pingAgentRuntime` 现在过 `validateEndpoint` 的 error 级校验。顺带在这条路径上**发现并修掉了 D1 的第三个入口**——它同样自己拼 cfg + 调 `pingModel`，在 `routingMode=pool` 下同样被端点池整体改写，而一期只修了 `/admin/ai-models/test` 与 `/admin/ai-config/test` 两个。这条正好印证了当初「唯独不要 C」的判断：盘点了五处只修三处，漏掉的那处就是缺陷藏身的地方。**仍待拍板**：要不要升 A（把 Agent 覆盖收编成 scoped 路由）。

6. **旧列什么时候删。** 设计稿原话是「观察一个发布周期后」——时间条件压不掉，但「能不能删」已经变成一条命令：
   `npx tsx scripts/checkAiLegacyDrop.ts` 会检查读路径是否真的切过去了、每行 `ai_model` 是否都有对应端点、
   chat 路由有没有可用成员、旧表开着的能力在新表有没有对应路由、有没有待确认 vendor 的凭证。
   **全绿也不等于现在就删**：仍需人工确认「已观察满一个发布周期」且「期间没有回滚过 `AI_CONFIG_V2`」——这两条机器查不了。

---

## 9. 参考

- [七牛 · AI 大模型推理](https://developer.qiniu.com/aitokenapi)
- [七牛 · 大模型接口调用 FAQ](https://developer.qiniu.com/aitokenapi/12897/how-to-use-ai-token-api)（baseUrl 规范、429/限额、模型范围、无 Embedding）
- [七牛 · Claude 系列模型的兼容调用](https://developer.qiniu.com/aitokenapi/13000/claude-inference-api)（thinking / budget_tokens / tool_choice 参数表）
- [七牛 · 获取 API 密钥](https://developer.qiniu.com/aitokenapi/12884/how-to-get-api-key)
- [qiniu/coding-helper](https://github.com/qiniu/coding-helper)（`ANTHROPIC_BASE_URL` 官方取值）
- [DeepSeek · Anthropic API 兼容](https://api-docs.deepseek.com/guides/anthropic_api/)
- [火山方舟 · 对话 Chat API](https://www.volcengine.com/docs/82379/1494384?lang=zh)

---

## 附录 A · D1 复现探针

放在仓库外跑（不入 `test/` 目录，避免污染 `npm test` glob）：

```ts
import { test } from 'node:test';
import { resolveCandidates, __resetLlmPool, __setPoolForTest, type PoolEndpoint } from '<abs>/server/src/services/llmPool.js';
import type { ResolvedAiConfig } from '<abs>/server/src/services/aiConfig.js';

const formCfg: ResolvedAiConfig = {
  provider: 'openai', label: '我正在编辑的端点', baseUrl: 'https://being-edited/v1',
  model: 'model-being-edited', apiKey: 'sk-being-edited', embeddingModel: '', temperature: 0.3,
  thinkingMode: 'enabled', thinkingBudget: 4096, timeoutMs: 60_000,
  embeddingEnabled: false, embeddingBaseUrl: '', embeddingApiKey: '',
  rerankEnabled: false, rerankModel: '', rerankBaseUrl: '', rerankApiKey: '',
};
const ep = (id: string): PoolEndpoint => ({
  id, label: `池端点-${id}`, provider: 'openai', baseUrl: `https://pool-${id}/v1`,
  apiKey: `sk-pool-${id}`, model: `pool-model-${id}`, temperature: 0.9,
  thinkingMode: 'disabled', thinkingBudget: 1024, weight: 1, tier: 0, maxConcurrency: 0,
});

test('pool 开启时探活打到了谁', async () => {
  __resetLlmPool();
  __setPoolForTest([ep('a'), ep('b')], { mode: 'pool', sticky: true });
  console.log(await resolveCandidates(formCfg));           // ← 现状：返回池端点，不是表单端点
  console.log(await resolveCandidates({ ...formCfg, poolBypass: true })); // ← 修复后应等于这个
});
```

```bash
cd server && node --env-file=.env.test --import tsx --test <探针路径>
```

2026-08-07 实测输出：第一候选为 `池端点-a` / `https://pool-a/v1` / `sk-pool-a` / `temperature 0.9` / `thinking disabled·1024`，与表单值无一相同；`poolBypass: true` 时正确返回「我正在编辑的端点」。

---
