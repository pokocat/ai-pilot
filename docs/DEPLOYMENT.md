# 军师 · 部署架构与上线指南（DEPLOYMENT）

> 给"帮我部署到服务器"的 agent 看：照本文件即可把军师跑到一台 Linux 服务器上供测试/试用。
> 主路径（裸机 Node + Nginx + 系统 Postgres）已在本地按生产构建实测：`npm run build` 出 `dist/`、`node dist/index.js` 起服务正常。Docker 段为模板（本环境无 docker 守护进程，未实测）。
> 配套模板见 `deploy/`：`nginx.conf.example` · `junshi-api.service` · `Dockerfile.server` · `docker-compose.yml`。

---

## 1. 架构总览

```
                         ┌────────────────────────── 你的服务器 ──────────────────────────┐
   浏览器 / 微信小程序     │                                                                │
        │                │   Nginx (443, 反向代理 + 静态托管)                              │
        ▼                │     ├── /          → H5 静态 (app/dist-h5)       ── 静态        │
   https://域名 ─────────┼──►  ├── /admin/    → 运营后台静态 (admin/dist)   ── 静态        │
                         │     └── /api/      → 反代 http://127.0.0.1:4000  ── 动态        │
                         │                              │                                  │
                         │                     ┌────────▼─────────┐                        │
                         │                     │ 后端 API (Node)  │  Fastify + Prisma      │
                         │                     │ node dist/index.js│  :4000                 │
                         │                     └────────┬─────────┘                        │
                         │                              │ Prisma                           │
                         │                     ┌────────▼─────────┐                        │
                         │                     │   PostgreSQL 14+ │  业务数据(行级隔离)     │
                         │                     │  (可选 pgvector) │  AiSetting(模型配置)    │
                         │                     └──────────────────┘                        │
                         └────────────────────────────────┬───────────────────────────────┘
                                                          │ 出站(可选)
                                          大模型网关：Agnes / DeepSeek / Qwen / OpenAI / Claude
                                          （在运营后台「模型」页配置；未配 key 自动降级本地 mock）
```

- **三个可独立部署的组件**：后端 API（动态）、H5（静态）、运营后台（静态）。
- **一个数据库**：PostgreSQL（单库收敛，业务数据 + 向量 + 模型配置都在里面）。
- **外部依赖（可选）**：大模型网关，仅当在后台配了真实 key 才出站调用；否则零外部依赖（mock）。

## 2. 组件 · 构建 · 运行

| 组件 | 目录 | 构建命令 | 产物 | 运行 |
|---|---|---|---|---|
| 后端 API | `server/` | `npm ci && npx prisma generate && npm run build` | `dist/` | `node dist/index.js`（systemd/pm2 守护） |
| H5（移动端 Web） | `app/` | `TARO_APP_MODE=server TARO_APP_API=https://域名/api npm run build:h5` | `app/dist-h5/`（静态） | Nginx 托管 |
| 运营后台 | `admin/` | `npm ci && npm run build -- --base=/admin/` | `admin/dist/`（静态） | Nginx 托管 |
| 微信小程序 | `app/weapp-native` | `WEAPP_APP_MODE=server WEAPP_APP_API=https://域名/api npm run build:weapp` | `app/dist-native/`（原生 weapp 包） | 微信开发者工具上传（见 §8） |

> 小程序与 H5 是两套渲染实现、同一后端契约；上线小程序额外需要备案与合法域名（§8）。
> 测试期若需让新注册用户默认开通高级套餐，可在服务端 `.env` 设置 `TEST_DEFAULT_PLAN_NAME=决策版` 并重启；存量用户先运行 `npm run db:grant-test-plan -- --plan=决策版` 试算，确认后追加 `--apply`。脚本不会降级企业私有化或重复发放有效同档套餐。

## 3. 前置

- 服务器：Linux（Debian/Ubuntu 示例），Node **20+**，Nginx，PostgreSQL **14+**（pgvector 可选）。
- 一个域名 + 解析到服务器；HTTPS（Let's Encrypt/certbot）。AI 类应用对外通常还需 ICP 备案（§8）。

---

## 4. 部署步骤（裸机，主路径）

### A0. 时区（务必，例行 QA 2026-07-08 新发现）

`server/src/services/clock.ts` 的 `now()` 用 `new Date()`，`casefile.ts`（今日军令 / 每日复盘归档）、
`reviewLog.ts`（复盘连续天数、决定 尉官/校官/将军/元帅 段位晋升）、`progress.ts`（里程碑解锁日期）、
`scheduler.ts`（21:30 前后夜间复盘提醒推送）等所有「今天」「几点」判断都基于 **宿主机本地时区**
的 `Date` getter（`getHours()`/`getFullYear()`/...）。裸机默认时区未必是 Asia/Shanghai（云厂商镜像
常见 UTC），务必先确认：

```bash
timedatectl                                   # 看 Time zone 是否已是 Asia/Shanghai
sudo timedatectl set-timezone Asia/Shanghai   # 不是则设置（无需重启，Node 进程读实时 tzset）
date                                          # 复核输出的时区缩写
```

