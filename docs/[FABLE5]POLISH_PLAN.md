# 军师小程序 · 精细打磨方案（不做减法，逐功能捋顺补全）

## 1. 一句话总判断 + 最该先打磨的事

**一句话总判断**：军师的服务端地基（四本账本、知识上传解析、双轴计费、案卷军令）其实做得很干净、数字大多"服务端算好、null 不编"；但**产品层的"信任叙事"正在被三类不自洽反噬**——① prompt 还在指令 AI 自产命中率/准确率/五维分，和服务端权威账本同屏打架；② 主线总军师根本不写记忆、诊断轮次换会话就清零，UI 却全程宣称"我一直在学、比你自己更懂你"；③ 一批留存关键动线（月/周复盘、悬念钩子、里程碑、陪跑保底、账本验证）在**记账/展示层做了、兑现/闭环层没接**。当务之急不是加新功能，而是把这些"承诺了但不兑现"的裂缝逐条焊死。

**最该先打磨的 8 件事（跨功能，按优先级）**：

1. **【P0·prompt 去机制化】** strat.v6.md 仍指令 AI 自出"预言/决策日志"并自报"命中率 67%/准确率 XX%"，与已注入的权威账本块同屏冲突，用户一屏看到两个命中率。→ 删所有账本条目生产与命中率自算指令，改"账本以注入块为准、禁编数字"，走 agent_version 发布。(A-1 / prompt-1)
2. **【P0·伪量化】** prompt 要五维健康度 0-100 分/团队战斗力，但服务端全无口径与注入块，纯 LLM 现编，用户拿假分做经营判断。→ prompt 先禁止无授权口径的分值。(P-12 / prompt-2 / ledger-4)
3. **【P0·悬念钩子失约】** prompt 强制每次埋"下周二来找我"死时间钩子，但无 Hook 模型、无到期注入、无 job，用户回来时系统毫无记忆、反复失约。→ 止血改开放式钩子；再排 SuspenseHook 落库+到期注入。(F-2 / hook-1)
4. **【P1·诊断轮次会话级丢失】** 轮次按当前会话 history 现算，换会话/删消息即归零，军师重新采八字，六轮主线一次误操作清零。→ 建 UserJourney.diagRound 用户级持久化。(F-5)
5. **【P1·总军师记忆空转+印象伪数据】** general 四分支全短路记忆学习、从不写记忆，但顶部"印象条"读死全用户同一份静态模板、"已校准"气泡去重命中时误报。→ general 写用户级共享事实池、印象条改真实记忆驱动。(A-3)
6. **【P1·计费×陪跑不自洽】** grace 只认日复盘硬前缀，月/周/季/年复盘与追问全被 402 拦——系统一边把月复盘当留存关键接住一边计费不保底。→ grace 改复用 detectIntent 的 `mode==='review'`，提前到 reserveQuota 前算。(A-8 / grace-1)
7. **【P1·分享无 ACL/TTL+无脱敏】** `/api/r/:id` 凭 cuid 永久公开无鉴权，每日战报卡把 leads/consults/deals 原始数字渲进公开页还引导"发朋友圈"，竞对可看真实成交量。→ 加 expiresAt/撤销 + mode='public' 脱敏默认对外链接。(F-9/P-5)
8. **【P1·账本闭环没接通】** verify 四接口已备但 App 从不调、无账本页，条目永停 pending，accuracy/hitRate 长期 null，将军/元帅不可达；且无最小样本保护，1 条验证即出 0%/100% 直接喂晋升。→ 补 App 账本页+verify 入口+n<5 返回 null。(F-8/P-2 / ledger-1/ledger-2)

> 命理合规 P-3：fortune 功能区本次 currentLogic 仅占位、findings 为空，无对应可执行 finding，待该区补完 review 后单独成批（见取舍点 6）。

---

## 2. 逐功能打磨清单

### 2.1 对话·参谋室（dispatch）

**现状**：chat 页是主对话入口，顶部"军师印象条"读 agents.ts 静态模板、参谋室导轨用 council.ts 渲染派单 chips、加号 @引用、"生成纪要"。后端 resolveMode 确定性路由 + buildGenContext 注入，非 general 结束后写 Memory（用户×agentKey 隔离），general 被排除。诊断轮次按 history 现算不落库。

| 优先级 | 问题 | 怎么捋顺/打磨 | 涉及文件 | docRef |
|---|---|---|---|---|
| P1 | general 四分支全短路记忆学习，Memory 表 general 恒 0 行，UI 却宣称"持续学习/记住偏好" | general 也走 learnFromConversation 写共享 agentKey（用户级事实池），recall 时并入；未建前先把 memText/learnText 文案对齐真实能力 | sessions.ts:214/252/402/458, chat/index.tsx:648/719 | A-3 |
| P1 | "军师印象"是全用户同一份静态模板冒充真实记忆；"已校准"气泡去重命中/空写入时误报 | 印象条改服务端真实数据驱动（返回该用户×agent Top-N 记忆摘要），无记忆显"还在了解你"；learnText 由真实写入结果决定（去重"已巩固"、空则不播） | chat/index.tsx:649/652/778, agents.ts:32/54 | A-3 |
| P1 | 派单/回流只 redirectTo fresh 新会话塞死 prompt，上一线程结论不随行，换军师要重讲 | openThread 携 sourceSessionId，新会话首轮注入"来自 X 线程结论摘要"（复用 summarize 折叠）；回流把结论回写共享记忆 | chat/index.tsx:486/672/680, council.ts:41 | A-3 |
| P1 | 诊断轮次按当前会话 history 现算，换/删会话即归零且军师无感 | 建 UserJourney.diagRound 用户级持久化，context.ts 改读它；过渡期按 general 最近会话链累计 | context.ts:116/117/118, sessions/index.tsx:81 | F-5 |
| P1 | 模式路由纯关键词，口语复盘漏匹配即走错模式、不落账、且保底另用更严前缀（双重惩罚），无兜底无补录 | 保留确定性快路径 + 轻量 LLM 意图兜底（失败回落 strategy 禁臆造）；命中补 recordReview+保底；加事后补录入口 | intent.ts:34/40, sessions.ts:186/340 | A-2 |
| P2 | @引用"军师印象"在总军师线程恒空，专业军师也只 @ 到自己记忆 | 与共享事实池联动合并展示；短期先对 general 放宽 agentKey 过滤 | chat/index.tsx:602/914, memories.ts:22 | A-3 |
| P3 | @记忆引用 label 恒"一段记忆"，与 picker 不一致不可溯源 | label 对齐其它类型：记忆摘要+来源军师名，注入 label 与用户可见一致 | retrieval.ts:179/180, chat/index.tsx:914 | A-3 |

### 2.2 战局·六轮诊断（diagnosis）

> 已补跑，详见文末「补跑 · 战局诊断 + 命理」一节（6 条 finding）。

### 2.3 执行·案卷·军令（execution）

**现状**：server 模式案卷已服务端化——认可方案 extractOrders 拆军令（accepted 统一 aligned:true）、打卡/手动加军令/三数回填有接口、day 复盘落 ReviewLog、每日战报卡真实账本渲染。month/week 复盘只能靠聊天触发词落库且复用 day 快照无周期聚合。

