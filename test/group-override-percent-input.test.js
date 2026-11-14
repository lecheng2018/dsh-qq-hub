// 「按群单独设置」的插话概率框：单位是百分数（0~100），敲 1 就是 1%。
// 报障现场：群 249729644 想设 1%，敲完「1」直接变 100 —— 旧 parsePct 把 ≤1 的输入
// 当 0~1 小数（1 = 100%），和框面「% 插话」的百分数语义打架。这里把行为钉死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(ROOT, 'client/client.js'), 'utf8')

function loadParsePct () {
  const m = src.match(/const parsePct = \(t\) => \{[\s\S]*?\n {2}\};/)
  assert.ok(m, 'client.js 里应该还有 parsePct')
  // 去掉 2/4 空格缩进并掐掉末尾分号后整体求值（带分号拼进 return (...) 会 Unexpected token ';'）
  const body = m[0].replace(/\n {4}/g, '\n').replace('const parsePct = ', '').replace(/;$/, '')
  return new Function('return (' + body + ')')()
}

test('敲 1 就是 1%，不再跳成 100（回归）', () => {
  const parsePct = loadParsePct()
  assert.equal(parsePct('1'), 1)
  // 写回配置的小数就是 0.01
  assert.equal(parsePct('1') / 100, 0.01)
})

test('百分数输入按字面解释，越界钳到 0~100', () => {
  const parsePct = loadParsePct()
  assert.equal(parsePct('0'), 0)
  assert.equal(parsePct('40'), 40)
  assert.equal(parsePct('100'), 100)
  assert.equal(parsePct('065'), 65)
  assert.equal(parsePct('150'), 100)
})

test('清空 / 非数字 / 负数都落回 0', () => {
  const parsePct = loadParsePct()
  assert.equal(parsePct(''), 0)
  assert.equal(parsePct('  '), 0)
  assert.equal(parsePct('abc'), 0)
  assert.equal(parsePct('-5'), 0)
})

test('不再把 ≤1 的输入当小数（旧启发式已删）', () => {
  assert.doesNotMatch(src, /n > 1 \? n \/ 100 : n/, 'parsePct 里不该再有「≤1 当小数」分支')
})
