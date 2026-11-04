// 回归（S1）：公开平台出站统一接身份泄露闸。
// - guardOutbound 语义：block 模式默认 allowIds 为空，裸 8~12 位也拦
// - 五个出站点（B站评论×3 / 小黑盒 post+comment / 空间说说+评论）源码级接闸断言
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const IG = SRC('../src/chat/identity-guard.js')
const DUTY = SRC('../src/bili/duty.js')
const HEY = SRC('../src/heybox/site.js')
const QZ = SRC('../src/features/qzone.js')
const QZS = SRC('../src/features/qzone-social.js')

test('guardOutbound 存在且公开导出', () => {
  assert.match(IG, /export function guardOutbound\(/)
})

test('B 站三个出站点都过 guard', () => {
  // 自动评论 / 自动回复 / 主人点名评论
  assert.match(DUTY, /guard\(comment\.slice\(0, 200\)\)/, '自动评论')
  assert.match(DUTY, /!guard\(reply\)/, '自动回复')
  assert.match(DUTY, /guard\(String\(message\)\.slice\(0, 200\)\)/, '主人点名评论')
  assert.match(DUTY, /import \{ guardOutbound \} from '\.\.\/chat\/identity-guard\.js'/)
})

test('小黑盒 post/comment 都过 guard', () => {
  assert.match(HEY, /guard\(t, '小黑盒评论'\)/)
  assert.match(HEY, /guard\(`\$\{t\}\\n\$\{text\}`, '小黑盒帖子'\)/)
  assert.match(HEY, /import \{ guardOutbound \} from '\.\.\/chat\/identity-guard\.js'/)
})

test('空间说说/评论都过 guard', () => {
  assert.match(QZ, /guardOutbound\(text, \{[^]*?'空间说说'/s)
  assert.match(QZS, /guardOutbound\(String\(content \|\| ''\), \{[^]*?'空间评论'/s)
})

test('拦下后不走 addEvent（失败不能被记成经历）', () => {
  // duty.js 的 comment 函数：guard 不过直接 return，后面的 addEvent 执行不到
  const seg = DUTY.slice(DUTY.indexOf('async function comment(text, message)'))
  const gi = seg.indexOf('if (!guard(')
  const ai = seg.indexOf('memory?.addEvent?', gi)
  const ri = seg.indexOf('return { ok: false', gi)
  assert.ok(gi >= 0 && ri > 0 && ai > ri, 'guard 拦下要先 return，再谈 addEvent')
})
