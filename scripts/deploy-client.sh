#!/usr/bin/env bash
# 把本仓库的改动部署到 DSH 线上运行目录。
# 该目录属 Harness，普通账号不可写，必须 sudo 执行。
set -euo pipefail
SRC_ROOT="/vol2/1000/docker/analysis_repos/dsh-qq-hub"
DST_ROOT="/vol2/@appshare/Harness/.dsh/profiles/web/node_modules/dsh-qq-hub"

# 只同步真正会变、且改过的文件；不动 node_modules / 用户数据
FILES=(
  "client/client.js"
  "src/host.js"
  "src/core/config.js"
  "src/core/llm.js"
  "src/core/models.js"
  "src/core/vision-helper.js"
  "src/chat/hub.js"
)

[ -d "$DST_ROOT" ] || { echo "找不到目标目录：$DST_ROOT"; exit 1; }

STAMP=$(date +%Y%m%d-%H%M%S)
for f in "${FILES[@]}"; do
  [ -f "$SRC_ROOT/$f" ] || { echo "跳过（源不存在）：$f"; continue; }
  mkdir -p "$DST_ROOT/$(dirname "$f")"
  # 已经一致就不备份、不覆盖，避免重复跑脚本留下一堆相同的 bak 文件。
  if [ -f "$DST_ROOT/$f" ] && cmp -s "$SRC_ROOT/$f" "$DST_ROOT/$f"; then
    echo "无需变更 $f"
    continue
  fi
  if [ -f "$DST_ROOT/$f" ]; then
    cp -p "$DST_ROOT/$f" "$DST_ROOT/$f.bak-$STAMP"
  fi
  cp "$SRC_ROOT/$f" "$DST_ROOT/$f"
  # 保持原来的属主/权限，避免 Harness 读不了
  if [ -f "$DST_ROOT/$f.bak-$STAMP" ]; then
    chown --reference="$DST_ROOT/$f.bak-$STAMP" "$DST_ROOT/$f" 2>/dev/null || true
    chmod --reference="$DST_ROOT/$f.bak-$STAMP" "$DST_ROOT/$f" 2>/dev/null || true
  else
    chown Harness:Harness "$DST_ROOT/$f" 2>/dev/null || true
  fi
  cmp -s "$SRC_ROOT/$f" "$DST_ROOT/$f" || { echo "部署后校验不一致：$f"; exit 1; }
  echo "已部署并校验 $f"
done

echo
echo "校验："
grep -n 'const pm = '        "$DST_ROOT/client/client.js" || true
grep -n 'onClick: () => setDraft((prev) =>' "$DST_ROOT/client/client.js" || true
grep -n 'next.persona.groups' "$DST_ROOT/src/core/config.js" || true
grep -n 'dedupeModelList'    "$DST_ROOT/src/host.js"      || true
grep -n '改用原始 base64'     "$DST_ROOT/src/core/llm.js"  || true
grep -n '保留原始 base64'     "$DST_ROOT/src/chat/hub.js"  || true
echo
echo "接下来：重启 DSH，然后浏览器 Ctrl+Shift+R 强制刷新面板。"
