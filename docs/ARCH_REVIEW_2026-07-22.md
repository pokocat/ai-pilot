# 生产架构体检 · 问题清单（2026-07-22）

> **审查方式**：主模型静态审查（代码 / schema / 部署脚本）+ 4 个子代理并行深审（①支付计费 ②知识库 RAG ③LLM 网关流式 ④可扩展性与运维），主模型交叉验证并回溯 `docs/CHANGELOG.md` 的线上排查记录。
> **基线**：`claude/system-architecture-review-x6nk2d` @ `877e51d`。
> **访问限制**：本次未接入生产库 / 日志（生产机 SSH 端口在审查环境不通、私钥在本机），仅可访问公网 `/api/health`。结论基于代码 + schema + 部署脚本 + CHANGELOG 里已记录的线上排查。凡需生产 `.env` 或运行时数据才能定性者，标注 **【待核实 prod】**。提供脱敏 DB dump 或 `journalctl` 片段可进一步落实并补运行时视角。

---

## 0. 总评

不是粗糙原型：SSOT 契约、79 个后端集成测试 + CI、支付幂等的精心设计、账本 advisory-lock、后台 RBAC——工程素养在线。真正的风险是**它仍是一套「演示优先」的架构，如今承载了真实用户与真实付费**。三条结构性断层：

- **默认不安全**：整套租户隔离，只差一个环境变量就全线敞开。鉴权 = `token=userId`、短信可免验、后台默认密钥，安全性完全押在 3 个生产环境变量上，而它们的默认值全部不安全。
- **静默降级**：检索 / 嵌入 / 审核 / 模型回退 / 断连计费全都「悄悄失败」——返回更少 / 错误 / 模板化的结果，却无任何错误信号。对一个 AI 军师，这是最糟的失败形态。
- **单点无兜底**：单机 Postgres、无自动备份、`db push` 上线、无优雅退出、进程内定时器、无限膨胀的日志表。缺一张安全网。

计数：**P0 ~8 · P1 ~14 · P2 ~13 · 做得好 ~9**。

---

## 1. 🔴 10 分钟内先做：核对生产 `.env` 三把锁

最高杠杆、零代码。三项若有任一是默认值，线上现在就是敞开的——也是唯一无法从代码判定、必须在生产确认的部分。

| 锁 | 要确认 | 否则 |
|---|---|---|
| 登录态 JWT | `APP_JWT_SECRET` 已设 + `APP_JWT_REQUIRED=true` | `token` 即明文 `userId`（cuid，会经 @引用 / 分享 / 日志外泄）。改 `x-user-id` 即冒充他人，越权读写全部案卷 / 知识 / 报告、花其算力 |
| 短信验证码 | `SMS_REQUIRE_CODE=true` | `POST /api/auth/login` 只凭手机号即可登录 / 注册他人账号，绕过 App 直打端点 = 账号接管 |
| 后台主密钥 | `ADMIN_TOKEN` ≠ `junshi-admin-dev` | 任何人进后台：退款、给自己开付费模块、导出全部用户 |

---

## 2. P0 · 立即处理

### P0-1 鉴权：token = userId，凭标识即凭证【待核实 prod】
- 证据：`server/src/services/context.ts:73`（`resolveUser`）、`server/src/services/userToken.ts:62`（`verifyUserToken`：未开 `APP_JWT_REQUIRED` 时原样返回 `x-user-id` 头）。
- 后果：cuid 非机密，会经 @引用 / 分享链接 / 审计日志外泄；拿到任意他人 id 即冒充其身份，跨租户读写案卷 / 知识 / 报告、消耗其算力。

### P0-2 短信验证码可绕过 → 手机号即账号接管【待核实 prod】
- 证据：`server/src/routes/auth.ts:237`、`server/src/env.ts:69`。请求不带 `code` 且 `SMS_REQUIRE_CODE≠true`（默认）时不校验，直接按手机号登录 / 注册。直接打端点即可。

