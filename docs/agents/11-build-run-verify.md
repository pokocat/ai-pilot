# 军师 · 工程说明分册 · §11 构建、运行、验证、发布

> 本文是 `AGENTS.md` 对应章节的**完整正文与历史约束账本**，2026-09-09 从 `AGENTS.md` 原样拆出（章节号与小节号保持不变，代码/文档里写的「AGENTS.md §11」即指本文）。
> `AGENTS.md` 只保留该章节的摘要、铁律与入口；**改动本领域的代码时，先读本文对应小节，再动手；改完把新约束写回本文（不是写回 AGENTS.md），并在 `docs/CHANGELOG.md` 顶部记一条。** 维护规则以 `AGENTS.md` §0 为准。

---
## 11. 构建、运行、验证

### 常用操作路径（给 Agent 直接执行）

默认仓库根目录：`/Users/donis/dev/ai-pilot`。微信源码在 `app/weapp-native`，产物在 `app/dist-native`；本地 DevTools 走查优先导入 `app/dist-native/`，发布/auto-preview CLI 仍指向 `app/`（`project.config.json` 的 `miniprogramRoot=dist-native/`）。H5 产物独立放在 `app/dist-h5/`。本机预览二维码和信息文件统一输出到根目录 `weapp-preview.png` / `weapp-preview-info.json` / `weapp-auto-preview-info.json`，均不纳入提交。

**本地调试**
```bash
cd /Users/donis/dev/ai-pilot
npm run dev
```
这是首选三端联调入口：自动准备本地 PostgreSQL，启动 API `:4000`、H5 `http://localhost:5173`、运营后台 `http://localhost:5174`。只看小程序前端时用 mock：
```bash
cd /Users/donis/dev/ai-pilot/app
npm run dev:weapp
```
H5 单端走查：`cd app && npm run dev:h5`；H5 连真实后端：`cd app && npm run dev:h5:server`（默认 API `http://localhost:4000/api`）。

**套餐与定价改动走运营后台，不走代码（2026-08-01 定）**：线上套餐的价格/额度/权益/周期/上下架只有一个入口——运营后台「商品 · 套餐」（`GET/POST/PATCH/DELETE /admin/plans`，requireSuper + 审计留痕），全新部署也是先在后台建档。`GET /admin/plans` 必须在响应出口用 `planRules` 补齐迁移期可空的 `planFamilyKey/tierRank/usageLevel/usageLabel`，并为用量阈值提供契约默认值，保持 `AdminPlan` 的非空口径；否则存量档进入编辑态后会在字符串 `.trim()` 处崩溃。`server/src/data/seedConfig.ts` 的 `DEV_PLANS` 只是**本地/测试夹具**，改它不影响线上、也别指望能改线上。原 `db:sync-plans` / `db:bump-free-quota` 两个脚本已删除：前者按 name 全字段 upsert，运营把入门版从 ¥68 改成 ¥99 之后，任何一次全量同步都会静默把线上价打回代码常量（dry-run 实测会打印「更新 入门版」）；后者写死 `PLANS[0]`，免费档下架后 `PLANS[0]` 变成付费入门版，跑一次就把付费用户的 token 钱包重置成夹具值。`npm run db:seed` 是破坏性的（deleteMany 套餐/智能体），现带生产护栏：`NODE_ENV=production` 或 `DATABASE_URL` 非本地一律拒绝执行（确认是测试库才加 `--i-know`）。同理 `npm run admin:sync-content` 默认**不覆盖**计价字段（agent 的 `gift/billing/price/billingRatio/meterUnit`、sku 的 `name/desc/priceFen/sort`）——与提示词同一「运营所有」约定，确需用仓库常量改线上价才加 `--force-pricing`。

**挂牌价 / 优惠价 / 生效时间（2026-08-08）**：`Plan.price` 是**挂牌价**，`promoPrice` + `promoStartsAt/promoEndsAt` + `promoLabel` 是一段有生效窗的**优惠价**，全部在运营后台「商品 · 套餐」里配（POST/PATCH `/admin/plans`，requireSuper + 审计带优惠前后快照）。窗口到点自动切换，不需要人工改价：未到 `promoStartsAt` 按挂牌价卖（可预约调价），过了 `promoEndsAt` 自动回挂牌价。**服务端一切读价都必须先过 `services/planPricing.ts` 的 `withEffectivePrice()`**——它把 `price` 换成「此刻的成交价」、把挂牌价挪到 `listPrice`、并算好用户侧折扣对象 `promotion`（`discountLabel` 形如「1折」）。已接入：`GET /plans`、`/plans/options`、`/plans/:id/quote|order|contract-order|purchase`、`quotePlanChange` 的在册档、`buildOrderSnapshot`（下单快照冻结成交价）、`scanAutoRenewals` 的改价停扣判断。**漏包一处就是真金白银的偏差**：`PlanEntitlement.listPrice` 记的是成交价快照，写挂牌价会让 ¥3980 买的档在升级时抵掉 ¥39800（`test/planPromotion.test.ts` 钉住）。硬约束是 `1 ≤ promoPrice < price` 且只允许配在正价档（`price>0`）上——保证生效价恒为正，`price<=0`（免费层不设到期）与 `price<0`（面议档禁止自助购买）的语义不会被优惠翻转，所以调用方无需为优惠新增分支。折扣率只有服务端一份实现，三个端只做文案拼装：**原生小程序** `weapp-native/packages/work/plans/index.js` 的 `promoView()`（WXML 不能调函数，`discountLabel/kickerText/listPriceText/saveText/deadlineText` 必须在 `setData` 前算完）、**H5** `app/src/packages/work/plans/model.ts` 的 `promotionKicker/promotionSave/promotionDeadline`、**运营后台**列表行。方案卡的价格区**所有档共用一套结构**（大号现价 + 周期单位），优惠档只叠加角标、整卡提色与「原价/立省/截止」——不给优惠档另换排版，同一列表里两种版式会看起来像坏了；促销色一律走 `--accent*` token，本命色有 6 套主题，写死红色会在其中 5 套里显脏。以上由 `app/scripts/native-weapp.test.mjs` 的折扣用例静态钉住（禁止端上重算折扣率或立省金额、禁止 WXML 里出现价格算术、禁止写死非白 hex 底色）。已开自动续费的档配优惠时：优惠结束后 `scanAutoRenewals` 发现成交价 ≠ 授权金额会转 `cancel_pending` 停扣并等用户重新确认，不会按挂牌价静默续。