| 优先级 | 问题 | 怎么捋顺/打磨 | 涉及文件 | docRef |
|---|---|---|---|---|
| P1 | 周/月复盘落库复用 day 快照（date=今天、只查当天军令、无跨周月聚合）产错账；无【本月数据】块 AI 现编月度数字（违反铁律①） | recordReview 按 layer 聚合区间 + date 存周期锚点；context.ts 新增【本月/本周数据】注入块（服务端聚合+环比，块尾禁算口径） | sessions.ts:189/372, reviewLog.ts:32/44, intent.ts:98 | A-4/WO-04 |
| P2 | REMINDERS 展示 09:00 军令+周五周复盘，scheduler 无对应 job，只订到 21:30 那条 | 补齐后端 09:00 军令+周五周复盘 job（复用 scan 骨架+幂等），subscribeReview 扩 order/review/week 三类；或止血加"即将上线"标注 | studio/index.tsx:22/452, scheduler.ts:193 | F-4 |
| P2 | 对齐率恒 100%/被 null 稀释：认可军令写死 aligned:true、手动军令 null，逐条判定未建，是"是否认可来源"非"是否对齐主要矛盾" | 短期标签改"认可军令占比"或暂隐藏；中期认可/复盘时结构化 LLM 判定每条对齐 judgment 并回写 aligned（服务端落库非现算） | casefile.ts:186, casefiles.ts:75, reviewLog.ts:44, cardHtml.ts:90 | C-4/P-12 |
| P2 | 执行页无月/周战报入口：周 tab 只军令罗列，月复盘只能碰对触发词 | 复盘区加"生成周复盘""生成上月战报"按钮：startReview('week'\|'month') 落账+goChat 发确定性 prompt，绕开路由脆弱 | studio/index.tsx:116/413, dossier.ts:260 | F-1/WO-04 |
| P3 | 目标阶梯四格恒"待拆解"：无后端模型/契约，点击只跳对话 | 建目标阶梯结构化落库、拆解后回写、执行页读真实值；未建前显式标"军师拆解后固化"引导态 | studio/index.tsx:277/279 | A-11/P-12 |
| P3 | 多业务线无法并行：Casefile 用户级唯一 active，第二战线军令/回填无处安放 | 建多案卷（业务线维度+案卷切换+新建独立案卷，按 casefileId 隔离），扩张期分期，默认仍单案卷 | casefile.ts:85/139, casefiles.ts:24 | P-11 |

### 2.4 复盘六层（review）

**现状**：执行页 startReview('day') 落 day 账+带真实数据跳对话；"周计划"tab 只读不落账。后端 recordReview 只做 day 逻辑、reviewStreak 只数 day、reviewBriefing 注入"连续天数+最近快照"。intent 能识别全 6 层触发词。mock 复盘全惰性。

| 优先级 | 问题 | 怎么捋顺/打磨 | 涉及文件 | docRef |
|---|---|---|---|---|
| P1 | week/month/quarter/year/team 只快照"当天"军令并标错日期（date=今天），非周期聚合 | recordReview 按 layer 算周期区间、date 存锚点，对 order 与 metric 按区间求和/计数，口径与注入块一致 | reviewLog.ts:31/37/52, sessions.ts:189 | A-4/C-7/WO-04 |
| P1 | day 以上五层无 UI 入口落账，只能靠聊天碰对触发词（可发现性≈0） | 复盘区加周复盘/月战报确定性按钮（月战报每月1日后），发预定义 prompt+startReview 落账；layer 白名单补齐六层 | studio/index.tsx:115/413/289, dossier.ts:260 | F-1/WO-04 |
| P1 | 段位"校官"依赖 month 账，而 month 账只能靠脆弱触发词，一次漏匹配卡死激励链 | ①月战报确定性按钮；②detectIntent 兜底放宽；③补录路径。让门槛可达而非降门槛 | progress.ts:62/39, intent.ts:28/40 | A-2/A-4 |
| P2 | day 对齐率把"未标注对齐"手动军令算作未对齐，注入 0% 伪数据（违反铁律①） | 分母改"aligned 非 null 的军令数"，null 不进分子分母；分母 0 时 alignRate=null；中期补 M2 逐条标注 | reviewLog.ts:40/44/104, casefiles.ts:72 | A-4/铁律① |
| P2 | mock 与 server 分叉：mock 下复盘无账本/连续天数/段位副作用 | mock.ts 建内存复盘账，startReview 记内存返递增 streak，api.reviews 从内存返回 | dossier.ts:261, api.ts:245, mock.ts:639 | A-4/铁律③ |
| P3 (PLAUSIBLE) | day 复盘双重落账：按钮 POST+同句话进 chat 再触发（幂等不重复行但 syncProgress/里程碑素材翻倍、双写口径易分叉） | 收敛单一落账入口：前端只发对话由 sessions.ts 统一落账，或按钮 POST+chat 侧对确定性前缀跳过重复 | studio/index.tsx:116, intent.ts:39, sessions.ts:188, casefiles.ts:138 | A-4 |

### 2.5 智库·资料·知识分析（knowledge）

**现状**：上传链路真实（OSS→异步解析切片 embed→ready），召回被动（hybridSearch 自动注入）。数据源绑定多引导态，行业基准来自 industryPacks。文档承诺的"财务表→经营体检""行业分位基准库"未建。

| 优先级 | 问题 | 怎么捋顺/打磨 | 涉及文件 | docRef |
|---|---|---|---|---|
| P2 | 知识库缺主动分析：财务表上传后无"经营体检"出口，只进不出 | 补：①"经营体检"deliverable 模板；②finParse.ts 抽结构化指标纯代码算存 analysisJson（数字服务端算、prompt 引用【财务摘要】禁推算）；③POST /knowledge/:id/analyze；④前端"生成经营体检"按钮 | knowledge.ts:179, docParse.ts:67, schema.prisma:418, contracts.d.ts:431, work/knowledge/index.tsx:102 | C-3/WO-09 |
| P2 | 资料树"8 类自动归类"伪功能：无分类逻辑、文件夹不可筛选、话术承诺不存在的能力 | ①真做轻分类（LLM/规则打 8 类写 folder，listKnowledgeDocs 支持过滤，叶子带 folder 参数）；②暂不做则话术改"按 8 类整理"去掉"自动归类" | thinktank/index.tsx:143/148/152, operatingSystem.ts:156, knowledge.ts:155 | C-3 |
| P2 | 行业基准双口径同屏冲突：prompt 第八部分硬编码 6 行业静态库 vs industryPacks 注入，含真实公司名+冻结数字 | ①prompt 第八部分改"以【行业基准】块与追问三问为准"，删静态表与公司名；②中期 industryPacks 下沉为 admin 可维护 IndustryBenchmark 表（p25/p50/p75 宁缺勿假） | strat.v6.md:320/342, industryPacks.ts:52, schema.ts:209 | A-9/WO-08 |
| P2 | search_knowledge 内置工具漏传 userId，与另两条召回口径不一（多用户 tenant 越权隐患） | builtin.ts 把 ctx.userId 透传 hybridSearch，与 context.ts:156/knowledge.ts:35 同口径，堵死多用户 tenant 越权面 | builtin.ts:26, context.ts:156, knowledge.ts:35 | C-3/铁律② |
| P3 | mock 与 server 不一致：mock 下资料库永远空、上传空操作，尽管已有 knowledge 存储 | mock.ts 增 knowledgeDocs()（从 d.knowledge 映射），uploadKnowledge mock 真写入，detail/reembed 给最小实现 | api.ts:301/307, mock.ts:829/838 | C-3/铁律③ |

### 2.6 命理·天势·排盘（fortune）

> 已补跑，详见文末「补跑 · 战局诊断 + 命理」一节（8 条 finding，含 2 条 P0 合规红线 P-3/P-4）。

### 2.7 账本·段位·预言（ledger）

**现状**：服务端已建三套账本（决策/预言/段位），准确率/命中率服务端算、无样本 null 不编，三块 briefing 注入（禁自算）。写入侧自动记账无人审。前端只段位卡露三项，无账本查看/修正 UI，verify 路由存在却无 App 入口，contracts 无这三套类型。五维健康度仍要 LLM 现编。

