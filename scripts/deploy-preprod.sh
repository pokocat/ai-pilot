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
# 用法：
#   bash scripts/deploy-preprod.sh              # 常规部署：**不动预发数据**，保留累积的测试数据
#   bash scripts/deploy-preprod.sh --reseed     # 额外重置业务数据（清空用户/会话/报告…并重建演示租户）
#
# 关于 seed：`db:seed` 是破坏性的（清空全部业务数据 + 重建 plan/agent/saying/survey 目录）。
# 它此前每次部署无条件执行，等于每次把预发验收环境推平；且当时 seed 不幂等（见下方 seed 段注释），
# 失败又被 `|| echo` 咽掉，实际长期没跑成。现在改为**默认不 seed**，只有两种情况会跑：
#   ① 显式 --reseed；② 本次刚 createdb（空库不 seed 会得到没有 agent/套餐的坏预发）。
set -euo pipefail

RESEED=0
for arg in "$@"; do
  case "$arg" in
    --reseed) RESEED=1 ;;
    *) printf "未知参数：%s\n用法：bash scripts/deploy-preprod.sh [--reseed]\n" "$arg" >&2; exit 2 ;;
  esac
done

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
  "SHA='${SHA}' PREPROD_ROOT='$PREPROD_ROOT' PROD_ROOT='$PROD_ROOT' PORT='$PORT' SERVICE='$SERVICE' PREPROD_DB='$PREPROD_DB' RUNTIME_USER='$RUNTIME_USER' RESEED='$RESEED' bash -se" <<'REMOTE'
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
DB_CREATED=0
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$PREPROD_DB'" | grep -q 1; then
  sudo -u postgres createdb -O "$RUNTIME_USER" "$PREPROD_DB"
  DB_CREATED=1
  echo "  建库完成（空库 → 稍后强制 seed 一次，否则预发没有 agent/套餐）"
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

# 预发支付必须永久与生产商户隔离：即使首次环境从生产 .env 派生，也不得
# 携带任何 WECHAT_PAY_* 凭据。预发只跑 PAY_MOCK_SUCCESS 的真实订单/权益管线，
# 不触达微信收款；每次部署都重申这个状态，防止手工改配后带着真商户出现。
set_env_value() {
  local key="$1" value="$2"
  if sudo grep -qE "^${key}=" "$PREPROD_ROOT/server/.env"; then
    sudo sed -i -E "s#^${key}=.*#${key}=${value}#" "$PREPROD_ROOT/server/.env"
  else
    printf '%s=%s\n' "$key" "$value" | sudo tee -a "$PREPROD_ROOT/server/.env" >/dev/null
  fi
}

# 预发每次都会从生产库复制 ai_setting / ai_model；其中 apiKey 是由生产
# APP_ENCRYPTION_KEY 加密的密文。只复制数据库行、不复制对应解密钥匙，会让预发看似有 4 个
# 带 key 的模型，运行时却全部解密失败并报 AI_UNAVAILABLE。这里仅同步这一个“配置解密钥匙”，
# 不复制 JWT / 支付 / 微信等其它生产凭据；全程不打印值，并在重启前 fail-closed 对账。
PROD_ENCRYPTION_KEY="$(sudo sed -n 's/^APP_ENCRYPTION_KEY=//p' "$PROD_ROOT/server/.env" | head -1 | tr -d '"\r')"
if [ -z "$PROD_ENCRYPTION_KEY" ]; then
  echo "!! 生产 APP_ENCRYPTION_KEY 缺失，无法在预发解密即将复制的 AI 配置" >&2
  exit 1
fi
sudo sed -i -E '/^APP_ENCRYPTION_KEY=/d' "$PREPROD_ROOT/server/.env"
printf 'APP_ENCRYPTION_KEY=%s\n' "$PROD_ENCRYPTION_KEY" | sudo tee -a "$PREPROD_ROOT/server/.env" >/dev/null
PREPROD_ENCRYPTION_KEY="$(sudo sed -n 's/^APP_ENCRYPTION_KEY=//p' "$PREPROD_ROOT/server/.env" | head -1 | tr -d '"\r')"
if [ "$PREPROD_ENCRYPTION_KEY" != "$PROD_ENCRYPTION_KEY" ]; then
  echo "!! 预发 APP_ENCRYPTION_KEY 写入后对账失败，拒绝部署" >&2
  exit 1
fi
unset PREPROD_ENCRYPTION_KEY PROD_ENCRYPTION_KEY

sudo sed -i -E '/^WECHAT_PAY_[A-Z0-9_]*=/d' "$PREPROD_ROOT/server/.env"
set_env_value NODE_ENV development
set_env_value PAY_MOCK_SUCCESS true
set_env_value PAY_SANDBOX false
set_env_value ALLOW_DEMO_PURCHASE false
sudo chown "$RUNTIME_USER:$RUNTIME_USER" "$PREPROD_ROOT/server/.env"
sudo chmod 600 "$PREPROD_ROOT/server/.env"
if sudo grep -qE '^WECHAT_PAY_[A-Z0-9_]*=.' "$PREPROD_ROOT/server/.env"; then
  echo "!! 预发 .env 仍含真实微信支付配置，拒绝部署" >&2
  exit 1
fi
echo "  AI 配置解密钥匙已对齐（值不回显）"
echo "  支付隔离已锁定：PAY_MOCK_SUCCESS=true · WECHAT_PAY_*=unset"

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