### P0-3 后台默认主密钥若未更换 = 后台接管【待核实 prod】
- 证据：`server/src/services/adminAuth.ts:48`；`.env.example` 默认 `ADMIN_TOKEN=junshi-admin-dev`。带入生产则任何人可越权调用全部 `/api/admin/*`。

### P0-4 单机 Postgres，无自动备份、无副本、无 PITR
- 证据：`deploy/docker-compose.yml`、`server/src/db.ts:3`；仓库内仅有「部署前手动 `pg_dump` 到 /tmp」（CHANGELOG 多处）。
- 后果：用户 / 订单 / 账本 / 案卷全在一台 ECS 一块盘上。磁盘或机器故障 = 全量不可逆丢失。**头号运维风险。**【待核实是否有 ECS 快照】

### P0-5 `prisma db push` 作上线机制：无迁移史、无回滚、静默丢数据
- 证据：`server/package.json`（`db:push`、`db:reset = --force-reset`）、`scripts/deploy-prod.sh`；schema 注释把缓解写成人肉纪律（「db push 纯加法」）。
- 后果：下一次改名 / 改类型 / 删字段经 db push 打到 prod = 无审计的静默丢数据。

### P0-6 知识库默认检索：内存暴力扫描，静默截断在 2000 条无序切片
- 证据：`server/src/services/retrieval.ts:156`（`take:2000` 无 `orderBy`）、`server/src/env.ts:63`（`PGVECTOR_ENABLED` 默认关）。
- 后果：单份大文档 ~428 切片，约 5 份大文档撑爆 2000；超过后只「看得见」任意 2000 条、其余静默忽略、召回崩塌不报错。每次查询把 2000 条文本 + 向量载入 Node 扫一遍。

### P0-7 嵌入在请求内同步跑、无队列、部分入库不可回滚
- 证据：`server/src/services/knowledgePipeline.ts:400`、`server/src/services/knowledge.ts:43`。
- 后果：确认一批大文档 = 一个请求内几百上千次串行嵌入 → 必超时；循环无 per-item try/catch、无事务，中途失败留混合态无回滚，整请求 500。

### P0-8 客户端断连从不被感知 → 生成照跑、token 照烧、用户为看不到的输出付费
- 证据：`server/src/routes/sessions.ts:386`（无 `reply.raw.on('close')`）、`server/src/llm/gateway.ts:415`（AbortSignal 不下传 provider）。
- 后果：用户切后台 / 断网后服务端仍生成 60–120s，烧全部真实 token、扣额度、落库一份用户永远没看到的报告。移动端断连是常态，当下持续漏钱。

### P0-9 Claude provider 未接超时 / 中止：网关卡住可拖住请求约 10 分钟 × SDK 重试
- 证据：`server/src/llm/providers/claude.ts:32`（`new Anthropic()` 未传 `timeout/maxRetries`）；`cfg.timeoutMs` 仅 OpenAI 路径生效。
- 后果：`provider=claude`（或 Anthropic 兼容网关）慢 / 挂时单请求阻塞至 SDK 默认 10 分钟并静默重试 3 次，占住连接 → provider 抖动时全站排队恶化。后台「超时」配置对 Claude 形同虚设。

> 注：P0 计数取「立即处理」口径；上表列出的即时项含鉴权三把锁（合并计为安全类）与上述运维 / RAG / 网关项。

---

## 3. P1 · 上量前修

### P1-1 鉴权靠「每路由手动 resolveUser」而非全局强制
- 证据：`server/src/app.ts:83-117`。无全局 `preHandler` 鉴权；新增路由忘记首行 `resolveUser` 即静默公开。约定非强制。

### P1-2 无优雅退出：每次部署重启掐断在途流、泄漏 Chromium、泄漏算力预留
- 证据：`server/src/index.ts`（零 `SIGTERM` 处理）、`deploy/junshi-api.service`。
- 后果：`systemctl restart` 直接杀进程 → 切断在途 SSE、`onClose` 的 Chromium 清理不跑、`reserveQuota` 已扣但 `settle/refund` 未跑（算力泄漏）。日间每次部署命中。