| 优先级 | 问题 | 怎么捋顺/打磨 | 涉及文件 | docRef |
|---|---|---|---|---|
| P1 | 账本只进不出：verify 是把 pending 翻 hit/miss 的唯一路径却 App 从不调，条目永停 pending→accuracy/hitRate 长期 null→将军/元帅不可达 | ①api.ts+mock.ts 增 decisions/prophecies/verify* 方法；②建 packages/work/ledger 双 tab 页；③月复盘对账带出待验证条目让用户点命中/未中 | api.ts:242, decisions.ts:9/38, prophecies.ts:8/34 | F-8/WO-11 |
| P1 | 无最小样本保护：单条验证即产 0%/100% 直接喂晋升（最高段位建立在 n=1 随机变量上） | Stats 加 n<5 门槛（rate=null+sampleTooSmall）；deriveRank 要求 rate 非 null 且过线；段位卡与 briefing 走同一 rate，样本不足显"先打满 5 个验证" | decisionLog.ts:138, prophecyLog.ts:119, progress.ts:37, profile/index.tsx:120 | P-2/WO-11 |
| P2 | 自动记账机器写机器判无审无修正无清理，账本是段位/信任地基却不可核 | 加 disputeNote/disputedAt：异议不直接改状态而标注、下次复盘注入块带出由对话确认再 verify；自动条目给"待确认"软状态或高亮"请核对" | sessions.ts:28, prophecyLog.ts:70, gateway.ts:692, decisionLog.ts:88, casefiles.ts:43 | A-6/WO-11 |
| P2（prompt 侧 P0） | 五维健康度/战略健康度仍由 prompt 要 LLM 现编，服务端零口径（伪量化） | 短期 prompt 去机制化"分值类来自注入块、块里没有的维度不给分"；中期若确需则服务端定义口径落库注入后再引用 | strat.v6.md:538/540/548, cardHtml.ts:104 | P-12/WO-05 |
| P2 | 契约漂移：段位/账本类型不在 contracts.d.ts，前端 ProgressView 手抄缺 rankAchievedAt/promoted/newMilestones | 三套类型收敛进 contracts.d.ts 单一契约源，server 与 app 都 import；删手抄副本补齐三字段 | contracts.d.ts, api.ts:50, progress.ts:17 | WO-11/铁律② |
| P3 | mock 分裂：mock 的 progress 恒 null、无账本 mock | progress() 返真实感 ProgressView，造 6 条决策/预言样例（含 pending/hit/miss、n≥5 才出百分比） | api.ts:242, mock.ts | WO-11/铁律③ |
| P3 | 冷启动曝光门不一致：注入块未按 WO-03 在 streak<3 去百分比，与前端段位卡门槛不一 | progressBriefing 补 streak<3 省略百分比字段；注入门槛与 profile 卡门槛（streak>=3\|\|usageDays>=14）对齐 | progress.ts:122, context.ts:107, profile/index.tsx:113 | WO-03/P-1 |

### 2.8 计费·权益·陪跑保底（billing）

**现状**：双轴计费——钻石管 unlock+image 按张扣，月度 token 额度管文本产出（reserveQuota 预留+settle）。grace 只有 'review' 一类且认硬前缀。mock 独立实现 token 额度但无 grace/过期概念。

| 优先级 | 问题 | 怎么捋顺/打磨 | 涉及文件 | docRef |
|---|---|---|---|---|
| P1 | grace 只认日复盘硬前缀，月/季/年/周复盘与追问全被 402 拦（一边接住记账一边不保底） | grace 资格改复用 detectIntent（mode==='review' 覆盖全 6 层），把 intent 提前到 reserveQuota 前算；GRACE_PER_DAY 按动线上调或分类计数 | sessions.ts:162/340, tokenQuota.ts:148, intent.ts:39 | A-8/P-9 |
| P2 | grace 次数用锁外预查+best-effort audit 计数，并发或审计失败即突破上限 | 计数与放行做同一原子路径：事务/advisory-lock 内查+写计数（或带唯一键的 GraceLog 日计数行），audit 仅旁路观测 | tokenQuota.ts:164/150/177 | A-8 |
| P2 | mock 完全没有复盘保底/grace，与 server 对"额度耗尽复盘能否用"给相反答案 | mock.ts 增同口径 review 保底：识别复盘意图，额度耗尽的复盘每日放行 N 次记透支，其余 402 | mock.ts:172/674/688 | A-8/铁律③ |
| P2 | metered 按次定义了但未接线：text-metered agent 的 price 被静默忽略 | ①sessions.ts 补 metered 分支（billing==='metered' 时 diamondCost=price 走 reserveCredits）；②或修正注释去掉第三档表述 | schema.prisma:130, entitlements.ts:2, sessions.ts:155/334 | P-9 |
| P3 | 产出响应 tokenQuota 用 QuotaState（quota/balance）下发，与契约 TokenQuotaView（limit/remaining）漂移，靠前端不消费侥幸未爆 | 下发前映射成 TokenQuotaView 或 tokenQuota.ts 加 toView() 统一出口；顺带让前端消费产出响应即时刷进度条 | sessions.ts:224/421, tokenQuota.ts:29, contracts.d.ts:214 | P-9/铁律② |
| P3 | 同一 tokenQuota 在 credits 页（ceil clamp[1,100]）与 profile 页（round 无下限）取整不一 | 抽共享 quotaPct 工具两页统一（倾向 ceil+[1,100] 避免小用量抹成 0） | work/credits/index.tsx:88, profile/index.tsx:177 | P-9/铁律③ |
| P3 | 速诊获客保底 grace:'quickscan' 未建（未建非坏） | 落 WO-06 时 grace 放宽为 'review'\|'quickscan'（或 category+perDay 映射），graceUsedToday 按类别分别计数 | tokenQuota.ts:156, REDESIGN_EXEC_SPEC.md:217 | WO-06 |

### 2.9 档案·记忆·上下文注入（profile-mem）

**现状**：个人档案页与"军师印象"条呈现"军师有多懂你"，数据来自 /me understanding。buildGenContext 组装注入链（战略档案+四本账本+understanding+语义召回+命盘/模式）。四本账本服务端化很干净但 prompt 侧未去机制化。

| 优先级 | 问题 | 怎么捋顺/打磨 | 涉及文件 | docRef |
|---|---|---|---|---|
| P0 | V6.0 prompt 仍指令 AI 自产"预言/决策日志 #N"并自报命中率 67%/准确率 XX%，与权威账本块同屏冲突 | prompt 去机制化（v6→v7）：删账本记录格式与命中率自算，改"账本以【天机账本】【决策账本】块为准、禁编条目与任何百分比"；agent_version 发布+UPDATE agent 行 | strat.v6.md:184/194/385/431, agents.ts:115, schema.ts:276 | A-1/WO-05 |
| P0 | prompt 要"战略/五维健康度(0-100)/团队战斗力"但服务端零数据源→纯 LLM 现编 | ①删看板章无数据源评分指令改"分值类来自注入块、块里没有的维度不给分"；②确需则先服务端定义口径做注入块再引用 | strat.v6.md:538/540/443, reviewLog.ts:44, cardHtml.ts:90 | P-12/A-1 |
| P1 | 军师向用户索要系统已持有的"战略档案"让其回传（F-10 荒谬话术） | §9.2 改"战略档案由系统持续沉淀、见【战略档案】块、直接引用，不让用户复制回传"；十九章同步删"接收战略档案" | strat.v6.md:394/396/651, context.ts:99, understanding.ts:183 | F-10/WO-05 |
| P1 | general 全链从不写长期记忆+Memory 按 agentKey 隔离→印象长期空转 | ①general 也 learnFromConversation 写用户级记忆，recall 增"用户级共享事实"与 per-agent 合并；②或专业军师召回并入 general。先做①止血 | sessions.ts:214/252/402/458, memory.ts:53 | A-3 |
| P1 | StrategicProfile 的 narrative/verse 及战略档案 app 端无查看/编辑入口，注释宣称的"手动回写点"不存在→死代码+记错无法纠正 | 补 app 端战略档案查看/编辑入口，api.ts+mock.ts 加 getStrategic/putStrategic 打通 PUT /profile/strategic，让四条战略事实可核对 | strategicProfile.ts:4/78, profile.ts:129, api.ts:1 | A-11/F-8 |
| P2 | understanding 的"战略档案（持续沉淀）"段读 Profile.extraJson.dossier 但生产无写入→永久空，且与真 StrategicProfile 同名混淆 | 优先把数据源改为 loadStrategicProfile（与 strategicBlock 同源）并改名；或补真实写入路径 | understanding.ts:173/183, dossier.seed.md:3, strategicProfile.ts:55 | A-11 |
| P2 | mock understanding maturity 口径不一致：evidenceTotal 漏算 memories、memories 恒 0、无 dossier 段 | mock 把 memories 纳入 evidenceTotal、用真实条数；buildUnderstandingM 补 dossier section 对齐 server 4+1 段 | mock.ts:262/263, understanding.ts:153, brief/index.tsx:113 | 铁律③ |
| P3 | Profile 按 tenantId 取而 Memory/账本按 userId 取，同租户多用户时档案会串（结构性隐患非 live bug） | 给 Profile 加 userId 维度或按 userId 选 Profile；短期至少加注释标"多用户前需补 userId 维度" | context.ts:91, understanding.ts:77, schema.prisma:1016 | A-3 |

