// 回归（S1）：公开平台出站统一接身份泄露闸。
// - guardOutbound 语义：block 模式默认 allowIds 为空，裸 8~12 位也拦
// - 出站点源码级接闸断言（B站与小黑盒已随实现搬到商店模块，见各自的测试文件）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const IG = SRC('../src/chat/identity-guard.js')
const QZ = SRC('../src/features/qzone.js')
const QZS = SRC('../src/features/qzone-social.js')

test('guardOutbound 存在且公开导出', () => {
  assert.match(IG, /export function guardOutbound\(/)
})

// B 站与小黑盒出站点的接闸断言跟着实现搬到了商店模块（modules/bili/duty.mjs 与 modules/heybox/lib/site.mjs），
// 在 dsh-qq-hub-mods 的测试里用行为级用例锁住：
// 注入的 guardOutbound 返回 false 时不发评论/发帖。

test('空间说说/评论都过 guard', () => {
  assert.match(QZ, /guardOutbound\(text, \{[^]*?'空间说说'/s)
  assert.match(QZS, /guardOutbound\(String\(content \|\| ''\), \{[^]*?'空间评论'/s)
})

