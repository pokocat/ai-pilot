# 对《生产架构体检·问题清单》的逐条核实与综合裁决(2026-07-22)

> 输入:用户上传的 `ARCH_REVIEW_2026-07-22.md`(一份**无生产访问权**的静态审查,基线 877e51d)。
> 方法:三路 Opus 子代理逐条到代码验真伪 + 生产 .env/DB 只读核实(HEAD 7638a01),再与本项目此前「五路生产审计」交叉。
> 一句话:**这份清单质量高、绝大多数机理属实,没有一条纯属捏造;但因作者拿不到生产配置,它系统性高估了「默认不安全」类 P0,同时也挖出了我们五路审计漏掉的几个真问题。**

---

## 0. 最重要的结论:三把「锁」在生产是锁好的

清单把最高优先级给了「10 分钟核对 .env 三把锁」,并诚实标注了【待核实 prod】。生产实测结果:

| 清单声明 | 生产 .env 实测 | 裁决 |
|---|---|---|
| P0-1 JWT = 明文 userId,改 header 即冒充 | `APP_JWT_REQUIRED=true` + `APP_JWT_SECRET` 长度 64 | **已缓解**,裸 userId token 失效 |
| P0-2 短信免验证码即可登录他人 | `SMS_REQUIRE_CODE=true` + `SMS_PROVIDER=aliyun` | **已缓解** |
| P0-3 后台默认主密钥 | `ADMIN_TOKEN` 64 位随机(上轮已测) | **已缓解** |

**这三条是原清单标称的 P0 主体。生产实配下全部不成立。** 教训:静态审查对「押在环境变量上的安全」只能报「可能敞开」,不能定性——真伪必须落到生产配置。

---

## 1. 真问题裁决表(全部逐条核实过)

### 与我们五路审计互相印证的(确认真问题,已在既有报告中)
| 编号 | 问题 | 裁决 | 现在/开卖后 |
|---|---|---|---|
| P0-4 | 单机 PG 无自动备份/副本/PITR | 属实 | **现在** · P0 |
| P0-5 | `prisma db push` 上线,无迁移史无回滚 | 属实 | 现在 · P1 |
| P0-8 | 客户端断连不感知,生成照跑照扣额度 | 属实(补全:无 close 监听 + AbortSignal 链断在路由层,修复动 3 层 ~6 函数) | **现在** · 中 |
| P1-2 | 无优雅退出,部署掐断在途流/漏 Chromium/漏预留 | 属实 | 现在 · P1 |
| P1-3 | audit_log 每请求写、无索引、被热路径读 | 属实 | 现在 · P1 |
| P1-4 | 进程内定时器,上第二实例即重复推送/双花 | 属实 | 扩容时 · P1 |
| P1-5 | credit_ledger 无索引,每次余额读全表扫 | 属实 | 现在 · P1 |
| P1-10 | 回调验签 fail-open + 不校验 timestamp 新鲜度 | 属实(重放因 per-outTradeNo 幂等而无害,但校验缺失属实) | 开卖后 · P1 |
| P1-16 | 输出侧零审核 + 输入 fail-open + 默认 4 词 | 属实(生产 `MODERATION_ENABLED=true` 但 provider=keyword、fail-open 默认) | 开卖后 · 合规 |