### 2.10 提醒·触达·钩子·里程碑（reminder）

**现状**：触达只有一条完整闭环——21:30 复盘。REMINDERS 列三条但只 review 场景有订阅/模板/job。里程碑按"使用天数"解锁、静默写 DB、新解锁信号不注入不下发无补发队列。悬念钩子无登记表/到期注入，prompt 仍强制埋死时间钩子。

| 优先级 | 问题 | 怎么捋顺/打磨 | 涉及文件 | docRef |
|---|---|---|---|---|
| P0 | 悬念钩子无登记表/到期兑现，prompt 仍强制埋"下周二来找我/30天后"死时间钩子→反复失约 | ①止血：§11.1 改开放式钩子删死时间；②补 SuspenseHook 模型+埋钩子落库+scheduler hook-due job+context.ts"待兑现钩子"注入块 | strat.v6.md:472/475, context.ts:106, schema.prisma:1108 | F-2/WO-05 |
| P1 | 里程碑解锁静默：新解锁信号不注入不下发无补发；progressBriefing 每轮先 syncProgress 把 newMilestones 清空 | ①注入"本轮新解锁 X 天请按 §11.2 交付"+映射表；②"标记解锁"与"读注入"解耦（注入只读，或用待交付队列缺席回来补发）；③前端 startReview 接住 progress 弹提示 | progress.ts:78/117/130, dossier.ts:263, casefiles.ts:136 | F-3 |
| P1 | 09:00 军令与周五周复盘前端有展示无后端场景/模板/job | contracts 增 command/weekly 场景+SCENE_META；studio 每行加订阅入口；scheduler 增 morning-command+friday-weekly job（参照幂等骨架） | studio/index.tsx:22/453, contracts.d.ts:572, wechatSubscribe.ts:12, scheduler.ts:138 | F-4 |
| P2 | prompt 里程碑话术说"连续复盘 N 天"，服务端按"使用天数"解锁→同屏数字冲突（触碰铁律①） | §11.2 不写死数字改引用注入块口径；明确里程碑=使用天数语义，prompt 与 progress.ts 注释统一 | strat.v6.md:481, progress.ts:5/65/126 | F-3/铁律① |
| P2 | report 授权与报告生成时序错位：产报告时无额度静默 skip，授权被下一份无关报告消费 | report 授权提前到"报告即将产出"前，或 notifyReportReady 无额度时登记"待通知"标记拿到额度补发对应 reportId；至少记 skipped 原因 | chat/index.tsx:497, sessions.ts:34/127, wechatSubscribe.ts:198 | F-4 |
| P2 | 断档提醒(scanReviewGaps)与每日提醒可同日双发，消耗两次一次性授权 | scanReviewGaps 前也加 hasSentWechatNotificationToday 守卫，或发送侧做当日幂等——当天只发一条优先断档语义 | scheduler.ts:124/154 | F-4/A-7 |
| P3 | scheduler 进程内 setInterval 无分布式锁，扩容/双活即重复触达（当前单实例成立） | 加轻量分布式锁/选主（DB advisory lock 或 lease 表），或发送侧 userId+scene+date 唯一约束幂等；单实例期先加唯一约束 | scheduler.ts:44/193 | A-7 |

### 2.11 报告·交付物·卡片·分享（deliverable）

**现状**：chat 页产出 Deliverable→ReportCard，点"网页版"触发 render_report 落库返 htmlUrl。B 级卡走 cardHtml 三模板、卡上数字全服务端账本算。/api/r/:id 不鉴权无 TTL 凭 cuid 公开。命中率/准确率服务端算好注入（注明禁自算）。

| 优先级 | 问题 | 怎么捋顺/打磨 | 涉及文件 | docRef |
|---|---|---|---|---|
| P1 | 分享链接无 ACL/TTL：cuid 永久公开，含私密经营数字可任意转发；404 文案写"已过期"实则永不过期 | report_html 增 expiresAt（默认 30/90 天、卡片更短）+revokedAt，share 路由查过期返真"已过期"页；增撤销入口；私密数字默认走脱敏版 | reportShare.ts:6, schema.prisma:638, reportHtml.ts:154 | F-9/P-5 |
| P1 | 单一渲染无脱敏：每日战报卡把 leads/consults/deals 原始数字渲进公开页，前端却引导"发朋友圈" | 渲染加 mode('full'\|'public')：public 隐去绝对数字（改趋势/达成态）与命盘细节，分享默认 public、"自用完整版"单独按钮+更短 TTL，话术改"对外可分享版" | reportHtml.ts:45, cardHtml.ts:95, studio/index.tsx:138 | P-5 |
| P2 | 网页版入口只在 chat 实时态；存方案库后 report 页无法再生成/打开分享，htmlUrl 孤悬 message | report 页详情补"生成网页版/打开分享"按钮复用 render_report 幂等接口，htmlUrl 落版本内容或单独 share 记录 | work/report/index.tsx:59, work/library/index.tsx:25, sessions.ts:107 | A-5/F-9 |
| P2 | B 级卡只实现 3/12，A 级七章报告无专用模板→第 6 轮"A×1+B×3"无法兑现（未建非坏） | 补 9 张 B 级卡+A 级七章模板（章节固定、每章数字走账本注入禁 AI 自填），CardKind 扩枚举、路由与 mock 同步扩 | cardHtml.ts:160, cards.ts:9, reportHtml.ts:45 | A-5 |
| P2 | A 级报告 sections 为 LLM 自由文本无统计护栏，prompt 残留 67%/XX% 占位诱导现编 | ①prompt 删硬编码百分比示例改"引用账本块、无块不得给数字、按'尚无样本'口径"（prophecyLog.ts:132 已有口径可复用）；②渲染侧裸百分比且无注入时标注/降级 | schema.ts:138, reportHtml.ts:34, strat.v6.md:197/431 | A-1/D-1 |
| P3 | 分享 HTML 只系统字体栈无自托管子集（安卓中文衬线退化）；H5 壳仍依赖被墙 Google Fonts CDN | 分享 HTML 内联极小 Noto Serif SC 子集或自托管 woff2；H5 壳换自托管或改纯系统栈 | reportHtml.ts:61, cardHtml.ts:26, index.html:10 | A-10 |