不设置的后果：夜间复盘提醒会在 UTC 21:30（= 次日凌晨 05:30 北京时间）而非晚间推送；
00:00–07:59 北京时间活跃的用户，其「今日」军令 / 复盘归档会被错误地记到前一个自然日，
可能影响连续打卡天数与段位晋升判定。Docker 部署已在 `deploy/Dockerfile.server` 里固定
`TZ=Asia/Shanghai`，systemd 单元也已加 `Environment=TZ=Asia/Shanghai`，但**裸机直接
`node dist/index.js` 跑（不经 systemd）时这两处都不生效，只能靠宿主机时区本身正确**。

### A. PostgreSQL
```bash
sudo apt update && sudo apt install -y postgresql
sudo -u postgres psql <<'SQL'
CREATE USER junshi WITH PASSWORD '强密码';
CREATE DATABASE junshi OWNER junshi;
SQL
# DATABASE_URL = postgresql://junshi:强密码@127.0.0.1:5432/junshi?schema=public
```
（可选 pgvector，见 §6。）

### B. 后端 API
```bash
sudo useradd -m -r junshi || true
sudo mkdir -p /opt/junshi && sudo chown junshi /opt/junshi
# 取代码（git clone 或上传），使 /opt/junshi/{server,shared,app,admin,...} 就位
cd /opt/junshi/server
cp .env.example .env        # ★ 编辑 .env：填 DATABASE_URL、PORT=4000，密钥建议留空（用后台配模型）
npm ci
npx prisma generate
npm run db:push             # 建表（无 migrations 目录，用 db push）
npm run db:seed             # 灌智能体/套餐/献策/问卷/演示账号(13800000000)。生产首次后勿重复（会清业务数据）
npm run build               # → dist/
# 守护进程（二选一）：
sudo cp /opt/junshi/deploy/junshi-api.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now junshi-api
journalctl -u junshi-api -f # 看日志，确认「军师 API ready」
# 或 pm2： pm2 start dist/index.js --name junshi-api && pm2 save && pm2 startup
```
自检：`curl http://127.0.0.1:4000/api/health` → `{"ok":true}`。

#### 大模型接入配置重设计发布（2026-08-08）

**schema 变更已预检，`db push` 不需要 `ACCEPT_DATA_LOSS`。** 用 `prisma migrate diff` 对着改动前的库
生成过实际 SQL，全量是：`ai_model` 加 6 列、`ai_setting` 加 2 列并改 4 个列默认值、新建 4 张表 + 4 个索引。
**没有 DROP、没有对既有列 `SET NOT NULL`**；两个唯一索引都建在全新空表上，不同于 2026-08 微信
`transactionId` 那次（给存量数据加约束、必须先查重复值）。所以这次**不要**去开 `ACCEPT_DATA_LOSS` —— 
真要被 data-loss 门拦住，说明实际 schema 与预期不符，应当停下来查，而不是加开关绕过。

复核用（生产上执行前可自行再跑一遍，只读不写）：

```bash
cd /srv/junshi/server && npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script
```

发布后**默认什么都不会变**：`AI_CONFIG_V2` 不设＝完全走旧表；四张新表建了但空着。
一期修复（探活不再被端点池劫持等）与二期护栏（保存时的互斥校验、端点检测）即时生效。
定时探活默认开启且会真实计费，要停设 `AI_PROBE_SCHEDULED=false`（见 §E3）。
归一化切换是独立的一次性动作，见 §E2，与本次发布解耦。

#### 持久对话生成首次发布（2026-08-05）

本次数据库变更是加法：新增 `generation_job / generation_attempt / generation_effect`，并给
`session.activeGenerationId`、`message.generationUserJob/generationResultJob` 增加可空关系与索引。
生产仍须先备份并人工复核 `prisma db push` 预览，不得因为“理论上是加法”就常驻打开
`ACCEPT_DATA_LOSS`。发布顺序固定为：

1. 备份 PostgreSQL，执行 `bash scripts/deploy-prod.sh` 发布服务端与 schema；先不上传新小程序。
2. 核对 `/opt/junshi/.deploy-version`、`junshi-api`、`/api/health` 与 `/api/metrics`；确认 worker 已启动，
   `junshi_chat_generation_total`、分段时长、恢复与估算序列都可被 Prometheus 抓取。
3. 用内部真实账号发起一轮至少 60 秒的对话：切后台/关闭页面后等待，再进入原会话。列表应显示阶段，
   进入后继续看到同一 `generationId` 的权威快照；不得新增第二条 user message。另测一次显式“停止生成”。
4. 查库确认一轮只有一个 job、一条 user message、最多一条结果消息，`settlementStatus` 已终态，
   `quotaCharged` 与 attempts 累计一致；pending/running effect 能继续被 worker 消费。
5. 服务端验证通过后，才用正式 `release:weapp` 上传带稳定 `clientRequestId` 的小程序版本；旧客户端未带该字段，
   仍走兼容 inline 路径。每日战报旧 POST 返回 410、历史 daily HTML/PDF 返回 404 是本次预期收口，不得回滚成公开链接。

抽查 SQL（只读）：