### ⭐ 我们五路审计漏掉、这份清单挖出的真问题(最有价值)
| 编号 | 问题 | 裁决 | 严重度 | 修法 |
|---|---|---|---|---|
| **P1-14** | `APP_ENCRYPTION_KEY` 错配 → 全站静默降级 mock 模板,零报错零 trace,且 `AI_FALLBACK_MOCK=false` **挡不住**(走的是「无 live provider」正常分支,不经 catch) | 属实·高危 | 潜伏 | 区分「密文解密失败」与「本就选 mock」,前者在 fallback=false 下抛 503 + trace 一条 `decrypt_failed`。**注:生产当前 `APP_ENCRYPTION_KEY` 未设→明文透传→暂无解密可失败,该雷休眠;但一旦启用加密即激活** |
| **P1-6** | 微信商户后台直接退款 → 本地订单仍 `applied`,`REFUND` 回调 `updateMany` 匹配 0 行 → 不撤权益/不追钻/无对账 sweep 兜底 | 属实 | 开卖后·资损 | `markRefundNotified` 改为按 outTradeNo 取单,若 `appliedAt` 存在则跑 `revokeOrderGrant` |
| **P1-15** | 辅助 LLM 调用(extractInsights 每轮、extractProphecies 每次总军师输出、势研判、履历)普遍不入 llm_trace、多数不扣额度 → 真实成本系统性低估 | 属实 | **现在就在低估** | rawText/rawJson 系加轻量 trace + token_usage |
| **sanitizeDeliverable 误杀** | `gateway.ts:62` 反串味正则含「代码库/repository/IDE/工作区」等宽泛词 → 面向 SaaS/开发者客户的正当战略报告被判串味、静默换成废 mock 模板 | 属实 | 现在·细分客群 | 正则剔除宽泛技术名词,只留明确的 Codex 串味短语 |
| **P2-② degraded 仍扣钻石** | 图片类 agent 产出 degraded 时只退 token 额度,**钻石预留不退**(degraded 正常返回不抛错,退款只在 catch 里) | 属实 | 开卖后·两轴资损 | degraded 时对 credit 预留也 refund |
| **P1-7** | SKU 赠送尾部写 0 额备注流水时未持 credit advisory lock(拿的是 storage 锁,命名空间不同),与并发扣钻竞态可冲掉扣减 | 属实 | 开卖后·窄窗资损 | 该流水前也取 `credit:userId` 锁 |
| **A3 pgvector 维度雷** | `prisma/pgvector.sql` 硬编码 `vector(256)`,而生产真实嵌入是 bge-m3 **1024 维**;upsert 维度错被 `.catch(()=>{})` 吞 → 谁开 `PGVECTOR_ENABLED` 谁全线静默空召回 | 属实·定时炸弹 | 潜伏(现 `PGVECTOR_ENABLED=false`、`embedding_vec` 列未建) | SQL 维度改为读配置;upsert 的吞错加告警 |

### 机理属实、但生产实配下当前未触发(扩容/多租户悬崖)
| 编号 | 问题 | 为何当前无害 |
|---|---|---|
| P0-6 | 检索 `take:2000` 无 orderBy | 生产最大租户仅 528 切片 ≪ 2000;`PGVECTOR_ENABLED=false` 时这是唯一路径。破 2000 即静默丢召回 |
| P0-7 | 确认文档在请求内串行远程嵌入 | 属实真隐患:生产用真实 bge-m3,大批量确认有超时 + 中途失败不回滚(无事务/无 per-item catch)。是**现役动线**,建议修 |
| P1-11 | search_knowledge 漏传 userId | 一人一租户,tenantId 已等价隔离;多人 seat 化才变越权 |
| P1-12 | pgvector 空不回退 | 同 A3,pgvector 全线休眠 |
| P0-9 | Claude provider 无 timeout/maxRetries | 生产走 openai 路径,`claude.ts` 当前不被调用;切到 provider=claude 端点即引爆 |
| P1-1 | 鉴权靠每路由手动 resolveUser | 现有全部路由已挂 resolveUser(无漏);价值是防回归加固,非现行漏洞 |

### 部分属实 / 被高估 / 已过时(需向作者纠偏)
| 编号 | 原判 | 纠偏 |
|---|---|---|
| P1-8 | 「并发双发放 → 用户得 2 年 + 双倍算力」 | 两单都成 = 微信两次独立扣款(付两次得两次,非资损);token 额度是 setQuota 覆盖**不翻倍**,仅钻石叠加。属重复购买 UX 问题 |
| P1-9 | 「admin 退款非原子 → 永停 applied」 | 退款单号确定 + 微信按 out_refund_no 幂等,**admin 手动重试可自愈**;无自动兜底属实,但非「永停」 |
| P2 假流式 | 暗示「普通对话假流式」 | **已过时**:普通对话自 7/4 (4ecc6e6) 起真原生流式。假流式只剩**报告路径**(整段 await + sleep 分段 + 无心跳 + 无 `X-Accel-Buffering`),这条对报告成立,是 60s 超时事故根因 |
| P2 工具步 20s | 「非流式/工具步 20s 偏紧」 | 以偏概全:报告工具步实为 120s,只有对话工具步 20s;纯调参项 |
| P1-13 | 「未配 EMBEDDING_MODEL→语义召回实为词法哈希」 | 生产已配 bge-m3 走真实 1024 维,此主张不成立。但「单次远程嵌入失败→静默回退 256 维→与库内 1024 维余弦恒 0→该次查询语义分清零」是真实静默降级面 |
| P0-1/2/3 | 三把锁 | 见第 0 节,生产已锁好 |