注意套餐额度调整只影响新用户：钱包 `quota` 是首建/购买时的快照，跨月重置也复用快照、不回读 live plan（见 `services/tokenQuota.ts`）。要给存量用户补额度，用运营后台的 per-user 额度写端点（`POST /admin/users/:id/token-quota`），不要再写批量刷库脚本。

Taro Webpack5 缓存只服务 H5。微信原生构建不经过 Webpack；若 DevTools RC 在外层 `miniprogramRoot` 重建时保留旧文件索引，先关闭项目、完成 `npm run build:weapp:server`，再直接导入 `app/dist-native/`，不要把缓存报错误判成源码缺文件。

**小程序真机实时预览**

用户说“推送真机实时预览”时，优先复用/启动一个 `screen` 后台 watch，再触发微信开发者工具预览；不要开多个重复 watch。
```bash
screen -ls | rg ai-pilot-weapp-watch || \
screen -dmS ai-pilot-weapp-watch bash -lc 'cd /Users/donis/dev/ai-pilot/app && WEAPP_APP_MODE=mock npm run dev:weapp > /tmp/ai-pilot-weapp-screen.log 2>&1'

tail -n 80 /tmp/ai-pilot-weapp-screen.log

/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto-preview \
  --project /Users/donis/dev/ai-pilot/app \
  --info-output /Users/donis/dev/ai-pilot/weapp-auto-preview-info.json \
  --lang zh

/Applications/wechatwebdevtools.app/Contents/MacOS/cli preview \
  --project /Users/donis/dev/ai-pilot/app \
  --qr-format image \
  --qr-output /Users/donis/dev/ai-pilot/weapp-preview.png \
  --info-output /Users/donis/dev/ai-pilot/weapp-preview-info.json \
  --lang zh
```
停止实时 watch：`screen -S ai-pilot-weapp-watch -X quit`。如果只是“编译推送一下”，不用常驻 watch；真机连线上后端验收时必须 `cd app && npm run build:weapp:server` 后跑上面的 `auto-preview` 和 `preview` 两条 CLI，避免默认 `build:weapp` 生成 mock 包。

**小程序连本机后端真机调试**

真机不能访问 Mac 上的 `localhost`，必须用局域网 IP。后端需监听 `0.0.0.0:4000`，先用手机同网可访问的地址验健康检查：
```bash
# 终端 A：启动后端，server/src/index.ts 已监听 0.0.0.0
cd /Users/donis/dev/ai-pilot/server
npm run dev
```
```bash
# 终端 B：取 Mac 局域网 IP，启动小程序 server-mode watch
LAN_IP="$(ipconfig getifaddr en0 || ipconfig getifaddr en1)"
curl "http://$LAN_IP:4000/api/health"

cd /Users/donis/dev/ai-pilot/app
WEAPP_APP_MODE=server WEAPP_APP_API="http://$LAN_IP:4000/api" npm run dev:weapp
```
也可用本机技能脚本减少漂移：
```bash
/Users/donis/.codex/skills/ai-pilot-weapp-preview/scripts/weapp_preview.sh print-env
/Users/donis/.codex/skills/ai-pilot-weapp-preview/scripts/weapp_preview.sh check-api
/Users/donis/.codex/skills/ai-pilot-weapp-preview/scripts/weapp_preview.sh build
/Users/donis/.codex/skills/ai-pilot-weapp-preview/scripts/weapp_preview.sh auto-preview
/Users/donis/.codex/skills/ai-pilot-weapp-preview/scripts/weapp_preview.sh preview
```
注意：`/api/health` 只证明服务端存活；如果业务接口因 `DATABASE_URL`/Prisma 连不上库报错，应先修数据库。用户只是要可扫码验收时，可先退回 mock 预览保持体验可用。

**小程序发布上线（开发版 → 体验版 → 发布）**

