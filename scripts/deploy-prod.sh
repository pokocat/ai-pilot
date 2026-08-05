#!/usr/bin/env bash
# 军师 · 生产部署脚本（server + admin，H5 可选）
#
# 默认目标是当前固定 ECS：ecs-user@8.136.36.175，上传当前 git HEAD 的干净归档。
# 远端 /opt/junshi 是上传包式部署，不是 git 仓库；不要在服务器上 git pull。
#
# 用法：
#   bash scripts/deploy-prod.sh
#   DEPLOY_H5=1 bash scripts/deploy-prod.sh
#   ACCEPT_DATA_LOSS=1 bash scripts/deploy-prod.sh   # schema 含新唯一约束/破坏性列变更时，让 db push 接受 prisma 的 data-loss 门；默认关（保护线上数据）
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
ACCEPT_DATA_LOSS="${ACCEPT_DATA_LOSS:-0}"   # 1=schema push 追加 --accept-data-loss（按需，默认关）

SHA="$(cd "$ROOT" && git rev-parse --short HEAD)"
ARCHIVE="/tmp/junshi-${SHA}.tar.gz"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=accept-new -i "$SSH_KEY")

log(){ printf "\033[1;36m[deploy]\033[0m %s\n" "$*"; }
die(){ printf "\033[1;31m[deploy] %s\033[0m\n" "$*" >&2; exit 1; }

[ -f "$SSH_KEY" ] || die "SSH key 不存在：$SSH_KEY"

if ! ( cd "$ROOT" && git diff --quiet && git diff --cached --quiet ); then
  log "检测到未提交的 tracked 改动；本次仍只部署当前 HEAD=${SHA}。"
fi

log "打包当前 HEAD：${SHA}"
( cd "$ROOT" && git archive --format=tar.gz -o "$ARCHIVE" HEAD )

log "上传 $ARCHIVE -> $DEPLOY_HOST:/tmp/"
scp "${SSH_OPTS[@]}" "$ARCHIVE" "$DEPLOY_HOST:/tmp/"

log "远端构建并发布 server + admin"
ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" \
  "SHA='${SHA}' REMOTE_ROOT='$REMOTE_ROOT' REMOTE_RUNTIME_USER='$REMOTE_RUNTIME_USER' DEPLOY_H5='$DEPLOY_H5' TARO_APP_API='$TARO_APP_API' ACCEPT_DATA_LOSS='$ACCEPT_DATA_LOSS' bash -se" <<'REMOTE'
set -euo pipefail

APP_ROOT="$REMOTE_ROOT"
ARCHIVE="/tmp/junshi-${SHA}.tar.gz"
RELEASE="/tmp/junshi-release-${SHA}"
ENV_BACKUP="/tmp/junshi-server-env-${SHA}"
DEPLOY_USER="$(id -un)"
DEPLOY_GROUP="$(id -gn)"

echo "== prepare release ${SHA} =="
rm -rf "$RELEASE"
mkdir -p "$RELEASE"
tar -xzf "$ARCHIVE" -C "$RELEASE"

if [ -f "$APP_ROOT/server/.env" ]; then
  sudo cp -p "$APP_ROOT/server/.env" "$ENV_BACKUP"
fi

# Replace tracked application paths so deleted files do not linger. Preserve
# server/.env, backups, logos, and other host-owned runtime artifacts.
#
# **deploy/ 不在这个列表里**——它被监控栈 bind mount 着，见下面单独处理。
for path in \
  AGENTS.md PRODUCT.md IMPLEMENTATION.md README.md package.json .gitignore \
  .github admin app chats docs project scripts server shared
do
  sudo rm -rf "$APP_ROOT/$path"
  if [ -e "$RELEASE/$path" ]; then
    sudo cp -R "$RELEASE/$path" "$APP_ROOT/$path"
    sudo chown -R "$DEPLOY_USER:$DEPLOY_GROUP" "$APP_ROOT/$path"
  fi
done

# ── deploy/ 必须**原地同步**，绝不能 rm -rf 后整目录替换 ──
#
# 监控栈把 deploy/monitoring 下的路径 bind mount 进容器：
#   ./prometheus/prometheus.yml -> /etc/prometheus/prometheus.yml   （文件）
#   ./prometheus/alerts         -> /etc/prometheus/alerts           （目录）
#   ./secrets/metrics.token     -> /etc/prometheus/metrics.token    （文件）
#
# bind mount 在**容器启动时**就绑定了 inode。rm -rf 再重建等于换了 inode，容器那边还盯着
# 已删除的旧 inode：
#   · alerts 目录 → 容器里变成**空目录**，Prometheus `groups: []`，**全部告警规则静默失效**
#     （system/api/llm/business 全部，不只是新加的）。/-/reload 也救不回来，因为它读的就是空目录。
#   · metrics.token → 文件 inode 还在（被挂载引用着），运行中照样 up，直到容器/主机重启才炸，
#     且 compose 会在缺失的源路径造出一个同名**目录**，报错形态完全不指向真因。
#
# 2026-08-04 查这两件事时才发现：告警规则其实自监控栈上线后的每次部署都是关着的。
# rsync 原地更新，目录 inode 不变，容器视图立刻跟上；secrets/ 是 gitignore 的运行时凭证，排除。
#
# 排除项 = deploy/monitoring/.gitignore 里的全部条目（那些是主机侧维护的运行时凭证，
# 归档里根本没有，同步过去只会把它们删掉）：
#   · monitoring/.env                 GRAFANA_ADMIN_PASSWORD 等 —— 删了之后**任何 docker compose
#                                     命令都会因变量缺失直接失败**，监控栈从此无法运维（这也是
#                                     上面那个「告警静默」长期没人修得动的原因）；
#   · monitoring/secrets/metrics.token Prometheus 抓 /api/metrics 的凭证。
# 新增 gitignore 条目时**必须同步加到这里**。
sudo rsync -a --delete \
  --exclude 'monitoring/.env' \
  --exclude 'monitoring/secrets/' \
  "$RELEASE/deploy/" "$APP_ROOT/deploy/"