### P1-3 audit_log：每请求写一行 + 额外查用户，无索引、无保留，还被热路径读取
- 证据：`server/src/services/audit.ts:99`、`server/prisma/schema.prisma:908`（无 `@@index`）、`server/src/services/tokenQuota.ts:171`（grace 检查按 `userId+action+createdAt` 读）。
- 后果：最快膨胀的表、读写全表扫，拖慢整站与复盘生成路径。

### P1-4 进程内定时器：无主节点选举、check-then-act 幂等
- 证据：`server/src/services/scheduler.ts:47`、`server/src/services/reminders.ts:87`。
- 后果：一上第二实例即重复推送微信订阅消息 + 一次性额度双花；6h 任务用 `setInterval`，频繁部署会让它基本不触发（启动不立即跑、无补偿）。

### P1-5 credit_ledger 无索引：每次余额读（即每次产出）全表扫 + 排序
- 证据：`server/src/services/credits.ts:24`、`server/prisma/schema.prisma:660`。并发本身用 advisory lock 处理得当，纯缺索引的性能坑。

### P1-6 微信商户后台发起的退款完全无处理 → 钱退了、权益还在
- 证据：`server/src/services/wechatPay.ts:747`、`server/src/routes/pay.ts:116`。
- 后果：`markRefundNotified` 只更新已是 `refunded` 的单；客服在商户后台退款时订单还是 `applied`，`REFUND.*` 到达时 `updateMany` 匹配 0 行，不撤权益不追回，且无对账兜底。这是多数客服退款的默认路径。

### P1-7 SKU 赠送写「未加锁」账本行，冲掉并发算力扣减
- 证据：`server/src/services/purchase.ts:121`。
- 后果：读上一余额不持算力锁，与并发 `chargeCredits` 竞态 → 扣减被抹掉、账本 `Σdelta==balance` 不变式破坏、用户白得算力。

### P1-8 并发已支付订单双发放：月→年折算重复计算
- 证据：`server/src/services/wechatPay.ts:136`、`server/src/services/purchase.ts:39`。【需并发时序复现】
- 后果：幂等 per-`outTradeNo`、无 `(userId,planId,created)` 唯一约束；两单都入账时 A 建年套餐、B 判为续费叠加 +12 月并再发一整年算力 → 用户得 2 年 + 双倍算力。

### P1-9 管理员退款：微信已退成功但本地回收抛错 → 卡「已退款却仍生效」
- 证据：`server/src/services/wechatPay.ts:692`。微信退款 HTTP 在本地事务之前提交；`revokeOrderGrant` 抛错则事务回滚但钱已退，订单永停 `applied/refundedAt=null`，`markRefundNotified` 也修不了。

### P1-10 回调验签 fail-open，且不校验时间戳新鲜度
- 证据：`server/src/services/wechatPay.ts:287`。平台证书不可用时打印警告后 `return true` 跳过验签（仅剩 AEAD 一层）；全程不校验 `wechatpay-timestamp`。默认 fail-open，证书端点抖动即把公开 webhook 降到单层认证。

### P1-11 search_knowledge 工具漏传 userId → 多人租户内互相泄漏文档
- 证据：`server/src/llm/tools/builtin.ts:26`（漏 `ctx.userId`，同文件 recall_memory 有传）。
- 后果：今天每人独占租户被掩盖；`Tenant.users` 一对多、`User.role` 已建 owner/member，企业 / 多人租户一上线，AI 检索把每个同事的文档返回给每个同事，违反「tenantId+userId 双维隔离」铁律。【潜伏，团队版即触发】

### P1-12 pgvector 空结果不回退 + 维度硬编码 256 + 双列漂移 = 一开就静默全灭
- 证据：`server/src/services/retrieval.ts:133`、`server/prisma/pgvector.sql:14`、`server/src/services/memory.ts:98`。
- 后果：ANN 返回空即 `return []` 不回退内存；`vector(256)` 与真实嵌入（1536 维）不匹配时 `upsertChunkVector` 每行抛错被吞 → `embedding_vec` 全 NULL → 检索静默彻底为空。同 bug 亦在长期记忆召回。

