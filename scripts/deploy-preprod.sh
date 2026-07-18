#!/usr/bin/env bash
# 军师 · 预发布(preprod)部署脚本 —— 与生产同机并存、互不影响。
#
#   生产：/opt/junshi          · junshi-api        · :4000 · DB junshi          · wxapi.aibuzz.cn/api
#   预发：/opt/junshi-preprod  · junshi-api-preprod · :4001 · DB junshi_preprod · wxapi.aibuzz.cn/api_preprod
#
# 首次运行自动完成：建库 junshi_preprod、写 preprod .env(改 DATABASE_URL+PORT)、
# 装 systemd 单元 junshi-api-preprod、在 nginx wxapi 块追加 location /api_preprod/(带 nginx -t 兜底)、
# 从生产库复制 ai_setting/ai_model(真 AI 密钥)。之后每次运行只做：上传 HEAD → 构建 → 迁移 → 重启。
# 生产的 junshi-api / junshi 库 / /opt/junshi 全程不受影响（AI 复制仅只读生产库）。
#
# 用法：bash scripts/deploy-preprod.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_HOST="${DEPLOY_HOST:-ecs-user@8.136.36.175}"
SSH_KEY="${SSH_KEY:-/Users/donis/dev/aliyun/aiartist.pem}"
PREPROD_ROOT="/opt/junshi-preprod"
PROD_ROOT="/opt/junshi"
PORT="4001"
SERVICE="junshi-api-preprod"
PREPROD_DB="junshi_preprod"
RUNTIME_USER="junshi"
PUBLIC="https://wxapi.aibuzz.cn/api_preprod"

SHA="$(cd "$ROOT" && git rev-parse --short HEAD)"
ARCHIVE="/tmp/junshi-preprod-${SHA}.tar.gz"

log(){ printf "\033[1;36m[preprod]\033[0m %s\n" "$*"; }
die(){ printf "\033[1;31m[preprod] %s\033[0m\n" "$*" >&2; exit 1; }
[ -f "$SSH_KEY" ] || die "SSH key 不存在：$SSH_KEY"

log "打包当前 HEAD=${SHA}"
( cd "$ROOT" && git archive --format=tar.gz -o "$ARCHIVE" HEAD )

log "上传归档 -> $DEPLOY_HOST"
scp -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new "$ARCHIVE" "$DEPLOY_HOST:/tmp/"

log "远端建立/更新 preprod"
ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new "$DEPLOY_HOST" \
  "SHA='${SHA}' PREPROD_ROOT='$PREPROD_ROOT' PROD_ROOT='$PROD_ROOT' PORT='$PORT' SERVICE='$SERVICE' PREPROD_DB='$PREPROD_DB' RUNTIME_USER='$RUNTIME_USER' bash -se" <<'REMOTE'
set -euo pipefail
ARCHIVE="/tmp/junshi-preprod-${SHA}.tar.gz"
RELEASE="/tmp/junshi-preprod-release-${SHA}"
DEPLOY_USER="$(id -un)"; DEPLOY_GROUP="$(id -gn)"
NGINX_CONF="/etc/nginx/conf.d/junshi.conf"

echo "== 解包 =="
rm -rf "$RELEASE"; mkdir -p "$RELEASE"; tar -xzf "$ARCHIVE" -C "$RELEASE"
sudo mkdir -p "$PREPROD_ROOT/server"

# 保留已存在的 preprod .env
ENV_BAK=""
if [ -f "$PREPROD_ROOT/server/.env" ]; then ENV_BAK="/tmp/preprod-env-${SHA}.bak"; sudo cp -p "$PREPROD_ROOT/server/.env" "$ENV_BAK"; fi

for path in package.json admin app chats deploy docs project scripts server shared AGENTS.md PRODUCT.md IMPLEMENTATION.md README.md; do
  sudo rm -rf "$PREPROD_ROOT/$path"
  if [ -e "$RELEASE/$path" ]; then
    sudo cp -R "$RELEASE/$path" "$PREPROD_ROOT/$path"
    sudo chown -R "$DEPLOY_USER:$DEPLOY_GROUP" "$PREPROD_ROOT/$path"
  fi
done

echo "== 数据库 $PREPROD_DB =="
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$PREPROD_DB'" | grep -q 1; then
  sudo -u postgres createdb -O "$RUNTIME_USER" "$PREPROD_DB"
  echo "  建库完成"
else
  echo "  已存在，跳过建库"
fi
sudo -u postgres psql -d "$PREPROD_DB" -c "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null 2>&1 || echo "  (pgvector 扩展稍后由 pgvector.sql 处理)"

echo "== preprod .env =="
if [ -n "$ENV_BAK" ] && [ -f "$ENV_BAK" ]; then
  sudo cp -p "$ENV_BAK" "$PREPROD_ROOT/server/.env"
  echo "  沿用已存在的 preprod .env"