```sql
SELECT status, "settlementStatus", COUNT(*)
FROM generation_job
GROUP BY status, "settlementStatus"
ORDER BY status, "settlementStatus";

SELECT status, COUNT(*)
FROM generation_effect
GROUP BY status
ORDER BY status;
```

回滚只回滚应用版本，不删新表、不清 generation/message/usage 事实。若只回滚小程序，新流量自然回到旧 inline
入口；若回滚服务端，先确认没有 active job，保留新增表与可空字段，避免向后迁移造成数据损失。上线后按
`docs/CHAT_STREAMING_RELIABILITY_PLAN.md` §12.4 连续观察 24 小时，达标前不得标记生产验收完成。

#### 方案/支付账本首次发布前置（2026-08-02）

本次 schema 会为微信 `transactionId` 与 `(userId, clientRequestId)` 增加唯一约束。不要直接把 `db push` 当成数据清洗；先只读检查历史重复值（正常应为 0 行）：

```sql
SELECT "transactionId", COUNT(*)
FROM "payment_order"
WHERE "transactionId" IS NOT NULL
GROUP BY "transactionId"
HAVING COUNT(*) > 1;

```

如有重复，先根据订单、微信交易号和权益实际发放结果人工核对，不得盲删。`clientRequestId` 是本次新增的可空字段，历史行均为 null，不会与 `(userId, clientRequestId)` 唯一约束冲突。唯一约束落库后，回填存量套餐的商业稳定字段：

固定生产部署脚本为这类已经人工复核的新唯一约束保留了显式开关：`ACCEPT_DATA_LOSS=1 bash scripts/deploy-prod.sh`。只能在上述查重为空、当次 schema diff 已人工确认无删列/缩窄类型后使用；不要把该开关设为常驻默认值。

```bash
cd /opt/junshi/server
npm run db:backfill-plan-commercial
# 复核 family / tier / usage 和每月权益输出后再执行
npm run db:backfill-plan-commercial -- --apply
```

最后在运营后台复核同 family 月付/年付的月度权益相同，`standard/5x/20x` 的真实倍率校验通过。回填脚本不修改价格，定价仍只归运营后台管理。

### C. 前端 H5 + 运营后台（静态）
```bash
# H5（指向你的公网 API）
cd /opt/junshi/app && npm ci
TARO_APP_MODE=server TARO_APP_API=https://你的域名/api npm run build:h5
sudo mkdir -p /var/www/junshi/h5 && sudo cp -r dist-h5/* /var/www/junshi/h5/

# 运营后台（子路径 /admin/ 需带 base 构建；后台用相对 /api，同源即可）
cd /opt/junshi/admin && npm ci && npm run build -- --base=/admin/
sudo mkdir -p /var/www/junshi/admin && sudo cp -r dist/* /var/www/junshi/admin/
```

### D. Nginx 反向代理 + HTTPS
```bash
sudo cp /opt/junshi/deploy/nginx.conf.example /etc/nginx/sites-available/junshi.conf
# 编辑：server_name=你的域名；root=/var/www/junshi/h5；/admin/ alias=/var/www/junshi/admin/
sudo ln -s /etc/nginx/sites-available/junshi.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名        # 自动签证书 + 跳转 443
```
要点（已在模板里）：`/api/` 反代 :4000；SSE 流式需 `proxy_buffering off`；`proxy_read_timeout 180s` 给 LLM 产出留时间。

如果线上保留裸 IP 的 HTTP server 块（例如固定 ECS 的 `http://8.136.36.175`），裸 IP 只用于 `/api/` 健康检查和兼容回调，不暴露运营后台：`/admin` 与 `/admin/` 必须直接返回 404。运营后台统一从域名 HTTPS 入口访问：`https://wxapi.aibuzz.cn/admin/`。

### E. 配置大模型（可随时切换）
打开 `https://你的域名/admin/` → **「模型」页** → 选内置接入商预设（**七牛分两条：Anthropic 协议 / OpenAI 兼容——同一家两个协议是两个不同的 baseUrl，选错就是上线后 404/400**）→ 填 API Key → **测试连接** → 保存即生效。**未配 key 时全站自动用本地 mock**（零成本可演示）。

保存时后台会跑互斥校验：`error` 直接拒绝（这份配置发出去必然失败），`warn` 可存但常驻黄标（能跑，但结果不是你以为的那样，例如 DeepSeek 的 Anthropic 端点会忽略思考预算）。端点行的「检测」按钮跑连通性 / Thinking 写法 / 模型范围三项，结果会回填能力标记；「固化方言」把当前推断出的协议方言写死，之后请求组装不再靠推断。

### E1. 「模型」页走查清单（2026-08-07 二三期新增的界面，登录后两分钟过一遍）

这些界面在管理员鉴权之后，自动化走不到；展示逻辑本身已提成 `admin/src/modelGateway.ts` 的纯函数并单测（26 例），
所以要看的不是「文案对不对」，而是**取值有没有接上**——列表页每一项都该显示出真实值而不是空白或 `undefined`：

