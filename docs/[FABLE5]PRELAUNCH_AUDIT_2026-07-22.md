# 军师·正式售卖前整体体检报告(2026-07-22)

> 方法:五路并行审计交叉验证 —— ①生产数据库只读审计 ②生产日志/基础设施只读巡检 ③计费支付代码审查 ④架构生产就绪度审查 ⑤合规与商业化缺口核查。所有生产操作严格只读。文中数字均来自真实查询/日志,标注「未验证」处为无法核实项。

## 总判断

**当前系统不具备对外售卖条件,且卡点不在代码质量。** 支付/计费/鉴权的代码内核是全仓最扎实的部分(幂等、发货原子性、advisory-lock 防双花、掉单三重补偿均已到位),但:

1. **收款能力实际为零** —— 生产未配微信支付凭据,真实用户点购买全部 501;`payment_order` 全时段 0 行,整套支付状态机从未被真实资金流验证过。
2. **合规硬门槛全未过** —— 生成式 AI 备案/算法备案 + 小程序 AI 类目、内容安全真落地、协议隐私文本,当前过不了微信 AI 类目审核。备案是 ~1 个月的最长关键路径。
3. **商业模型自相矛盾** —— 免费档月度 token 额度(10M)是付费档(1M)的 10 倍,付费价值主张被击穿。
4. **数据资产裸奔** —— 数据库零备份、零监控告警、SSL 证书 41 天后到期且无自动续期。

**建议节奏:立即启动备案(关键路径),并行 1–2 周工程整改(下面 P0/P1 清单),小额真实支付端到端验证 + preprod 计费生命周期演练后,再开卖。**

---

## P0 —— 不解决不能卖

| # | 问题 | 证据 | 动作 |
|---|------|------|------|
| 1 | **微信支付未接通**:prod `.env` 无任何 `WECHAT_PAY_*` 键,`payConfigured()`=false;真实小程序用户 6/25、7/3、7/5、7/9 下单均得 501 `PAYMENT_NOT_CONFIGURED`;`payment_order` 0 行,notify/发货/退款零真实样本 | 日志+DB+代码三路交叉 | 配齐 v3 六件套(MCHID/APIV3_KEY/CERT_SERIAL/PRIVATE_KEY/NOTIFY_URL/平台证书),用真实小额支付跑通 created→paid→notify 验签→applied→退款全链路 |
| 2 | **数据库零备份**:全服务器无任何 pg_dump 定时任务(crontab/cron.d/cron.daily/timers 全空),全盘无 dump 文件;单机单库无从库无快照 | 基础设施巡检 | systemd timer 定时 pg_dump + OSS 异地存档 + 恢复演练;`.env`/证书一并备份 |
| 3 | **合规三大硬门槛**:①生成式 AI「双备案」(算法备案+大模型登记)+小程序补「深度合成/AI问答」类目——用第三方模型 API 也须办(封装成独立服务即为「服务提供者」);②ICP:aibuzz.cn 备案主体须与小程序主体/支付商户一致,经营性 ICP 按属地通管局核实;③内容安全:输出侧审核在 7/4 流式化提交(4ecc6e6)中被整体移除至今未回补,输入侧词表仅 4 个演示词、默认 fail-open | 合规审查(来源见附录)+代码核实 | 立即启动备案(约 1 个月,最长关键路径);把 `moderate()` 回接到输出路径(流式可对累积文本分段审),接真实审核服务,日志留存≥6 个月,改 fail-closed |
| 4 | **免费/付费额度倒挂**:体验版(¥0)10,000,000 token/月 vs 决策版(¥198/月)1,000,000;生产 DB 与 `seedConfig.ts:60` 一致,是源头设计而非漂移。按实测 chat 均 31.6K token/次,付费档仅够 ~32 次对话/月;免费档则是薅羊毛靶心(注册即得,永不过期,按月无限重置,注册无 IP/设备频控) | DB 审计+计费审查 | 重新定价三档额度(免费建议 ≤200K);改后必须跑 `bumpFreeQuota` 刷存量钱包(额度是购买时快照,改 plan 不影响老用户) |
| 5 | **生产 `NODE_ENV` 未设置(已确认)**:所有 `NODE_ENV==='production'` 条件的 fail-safe 恒不生效——`assertSandboxSafe` 沙箱护栏、SMS devcode 屏蔽、`index.ts` 启动安全告警全部被架空。当前因 `PAY_SANDBOX`/`ALLOW_DEMO_PURCHASE` 恰好未设而侥幸安全 | 代码审查+prod 实测 | systemd 单元或 prod `.env` 显式加 `NODE_ENV=production`(一行修复);同时核实 `SMS_REQUIRE_CODE=true`、`SMS_PROVIDER=aliyun`(未验证) |
| 6 | **协议/隐私空壳 + 微信隐私接口未接**:登录页「登录即同意」纯文本不可点;协议/隐私全文只是设置页两句硬编码常量;未配《小程序隐私保护指引》、未接 `wx.requirePrivacyAuthorize`(不配则头像/手机号接口会失败,且是上架硬要求);收集了手机号/微信标识/上传文档/生辰(敏感)但披露不实 | 合规审查(app/src/components/Login/index.tsx:363 等) | 法务出全文 → 登录页可点可读+显式勾选;后台配隐私保护指引+接授权接口;敏感信息(生辰)单独同意 |
| 7 | **发票能力完全缺失**:全仓 0 命中,对企业客户(决策版/企业版)售卖为刚需 | 计费+合规两路 | 先行「客服登记+人工开票」流程兜底,再接电子发票 |

