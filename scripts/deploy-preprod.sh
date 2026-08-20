#!/usr/bin/env bash
# 军师 · 预发布(preprod)部署脚本 —— 与生产同机并存、互不影响。
#
#   生产：/opt/junshi          · junshi-api        · :4000 · DB junshi          · wxapi.aibuzz.cn/api
#   预发：/opt/junshi-preprod  · junshi-api-preprod · :4001 · DB junshi_preprod · wxapi.aibuzz.cn/api_preprod
#
# 首次运行自动完成：建库 junshi_preprod、写 preprod .env(改 DATABASE_URL+PORT)、
# 装 systemd 单元 junshi-api-preprod、在 nginx wxapi 块追加 location /api_preprod/(带 nginx -t 兜底)、
# 从生产库复制 ai_setting/ai_model(真 AI 密钥，复制后统一明文化)。之后每次运行只做：上传 DEPLOY_SHA → 构建 → 迁移 → 重启。
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

# ── 锁定本次要发布的提交 ──────────────────────────────────────────────────────
# 与 deploy-prod.sh 同口径、同理由：校验与打包之间隔着几十秒，并行 session 只要在这中间提交，
# `git archive HEAD` 就会把没校验过的提交打进包（2026-08-20 在生产真发生过）。开头定死并 export，
# 全脚本（含下面自重入的那次）只认这一个值。要发指定提交：DEPLOY_SHA=<sha> bash scripts/deploy-preprod.sh
# 统一解析成完整 sha（显式传短 sha 时也归一，否则与 HEAD 比对会恒报「有并行提交」）；
# ref 不存在时 rev-parse 非零退出，set -e 直接中止，好过打出一个空包。
DEPLOY_SHA="$(cd "$ROOT" && git rev-parse "${DEPLOY_SHA:-HEAD}")"
export DEPLOY_SHA
SHA="$(cd "$ROOT" && git rev-parse --short "$DEPLOY_SHA")"
RELEASE_ID="${SHA}-$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="/tmp/junshi-preprod-${SHA}.tar.gz"

# 与 deploy-prod.sh 同口径：谁发的要能追溯，制表符/换行会破坏 TSV 结构先洗掉。
DEPLOY_OPERATOR="${DEPLOY_OPERATOR:-$( (cd "$ROOT" && git config user.name) 2>/dev/null || id -un)@$(hostname -s)}"
DEPLOY_OPERATOR="$(printf '%s' "$DEPLOY_OPERATOR" | tr -d '\t\n' | tr -s ' ')"

# 见 deploy-prod.sh 同段注释：exec > >(tee ...) 会丢末尾行，改用自重入 + 管道。
LOG_DIR="$ROOT/.deploy-logs"
mkdir -p "$LOG_DIR"
if [ -z "${DEPLOY_LOG_FILE:-}" ]; then
  export DEPLOY_LOG_FILE="$LOG_DIR/preprod-${SHA}-$(date -u +%Y%m%dT%H%M%SZ).log"
  set -o pipefail
  bash "$0" "$@" 2>&1 | tee -a "$DEPLOY_LOG_FILE"
  DEPLOY_STATUS="${PIPESTATUS[0]}"
  printf '\033[1;36m[deploy]\033[0m 全量日志：%s\n' "$DEPLOY_LOG_FILE"
  exit "$DEPLOY_STATUS"
fi

log(){ printf "\033[1;36m[preprod]\033[0m %s\n" "$*"; }
die(){ printf "\033[1;31m[preprod] %s\033[0m\n" "$*" >&2; exit 1; }
[ -f "$SSH_KEY" ] || die "SSH key 不存在：$SSH_KEY"

# 醒目声明本次到底发的是哪个提交（预发是验收基准，发错版本会把验收结论也带偏）。
printf '\033[1;33m========================================================\033[0m\n'
printf '\033[1;33m[preprod] 本次发布提交：%s  %s\033[0m\n' "$SHA" "$( (cd "$ROOT" && git log -1 --format=%s "$DEPLOY_SHA") 2>/dev/null || echo '(subject 读取失败)')"
printf '\033[1;33m========================================================\033[0m\n'