sudo chown -R "$DEPLOY_USER:$DEPLOY_GROUP" "$APP_ROOT/deploy"
# 凭证目录属主/权限由主机侧维护（0600 root，compose 里 prometheus 是 user: root），别被上面 chown 带走。
if [ -f "$APP_ROOT/deploy/monitoring/secrets/metrics.token" ]; then
  sudo chown root:root "$APP_ROOT/deploy/monitoring/secrets/metrics.token"
  sudo chmod 0600 "$APP_ROOT/deploy/monitoring/secrets/metrics.token"
fi

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
# ACCEPT_DATA_LOSS=1 时追加 --accept-data-loss：仅在明知本次为加法迁移（新可空列/新表/新可空唯一索引）
# 时按需启用，让 prisma 越过 data-loss 门；默认关，避免误吞真正的破坏性变更。
DB_PUSH_EXTRA=""
[ "${ACCEPT_DATA_LOSS:-0}" = "1" ] && DB_PUSH_EXTRA="--accept-data-loss"
sudo -u "$REMOTE_RUNTIME_USER" env HOME="/home/$REMOTE_RUNTIME_USER" APP_ROOT="$APP_ROOT" DB_PUSH_EXTRA="$DB_PUSH_EXTRA" bash -c \
  'cd "$APP_ROOT/server" && ./node_modules/.bin/prisma db push --skip-generate $DB_PUSH_EXTRA'

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

printf '%s\n' "${SHA}" | sudo tee "$APP_ROOT/.deploy-version" >/dev/null

echo "== nginx reload =="
sudo nginx -t
sudo systemctl reload nginx

# 告警规则随代码一起同步过来了，让 Prometheus 热加载（规则改动才会生效）。
# 监控栈没起就跳过——它是可选组件，不能因为没装监控就让部署失败。
if sudo docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^monitoring-prometheus-1$'; then
  echo "== prometheus rules reload =="
  # 先 promtool 验一遍：坏规则热加载会被整份拒绝，那等于把全部告警一起关掉。
  # 必须套 sh -c：docker exec 不经 shell，通配符会被原样传给 promtool（"path ... does not exist"）。
  if sudo docker exec monitoring-prometheus-1 sh -c 'promtool check rules /etc/prometheus/alerts/*.yml'; then
    sudo docker exec monitoring-prometheus-1 wget -qO- --post-data='' http://127.0.0.1:9090/-/reload >/dev/null \
      && echo "  已热加载"
    # 对账：规则组数必须 >0。0 组说明挂载点被孤立（见上面 deploy/ 的 rsync 说明），静默失效必须叫出来。
    GROUPS=$(sudo docker exec monitoring-prometheus-1 wget -qO- 'http://127.0.0.1:9090/api/v1/rules' 2>/dev/null \
      | tr ',' '\n' | grep -c '"name"' || true)
    if [ "${GROUPS:-0}" -eq 0 ]; then
      echo "  !! Prometheus 已加载 0 条规则——告警全部静默，请检查 alerts 目录挂载" >&2
    else
      echo "  规则条目数：${GROUPS}"
    fi
  else
    echo "  !! promtool 校验未通过，跳过 reload（保留旧规则，不要让坏规则关掉全部告警）" >&2
  fi
fi

echo "== local smoke =="
curl -fsS http://127.0.0.1/api/health
echo
curl -fsSI http://127.0.0.1/admin/ >/dev/null
if [ "$DEPLOY_H5" = "1" ]; then
  curl -fsSI http://127.0.0.1/ >/dev/null
fi

echo "DEPLOYED ${SHA}"
REMOTE

log "公网验证"
curl -fsS "$PUBLIC_BASE/api/health"
printf "\n"
if [ -n "$PUBLIC_DOMAIN" ]; then
  curl -fsS "$PUBLIC_DOMAIN/api/health"
  printf "\n"
  curl -fsSI "$PUBLIC_DOMAIN/admin/" >/dev/null
else
  curl -fsSI "$PUBLIC_BASE/admin/" >/dev/null
fi

log "完成：${SHA}"