小程序是独立于服务端的发布渠道，**不在 `deploy-prod.sh` 内**；后端用 `deploy-prod.sh` 单独上线，且必须向后兼容线上旧版小程序（新增字段/可选参数/新端点，不改既有响应契约）。发布前统一走**一体化正式发布命令**，它会强制 server 模式重建并校验构建身份，避免复用旧 dist 或误传 mock：
```bash
cd /Users/donis/dev/ai-pilot/app
npm run release:weapp -- --version <版本号> --desc "<本次变更说明>"
```
该命令依次执行 `build:weapp:server` → 校验 `dist-native/junshi-build-meta.json` 的 `runtime=native-weapp`、`mode=server`、生产 API 与上传版本完全一致 → 检查 DevTools 登录态 → CLI 上传；加 `--dry-run` 可只构建校验、不触达微信。产物在 `app/dist-native/`（外层 `miniprogramRoot=dist-native/`）。**上传这一步由 agent 自己执行，不要甩给用户**。DevTools 需已打开且开启「设置 → 安全 → 服务端口」。底层等效命令如下，仅用于排障，正常发布不得直接调用：
1. **微信开发者工具 CLI（底层首选，无需上传密钥）**：复用已登录的 DevTools 会话，`--project` 指向 `app/`（含发布配置；本地界面走查才导入 `dist-native/`）：
   ```bash
   /Applications/wechatwebdevtools.app/Contents/MacOS/cli upload \
     --project /Users/donis/dev/ai-pilot/app \
     -v <版本号> -d "<本次变更说明>"
   ```
   退出码 0 且打印 `✔ upload` + 体积表即成功，进入 mp 后台「版本管理 · 开发版」。版本号每次递增，上传前后同步 `docs/WEAPP_RELEASES.md`。GUI 仅作为 CLI 不可用时的最后回退：上传前必须人工打开 `dist-native/junshi-build-meta.json` 核对 `runtime/mode/API/version`，且预览中不得出现红色 MOCK 标识。
2. **miniprogram-ci（CI/headless 备选）**：需在 mp 后台 *开发管理 → 开发设置 → 小程序代码上传* 下载上传密钥 `private.<appid>.key` 并把**本机公网 IP**加进白名单。该密钥本地通常没有，**除非用户给出密钥路径，否则一律用①**：
   ```bash
   cd app && WEAPP_UPLOAD_KEY=/绝对路径/private.<appid>.key \
     npm run upload:weapp -- --version <版本号> --desc "本次变更说明"
   ```
上传后在 mp 后台 `mp.weixin.qq.com`「版本管理」：**开发版 → 转「体验版」自测 → 「提交审核」→ 审核通过后「发布」** 给全体用户。CLI 只产出开发版；转体验版、提交审核、正式发布是 mp 后台手动步骤（这几步才需要用户操作）。

**部署发布**

服务器部署/升级主文档是 `docs/DEPLOYMENT.md`，模板在 `deploy/`。当前固定线上环境：`ecs-user@8.136.36.175`，SSH key `/Users/donis/dev/aliyun/aiartist.pem`，代码目录 `/opt/junshi`，后台静态 `/var/www/junshi/admin`，H5 静态 `/var/www/junshi/h5`，API systemd 服务 `junshi-api`，公网域名 `https://wxapi.aibuzz.cn`。裸 IP `http://8.136.36.175` 仅保留 `/api/` 访问，`/admin` 与 `/admin/` 必须返回 404；运营后台只从域名 `https://wxapi.aibuzz.cn/admin/` 进入。**不要再探测远端是不是 git 仓库，也不要走远端 `git pull`**：当前 `/opt/junshi` 是本地 `git archive` 上传包式部署，不是 git checkout；例行「提交部署」直接跑仓库脚本。

常规升级（默认部署 `server + admin`；仅 `app/` 变更时再加 `DEPLOY_H5=1` 发布 H5）：
```bash
bash scripts/deploy-prod.sh

# 需要同时发布 H5：
DEPLOY_H5=1 bash scripts/deploy-prod.sh

# 目标变化时覆盖默认值：
DEPLOY_HOST=ecs-user@1.2.3.4 SSH_KEY=/path/key REMOTE_ROOT=/opt/junshi \
REMOTE_RUNTIME_USER=junshi PUBLIC_BASE=http://1.2.3.4 PUBLIC_DOMAIN=https://example.com \
bash scripts/deploy-prod.sh
```
脚本会打包当前 git `HEAD`、上传到 ECS、替换 tracked 应用目录（保留 `server/.env`、`logos/`、`backups/` 等运行时/主机产物）、执行 `npm ci` / `prisma generate` / `db push --skip-generate` / 后端构建重启 / admin 构建发布 / nginx reload / 公网 smoke。`DEPLOY_H5=1` 时构建并发布 `app/dist-h5/`；微信原生迁移后不得再从旧 `app/dist/` 复制，否则构建虽绿、复制阶段仍会中断且线上继续保留旧 H5。已完成线上 schema 只读核对、且本次明确没有数据库变更的代码热修复，可显式使用 `SKIP_DB_PUSH=1 bash scripts/deploy-prod.sh` 保留生产额外列/索引；它不是常规默认值，任何有意 schema 变更仍须走 `db push` 预检与备份。例行升级不跑 `npm run db:seed`，避免重灌演示数据影响线上业务；`server/.env` 不纳入上传包、不改权限。`npm audit` 提示只作为依赖治理信号，非部署阻断项；真正阻断以构建失败、`junshi-api` 非 active、裸 IP/域名 `/api/health` 非 200 或域名 `/admin/` 非 200 为准；裸 IP `/admin` 预期为 404。
`.claude/worktrees/*/AGENTS.md` 是 Claude 工作树副本，不是维护源；需要固化流程时改根目录 `AGENTS.md`、`scripts/deploy-prod.sh` 和必要的 `docs/*`。
正式微信小程序发布仍走 §11「本机上传到小程序平台」：上传前后同步 `docs/WEAPP_RELEASES.md`，版本号/描述与上传命令一致；连真实后端的小程序包用 `WEAPP_APP_MODE=server WEAPP_APP_API=https://你的域名/api npm run build:weapp`（生产固定域名直接用 `npm run build:weapp:server`）。

