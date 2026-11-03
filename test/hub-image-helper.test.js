// 辅助看图模型必须真的接到聊天主链路上。
// 之前的坑：hub.js 自己手写「看不了图就塞一句提示」，完全绕过 describeWithHelper，
// 结果面板配了辅助模型也毫无作用。这里守住三条路径都必须走 imageTextFor。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(ROOT, 'src/chat/hub.js'), 'utf8')

test('hub.js 导入了 describeWithHelper（不再自己造轮子）', () => {
  const importLine = src.split('\n').find((x) => x.includes("from '../core/llm.js'")) || ''
  assert.ok(importLine.includes('describeWithHelper'), '必须从 llm.js 导入 describeWithHelper，实际：' + importLine)
})

test('有统一的 imageTextFor，且内部真的调了 describeWithHelper', () => {
  const m = src.match(/async function imageTextFor[\s\S]*?\n  \}/)
  assert.ok(m, '应该有 imageTextFor')
  assert.match(m[0], /describeWithHelper\(/, 'imageTextFor 里必须调用转述')
  assert.match(m[0], /别当成你亲眼见过/, '转述必须带来源标注')
})

test('私聊主链路：看不了图时走 imageTextFor，不再只塞一句干提示', () => {
  // 找到「模型明确不支持看图」那段
  const i = src.indexOf('模型明确不支持看图')
  assert.ok(i > 0, '应保留这段注释')
  const seg = src.slice(i, i + 700)
  assert.match(seg, /imageTextFor\(/, '私聊必须调用 imageTextFor')
})

test('群聊：看不了图时不再直接 return 丢掉图片', () => {
  const i = src.indexOf('async function addGroupImages')
  assert.ok(i > 0)
  const seg = src.slice(i, i + 1200)
  assert.match(seg, /imageTextFor\(/, '群聊也必须转述')
  // 旧写法是 `=== false) return` 直接丢
  assert.doesNotMatch(seg, /canSeeImages\(dsh, getConfig\(\)\)\) === false\) return/)
})

test('群聊提示词会把转述文字带出来（picNote 拼进 line）', () => {
  const m = src.match(/const line = \(x\) =>[^\n]*/)
  assert.ok(m, '应该有 line 函数')
  assert.match(m[0], /picNote/, 'line() 必须拼上 picNote')
})
