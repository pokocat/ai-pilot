#!/usr/bin/env bash
# 压测前置：生成压测专用密钥与 JWT，供 docker-compose 与 k6 使用。
#
#   bash loadtest/prepare.sh [用户数]        # 默认 1000，与 loadtestSeed 的规模一致
#
# 产物（两个都是 0600、都已 gitignore，**禁止写入仓库/报告/日志**）：
#   loadtest/.env         LT_JWT_SECRET / LT_METRICS_TOKEN，docker compose 自动读取
#   loadtest/tokens.json  N 个真实 HS256 JWT，k6 按 VU 取用
#
# 已存在的 .env 不会被覆盖（密钥换掉会让已签发的 tokens.json 全部失效 → 全站 401）。
# 要重置：先 rm loadtest/.env loadtest/tokens.json 再跑本脚本。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LT="$ROOT/loadtest"
USERS="${1:-${LT_USERS:-1000}}"

if [ -f "$LT/.env" ]; then
  echo "== 复用已有 loadtest/.env（要重置先删掉它和 tokens.json）=="
else
  echo "== 生成压测专用密钥 → loadtest/.env =="
  umask 077
  {
    echo "# 压测专用，用后即弃。禁止提交、禁止贴进报告或日志。"
    echo "# 由 loadtest/prepare.sh 生成于容器外，只在本机存在。"
    echo "LT_JWT_SECRET=$(openssl rand -hex 32)"
    echo "LT_METRICS_TOKEN=$(openssl rand -hex 24)"
  } > "$LT/.env"
  chmod 600 "$LT/.env"
fi

# shellcheck disable=SC1091
set -a; . "$LT/.env"; set +a

echo "== 签发 $USERS 个 JWT → loadtest/tokens.json =="
if [ -x "$ROOT/server/node_modules/.bin/tsx" ]; then
  ( cd "$ROOT/server" && LT_JWT_SECRET="$LT_JWT_SECRET" npx tsx scripts/mintLoadtestTokens.ts "$USERS" )
elif command -v docker >/dev/null 2>&1 && docker image inspect junshi-loadtest-api >/dev/null 2>&1; then
  # 干净的压测服务器通常没有宿主机 node_modules。复用刚构建的隔离 API 镜像签发，
  # 不安装依赖、不碰生产运行时；以当前用户写入，保持 tokens.json 可读但仍为 0600。
  docker run --rm --user "$(id -u):$(id -g)" --env-file "$LT/.env" \
    -v "$ROOT/server/scripts:/app/scripts:ro" \
    -v "$LT:/loadtest" \
    junshi-loadtest-api npx tsx scripts/mintLoadtestTokens.ts "$USERS"
else
  echo "缺少 server/node_modules/.bin/tsx；请先执行 cd loadtest && docker compose build api，再重跑本脚本。" >&2
  exit 1
fi
chmod 600 "$LT/tokens.json"

echo
echo "就绪。接下来："
echo "  T1 生产同构单进程（不设 CPU 配额）："
echo "    cd loadtest && docker compose up -d --build"
echo "  T0 对照组（复刻上一轮 2.25 核）："
echo "    cd loadtest && docker compose -f docker-compose.yml -f docker-compose.limits.yml up -d --build"
echo
echo "启动后务必先看一眼日志里的安全告警："
echo "    cd loadtest && docker compose logs api | grep -i '安全告警'"
echo "  只允许出现 SMS_REQUIRE_CODE 那一条（压测有意不走验证码）。"
echo "  若出现 APP_JWT_SECRET / APP_JWT_REQUIRED 相关告警，说明配置没生效，**该轮数据作废**。"