### 2.12 处方·生态·journey主线（ecosystem）

**现状**：停在"批次一减法后"地基态。无 Prescription/BrandKit/UserJourney 模型，Deliverable 契约无 prescriptions[]，认可方案只拆军令不产处方。home"下一步卡"用本地启发式不调 /journey，诊断轮次会话级现算。ChatReply.acts 两侧都产出但 chat 页从不渲染是死契约。成果回流/生态账户/漏斗埋点均无代码。

| 优先级 | 问题 | 怎么捋顺/打磨 | 涉及文件 | docRef |
|---|---|---|---|---|
| P1 | assistant 回复的 acts 从不渲染，处方依赖的"现有 acts 机制"实为死契约 | assistant 渲染块补 m.reply.acts?.map 渲染 act 芯片复用 .act-chip，点击按 [icon,label] 语义路由；server/mock 已同口径无需改数据侧 | chat/index.tsx:752-776/336, sessions.ts:484, mock.ts:691, contracts.d.ts:290 | E-1/WO-12 |
| P2 | 处方引擎缺失：无 Prescription 模型、契约无 prescriptions、accept 不落处方（未建非坏） | schema 增 Prescription+迁移；contracts 增类型；accept 扫描 prescriptions[] 经服务端白名单过滤（不在白名单丢弃+审计）落库、按 section 挂 CasefileOrder | schema.prisma:926, contracts.d.ts:279, casefiles.ts:24, casefile.ts:50 | E-1/E-5/WO-12 |
| P2 | journey 状态机未建，home"下一步卡"用本地启发式冒充，无 /journey，三处 tab 不统一（未建非坏） | UserJourney 模型+状态迁移挂钩+deriveNextStep+GET /journey；contracts 增 JourneyView；home 换读 api.journey().nextStep，抽 NextStepCard 三处复用 | schema.prisma:926, home/index.tsx:113, api.ts, mock.ts | L-1/WO-07 |
| P2 | 诊断轮次按会话消息数现算，换/删即清零（F-5）→ 与 dispatch/战局同根，合并修 | 改读 UserJourney.diagRound（会话切换/误删不重置），一问一答收尾 diagRound+1；最小版按 userId 跨会话聚合 | context.ts:117-118 | WO-07/F-5 |
| P3 | market 落地页不读 from=prescription&pid=，处方跳转与开通回调断裂（依赖处方模型） | market 读 router.params，from==='prescription' 时渲"为『{problem}』开出"上下文卡，开通回调 POST /prescriptions/:id/activate | work/market/index.tsx:13-27 | E-1/WO-12 |
| P3 | 成果回流(outcome)全链无实现，月战报无【处方效果】块无禁算护栏（依赖处方模型） | outcome 回填接口（执行页处方卡+复盘确认两写入口，军师不自动写）；月战报加【处方效果】块占比由 CasefileMetric.leads 服务端求和注入（禁自算）+禁算口径 | schema.prisma:926, casefiles.ts, context.ts | E-3/WO-14 |

---

## 3. 建议的打磨批次

### 批次 A — 止血信任裂缝：prompt 去机制化 + 钩子止血（纯 prompt/文案，无迁移，风险最低，最先做）
把 prompt 里所有"AI 自算数字/索要档案/带死时间钩子/写死里程碑天数"改掉，走 agent_version 草稿→发布。
- prompt-1 / prompt-2 / ledger-4：删账本条目生产+命中率自算+五维评分指令（A-1/P-12）
- prompt-3：删"让用户回传战略档案"话术（F-10）
- hook-1（止血半）：§11.1 钩子改开放式删死时间（F-2）
- milestone-2：§11.2 里程碑话术改引用注入块口径（F-3）
- stat-1（prompt 半）+ benchmark-1（prompt 半）：报告占位百分比+第八部分行业静态表/真实公司名去化（A-1/A-9）
- **依赖**：无。收益最高、风险最低。

### 批次 B — 记忆与诊断主线持久化：UserJourney 地基（一次迁移打通多处）
- round-reset-on-session-switch / diag-round-session-scoped：UserJourney.diagRound 用户级持久化（F-5）
- journey-state-machine-missing：UserJourney 状态机+GET /journey+NextStepCard（WO-07）
- memory-general-void / memory-1 / impression-static-template：general 写共享事实池+印象条真实驱动（A-3）
- impression-picker-empty-in-general：@候选合并用户事实池（A-3）
- milestone-1：里程碑新解锁注入+补发队列+前端接住 progress（F-3）
- **依赖**：批次 A 先落（prompt 不再宣称假记忆/假轮次）。

### 批次 C — 复盘×计费×账本闭环：周期聚合+保底+验证入口
- review-1 / review-week-month-1：recordReview 按 layer 周期聚合+【本月/本周数据】注入块（A-4/WO-04）
- review-2 / no-week-month-ui-entry-4：执行页周复盘/月战报确定性按钮（F-1/WO-04）
- review-3：段位 month 门槛可达（按钮+intent 兜底+补录）（A-2/A-4）
- grace-1 / grace-2：grace 覆盖全复盘层+计数原子化（A-8）
- ledger-1 / ledger-2：App 账本页+verify 入口+n<5 最小样本保护（F-8/P-2/WO-11）
- align-rate-pseudo-3 / review-4：对齐率分母改 aligned 非 null+诚实口径（C-4/P-12）
- **依赖**：ledger-1 需 ledger-5（契约收敛）先行或同 PR；grace-1 与 review 意图判定共用 detectIntent，建议同批。

### 批次 D — 分享安全与交付物补全 + 触达兑现 + mock/契约对齐（可并行）
- share-1 / share-2 / share-3：分享 TTL/撤销+脱敏 public 版+方案库分享入口（F-9/P-5/A-5）
- card-1 / stat-1（渲染半）：补 9 张 B 级卡+A 级七章模板+报告统计护栏（A-5/A-1）
- reminder-1 / reminders-no-backing-2：09:00 军令+周五周复盘场景/模板/job（F-4）
- report-1 / reminder-2：report 授权时序修正+复盘提醒当日幂等（F-4/A-7）
- 各 mock-1（review/knowledge/billing/ledger/profile-mem）+ contract-1 / ledger-5 / quota-pct-1 / retrieval-scope-1：mock 同口径+契约收敛+userId 透传（铁律②③）
- acts-dead-contract：前端补 acts 消费端（E-1，只改前端可提前塞入本批）
- font-1 / scheduler-1：字体自托管+scheduler 发送侧唯一约束（A-10/A-7）
- **依赖**：可与 A/B/C 并行；scheduler-1 建议随 C 的 grace 一起做（都碰计费/幂等）。

> **批次 E（扩张期能力，单独立项）**：prescription-model-missing / market-no-prescription-context / outcome-reflux-missing（处方生态，彼此依赖处方模型）+ multi-casefile-6（多案卷）+ goal-ladder-dead-5（目标阶梯）。工程量大、属"未建的加法地基"，不塞进止血批次。

---

## 4. 需要产品拍板的取舍点

1. **记忆归属模型**：总军师记忆走"用户级共享事实池（所有军师可读、general 可写）"还是维持严格 agentKey 隔离只补 understanding 兜底？前者体验连贯但弱化"每个军师独立印象"人设——要哪个？

2. **复盘六层是否全留**：周/月补按钮+周期聚合是明确的；但季/年/团队目前触发极弱、可发现性≈0，是否值得为这三层都补 UI+聚合，还是先只做 day/week/month、季/年/团队降级为"军师对话里带出"？

3. **五维健康度/战略健康度**：彻底从叙事去掉（只留 prompt 禁令），还是产品确定保留→先投入定义服务端计算口径（营收维/团队维派生自什么数据）再引用？口径定义前 prompt 一律禁输出这些分。