### P1-13 嵌入失败静默回退本地 256 维；默认「语义」实为词法哈希；异步入库悬空无兜底
- 证据：`server/src/services/embedding.ts:110`、`server/src/services/embedding.ts:46`（FNV-1a 词袋哈希 256 桶）、`server/src/services/knowledge.ts:176`（`void processDocument`）。
- 后果：维度不匹配时余弦恒 0、切片静默隐形；未配 `EMBEDDING_MODEL` 时「语义召回」实为模糊关键词；进程崩溃则条目永卡 `parsing/embedding`、状态与切片漂移无对账。stage 隔离仅靠「非确认项恰好没切片」维系。

### P1-14 APP_ENCRYPTION_KEY 错配 → 全站静默降级为 mock 模板
- 证据：`server/src/services/aiConfig.ts:129`、`server/src/llm/gateway.ts:21`。
- 后果：密钥缺失 / 轮换错时 `decryptSecretSafe` 吞 GCM 失败返回空 → provider 判「未就绪」走 mock 分支（非错误分支），无 503、trace 无错、usage=0。付费用户拿套模板的「战略」而无人察觉。近乎 P0。

### P1-15 无单请求成本上限；辅助 LLM 调用不进 trace 也不计费
- 证据：`server/src/services/tokenQuota.ts:18`（预留固定 2000）、`server/src/llm/gateway.ts:656`。
- 后果：带工具一轮最坏数万 token 无绝对上限；`extractInsights/Prophecies/Graph/summarize` 走未 traced、（多数）未计费路径，真实成本被系统性低估。

### P1-16 模型输出从不审核 + 输入审核 fail-open + 默认仅 4 个关键词【合规】
- 证据：`server/src/services/moderation.ts:27`（`FAIL_OPEN` 默认 true、默认词表 `['暴力','违法集资','赌博','毒品']`）、`server/src/llm/gateway.ts:236`（仅 `moderate('input')`，无 output 审核）。
- 后果：对强监管的微信小程序，「弱默认过滤 + 服务抖动就放行 + 输出零审核」是下架级敞口。

---

## 4. P2 · 排期修

- **持久化**：`llm_trace/token_usage/moderation_log/tool_call_log` 无 TTL / 分区无限膨胀；`/api/health`（`meta.ts:18`）不探 DB；Prisma 连接池（`db.ts:3`）未配上限。
- **扫描**：提醒每 30 分钟全表扫 `casefile`（`reminders.ts:74`，索引首列缺失用不上）；单 Node 进程单核，无头 Chromium 与 Postgres 同机争内存有 OOM 隐患。
- **支付**：崩溃遗留的算力 / 额度预留无 orphan 清扫器（`sessions.ts:182` vs `540`）；降级产出仍扣钻石（`sessions.ts:281`）；SSE 已流式交付却在末段失败时全额退款（白拿，`sessions.ts:540`）；advisory 锁共用一个 `hashtext` 命名空间、嵌套获取有理论死锁风险。
- **流式**：结构化成果「假流式」（整段 await 后 `sleep(520)` 分段下发、无心跳、无 `X-Accel-Buffering`，`sessions.ts:486`）→ 代理空闲超时掐断，是线上 60s/73.6s 超时事故的根因链。
- **网关**：httpTool SSRF 可被重定向 / DNS rebinding 绕过打云元数据（`httpTool.ts:38`）；Dify 硬 60s 上限且全缓冲（`dify.ts:12`）；`sanitizeDeliverable` 误杀 SaaS 类正当报告换模板（`gateway.ts:62`）；非流式 / 工具步 20s 超时偏紧（`openai.ts:37`）；`AI_FALLBACK_MOCK` 若误入 prod 会把 provider 故障伪装成正常 mock。
- **RAG**：切片无重叠 / 表格压平 / 超 12 万字静默截断（`knowledge.ts:18`、`docParse.ts:24`）；去重键「同批内 文件名::大小」易绕过。
- **鉴权**：CORS `origin:true` 反射任意来源、无 helmet；`/api/r/:id` 公开报告页凭 cuid 无鉴权无过期（`reportShare.ts:20`）。
- **前端**：`app/src/services/mock.ts` 1638 行完整复刻后端，mock/server 双轨的长期维护成本。

