#!/usr/bin/env bash
# 全量单测：一个一个文件跑，避开单进程内存上限；TAP 汇总后**如实退出**。
#
# 审计 Q07 修的三件事：
#   1. 清单过去是手写的，包含早就删掉的 title-filter / voice-rvc 等文件，
#      又漏掉了大量现存测试 —— 一个「全量」脚本跑不到一半的用例；
#   2. 没有创建结果目录，首次运行直接写失败；
#   3. 从不看 `node --test` 的退出码，最后无条件 echo DONE，永远「成功」。
# 现在按实际文件动态列举，并且只要有失败就非零退出。
#
# 用法：
#   QQHUB_REPO=/path/to/dsh-qq-hub scripts/run-full-tests.sh
#   不加 QQHUB_REPO 时按脚本自身位置推断仓库根。
set -uo pipefail

REPO="${QQHUB_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$REPO" || { echo "找不到仓库：$REPO" >&2; exit 1; }

OUT_DIR="${QQHUB_TEST_RESULTS_DIR:-/tmp/tmptest}"
mkdir -p "$OUT_DIR" || { echo "建不了结果目录：$OUT_DIR" >&2; exit 1; }
RESULT_FILE="$OUT_DIR/qq-hub-test-results.txt"
: > "$RESULT_FILE"

export TMPDIR="${TMPDIR:-/tmp}"
unset DSH_QQ_HUB_DATA_DIR DSH_HOME AURABOT_DATA_DIR

NODE_BIN="${NODE_BIN:-node}"
total=0
failed_files=0
sum_pass=0
sum_fail=0
sum_skip=0

# 动态列举：不再维护手工清单（手工清单必然漂移）
shopt -s nullglob
FILES=(test/*.test.js)
shopt -u nullglob
if [ ${#FILES[@]} -eq 0 ]; then
  echo "没找到任何测试文件（test/*.test.js）" >&2
  exit 1
fi

for t in "${FILES[@]}"; do
  total=$((total + 1))
  out="$("$NODE_BIN" --test "$t" 2>&1)"
  code=$?
  # Node 的汇总行两种格式都见过：# pass N（TAP）与 ℹ pass N（新版 spec reporter）。
  # 两种都认，免得换个 Node 版本就静默数成 0。
  p=$(printf '%s\n' "$out" | sed -n -e 's/^# pass \([0-9]*\).*/\1/p' -e 's/^ℹ pass \([0-9]*\).*/\1/p' | tail -1)
  f=$(printf '%s\n' "$out" | sed -n -e 's/^# fail \([0-9]*\).*/\1/p' -e 's/^ℹ fail \([0-9]*\).*/\1/p' | tail -1)
  s=$(printf '%s\n' "$out" | sed -n -e 's/^# skipped \([0-9]*\).*/\1/p' -e 's/^ℹ skipped \([0-9]*\).*/\1/p' | tail -1)
  p=${p:-0}; f=${f:-0}; s=${s:-0}
  sum_pass=$((sum_pass + p))
  sum_fail=$((sum_fail + f))
  sum_skip=$((sum_skip + s))

  status=ok
  # 退出码非零 或 fail>0 都算失败：只看数字会漏掉「进程崩了但没打印 TAP」这种
  if [ "$code" -ne 0 ] || [ "$f" -ne 0 ]; then
    status=FAIL
    failed_files=$((failed_files + 1))
    echo "✖ $t（exit=$code pass=$p fail=$f）"
    # 失败时把该文件的输出留档，便于事后看，不刷屏
    printf '%s\n' "$out" > "$OUT_DIR/$(basename "$t").log"
  fi
  printf '%s\tpass=%s\tfail=%s\tskip=%s\texit=%s\t%s\n' "$t" "$p" "$f" "$s" "$code" "$status" >> "$RESULT_FILE"
done

echo
echo "汇总：文件 $total 个，失败文件 $failed_files 个；用例 pass=$sum_pass fail=$sum_fail skip=$sum_skip"
echo "明细：$RESULT_FILE"

if [ "$failed_files" -ne 0 ]; then
  echo "FAILED" >&2
  exit 1
fi
echo "OK"