# 打包前再看一眼 HEAD。**不阻断**：内容正确性已由「打包 $DEPLOY_SHA 而不是 HEAD」保证，
# 这行只是提示有并行提交，免得日志 SHA 与 `git log` 对不上时误以为发错。
CURRENT_HEAD="$( (cd "$ROOT" && git rev-parse HEAD) 2>/dev/null || echo '')"
if [ -n "$CURRENT_HEAD" ] && [ "$CURRENT_HEAD" != "$DEPLOY_SHA" ]; then
  printf '\033[1;33m[preprod] ⚠ 本地 HEAD 已变为 %s，与锁定的 %s 不同（有并行提交）。本次仍按锁定的 SHA 打包。\033[0m\n' \
    "$(cd "$ROOT" && git rev-parse --short "$CURRENT_HEAD")" "$SHA"
fi

log "打包锁定提交：${SHA}"
( cd "$ROOT" && git archive --format=tar.gz -o "$ARCHIVE" "$DEPLOY_SHA" )

log "上传归档 -> $DEPLOY_HOST"
scp -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new "$ARCHIVE" "$DEPLOY_HOST:/tmp/"

log "远端建立/更新 preprod"
ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new "$DEPLOY_HOST" \
  "SHA='${SHA}' RELEASE_ID='${RELEASE_ID}' PREPROD_ROOT='$PREPROD_ROOT' PROD_ROOT='$PROD_ROOT' PORT='$PORT' SERVICE='$SERVICE' PREPROD_DB='$PREPROD_DB' RUNTIME_USER='$RUNTIME_USER' RESEED='$RESEED' DEPLOY_OPERATOR='${DEPLOY_OPERATOR}' bash -se" <<'REMOTE'
set -euo pipefail
ARCHIVE="/tmp/junshi-preprod-${SHA}.tar.gz"
DEPLOY_USER="$(id -un)"; DEPLOY_GROUP="$(id -gn)"
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
RELEASES_ROOT="$PREPROD_ROOT/releases"
RELEASE="$RELEASES_ROOT/release-${RELEASE_ID}"
CANDIDATE_SERVER="$RELEASE/server"
LIVE_SERVER="$PREPROD_ROOT/server"
NGINX_CONF="/etc/nginx/conf.d/junshi.conf"
MIN_AVAILABLE_MB="${PREPROD_MIN_AVAILABLE_MB:-3072}"
BUILD_MEMORY_MAX="${PREPROD_BUILD_MEMORY_MAX:-2G}"
BUILD_CPU_QUOTA="${PREPROD_BUILD_CPU_QUOTA:-100%}"

cleanup_stage() {
  rm -f "$ARCHIVE"
}
trap cleanup_stage EXIT

echo "== 建立候选 release（磁盘构建，不覆盖在线 server）=="
sudo install -d -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m 0755 "$PREPROD_ROOT" "$RELEASES_ROOT"
if [[ "$RELEASE" != "$RELEASES_ROOT"/release-* ]]; then
  echo "!! 非法 release 路径：$RELEASE" >&2
  exit 1
fi
sudo rm -rf "$RELEASE"
sudo install -d -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m 0755 "$RELEASE"
tar -xzf "$ARCHIVE" -C "$RELEASE"
[ -d "$CANDIDATE_SERVER" ] || { echo "!! 候选 release 缺少 server/" >&2; exit 1; }

# 保留已存在的 preprod .env
ENV_SOURCE=""
if [ -f "$LIVE_SERVER/.env" ]; then ENV_SOURCE="$LIVE_SERVER/.env"; fi

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
if [ -n "$ENV_SOURCE" ]; then
  sudo cp -p "$ENV_SOURCE" "$CANDIDATE_SERVER/.env"
  echo "  沿用已存在的 preprod .env"