**预发环境**固定为 `/opt/junshi-preprod` · `junshi-api-preprod` · `:4001` · DB `junshi_preprod` · `https://wxapi.aibuzz.cn/api_preprod`，只用 `scripts/deploy-preprod.sh`。该脚本每次部署都会复制生产 `ai_setting/ai_model` 供真实模型验收；AI 对话/Embedding/Rerank 凭证现统一明文存库，不再把生产 `APP_ENCRYPTION_KEY` 持久写进预发。兼容窗口里若生产行仍是旧 `enc:v1` 密文，脚本只在迁移进程环境中临时传入生产旧主密钥，整批解密成功后原子写为明文，并硬验密文为 0；生产完成同一迁移后自然不再需要主密钥。脚本仍会删除预发 `.env` 中所有 `WECHAT_PAY_*` 真商户凭据，并强制 `NODE_ENV=development` + `PAY_MOCK_SUCCESS=true` + `PAY_SANDBOX=false` + `ALLOW_DEMO_PURCHASE=false`：预发可走真实订单/权益状态机，但绝不触发微信真扣款。快出片预发固定回源同机隔离 AIStar `http://127.0.0.1:8081`，必须配置 `AIDRAMA_CLIP_ALLOW_PRIVATE_NET=true` 与双方一致的独立 service token；AIStar 其它 API 不对公网开放。**注意：`8.136.36.175` 是军师生产宿主机，所以这套 AIStar 只能称“共宿主的逻辑预发”，不是独立预发服务器；军师生产并不调用它，而是以 `AIDRAMA_CLIP_BASE_URL=https://api.aibuzz.cn` 跨服务器调用 `47.98.162.120` 的 `aistareco-server`。**小程序预发包用 `cd app && npm run build:weapp:preprod`，并核对 `dist-native/junshi-build-meta.json` 的 `runtime/mode/api/gitSha`；DevTools CLI 的 `--project` 仍指向 `app/`。**预发构建与生产同机，这不是免费的（2026-08-15 事故）**：Prometheus 还原出部署前 `/tmp` tmpfs 的 Shmem 已随 AIStar Clip 历史 JAR 残留从约 48MiB 阶梯增长到约 2.97GiB，宿主 `MemAvailable` 只剩约 670MiB且无 Swap；随后预发 `npm ci` 把 CPU 推到约 84%，SSH/HTTP/监控陆续失联。Dify 已按用户决定下线并保留 `/opt/dify` 数据。部署脚本不再覆盖在线 server：候选版本在 `/opt/junshi-preprod/releases/release-*` 完成依赖、Prisma 生成和 build，确认 `dist/index.js` 后原子切换 `/opt/junshi-preprod/server` 符号链接；启动/本机 health 失败自动切回上一版。构建前 `MemAvailable <3GiB` 拒绝，npm/prisma/build 通过 transient systemd cgroup 限制为 `MemoryMax=2G`、`MemorySwapMax=0`、`CPUQuota=100%`、`Nice=19` 与 idle IO。AIStar 的 `deploy-clip-preprod.sh` 同步以 `trap` 清当前 `/tmp` JAR并兜底清理超过 60 分钟的同类残留。

**「快出片」后端职责与配置边界**：军师 BFF 负责军师 JWT/租户、脚本 AI、文本与媒体审核、积分预扣结算退款、通知、审计与限流，其运行时真源是 `AIDRAMA_CLIP_*`、`CLIP_MEDIA_MODERATION_*`、`ALIYUN_GREEN_*`、`WECHAT_SUBSCRIBE_AVATAR_TEMPLATE_ID` 和军师自身 LLM/套餐配置；AIStar Clip 负责模板/项目/素材/数字人/声音/任务/作品、石榴 speaker/avatar/TTS/video、ffprobe、抽帧、FFmpeg 总装、字幕/BGM/标识、质检、存储与回收，其真源是 `AEP_CLIP_SERVICE_TOKEN`、`AEP_CLIP_SHILIU_*`、`AEP_CLIP_PRICE_*`、任务/素材/回收/质检阈值及 AIStar DB/存储/CDN/FFmpeg 配置。两边 service token 必须成对一致；军师用户 JWT 不发给 AIStar，石榴 token 不进入军师或小程序。生产目标是 `172.30.184.223` 军师 → `172.30.184.224` AIStar 的同 VPC 私网回源，并继续保持两机资源隔离；4 核 / 7.3 GiB、无 Swap 的军师宿主当前不允许再常驻一套 Clip 生产。详见 `docs/DEPLOYMENT.md` §8.1。

### ★ 一键开发（PostgreSQL，推荐）
```bash
npm run dev            # 根目录：确保 PG → 建库 → 迁移 → (首次)灌种子 → 同时起 后端 + H5 + 运营后台
```
- 入口 `scripts/dev.sh`（根 `package.json`）。打开 **H5 http://localhost:5173**（浏览器手测）、后台 http://localhost:5174（改模型）、API :4000。
- 可配：`AI_PROVIDER=openai npm run dev`（真实模型）、`SEED=1 npm run dev`（强制重灌种子）、`DATABASE_URL=... npm run dev`（指向已有库）、`DB_NAME/DB_USER/DB_PASS/DB_HOST/DB_PORT` 覆盖默认。
- 演示账号手机号 `13800000000`（含演示项目/报告/知识）；Ctrl+C 一并关闭三端。

### 本地 mock（零依赖，纯前端走查）
```bash
cd app && npm install && npm run dev:weapp   # 微信开发者工具导入 app/dist-native/；或 npm run dev:h5 浏览器
```

