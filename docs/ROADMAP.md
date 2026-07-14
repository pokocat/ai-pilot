# 军师 · 路线图与进展（ROADMAP）

> 活文档。与 `AGENTS.md`（工程总说明）配套：AGENTS 记「当前真实状态」，本文件记「已做 / 待做」。
> 最近更新：2026-06-20

## 一、已交付（已合入 `claude/youthful-bell-feC4l`）

### 1) 企业事务操作系统
- **项目（Project）主线**：会话 / 报告 / 知识 / 记忆均可归属项目；首页 +「我的」入口 → 项目工作台 → 项目详情（会话 / 报告 / 知识三段）。
- **知识库 + 语义记忆**：切片向量化入库；向量 × 关键词混合检索；记忆按当前问题语义召回；对话 / 手动 / 汇总三种来源沉淀。
- **版本化报告**：按报告名归一、内容哈希去重、自动变更摘要；报告页版本时间线 + 查看某版 + **段级 & 句内词级 diff**。
- **@ 引用（上下文工程）**：对话框 📎 选 项目 / 报告 / 知识 → 注入上下文、可溯源、随消息回显。
- **对话汇总**：一键「生成纪要」→ 版本化报告 + 沉淀知识库。

### 2) 可切换大模型
- 默认 **Agnes 2.0 Flash**（`apihub.agnes-ai.com/v1`，OpenAI 兼容）；运营后台「模型」页一键切 DeepSeek / Qwen / Moonshot / OpenAI / Claude / mock，含**测试连接**、即时生效。
- DB 配置（`AiSetting`）> env 兜底；未配真实 key 自动降级 mock；对外不回传明文 key。
- LLM 提炼记忆 / 汇总（有真实模型走结构化抽取/归纳，mock 确定性兜底）。

### 3) 检索/向量增强
- 真实嵌入（配置 `embeddingModel` + key 走 `/embeddings`，否则本地确定性嵌入）。
- pgvector 路径（`PGVECTOR_ENABLED` + `npm run db:pgvector`，flag 内走 `<=>` ANN，默认关）。

### 4) 工程
- 三端构建全绿；后端 `buildApp()` 工厂 + **集成测试 16 用例全过**（含跨用户隔离，见 `docs/TESTING.md`）。

## 二、待办 TODO（按优先级）

### P0 · 验收 / 联调（需真实 Key·DB，代码已就绪）
- [ ] 后台「模型」页填 **Agnes API Key** → 测试连接 → 跑通一次真实产出。
- [ ] 真库验 **pgvector**：`npm run db:pgvector` → `PGVECTOR_ENABLED=true` → 验 ANN 检索/召回（注意向量维度 N 与嵌入一致）。
- [ ] 配**真实嵌入模型**验语义检索质量（换维度需重嵌）。
- [ ] 真机/模拟器走查新页面 UI（项目 / 报告 / 对话 @引用），核对像素与本命色。

### P1 · 功能增强
- [x] **时序知识图谱**（Graphiti 式）：`GraphEntity/GraphRelation`（有效时间窗）+ `services/knowledgeGraph.ts`（去重/软失效/as-of 查询）+ `routes/graph.ts`。抽取依赖真实模型。
- [x] 运营后台**项目 / 报告 / 知识只读看板**后端接口（`GET /admin/{projects,reports,knowledge}`）；前端看板页待接。
- [x] @引用选择器**「记忆」候选**分组（`GET /memories`，`resolveReferences` 支持 `kind:memory`）；前端分组待接。
- [x] 报告**任意两版对比**（`/reports/:id/diff?from=&to=`）+ **重命名**（`PATCH /reports/:id`）+ **删除**。PDF 导出可用既有 HTML 分享页打印。
- [x] 知识库**文档上传**（`POST /knowledge/upload`，纯文本即入库；PDF/图片走 `services/ocr.ts` 配 `OCR_*` 启用）。

### P2 · 生产硬化
- [x] **密钥加密**：`services/secretBox.ts`（AES-256-GCM）模型/Dify/技能库密钥写时加密读时解密（配 `APP_ENCRYPTION_KEY`，`npm run secrets:encrypt` 回填）。**RBAC**：`AdminAccount.role`（super_admin/operator）+ `requireSuperAdmin` 守护密钥配置/账号管理 + `/admin/accounts` 多账号。仍待：密钥接 KMS/轮换、前端账号管理页。
- [x] 鉴权升级：JWT（`services/userToken.ts`，配 `APP_JWT_SECRET`，`APP_JWT_REQUIRED` 强制）；短信强制校验开关 `SMS_REQUIRE_CODE` 就绪。
- [x] 内容审核 / 缓存：`services/moderation.ts`（keyword/http 可插拔）+ `services/cache.ts`（内存/Redis 可选依赖 ioredis）。
- [x] **算力按次扣减 + 余额不足拦截**（`services/credits.ts`，TC-K 守护）。
- [x] **微信支付 v3 脚手架 + 幂等入账**：`PaymentOrder` 状态机 + `services/wechatPay.ts`（下单/回调验签解密/`markPaidAndApply` 原子防并发双发）+ `routes/pay.ts`。配 `WECHAT_PAY_*` 启用。主动查单对账已落地（2026-07-14：`reconcileOrder` + `GET /pay/orders/:outTradeNo` 轮询补账 + `pay:mock` 本地 mock 微信网关全链路）。仍待：平台证书自动轮换、定时批量对账 job、退款；token 级用量归集仍为旁路统计。

### P3 · 收尾
- [x] 扩充集成测试：SSE `/generate` 流式、内容审核拦截、**算力按次扣减+不足拦截**、并发冒烟（见 `docs/TESTING.md` TC-I/J/K/L）。
- [ ] 性能基准（非冒烟）：检索/产出在 1k+ 数据下的时延与吞吐。
- [ ] 微信小程序上线硬约束：真实 AppID、HTTPS+ICP 域名、生成式 AI 备案（建议用已备案国产模型，走 OpenAI 兼容即可）。

## 三、风险登记
- **信息泄露（高）**：跨租户/跨用户数据隔离——已由 `TC-G` 集成测试守护，**大改后必须跑通**（见 `docs/TESTING.md`）。
- **密钥明文（已缓解）**：模型/Dify/技能库 key 已支持 AES-256-GCM 加密存库（配 `APP_ENCRYPTION_KEY` 启用 + `npm run secrets:encrypt` 回填）；细粒度 RBAC 已落（super_admin/operator）。仍待密钥接 KMS/轮换。
- **pgvector 未真验（中）**：路径实现但本地无扩展未端到端跑，启用前在真库验证。