else
  sudo cp -p "$PROD_ROOT/server/.env" "$CANDIDATE_SERVER/.env"
  # 只替换 DB 路径段 /junshi?schema=public（不动同名的用户名 junshi:）
  sudo sed -i "s#/junshi?schema=public#/${PREPROD_DB}?schema=public#g" "$CANDIDATE_SERVER/.env"
  if sudo grep -qE '^PORT=' "$CANDIDATE_SERVER/.env"; then
    sudo sed -i -E "s#^PORT=.*#PORT=${PORT}#" "$CANDIDATE_SERVER/.env"
  else
    echo "PORT=${PORT}" | sudo tee -a "$CANDIDATE_SERVER/.env" >/dev/null
  fi
  if sudo grep -qE '^AI_FALLBACK_MOCK=' "$CANDIDATE_SERVER/.env"; then
    sudo sed -i -E "s#^AI_FALLBACK_MOCK=.*#AI_FALLBACK_MOCK=false#" "$CANDIDATE_SERVER/.env"
  fi
  sudo chown "$RUNTIME_USER:$RUNTIME_USER" "$CANDIDATE_SERVER/.env"
  sudo chmod 600 "$CANDIDATE_SERVER/.env"
  echo "  由生产 .env 派生（DATABASE_URL→${PREPROD_DB}, PORT=${PORT}, AI_FALLBACK_MOCK=false）"
fi

# 预发支付必须永久与生产商户隔离：即使首次环境从生产 .env 派生，也不得
# 携带任何 WECHAT_PAY_* 凭据。预发只跑 PAY_MOCK_SUCCESS 的真实订单/权益管线，
# 不触达微信收款；每次部署都重申这个状态，防止手工改配后带着真商户出现。
set_env_value() {
  local key="$1" value="$2"
  if sudo grep -qE "^${key}=" "$CANDIDATE_SERVER/.env"; then
    sudo sed -i -E "s#^${key}=.*#${key}=${value}#" "$CANDIDATE_SERVER/.env"
  else
    printf '%s=%s\n' "$key" "$value" | sudo tee -a "$CANDIDATE_SERVER/.env" >/dev/null
  fi
}

sudo sed -i -E '/^WECHAT_PAY_[A-Z0-9_]*=/d' "$CANDIDATE_SERVER/.env"
set_env_value NODE_ENV development
set_env_value PAY_MOCK_SUCCESS true
set_env_value PAY_SANDBOX false
set_env_value ALLOW_DEMO_PURCHASE false
set_env_value CLIP_MEDIA_MODERATION_BYPASS true
sudo chown "$RUNTIME_USER:$RUNTIME_USER" "$CANDIDATE_SERVER/.env"
sudo chmod 600 "$CANDIDATE_SERVER/.env"
if sudo grep -qE '^WECHAT_PAY_[A-Z0-9_]*=.' "$CANDIDATE_SERVER/.env"; then
  echo "!! 预发 .env 仍含真实微信支付配置，拒绝部署" >&2
  exit 1
