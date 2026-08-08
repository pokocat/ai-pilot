# 三期收尾（写路径）· Review 与完成记录

> 初稿写于 2026-08-08，原会话中断于「独立测试库上的全量回归」。
> 2026-08-08 续做 review、补齐缺口并完成回归；本文件从临时交接单升级为最终完成记录。

---

## 0. 一句话

三期此前只建了四张表、只切了读路径，**后台仍写旧表、V2 靠 `syncV2FromLegacy` 投影**——三笔债一笔没收，反而多了一层拷贝（净负）。本次把写路径也搬过去：后台只写归一化表，旧表降为只读。

---

## 1. 已完成并复核

### 后端
| 改动 | 文件 |
|---|---|
| 删除整套旧 CRUD（`setAiConfig`/`addModel`/`updateModel`/`deleteModel`/`activateModel`/`syncActiveSetting`/`ensureSeededModels`） | `server/src/services/aiConfig.ts` |
| 删除投影函数 `syncV2FromLegacy` | `server/src/services/aiRoutes.ts` |
| 新增唯一写入口（端点/凭证/路由 CRUD + `configurePurpose` + `__wipeAiV2`） | `server/src/services/aiV2Admin.ts` |
| 删除旧路由（`PUT /admin/ai-config`、`/admin/ai-models*`、`PUT /admin/ai-routing`），V2 路由成为唯一写路径；探活/测试重定向到 `/admin/ai-endpoints*` | `server/src/routes/admin.ts` |
| 探活改写**端点表**并清路由缓存（`probeModelById` → `probeEndpointById`） | `server/src/services/aiProbe.ts` |
| `AI_CONFIG_V2` 默认值 `false` → `true` | `server/src/services/aiRoutes.ts` |

### 前端
后台模型页按真实结构重排为三层，并全部改读写 V2 实体：

- **接入点** —— 一行一个上游，属性与操作都在这一行（含池参数内联）
- **路由** —— 六个用途结构同构，共用一个 `RouteRow` 组件（旧版嵌入/重排是另写的一套 UI）
- **凭证** —— 换 Key 的唯一入口

文件：`admin/src/views/model.tsx`（重写）、`admin/src/api.ts`（AI 段重写）。

### 契约
- `AiDialectMeta.thinkingOff` 补上二期就加了却漏同步的第四档 `explicit_when_configured`（**类型检查抓出来的**）
- `AiV2View` 增加 `presets` / `dialects` / `vendors`，前端建端点与确认凭证无需额外目录请求
- `AiRouteView/AiRouteUpsert` 补齐用途级 `budget`，支持超时 / 正文 token / 温度的保存与显式清空
- 端点直测使用独立 `AiEndpointTest.endpointId`，删除旧 `AiConfig/AiModel` 写契约

### 测试
- 删除 `aiModelUpsert` / `aiTemperatureConfig` / `aiV2Writeback`（只测旧 CRUD 与投影）
- 新增 `test/aiV2Admin.test.ts`（30 例，覆盖三笔债、事务、关系校验、用途预算与凭证确认）
- 新增 `test/aiLegacyReadOnly.test.ts`（**扫源码**钉死「运行时不得再写旧表」）
- 迁移：`aiProbe` 改测端点；`aiCredentialStorage` 的旧密文段显式走 `AI_CONFIG_V2=false`；`integration` TC-H 改 V2 口径；`structuredBilling`/`planExpiryRoute` 用 `configurePurpose` 替代 `setAiConfig`

### 文档
`docs/CHANGELOG.md`（顶部新条目）、`AGENTS.md` §13、设计稿状态行，均已更新。

---

## 2. 过程中修掉的缺陷

都属**不报错但结果不对**，是这次改动最有价值的产出：

1. **写完没人清 `aiConfig` 的 4 秒缓存。** 旧的 `setAiConfig` 顺手做了 `cache = null`，删掉那套 CRUD 后没人接手 → 运营改完配置、页面显示已保存，运行时最多 4 秒仍用旧值且**无任何报错**。现由 `aiV2Admin.invalidate()` 统一清（新增 `__resetAiConfigCache`），并有回归（**不传 `force`**，走线上真实读法）。
2. **费率表仍读 `ai_model`。** 单价现在配在端点上，不改的话运营填的价一分钱进不了成本核算，只会看到成本恒为 0。
3. **探活结果仍写 `ai_model`。** 切到 V2 后运行时读端点表，能力回填（「这个模型不支持思考」）到不了运行时，「能力靠测」的闭环恰好断在最要紧的一环。

续做 review 又补出并修复了这些问题：

