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
        ▼                │     ├── /          → H5 静态 (app/dist)          ── 静态        │
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
| H5（移动端 Web） | `app/` | `TARO_APP_MODE=server TARO_APP_API=https://域名/api npm run build:h5` | `app/dist/`（静态） | Nginx 托管 |
| 运营后台 | `admin/` | `npm ci && npm run build -- --base=/admin/` | `admin/dist/`（静态） | Nginx 托管 |
| 微信小程序 | `app/` | `TARO_APP_MODE=server TARO_APP_API=https://域名/api npm run build:weapp` | `app/dist/`（weapp 包） | 微信开发者工具上传（见 §8） |

> 小程序与 H5 是同一套码；上线小程序额外需要备案与合法域名（§8）。

## 3. 前置

- 服务器：Linux（Debian/Ubuntu 示例），Node **20+**，Nginx，PostgreSQL **14+**（pgvector 可选）。
- 一个域名 + 解析到服务器；HTTPS（Let's Encrypt/certbot）。AI 类应用对外通常还需 ICP 备案（§8）。

---

## 4. 部署步骤（裸机，主路径）

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

### C. 前端 H5 + 运营后台（静态）
```bash
# H5（指向你的公网 API）
cd /opt/junshi/app && npm ci
TARO_APP_MODE=server TARO_APP_API=https://你的域名/api npm run build:h5
sudo mkdir -p /var/www/junshi/h5 && sudo cp -r dist/* /var/www/junshi/h5/

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

### E. 配置大模型（可随时切换）
打开 `https://你的域名/admin/` → **「模型」页** → 默认 **Agnes 2.0 Flash**（`apihub.agnes-ai.com/v1`）→ 填 API Key → **测试连接** → 保存即生效。要换 DeepSeek/Qwen/OpenAI/Claude：点对应预设再填该家的 key。**未配 key 时全站自动用本地 mock**（零成本可演示）。

完成后访问 `https://你的域名/` 用手机号 `13800000000` 登录即是演示账号（含演示项目/版本化报告/知识）。

---

## 5. 环境变量（`server/.env`，详见 `server/.env.example`）

| 变量 | 说明 | 生产建议 |
|---|---|---|
| `DATABASE_URL` | Postgres 连接串 | 必填，强密码 |
| `PORT` | 后端端口 | 4000（被 Nginx 反代） |
| `AI_PROVIDER` | 兜底 provider | `mock`（真实模型走后台 `AiSetting`） |
| `WECHAT_MINI_APPID`/`WECHAT_MINI_SECRET` | 小程序 `wx.login` 后端换 openid | AppSecret 只放服务端环境变量，不入前端包 |
| `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL` | env 兜底模型 | 一般留空，改用后台配置 |
| `EMBEDDING_MODEL` | 嵌入模型 | 留空=本地确定性嵌入；配则走 `/embeddings` |
| `MODERATION_ENABLED` | 内容审核开关 | `true`（演示级关键词；生产换合规服务） |
| `PGVECTOR_ENABLED` | pgvector 近邻检索 | `false`（启用见 §6） |

> 模型 key 优先存数据库（后台「模型」页，运行时可切换、不入仓库）；env 仅作兜底。

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
3. **生成式 AI 备案 / 算法备案 + 内容安全**（AI 类小程序审核硬性门槛；国内合规建议用已备案的国产模型，走 OpenAI 兼容协议即可）。
4. `TARO_APP_MODE=server TARO_APP_API=https://域名/api npm run build:weapp` → 微信开发者工具上传审核。

## 9. 上线前安全/生产硬约束（务必过一遍 · 详见 ROADMAP P2）
- [ ] **鉴权**：当前小程序 `token=userId`（演示）→ 换 短信验证码 + JWT；运营后台已有 `ADMIN_TOKEN`/`role=admin` 基线鉴权，生产仍需细粒度 RBAC、管理员账号体系与密钥轮换策略。
- [ ] **密钥**：`AiSetting.apiKey` 现明文存库 → 加密 / 接密管；`ADMIN_TOKEN` 必须使用高强度随机值并仅在服务端环境变量保存。
- [ ] **内容审核/计量**：关键词→合规审核服务；算力按次扣减已实现，充值/支付/token 级归集待接。
- [ ] **限流 / 超时 / 重试**：给 `/api/generate*` 加限流；LLM 调用超时与重试。
- [ ] **数据库**：定时备份（`pg_dump`）、连接加密、最小权限账号。
- [ ] **CORS**：现 `origin: true`（放开）→ 生产收敛到你的域名白名单。
- [ ] **隔离回归**：上线/大改后跑 `npm test`（含 TC-G 跨用户隔离），见 `docs/TESTING.md`。

## 10. 运维
- 健康检查：`GET /api/health`（可挂监控/负载均衡探针）。
- 日志：`journalctl -u junshi-api -f`（或 pm2 logs）。
- 升级流程：拉新代码 → `npm ci && npx prisma generate && npm run db:push && npm run build` → `systemctl restart junshi-api`；前端重 build 后覆盖 `/var/www/junshi/*`。
- 回滚：保留上一个 `dist/` 与前端产物；DB 变更前先 `pg_dump` 备份。
