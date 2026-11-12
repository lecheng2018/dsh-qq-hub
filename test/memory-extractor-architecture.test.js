import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('模型提炼独立成 extractor，档案提交仍由 memory 主库执行', () => {
  const extractor = source('src/features/memory-extractor.js')
  const memory = source('src/features/memory.js')
  assert.doesNotMatch(extractor, /memory-files|memory-markdown|core\/store|dataDir/)
  assert.match(memory, /createMemoryExtractor\(\{[\s\S]*?commit: commitExtracted/)
  assert.match(memory, /function extractFacts\(chatId, transcript, genSignal = null\) \{\s*return extractor\.extractFacts/)
  assert.match(memory, /function extractLines\(chatId, lines, genSignal = null\) \{\s*return extractor\.extractLines/)
  assert.match(extractor, /async function extractLines\(chatId, lines, genSignal = null\)/)
  assert.match(memory, /function consolidate\(o = \{\}\) \{\s*return extractor\.consolidate/)
  assert.match(extractor, /async function consolidate\(o = \{\}\)/)
})
