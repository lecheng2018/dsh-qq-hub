#!/usr/bin/env bash
# 把本仓库的 client/client.js 部署到 DSH 线上运行目录。
# 该目录属 Harness，普通账号不可写，必须 sudo 执行。
set -euo pipefail
SRC="/vol2/1000/docker/analysis_repos/dsh-qq-hub/client/client.js"
DST_DIR="/vol2/@appshare/Harness/.dsh/profiles/web/node_modules/dsh-qq-hub/client"
DST="$DST_DIR/client.js"

[ -f "$SRC" ] || { echo "找不到源文件：$SRC"; exit 1; }
[ -d "$DST_DIR" ] || { echo "找不到目标目录：$DST_DIR"; exit 1; }

STAMP=$(date +%Y%m%d-%H%M%S)
cp -p "$DST" "$DST.bak-$STAMP"
echo "已备份 → $DST.bak-$STAMP"

cp "$SRC" "$DST"
chown --reference="$DST.bak-$STAMP" "$DST" 2>/dev/null || true
chmod --reference="$DST.bak-$STAMP" "$DST" 2>/dev/null || true

echo "已部署。校验："
grep -n 'const pm = ' "$DST"
echo
echo "接下来：重启 DSH，然后在浏览器里 Ctrl+Shift+R 强制刷新面板。"
