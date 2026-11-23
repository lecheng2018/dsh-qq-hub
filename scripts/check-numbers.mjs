#!/usr/bin/env node
// 上传前的「裸号码」门禁：QQ 号 / 群号这类 8–12 位数字。
//
// 为什么单独有这一道（2026-11-23 事故）：pii-guard 的 `qq-number` 规则**要求上下文关键词**
// （`QQ：`、`群号：` 之类）。于是这些写法它一律放过：
//     "chatId": "group:<群号>"      // 没有「群号」字样
//     真机：<群号> 就是空值行        // 同上
//     测试 fixture: 'private:<主人QQ>'
// 结果真实群号/主人 QQ 直接进了 public 仓库。这里不看关键词，只看形状：
//
//   ① 8–12 位连续数字（QQ 号 5–11 位、群号 6–12 位，长度取交集的高发段）；
//   ② 排除 YYYYMMDD（20261123 这类日期在本仓库遍地都是）；
//   ③ 排除全同数字（999999999）与纯 0；
//   ④ 排除紧邻字母/下划线的（`eca52fe2`、`v2_<群号>` 这种是标识符不是号码）。
//
// 确属假数据（测试 fixture、示例配置）的行，用行内标记 `pii-scan:ignore` 显式豁免 ——
// 豁免是有痕迹的，比默默放过强。
//
// 用法：
//   node scripts/check-numbers.mjs --range origin/main..HEAD   # 只看新增行（pre-push 用）
//   node scripts/check-numbers.mjs --range A..B --json
//   node scripts/check-numbers.mjs --file /tmp/pr-body.md      # 整份文件（PR 正文/文档）
//   node scripts/check-numbers.mjs --file a.md --file b.txt
//
// 退出码：0 干净；1 有发现；2 用法/运行错误。

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const DEFAULT_MIN = 8
const DEFAULT_MAX = 12
const IGNORE = /pii-scan:\s*ignore/i

const args = process.argv.slice(2)
const ranges = []
const files = []
let json = false
let min = DEFAULT_MIN
let max = DEFAULT_MAX
for (let i = 0; i < args.length; i += 1) {
  const a = args[i]
  if (a === '--range') ranges.push(String(args[++i] || ''))
  else if (a === '--file') files.push(String(args[++i] || ''))
  else if (a === '--json') json = true
  else if (a === '--min') min = Number(args[++i]) || DEFAULT_MIN
  else if (a === '--max') max = Number(args[++i]) || DEFAULT_MAX
  else if (a === '-h' || a === '--help') { console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 30).join('\n')); process.exit(0) }
  else { console.error(`未知参数：${a}`); process.exit(2) }
}
if (!ranges.length && !files.length) {
  console.error('用法：node scripts/check-numbers.mjs --range <A..B> | --file <path> [--json]')
  process.exit(2)
}

/** YYYYMMDD（1900–2099）当日期放过：本仓库的版本号/真机日期全是这个形状。 */
const asDate = (s) => /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(s)
const degenerate = (s) => /^0+$/.test(s) || /^(\d)\1+$/.test(s)

/** 一行里找出可疑号码，返回 [{ value, index }]（value 原样，输出时打码）。 */
function suspects(line) {
  if (IGNORE.test(line)) return []
  const out = []
  const re = new RegExp(`(?<![0-9A-Za-z_])[0-9]{${min},${max}}(?![0-9A-Za-z_])`, 'g')
  let m
  while ((m = re.exec(line)) !== null) {
    const v = m[0]
    if (asDate(v) || degenerate(v)) continue
    out.push({ value: v, index: m.index })
  }
  return out
}

const mask = (v) => (v.length <= 4 ? '*'.repeat(v.length) : `${v.slice(0, 2)}${'*'.repeat(Math.max(1, v.length - 4))}${v.slice(-2)}`)

/** 片段里也不能出现原号码：输出会进终端、CI 日志、issue 评论，那同样是外泄。 */
const maskIn = (text) => String(text ?? '').replace(new RegExp(`(?<![0-9A-Za-z_])[0-9]{${min},${max}}(?![0-9A-Za-z_])`, 'g'), (v) => (asDate(v) || degenerate(v) ? v : mask(v)))

const findings = []
function scanText(label, text) {
  const lines = String(text ?? '').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    for (const s of suspects(line)) {
      findings.push({ where: `${label}:${i + 1}`, masked: mask(s.value), len: s.value.length, snippet: maskIn(line.trim()).slice(0, 120) })
    }
  }
}

for (const f of files) {
  if (!existsSync(f)) { console.error(`文件不存在：${f}`); process.exit(2) }
  scanText(f, readFileSync(f, 'utf8'))
}

for (const range of ranges) {
  if (!range) { console.error('--range 缺少参数（形如 origin/main..HEAD）'); process.exit(2) }
  let diff = ''
  try {
    // -U0：只要新增行；--no-color 避免 ANSI 混进行号
    diff = execFileSync('git', ['diff', '--no-color', '-U0', range], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    console.error(`git diff ${range} 失败：${error?.message || error}`)
    process.exit(2)
  }
  let file = ''
  let lineNo = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ b/')) { file = raw.slice(6); continue }
    if (raw.startsWith('+++ ')) { file = raw.slice(4); continue }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) { lineNo = Number(hunk[1]) - 1; continue }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      lineNo += 1
      if (!file) continue
      for (const s of suspects(raw.slice(1))) {
        findings.push({ where: `${file}:${lineNo}`, masked: mask(s.value), len: s.value.length, snippet: maskIn(raw.slice(1).trim()).slice(0, 120) })
      }
      continue
    }
    if (!raw.startsWith('-') && !raw.startsWith('\\')) lineNo += 1
  }
}

if (json) {
  console.log(JSON.stringify({ findings }, null, 2))
} else {
  console.log(`裸号码检查 — 范围: ${[...ranges, ...files].join(', ')}；规则 ${min}–${max} 位（排除日期/全同/标识符）`)
  if (!findings.length) console.log('结果: 没发现 QQ 号 / 群号形状的数字 ✓')
  else {
    for (const f of findings) console.log(`  [可疑] ${f.where}  ${f.masked}（${f.len} 位）  ${f.snippet}`)
  }
}
process.exit(findings.length ? 1 : 0)