fi
echo "  AI 模型凭证不再要求预发持有生产 APP_ENCRYPTION_KEY"
echo "  测试旁路已锁定：PAY_MOCK_SUCCESS=true · CLIP_MEDIA_MODERATION_BYPASS=true · WECHAT_PAY_*=unset"

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
cd "$CANDIDATE_SERVER"
# 预发与生产同机：构建期峰值必须被硬隔离。宿主机只有 4C/7.3GiB 且无 Swap，
# 2026-08-15 部署前 /tmp tmpfs 已被 AIStar Clip 历史 JAR 占到约 3GiB，随后 npm ci
# 把宿主拖到 SSH/HTTP 失联。先按 MemAvailable 拒绝危险部署，再用 transient cgroup
# 把每个构建命令限制在单核/2GiB；nice/idle IO 只负责调度优先级，不能替代硬上限。
AVAIL_MB=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
[ "$AVAIL_MB" -ge "$MIN_AVAILABLE_MB" ] || { echo "!! 可用内存仅 ${AVAIL_MB}MB (<${MIN_AVAILABLE_MB})，拒绝在生产宿主机上构建预发"; exit 1; }
run_build_limited() {
  sudo systemd-run --quiet --wait --pipe --collect \
    --uid="$DEPLOY_USER" --gid="$DEPLOY_GROUP" \
    --working-directory="$CANDIDATE_SERVER" --setenv="HOME=$DEPLOY_HOME" \
    --property="MemoryMax=$BUILD_MEMORY_MAX" --property="MemorySwapMax=0" \
    --property="CPUQuota=$BUILD_CPU_QUOTA" --property="Nice=19" \
    --property="IOSchedulingClass=idle" -- "$@"
}
echo "  构建护栏：MemAvailable=${AVAIL_MB}MB · MemoryMax=${BUILD_MEMORY_MAX} · CPUQuota=${BUILD_CPU_QUOTA}"
run_build_limited npm ci --no-audit --no-fund
run_build_limited npx prisma generate
run_build_limited npm run build
[ -s "$CANDIDATE_SERVER/dist/index.js" ] || { echo "!! 候选构建缺少 dist/index.js" >&2; exit 1; }
# preprod 为测试库：容忍新增唯一约束/列的 data-loss 提示（如 app_user.inviteCode 唯一约束；新列多为 NULL，PG 允许多 NULL）
sudo -u "$RUNTIME_USER" env HOME="/home/${RUNTIME_USER}" bash -c "cd '$CANDIDATE_SERVER' && ./node_modules/.bin/prisma db push --skip-generate --accept-data-loss"
sudo -u postgres psql -d "$PREPROD_DB" -f "$CANDIDATE_SERVER/prisma/pgvector.sql" >/dev/null 2>&1 || echo "  (pgvector.sql 已处理或不需要)"

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
  if ! sudo -u "$RUNTIME_USER" env HOME="/home/${RUNTIME_USER}" bash -c "cd '$CANDIDATE_SERVER' && npm run db:seed"; then
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