---

## 5. 线上事故回溯（CHANGELOG 已记录的信号）

印证两个主题——**多层超时错配** 与 **并发竞态被一个个手工发现**（缺系统性并发控制与统一超时 / 流式约定，只能靠 QA 打地鼠）：

- `07-18` 长对话「有记忆没带入」：超 100 条只注入最近 8 条（已改 16）。根因未除——固定滑窗记忆、无摘要压缩，对「长期军师」定位天然脆弱。
- `07-18` ×2 流式超时：`wx.request` 默认 60s < 服务端 73.6s；服务端 `AbortController` 60s 掐断长流。客户端 / 网关 / Nginx 三层超时耦合逐个踩。
- `07-15` 下单频控 TOCTOU 竞态 + 聊天流式失败兜底误判致重复追答（双计费）。
- `07-14` 支付证书拉取节流可绕开（放大攻击）+ 后台 CSV 导出公式注入。
- `07-11` 认可方案幂等竞态（`(userId,seq)` 撞车）+ 处方状态机读改竞态。
- `07-04+` 输出长度上限反复上调（回复 800→4000、报告 1500→2600→8000）——截断反复打到用户。

---

## 6. 建议处理顺序（止血 → 保命 → 修复 → 加固）

1. **核对生产 `.env` 三把锁**（JWT / 短信 / ADMIN_TOKEN）——零代码 10 分钟，堵住整套隔离敞口。
2. **Postgres 自动备份 + 异地 / 快照，并验证能恢复**——磁盘一挂全没，其它都不重要。
3. **补微信商户后台退款处理闭环 + SKU 账本加锁**——正常运营下就在悄悄错钱。
4. **SSE 接客户端断连 AbortSignal（断连即停生成 / 停结算）+ 给 Claude client 传 timeout/maxRetries**——止住持续的 token / 算力泄漏。
5. **知识库改异步入库（队列 + 状态机 + 事务）**，默认检索加 orderBy / 上限治理 + 语义嵌入——别让核心功能随资料变多静默崩。
6. **`db push` → `prisma migrate`**；`audit_log` 加索引 + 保留、去掉每请求额外查询；日志表 TTL / 分区。
7. **输出侧内容审核 + 合规默认 fail-closed**；定时器抽成单实例 worker + advisory-lock 主节点守卫 + 唯一约束幂等。

---

## 7. 做得好，别回退

- SSOT `shared/contracts.d.ts` 三端类型统一 + AGENTS.md 强制同步纪律。
- 79 个后端集成测试 + GitHub Actions（真 Postgres service）。
- 支付单订单幂等：`appliedAt` 终态锚点 + 金额 / appid / mchid 校验 + 退款幂等 + 对账 sweep。
- 算力账本并发用 `pg_advisory_xact_lock` + 锁内复核，无双花。
- 「401 必须显式打断」全局铁律，杜绝失效态滞留。
- 审计脱敏：手机号掩码、密钥 / 验证码 redact。
- 后台 RBAC：master 常量时间比对 / 账户会话 / per-agent 协作授权。
- 折算防套利数学：`min(全价, 原价, 日费×天数)` 双封顶。
- 时区经 `clock.ts` 用 Intl 固定 Asia/Shanghai，不靠宿主机 TZ。

---

> 附：本清单另有带分级 / 筛选的 HTML 版 `docs/arch-review-2026-07-22.html`（自包含、可直接浏览器打开）。