## P1 —— 会出事故/客诉/成本盲区(开卖前应完成)

**线上已在发生的:**
- **temperature=0.7 与 qnaigc Opus thinking 模式冲突 → 400 硬报错**:llm_trace 36/419 错误,7/20 错误率 14.3%;约 24 条用户消息没收到回复。修法:`ai_setting.temperature` 改 1 或关 thinking。这是当下真实吞用户产出的 bug。
- **AI 网关超时(60s AbortError)间歇发生**,无重试/退避/熔断,一次瞬时失败即用户可见报错(`AI_FALLBACK_MOCK=false`)。

**售卖链路:**
- **计费生命周期生产从未触发**:37 个用户全部 `planActivatedAt=NULL`/`planExpiresAt=NULL`,「按激活日月度重置」「到期只读锁」两条核心逻辑零真实运行。→ 在 preprod 用带真实时间的订阅演练一轮。
- **回调验签 fail-open**:平台证书缺失且自动下载失败时 `verifyNotifySignature` 直接放行(wechatPay.ts:300)。配平台证书使其 fail-closed。
- **无用户侧退款入口、无部分退款**:仅 admin 全额退;年付用 3 个月只能全退或不退;重度使用后全额退=资损缺口。另缺:退款政策文本、客服入口(`open-type=contact`)、购买须知前置。
- **AI 生成内容标识**(《标识办法》2025-09-01 已强制):报告/对话/导出文件加显式「AI 生成」标识+文件元数据隐式标识。
- **Dify 路径不计量**(usage.ts:33 totalTokens≤0 直接 return):确认线上无 Dify 计费路径,或补计量。
- **免费注册防薅**:注册 IP/设备频控目前为零,唯一门槛是一手机号一账号。

**基础设施:**
- **零监控告警**:无 APM/uptime/错误告警/云监控指标报警;junshi 崩溃、证书过期、磁盘写满无人会被通知。至少:uptime 探活(/api/health,且健康检查应加 DB ping)+ 证书/磁盘告警 + 「paid 未 applied」资损告警。
- **SSL 证书 9/1 到期,无自动续期**(手动放置的 90 天 DigiCert)。上 acme.sh 或设提醒。
- **全站无限流**:nginx 无 limit_req,应用无 rate-limit 依赖;SMS/AI 生成/下单等成本型接口零防刷;fail2ban/firewalld 均未启用;admin 静态站公网可达无 IP 白名单(API 层有鉴权)。机器常态被扫描器扫(.env/.git 探测各 30+ 次,均 404)。
- **无优雅停机/无全局错误兜底**:全仓无 SIGTERM/unhandledRejection 处理;每次发版硬切,在途 SSE/报告生成全丢、预扣未结算悬空(预扣泄漏无对账补偿)。
- **audit_log 零索引 + 每请求写一行 + scheduler 每轮 per-user findFirst 查它** —— 上量后最先崩的 DB 点;credit_ledger 也无索引(热计费路径按 createdAt 扫)。加 `@@index([userId, action, createdAt])`/`[createdAt]`、`[userId, createdAt]`。
- **无 swap**:同机挤着 Dify(~1.7G)+mino+preprod+双 Chrome,available 仅 3.2G,突发并发 OOM 无缓冲。
- **错误日志无级别**:pino 只有 level:30,应用错误全走 console.error → 无法按 error 级做告警。

**成本口径:**
- `ai_model.priceInput/priceOutput=1`(≈1 元/百万 token)是占位价,成本统计严重低估,单位经济算不准。按真实网关价格回填。
- SSE 断流后生成继续跑完(成本照付);额度只封月总量不封速率,单账号可几分钟烧光整月额度打出账单尖峰。

