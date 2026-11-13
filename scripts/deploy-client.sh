#!/usr/bin/env bash
# 把本仓库的改动部署到 DSH 线上运行目录。
# 该目录属 Harness，普通账号不可写，必须 sudo 执行。
set -euo pipefail
SRC_ROOT="${QQHUB_DEPLOY_SRC:-/path/to/dsh-qq-hub}"
DST_ROOT="${QQHUB_DEPLOY_DST:-/path/to/.dsh/profiles/web/node_modules/dsh-qq-hub}"

FILES=(
  "client/client.js"
  "src/host.js"
  "src/host/http.js"
  "src/host/models.js"
  "src/host/gateway.js"
  "src/host/modular-core.js"
  "src/host/current-hub.js"
  "src/host/shared-outbox.js"
  "src/host/hub-egress.js"
  "src/host/module-send-bridge.js"
  "src/host/effects.js"
  "src/host/panel/overview.js"
  "src/host/panel/routes-config.js"
  "src/host/panel/routes-gateway.js"
  "src/host/panel/routes-persona.js"
  "src/host/panel/routes-purpose.js"
  "src/host/panel/routes-modules.js"
  "src/host/panel/routes-misc.js"
  "src/core/config.js"
  "src/core/fnos-fsync-patch.js"
  "src/core/llm.js"
  "src/core/models.js"
  "src/core/vision-helper.js"
  "src/chat/reply-delivery.js"
  "src/chat/reply.js"
  "src/chat/outbound.js"
  "src/chat/outbound-files.js"
  "src/chat/outbox.js"
  "src/chat/presence.js"
  "src/chat/capture.js"
  "src/chat/system-turns.js"
  "src/chat/turn-controller.js"
  "src/chat/turn-participants.js"
  "src/chat/turn-scheduler.js"
  "src/chat/session-registry.js"
  "src/chat/session-store.js"
  "src/chat/recent-media.js"
  "src/chat/inbound-vision.js"
)

OBSOLETE_FILES=(
  "src/chat/hub.js"
  "src/host/pipeline.js"
  "src/kernel/legacy-fallback.js"
  "src/features/memory-sqlite.js"
  "src/kernel/compose.js"
  "src/kernel/context.js"
  "src/kernel/ctx-store.js"
  "src/kernel/dispatcher.js"
  "src/kernel/mw-acl.js"
  "src/kernel/mw-aggregator.js"
  "src/kernel/mw-command-router.js"
  "src/kernel/mw-dedup.js"
  "src/kernel/mw-egress.js"
  "src/kernel/mw-egress-cutover.js"
  "src/kernel/mw-memory.js"
  "src/kernel/mw-persona.js"
)

[ -d "$DST_ROOT" ] || { echo "找不到目标目录：$DST_ROOT"; exit 1; }
STAMP=$(date +%Y%m%d-%H%M%S)

for f in "${OBSOLETE_FILES[@]}"; do
  if [ -f "$DST_ROOT/$f" ]; then
    mv "$DST_ROOT/$f" "$DST_ROOT/$f.retired-$STAMP"
    echo "已退役旧实现并保留备份 $f"
  fi
done

for f in "${FILES[@]}"; do
  [ -f "$SRC_ROOT/$f" ] || { echo "缺少当前实现文件：$f"; exit 1; }
  mkdir -p "$DST_ROOT/$(dirname "$f")"
  if [ -f "$DST_ROOT/$f" ] && cmp -s "$SRC_ROOT/$f" "$DST_ROOT/$f"; then
    echo "无需变更 $f"
    continue
  fi
  if [ -f "$DST_ROOT/$f" ]; then
    cp -p "$DST_ROOT/$f" "$DST_ROOT/$f.bak-$STAMP"
  fi
  cp "$SRC_ROOT/$f" "$DST_ROOT/$f"
  if [ -f "$DST_ROOT/$f.bak-$STAMP" ]; then
    chown --reference="$DST_ROOT/$f.bak-$STAMP" "$DST_ROOT/$f" 2>/dev/null || true
    chmod --reference="$DST_ROOT/$f.bak-$STAMP" "$DST_ROOT/$f" 2>/dev/null || true
  else
    chown --reference="$DST_ROOT" "$DST_ROOT/$f" 2>/dev/null || true
  fi
  cmp -s "$SRC_ROOT/$f" "$DST_ROOT/$f" || { echo "部署后校验不一致：$f"; exit 1; }
  echo "已部署并校验 $f"
done

echo
echo "当前核心校验："
grep -n 'createCurrentHub' "$DST_ROOT/src/host.js"
grep -n 'createReplyDelivery' "$DST_ROOT/src/host/modular-core.js"
grep -n 'createOutboundFiles' "$DST_ROOT/src/host/modular-core.js"
echo
echo "接下来：重启 DSH，然后浏览器 Ctrl+Shift+R 强制刷新面板。"