4. **保存路由先删后建且不在事务里。** 任一重复成员或外键失败都会把线上路由清空。现整段在同一事务内，失败完整回滚；HTTP 关系不存在仍保持 404，配置冲突才是 409。
5. **校验事实仍有旧表残留。** 同名价格冲突曾查 `AiModel`，V2 端点之间的冲突完全看不见；现只查 `AiEndpoint`。
6. **编辑已入路由端点、加入分流池仍可能绕过关系校验。** 现端点更新会反查所有引用路由，入池 / 切 primary / 保存路由均用变更后的完整成员集合校验，混协议在落库前被拒。
7. **单端点用途换主项留下旧成员。** `aux/embedding/rerank/moderation` 现在替换成员而不是追加，避免旧端点形成幽灵引用并阻止删除。
8. **迁移凭证只有黄标，没有确认闭环。** 凭证区可确认接入商（含“自定义 / 其它”）；`needsReview` 未清除前禁止新的路由变更，但一次性迁移仍可保留现有主路由。
9. **Embedding/Rerank 与用途预算只存在于服务层。** 六用途行现在可编辑预算；Embedding/Rerank 同时校验协议和厂商能力，不能把 Anthropic 或七牛 OpenAI 端点误配进去。
10. **运营端吞错。** 冷却态加载和端点直测改为展示真实错误，不再把失败伪装为空态或固定“测试失败”。
11. **死代码与事实表分散。** 删除旧全局测试合并、public config 与旧写契约；`AI_PRESETS` 移到 `llm/vendors.ts`，厂商事实与预设归位。

---

## 3. 验收结果

- 独立数据库 `junshi_test_v2` 上完成最终全量服务端回归：review 分支提交前 `npm run build && npm test` **1427/1427**（233 套件），rebase 到主线后重新生成 Prisma Client 并复跑为 **1442/1442**（237 套件，0 fail / 0 skip）。第一次续跑曾得到 **1425/1426**，唯一失败是不存在端点从 404 回归成 409；修复后相关服务端与集成用例 **177/177**，再补入池校验后 **141/141**。
- admin `npm run build && npm test` 通过：设计系统 lint、TypeScript、Vite 构建全绿，测试 **61/61**。
- app `npm test && npm run build:h5 && npm run build:weapp` 通过：TypeScript、原生构建脚本 **43/43**、H5 测试 **93/93**，H5 与原生微信 mock 包均构建成功；H5 仅有既存 bundle 体积警告。
- 本地 `.env.test` 的独立库名只用于隔离测试，完成后恢复仓库默认，不纳入提交。
- 旧 CRUD / 投影 / 写契约 / `mergedConfigTest` / `publicConfig` 已确认无调用并删除；预设已移到 `llm/vendors.ts`。

## 4. 尚需外部执行的产品 / 运维动作

- 生产迁移与发布：`npm run ai:migrate` 预演 → `ai:migrate:apply` → 看 `/admin/ai-v2-status` 的 `ready` → 发布
- 旧列删除：观察一个发布周期后按 `npm run ai:check-drop` 的结论
- 后台登录态实机走查（要填 `ADMIN_TOKEN`）
- 设计稿 §8 的五个决策点
- Agent 自带接入（`providerMode=openai|dify`）仍未收编进路由（决策点 5）

**没有实现开机自动迁移。** 迁移继续是发布窗口里的显式动作；隐式启动写库会模糊变更时点，也无法替代 `ready` 和待确认凭证的人工检查。

---

## 5. 后来者必须知道的坑

1. **任何写接入配置的地方都要走 `aiV2Admin.invalidate()`** —— 它同时清路由缓存、`aiConfig` 的已解析配置与费率缓存、端点池缓存。少清 `aiConfig` 那一层，就是上面第 2 节的第 1 条，**不报错**。
2. **单价读端点表、探活写端点表** —— 读错/写错表都不报错，只会静默记 0、或让能力回填到不了运行时。
3. **`npm test` 带 `--test-concurrency=1`；手工跑多个文件时别忘了加**，否则同库竞争，失败看着像真的。
4. **worktree 必须用独立测试库**，否则会影响主工作区的测试。
5. **`AI_CONFIG_V2=false` 是逃生口，不是回滚方案** —— 旧表自本次上线起不再更新，关掉读到的是**历史快照**，只能救急。
6. **旧表只读这条有自动化守卫**（`test/aiLegacyReadOnly.test.ts` 扫源码）。确实需要写旧表的一次性迁移，把文件加进白名单并写清理由。
7. **路由成员重建必须保持事务性**；不要把 `deleteMany` 和 `create` 拆到事务外。
8. **关系变更要按变更后的完整集合校验**；只校验被点的那一个端点会漏掉池内协议、唯一 primary 与厂商能力冲突。
9. **`needsReview` 的迁移语义与日常写语义不同**：一次性迁移允许保住既有路由，迁移后的新路由写入必须先确认。

---

## 6. 分支与历史说明

续做基于 worktree `/Users/donis/dev/ai-pilot-v2`、分支 `feat/ai-config-v2-writepath` 完成，并已 rebase 到本机主线 `259a5f8`；主工作区已有未跟踪文档全程不触碰。历史备份 ref 仍为 `backup/ai-config-redesign-pre-rebase-20260808 → a672f01`。