| # | 位置 | 该看到什么 | 不对的话说明 |
|---|---|---|---|
| 1 | 端点行第二排 | `方言 xxx（已固化）` 或 `（推断中 · 点右侧「固化方言」确认）` | 空白＝后端没回 `resolvedDialect` |
| 2 | 端点行第二排 | `上次检测 …通过/未过` 或 `从未检测` | 显示成「通过」但从没测过＝取值接错 |
| 3 | 端点行按钮 | 未固化的端点才有「固化方言」按钮；点一次后该按钮消失、文案变「已固化」 | 点完不变＝PATCH 没带 `dialect` |
| 4 | 端点行按钮 | 「检测」跑完弹 toast，未过项要写出中文名（如「Thinking 写法」）而不是 `thinking` | 出现英文枚举＝没走 `probeName` |
| 5 | 编辑表单 · 单价区 | **四个**输入框（输入 / 输出 / 缓存读 / 缓存写） | 只有三个＝`priceCacheWrite` 没接上 |
| 6 | 编辑表单 · 保存 | 故意把 baseUrl 填成 `…/v1/chat/completions` → 保存应被拒并说明原因 | 存进去了＝校验器没接上 |
| 7 | 检索增强区 | 对话端点是 Anthropic 协议 / 七牛时，出现红条说明，且 baseUrl 与 Key 标「（必填）」 | 仍写「留空＝复用对话模型」＝闸门没生效 |
| 8 | 归一化配置区 | 跑过迁移才出现；显示各用途路由与主端点 | 迁移前不出现是**正常**的 |

第 6、7 两条是**故意造错来验拦截**，验完记得改回去。

### E2. 归一化接入配置切换（重设计三期 · 一次性，可回滚）

> 背景与设计见 `docs/[OPUS5]AI_CONFIG_REDESIGN_2026-08-07.md`。**不做这一步也完全正常**——`AI_CONFIG_V2` 不开就是旧行为。
> 做了之后的收益：对话 / 成果 / 辅助抽取 / 嵌入 / 重排各走各的路由（辅助档不再只能改 env + 重启），一把 key 喂多个端点、换 key 只改一处。

```bash
cd /srv/junshi/server
npx prisma db push                 # 建四张新表（纯新增，旧表一字不动）
npm run ai:migrate                 # ① 预演：只打印要发生什么，不写库
npm run ai:migrate:apply           # ② 写入（幂等，可反复跑）
```

③ 打开后台「模型」页看**「归一化接入配置」**分区，或直接 `GET /api/admin/ai-v2-status`：
   - `ready` 必须为 `true`（chat 路由有可用端点）。**`false` 时切过去就是把 AI 关掉**，别切。
   - 有「待确认接入商」的凭证就先在后台确认——迁移期只标黄不阻断，但删旧列之前必须清零。

④ 切读路径：`server/.env` 加 `AI_CONFIG_V2=true` → `systemctl restart junshi-api`。
   **回滚 = 把这行删掉再重启**，旧表一个字段都没动。切换等价性已在测试库按生产形态彩排并钉成回归（`test/aiCutover.test.ts`）。

⑤ 观察一个发布周期后再考虑删旧列。**能不能删跑一条命令**：

```bash
cd /srv/junshi/server && npm run ai:check-drop
```

   全绿也**不等于**现在就删——脚本会提示还需人工确认「已观察满一个周期」且「期间没回滚过开关」，这两条机器查不了。

### E3. 定时探活（默认开启）

端点探活会周期性外呼（连通性 10 分钟 / Thinking 写法 1 小时 / 模型范围 24 小时），**是真实计费请求**，用量按 `kind='probe'` 单独记账、成本看板可与用户流量分开看。要停：`AI_PROBE_SCHEDULED=false`。探活连续失败会走 Alertmanager → 飞书卡片（`JunshiAiEndpointProbeFailing`），它是**先行指标**——探活先红意味着在用户撞上之前就发现了。

### E4. 待向七牛确认的两个事实（影响生产配置与成本记账）

两条都已查到公开证据但**未获供应商确认**，故代码里只做了 info 级提示、没有擅自改生产值：

| 待确认 | 已查到的证据 | 确认后要做什么 |
|---|---|---|
| Anthropic 协议的权威 baseUrl | 生产在用的 `/bypass/anthropic` **在七牛公开文档里查不到**；官方 `qiniu/coding-helper` 写死 `ANTHROPIC_BASE_URL=https://api.qnaigc.com` | 统一到官方值，并观察提示词缓存命中率是否变化（2026-07 那条「缓存 88% 未命中」至今无别的解释） |
| 缓存写是否单独计价 | 模型广场**有「缓存输入」档**（缓存读分开计价），但**没有单独的缓存写档位** | 若按输入价结算，把每个七牛端点的「缓存写单价」显式填成与输入价相同——否则按默认的 ×1.25 推导会**系统性高估 25%** |

<details>
<summary>可直接发给七牛技术支持的问法（点开复制）</summary>