### 真实后端（PostgreSQL）
```bash
cd server && npm install
cp .env.example .env            # 配 DATABASE_URL；AI_PROVIDER 按需
npm run db:push && npm run db:seed
npm run dev                     # http://localhost:4000
# 原生小程序连后端：WEAPP_APP_MODE=server WEAPP_APP_API=http://localhost:4000/api npm run dev:weapp
cd admin && npm install && npm run dev   # 运营后台
```

### 构建校验基线（每次大改后应保持全绿）
- `server`：`npx tsc -p tsconfig.json --noEmit` → 0
- `app`：`npm test` → 原生路由/非受控 textarea/Lucide/产物隔离 + H5 typecheck + PC 零 Taro/区域真源守卫全绿；`npm run build:weapp:server` → 原生 49 路由四件套、JS 语法、无 Taro 引用、生产元数据校验通过；`npm run build:h5` → Taro H5 构建成功；改 PC 另跑 `npm run build:pc`
- `admin`：`npx tsc -b && npx vite build` → 0 + built

**app / admin 纯函数单测（2026-07-21 起，`node --import tsx --test`，与 server 同一套工具链，无需额外起服务）**：
两端此前完全没有测试基座；例行 QA 发现「方案库详情」页 / 运营「调教沙盒」都对报告 V2 类型化 section
直接读 `sec.h/sec.b/sec.list` 而静默剥空内容后，才各自补上最小基座——只覆盖**不依赖 JSX/DOM 渲染的纯函数**
（如 `app/src/services/deliverableSection.ts`、`admin/src/ui.tsx` 的 `sandboxSection`），不是完整的组件/端到端测试。
```bash
cd app   && npm test   # node --import tsx --test src/**/*.test.ts
cd admin && npm test   # 同上
```
**改「快出片」界面文案的固定口径（2026-08-28）**：用 `shuorenhua` skill（`~/.claude/skills/shuorenhua/`）做「去 AI 味」时，按这套判定走，别每次重新拍：

- 场景 `chat`（界面微文案 = 系统对用户的即时回应），档位 `minimal` 为主、翻译腔与自造口语升 `standard`，
  **scope 固定 `in-place`** —— 界面文案一句一个位置，删了就是开天窗，不许删整句、不许并句。
- ⚠️ **项目口径压过 skill**（skill 自己也这么规定）。最容易打架的一条：方案 §3.7.2 B 类要求
  「标签 / 按钮 / 状态 / 分类一律用行业通用词」，而「去 AI 味」的惯性是往口语走。
  **去 AI 味不等于改得更土**。实测这一轮 agent 就把状态词改成了「已经开始生成了 / 出好了 /
  这次没算出来 / 没下载完」，全部退回 §3.7.2 的映射（`做好了 → 已完成`、`没做成 → 生成失败`）。
- **术语 sweep 要么全落要么整族退出**，不能只改一半 —— 同一组件里出现两种叫法比不改更糟。
  实测这一轮就漏出过「在『我的数字分身』里随时删除」，而那个页面已经叫「我的数字人」，
  等于把用户指向一个不存在的页面。
- **「出镜」有两种含义，不能一刀切**：用户本人出镜（「不用出镜」「上传你的出镜视频」）保留本义；
  指数字人时长的必须限定成「数字人出镜 N 秒」—— 光秃秃的「出镜 32 秒」会被店主读成
  「要我自己讲 32 秒」，与首页承诺正面冲突。
- **protected spans 里额外要护住的**：法律授权声明正文（`mock.js` 的 `consentText`）、
  文档正式名（《数字分身素材使用说明》）、朗读脚本（`READING_SCRIPT`）、
  以及 AGENTS 已固定的全局文案（如 §0 第 7 条的「登录态已失效，请重新登录」）。
- **完成态不能前移**：`onPhase('processing')` 时还没拿到 `accepted`，就不能说「正在安排训练」。
- 落地方式：改写产物走 `FILE/FROM/TO` 精确替换，**对不上要报错而不是静默跳过**
  （静默跳过的话最后看到「大部分改了」，根本发现不了漏哪条）；解析 `TO:   xxx` 时注意别把
  对齐空格吃成文案内容，实测污染过 20 多处前导空格。改完由 `npm test` + `e2e:weapp` 当闸门。

**「快出片」主链的三层测试分工（2026-08-27 起）**，改分包代码前先认清自己该改哪一层：

| 层 | 文件 | 覆盖什么 | 依赖 |
|---|---|---|---|
| 纯函数 | `app/scripts/video-{catalog,model}.test.mjs` | 模板真值、报价、镜头切分、文案编辑规则 | 无 |
| **页面行为** | `app/scripts/video-chain.test.mjs` + `weapp-runtime.mjs` | 逐页走通 首页→模板专区→模板详情→改文案→配画面→确认→出片→作品：取数、状态流转、按钮 handler、跳转参数与页面栈 | 无 |
| 布局与渲染 | `app/scripts/video-e2e.mjs`（`npm run e2e:weapp`） | 主次入口的上下顺序、横向溢出、截图 | 微信开发者工具**已登录** + 服务端口已开 |