---

## 2. 附带的独立新发现(非清单声明,子代理顺手查到)

- **`APP_ENCRYPTION_KEY` 未设 → 生产 `ai_setting.apiKey` 明文存库**。安全降级项(AI provider 密钥明文)。这也解释了 P1-14 当前休眠。
- **`.env` 内 `SMS_REQUIRE_CODE` 重复出现两行**(值都是 true,无害,建议清理)。
- **全站 SSE 缺 `X-Accel-Buffering: no`**,对普通对话真流式也构成 nginx 缓冲隐患,不止报告路径。
- **`void processDocument` 悬空无对账**:进程崩溃会让条目永卡 parsing/embedding(生产当前 0 积压,但无 reconcile/cron 兜底)。

---

## 3. 合并后的优先级(结合五路审计 + 本次核实)

**开卖前必须(P0,与既有体检报告合并):**
1. 微信支付六件套接通 + 真实小额端到端(既有 P0)
2. PG 自动备份 + 异地/快照 + 恢复演练(P0-4,既有 P0)
3. 合规:生成式 AI 备案 + 内容审核输出侧回接 fail-closed(P1-16 + 既有 P0)
4. 体验版额度改回正常值 + bumpFreeQuota 刷存量(**用户确认 10M 是临时测试值**)
5. `NODE_ENV=production`(既有 P0,收回沙箱护栏)

**开卖前应做(P1,本次新增的真问题优先):**
6. ⭐ **P1-6 商户后台退款闭环**——开卖即资损口
7. ⭐ **P1-14 加密密钥错配的静默 mock 防护**——加 trace + fallback=false 下抛 503(即便当前休眠,启用加密前必须先修)
8. ⭐ **sanitizeDeliverable 正则收窄**——别误杀 SaaS 客户报告
9. ⭐ **P2-② degraded 退钻石** + **P1-7 SKU 账本加锁**——两轴计费对齐
10. **P1-15 辅助调用计量**——补 token_usage,让成本可见(定价依赖它)
11. **P0-8 断连即停生成/停结算**——止住现役 token 泄漏
12. **P0-7 确认文档改异步/加 per-item 容错**——现役动线
13. audit_log/credit_ledger 加索引 + 优雅退出 + 定时器单实例化(既有 P1)

**潜伏/扩容前(P2):**
14. `pgvector.sql` 维度对齐 1024(开 pgvector 前必修)
15. Claude provider 补 timeout(切 claude 端点前必修)
16. httpTool redirect:manual + 每跳校验;报告路径加心跳 + `X-Accel-Buffering`
17. db push → prisma migrate;日志表 TTL/分区;鉴权全局 preHandler 兜底
18. 记忆滚动摘要(长期军师定位的架构演进)

---

## 4. 对这份清单的总评

- **可信度高**:7 条支付声明无一纯伪;网关/RAG 声明机理基本都对。作者工程功底扎实,把「待核实 prod」标得很诚实。
- **主要偏差来自没有生产访问权**:三把锁、Claude 超时、RAG 静默降级这些「押在配置上」的问题被按最坏默认值定性为 P0,而生产实配把其中多数降级为潜伏或已缓解。
- **最大增量价值**:P1-6、P1-14、P1-15、sanitizeDeliverable 误杀、P2-②——这几条是我们此前五路生产审计确实没覆盖到的真问题,值得直接进整改 backlog。