> 你好，我们在用贵司 AI 大模型推理服务调用 Claude 系模型（Anthropic 协议），有两个问题想确认：
>
> **1. Anthropic 协议的权威接入地址。**
> 我们目前用的是 `https://api.qnaigc.com/bypass/anthropic`，但这个路径在贵司公开文档里没有找到；
> 而贵司官方的 Claude Code 配置工具（github.com/qiniu/coding-helper）写的是
> `ANTHROPIC_BASE_URL=https://api.qnaigc.com`。
> 想确认：**这两个地址是否等价？** 如果不等价，区别是什么（是否走不同的中转/上游账号池）？我们应该用哪一个？
> 背景：我们观察到提示词缓存命中率长期偏低（近 30 天约 10%，而同一会话的相邻请求间隔多在 5 分钟内），
> 怀疑与请求被分发到不同上游账号有关——Anthropic 的提示词缓存是按账号隔离的。
> 如果贵司侧可以固定后端/账号，也想了解如何配置。
>
> **2. 提示词缓存的计费口径。**
> 我们在模型广场看到有「缓存输入」这一档单价，理解为**缓存读**（cache_read_input_tokens）单独计价。
> 想确认：**缓存写**（cache_creation_input_tokens）是按哪个价格结算？
> - 是按普通输入价（1×）？
> - 还是像 Anthropic 官方那样按 1.25×（5 分钟 TTL）/ 2×（1 小时 TTL）？
> 我们的成本核算目前按 1.25× 估算，如果贵司实际按输入价结算，我们会高估约 25%，希望按真实口径对齐。
>
> 另外如果有 Claude 系模型的完整价目表（含上述各档），也麻烦提供一份。谢谢！

拿到答复后：
- 问题 1 → 若不等价，统一到官方地址并观察缓存命中率变化；同时更新 `AI_PRESETS` 里 `qiniu-anthropic` 的 `baseUrl`。
- 问题 2 → 若按 1× 结算，把每个七牛端点的「缓存写单价」填成与输入价相同；
  若确认按 1.25×/2×，则填对应值。**两种情况都是在后台填，不用改代码**（`priceCacheWrite` 已是可填字段）。
</details>

完成后访问 `https://你的域名/` 用手机号 `13800000000` 登录即是演示账号（含演示项目/版本化报告/知识）。

---

## 5. 环境变量（`server/.env`，详见 `server/.env.example`）

| 变量 | 说明 | 生产建议 |
|---|---|---|
| `DATABASE_URL` | Postgres 连接串 | 必填，强密码 |
| `PORT` | 后端端口 | 4000（被 Nginx 反代） |
| `AI_PROVIDER` | 兜底 provider | `mock`（真实模型走后台 `AiSetting`） |
| `WECHAT_MINI_APPID`/`WECHAT_MINI_SECRET` | 小程序 `wx.login` 后端换 openid | AppSecret 只放服务端环境变量，不入前端包 |
| `WECHAT_MESSAGE_TOKEN` | 微信后台消息推送 URL 验签 Token（URL：`https://域名/api/wechat/message`） | 高强度随机串；必须与微信后台填写值一致，只放服务端 |
| `WECHAT_SUBSCRIBE_REVIEW_TEMPLATE_ID`/`WECHAT_SUBSCRIBE_REPORT_TEMPLATE_ID` | 小程序订阅消息模板：复盘提醒 / 报告生成 | 模板字段需匹配 `.env.example` 注释；订阅消息一次授权只发送一次 |
| `SMS_PROVIDER`/`SMS_REQUIRE_CODE` | 短信验证码通道与登录校验开关 | 生产设 `aliyun` / `true` |
| `ALIYUN_SMS_ACCESS_KEY_ID`/`ALIYUN_SMS_ACCESS_KEY_SECRET`/`ALIYUN_SMS_SIGN_NAME` | 阿里云短信凭证与签名 | 只放服务端环境变量 |
| `ALIYUN_SMS_TEMPLATE_CODE` | 阿里云短信验证码模板 | 当前固定 `SMS_508120103`，模板变量名须为 `code` |
| `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL` | env 兜底模型 | 一般留空，改用后台配置 |
| `EMBEDDING_MODEL` | 嵌入模型 | 留空=本地确定性嵌入；配则走 `/embeddings` |
| `MODERATION_ENABLED` | 内容审核开关 | `true`（演示级关键词；生产换合规服务） |
| `PGVECTOR_ENABLED` | pgvector 近邻检索 | `false`（启用见 §6） |
| `WECHAT_PAY_MCHID` 等基础项 | 微信支付 v3 真实凭据（基础项全部配齐才 `payConfigured()=true`） | 见 `.env.example`「微信支付 v3」段 |
| `WECHAT_PAY_PLATFORM_CERT`/`WECHAT_PAY_PLATFORM_CERT_SERIAL` | 本地平台证书兜底，证书必须与序列号成对 | 优先使用 APIv3 自动下载/轮换；静态证书只作兜底 |
| `WECHAT_PAY_PUBLIC_KEY`/`WECHAT_PAY_PUBLIC_KEY_ID` | 微信支付公钥验签模式 | 使用 `PUB_KEY_ID_*` 时必须成对配置；无匹配证书/公钥时回调 fail-closed |
| `WECHAT_PAY_V2_KEY` | 委托代扣 APIv2 密钥（32 位） | 仅服务端保存；与 v3 的 APIv3 Key 不是同一个配置项 |
| `WECHAT_PAPAY_PAY_NOTIFY_URL`/`WECHAT_PAPAY_CONTRACT_NOTIFY_URL` | 自动续费扣款/签解约回调 | 分别填公网 HTTPS `/api/pay/wechat/v2/notify` 与 `/api/pay/wechat/contract/notify` |
| `PAY_MOCK_SUCCESS` | **测试期模拟支付成功**（无商户凭据时把真实支付管线跑通） | **默认不设**；仅测试期设 `true`，见下方警示 |