- `weapp-runtime.mjs` 是个最小微信运行时（`wx` / `Page` / `getApp` / `getCurrentPages`），让原生页面 JS 在 Node 里真跑。**它不冒充渲染**：WXML 编译、样式、布局测量只有开发者工具/真机能验，那是第三层的事。
- 它跑的是 **`weapp-native/` 源码**，不是 `dist-native`：构建器对 JS 是逐字节搬运，跑源码等于跑产物，且改完立刻生效；缺的那一个 `config/env`（只在构建时生成）由运行时注入 mock 档。**不要改成在测试里跑构建** —— `node --test scripts/*.test.mjs` 是并行的，写共享 `dist-native` 会和读产物的用例抢文件。
- wx 桩必须忠实回调 `success`：`services/nav.js` 的导航锁靠 `success`/`fail` 复位 `inFlight`，不回调就等于第一次跳转之后整个 App 再也跳不动，而症状是「点了没反应」。同理操作菜单要**按选项文案**选而不是按下标——`shots` 的 `pickAsset` 会按素材库有没有东西重排选项。
- **e2e 的夹具本身也会说谎**（2026-08-27 实测两次）：① 拍「不可重试」那屏时只翻了 `canRetry` 没换 `loadError`，截出「404 却说网络没通」这种生产里跑不出来的组合，走查照着它得出了一条假 P0；② gate 三态只 `setData({avatarState})` 从不登录，而 `home` 未登录时强制 `avatarState:'missing'`，于是三张图全是游客态——`01-home-guest.png` 与 `02-gate-missing.png` **md5 逐字节相同**；③ 采集页未登录会被全局登录浮层盖住，而**路由断言照样通过**，截出来的是「AI 军师」登录页。**教训：注入的假数据必须是该状态真会出现的值；断言路由不等于断言进对了页。**
- **换机后第三层要过两道门，缺一不可**（2026-08-27 实况）：① 开发者工具扫码登录；② **设置 → 安全设置 → 服务端口 开启**。只登录不开端口，CLI 仍卡在 `initialize` 退出码 246，而且**工具已在运行时错误信息是空的**——必须先完全退出工具再跑 CLI，才会打印真正的原因（「工具的服务端口已关闭」）。`cli quit` 自己也依赖服务端口，退不干净时用 `pkill -f wechatwebdevtools`；登录态在 profile 里，杀进程不会丢。开启的验证标志：`~/Library/Application Support/微信开发者工具/<profile>/Default/` 下出现 `.ide` 文件且该端口在监听。前两层不受这两道门影响，先用它们把行为守住。

**CI：`.github/workflows/frontend-unit.yml`**（2026-07-27 起）用 `admin` / `app` 两个 matrix job 跑 `npm ci` + `npm test`。
此前 CI 只跑 server，这两条命令全靠人工执行，`admin` 的 `tsx` 漏装后测试基座整整停摆一段时间都没人发现。
两个坑写在这里，别再踩：
- **Node 必须 >= 22**：`src/**/*.test.ts` 不是被 shell 展开的（npm 用 `/bin/sh`，不支持 globstar，原样透传给 node），
  而是 `node --test` 自己 glob——该能力 Node 22 才有。前后端 CI 都固定 node 24；后端 gateway/LLM gate 的异步计时用例在 Node 20 会被测试运行器提前结束事件循环并批量标为 cancelled，禁止降回 Node 20。
- **`node --test` 匹配到 0 个文件时退出码仍是 0**（只打印 `tests 0`），测试基座整体失踪也会是一片绿。
- **安全补丁不许按写死路径找依赖**（2026-08-27 实况）：`patch-swiper-security.mjs` 原来写死
  `node_modules/@tarojs/components{,-react}/node_modules/swiper/...` 两条嵌套路径。npm 把 `swiper` 提升到顶层后
  这两条路径不存在，脚本一个文件都没打到（它只在「一条都没找到」时才抛，而那正是它被跳过的方式），
  配套测试则红成 ENOENT，**看着像陈旧路径，实际是护栏已经没了** —— 顶层 `swiper@6.8.0` 里带修复模式的文件数为 0，
  而 Taro 解析到的就是它。现在统一走 `scripts/swiper-targets.mjs` 按 Taro 自己的解析规则定位，提升与否都不影响；
  测试断言的是「解析到的那份里已无脆弱写法」，不是「某条路径存在」。
  所以 CI 那步额外断言 `pass` 计数 > 0；移动/重命名测试文件后留意这个守卫。

两端 `tsconfig.json` 都 `exclude: ["src/**/*.test.ts"]`——测试文件不参与 `tsc -b`/`build:weapp` 的生产编译门
（两端都没有 `@types/node`，`node:test`/`node:assert` 类型解析不进生产类型检查范围）；新增纯函数时尽量一并补测试，
但不要为了凑测试覆盖率把需要真实 DOM/Taro 运行时的组件也塞进这套基座。

### 后端集成测试（★ 大变更必跑 · 详见 `docs/TESTING.md`）
- 入口：`server/src/app.ts` 的 `buildApp()` 工厂（`index.ts` 用它 listen，测试用 `app.inject` 免端口）。
- 跑法：备好测试库 → `DATABASE_URL=...junshi_test npm run db:push` → `AI_PROVIDER=mock npm test`。
- **隔离服务器压测**：使用 `loadtest/docker-compose.yml` 部署独立 API/PostgreSQL/网关，网关仅绑定
  `127.0.0.1:14080`，可通过 SSH 隧道从外部运行 `loadtest/k6-readonly.js`；在测试机本机运行 k6 时必须加入
  `junshi-loadtest_edge` 并访问 `http://gateway:8080`，不能从容器访问宿主 loopback。运行态固定
  `NODE_ENV=production`、HS256 JWT、Redis 限流与 `SCHEDULER_ENABLED=false`，同时使用 `AI_PROVIDER=mock`；API 仅接无公网出口的 Docker internal network；
  短信、微信、支付、OSS、embedding/rerank 与生产数据库均不接入。数据由
  `server/prisma/loadtestSeed.ts` 生成确定性假数据，禁止复制线上用户数据。操作与清理命令见
  `loadtest/README.md`。真实 LLM 仅允许使用独立的 `loadtest/k6-llm.js` 最小消耗探针：
  一个字符输入、`max_tokens=1`、固定请求数、逐档核算总 Token；0600 token 文件挂入 k6 时使用只读 root 容器，不放宽宿主文件权限；密钥只进临时 `0600`
  env 文件且测试后删除，不得接入业务生成接口或写入仓库。