4. **报告脱敏分享**：对外默认出脱敏 public 版（数字改趋势/达成态）是否可接受"炫耀感下降"的代价？还是保留完整版分享只加"含真实数字"确认弹窗？完整版 TTL 设多久（30/90 天）？

5. **陪跑保底额度**：REVIEW_GRACE_PER_DAY 当前 2 次，扩到全 6 层+追问后一天正常动线（日复盘+追问2句+明日军令）必超——上调每日次数还是按类别（复盘/追问）分别计数？速诊 quickscan 保底（WO-06）是否本轮就要？

6. **命理浓度/命理合规（P-3）**：fortune 区本次未复核、findings 为空。命盘注入浓度、合规红线是否先补一轮该区逐功能 review 再定，还是产品已有明确红线可直接下发 prompt 手术？

7. **多案卷/处方生态**：多业务线并行（P-11）、处方引擎（WO-12）、成果回流（WO-14）都是加法地基、工程量大。本阶段就启动（批次 E），还是先跑完止血批次、验证留存后再投入？

---

完整报告文件：`/private/tmp/claude-501/-Users-donis-dev-ai-pilot--claude-worktrees-charming-solomon-918965/d6b73e25-0101-4f64-94ec-2e95a09bd221/scratchpad/polish-plan.md`


---

# 补跑 · 战局诊断 + 命理（首轮 stub，2026-07-05 补齐，14 条全 CONFIRMED）

# 战局·命理 已复核 findings 打磨清单

> 来源：AUDIT_V6_GLOBAL 已复核 findings（CONFIRMED / PLAUSIBLE）。每区一节 = 现状 + 打磨表（CONFIRMED 排 PLAUSIBLE 前，同级按优先级）。所有 finding 均为「补全 / 对齐 / 打磨」，不删除既有功能。

---

## 一、战局·六轮诊断

**现状（currentLogic 提炼）**

- **军师判断 hero**：文案取 `me.understanding.summary`（fallback `dossier.judgment`），kicker 硬写「军师判断 · 主要矛盾」；但 `summary` 实际是 `understanding.ts:155-159` 拼的资料成熟度通用模板串（"军师已沉淀 N 条经营线索…底稿"），既非主要矛盾、也不来自 `StrategicProfile.mainContradiction`。
- **metric-grid**：案卷完整度 / 待补资料 / 风险锁——均为真实前端派生状态。
- **下一步卡**：本地按 dossier/und 派生的 if 链，自标「WO-07 Journey 状态机占位」，**无服务端 journey 接口**。
- **三势判断（force-grid）**：数据源 `THREE_FORCES`（`operatingSystem.ts:231-235`）是 3 条静态 key+desc 常量。天势卡接真实 `chart.monthlyOutlook`（本月 phase/拐点，可进原生天时页）；市势/人势两卡仅渲染静态 desc + 「发起判断 ›」拼 prompt 跳对话，**无任何 forces 结构化结论回显**。
- **下一步动作（battle-actions）**：渲染 `und.nextQuestions.slice(0,3)`——是建档缺口问句（"以后军师怎么称呼你？"），**并非六轮诊断/十二问**。
- **后端诊断轮次**（`context.ts:116-118`）：仅 `agentKey==='general'` 且 strategy 模式注入「本会话第 N 轮」，`N = history.filter(role==='user').length + 1`，**纯按当前会话历史算，无用户级持久化**。
- **StrategicProfile**：mainContradiction/positioning/track/stage/... 六字段，仅在认可方案（正则抽分节标题）和手动 PUT 回写；stage 为自由文本，无枚举/验证/迁移。
- **twelveQJson**（`schema.prisma:1024`）：字段预留，**全仓零写零读**。
- **forces**：契约/服务端/schema **全仓无此结构化字段**。

| 优先级 | 问题 | 怎么捋顺 / 打磨 | 涉及文件 | docRef |
|---|---|---|---|---|
| P1 · CONFIRMED | **诊断轮次按会话历史现算，换会话/删会话即归零**：`round = history.filter(user).length + 1` 纯派生自当前会话；home 各入口（startInterview/startForces/goQuickScan）均带 `fresh=1` 新开空历史会话，删会话 DELETE 消息 → round 重算为 1，军师无察觉重新开场，六轮旅程被一次操作清零。落库处只 update `session.mode`，无任何轮次持久化。 | 按 WO-07 建 `UserJourney`（userId @unique，diagRound/diagSessionId/stage）；sessions.ts 消息落库后于 strategy 一问一答收尾时 `diagRound+1`；context.ts「本会话第 N 轮」改读 `UserJourney.diagRound`（用户级），diagSessionId 变化不重置，话术接续「上次聊到第 N 轮」。回归：删会话后 diagRound 不变。**补持久化，不删功能。** | `server/src/services/context.ts:116-118`、`server/src/routes/sessions.ts:184-193` | AUDIT F-5；REDESIGN WO-07 |
| P1 · CONFIRMED | **十二问 twelveQJson 抽取管道未建**：字段预留但全仓零写零读，`extractStrategicFacts` 只从认可方案分节标题抽 4 个粗字段（矛盾/定位/赛道/阶段），不覆盖十二问。文档把十二问结论当核心资产（复盘对齐/定位验证依赖它），但答案永远散落在对话消息里，战局/复盘无法引用。**属「未建」非「坏」。** | 建抽取管道：诊断收尾或认可方案时，用与决策日志共用的 LLM 结构化抽取（gateway extract），把答案写入 `StrategicProfile.twelveQJson`（结构化 `{ qKey: answer }`）；服务端读出后在战局页做「定位/矛盾」真实回显，替换 hero 现有通用 summary。抽取需带用户确认环节避免 LLM 误写（对齐 A-6 无人审顾虑）。 | `server/prisma/schema.prisma:1024`、`server/src/services/strategicProfile.ts:20-33` | AUDIT A-11 |
| P1 · CONFIRMED | **军师判断 hero 标签「主要矛盾」但渲染的是通用成熟度模板串**：kicker 硬写「军师判断 · 主要矛盾」，bh-title 渲染 `und.summary`（empty/forming/ready 三档资料成熟度模板），完全不是主要矛盾；真正的 `mainContradiction` 存 StrategicProfile 却前端未消费。用户认可方案后，主要矛盾判断在战局首屏不可见，标签与内容不符。 | 服务端把 `StrategicProfile.mainContradiction` 经 me/understanding 或新 journey 接口暴露给前端；home hero 优先渲染 mainContradiction，回退才用 summary/dossier.judgment。前后端同口径（铁律②），**保留 hero 功能，只把数据源接对**。 | `app/src/pages/home/index.tsx:138-144`、`server/src/services/understanding.ts:154-159` | AUDIT A-11；铁律② |
| P2 · CONFIRMED | **三势判断市势/人势为纯静态框架卡，无 forces 结构化结论**：THREE_FORCES 是硬编码 3 条常量；force-grid 中天势卡接真实 `chart.monthlyOutlook`，但市势/人势永远只渲染静态 desc + 「发起判断 ›」跳对话。用户完成多轮诊断后仍看不到自己业务的真实三势结论，与「每个方案都判断该攻该守该等」承诺不符。forces 结构化服务端完全未建。 | StrategicProfile 增 forces 结构化字段（`{ tianshi/shishi/renshi: { verdict: '攻\|守\|等\|撤', note } }`），随诊断/认可方案抽取回写；契约加 forces（铁律②），mock 同口径给确定性样例；home 市势/人势卡有结论时回显 verdict+note，无结论保留现有引导态。**给静态卡补真实数据，不删卡。** | `app/src/data/operatingSystem.ts:231-235`、`app/src/pages/home/index.tsx:174-199` | AUDIT A-11；REDESIGN L-6 |
| P2 · CONFIRMED | **六轮诊断无中途流失召回、快速通道入口用户不可见**：`context.ts:118` 注入「客户要求加速时切 3 轮快速通道」——完全靠 LLM 自判用户是否「要求加速」，前端无任何显式入口；scheduler 也无「诊断进行到第 N 轮后断档」的召回任务。用户第 2 轮想直接要结论但没说加速词 → 继续走六轮；第 3 轮弃疗 → 无人召回，漏斗每轮流失无管控。 | ① 前端在下一步卡「继续第 N+1 轮」旁加显式「改走 3 轮快速通道」入口，服务端据此在 modeLine 注入快速通道指令（**确定性触发，不靠 LLM 猜**）；② scheduler 增诊断断档召回任务（依赖 F-5 的 `UserJourney.diagRound + updatedAt` 判断断档）。**均为补动线，不删六轮功能。** | `server/src/services/context.ts:118`、`app/src/pages/home/index.tsx:115-124` | AUDIT P-10 |
| P2 · CONFIRMED | **阶段自适应：stage 为分节标题正则抽的自由文本，无验证/迁移/回填交叉校验**：`strategicProfile.ts:30` stage 由 `/阶段\|三步走/` 从认可成果正文首行 slice(60) 抽，是任意自由文本非枚举；回写点仅认可方案 + 手动 PUT 两处，无「经营三数回填 vs 自报阶段」交叉校验，无阶段迁移触发点。自报或方案写错阶段 → 整套打法（复盘深度/话术）持续错配，无纠正触发。*（注：读取侧 `stageOf` 已把自由文本归一到 survival/start/growth/expansion 四枚举，「非枚举」仅指存储值。）* | ① stage 收敛为枚举，抽取时做映射（抽不出不写）；② 用执行页回填 leads/consults/deals + 营收段做阶段复核，与自报冲突时注入「疑似阶段迁移，先求证」（对齐 strategicBlock 已有「冲突先求证」口径）；③ 阶段迁移作为服务端事件触发模式切换。**给已有 stage 补验证与迁移，不删功能。** | `server/src/services/strategicProfile.ts:30`、`server/src/services/context.ts:121-122` | AUDIT P-7 |

