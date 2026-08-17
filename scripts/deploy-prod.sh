#!/usr/bin/env bash
# 军师 · 生产部署脚本（server + admin，H5 可选）
#
# 默认目标是当前固定 ECS：ecs-user@8.136.36.175，上传当前 git HEAD 的干净归档。
# 远端 /opt/junshi 是上传包式部署，不是 git 仓库；不要在服务器上 git pull。
#
# 用法：
#   bash scripts/deploy-prod.sh
#   DEPLOY_H5=1 bash scripts/deploy-prod.sh
#   DEPLOY_PC=1 bash scripts/deploy-prod.sh      # PC 工作台（/pc/）
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
DEPLOY_PC="${DEPLOY_PC:-0}"
TARO_APP_API="${TARO_APP_API:-https://wxapi.aibuzz.cn/api}"
ACCEPT_DATA_LOSS="${ACCEPT_DATA_LOSS:-0}"   # 1=schema push 追加 --accept-data-loss（按需，默认关）

SHA="$(cd "$ROOT" && git rev-parse --short HEAD)"
ARCHIVE="/tmp/junshi-${SHA}.tar.gz"

# 谁发的、发的什么，都要能事后追溯。制表符/换行会破坏历史行的 TSV 结构，先洗掉。
DEPLOY_OPERATOR="${DEPLOY_OPERATOR:-$( (cd "$ROOT" && git config user.name) 2>/dev/null || id -un)@$(hostname -s)}"
DEPLOY_OPERATOR="$(printf '%s' "$DEPLOY_OPERATOR" | tr -d '\t\n' | tr -s ' ')"

# 本地全量日志：远端 .deploy-history 只记一行结论，出问题要看过程还得靠这个。
# 走「自重入 + 管道」而不是 exec > >(tee ...)：后者父进程会先于 tee 退出，
# 实测末尾几行来不及落盘——而部署失败时最该看的恰恰是末尾。
# 这里父进程等整条管道结束，再用 PIPESTATUS[0] 把子进程真实退出码透出去。
LOG_DIR="$ROOT/.deploy-logs"
mkdir -p "$LOG_DIR"
if [ -z "${DEPLOY_LOG_FILE:-}" ]; then
  export DEPLOY_LOG_FILE="$LOG_DIR/prod-${SHA}-$(date -u +%Y%m%dT%H%M%SZ).log"
  set -o pipefail
  bash "$0" "$@" 2>&1 | tee -a "$DEPLOY_LOG_FILE"
  DEPLOY_STATUS="${PIPESTATUS[0]}"
  printf '\033[1;36m[deploy]\033[0m 全量日志：%s\n' "$DEPLOY_LOG_FILE"
  exit "$DEPLOY_STATUS"
fi

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
  "SHA='${SHA}' REMOTE_ROOT='$REMOTE_ROOT' REMOTE_RUNTIME_USER='$REMOTE_RUNTIME_USER' DEPLOY_H5='$DEPLOY_H5' DEPLOY_PC='$DEPLOY_PC' TARO_APP_API='$TARO_APP_API' ACCEPT_DATA_LOSS='$ACCEPT_DATA_LOSS' DEPLOY_OPERATOR='${DEPLOY_OPERATOR}' bash -se" <<'REMOTE'
set -euo pipefail

APP_ROOT="$REMOTE_ROOT"
ARCHIVE="/tmp/junshi-${SHA}.tar.gz"
RELEASE="/tmp/junshi-release-${SHA}"
ENV_BACKUP="/tmp/junshi-server-env-${SHA}"
DEPLOY_USER="$(id -un)"
DEPLOY_GROUP="$(id -gn)"

file_hash() {
  if sudo test -f "$1"; then
    sudo sha256sum "$1" | awk '{print $1}'
  else
    printf 'missing\n'
  fi
}

directory_hash() {
  if sudo test -d "$1"; then
    sudo find "$1" -type f -exec sha256sum {} \; | sort | sha256sum | awk '{print $1}'
  else
    printf 'missing\n'
  fi
}