# 生产尚未发布本版本前，复制来的 AI 字段可能仍是 enc:v1 密文。仅在这一瞬间从生产 .env
# 读取旧主密钥并通过进程环境交给迁移脚本；不写入 preprod .env、不打印值。所有字段先解密成功
# 才会开启事务写入，错误密钥不会造成半迁移。生产完成迁移后这里自然变成 0 项、无需主密钥。
AI_ENCRYPTED_N="$(sudo -u postgres psql -Atq -d "$PREPROD_DB" -c \
  "SELECT
     (SELECT count(*) FROM ai_model WHERE coalesce(\"apiKey\",'') LIKE 'enc:v1:%') +
     (SELECT count(*) FROM ai_setting WHERE coalesce(\"apiKey\",'') LIKE 'enc:v1:%'
       OR coalesce(\"embeddingApiKey\",'') LIKE 'enc:v1:%'
       OR coalesce(\"rerankApiKey\",'') LIKE 'enc:v1:%')")"
if [ "$AI_ENCRYPTED_N" -gt 0 ]; then
  PROD_ENCRYPTION_KEY="$(sudo sed -n 's/^APP_ENCRYPTION_KEY=//p' "$PROD_ROOT/server/.env" | head -1 | tr -d '"\r')"
  if [ -z "$PROD_ENCRYPTION_KEY" ]; then
    echo "!! 复制到 ${AI_ENCRYPTED_N} 行历史 AI 密文，但生产 APP_ENCRYPTION_KEY 缺失，拒绝半迁移" >&2
    exit 1
  fi
  sudo -u "$RUNTIME_USER" env HOME="/home/${RUNTIME_USER}" APP_ENCRYPTION_KEY="$PROD_ENCRYPTION_KEY" \
    bash -c "cd '$CANDIDATE_SERVER' && npm run secrets:decrypt-ai"
  unset PROD_ENCRYPTION_KEY
else
  echo "  AI 凭证已是明文，无需迁移"
fi
AI_ENCRYPTED_AFTER="$(sudo -u postgres psql -Atq -d "$PREPROD_DB" -c \
  "SELECT
     (SELECT count(*) FROM ai_model WHERE coalesce(\"apiKey\",'') LIKE 'enc:v1:%') +
     (SELECT count(*) FROM ai_setting WHERE coalesce(\"apiKey\",'') LIKE 'enc:v1:%'
       OR coalesce(\"embeddingApiKey\",'') LIKE 'enc:v1:%'
       OR coalesce(\"rerankApiKey\",'') LIKE 'enc:v1:%')")"
if [ "$AI_ENCRYPTED_AFTER" != "0" ]; then
  echo "!! AI 凭证明文化后仍有 ${AI_ENCRYPTED_AFTER} 行密文，拒绝重启" >&2
  exit 1
fi
echo "  AI 凭证存储校验：历史密文 0 行"

echo "== 原子切换候选 release =="
# 必须在覆盖 .deploy-version 之前捞出旧值，否则「上一版是谁」永久丢失。
PREV_VERSION="$(cat "$PREPROD_ROOT/.deploy-version" 2>/dev/null || true)"
# 列口径与 deploy-prod.sh 一致：UTC / 旧版本 / 新版本 / 明细 / 结果 / 操作者。
record_history() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${PREV_VERSION:--}" "${SHA}" "release=${RELEASE_ID}" "$1" "${DEPLOY_OPERATOR:-unknown}" \
    | sudo tee -a "$PREPROD_ROOT/.deploy-history" >/dev/null || true
}
PREVIOUS_TARGET=""
if [ -L "$LIVE_SERVER" ]; then
  PREVIOUS_TARGET="$(readlink -f "$LIVE_SERVER")"
elif [ -d "$LIVE_SERVER" ]; then
  PREVIOUS_TARGET="$RELEASES_ROOT/legacy-server-$(date -u +%Y%m%dT%H%M%SZ)"
  sudo mv "$LIVE_SERVER" "$PREVIOUS_TARGET"
fi
NEXT_LINK="$PREPROD_ROOT/.server-next-${RELEASE_ID}"
sudo rm -f "$NEXT_LINK"
sudo ln -s "$CANDIDATE_SERVER" "$NEXT_LINK"
sudo mv -Tf "$NEXT_LINK" "$LIVE_SERVER"

rollback_release() {
  echo "!! 候选 release 启动失败，回滚到 ${PREVIOUS_TARGET:-无}" >&2
  # 回滚也是一次真实发生过的发布尝试，必须留痕；只记成功的历史会掩盖反复失败的版本。
  record_history rollback
  if [ -n "$PREVIOUS_TARGET" ] && [ -d "$PREVIOUS_TARGET" ]; then
    local rollback_link="$PREPROD_ROOT/.server-rollback-${RELEASE_ID}"
    sudo rm -f "$rollback_link"
    sudo ln -s "$PREVIOUS_TARGET" "$rollback_link"
    sudo mv -Tf "$rollback_link" "$LIVE_SERVER"
    sudo systemctl restart "$SERVICE" || true
  fi
}

if ! sudo systemctl restart "$SERVICE"; then
  rollback_release
  sudo journalctl -u "$SERVICE" -n 60 --no-pager
  exit 1
fi
HEALTHY=0
for _ in $(seq 1 15); do
  if sudo systemctl is-active --quiet "$SERVICE" && curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/api/health" >/tmp/junshi-preprod-health; then
    HEALTHY=1
    break
  fi
  sleep 2
done
if [ "$HEALTHY" != "1" ]; then
  rollback_release
  sudo journalctl -u "$SERVICE" -n 60 --no-pager
  exit 1
fi
echo "== 本机健康检查 :$PORT =="
cat /tmp/junshi-preprod-health; echo
printf '%s\n' "${SHA}" | sudo tee "$PREPROD_ROOT/.deploy-version" >/dev/null
# 预发已在上面做过启动 + 健康双重把关（失败会走 rollback_release 并记 rollback），
# 走到这里就是确定成功，不需要生产那种 switched/ok 两段式。
record_history ok
echo "== 版本记录 ${PREV_VERSION:--} -> ${SHA}（ok）=="
echo "PREPROD_DEPLOYED ${SHA} release=${RELEASE_ID} previous=${PREVIOUS_TARGET:-none}"
REMOTE

log "公网验证 $PUBLIC/health"
curl -fsS "$PUBLIC/health" && printf "\n"
log "完成：${SHA} → $PUBLIC"
