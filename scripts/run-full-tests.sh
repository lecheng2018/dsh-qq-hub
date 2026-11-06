#!/usr/bin/env bash
# 全量单测：一个一个文件跑，避免 256MiB 内存上限；TAP 汇总打印，不做视觉校验
cd /home/user/repos/dsh-qq-hub || exit 1
export TMPDIR=/tmp/tmptest HOME=/tmphome
unset DSH_QQ_HUB_DATA_DIR DSH_HOME AURABOT_DATA_DIR
: > /tmp/tmptest/qq-hub-test-results.txt
for t in approvals.test.js backfill.test.js bili-avatar-source.test.js bili-media.test.js bili.test.js chat-model.test.js codex-auth-lifecycle.test.js codex-image.test.js commands.test.js contacts.test.js danger-guard.test.js diary-image.test.js douyin-media.test.js douyin.test.js e2e.test.js faces.test.js features.test.js file-segment.test.js fnos-fsync-patch.test.js gateway-resilience.test.js hub-image-helper.test.js imagegen-blocks.test.js imagegen-shape.test.js imagegen.test.js integration-carrier.test.js issue34-setup.test.js known-chats.test.js llm.test.js local.test.js media-cleanup.test.js memory-privacy-scope.test.js memory-scope.test.js memory.test.js mentions.test.js mime-sniff.test.js models-dedupe.test.js module-data-isolation.test.js modules.test.js multi-parser.test.js onebot-login-buffer.test.js paintings.test.js panel-behavior.test.js panel-hasui.test.js panel-persona-render.test.js panel-purpose-settings.test.js panel-purpose-single.test.js panel-purpose.test.js panel-visibility.test.js persona-map.test.js persona-merge.test.js persona-row-input.test.js pet-behavior-client.test.js pet-behavior.test.js pet.test.js port-dsh-qq.test.js profile-scope.test.js profile.test.js pure.test.js purpose.test.js questions.test.js qzone-audience.test.js qzone.test.js recent-media.test.js scheduler.test.js scope-migration-script.test.js security-lock-enforce.test.js shots.test.js snowluma.test.js song.test.js speakup.test.js sticker-owner.test.js sticker-pick.test.js stickers.test.js title-filter.test.js token-guardian-robust.test.js vision-capability.test.js vision-helper.test.js vision.test.js voice-rvc.test.js; do
  out=$(/home/user/.nvm/versions/node/v20.20.2/bin/node --test "test/$t" 2>&1)
  p=$(printf '%s\n' "$out" | sed -n 's/^# pass \([0-9]*\).*/\1/p')
  f=$(printf '%s\n' "$out" | sed -n 's/^# fail \([0-9]*\).*/\1/p')
  s=$(printf '%s\n' "$out" | sed -n 's/^# skipped \([0-9]*\).*/\1/p')
  printf '%s pass=%s fail=%s skip=%s\n' "$t" "${p:-?}" "${f:-?}" "${s:-0}" >> /tmp/tmptest/qq-hub-test-results.txt
done
echo DONE