---

## 二、命理·天势·排盘

> **最优先（P0 合规）**：`P-3`（无平台级一键降级开关）与 `P-4`（第三人生辰永久落库 + 无鉴权公开访问、与"不落库"承诺相反、无当事人同意）是本区两条 P0 合规缺口，必须先于所有 P1+ 打磨落地——前者关系微信类目审核期能否止血，后者关系个保法下第三人敏感信息（生辰）的收集/存储/公开链路。**审核降级开关（P-3）应先于任何提审接好，且切换无需发版。**

**现状（currentLogic 提炼）**

- **采集三入口**：① 主流程建档 Picker（结构化八字表单 solar/lunar+时辰+性别+出生地，可 optOutBazi → `saveBazi({believe:false})`）；② 全年天时页 calendar（就地补生辰 + 12 月攻守网格 + 转发/打印）；③ 送你一卦 gift（采集第三人姓名+生辰）。**三表单都只暴露 1-12 月整数，无「闰月」勾选。**
- **后端排盘**：`paipan.ts` computeChart（lunar-typescript 干支 + iztro 紫微，`PAIPAN_ENGINE_VERSION='paipan-v1'`）产出四柱/日主强弱/喜用/取格/紫微/大运/「逐月攻守」monthlyOutlook（12 公历月，取每月 15 日节气月柱）。头注 v1 边界：**真太阳时无均时差、不处理从格/化格、称骨暂缓、无流日推演**。`/profile/bazi` 有完整范围校验并落 NatalChart；`/cards/:kind` 的 fate 卡把 friendBazi 传 computeChart 现算但**无任何范围校验**。
- **注入**：`context.ts:126-133` 读 `profile.extraJson.bazi.believe`，`believe!==false` → loadChart→chartBriefing 注入【天势档案】（带「AI 禁自排」铁律）；`believe===false` → TIANSHI_OPTOUT_LINE 降级。**降级仅由用户级 believe 开关驱动，无平台级/全局开关。**
- **prompt**：`strat.v6.md` §4.1 指示 LLM 第 1 轮用**聊天文本**采集生辰；§4.5 承诺择时「流月+流日…重大决策精确到日」、从格判定、年度谶语——**超出引擎 v1 实际能力**。
- **mock**：`saveBazi/myChart` 恒返回 `chart:null`，从不返回真实 ChartSummary。