> 模型 key 优先存数据库（后台「模型」页，运行时可切换、不入仓库）；env 仅作兜底。
>
> **`PAY_MOCK_SUCCESS=true` 的含义与代价（务必读完再开）**：开启后 `POST /plans/:id/order` 与
> `POST /skus/:key/order` 在**没有微信支付商户凭据**的情况下也放行，照常建真实 `PaymentOrder`
> （条款快照 / 实付金额 / 归因 / 下单频控 / 关同类旧单一个不跳），只是不调微信 JSAPI 下单；
> 端上拿到 `mock: true` 就跳过 `wx.requestPayment`，改调 `POST /pay/mock/pay`（普通用户鉴权 +
> 校验订单归属，他人订单 404），由**真实的** `markPaidAndApply` 幂等发放权益、落 `ActivationEvent`
> 并发「支付到账」订阅消息。这样订单状态机 / 幂等 / 权益发放 / 到账通知在拿到凭据前就能被完整验证
> （对比一下：`/plans/:id/purchase` 的演示发放是**整条绕过**支付管线的，什么也验不到）。
> - ⚠️ **开启即等于任何登录用户都可以自助领取任意付费套餐 / SKU**（下单 → 点一下模拟支付 → 权益到账）。**仅测试期使用**，测试结束后删掉这一行并重启 API。
> - ✅ **真凭据配齐后自动失效**：`payMockSuccessEnabled()` 的判定仍要求 `!payConfigured()`；但生产环境不得保留该变量，`assertSandboxSafe()` 会在 `NODE_ENV=production` 且任一 `PAY_MOCK_SUCCESS/PAY_SANDBOX/ALLOW_DEMO_PURCHASE=true` 时直接拒绝启动。
> - 与 `PAY_SANDBOX` 一样，本开关只允许 test/development；发布前必须清除所有免支付权益通道，并配齐真实支付凭据与回调验签证书/公钥。
> - 假到账**不污染真实链路**：这些单带 `provider='mock'` + `snapshotJson.mock=true` + `transactionId` 以 `mock` 开头。对账 sweep / 主动查单 / 微信关单 / 微信退款一律跳过（跳过而非标 failed）；营收统计（后台「期内实收 / 客单价 / 按天曲线」与 `junshi_pay_amount_cny_total`）**不含** mock 单，改计 `junshi_pay_mock_total`；后台订单列表与 CSV 导出显式标「mock」。运营对 mock 单执行退款时**不调微信**，但**本地权益回收照常**（撤掉测试期误发放）。每次模拟到账都落审计 `pay.mock.paid`（单号 / 金额 / 套餐或 SKU）。
> **海报成品图（`canvas_design`）没有任何环境变量**——开关 / 单价 / 日限额 / 渲染超时 / 模板启停 / 图片供应商接入点（含密钥）全在**后台**「创作任务」页，存 `FeatureFlag` 行 `creative-poster` 的 `enabled + payload`（密钥经 `secretBox` 加密），约 1 分钟内生效、不用重启。2026-07-29 删掉了 `CANVAS_DESIGN_ENABLED` / `_ENGINE` / `_MAX_CONCURRENCY` / `_TIMEOUT_MS` 四个：`ENABLED` 与后台开关取合取，制造「后台开了却不生效」的静默失败，而作为熔断闸它要 SSH + 改 env + 重启，比后台点一下慢一个数量级；`ENGINE` 全仓无分支（改它只改变库里那个标签的字面值）；后两个只作 payload 缺省值，而后台保存是全量重写 payload，**运营点过一次保存后改 env 重启就永久无效果**。别再往回加——理由与代码注释同步记在 `server/src/env.ts` 的同名段落。

### 5.1 微信自动续费上线清单

代码同时支持「单次购买」与微信官方委托代扣「自动续费」；自动续费从不默认勾选。上线前需在微信支付商户平台申请委托代扣权限及自动续费模板，选择「通知后 24 小时扣费」，再完成以下配置：

1. 服务端设置 `WECHAT_PAY_V2_KEY`、两条 `WECHAT_PAPAY_*_NOTIFY_URL`，保留现有 v3 单次支付配置。
2. 运营后台逐套餐填写审核通过的数字模板 ID，并打开「允许用户选择自动续费」。未同时满足全局配置与套餐配置时，C 端自动隐藏续费选项。
3. 发布时执行 `cd server && npm run db:push`，新增 `subscription_contract` 及订单关联字段；先用内部账号跑「单次购买、支付中签约、主动关闭、微信侧解约、一次周期续费」五条验收。
4. 核对商户平台模板的签约/解约通知地址与服务端一致。签约回调丢失时，正式开放的 `/papay/querycontract` 会按模板 ID + 商户协议号补查并激活；扣款申请只代表受理，扣款异步回调是当前主链路。`/pay/paporderquery` 目前仍由微信灰度开放，商户获权后代码会自动用它补查，未获权时查询失败只告警、不影响回调入账。重复通知由状态条件更新、订单锁和 `appliedAt` 幂等。