# bind mount 文件内容变更后仅 reload 并不总能覆盖组件自身的配置生命周期；先记发布前哈希，
# 同步后按变化精确 force-recreate 对应组件。不存在也记为 missing，首次补配置同样可识别。
PROM_CONFIG="$APP_ROOT/deploy/monitoring/prometheus/prometheus.yml"
ALERT_CONFIG="$APP_ROOT/deploy/monitoring/alertmanager/alertmanager.yml"
GRAFANA_DASHBOARDS="$APP_ROOT/deploy/monitoring/grafana/dashboards"
PROM_CONFIG_BEFORE="$(file_hash "$PROM_CONFIG")"
ALERT_CONFIG_BEFORE="$(file_hash "$ALERT_CONFIG")"
GRAFANA_DASHBOARDS_BEFORE="$(directory_hash "$GRAFANA_DASHBOARDS")"

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
PROM_CONFIG_AFTER="$(file_hash "$PROM_CONFIG")"
ALERT_CONFIG_AFTER="$(file_hash "$ALERT_CONFIG")"
GRAFANA_DASHBOARDS_AFTER="$(directory_hash "$GRAFANA_DASHBOARDS")"

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

# 2026-08-05 产品决策：AI 模型、Embedding、Rerank 凭证明文存库。旧服务本就兼容明文，
# 所以可在重启前原子迁移；若历史密文与 APP_ENCRYPTION_KEY 不匹配，脚本 fail-closed，旧服务继续运行。
echo "== AI credential plaintext migration =="
sudo -u "$REMOTE_RUNTIME_USER" env HOME="/home/$REMOTE_RUNTIME_USER" APP_ROOT="$APP_ROOT" bash -c \
  'cd "$APP_ROOT/server" && npm run secrets:decrypt-ai'

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
  # 微信端迁到原生运行时后，Taro 只构建 H5，产物固定在 dist-h5/。
  # 这里若仍复制旧 dist/，构建本身会成功，但发布在 cp 阶段中断，线上继续吃旧 H5。
  sudo cp -R dist-h5/. /var/www/junshi/h5/
fi

if [ "$DEPLOY_PC" = "1" ]; then
  echo "== pc workbench build and publish =="
  cd "$APP_ROOT/app"
  npm ci
  # PC 是独立的 Vite 应用（零 Taro），产物 dist-pc/，线上挂在 /pc/ 下。
  # 字体不自带：@font-face 指向站点根 /fonts/（由 H5 构建落地），所以首次上线 PC 前必须先发过一次 H5。
  TARO_APP_MODE=server TARO_APP_API="$TARO_APP_API" npm run build:pc:server
  sudo mkdir -p /var/www/junshi/pc
  sudo find /var/www/junshi/pc -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  sudo cp -R dist-pc/. /var/www/junshi/pc/
fi

# 版本切换点：先把被覆盖的旧版本捞出来，否则 .deploy-version 一写就再也查不到「上一版是谁」。
# 生产是 rsync 原地更新、没有 release 目录史，这份 append-only 的 .deploy-history 是唯一可追溯来源。
PREV_VERSION="$(cat "$APP_ROOT/.deploy-version" 2>/dev/null || true)"
printf '%s\n' "${SHA}" | sudo tee "$APP_ROOT/.deploy-version" >/dev/null

DEPLOY_COMPONENTS="server,admin"
[ "${DEPLOY_H5:-0}" = "1" ] && DEPLOY_COMPONENTS="$DEPLOY_COMPONENTS,h5"
[ "${DEPLOY_PC:-0}" = "1" ] && DEPLOY_COMPONENTS="$DEPLOY_COMPONENTS,pc"

# 列：UTC 时间 / 旧版本 / 新版本 / 组件 / 结果 / 操作者。记账失败绝不能连累发布，整段 || true。
record_history() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${PREV_VERSION:--}" "${SHA}" "$DEPLOY_COMPONENTS" "$1" "${DEPLOY_OPERATOR:-unknown}" \
    | sudo tee -a "$APP_ROOT/.deploy-history" >/dev/null || true
}
# 两段式记账：这里先记 switched（线上版本此刻已经变了），冒烟全过之后再补 ok。
# 只在最后记一行的话，中途失败会既改了线上版本又不留任何痕迹——那正是这次要解决的问题。
# 所以一条孤立的 switched 就代表「发布没走完」，比历史里一片 ok 诚实。
record_history switched
echo "== 版本记录 ${PREV_VERSION:--} -> ${SHA}（switched）=="

echo "== nginx reload =="
sudo nginx -t
sudo systemctl reload nginx

