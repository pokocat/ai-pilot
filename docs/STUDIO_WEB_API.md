# 声量AI 接军师：网页直连与代售套餐接口契约

> 2026-11-23 起。对象：声量AI 网页（`apps/web-aiavatar`）与声量AI 后端（`apps/server`）。
> 规划背景见声量AI 仓库 `docs/junshi-in-studio-plan.md`。本文是军师侧的接口真源；字段类型在 `shared/contracts.d.ts`（`StudioWeb*`、`ExternalPlanGrant*`）。
> 所有错误都是全站统一的 `{ "error": "中文说明", "code": "机器码" }`。

## 0. 两种调用方、两种令牌

| 调用方 | 令牌 | 接口 |
|---|---|---|
| 声量AI **网页**（浏览器） | 账号中心**换票**得到的用户令牌：`aud` 只有 `junshi-api`、`azp=web-aiavatar`、带 `phone` scope、600 秒（见 §6） | 军师现有全部用户接口（诊断、对话、方案、任务、复盘）+ 本文 §2 的 `/api/studio-web/*` |
| 声量AI **后端** | 账号中心 `client_credentials` **机器令牌**（见 §3.1） | 本文 §3 的 `/api/s2s/plan-grants*` |

- 军师现有接口原样可用：带 `Authorization: Bearer <用户令牌>` 即可。第一次带令牌进来时军师按手机号自动建档（已有手机号账号则合并到同一个账号），所以令牌必须有 `phone_verified=true` 且申请时带 `phone` scope，否则 403 `PHONE_BINDING_REQUIRED` / 502 `IDENTITY_PHONE_UNAVAILABLE`。
- 套餐闸：没套餐的账号写接口返回 403 `PLAN_REQUIRED`，只放行建档类与 `POST /api/quickscan`（每天一次免费诊断）；过期账号写接口 403 `PLAN_EXPIRED`。**只读（GET）接口不受套餐闸限制**，过期用户能看任务、方案、案卷、会话（测试已覆盖：`/api/casefile`、`/api/progress`、`/api/reviews`、`/api/reports`、`/api/sessions`、`/api/prescriptions`、`/api/journey`、`/api/me`）。
- 跨域：浏览器 Origin 必须在白名单里（§4）。

## 1. 网页要用到的现成接口（不改逻辑，只列出入口）

| 用途 | 接口 |
|---|---|
| 进度（没诊断/已诊断/深聊/方案已出/执行中/复盘中） | `GET /api/journey` |
| 速诊（初诊卡） | `POST /api/quickscan` |
| 对话（SSE） | `POST /api/generate`；断线恢复 `GET /api/generations/:id/stream`；会话 `GET /api/sessions`、`GET /api/sessions/:id` |
| 方案 | `GET /api/reports`、`GET /api/reports/:id` |
| 操盘台 | `GET /api/casefile`、`GET /api/progress`、`GET /api/reviews` 及 `/api/casefile*` 写接口 |
| 套餐与价格 | `GET /api/plans`（套餐 id 给 §3 用） |
| 对话里的图片 | `POST /api/chat/image-upload`（multipart，字段 `file`）。格式和大小由系统处理：HEIC、AVIF、TIFF 等自动转成 JPEG/PNG，超过 10MB 自动压缩；JPG/PNG/GIF/WebP 不超限的原样保存。只有不是图片或解不开（400 `IMAGE_DECODE_FAILED`）、原始文件超过 40MB（413 `IMAGE_TOO_LARGE`）才报错；没配存储 503 `OSS_NOT_CONFIGURED`；本月空间用完 402 `KNOWLEDGE_QUOTA`。网页选图时不要再按格式或 10MB 拦，只挡 40MB |
| 完整的我 | `GET /api/me`（较重；网页优先用 §2.1） |