当前实现使用官方默认的「通知后 24 小时扣费」：权益到期前 24 小时提交申请，微信通知用户后在到期点附近执行扣款。后台改价、手动换档、退款或用户关闭续费都会先停掉本地调度并补做微信侧解约，不会沿旧授权静默扣新条款。

代扣失败按同周期最多两次处理，但只有微信明确返回业务失败才允许第二次尝试；`SYSTEMERROR`、网络超时、响应验签或解析失败均可能是“微信已受理但本地未知”，必须保留原单等待回调/查单确认，不得换新单，避免原单晚到成功后发生重复扣款。查询接口未获灰度权限时，这类订单需在运营订单页结合微信商户平台人工核对后处理。用户关闭续费遇到同类不确定结果时，状态保持“关闭中”且本地立即停扣，scheduler 会重试远端解约。

### 5.2 海报成品图上线三步（缺一不可）

顺序是「先把能力装齐，最后才放量」。**放量不在这三步里**，见文末——它是后台点一下的事，不需要改 env、不需要重启。

```bash
cd /opt/junshi/server
npm run db:push                                # ① 建 creative_job / creative_asset（本仓无 migrations 目录）
npm run db:upgrade-poster-prompt               # ③ 先 dry-run 看将要发生的变更
npm run db:upgrade-poster-prompt -- --apply    #    再真写库：幂等把「成品图版式推荐」段落追加进 poster 提示词
# 运行时读的是 AgentVersion 的已发布快照，所以脚本同时改 Agent.systemPrompt 与已发布版本，否则 C 端不生效
```
② **中文字体**：Docker 路径已在 `deploy/Dockerfile.server` 装好 `fonts-noto-cjk`（开源 OFL，可商用打包）。裸机按发行版装，**包名和 family 名都因发行版而异**，装完必须用 `fc-match` 验证 family 能命中，不要只看包装上了：

```bash
fc-list :lang=zh | wc -l && fc-match "Noto Sans CJK SC" && fc-match "Noto Serif CJK SC"
```

- **当前生产 ECS（Alibaba Cloud Linux 4）已自带** `google-noto-cjk`，提供 `Noto Sans CJK SC` / `Noto Serif CJK SC`，无需安装（2026-07-29 实测 14 个字体文件在位）。注意它**没有** apt，`apt-get install fonts-noto-cjk` 在这台机器上跑不通。
- Debian/Ubuntu：`sudo apt-get install -y fontconfig fonts-noto-cjk fonts-noto-cjk-extra && fc-cache -f`
- RHEL/Anolis/alinux：`sudo dnf install -y fontconfig google-noto-sans-cjk-fonts google-noto-serif-cjk-fonts && fc-cache -f`

⚠️ **family 名的坑**：Pan-CJK 包装出来的名字是 `Noto Sans CJK SC`，与 Google Fonts 子集版的 `Noto Sans SC` 是**两个不同 family**。生产实测 `fc-match "Noto Sans SC"` 命中的是纯拉丁的 `NotoSans-VF.ttf`（连 `fc-match "Noto Serif SC"` 也是它，衬线都不保）。`templates.ts` 的字体栈两种名字都写了，动那里时不要删掉 CJK 名——只留子集名会让整栈落空到通用 `sans-serif`，中文全靠 Chromium 逐字回退，版式的衬线区分随之丢失。仓库**不提交字体二进制**。

**放量 / 回滚（都不动部署）**：三步做完后，到运营后台「创作任务」页打开功能开关即放量；关掉即熔断。两个方向都约 1 分钟内生效（`FeatureFlag` 有 60s 读缓存），不发版、不重启、不 SSH。已入队任务留在库里，重新打开后 worker 接着跑。

> **先发代码不会误放量**：唯一的开关就是 `FeatureFlag` 行 `creative-poster` 的 `enabled`，而**行缺失被显式当作「关」**（生产库本来就没有这一行）。所以不存在「忘了留 false」这种事。
> ⚠️ 但注意另一面：这一行在 prisma 里 `enabled` 是 `@default(true)`，后台写 payload 走 upsert。服务端因此在保存配置时**每次都显式落一遍 `enabled`**（patch 没带就回落到当前值），否则运营第一次进后台「只改个单价」就会创建出 `enabled=true` 的行，把还没验收的功能放出去。改 `updateCreativeConfig` 时别把这一步当冗余删掉。

## 6. （可选）启用 pgvector 语义检索加速
默认走"内存余弦"，数据量大时再开 pgvector（HNSW ANN）：
```bash
sudo -u postgres psql -d junshi -c "CREATE EXTENSION IF NOT EXISTS vector;"   # 需安装 postgresql-NN-pgvector
cd /opt/junshi/server && npm run db:pgvector   # 建 vector 列 + HNSW + 回填
# .env 设 PGVECTOR_ENABLED=true，重启后端
```
⚠️ 向量维度 N 必须与嵌入一致（本地确定性嵌入=256；换真实嵌入如 1536 需改 `prisma/pgvector.sql` 的 N 并全量重嵌）。