# 监控栈未安装/未启动时仍保持可选；只要线上已有对应容器，配置校验、重建、热加载、
# ready 与实际规则数任一步失败都必须让部署失败，不能把“业务发布成功、监控静默”当成功。
PROM_PRESENT=0
ALERT_PRESENT=0
GRAFANA_PRESENT=0
# 用 ps -a：监控容器即使当前 exited 也属于“已安装”，发布必须尝试拉起并验收，不能静默跳过。
sudo docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^monitoring-prometheus-1$' && PROM_PRESENT=1
sudo docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^monitoring-alertmanager-1$' && ALERT_PRESENT=1
sudo docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^monitoring-grafana-1$' && GRAFANA_PRESENT=1

wait_ready() {
  local url="$1"
  local label="$2"
  local i
  for i in $(seq 1 30); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "  ${label} ready"
      return 0
    fi
    sleep 1
  done
  echo "  !! ${label} 30 秒内未 ready" >&2
  return 1
}

if [ "$PROM_PRESENT" = "1" ] || [ "$ALERT_PRESENT" = "1" ] || [ "$GRAFANA_PRESENT" = "1" ]; then
  MONITOR_DIR="$APP_ROOT/deploy/monitoring"
  sudo test -f "$MONITOR_DIR/.env" || { echo "监控栈运行中但 monitoring/.env 缺失" >&2; exit 1; }
  sudo test -f "$MONITOR_DIR/secrets/metrics.token" || { echo "监控栈运行中但 metrics.token 缺失" >&2; exit 1; }
  sudo test ! -d "$MONITOR_DIR/secrets/metrics.token" || { echo "metrics.token 被错误创建成目录" >&2; exit 1; }
  cd "$MONITOR_DIR"
  sudo docker compose config --quiet
fi

if [ "$GRAFANA_PRESENT" = "1" ]; then
  echo "== grafana dashboards verify =="
  HOST_DASHBOARD_COUNT="$(sudo find "$GRAFANA_DASHBOARDS" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')"
  [ "${HOST_DASHBOARD_COUNT:-0}" -gt 0 ] || { echo "Grafana 主机看板目录为空" >&2; exit 1; }

  # rsync 会原地保留目录，但历史部署曾让容器继续盯着已删除的旧目录 inode，表现为主机有 JSON、
  # 容器目录为空、UI 仍展示数据库里的旧看板。内容变化或主机/容器文件数不一致都必须重建。
  CONTAINER_DASHBOARD_COUNT="$(sudo docker exec monitoring-grafana-1 sh -c 'find /var/lib/grafana/dashboards -maxdepth 1 -type f -name "*.json" 2>/dev/null | wc -l' 2>/dev/null || printf '0')"
  if [ "$GRAFANA_DASHBOARDS_BEFORE" != "$GRAFANA_DASHBOARDS_AFTER" ] || [ "$CONTAINER_DASHBOARD_COUNT" != "$HOST_DASHBOARD_COUNT" ]; then
    sudo docker compose up -d --force-recreate grafana
  else
    sudo docker compose up -d grafana
  fi
  wait_ready http://127.0.0.1:3000/api/health Grafana
  CONTAINER_DASHBOARD_COUNT="$(sudo docker exec monitoring-grafana-1 sh -c 'find /var/lib/grafana/dashboards -maxdepth 1 -type f -name "*.json" | wc -l')"
  [ "$CONTAINER_DASHBOARD_COUNT" = "$HOST_DASHBOARD_COUNT" ] || {
    echo "Grafana 容器看板数 ${CONTAINER_DASHBOARD_COUNT} 与主机 ${HOST_DASHBOARD_COUNT} 不一致" >&2
    exit 1
  }
  echo "  已挂载看板：${CONTAINER_DASHBOARD_COUNT} 个"
fi

