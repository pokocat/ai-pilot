# 生态统一账户与跨产品结算 · 设计（WO-15）

> **上游**：`docs/[FABLE5]REDESIGN_EXEC_SPEC.md` WO-15。**产出物**：本设计文档（设计先行，暂不编码）。
> **用途**：生态第二产品（数字人 / AI 短剧 / 短视频工具）立项时的账户与结算蓝图。
> 编写日期 2026-07-08。已建地基：处方引擎（WO-12，`Prescription` + activate 埋点）、品牌资产包（WO-13，`BrandKit` + approve）、成果回流（WO-14，`outcomeJson`）。

---

## 0. 一句话主张

**现阶段单库多产品**：所有生态产品共用现有 `User`/`Tenant` 表与一个 Postgres 库，靠一个 `product` 维度做会话与账目隔离；身份用「手机号 + 微信 unionid」，钱包用现成的「钻石 + token 两轴」升为用户级跨产品货币。**拆微服务留到第三个产品**——过早拆分是给自己上枷锁。

---

## 1. 身份（identity）

### 现状
小程序 `loginOrRegisterByPhone` 以手机号建 `User`（挂 `Tenant`）；微信登录走 openid/unionid。军师是「产品一」。

### 设计
- **中心身份键 = 手机号 + 微信 unionid**。unionid 在同一微信开放平台主体下跨小程序/公众号稳定，是打通生态产品的天然主键；手机号是兜底与找回。
- **不新建身份服务**：生态产品直接读同库 `User` 表。给 `User` 加一个可选 `unionId`（若尚无）作二级唯一索引；登录时「手机号 ∪ unionid」双路命中同一 `User`。
- **会话隔离靠 `product` 维度**，而非拆账号：见 §5。

### 判断
现阶段单库共用 `User`，成本最低、体验最连贯（老板在数字人产品里就是军师里的同一个人）。独立 auth 服务 / OIDC 留到第三个产品或外部合作方接入时再立。

---

## 2. 钱包（wallet）

### 现状
两轴计费：**钻石**（`CreditLedger`，一次性解锁 + 图片按张）+ **token 月度额度**（`TokenWallet`/`token_usage`，文本产出）。二者正交。这套两轴天然适合当生态通用货币——这是现有架构里少数为生态化埋好的伏笔。

### 设计
- **升为「用户级、跨产品」**：`CreditLedger` 加 `product String @default("junshi")` 字段即可起步；每条流水标注产生/消耗它的产品。`TokenWallet` 同理（或 token 额度仍归军师、生态产品只用钻石轴，视定价而定）。
- **跨产品扣费走同库事务**：数字人产品扣钻石 = 在同一 Postgres 事务里 `CreditLedger` 记一条 `product='avatar'` 的负流水。**暂不需要分布式结算**（单库事务即强一致）。
- **对账**：按 `product` 聚合流水即得各产品消耗；运营后台「消耗」区加 `product` 维度即可。

---

## 3. 权益互通（entitlements）

- **套餐附赠生态额度**（增长杠杆）：军师套餐可附赠数字人 N 条/月 —— 实现为购买时给 `CreditLedger` 记一条 `product='avatar'` 的赠送流水（带 `expiresAt`）。
- **处方开通跨产品下单**：WO-12 的 `Prescription.activate` 是转化终点。跨产品下单回调复用现有 `PaymentOrder` 幂等模式——生态产品支付成功 → 回调军师 `POST /prescriptions/:id/activate`（已建）→ 标 `activatedAt`，并在 `CreditLedger` 记扣费。回调用 §4 的 service token 鉴权。
- **原则**：权益的「授予」和「消耗」都落 `CreditLedger`（加 `product` + 可选 `expiresAt`），一张表看全生态账。

---

## 4. 数据互通授权（data interop）

两条数据要跨产品流动，都需鉴权：

1. **BrandKit 出口**（WO-13）：生态产品预填人设。设计 `GET /brand-kit/export?token=`——签名 token（复用 `reportShare` 不可猜 id 思路 **+ TTL 1h**），只返回 `approvedAt` 非空的三段 JSON；未 approve → 403。token 签发需登录态，由生态产品经统一账号换取。
2. **成果回传**（WO-14 v2 的 API 版）：数字人产品把「发布数/线索」回传军师 `POST /prescriptions/:id/outcome`（已建）。

**鉴权模型 = 产品间 service token + 用户级授权记录表**：
- `service token`：产品对产品的机器凭证（环境注入，非用户态），标识「哪个生态产品」。
- `user_grant` 表（新）：`{userId, product, scope: 'brandkit.read'|'outcome.write', grantedAt, revokedAt?}`——用户在军师侧一次性授权某产品读 BrandKit / 写 outcome，可撤销。生态产品调用时 = service token（是谁）+ 目标 userId 的 grant（有没有被授权）。

---

## 5. 风险与边界

- **单库多产品 schema 耦合**：所有产品共用一个 Prisma schema，改表互相影响。**边界纪律**：生态产品的私有数据进各自命名前缀的表（如 `avatar_*`），只共享 `User/Tenant/CreditLedger/BrandKit/Prescription` 这几张「账户与桥」表；共享表的改动走 SSOT 评审。`product` 字段是软隔离，不是租户级硬隔离——跨产品查询必须显式带 `product`。
- **unionid 依赖同一微信开放平台主体**：跨小程序打通 unionid 的前提是所有生态小程序挂在同一开放平台账号下。若生态产品由不同主体开发，unionid 不通 → 退回手机号绑定（体验降级但可用）。**立项前必须确认开放平台主体归属**。
- **拆分触发线**：当（a）出现第三个产品，或（b）某产品需独立扩容/独立团队/外部合作方接入时，把 `User + CreditLedger + BrandKit` 抽成独立「账户服务」（保留本文的表结构，只是换成 service 边界）。在那之前，单库多产品是正确的成本/速度选择。

---

## 附：落地顺序（当生态第二产品立项时）

1. `User.unionId` 二级唯一索引 + 登录双路命中（§1）。
2. `CreditLedger.product` 字段 + 运营后台 `product` 维度对账（§2）。
3. `user_grant` 表 + service token 中间件（§4）。
4. `GET /brand-kit/export?token=`（签名 + TTL 1h，§4.1）——本条是 WO-13 的明确未竟项，第二产品第一个要的就是它。
5. 处方 activate 的跨产品支付回调接入 `PaymentOrder` 幂等（§3）。

> 以上均为**加法**，不改军师现有主链路；生态化不需要推倒重来，只需在「账户与桥」几张表上加 `product` 维度与授权层。
