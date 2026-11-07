// effort 被拒时的自动重试（MiniMax requires adaptive thinking 这类措辞）
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('isUnsupportedEffort 认得 MiniMax 的「requires adaptive thinking」措辞', () => {
  const src = readFileSync(new URL('../src/core/llm.js', import.meta.url), 'utf8')
  assert.match(src, /requires adaptive thinking/, '匹配 adaptive thinking')
  assert.match(src, /reasoning\\\.effort|reasoning\.effort/, '匹配 reasoning.effort=none')
  // 原有措辞仍认
  assert.match(src, /UNSUPPORTED_REASONING_EFFORT/)
  assert.match(src, /does not support reasoning effort/)
})

test('askModel：effort 被拒时重试一次且不再带 effort（去掉思考参数）', () => {
  const src = readFileSync(new URL('../src/core/llm.js', import.meta.url), 'utf8')
  assert.match(src, /attempt === 0 && effort && isUnsupportedEffort\(error\)/, '有重试分支')
  assert.match(src, /effort = undefined[\s\S]{0,60}continue/, '重试时清掉 effort')
})