if [ "$ALERT_PRESENT" = "1" ]; then
  echo "== alertmanager config verify =="
  # 即使 alertmanager.yml 没变，docker-compose.yml 的 user/挂载等配置也可能变；普通 up 会按
  # compose config hash 精确重建。配置文件内容变化则明确 force-recreate，避免旧进程持有旧解析结果。
  if [ "$ALERT_CONFIG_BEFORE" != "$ALERT_CONFIG_AFTER" ]; then
    sudo docker compose up -d --force-recreate alertmanager
  else
    sudo docker compose up -d alertmanager
  fi
  wait_ready http://127.0.0.1:9093/-/ready Alertmanager
  sudo docker exec monitoring-alertmanager-1 amtool check-config /etc/alertmanager/alertmanager.yml
  ALERT_CONFIG_IN_CONTAINER="$(sudo docker exec monitoring-alertmanager-1 sha256sum /etc/alertmanager/alertmanager.yml | awk '{print $1}')"
  [ "$ALERT_CONFIG_IN_CONTAINER" = "$ALERT_CONFIG_AFTER" ] || { echo "Alertmanager 容器配置哈希与主机不一致" >&2; exit 1; }
fi

if [ "$PROM_PRESENT" = "1" ]; then
  echo "== prometheus config and rules verify =="
  if [ "$PROM_CONFIG_BEFORE" != "$PROM_CONFIG_AFTER" ]; then
    sudo docker compose up -d --force-recreate prometheus
  else
    sudo docker compose up -d prometheus
  fi
  wait_ready http://127.0.0.1:9090/-/ready Prometheus
  # 必须套 sh -c：docker exec 不经 shell，通配符会被原样传给 promtool。校验放在 up/ready 后，
  # 这样检查的是刚发布的文件，也能覆盖发布前容器处于 exited 的恢复路径。
  sudo docker exec monitoring-prometheus-1 promtool check config /etc/prometheus/prometheus.yml
  sudo docker exec monitoring-prometheus-1 sh -c 'promtool check rules /etc/prometheus/alerts/*.yml'
  PROM_CONFIG_IN_CONTAINER="$(sudo docker exec monitoring-prometheus-1 sha256sum /etc/prometheus/prometheus.yml | awk '{print $1}')"
  [ "$PROM_CONFIG_IN_CONTAINER" = "$PROM_CONFIG_AFTER" ] || { echo "Prometheus 容器配置哈希与主机不一致" >&2; exit 1; }

  # 规则目录原地同步时不必重建，但 reload 必须成功；随后解析 JSON 精确数 data.groups[].rules，
  # 不能再用 grep 'name'（会把组名/标签/注解一并误计）。
  sudo docker exec monitoring-prometheus-1 wget -qO- --post-data='' http://127.0.0.1:9090/-/reload >/dev/null
  RULES_JSON="$(sudo docker exec monitoring-prometheus-1 wget -qO- http://127.0.0.1:9090/api/v1/rules)"
  RULE_COUNT="$(printf '%s' "$RULES_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(len(g.get("rules", [])) for g in d.get("data", {}).get("groups", [])))')"
  [ "${RULE_COUNT:-0}" -gt 0 ] || { echo "Prometheus 已加载 0 条规则——告警全部静默" >&2; exit 1; }
  echo "  已加载规则：${RULE_COUNT} 条"
fi

echo "== local smoke =="
curl -fsS http://127.0.0.1/api/health
echo
curl -fsSI http://127.0.0.1/admin/ >/dev/null
if [ "$DEPLOY_H5" = "1" ]; then
  curl -fsSI http://127.0.0.1/ >/dev/null
fi
if [ "$DEPLOY_PC" = "1" ]; then
  curl -fsSI http://127.0.0.1/pc/ >/dev/null
fi

# 冒烟全过，补记结果行。有 switched 无 ok = 这次发布中途挂了，事后一眼可辨。
record_history ok

# 智能体配置漂移巡检（只读、只警告、绝不阻断）。
# 上面那句 `prisma db push` 只同步表结构，**不动数据**；而运行时读的是 agent.publishedVersionId
# 指向的 agent_version 快照。所以 systemPrompt / deliverableKey / skillsConfig 改了代码并部署后
# 依然是旧的，且没有任何报错——2026-08-16 海报设计师停在 v2 就是这么漏过去的。
# 放在 record_history ok 之后：巡检结果不参与「本次发布成不成」的判定，只在收尾处提醒人去后台发布。
echo "== agent config drift check (warn only) =="
sudo -u "$REMOTE_RUNTIME_USER" env HOME="/home/$REMOTE_RUNTIME_USER" APP_ROOT="$APP_ROOT" bash -c \
  'cd "$APP_ROOT/server" && npm run --silent agents:check-drift' \
  || echo "⚠ 漂移巡检未跑完（不阻断发布）：登机后手动 cd $APP_ROOT/server && npm run agents:check-drift"

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
