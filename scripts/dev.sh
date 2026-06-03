#!/usr/bin/env bash
# 军师 · 本地一键开发（PostgreSQL）
#   确保 Postgres → 建库 → 装依赖 → 迁移 → (首次)灌种子 → 同时拉起 后端 + H5 + 运营后台。
#
# 用法：
#   npm run dev                      # 根目录；或： bash scripts/dev.sh
#   AI_PROVIDER=openai npm run dev    # 用真实模型（也可在运营后台「模型」页配置/切换）
#   SEED=1 npm run dev               # 强制重新灌种子（会清空业务数据）
#   DATABASE_URL=... npm run dev      # 指向已有库（跳过自动建库逻辑里的默认值）
#   纯前端走查（不连后端）： cd app && npm run dev:h5
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# —— 可配置（带默认）——
DB_NAME="${DB_NAME:-junshi}"
DB_USER="${DB_USER:-postgres}"
DB_PASS="${DB_PASS:-postgres}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
export DATABASE_URL="${DATABASE_URL:-postgresql://$DB_USER:$DB_PASS@$DB_HOST:$DB_PORT/$DB_NAME?schema=public}"
export AI_PROVIDER="${AI_PROVIDER:-mock}"
API_PORT="${API_PORT:-4000}"
H5_PORT="${H5_PORT:-5173}"
ADMIN_PORT="${ADMIN_PORT:-5174}"

log(){ printf "\033[1;36m[dev]\033[0m %s\n" "$*"; }
die(){ printf "\033[1;31m[dev] %s\033[0m\n" "$*" >&2; exit 1; }

# —— 1) 确保 Postgres 在跑（已就绪则跳过；否则尽力启动）——
if ! pg_isready -h "$DB_HOST" -p "$DB_PORT" -q 2>/dev/null; then
  log "Postgres 未就绪，尝试启动…"
  if command -v pg_ctlcluster >/dev/null 2>&1; then
    ver="$(ls /etc/postgresql 2>/dev/null | sort -V | tail -1 || true)"
    [ -n "$ver" ] && { pg_ctlcluster "$ver" main start 2>/dev/null || sudo pg_ctlcluster "$ver" main start 2>/dev/null || true; }
  fi
  command -v brew >/dev/null 2>&1 && brew services start postgresql >/dev/null 2>&1 || true
  command -v service >/dev/null 2>&1 && { service postgresql start 2>/dev/null || sudo service postgresql start 2>/dev/null || true; }
  for _ in $(seq 1 15); do pg_isready -h "$DB_HOST" -p "$DB_PORT" -q 2>/dev/null && break; sleep 1; done
fi
pg_isready -h "$DB_HOST" -p "$DB_PORT" -q 2>/dev/null || die "无法连接/启动 Postgres（$DB_HOST:$DB_PORT）。请手动启动，或设 DATABASE_URL 指向已有库后重试。"
log "Postgres OK · $DB_HOST:$DB_PORT · db=$DB_NAME"

# —— 2) 确保数据库存在 ——
export PGPASSWORD="$DB_PASS"
if ! psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null | grep -q 1; then
  log "创建数据库 $DB_NAME"
  createdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME" 2>/dev/null \
    || psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c "CREATE DATABASE \"$DB_NAME\"" \
    || die "建库失败，请检查 DB_USER/DB_PASS 或手动建库 $DB_NAME。"
fi

# —— 3) 依赖 + 迁移 + (首次/强制)种子 ——
need_install(){ [ -d "$1/node_modules" ] || { log "安装依赖 ${1##*/} …"; ( cd "$1" && npm install ); }; }
need_install "$ROOT/server"; need_install "$ROOT/app"; need_install "$ROOT/admin"

log "Prisma generate + db push"
( cd "$ROOT/server" && npx prisma generate >/dev/null && npx prisma db push --skip-generate >/dev/null )

do_seed="${SEED:-}"
if [ -z "$do_seed" ]; then
  cnt="$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc 'SELECT count(*) FROM "agent"' 2>/dev/null || echo 0)"
  [ "${cnt//[[:space:]]/}" = "0" ] && do_seed=1
fi
[ -n "$do_seed" ] && { log "灌入种子数据（智能体/套餐/献策/问卷/演示项目+报告）"; ( cd "$ROOT/server" && npm run db:seed ); }

# —— 4) 同时拉起三端；Ctrl+C 一并关闭 ——
trap 'echo; log "关闭所有进程…"; kill 0 2>/dev/null' EXIT INT TERM

log "① 后端 API :$API_PORT （provider=$AI_PROVIDER）"
( cd "$ROOT/server" && PORT="$API_PORT" npm run dev ) &

log "② 运营后台 :$ADMIN_PORT （/api 代理到 :$API_PORT）"
( cd "$ROOT/admin" && npm run dev -- --port "$ADMIN_PORT" ) &

# H5 先做一次阻塞式构建（确保 dist 就绪，serve 不会 500），再起静态预览。
log "③ 构建 H5（server 模式 · 首次约 20–40s，请稍候）…"
( cd "$ROOT/app" && npm run build:h5:server )
log "   H5 预览 :$H5_PORT （改了 app 源码后重跑 npm run build:h5:server；或另开 npm run dev:h5:server 自动监听）"
( cd "$ROOT/app" && npm run serve:h5 "$H5_PORT" ) &
cat <<TXT

  ┌──────────────────────────────────────────────────────────┐
   军师 · 本地开发已就绪（Ctrl+C 退出，一并关闭三端）
     H5（浏览器手测）   http://localhost:$H5_PORT
     后端 API          http://localhost:$API_PORT/api
     运营后台（改模型） http://localhost:$ADMIN_PORT
     演示账号          手机号 13800000000（王总 · 含演示项目/报告/知识）
                       其他手机号 = 新账号（体验版 10 次算力，可验扣减）
  └──────────────────────────────────────────────────────────┘
TXT

wait