## P2 —— 改进(开卖后 90 天内)

- scheduler 单主化(横向扩前置;当前多实例会重复推送微信订阅消息)、报告/PDF 出请求路径进队列、Puppeteer 拆独立 worker、外部依赖 retry+熔断、AbortSignal 透传止血断流成本。
- 大表归档策略(message/audit_log/llm_trace/token_usage 只增不删)、`db push`→`prisma migrate`、发布脚本内置 pre-deploy pg_dump+一键回滚、API 版本化(/api/v1,旧版小程序兼容)。
- Agent 版本快照机制 14 个只覆盖 1 个(general),其余 13 个 C 端裸读草稿行,后台误改立即生效无回退。
- 前端「我的订单/继续支付」入口(后端 /pay/orders 已就绪)、admin 手动补发 SKU、`current` 套餐判断按 planId 不按名称。
- 日常运维:logrotate 实际从不执行(cron.daily 为空)、journald 无上限、部署 3s 空档 502、4000/4001/4100 绑 0.0.0.0 全靠安全组单层、CORS origin:true、JWT 无吊销机制、未成年人声明、数据导出(PIPL 可携带权)。
- `db:sync-plans` 会把 seedConfig 覆盖回 DB(运营在 admin 改价后跑它=回退),固化「价格真相源」流程。

## 产品侧观察(不阻断,但决定卖不卖得动)

- 37 注册用户中 **17 人(46%)从未发过一条消息**;注册满 7 天的最早 4 人近 7 天回访 0;活跃集中在 7/16–7/21 一次拉新爆发,无日活底盘。
- 钻石账完全平(37 用户流水与余额零不匹配),token 扣减真实生效,数据结构极干净(零孤儿/零倒挂)——数据质量本身可放心。

## 交叉验证修正记录(单路结论被其他路推翻的)

1. 「`moderate()` 生产零调用」(合规路)——**误报**,macOS BSD grep 不支持 `\|` 交替所致。实际输入侧四处已接(gateway.ts:236/296/416/476,与生产 511 条 moderation_log 吻合);**输出侧确于 4ecc6e6 被移除**。
2. 「日志泄漏 13419 个手机号」(基础设施路初筛)——**误报**,是 pino 毫秒时间戳;精确 JSON 字段复核为 0,脱敏合格。
3. 「JWT/ADMIN_TOKEN 默认空/弱值」(架构路,基于 .env.example)——**生产实测已配** 64 位随机值,该项从 P0 降为「模板默认不安全,需固化部署检查清单」。`SMS_REQUIRE_CODE`/`APP_ENCRYPTION_KEY` 生产值仍未验证。

## 已达标清单(审计确认无需动)

回调幂等与恰好一次发货(advisory lock + appliedAt 认领)、金额/appid/mchid 串单校验、发货事务原子性、掉单三重补偿(轮询/5min sweep/admin 补账)、并发透支有界(悲观预留)、钻石不打负、月转年折算反套利双封顶、下单金额服务端计算+条款快照、admin 95 路由鉴权无漏挂、SSRF 防护(私网/元数据拒绝)、SQL 注入面干净(raw 仅参数化 advisory lock)、cuid 不可枚举、SMS 限频、日志脱敏、CI 全量测试(77 文件,mock 隔离真实外呼)、服务 30 天零崩溃零 OOM。

## 行动路线

**本周(并行启动):**
1. 启动生成式 AI 备案/算法备案 + 小程序类目变更(关键路径 ~1 个月,材料先行)。
2. 一行修复:`NODE_ENV=production`;`ai_setting.temperature` 冲突修复;SSL 续期方案。
3. pg_dump 定时备份 + OSS 存档(半天工作量,消掉最大不可逆风险)。

**开卖前(1–2 周工程包):**
4. 微信支付六件套配置 + 真实小额端到端(含退款);preprod 演练付费订阅完整生命周期(激活/月度重置/到期锁)。
5. 三档额度重新定价 + bumpFreeQuota 刷存量;注册防薅频控。
6. 内容安全:输出侧审核回接 + 真实审核 provider + fail-closed;AI 生成标识。
7. 协议/隐私全文 + 登录勾选 + 微信隐私保护指引;客服入口 + 退款政策;人工开票流程。
8. 监控告警最小集(uptime/证书/磁盘/paid-unapplied);nginx 限流(sms/generate/order);audit_log+credit_ledger 索引;优雅停机+全局错误兜底。

**开卖后 90 天:** P2 清单(队列化、归档、migrate、灰度回滚、API 版本化、横向扩就绪)。