SSE 响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache, no-transform`、`X-Accel-Buffering: no`，`Access-Control-Allow-Origin` 只回显白名单 Origin。

## 2. 网页专用接口 `/api/studio-web/*`

只认账号中心用户令牌，且令牌 `aud` 必须含 `junshi-api`。小程序登录（`x-user-id`）调用一律 401；`aud` 只有 `quickreel-api` 的令牌 403 `STUDIO_WEB_AUDIENCE_REQUIRED`。

### 2.1 `GET /api/studio-web/status` —— 我的军师状态

只读；调用时顺手领取挂在该 uid 上、还没到账的代售订单（§3.3），所以「付完款第一次打开」看到的已经是开通后的状态。只要求账号中心已配置，不受 `JUNSHI_STUDIO_WEB_ENABLED` 控制。

200：
```json
{
  "account": { "userId": "军师用户id", "identityUid": "账号中心uid", "onboarded": true, "hasProfile": true },
  "plan": { "id": "plan_id", "name": "入门版", "period": "month" },
  "planStatus": { "state": "active", "expiresAt": "2026-12-23T...Z", "daysRemaining": 30, "nextResetAt": "..." },
  "tokenQuota": { "limit": 400000, "used": 0, "remaining": 400000, "unlimited": false, "packRemaining": 0 },
  "creditBalance": 20,
  "quickscan": { "availableToday": true, "freeAvailableToday": true, "usedToday": 0, "dailyLimit": 3 },
  "externalGrants": {
    "claimedNow": 0, "unresolved": 0,
    "lastApplied": { "source": "studio", "orderNo": "SO-…", "planId": "…", "planName": "入门版", "appliedAt": "…", "pendingFirst": true, "isCurrentPlan": true }
  },
  "features": { "fortune": true }
}
```
- `plan` 为 null = 从未开通；`planStatus.state` 为 `none | active | expired`。
- `tokenQuota.remaining` 可以是负数（透支），`limit=-1` 且 `unlimited=true` 是不限量。
- `quickscan.freeAvailableToday`：今天那一次「不占套餐额度」的诊断还在；`availableToday`：现在点诊断会不会被拦（过期一律 false）。
- `externalGrants.claimedNow`：**本次请求**领取到账的挂起单笔数，包括建档/换票阶段领取的（2026-11-24 修：以前漏算了建档阶段，先付款后打开时恒为 0）。只有付款后第一次进军师的那个请求会大于 0；如果网页第一次请求打的是别的接口，挂起单会在那里到账，status 看到的就是 0。
- `externalGrants.lastApplied`：最近一笔已到账的代售开通，没有则 null，不受「哪个请求先领走」影响。**判断「是不是在声量AI 付款开通的」请用它**：`pendingFirst=true` 表示先付款、后进军师才到账；`isCurrentPlan=true` 表示这笔开通的套餐就是当前套餐。
- `externalGrants.unresolved`：该 uid 还有几笔代售订单没到账（挂起或需人工）。
- `features.fortune` 是军师现有的全局命理开关，只读下发；按入口关闭命理还没做（见 `docs/agents/13-todo.md`）。

错误：401 `UNAUTHORIZED`；403 `STUDIO_WEB_AUDIENCE_REQUIRED`；503 `IDENTITY_NOT_CONFIGURED`；建档相关 403/409/502 同 §0。

### 2.2 `POST /api/studio-web/intent` —— 这一轮要不要做内容

与小程序 `/api/studio/intent` 是同一个判断（同一个模型和规则，不改提示词），区别只是：网页拿到**明文**方案，自己去声量AI 建草稿；军师不代写草稿，也不返回加密票据。小程序那条路不变。

入参（同 `StudioIntentRequest`）：
```json
{ "sessionId": "可选，已有会话", "agentKey": "可选，默认 general", "text": "本轮用户输入", "clientRequestId": "本轮幂等号", "refs": [{ "kind": "image", "id": "知识库图片id", "label": "图1" }] }
```
200 三种：
```json
{ "action": "chat" }
{ "action": "clarify", "question": "这张图准备做什么用？", "ask": { "q": "选择参考图", "options": ["第 1 张作为参考图", "不带参考图"] } }
{ "action": "draft",
  "plan": { "kind": "image", "prompt": "……", "referenceIds": ["kid1"], "specs": { "ratio": "9:16", "count": 1 }, "sourceScriptMessageId": null },
  "references": [{ "id": "kid1", "fileName": "a.png", "fileType": "png", "url": "/api/studio-web/references/kid1", "available": true }],
  "source": { "sessionId": "…", "scriptMessageId": null, "clientRequestId": "…" } }
```
- `kind`：`image | video`；`specs` 只含用户明确说过的：`ratio`（`9:16` 等）、视频 `duration`（秒）、图片 `count`（张）。
- `clarify.ask` 只在需要选参考图时出现。
- 本轮 `refs` 里的图片必须是本人上传、已就绪的，否则**受理时**就返回 422 `REFERENCE_NOT_FOUND`，体里 `missing` 列出取不到的 id；这时不调用模型。不按格式拒绝：GIF/WebP 照常受理。
- `references[].available`：这张图现在还能不能取到（例如沿用的更早轮次的图之后被删了）。格式不影响它：GIF/WebP 也是 true，取图时系统自动转换（§2.3）。方案可能沿用更早轮次的图，之后它被删除了；为 false 时，网页应提示重新上传，不要等用户点生成时才取图失败。取图仍可能因存储抖动失败，`/references/:id` 的 404 照样要处理。
- 网页随后照常 `POST /api/generate` 让军师回复本轮对话（不带 `studioIntentTicket`）；军师不会代建草稿。
- `JUNSHI_STUDIO_WEB_ENABLED` 未开、该智能体没挂制作技能、内容审核不过时，一律返回 `{ "action": "chat" }`。

错误：400 `BAD_REQUEST`；401；403 `PLAN_REQUIRED` / `PLAN_EXPIRED`（套餐闸，与小程序同口径）；404 `SESSION_NOT_FOUND`；422 `REFERENCE_NOT_FOUND`（带 `missing`）；限流 40 次/分钟。

### 2.3 `GET /api/studio-web/references/:id` —— 取参考图原图

返回图片字节（`image/jpeg` 或 `image/png`，`Cache-Control: private, no-store`），只给本人上传的原图。JPG/PNG 原样返回；GIF、WebP 等其它格式由系统从原件转换：带透明的转 PNG，不透明的转 JPEG，GIF 取第一帧，转换后超过 10MB 就自动缩小。`content-disposition` 里的文件名扩展名会跟着改。小程序草稿上传给声量AI 的也是这同一份。格式问题不交给用户，网页不需要提示换图。网页用带 Bearer 的 `fetch` 取成 Blob 再传给声量AI，不要放进 `<img src>`（带不了令牌）。

错误：404 `REFERENCE_NOT_FOUND`（不存在、不是本人、或原件解不开）；404 `STUDIO_WEB_DISABLED`；401。

### 2.4 `GET /api/studio-web/mini-code` —— 扫码回手机小程序接着聊

鉴权与开关同 §2.1（账号中心用户令牌、`aud` 含 `junshi-api`；只要求账号中心已配置）。
200：`{ "dataUri": "data:image/png;base64,…" | null, "page": "pages/sessions/index" }`
- 全站同一张码：scene 固定 `web=chat`，与用户无关、不带邀请码（不要用 `/api/invite/qrcode`，那张会被算成邀请渠道）。不传 page，微信落小程序主页 = `pages/sessions/index`（问策）。码默认对应**正式版**小程序。
- 小程序端只有 `services/invite.js` 读 scene，只认 `JS` 开头的邀请码形状，`web=chat` 被忽略，正常进问策，不算邀请。
- `dataUri=null`：没生成出来（未配微信凭据、微信报错、超时），网页隐藏码即可；不会返回 5xx。
- 缓存：成功 12 小时，失败 60 秒；同进程并发只调一次微信。不记录 access_token 与图片内容。
- 用户在手机上登录军师后看到的是自己的会话列表；网页对话与小程序是同一个账号的同一批会话（前提是同一手机号）。

## 3. 代售套餐（声量AI 后端 → 军师）

### 3.1 鉴权：账号中心机器令牌

镜像「军师 → 声量AI」的做法：声量AI 后端用自己的机密客户端换 `client_credentials` 令牌，军师验：

| 校验 | 期望值（军师 env，括号内是默认） |
|---|---|
| 签名 | 账号中心 JWKS（`ID_ISSUER/oauth2/jwks`） |
| `iss` | 逐字符等于 `ID_ISSUER` |
| `exp` | 未过期（容忍 60 秒） |
| `aud` | **恰好一项**，等于 `JUNSHI_PLAN_GRANT_AUDIENCE`（`junshi-plan-grant`） |
| `azp` 与 `sub` | 都等于 `JUNSHI_PLAN_GRANT_CLIENT_ID`（`aistar-junshi-grant`） |
| `amr` | 不能有（有就是人的令牌） |
| `scope` | 含 `junshi:plan.grant` |

另需 `JUNSHI_PLAN_GRANT_ENABLED=true`，否则 503 `PLAN_GRANT_DISABLED`。任何一项不符 401 `UNAUTHORIZED`。机器 audience **不要**加进 `ID_AUDIENCES`。

### 3.2 `POST /api/s2s/plan-grants` —— 开通（幂等）

入参：
```json
{ "orderNo": "声量AI订单号", "identityUid": "账号中心uid", "planId": "军师套餐id", "source": "studio", "amount": 9900 }
```
- `orderNo`：1–64 位 `[A-Za-z0-9_.:-]`；`(source, orderNo)` 是防重键。
- `planId`：取自 `GET /api/plans`；只接受正价档（`price>0`），免费/面议档 422 `PLAN_NOT_SELLABLE`。
- `amount`：声量AI 实收，单位分，0–100000000。只用于对账和日后升级时的折算快照，不参与军师定价。

返回（三种状态，HTTP 码不同）：

| HTTP | `status` | 含义 |
|---|---|---|
| 200 | `applied` | 已到账 |
| 202 | `pending` | 该 uid 在军师还没有账号，已挂起；用户第一次带令牌进军师（任一接口或 §2.1）时自动到账 |
| 409 | `blocked` | 开通会缩短用户现有权益（当前是更高档或不限期方案），**没有执行**，需人工；`code=PLAN_CHANGE_SHORTENS` |

200 体：
```json
{
  "grantId": "…", "source": "studio", "orderNo": "SO-0001", "identityUid": "…", "planId": "…", "amount": 9900,
  "status": "applied", "createdAt": "…", "appliedAt": "…", "replay": false,
  "plan": { "id": "…", "name": "入门版", "period": "month" },
  "planExpiresAt": "2026-12-23T…Z",
  "grantedCredits": 20, "grantedTokens": 400000, "carriedDays": 0, "renewal": false,
  "tokenQuota": { "limit": 400000, "remaining": 400000, "used": 0, "unlimited": false, "packRemaining": 0 }
}
```
- `replay=true` 表示这单之前已处理过，返回的是第一次的结果；`tokenQuota` 是**此刻**的额度，其余字段是开通那一刻冻结的。
- 续同一档：到期日顺延，不重复发本期钻石和额度（`renewal=true`，`grantedCredits/grantedTokens=0`），与军师自己的续费同口径。
- 升档：剩余天数结转到新到期日（`carriedDays`），与运营后台手动开通同口径。
- 账号中心已停用的 uid：422 `IDENTITY_ACCOUNT_DISABLED`；军师账号已注销：422 `USER_DELETED`；这两种不落库。

错误码汇总：400 `BAD_REQUEST`；401 `UNAUTHORIZED`；409 `GRANT_ORDER_CONFLICT`（同订单号、内容不同，原记录不动）；409 `PLAN_CHANGE_SHORTENS`；422 `PLAN_NOT_SELLABLE` / `IDENTITY_ACCOUNT_DISABLED` / `USER_DELETED`；503 `PLAN_GRANT_DISABLED`。

重试建议：网络错误、5xx、202 都可以原样重试（同订单号同内容）；409/422 不要重试。

### 3.3 查询与对账

- `GET /api/s2s/plan-grants/:source/:orderNo`：查一笔，体同 3.2（无 `replay`）；没有 404 `GRANT_NOT_FOUND`。
- `GET /api/s2s/plan-grants?source=studio[&orderNo=][&identityUid=][&status=pending|applied|blocked][&from=ISO][&to=ISO][&limit=1..200]`：按创建时间倒序，`{ "items": [...] }`。

### 3.3.1 `GET /api/s2s/users/:uid/plan` —— 按 uid 查军师当前套餐

付费弹窗用：判断用户是否已在小程序开通，以及收款前预判会不会落到 `PLAN_CHANGE_SHORTENS`（`plan.tierRank` 高于要卖的档且 `active=true` 时别卖低档）。同一张机器令牌、同一 scope。只读，不建档、不领取挂起单。

```json
{ "identityUid": "…", "linked": true, "active": true, "state": "active",
  "plan": { "id": "…", "name": "入门版", "period": "month", "tierRank": 1, "planFamilyKey": "starter" },
  "expiresAt": "2026-12-23T…Z", "daysRemaining": 30, "pendingGrants": 0 }
```
`linked=false` 表示该 uid 在军师还没有账号（此时 `active=false`、`state="none"`、`plan=null`）。`state` 为 `none | active | expired`。`expiresAt=null` 且 `active=true` 是不限期方案（企业版）。

### 3.3.2 与声量AI 草拟形状的对照（以本文为准）

| 声量AI 草拟 | 军师实际 |
|---|---|
| `aud=junshi-api`、`azp=aistar-junshi-s2s`、scope `junshi.plan.grant` | `aud=junshi-plan-grant`（只这一项）、`azp=sub=aistar-junshi-grant`、scope `junshi:plan.grant`。`junshi-api` 是用户令牌的 aud，机器令牌不能用 |
| 头 `Idempotency-Key` | 不用；防重键是体里的 `orderNo`（+`source`） |
| `orderId/uid/planCode/days/priceCents/paidAt` | `orderNo/identityUid/planId/source/amount`；时长由套餐 `period` 决定（月付一个月、年付一年），不收 `days`/`paidAt` |
| 回包 `{success,data:{…}}` | 不包壳，直接是 3.2 的对象；错误是 `{error,code}` |
| 只有 200 / 4xx | 另有 202（挂起，可重试也可不管）和 409 blocked |
| `GET /api/s2s/plans/{uid}` | `GET /api/s2s/users/{uid}/plan`（3.3.1） |

### 3.4 退款与撤销（现状）

**不自动回收。** 军师没有撤销接口；声量AI 退款后，军师侧的套餐、钻石和对话额度保持原样。处理方式：声量AI 按 §3.3 查到这笔开通，线下联系军师运营人工处理。`blocked` 的单同样人工处理。

## 4. 跨域白名单

`CORS_ALLOWED_ORIGINS`（逗号分隔，逐字符比对 `scheme://host[:port]`）。留空时用内置清单：
`https://aibuzz.cn`、`https://www.aibuzz.cn`、`https://wxapi.aibuzz.cn`、`https://copilot.aibuzz.cn`、`https://aiavatar.aibuzz.cn`、`https://aistar.aibuzz.cn`、`https://www.aistar.aibuzz.cn`。非 production 另外放行任意 `http://localhost:<端口>` 和 `http://127.0.0.1:<端口>`（声量AI 网页本地是 3013）。不在白名单的 Origin 收不到任何 CORS 头；不带 Origin 的请求（小程序、服务间）不受影响。

## 5. 军师侧配置一览

| env | 用途 | 默认 |
|---|---|---|
| `ID_ISSUER`、`ID_AUDIENCES` | 账号中心；`ID_AUDIENCES` 须含 `junshi-api` | 已有 |
| `JUNSHI_STUDIO_WEB_ENABLED` | 打开 §2.2、§2.3 | 关 |
| `JUNSHI_PLAN_GRANT_ENABLED` | 打开 §3 | 关 |
| `JUNSHI_PLAN_GRANT_AUDIENCE` | 机器令牌 aud | `junshi-plan-grant` |
| `JUNSHI_PLAN_GRANT_CLIENT_ID` | 机器令牌 azp/sub | `aistar-junshi-grant` |
| `CORS_ALLOWED_ORIGINS` | 跨域白名单 | 内置清单 |

## 6. 账号中心配合（aibuzz-id 已实现，分支见下）

账号中心会话（aibuzz-id `dev/distracted-mirzakhani-78baa2`，提交 `0ebdf0d`、`a98a857`）已实现，契约真源是该仓 README §29 与 `docs/junshi-token-exchange.md`。军师侧不需要为此改代码，已用 `verifyIdentityToken` / `fetchIdentityUserinfo` / `verifyMachineToken` 实测通过。

1. **网页换票（RFC 8693）**：网页拿自己的声量AI 令牌（`aud=aistar-api`）向 `POST {ID_ISSUER}/oauth2/token` 换一张军师票：`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`、`client_id=web-aiavatar`、`subject_token=<声量AI 令牌>`、`subject_token_type=urn:ietf:params:oauth:token-type:access_token`、`audience=junshi-api`，不带 secret、不带 Cookie。
   - 票的 `aud` 只有 `junshi-api`，`azp=web-aiavatar`，`sub`/`sid`/`amr`/`phone_verified` 同原令牌，600 秒，没有 refresh_token；过期用当前声量AI 令牌再换（提前 60 秒换、单飞、只放内存）。
   - 只对主站三个 Origin 开放（aiavatar / aistar / www.aistar），贴牌站 400 `unauthorized_client`；体验账号 403 `TOKEN_EXCHANGE_DEMO_ACCOUNT`；限流 429 `TOKEN_EXCHANGE_RATE_LIMITED`。
   - 军师不把 `aistar-api` 加进 `ID_AUDIENCES`（否则声量AI 系所有产品的令牌都能调军师）。
   - 不要拿这张票调账号中心 `/api/me/logout`：`sid` 是原那次登录，会把声量AI 登录也退掉。
2. **声量AI 后端的机器客户端** `aistar-junshi-grant`（配置项）：`client_credentials` + Basic，scope `junshi:plan.grant`，发出的令牌 `aud=junshi-plan-grant`、`sub=azp=aistar-junshi-grant`、不带 `amr`、300 秒。生产 secret 在账号中心是 `ID_CLIENT_SECRET_AISTAR_JUNSHI_GRANT`，声量AI 后端配同一个值；dev 默认 `aistar-junshi-grant-dev-secret`。

## 7. 上线步骤（军师侧）

顺序不能反：账号中心先能发票，军师再开开关，最后声量AI 打开入口。

1. **建表（发布前）**：用有 DDL 权限的账号在正式 RDS 执行 `deploy/sql/2026-11-24-external-plan-grant.sql`（纯加法，只建 `external_plan_grant` 一张表和三个索引；旧代码不读它，先建表不影响线上）。发布工具不执行 DDL，见 `docs/MIGRATION_SOP.md` §5。
2. **发布代码**：`bash scripts/deploy-prod.sh --schema-reviewed`（该参数只读核对 RDS 已有新表）。服务端新依赖 `heic-decode`（纯 wasm，无系统包）随 `npm ci` 安装。此时两个开关仍关：`/studio-web/intent` 一律回 `chat`、取参考图 404 `STUDIO_WEB_DISABLED`、代售接口 503 `PLAN_GRANT_DISABLED`；小程序行为不变（图片上传转换除外，它不受开关控制，现在就生效）。
3. **账号中心上线**换票与 `aistar-junshi-grant`（该仓自己的发布流程）。
4. **军师 env**（两台节点的 EnvironmentFile 都要改，重启后核对实际进程环境）：
   - `JUNSHI_STUDIO_WEB_ENABLED=true`
   - `JUNSHI_PLAN_GRANT_ENABLED=true`（`JUNSHI_PLAN_GRANT_AUDIENCE` / `JUNSHI_PLAN_GRANT_CLIENT_ID` 用默认值即可）
   - `ID_ISSUER=https://id.aibuzz.cn` 已有；`ID_AUDIENCES` 留空或含 `junshi-api`
   - `CORS_ALLOWED_ORIGINS` 留空用内置清单（已含 aiavatar / aistar / www.aistar）
   - 小程序码接口要 `WECHAT_MINI_APPID/WECHAT_MINI_SECRET`（已有）
5. **上线验收**（真实环境，不发付费生成）：
   - 用声量AI 主站登录 → 换票 → `GET /api/studio-web/status` 200，且 `account.identityUid` 与声量AI uid 一致；没有手机号的账号得到 403 `PHONE_BINDING_REQUIRED`。
   - 跨域：从 `https://aiavatar.aibuzz.cn` 发 OPTIONS，有 `Access-Control-Allow-Origin`；SSE 响应头有 `Cache-Control: no-cache, no-transform` 和 `X-Accel-Buffering: no`，逐段到达不被缓冲。
   - 机器令牌调 `GET /api/s2s/plan-grants?source=studio&limit=1` 200；用户令牌调同一接口 401。
   - 一笔真实代售（运营指定的测试账号）：200 applied 或 202 pending → 进军师后 `externalGrants.lastApplied` 有这笔；同单号重放返回 `replay:true`。
   - 小程序冒烟：登录、对话、上传一张 HEIC 照片（小程序上限放宽要等下次发版，服务端转换现在就生效）。
6. **回退**：先让声量AI 关掉军师入口（网页不再换票、不再调军师）；军师侧关 `JUNSHI_STUDIO_WEB_ENABLED` 停制作方案与取图，关 `JUNSHI_PLAN_GRANT_ENABLED` 停代售到账（声量AI 已付款的单会收到 503，按它的重试/人工流程处理）。`/studio-web/status` 和现有用户接口只要账号中心还发票就仍能用。已到账的套餐保留；代码回退不需要删表。
