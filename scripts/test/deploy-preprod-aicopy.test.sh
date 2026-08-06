#!/usr/bin/env bash
# 手动运行（需本机 Postgres + createdb 权限）：
#   bash scripts/test/deploy-preprod-aicopy.test.sh
#
# 本测试直接从 scripts/deploy-preprod.sh 抽取真实函数体（不是复刻一份逻辑），
# 只把 `sudo -u postgres psql` 换成本地 psql，所以脚本改坏了这里就会红。
# 用完即销毁两个临时库，不碰任何真实数据。
#
# 端到端验证 deploy-preprod.sh 的 AI 配置复制：
#   ① 造出「生产库比预发多一列」的真实漂移场景（正是 2026-07-27 事故的形态）
#   ② 证明旧实现（pg_dump --column-inserts | psql >/dev/null 2>&1）会**谎报成功**
#   ③ 证明新实现能正确复制共有列，且预发新增列由默认值补齐
#   ④ 证明新实现在真正失败时会以非零码退出
set -uo pipefail

SRC=junshi_copytest_src   # 扮演生产
DST=junshi_copytest_dst   # 扮演预发
PASS=0; FAIL=0
ok(){ printf '  \033[32m✔\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
no(){ printf '  \033[31m✖\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }

cleanup(){ dropdb --if-exists "$SRC" 2>/dev/null; dropdb --if-exists "$DST" 2>/dev/null; }
trap cleanup EXIT
cleanup
createdb "$SRC"; createdb "$DST"

# 生产：有 thinkingMode 这一列（当年手工加的，仓库 schema 里没有）
psql -q -d "$SRC" <<'SQL'
CREATE TABLE ai_setting (id text PRIMARY KEY, provider text, "apiKey" text, "thinkingMode" text);
CREATE TABLE ai_model   (id text PRIMARY KEY, label text, "apiKey" text, "thinkingMode" text);
INSERT INTO ai_setting VALUES ('default','claude','enc:setting-key','enabled');
INSERT INTO ai_model   VALUES ('m1','主端点','enc:model-key-1','enabled'),
                              ('m2','备端点','enc:model-key-2','disabled');
SQL

# 预发：没有 thinkingMode，但有生产没有的 poolEnabled（本分支纯加法新增，带默认值）
reset_dst(){
  psql -q -d "$DST" <<'SQL'
DROP TABLE IF EXISTS ai_setting; DROP TABLE IF EXISTS ai_model;
CREATE TABLE ai_setting (id text PRIMARY KEY, provider text, "apiKey" text, "poolEnabled" boolean NOT NULL DEFAULT false);
CREATE TABLE ai_model   (id text PRIMARY KEY, label text, "apiKey" text, "poolEnabled" boolean NOT NULL DEFAULT false);
SQL
}

echo "== ① 旧实现：验证它会谎报成功 =="
reset_dst
if pg_dump --data-only --column-inserts --table=ai_model --table=ai_setting "$SRC" \
     | psql -d "$DST" >/dev/null 2>&1; then
  OLD_SAYS="成功"
else
  OLD_SAYS="失败"
fi
OLD_ROWS="$(psql -Atq -d "$DST" -c 'SELECT count(*) FROM ai_model')"
[ "$OLD_SAYS" = "成功" ] && [ "$OLD_ROWS" = "0" ] \
  && ok "旧实现报告「${OLD_SAYS}」，但实际复制了 ${OLD_ROWS} 行 —— 静默失败已复现" \
  || no "预期旧实现谎报成功且 0 行，实际报告=${OLD_SAYS} 行数=${OLD_ROWS}"

echo "== ② 新实现：共有列精确复制 =="
reset_dst
# 从 deploy-preprod.sh 抽出真实函数体（不是复刻），只把 sudo -u postgres psql 换成本地 psql
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
awk "/<<'REMOTE'/{f=1;next} /^REMOTE\$/{f=0} f" "$REPO/scripts/deploy-preprod.sh" \
  | awk '/^cols_of\(\)/{f=1} f' \
  | awk '/^copy_ai_table ai_setting/{exit} {print}' \
  | sed 's/sudo -u postgres psql/psql/g' > "$ROOT/_fns.sh"
grep -q 'comm -12' "$ROOT/_fns.sh" || { echo "!! 没抽到函数体，测试无效"; exit 1; }
PREPROD_DB="$DST"
PROD_DB="$SRC"   # 脚本已把生产库名参数化，测试直接指向 SRC
# shellcheck disable=SC1090
source "$ROOT/_fns.sh"

if copy_ai_table ai_setting && copy_ai_table ai_model; then ok "复制返回 0"; else no "复制返回非 0"; fi

N_SET="$(psql -Atq -d "$DST" -c 'SELECT count(*) FROM ai_setting')"
N_MOD="$(psql -Atq -d "$DST" -c 'SELECT count(*) FROM ai_model')"
N_KEY="$(psql -Atq -d "$DST" -c "SELECT count(*) FROM ai_model WHERE coalesce(\"apiKey\",'') <> ''")"
[ "$N_SET" = "1" ] && ok "ai_setting 复制到 1 行" || no "ai_setting 期望 1 行，实际 $N_SET"
[ "$N_MOD" = "2" ] && ok "ai_model 复制到 2 行" || no "ai_model 期望 2 行，实际 $N_MOD"
[ "$N_KEY" = "2" ] && ok "两个端点的 apiKey 都带过来了" || no "带 key 的端点期望 2，实际 $N_KEY"

DEF="$(psql -Atq -d "$DST" -c 'SELECT DISTINCT "poolEnabled" FROM ai_model')"
[ "$DEF" = "f" ] && ok "预发新增列 poolEnabled 由默认值补齐（f）" || no "poolEnabled 期望 f，实际 $DEF"

echo "== ③ 新实现：真失败时必须非零退出 =="
psql -q -d "$DST" -c 'DROP TABLE ai_model' >/dev/null 2>&1
if copy_ai_table ai_model 2>/dev/null; then no "目标表不存在时仍返回 0"; else ok "目标表不存在 → 返回非 0"; fi

echo
printf '通过 %d · 失败 %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
