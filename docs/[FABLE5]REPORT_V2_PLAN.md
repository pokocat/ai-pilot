# 报告 V2 改造方案：类型化交付物 + 案卷视觉

> 状态：方案已定稿，待排期执行。视觉/文风权威样张：`docs/[FABLE5]REPORT_V2_DEMO.html`（虚构案例，直接浏览器打开看效果）。
> 背景：用户反馈现有报告（统一白卡分段）表现力不足；参考某高丰富度咨询报告案例后，决定"学结构语法、穿军师衣服"——组件词汇量对齐，视觉身份完全自有。

## 已拍板的产品决策

1. **称谓 = 「老板」**（性别中性、零门槛）。替换所有"主公"：底部 tab 标签（`app/src/app.config.ts:81`、`app/src/custom-tab-bar/index.tsx:16`）、V6.0 提示词内称呼、报告文案。仪式位写法：封面「呈 老板 亲启 · 密」；书信标题用《军师手书》（不用《致老板书》，滑稽）。后续可选：个人档案开放自定义称谓（存 `Profile.extraJson`，本命色同款架构），不在本期。
2. **文风尺度**：95% 现代商业咨询白话（称呼"你"、直给、带数字、说人话），古典味只锁在仪式位——封面格言、「呈 老板 亲启 · 密」、金句、书信首尾（"老板台鉴"/"军师 顿首"）、汉字章节序号。禁 AI 腔与咨询黑话（赋能/抓手/闭环/心智/底层逻辑等）。
3. **语义标签五色**（进 schema 的 tone 枚举）：机会(金 #9B7C3F) / 风险(赭赤 #8C3B2E) / 行动(朱 #A63D2F) / 布局(黛青 #2F4C5C) / 时机(苍绿 #3F6B4F)。阶段卡 KPI 线标签固定文案「军令状」。
4. **视觉身份**（区别于"暗黑帝国风"的关键点）：米纸 #ECE7DA + 纸白 #FBFAF6 + 深绿 #1E5A43/#163F30 + 哑金 #9B7C3F；**直角**（radius 0，双线边框、角标、田字格印章）；宋体衬线标题；汉字序号「壹贰叁」；低饱和水墨语义色。所有 token 见样张 `:root`。
5. **AI 只产结构化数据，不写 HTML**（维持防注入与成本可控），版式全部由服务端模板决定。

## 改造范围

### A. Schema 扩展（`shared/contracts.d.ts` + `server/src/llm/schema.ts` DELIVERABLE_TOOL）

section 增加 `type` 判别字段，新增类型（字段最小化）：

| type | 字段 | 对应样张组件 |
|---|---|---|
| `hero` | h, paras[] | 定调宣言（深绿底） |
| `callout` | tone(机会/风险/行动/布局/时机), h, b | 语义提示块 |
| `stats` | items[{num, unit?, label}] | 数据大字格 |
| `roster` | people[{name, role, desc}] | 人物卡 |
| `table` | headers[], rows[][]（支持 up/dn 语义标记） | 对比表 |
| `phases` | items[{tab, when, h, actions[], kpi}] | 作战阶段卡（kpi 渲染为「军令状」线） |
| `timeline` | items[{when, h, d, highlight?}] | 时间轴（highlight=金色关键节点） |
| `quote` | text | 居中金句 |
| `letter` | salute?, paras[], close, sign? | 军师手书（收尾） |
| `gauge` | score(0-100), verdict?, items[{label, score, note?}] | 评分盘（半环弧盘 + 分项横条，体检/诊断章；SVG 内联直出） |
| `matrix` | xLabels?, yLabels?, quads[{title, tone?, items[]}]（恰 4 个） | 四象限（2×2 直角格，SWOT/优先级/风险格） |
| `gantt` | unit?, total?, rows[{label, from, to, tone?, note?}] | 甘特泳道条（作战地图/排期，百分比布局静态可靠） |

顶层 Deliverable 增加 `cover?: {title, subtitle?, motto?}`（封面文案 AI 生成；badge/印章/meta 由模板固定）。**向后兼容**：无 `type` 的旧 `{h,b,list}` section 按现行白卡渲染，存量消息不受影响。

### B. 服务端渲染（`server/src/services/reportHtml.ts`）

- `renderReportHtml` 按 `type` 分发到 per-type 模板函数；CSS 整体替换为样张的 token 体系（从样张 `<style>` 移植）。
- 封面/书信/金句为满宽段落（不套章节白卡）；未知 type 优雅降级为现行白卡。
- footer 免责声明/版本行保留现行 trust 逻辑，落款印章改田字格「参谋之印」。

### C. 小程序端成果卡（`app/src/components/ReportCard/index.tsx`）

- 本期最小做法：新类型在卡内降级渲染（callout→带色条段落、stats→两列小格、phases→带标签小节、letter/quote→衬线段落），保证不破版；像素级对齐后置。
- 分享图 `reportShareCard.ts` 取首个 callout/hero 的要点作为三条摘要，逻辑基本不变。

### D. V6.0 提示词修订（⚠️ 只存在于生产库，仓库无副本）

- 流程：从 prod DB 拉出当前 prompt 备份 → 修订 → 写回（参考 memory: prod-deploy-method / strat-v6-embedding）。
- 修订内容：① emit_deliverable 新类型的使用时机（人物→roster、阶段计划→phases、对比→table、数字→stats）；② 情绪弧线（hero 开场定调 → 中段干货 → quote → letter 收尾）；③ 文风规范（见决策 2）；④ 称谓「老板」；⑤ 正文纯文本、禁 markdown 语法（渲染端不解析）。

### E. 称谓替换（随本期一起）

tab 标签「主公」→「老板」两处 + 注释顺手更新；样张已是最终称谓。

## 分期

- **M1（本体）**：A + B + D + E，网页版报告直接达到样张效果。验收：新会话产出的报告含 ≥4 种新类型且渲染正确；旧消息报告渲染不变。
- **M2**：C 小程序成果卡原生适配新类型。
- **M3（可选后续）**：三表面样式收敛（成果卡/详情页/网页版共享 token，解决"详情页随本命色、网页版恒定深绿"的不一致）；个人档案自定义称谓。

## M1.5：报告 PDF 下载 + 宋体栈双端兼容（已实现）

- **宋体栈统一**（安卓无 Songti SC/STSong；新安卓与微信内置思源宋体）：`--serif` 四处 token 同步为
  `"Songti SC","Noto Serif CJK SC","Source Han Serif SC","STSong","SimSun",serif`
  —— `server/src/services/reportHtml.ts`、`server/src/services/cardHtml.ts`、`app/src/app.scss`、`app/src/app.h5.scss`、样张 `docs/[FABLE5]REPORT_V2_DEMO.html`。遵守全站铁律：只改 --serif token，不新增页面级字体变量。
- **服务端 PDF**：`server/src/services/reportPdf.ts`（puppeteer 无头 Chromium）——浏览器懒启动单例、单并发队列、单次 30s 超时、断连自动重启、进程关闭时释放（app.ts `onClose`）。`NODE_ENV=test`（或 `REPORT_PDF_DISABLED=true`）返回最小合法 PDF 桩，绝不 launch 真浏览器；launch 失败抛 `PdfUnavailableError` → 路由回 503，不 crash 进程。
- **路由** `GET /api/r/:id/pdf`（reportShare.ts，公开凭 id）：OSS 确定性 key `{prefix/}pdf/{id}.pdf` 缓存（命中流式回传、未命中现生成后异步回填），OSS 未配置则每次现生成；响应 `Content-Type: application/pdf` + `Content-Disposition: attachment; filename*=UTF-8''<标题·军师参谋部.pdf>`（带纯 ASCII 兜底）。**不动 DB schema**。
- **打印适配**：reportHtml.ts `@media print` 补卡片 `page-break-inside:avoid`、封面自成一页且不强撑 100vh、`print-color-adjust:exact` 保留深绿封面/书信背景。
- **端上**：`api.ts` 新增 `reportPdfUrl(htmlUrl)`；ReportCard「网页版」旁加「PDF」ghost 按钮；chat/index.tsx `downloadReportPdf` —— 先 `renderReport` 确保 htmlUrl → weapp `downloadFile`（落 `USER_DATA_PATH`，文件名安全清洗）+ `openDocument(showMenu)`，H5 `window.open`。

### 部署前人工事项（M1.5）
1. **生产服务器装 Chromium 运行库 + 中文字体**：`sudo apt-get install -y fonts-noto-cjk` + puppeteer 所需依赖（`libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2` 等，或 `npx puppeteer browsers install chrome` 后按其提示补齐）。**缺中文字体 → PDF 里中文变豆腐块**。
2. **puppeteer npm 体积**：安装会拉一份 Chromium（约 170MB+）。本仓库 `npm install` 时用了 `PUPPETEER_SKIP_DOWNLOAD=true` 跳过下载（本机/CI 不需要真浏览器）；**生产部署时不要 skip**，需实际下载 Chromium 或指向系统 Chromium（`PUPPETEER_EXECUTABLE_PATH`）。部署走 scp+build-on-server 流程时注意 `server/node_modules` 需含 puppeteer 及其 Chromium。
3. **微信小程序后台**：把 `wxapi.aibuzz.cn` 加入 **downloadFile 合法域名**（PDF 经自有域名下载，非 OSS 域名）。
4. 可选调优环境变量：`REPORT_PDF_TIMEOUT_MS`（默认 30000）、`REPORT_PDF_DISABLED=true`（临时关闭 PDF，路由回 503）。

## 风险与注意

- 提示词只在 prod DB：改前必备份（同 memory 提醒 pubVer=NULL、len 41713 那份）。
- 新类型使输出变长 → token 消耗上升，观察双轴计费下用户额度消耗；必要时提示词里约束单报告 section 数上限。
- 部署走 scp+build-on-server 流程（memory: prod-deploy-method），weapp 端另走发版流程。
- 相关但未排期（另议）：报告"带走能力"（复制链接/浏览器打开/PDF）、裂变钩子（reportHtml 页脚接小程序码 + CTA）——裂变逻辑用户在想，勿抢跑。
