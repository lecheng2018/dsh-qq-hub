// 回归（S1）：公开平台出站统一接身份泄露闸。
// - guardOutbound 语义：block 模式默认 allowIds 为空，裸 8~12 位也拦
// - 出站点源码级接闸断言（B站已随实现搬到商店模块，见该模块的 duty.test.mjs）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const IG = SRC('../src/chat/identity-guard.js')
const HEY = SRC('../src/heybox/site.js')
const QZ = SRC('../src/features/qzone.js')
const QZS = SRC('../src/features/qzone-social.js')

test('guardOutbound 存在且公开导出', () => {
  assert.match(IG, /export function guardOutbound\(/)
})

// B 站三个出站点的接闸断言跟着实现搬到了商店模块（modules/bili/duty.mjs），
// 在 dsh-qq-hub-mods 的 modules/bili/duty.test.mjs 里用行为级用例锁住：
// 注入的 guardOutbound 返回 false 时不发评论 / 不计数 / 不记记忆。

test('小黑盒 post/comment 都过 guard', () => {
  assert.match(HEY, /guard\(t, '小黑盒评论'\)/)
  assert.match(HEY, /guard\(`\$\{t\}\\n\$\{text\}`, '小黑盒帖子'\)/)
  assert.match(HEY, /import \{ guardOutbound \} from '\.\.\/chat\/identity-guard\.js'/)
})

test('空间说说/评论都过 guard', () => {
  assert.match(QZ, /guardOutbound\(text, \{[^]*?'空间说说'/s)
  assert.match(QZS, /guardOutbound\(String\(content \|\| ''\), \{[^]*?'空间评论'/s)
})

