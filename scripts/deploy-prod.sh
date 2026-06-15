#!/usr/bin/env bash
# 军师 · 生产部署脚本（server + admin，H5 可选）
#
# 默认目标是当前固定 ECS：ecs-user@8.136.36.175，上传当前 git HEAD 的干净归档。
# 远端 /opt/junshi 是上传包式部署，不是 git 仓库；不要在服务器上 git pull。
#
# 用法：
#   bash scripts/deploy-prod.sh
#   DEPLOY_H5=1 bash scripts/deploy-prod.sh
#   DEPLOY_HOST=ecs-user@1.2.3.4 SSH_KEY=/path/key REMOTE_ROOT=/opt/junshi bash scripts/deploy-prod.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DEPLOY_HOST="${DEPLOY_HOST:-ecs-user@8.136.36.175}"
SSH_KEY="${SSH_KEY:-/Users/donis/dev/aliyun/aiartist.pem}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/junshi}"
REMOTE_RUNTIME_USER="${REMOTE_RUNTIME_USER:-junshi}"
PUBLIC_BASE="${PUBLIC_BASE:-http://8.136.36.175}"
PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-https://wxapi.aibuzz.cn}"
DEPLOY_H5="${DEPLOY_H5:-0}"
TARO_APP_API="${TARO_APP_API:-https://wxapi.aibuzz.cn/api}"

SHA="$(cd "$ROOT" && git rev-parse --short HEAD)"
ARCHIVE="/tmp/junshi-${SHA}.tar.gz"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=accept-new -i "$SSH_KEY")

log(){ printf "\033[1;36m[deploy]\033[0m %s\n" "$*"; }
die(){ printf "\033[1;31m[deploy] %s\033[0m\n" "$*" >&2; exit 1; }

[ -f "$SSH_KEY" ] || die "SSH key 不存在：$SSH_KEY"

if ! ( cd "$ROOT" && git diff --quiet && git diff --cached --quiet ); then
  log "检测到未提交的 tracked 改动；本次仍只部署当前 HEAD=$SHA。"
fi

log "打包当前 HEAD：$SHA"
( cd "$ROOT" && git archive --format=tar.gz -o "$ARCHIVE" HEAD )

log "上传 $ARCHIVE -> $DEPLOY_HOST:/tmp/"
scp "${SSH_OPTS[@]}" "$ARCHIVE" "$DEPLOY_HOST:/tmp/"

log "远端构建并发布 server + admin"
ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" \
  "SHA='$SHA' REMOTE_ROOT='$REMOTE_ROOT' REMOTE_RUNTIME_USER='$REMOTE_RUNTIME_USER' DEPLOY_H5='$DEPLOY_H5' TARO_APP_API='$TARO_APP_API' bash -se" <<'REMOTE'
set -euo pipefail

APP_ROOT="$REMOTE_ROOT"
ARCHIVE="/tmp/junshi-${SHA}.tar.gz"
RELEASE="/tmp/junshi-release-${SHA}"
ENV_BACKUP="/tmp/junshi-server-env-${SHA}"
DEPLOY_USER="$(id -un)"
DEPLOY_GROUP="$(id -gn)"

echo "== prepare release $SHA =="
rm -rf "$RELEASE"
mkdir -p "$RELEASE"
tar -xzf "$ARCHIVE" -C "$RELEASE"

if [ -f "$APP_ROOT/server/.env" ]; then
  sudo cp -p "$APP_ROOT/server/.env" "$ENV_BACKUP"
fi

# Replace tracked application paths so deleted files do not linger. Preserve
# server/.env, backups, logos, and other host-owned runtime artifacts.
for path in \
  AGENTS.md PRODUCT.md IMPLEMENTATION.md README.md package.json .gitignore \
  .github admin app chats deploy docs project scripts server shared
do
  sudo rm -rf "$APP_ROOT/$path"
  if [ -e "$RELEASE/$path" ]; then
    sudo cp -R "$RELEASE/$path" "$APP_ROOT/$path"
    sudo chown -R "$DEPLOY_USER:$DEPLOY_GROUP" "$APP_ROOT/$path"
  fi
done

if [ -f "$ENV_BACKUP" ]; then
  sudo mkdir -p "$APP_ROOT/server"
  sudo cp -p "$ENV_BACKUP" "$APP_ROOT/server/.env"
fi

echo "== server dependencies and prisma =="
cd "$APP_ROOT/server"
npm ci
npx prisma generate

# server/.env is owned by runtime user junshi (0600). Run schema push as that
# user and skip generate, because generate already ran as deploy user above.
sudo -u "$REMOTE_RUNTIME_USER" env HOME="/home/$REMOTE_RUNTIME_USER" APP_ROOT="$APP_ROOT" bash -c \
  'cd "$APP_ROOT/server" && ./node_modules/.bin/prisma db push --skip-generate'

echo "== server build and restart =="
sudo rm -rf dist
npm run build
sudo systemctl restart junshi-api
sleep 3
sudo systemctl is-active --quiet junshi-api
curl -fsS http://127.0.0.1:4000/api/health
echo

echo "== admin build and publish =="
cd "$APP_ROOT/admin"
npm ci
npm run build -- --base=/admin/
sudo mkdir -p /var/www/junshi/admin
sudo find /var/www/junshi/admin -mindepth 1 -maxdepth 1 -exec rm -rf {} +
sudo cp -R dist/. /var/www/junshi/admin/

if [ "$DEPLOY_H5" = "1" ]; then
  echo "== h5 build and publish =="
  cd "$APP_ROOT/app"
  npm ci
  TARO_APP_MODE=server TARO_APP_API="$TARO_APP_API" npm run build:h5
  sudo mkdir -p /var/www/junshi/h5
  sudo find /var/www/junshi/h5 -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  sudo cp -R dist/. /var/www/junshi/h5/
fi

printf '%s\n' "$SHA" | sudo tee "$APP_ROOT/.deploy-version" >/dev/null

echo "== nginx reload =="
sudo nginx -t
sudo systemctl reload nginx

echo "== local smoke =="
curl -fsS http://127.0.0.1/api/health
echo
curl -fsSI http://127.0.0.1/admin/ >/dev/null
if [ "$DEPLOY_H5" = "1" ]; then
  curl -fsSI http://127.0.0.1/ >/dev/null
fi

echo "DEPLOYED $SHA"
REMOTE

log "公网验证"
curl -fsS "$PUBLIC_BASE/api/health"
printf "\n"
curl -fsSI "$PUBLIC_BASE/admin/" >/dev/null
if [ -n "$PUBLIC_DOMAIN" ]; then
  curl -fsS "$PUBLIC_DOMAIN/api/health"
  printf "\n"
  curl -fsSI "$PUBLIC_DOMAIN/admin/" >/dev/null
fi

log "完成：$SHA"