## 7. （备选）Docker
DB + API 用 `deploy/docker-compose.yml`；H5/后台静态仍交给宿主 Nginx。迁移/种子从仓库连容器 DB 跑（见 compose 顶部注释与 `deploy/Dockerfile.server`）。本环境无 docker 守护进程，模板未实测，按需微调（强密码 / secrets）。

## 8. 微信小程序上线（硬门槛）
1. 真实 **AppID**（替换 `app/project.config.json` 的 `touristappid`）。
2. 后端公网 **HTTPS + ICP 备案域名**，并加入小程序后台 **request 合法域名**。
3. 如启用微信后台消息推送，服务端配置 `WECHAT_MESSAGE_TOKEN`；后台 URL 填 `https://你的域名/api/wechat/message`，Token 填同一个值。订阅消息另在小程序后台配置模板，并把模板 ID 写入 `WECHAT_SUBSCRIBE_REVIEW_TEMPLATE_ID` / `WECHAT_SUBSCRIBE_REPORT_TEMPLATE_ID`。
4. **生成式 AI 备案 / 算法备案 + 内容安全**（AI 类小程序审核硬性门槛；国内合规建议用已备案的国产模型，走 OpenAI 兼容协议即可）。
5. 在 `docs/WEAPP_RELEASES.md` 记录本次版本号/上传描述/提交；执行 `cd app && npm run release:weapp -- --version x.y.z --desc "说明"`，由脚本强制重建 server 包并核对构建模式、生产 API、版本号后上传开发版。上传命令的版本号/描述必须与记录一致；不要裸调 DevTools CLI/GUI 绕过校验。

## 9. 上线前安全/生产硬约束（务必过一遍 · 详见 ROADMAP P2）
- [ ] **鉴权**：短信验证码与小程序本机号登录已接入；当前小程序登录态仍是 `token=userId`（演示）→ 换 JWT；运营后台已有 `ADMIN_TOKEN`/`role=admin` 基线鉴权，生产仍需细粒度 RBAC、管理员账号体系与密钥轮换策略。
- [x] **AI 模型凭证存储口径（产品已拍板）**：`AiSetting` 的对话/Embedding/Rerank Key 与 `AiModel.apiKey` 明文存库，对外接口只回 `hasKey`；部署执行 `npm run secrets:decrypt-ai` 清理历史密文。接受的代价是数据库读权限与备份持有者可见凭证，因此数据库账号最小权限、备份 0600 与主机访问控制是硬要求。`ADMIN_TOKEN` 仍必须使用高强度随机值并仅在服务端环境变量保存；Agent/Dify/技能库/告警/图片供应商等其它业务密钥继续走 `secretBox`。
- [ ] **内容审核/计量**：关键词→合规审核服务；算力按次扣减已实现，充值/支付/token 级归集待接。
- [ ] **图片内容审核（海报成品图放量前必过）**：`services/creative/imageModeration.ts` 默认 `provider='none'` = 放行 + 审计记 `skipped`。放量前须接一家图片内容安全服务（后台「创作任务」页把 provider 置 `http` 并配地址/密钥），否则用户上传的人像与生成的主视觉都没有机器审核。文案侧已走既有 `moderate()`。
- [ ] **限流 / 超时 / 重试**：给 `/api/generate*` 加限流；LLM 调用超时与重试。
- [ ] **数据库**：定时备份（`pg_dump`）、连接加密、最小权限账号。
- [ ] **CORS**：现 `origin: true`（放开）→ 生产收敛到你的域名白名单。
- [ ] **隔离回归**：上线/大改后跑 `npm test`（含 TC-G 跨用户隔离），见 `docs/TESTING.md`。

## 10. 运维
- 健康检查：`GET /api/health`（可挂监控/负载均衡探针）。
- 日志：`journalctl -u junshi-api -f`（或 pm2 logs）。
- 现有固定 ECS（`ecs-user@8.136.36.175`，`/opt/junshi` 上传包式部署）升级：从本机仓库根目录执行 `bash scripts/deploy-prod.sh`，默认发布 `server + admin`；如需同步 H5，加 `DEPLOY_H5=1`。不要在远端 `git pull`，脚本会上传当前 git `HEAD` 归档、保留 `server/.env`、构建重启 API、覆盖 `/var/www/junshi/admin/` 并做公网 smoke。裸 IP 只验 `/api/health`；`/admin/` 只验域名入口，裸 IP `/admin` 预期为 404。
- 首次部署或换新机器：仍按 §4 裸机步骤准备数据库、systemd、Nginx 与 HTTPS，再把 `scripts/deploy-prod.sh` 的 `DEPLOY_HOST`/`REMOTE_ROOT`/`PUBLIC_BASE`/`PUBLIC_DOMAIN` 指向新环境。
- 回滚：保留上一个 `dist/` 与前端产物；DB 变更前先 `pg_dump` 备份。
