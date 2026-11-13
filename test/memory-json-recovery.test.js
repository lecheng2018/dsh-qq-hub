import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMemoryJsonArray, memoryExtractionMaxTokens } from '../src/features/memory-extractor.js'

test('记忆 JSON：接受代码围栏和数组外说明，不贪婪吞掉尾部括号', () => {
  assert.deepEqual(parseMemoryJsonArray('```json\n[{"text":"事实甲"}]\n```'), [{ text: '事实甲' }])
  assert.deepEqual(parseMemoryJsonArray('说明[注意]\n[{"text":"事实乙"}]\n尾部[解释]'), [{ text: '事实乙' }])
  assert.deepEqual(parseMemoryJsonArray('[{"text":"字段里的 [括号] 和 ] 符号"}] 后续说明]'), [{ text: '字段里的 [括号] 和 ] 符号' }])
})

test('记忆 JSON：截断时不补括号、不返回部分对象', () => {
  assert.throws(() => parseMemoryJsonArray('[{"text":"完整"},{"text":"半截"'), /不合法/)
  assert.throws(() => parseMemoryJsonArray('没有数组'), /有效的记忆 JSON 数组/)
})

test('记忆输出预算随输入增长并设上下限，改答也不低于 3000', () => {
  assert.equal(memoryExtractionMaxTokens('短输入', 0), 3000)
  assert.equal(memoryExtractionMaxTokens('短输入', 1), 3000)
  assert.ok(memoryExtractionMaxTokens('x'.repeat(6000), 0) > 3000)
  assert.equal(memoryExtractionMaxTokens('x'.repeat(100_000), 0), 6000)
})
