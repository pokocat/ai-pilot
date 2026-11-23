# 声量AI 接军师：网页直连与代售套餐接口契约

> 2026-11-23 起。对象：声量AI 网页（`apps/web-aiavatar`）与声量AI 后端（`apps/server`）。
> 规划背景见声量AI 仓库 `docs/junshi-in-studio-plan.md`。本文是军师侧的接口真源；字段类型在 `shared/contracts.d.ts`（`StudioWeb*`、`ExternalPlanGrant*`）。
> 所有错误都是全站统一的 `{ "error": "中文说明", "code": "机器码" }`。

## 0. 两种调用方、两种令牌

| 调用方 | 令牌 | 接口 |
|---|---|---|
| 声量AI **网页**（浏览器） | 账号中心发的**用户令牌**，`aud` 含 `junshi-api`、带 `phone` scope | 军师现有全部用户接口（诊断、对话、方案、任务、复盘）+ 本文 §2 的 `/api/studio-web/*` |
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
  "externalGrants": { "claimedNow": 0, "unresolved": 0 },
  "features": { "fortune": true }
}
```
- `plan` 为 null = 从未开通；`planStatus.state` 为 `none | active | expired`。
- `tokenQuota.remaining` 可以是负数（透支），`limit=-1` 且 `unlimited=true` 是不限量。
- `quickscan.freeAvailableToday`：今天那一次「不占套餐额度」的诊断还在；`availableToday`：现在点诊断会不会被拦（过期一律 false）。
- `externalGrants.unresolved`：该 uid 还有几笔代售订单没到账（挂起或需人工）。
- `features.fortune` 是军师现有的全局命理开关，只读下发；按入口关闭命理还没做（见 §6）。

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
  "references": [{ "id": "kid1", "fileName": "a.png", "fileType": "png", "url": "/api/studio-web/references/kid1" }],
  "source": { "sessionId": "…", "scriptMessageId": null, "clientRequestId": "…" } }
```
- `kind`：`image | video`；`specs` 只含用户明确说过的：`ratio`（`9:16` 等）、视频 `duration`（秒）、图片 `count`（张）。
- `clarify.ask` 只在需要选参考图时出现。
- 网页随后照常 `POST /api/generate` 让军师回复本轮对话（不带 `studioIntentTicket`）；军师不会代建草稿。
- `JUNSHI_STUDIO_WEB_ENABLED` 未开、该智能体没挂制作技能、内容审核不过时，一律返回 `{ "action": "chat" }`。

错误：400 `BAD_REQUEST`；401；403 `PLAN_REQUIRED` / `PLAN_EXPIRED`（套餐闸，与小程序同口径）；404 `SESSION_NOT_FOUND`；限流 40 次/分钟。

### 2.3 `GET /api/studio-web/references/:id` —— 取参考图原图

返回图片字节（`image/jpeg` 或 `image/png`，`Cache-Control: private, no-store`）。只给本人上传的 JPG/PNG 原图，与小程序草稿上传给声量AI 的是同一份。网页用带 Bearer 的 `fetch` 取成 Blob 再传给声量AI，不要放进 `<img src>`（带不了令牌）。

错误：404 `REFERENCE_NOT_FOUND`（不存在、不是本人、不是 JPG/PNG）；404 `STUDIO_WEB_DISABLED`；401。

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

## 6. 需要账号中心配合（军师不改 `aibuzz-id`）

1. **声量AI 后端的机器客户端**（纯配置，`id-server-clients.yml` 加一段，不用改代码）：
   ```yaml
   - client-id: aistar-junshi-grant
     display-name: 声量AI 代售军师套餐
     client-secret: ${ID_CLIENT_SECRET_AISTAR_JUNSHI_GRANT}
     product-code: aistar
     audience: junshi-plan-grant
     grants: [client_credentials]
     scopes: ["junshi:plan.grant"]
   ```
   账号中心对 `client_credentials` 令牌按配置写 `aud`（`IdTokenClaimsCustomizer`）、`sub=azp=client_id`、不带 `amr`，scope 不做白名单校验，所以现有代码就能发。
2. **声量AI 网页拿到 `aud=junshi-api` 的用户令牌**：现在 `web-aiavatar` 客户端的 `audience` 是单值 `aistar-api`，军师不认。两种做法，需要拍板：
   - 甲（推荐，纯配置）：新登记一个公开客户端（例如 `web-junshi-studio`，`audience: junshi-api`，`authorization_code` + PKCE，scopes `openid profile phone`，回调用声量AI 主站域名下的独立路径）。网页在已登录账号中心的前提下再走一次授权码流程拿军师令牌（账号中心有会话时不需要再输入）。需要确认账号中心对已登录会话是否免确认直接回跳；若要「完全无感」，需要账号中心支持 `prompt=none`，那是代码改动。
   - 乙：账号中心让一个客户端可以发多 audience（`web-aiavatar` 同时带 `aistar-api` 与 `junshi-api`）。要改 `IdTokenClaimsCustomizer` 与客户端配置结构，是代码改动；且同一张令牌两边都认，被任一后端拿去都能调另一边。
   - 不建议：军师把 `aistar-api` 加进 `ID_AUDIENCES`。那样声量AI 系所有产品（音乐人、短剧等）的令牌都能调军师。
3. 计划里提到的「跨产品凭据做成配置表」：第 1 项已经是配置，第 2 项甲方案也只是配置，暂时不阻塞。