else
  sudo cp -p "$PROD_ROOT/server/.env" "$PREPROD_ROOT/server/.env"
  # 只替换 DB 路径段 /junshi?schema=public（不动同名的用户名 junshi:）
  sudo sed -i "s#/junshi?schema=public#/${PREPROD_DB}?schema=public#g" "$PREPROD_ROOT/server/.env"
  if sudo grep -qE '^PORT=' "$PREPROD_ROOT/server/.env"; then
    sudo sed -i -E "s#^PORT=.*#PORT=${PORT}#" "$PREPROD_ROOT/server/.env"
  else
    echo "PORT=${PORT}" | sudo tee -a "$PREPROD_ROOT/server/.env" >/dev/null
  fi
  if sudo grep -qE '^AI_FALLBACK_MOCK=' "$PREPROD_ROOT/server/.env"; then
    sudo sed -i -E "s#^AI_FALLBACK_MOCK=.*#AI_FALLBACK_MOCK=false#" "$PREPROD_ROOT/server/.env"
  fi
  sudo chown "$RUNTIME_USER:$RUNTIME_USER" "$PREPROD_ROOT/server/.env"
  sudo chmod 600 "$PREPROD_ROOT/server/.env"
  echo "  由生产 .env 派生（DATABASE_URL→${PREPROD_DB}, PORT=${PORT}, AI_FALLBACK_MOCK=false）"
fi

echo "== systemd 单元 $SERVICE =="
if [ ! -f "/etc/systemd/system/${SERVICE}.service" ]; then
  sudo tee "/etc/systemd/system/${SERVICE}.service" >/dev/null <<UNIT
[Unit]
Description=Junshi API PREPROD (Fastify + Prisma)
After=network.target postgresql.service
Wants=postgresql.service
[Service]
Type=simple
User=${RUNTIME_USER}
WorkingDirectory=${PREPROD_ROOT}/server
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE" >/dev/null 2>&1 || true
  echo "  已安装并 enable"
else
  echo "  已存在，跳过"
fi

echo "== nginx /api_preprod/ =="
if sudo grep -q '/api_preprod/' "$NGINX_CONF"; then
  echo "  已存在，跳过"
else
  BAK="${NGINX_CONF}.bak.preprod-$(date +%Y%m%d%H%M%S)"
  sudo cp -p "$NGINX_CONF" "$BAK"
  LAST_BRACE="$(grep -n '}' "$NGINX_CONF" | tail -1 | cut -d: -f1)"
  BLOCK=$'\n    # ==== 军师 preprod（新增；与 /api/ 生产互不影响）→ 去 /api_preprod 前缀转 :'"$PORT"$'/api/ ====\n    location /api_preprod/ {\n        proxy_pass http://127.0.0.1:'"$PORT"$'/api/;\n        proxy_http_version 1.1;\n        proxy_set_header Host              $host;\n        proxy_set_header X-Real-IP         $remote_addr;\n        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto https;\n        proxy_set_header Connection        "";\n        proxy_buffering off;\n        proxy_cache off;\n        proxy_read_timeout 180s;\n    }\n'
  sudo awk -v n="$LAST_BRACE" -v blk="$BLOCK" 'NR==n{printf "%s", blk} {print}' "$NGINX_CONF" | sudo tee "${NGINX_CONF}.new" >/dev/null
  sudo cp "${NGINX_CONF}.new" "$NGINX_CONF"; sudo rm -f "${NGINX_CONF}.new"
  if sudo nginx -t 2>/dev/null; then
    sudo systemctl reload nginx
    echo "  已插入 location 并 reload（备份：$BAK）"
  else
    echo "  !! nginx -t 失败，回滚"; sudo cp -p "$BAK" "$NGINX_CONF"; sudo nginx -t; exit 1
  fi
fi

echo "== 依赖 + prisma =="
cd "$PREPROD_ROOT/server"
npm ci
npx prisma generate
# preprod 为测试库：容忍新增唯一约束/列的 data-loss 提示（如 app_user.inviteCode 唯一约束；新列多为 NULL，PG 允许多 NULL）
sudo -u "$RUNTIME_USER" env HOME="/home/${RUNTIME_USER}" bash -c "cd '$PREPROD_ROOT/server' && ./node_modules/.bin/prisma db push --skip-generate --accept-data-loss"
sudo -u postgres psql -d "$PREPROD_DB" -f "$PREPROD_ROOT/server/prisma/pgvector.sql" >/dev/null 2>&1 || echo "  (pgvector.sql 已处理或不需要)"

echo "== 种子数据（幂等）=="
sudo -u "$RUNTIME_USER" env HOME="/home/${RUNTIME_USER}" bash -c "cd '$PREPROD_ROOT/server' && npm run db:seed" || echo "  seed 有非致命告警，继续"

echo "== 从生产库复制 AI 配置（真 AI 密钥；只读生产）=="
if sudo -u postgres bash -c "
  set -e
  psql -d '$PREPROD_DB' -c 'DELETE FROM ai_setting;' -c 'DELETE FROM ai_model;' >/dev/null 2>&1 || true
  pg_dump --data-only --column-inserts --table=ai_model --table=ai_setting junshi | psql -d '$PREPROD_DB' >/dev/null 2>&1
"; then echo "  ai_setting/ai_model 已从生产复制"; else echo "  !! AI 配置复制失败——preprod 可能回退 mock，稍后单独修"; fi

echo "== 构建 + 重启 =="
sudo rm -rf dist
npm run build
sudo systemctl restart "$SERVICE"
sleep 3
sudo systemctl is-active --quiet "$SERVICE" || { echo "!! 服务未起来"; sudo journalctl -u "$SERVICE" -n 40 --no-pager; exit 1; }
echo "== 本机健康检查 :$PORT =="
curl -fsS "http://127.0.0.1:${PORT}/api/health"; echo
printf '%s\n' "${SHA}" | sudo tee "$PREPROD_ROOT/.deploy-version" >/dev/null
echo "PREPROD_DEPLOYED ${SHA}"
REMOTE

log "公网验证 $PUBLIC/health"
curl -fsS "$PUBLIC/health" && printf "\n"
log "完成：${SHA} → $PUBLIC"