| 优先级 | 问题 | 怎么捋顺 / 打磨 | 涉及文件 | docRef |
|---|---|---|---|---|
| **P0 · CONFIRMED** | **命理内容无全局 feature flag / 无平台审核期一键降级**：全仓无 TIANSHI_ENABLED 类开关，唯一降级路径是用户级 believe（粒度=单个用户主动选不信）。微信命理类目审核不过或临时下架整改时，运营**无法一键把全量用户降级**：命盘对所有 `believe!==false` 用户无条件注入，home 天势卡/calendar/gift 命理 UI 全部照常渲染八字/命宫/大运术语。一次审核事故=全量带命理术语。 | ① 加全局开关 `env`/`AiSetting.tianshiMode ∈ {full\|downgrade\|off}`，作 believe 之上的短路项：downgrade→无条件走已有 TIANSHI_OPTOUT_LINE，off→天势块整段不注入。② 前端 home 天势卡/calendar/gift 读同一开关（复用现有全局 config 下发通道）：downgrade 保留「进攻/防守」但去八字/命宫/大运字样、更名「经营节奏日历」；off 隐藏 gift 与命理术语入口，保留三势中的天势=时机窗口话术。③ **开关先于任何提审接好，切换无需发版。** | `server/src/services/context.ts:126-133`、`server/src/services/paipan.ts:288-289`、`app/src/packages/work/calendar/index.tsx`、`app/src/packages/work/gift/index.tsx`、`app/src/pages/home/index.tsx:107-108,171-176` | AUDIT §P-3；REDESIGN 铁律④ |
| **P0 · CONFIRMED** | **送你一卦：第三人生辰被永久落库且无鉴权公开访问，「不落库」承诺与代码相反、无当事人同意**：前端（"生辰只用来现场排盘，不会保存"/"军师不留档"）与 cardHtml 注释（"现算不落库"）都声称不存，但 `publishCard(fate)` 用 friendBazi 现算后把**朋友姓名+公历生辰+命格**渲进 HTML，经 `prisma.reportHtml.create` **永久落库**，返回 `/api/r/:id`；该路由**明确不鉴权**。给"老王"出卦→老王姓名+生日+命格永久存库，任何拿到链接者（转发/截图 OCR/泄漏）无需登录即可访问，被算者从未同意、无删除入口。个保法合规缺口。 | ① 诚实二选一——要么**真不落库**：fate 卡改走一次性内存渲染或短 TTL 缓存（几分钟过期），链接即用即弃；要么落库则给 reportHtml 加 `kind+expiresAt`，fate 短保留期（如 7 天）并让当事人/发起人可删。② 补当事人**同意语义**：gift 表单加「已获对方同意用其生辰出卡」勾选（前端 valid 门槛 + 后端 `recordAudit` 记 consent），文案不再写「不会保存」除非真不保存。③ fate 渲染考虑脱敏（默认只渲月日，不渲完整 solarDate）。**补合规链路，不删「送你一卦」。** | `server/src/services/cardHtml.ts:172-176,196-200,138-158`、`server/src/routes/reportShare.ts:1-11`、`app/src/packages/work/gift/index.tsx:11,69,133` | AUDIT §P-4；铁律④ |
| P1 · CONFIRMED | **八字采集双轨分裂**：轨 A 结构化（Picker/calendar/gift → `/profile/bazi` computeAndStoreChart → NatalChart → 注入引擎结果）；轨 B 聊天文本（`strat.v6.md:71/234/297` 指示 LLM 第 1 轮口头收生辰）。但 LLM **无工具**可把聊天里的生辰写进 NatalChart。用户跳过建档直接对话报「农历 85 年冬月初八早上」→ LLM 只能自解析并**现编命理结论**（违反铁律①），命盘从不落库，后续天势全是 LLM 口算；走 Picker 的用户得引擎确定性结果——同一功能两套精度、两套真实性。 | ① 收敛单轨——prompt 第 1 轮把「报生辰」改为**引导点结构化入口**（深链到 Picker/calendar，"点这里 30 秒补生辰，我按引擎给你排盘"），LLM 不再口算；② 若保留对话内采集，则给 LLM 加 `saveBazi` 结构化工具（参数=calendar/year/month/day/hour/gender），落 NatalChart 后再注入，杜绝现编；③ context.ts 注入时若无命盘但对话疑似含生辰，回一句提示走结构化补录。 | `server/prompts/strat.v6.md:71-79,228-234,297,650`、`app/src/components/Picker/index.tsx:200-270`、`server/src/routes/profile.ts:54-113`、`server/src/services/context.ts:126-133` | AUDIT §F-6；铁律① |
| P1 · CONFIRMED | **闰月后端支持但三前端表单均无入口，闰月生日必然排错**：后端约定 lunar 闰月传负数月（`paipan.ts:21` 闰二月=-2，profile.ts:85 显式放行 `monthNum<0`），但 Picker/calendar/gift 三处月输入都是 `type=number maxlength=2` 普通整数框，无闰月勾选，`BaziBody` 契约也无 isLeapMonth。闰月出生者只能填正整数月→后端当正常月排盘→月柱/整盘错，全年攻守/择时/命盘注入全基于错盘，用户无从察觉。闰月在中国生辰非罕见。 | ① lunar 模式下月份旁加「闰月」toggle（Picker/calendar/gift 三处同口径），勾选后前端把 month 取负传后端（后端已支持）；② `BaziBody` 契约 + mock 加 `isLeap` 或沿用负数约定，前后端/mock 同口径；③ 校验：仅当 `calendar==='lunar'` 且该年确有该闰月时允许（可复用 profile.ts:111 现有「农历大小月/闰月」报错兜底）。 | `server/src/services/paipan.ts:21,99-100`、`server/src/routes/profile.ts:85`、`app/src/components/Picker/index.tsx:221-225`、`app/src/packages/work/calendar/index.tsx:171-175`、`app/src/packages/work/gift/index.tsx:88-92`、`app/src/services/api.ts:42-44` | AUDIT §F-6/§P-6；铁律② |
| P1 · CONFIRMED | **prompt 承诺择时「精确到日」+流日+从格+称骨，超出引擎 v1 能力，无精度声明**：prompt 承诺「精确到周，重大决策精确到日」「结合流月+流日」「身强/身弱/从格」「年度谶语」；引擎现实（paipan.ts 头注）**无流日推演**（monthlyOutlook 只到月级）、**不处理从格/化格**、**称骨暂缓**、真太阳时无均时差。用户问「哪天签约最好」→ LLM 被要求给「精确到日」吉日但服务端无流日数据→只能**现编日子**（违反铁律①）；对照专业排盘发现四柱/从格/称骨对不上→信任崩。 | ① prompt §4.5/§4.6 择时话术降级到引擎真实精度——「精确到月/给出本月内相对更宜的窗口区间」，删「精确到日」「流日」；重大决策明确「引擎给到流月级，日级请结合线下黄历/专业排盘」。② 从格/称骨/谶语：明确当前不由引擎产出——从格删或标 v1 按正格近似；谶语本是 `strategicProfile.verse` 手写字段，勿声称八字推演。③ chartBriefing 注入块补一行精度声明（"本盘为 paipan-v1：月级择时、正格近似、真太阳时未含均时差"），让 LLM 不越界承诺。 | `server/prompts/strat.v6.md:148-150,464,86,141`、`server/src/services/paipan.ts:6-10,185-205,266-285` | AUDIT §P-6；paipan.ts 头注 |
| P2 · CONFIRMED | **送你一卦 friendBazi 服务端零校验，恶意/错误输入直进排盘引擎**：`/profile/bazi` 有完整范围与历法校验，但 `/cards/:kind` 对 friendBazi **完全不校验**，直接 friendBazi→publishCard→computeChart。异常输入（year=9999/month=13/hour=99）→ 要么抛错落 catch 返 500（对用户是「生成失败」而非 400 明确提示），要么产出基于非法生辰的垃圾命盘卡并**永久落库公开**（叠加 P-4）。前后端校验口径不一致。 | 把 profile.ts:80-91 校验抽成共享函数 `validatePaipanInput(input): {ok,error}`，`/profile/bazi` 与 `/cards/:kind` 的 friendBazi 都先过它，非法→400 明确报错，不进引擎、不落库。契约层前后端/mock 同口径。 | `server/src/routes/cards.ts:12-34`、`server/src/services/cardHtml.ts:196-200`、`server/src/services/paipan.ts:118` | 铁律②；对照 profile.ts:80-91 |
| P2 · CONFIRMED | **mock 的 saveBazi/myChart 恒返回 chart:null，天时日历渲染路径在 mock 下无法演练**：真实 server 返回带 `monthlyOutlook.months` 的 ChartSummary，calendar 据此渲 12 月攻守网格 + 本月攻守；但 mock 恒返回 `chart:null`。IS_MOCK 下排完盘 chart 永为 null→calendar 永远落空态补生辰分支，攻守网格/拐点/图例、gift 出卡、home 天势卡真实态在 mock 下全无法演练，违反铁律③，前端 UI 在本地/评测无法回归。 | mock.ts 的 saveBazi/myChart 返回一份符合 ChartSummary 契约的**确定性假命盘**（pattern/hourKnown/monthlyOutlook 含 12 月 phase+turning，写死一套示例），与 server 输出结构同口径，使 calendar/gift/home 天势卡在 mock 下可完整演练与回归。 | `app/src/services/mock.ts:593-598`、`app/src/services/api.ts:60-67,237-240`、`app/src/packages/work/calendar/index.tsx:100-153` | 铁律③ |
| P3 · CONFIRMED | **命盘 chartJson 全量快照 + 引擎版本复算，历史预言/择时验证公平性未定义**：NatalChart 每用户一张、chartJson 整块 v1 快照、重排 upsert 覆盖、带 PAIPAN_ENGINE_VERSION。头注称「升级后可按版本批量复算」，但历史预言/择时（prophecyLog/decisionLog）基于**旧版命盘**给出；一旦引擎升 v2 复算覆盖，命盘依据变了，预言验证按当时盘还是新盘——**无定义**，命中率对账口径漂移。**属演进负担，非当前已坏。** | ① 明确复算语义——升级不覆盖旧盘，NatalChart 按 engineVersion 保留历史盘（或存 history），预言/择时验证一律按【当时生成所依据的盘版本】对账；② 预言/决策记录存下当时引用的 chart engineVersion，验证时按版本取盘。**工程卫生，可排在 P-3/P-4 之后。** | `server/src/services/paipan.ts:231-257,16`、`server/src/services/cardHtml.ts:191-193`、`server/src/services/context.ts:131-132` | AUDIT §A-12 |

---

**汇总**：14 条 findings 全部 CONFIRMED，无 PLAUSIBLE。战局区 6 条（1×P1 hero 标签、3×P1、3×P2 — 实为 3P1+3P2）；命理区 8 条（**2×P0 合规**、3×P1、2×P2、1×P3）。命理 P0（P-3 审核降级开关、P-4 第三人生辰合规）为全清单最优先，其中 P-3 开关须先于提审、切换免发版。
