# 运营后台账户系统（密钥引导 + 账号密码）

> 后台登录从「只填共享密钥」升级为**账户系统**：用主密钥 `ADMIN_TOKEN` 首次初始化一个管理员账号+密码，
> 之后用账号密码登录；主密钥保留为**应急/找回**通道。单一管理员账户。

---

## 一、登录流程

```
首次（未初始化）
  登录页 → 填 账号 / 密码 / 主密钥(ADMIN_TOKEN) → 初始化账户（自动登录）
之后（已初始化）
  登录页 → 账号 + 密码 → 登录
  忘记密码 / 账户异常 → 「用密钥应急登录」直接填 ADMIN_TOKEN 进入 → 在「修改密码」里重置
```

- 登录/初始化成功后，后端下发一个**会话 token**（不透明随机串，7 天有效），前端存 localStorage，
  之后每个请求作为 `x-admin-token` 头发送 —— 与旧的「直接存主密钥」走同一通道，前端无感。
- 应急登录则直接把主密钥当作 `x-admin-token` 存下（`requireAdmin` 始终接受主密钥）。

---

## 二、鉴权放行（`server/src/services/adminAuth.ts` · `requireAdmin`）

`/api/admin/*` 放行条件（任一，常量时间比对）：

1. **主密钥**：`x-admin-token` / `Bearer` 命中 `process.env.ADMIN_TOKEN`（应急/找回，请求时即时读取，可热轮换）。
2. **账户会话**：命中有效未过期的 `AdminSession.token`（账号密码登录后下发）。
3. **role=admin 用户**：`x-user-id` 解析到 `role='admin'` 的小程序用户（兼容旧路径）。

`/admin/auth/*` 登录类接口**不挂**全局 `requireAdmin`（靠主密钥/密码自证）；退出/改密用 per-route `requireAdmin`。

---

## 三、接口

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/admin/auth/status` | 公开 | `{ initialized, masterKeyEnabled }`，登录页据此选表单 |
| POST | `/api/admin/auth/init` | 主密钥 | `{ masterKey, username, password }` → 初始化账户，仅未初始化时可用，成功返回 `{ token, username }` |
| POST | `/api/admin/auth/login` | 公开 | `{ username, password }` → `{ token, username }`；失败统一 401（防账号枚举） |
| POST | `/api/admin/auth/logout` | 会话 | 吊销当前会话 token |
| POST | `/api/admin/auth/password` | 会话/主密钥 | `{ currentPassword?, newPassword, masterKey? }`；主密钥可直接重置，否则需当前密码。改密后吊销该账户全部会话 |

---

## 四、数据模型 & 安全

`server/prisma/schema.prisma`：

```prisma
model AdminAccount { id, username @unique, passwordHash, createdAt, updatedAt, lastLoginAt?, sessions[] }
model AdminSession { token @id, accountId, createdAt, expiresAt }  // 不透明随机 token，7 天过期
```

- **密码哈希**：Node 内置 `crypto.scrypt` + 16 字节随机盐，存 `scrypt$saltHex$hashHex`，**无外部依赖**；校验用 `timingSafeEqual` 常量时间比对（`server/src/services/adminAccount.ts`）。
- 账户与小程序用户（`app_user`）**完全分离**，互不影响。
- 主密钥仍明文在 env（与现状一致）；生产请用高强度随机串并接密管。
- 改密会清空该账户所有会话，强制重新登录。

新增了表，需推库（本项目用 `db push`，无迁移文件）：

```bash
cd server && npm run db:push
```

---

## 五、相关文件

| 层 | 文件 |
| --- | --- |
| 数据模型 | `server/prisma/schema.prisma`（`AdminAccount` / `AdminSession`） |
| 账户服务 | `server/src/services/adminAccount.ts`（哈希/会话/初始化/登录/改密） |
| 鉴权 | `server/src/services/adminAuth.ts`（`requireAdmin` 加会话 token 放行） |
| 路由 | `server/src/routes/adminAccount.ts`（`/admin/auth/*`） |
| 契约 | `shared/contracts.d.ts`（`AdminAuthStatus`/`AdminInitRequest`/`AdminLoginRequest`/`AdminAuthResult`/`AdminChangePasswordRequest`） |
| 前端登录 | `admin/src/AdminLogin.tsx`（初始化/登录/应急三态） |
| 前端账户 | `admin/src/App.tsx`（账户菜单 + 修改密码弹窗）、`admin/src/api.ts`（`adminAuth.*`） |
| 单元测试 | `server/test/adminAccount.test.ts`（哈希/主密钥，免 DB） |

---

## 六、测试

```bash
cd server && node --import tsx --test test/adminAccount.test.ts   # 6 用例，免 DB
```

覆盖密码哈希（随机盐、正确/错误、畸形串不抛错、大小写敏感）与主密钥校验（命中/裁空白/未配置）。
登录/初始化/会话等需 DB 的流程由集成测试（`server/test/integration.test.ts`，需 PostgreSQL）覆盖。