- **LLM 零 Token 闸门补测（2026-07-28）**：默认 mock 不占槽位；仅隔离压测显式配置 `AI_MOCK_LATENCY_MS>0` 时，`providers/mock.ts` 才经同一 `llmGate` 持槽，配合 `k6-llm-queue.js` 实测 8/12/20/40 并发的排队与超时行为。`AI_MOCK_429_FIRST_N` 可确定性注入前 N 次 429，用于验证冷却及恢复，默认 0；这些变量禁止出现在生产环境。实测 40 个约 3 秒的同到请求全部成功，最大队列 28、最长等待 9.64 秒；这不是供应商并发配额，真实提供方仍须使用可撤销、日限额的独立 key 做最小探针。
- 全程 mock 模型（确定性、可复现），无需真实 key/pgvector。**现状 1530 用例 / 256 套件（0 跳过）**；覆盖微信登录 openid 复登、运营后台鉴权、算力/套餐购买（含挂牌价/优惠价生效窗）、大模型接入配置、智能体权益、军师档案访谈、问策入口 WP1（分桶/主动消息/词池/埋点）、连续主线/摘要滚动合并、事实确认、复杂交付、9 图批处理与用户主路径。最近一次本地 PostgreSQL 测试库全量实跑为 2026-08-10（独立测试库 `junshi_test`），1530/1530 全过。
- **并行分支要用独立测试库**：`server/.env.test` 的 `DATABASE_URL` 是唯一入口，worktree 里改成 `junshi_test_<主题>` 即可与主检出并行跑测试而不互相 `db push` 冲 schema（本次 WP1 用的是 `junshi_test_wence`）。合回 main 前记得把这行改回 `junshi_test`。
- **★ 测试环境自足（hermetic env，2026-07-27 起）**：`npm test` 只吃 `.env.test` + 真实 shell 环境 + 用例内显式设置，**绝不吃开发机的 `server/.env`**——否则用例红绿取决于谁的机器（CI 没有 `.env` 故长期为绿）。三层机制：① `src/env.ts` 在 `NODE_ENV=test` 时整体跳过 dotenv；② `@prisma/client` 会在 import 与每次 `new PrismaClient()` 时**无条件**读 `server/.env`（路径烤进生成产物、与 cwd 无关，Prisma 5.22 无 opt-out），故 `test/hermeticEnv.mjs`（由 test 脚本 `--import` 预载）记下进程启动时的键集合并抹除后来被注入的键，`src/db.ts` 在构造语句下一行调该钩子；③ 守卫用例 `test/envHermetic.test.ts` 读 `.env` 的键做通用断言（不 pin 变量名），所以往 `.env` 里加新键不会再弄红测试。**推论**：用例要用的变量写进 `.env.test` 或在用例里显式 set/delete，别指望 `.env`。
- **★ AI v2 测试配置必须归还现场（2026-08-14 起）**：`AiCredential/AiEndpoint/AiRoute/AiRouteMember` 是运营配置，刻意不进 `resetBusinessData()`（该函数还被生产 seed 共用，加入会误删真实接入）；任何测试用 `configurePurpose()` 或直接写这四表，都必须在 `after/finally` 调 `__wipeAiV2()`。约定“全程 mock”的聚合套件还要在入口显式复位，不能相信共享 `junshi_test` 恰好干净。历史坑：`structuredBilling.test.ts` 留下 OpenAI chat 路由后，TC-L 动态预留从 2,000 变 136,000，8 并发中第 4 个起返回 402；这不是 429 限流或 503 过载。
- **UserJourney 首次并发建行**：禁止用空更新 `upsert()` 假设数据库原子建行；Prisma 在首次并发下可能撞 `userId` 唯一键。统一用 `createMany({ skipDuplicates:true })` 建幂等初始行后再读取，事件迁移继续走带状态条件的 `updateMany()`。
- **测试夹具不得依赖日历碰巧未过功能上线日**：只验证 provider/gateway 的新注册用户必须显式创建 Profile 或其它已入局锚点，不能靠 `createdAt < ONBOARDING_ROLLOUT_AT` 绕过首次入局；否则固定上线日期一过，请求会被补档案流程提前接管，原本绿色的测试会集体变红。
- 覆盖：鉴权隔离、微信 openid 登录/复登、注册花名、军师档案、运营后台鉴权、多智能体对话、智能体 `free/unlock/metered` 权益、记忆语义召回+TTL、项目+知识库+跨对话召回、跨项目隔离、对话汇总、版本化报告+diff、**★跨用户隔离（防信息泄露 TC-G）**、模型配置不泄露明文 key、SSE 流式、内容审核拦截、算力赠送/扣减/不足拦截、套餐购买/企业版不限量、并发回归（智能体购买、套餐发放、短信发放/消费、报告版本、智能体发布）、首登建档个性化、老用户回流、跨智能体协同+引用闭环、成果反馈回流、用户主路径、边界健壮性。
- Node 运行时统一固定 **24.x**：仓库根 `.nvmrc/.node-version` 与三端 `package.json#engines` 均为 `>=24 <25`；CI 同样使用 Node 24。不要用 Node 22 跑后端全量测试（`unref` 定时器会产生 cancelled），也不要把未验证的 Node 25 当作发布基线。
- CI：`.github/workflows/server-integration.yml` 用 GitHub Actions Node 24 + `postgres:16-alpine` 服务（tmpfs 数据目录）执行 `npm ci`、`prisma generate`、后端 build、`prisma db push`、`npm test`。
- 红线：改 路由/鉴权/检索/上下文/数据模型 后必须 `npm test` 全绿；新增可隔离数据类型须在 TC-G 补「跨用户不可见」断言。

