#!/usr/bin/env bash
# 整包部署：npm pack → staging 装依赖 → 校验 → 原子切换目标目录。
#
# 为什么取代 deploy-client.sh（审计 Q21，2026-11-21 实测）：
#   手工 FILES 清单已严重漂移——host.js 直接 import 的 45 个文件里 24 个不在清单上
#   （含 core/modules.js、core/store.js、security/danger.js 这类缺了就起不来的核心）。
#   逐个补文件治标不治本：每次重构 host.js 都会再漂。整包从 npm pack 出，
#   清单自动与 package.json 对齐，不存在漂移问题。
#
# 用法：
#   QQHUB_DEPLOY_SRC=/path/to/dsh-qq-hub \
#   QQHUB_DEPLOY_DST=/path/to/profiles/web/node_modules/dsh-qq-hub \
#   scripts/deploy-package.sh
#
# 步骤：
#   1. npm pack 出 tgz（含 prepack 自动重建 client 产物）
#   2. 解包到 staging，npm ci --omit=dev 装生产依赖
#   3. 校验：node --check 关键入口 + package.json 版本一致 + 依赖装齐
#   4. 原子切换：目标目录改名留备份 → staging 改名上位；失败自动回滚
#
# 切换后需要重启 DSH 让插件重新加载。回滚：用打印出的备份目录整体改回即可。
set -euo pipefail

SRC_ROOT="${QQHUB_DEPLOY_SRC:?要设 QQHUB_DEPLOY_SRC（源仓库目录）}"
DST_ROOT="${QQHUB_DEPLOY_DST:?要设 QQHUB_DEPLOY_DST（目标插件目录，如 .dsh/profiles/web/node_modules/dsh-qq-hub）}"

[ -d "$SRC_ROOT" ] || { echo "源仓库不存在：$SRC_ROOT" >&2; exit 1; }
[ -d "$(dirname "$DST_ROOT")" ] || { echo "目标父目录不存在：$(dirname "$DST_ROOT")" >&2; exit 1; }

STAMP=$(date +%Y%m%d-%H%M%S)
DST_PARENT=$(dirname "$DST_ROOT")
# 优先在目标父目录建临时工作区以确保处于同一文件系统（真正的原子 rename 切换）；
# 若父目录不可写则回退到 TMPDIR
WORK=$(mktemp -d "$DST_PARENT/.qqhub-deploy-$STAMP-XXXXXX" 2>/dev/null || mktemp -d "${TMPDIR:-/tmp}/qqhub-deploy-$STAMP-XXXXXX")
trap 'rm -rf "$WORK"' EXIT
echo "== 工作目录：$WORK"

# ---- 1) npm pack（prepack 会先重建 client 产物）----
echo "== npm pack…"
( cd "$SRC_ROOT" && npm pack --pack-destination "$WORK" >/dev/null )
TGZ=$(ls "$WORK"/*.tgz | head -n 1)
echo "   $(basename "$TGZ")"

# ---- 2) 解包 + 装生产依赖 ----
echo "== 解包并安装生产依赖…"
mkdir -p "$WORK/staging"
tar -xzf "$TGZ" -C "$WORK/staging" --strip-components=1
# npm pack 的 tgz 不含 package-lock.json（files 白名单排除），npm ci 没有 lock 会
# 直接 EUSAGE。lock 从源仓库带过来——依赖版本必须与源测试环境一致，而不是
# 现场解析最新版。
cp "$SRC_ROOT/package-lock.json" "$WORK/staging/package-lock.json"
( cd "$WORK/staging" && npm ci --omit=dev --no-audit --no-fund --prefer-offline >/dev/null 2>&1 )

# ---- 3) 校验 ----
echo "== 校验…"
# 路径必须走 argv，绝不能拼进 -p 的脚本正文：目录名里一个单引号就能把整条命令改写成
# 任意 JS（`/tmp/a');require('child_process').execSync('...');//`）。
SRC_VERSION=$(node -p 'require(process.argv[1]).version' "$SRC_ROOT/package.json")
STG_VERSION=$(node -p 'require(process.argv[1]).version' "$WORK/staging/package.json")
[ "$SRC_VERSION" = "$STG_VERSION" ] || { echo "版本不一致：源 $SRC_VERSION / 包 $STG_VERSION" >&2; exit 1; }
echo "   版本 $STG_VERSION ✔"

# JS 入口按语法检查；package.json 按 JSON 可解析校验（--check 是 JS 解析器，
# 对 JSON 会报 Unexpected token——首次实测踩到的）。
for entry in src/host.js src/host/modular-core.js src/core/modules.js; do
  [ -f "$WORK/staging/$entry" ] || { echo "包内缺关键文件：$entry" >&2; exit 1; }
  node --check "$WORK/staging/$entry" || { echo "语法检查失败：$entry" >&2; exit 1; }
done
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$WORK/staging/package.json" \
  || { echo "package.json 不是合法 JSON" >&2; exit 1; }
echo "   关键入口语法 + package.json ✔"

# 目标里已装过的依赖在 staging 也要有（防 package.json 改了依赖名而 lock 没跟上）
if [ -d "$DST_ROOT/node_modules" ] && [ -d "$WORK/staging/node_modules" ]; then
  # head 提前关管道会让 comm 吃到 SIGPIPE；pipefail 下整条脚本会「莫名其妙」退出
  missing=$(comm -13 <(ls "$WORK/staging/node_modules" | sort) <(ls "$DST_ROOT/node_modules" | sort) | head -3 || true)
  [ -z "$missing" ] || echo "   提示：目标目录有而新包没有的依赖（新包依赖变少了，属正常）：$missing"
fi

# ---- 4) 原子切换 ----
BACKUP="$DST_ROOT.bak-$STAMP"
echo "== 原子切换（备份：$BACKUP）…"
if [ -d "$DST_ROOT" ]; then
  mv "$DST_ROOT" "$BACKUP"
fi
if mv "$WORK/staging" "$DST_ROOT"; then
  # 保持原有属主：以 root 部署时 rename 出来的目录属主会变成 root，
  # 之后普通用户跑 DSH 写不了自己的数据目录（备份目录里留着原始属主，照着改）
  if [ -d "$BACKUP" ] && [ "$(id -u)" = "0" ]; then
    chown -R --reference="$BACKUP" "$DST_ROOT" || echo "   提示：恢复属主失败（$DST_ROOT）" >&2
  fi
  echo "== 完成：$DST_ROOT → $STG_VERSION"
  echo "   重启 DSH 生效；回滚：rm -rf '$DST_ROOT' && mv '$BACKUP' '$DST_ROOT'"
else
  [ -d "$BACKUP" ] && mv "$BACKUP" "$DST_ROOT"
  echo "切换失败，已回滚。" >&2
  exit 1
fi