echo "== 种子数据 =="
# 破坏性：db:seed 会清空全部业务数据（用户/会话/报告/知识库/钱包/订单…）并重建
# plan/agent/saying/survey 目录，然后造演示租户。因此**默认不跑**，保住预发上累积的测试数据。
#
# 这一步曾经无条件执行 + `|| echo "seed 有非致命告警，继续"`，把真实失败咽成一行提示
# （与下方 AI 复制 2026-07-27 那个坑同源：吞退出码 → 脚本谎报成功）。2026-08-01 实测：
# seed 第二次跑必然在 user.deleteMany() 撞 token_wallet_userId_fkey 报 P2003，
# 脚本照样打印成功，演示租户其实一直没重建。seed 现已幂等
# （prisma/resetBusinessData.ts 是唯一顺序表 + test/seedIdempotent.test.ts 兜底），
# 所以它一旦失败就是真出事：直接中止。此时新代码还没构建/重启，旧服务照常在跑。
if [ "$RESEED" = "1" ] || [ "$DB_CREATED" = "1" ]; then
  [ "$DB_CREATED" = "1" ] && echo "  触发原因：本次刚建库（空库必须 seed）" || echo "  触发原因：--reseed"
  if ! sudo -u "$RUNTIME_USER" env HOME="/home/${RUNTIME_USER}" bash -c "cd '$PREPROD_ROOT/server' && npm run db:seed"; then
    echo "!! seed 失败（真实报错见上方输出）。已中止，未构建、未重启，旧服务不受影响。" >&2
    exit 1
  fi
else
  echo "  跳过（默认不动预发数据）。需要重置验收环境时加 --reseed。"
fi

echo "== 从生产库复制 AI 配置（真 AI 密钥；只读生产）=="
# 这一步曾经**静默失败并谎报成功**（2026-07-27）。旧实现是
#   pg_dump --column-inserts ... | psql >/dev/null 2>&1
# 三个问题叠加：① 管道退出码取最后一个命令(psql)；② psql 不带 ON_ERROR_STOP 时，
# 即使每条语句都报错也退 0；③ stderr 被丢掉。于是当生产库比 preprod 多出列时
# （当时是手工加的 thinkingMode/thinkingBudget），每行 INSERT 全失败，脚本照样打印
# 「已从生产复制」，preprod 静默回退 mock，AI 相关测试全部无效且无人知晓。
#
# 现在：只复制**两库共有列**（生产多出的列跳过；preprod 多出的新列由默认值补齐——
# 这正是纯加法迁移期望的行为），任何失败都必须响，并在复制后验证真实结果。
PROD_DB="${PROD_DB:-junshi}"
cols_of() { # $1=库 $2=表 → 列名每行一个（已排序，供 comm 求交集）
  sudo -u postgres psql -Atq -d "$1" \
    -c "SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='$2' ORDER BY 1"
}
copy_ai_table() {
  local t="$1" cols
  # Prisma 列名是 camelCase，**必须逐个加双引号**——不加会被 PG 折成小写，
  # "apiKey" 变 apikey 直接 column does not exist，整表复制全失败。
  cols="$(comm -12 <(cols_of "$PROD_DB" "$t") <(cols_of "$PREPROD_DB" "$t") | sed 's/.*/"&"/' | paste -sd, -)"
  [ -n "$cols" ] || { echo "  !! 表 $t 在 $PROD_DB 与 $PREPROD_DB 之间没有共有列" >&2; return 1; }
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$PREPROD_DB" -c "TRUNCATE $t" || return 1
  # 显式判管道成败并 return，不依赖调用处的 set -e：本函数一旦被放进 if/&& 条件上下文，
  # set -e 就不生效，末尾 echo 的 0 会把 COPY 失败盖掉（这个坑已被回归测试抓过一次）。
  if ! sudo -u postgres psql -v ON_ERROR_STOP=1 -Atq -d "$PROD_DB" -c "COPY (SELECT $cols FROM $t) TO STDOUT" \
       | sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$PREPROD_DB" -c "COPY $t($cols) FROM STDIN"; then
    echo "  !! 表 $t 复制失败（真实报错见上方 psql 输出）" >&2
    return 1
  fi
  echo "  $t 已复制（共有列 $(($(echo -n "$cols" | tr -cd , | wc -c) + 1)) 个）"
}
copy_ai_table ai_setting
copy_ai_table ai_model

# 验证：只有「ai_setting 恰好 1 行 + 至少一个带 key 的 ai_model」才算真的没回退 mock。
# 不通过就中止——此时新代码还没构建/重启，旧服务照常在跑，这是安全的失败姿态。
AI_SET_N="$(sudo -u postgres psql -Atq -d "$PREPROD_DB" -c 'SELECT count(*) FROM ai_setting')"
AI_KEY_N="$(sudo -u postgres psql -Atq -d "$PREPROD_DB" -c "SELECT count(*) FROM ai_model WHERE coalesce(\"apiKey\",'') <> ''")"
echo "  校验：ai_setting=${AI_SET_N} 行 · 带 key 的 ai_model=${AI_KEY_N} 个"
if [ "$AI_SET_N" != "1" ] || [ "$AI_KEY_N" -lt 1 ]; then
  echo "!! AI 配置复制结果不符合预期——preprod 会回退 mock，AI 相关测试全部无效。" >&2
  echo "   先核对生产库 ai_setting/ai_model 是否有数据、两库列是否严重漂移，再重跑本脚本。" >&2
  exit 1
fi

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