### 微信支付本地验证（不触达微信，两条通道互补）
- **沙箱通道** `npm run pay:e2e`（22 项）：`PAY_SANDBOX=true`，绕过加解密专注业务状态机——套餐/SKU 下单入账、月→年折算、过期降级/只读、续费恢复、幂等。
- **真实代码路径通道** `npm run pay:e2e:mock`（19 项）：起本地 mock 微信支付网关（`src/services/wechatPayMock.ts`）+ 真实监听端口的 app，完整走 商户请求 RSA 签名 → 网关验签发 `prepay_id` → `paySign` 可验 → 官方格式加密回调（APIv3 AES-256-GCM + 平台私钥签名）→ `/pay/wechat/notify` 验签解密幂等入账 → 重复回调幂等 → 篡改签名 401 → 回调丢失时 `GET /pay/orders/:no` 主动查单补账 → 他人订单 404。同链路已入 `npm test`（`test/wechatPayMockFlow.test.ts` 14 用例，另覆盖：降级守卫 409、对账 sweep 自动补账/关单、admin 卡单清单与手动补账、回调金额不一致拒绝入账、条款快照发放、close-on-supersede、订单列表/继续支付/超时 409、全额退款+权益回收+幂等、下单频控 429、admin 手动开通套餐/模块、平台证书自动下载轮换验签、admin 搜索/分页/CSV 导出）。mock 网关模拟 下单/查单/关单/退款/平台证书下载 五个 v3 端点。
- **手动联调**：`npm run pay:mock` 独立起 mock 网关（默认 `:9860`，密钥持久化 `server/.paymock/` 已 gitignore），启动时打印整套可粘贴进 `server/.env` 的 `WECHAT_PAY_*`（含 `WECHAT_PAY_BASE` 指向 mock）；下单后 `curl -X POST http://127.0.0.1:9860/mock/pay/<outTradeNo>` 模拟用户付款触发真实格式回调。

### 端到端隔离验证（本地 Postgres + mock provider）
已用 curl 跑通 **19/19**：无 token→401、新号建号、A/B token+租户不同、A 建档/产出/存库后 A 有数据而 **B 全空（隔离）**、A 复登 token 不变且 onboarded 持久化、demo 号可登录、非法 token→401、非法手机号→400。

### 本机上传到小程序平台（miniprogram-ci）
> 云端沙箱网络白名单未放行 `servicewechat.com`，需在**本机**执行。
> 每次上传前后必须同步 `docs/WEAPP_RELEASES.md`，上传命令里的版本号/描述要与该文件记录一致；不要把每次上传明细塞进 AGENTS.md。正式上传只走 `release:weapp`，不要裸调 DevTools CLI/GUI。
```bash
cd app
npm run release:weapp -- --version 0.2.22 --desc "本次变更说明"
```
注意：发布脚本会强制重建并校验 `junshi-build-meta.json`，拒绝 mock、非生产 API、旧产物及构建/上传版本号不一致；备用 `upload:weapp` 使用上传密钥时仍受 **IP 白名单**约束。连真实后端版本另需把 API 域名加入 request 合法域名（见 §12）。

### 微信账号登录联调
```bash
cd server
cp .env.example .env
# 填 WECHAT_MINI_APPID=wx810ebe6dfef8e75f 与 WECHAT_MINI_SECRET
npm run db:push && npm run dev

cd ../app
WEAPP_APP_MODE=server WEAPP_APP_API=https://你的域名/api npm run build:weapp
```
微信开发者工具本地走查导入 `app/dist-native/`；真机/预览必须把 `WEAPP_APP_API` 的 HTTPS 域名加入小程序后台 request 合法域名。

### 微信消息推送 URL 验签联调
```bash
cd server
# .env 里配置：WECHAT_MESSAGE_TOKEN=与你在微信后台填写的 Token 完全一致
npm run dev
```
微信后台「消息推送 URL」填 `https://你的域名/api/wechat/message`，Token 填 `WECHAT_MESSAGE_TOKEN` 的值。GET 验签通过会原样返回微信传入的 `echostr`；POST 推送会先验签再返回 `success`。

订阅消息另配小程序后台「订阅消息」模板：
- `WECHAT_SUBSCRIBE_REVIEW_TEMPLATE_ID`：复盘提醒，字段 `thing1=提醒事项`、`time2=提醒时间`、`thing3=备注`。
- `WECHAT_SUBSCRIBE_REPORT_TEMPLATE_ID`：报告生成，字段 `thing1=报告名称`、`phrase2=状态`、`time3=完成时间`、`thing4=备注`。
- 前端执行页「复盘 → 订阅复盘提醒」会调 `wx.requestSubscribeMessage`，服务端只在用户接受后累计一次可发送额度。
