// 回归：压缩失败要说清「为什么」。
//
// 2026-11-04 主人点「现在压一次」看到「这次没压成（没有聊天流水或请求失败，看日志）」，
// 但日志里真正的原因是模型 429 限流。笼统的提示让他以为是功能坏了。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = readFileSync(join(ROOT, 'src/modules/token-guardian/index.js'), 'utf8')

test('compact 返回结构而不是 boolean（要能带 reason）', () => {
  assert.match(SRC, /return \{ ok: false, reason: 'no-transcript'/, '没流水要单独说')
  assert.match(SRC, /return \{ ok: false, reason: 'rate-limited'/, '限流要单独说')
  assert.match(SRC, /return \{ ok: false, reason: 'ask-failed'/, '其他调用失败要单独说')
  assert.match(SRC, /return \{ ok: false, reason: 'empty-summary'/, '空摘要要单独说')
  assert.match(SRC, /return \{ ok: true, chars:/, '成功也要结构化')
})

test('429 / 限流要被识别出来，给出可操作建议', () => {
  assert.match(SRC, /429\|rate\.?limit\|频率限制\|quota\|限额/, '要能认限流的各种说法')
  assert.match(SRC, /额度用完/, '要明确说是额度问题，不是功能坏了')
})

test('自动压缩失败不刷 warn（每 30 秒一次会很吵）', () => {
  assert.match(SRC, /if \(!r\.ok && r\.reason !== 'no-transcript'\) api\.log\.debug/, '自动路径降成 debug')
})

test('路由把 reason / message 透给面板', () => {
  assert.match(SRC, /reason: r\.reason, message: r\.message/, '面板要能显示具体原因')
})
