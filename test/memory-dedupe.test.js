// 回归（P1-3）：Jaccard≥0.6 误并语义相反的事实。
// 「小雨养了一只猫叫团子」vs「…狗…」相似度 0.64，旧逻辑合并成一条，把事实改错。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let contradicts, similarity, createMemoryStore

before(async () => {
  // 隔离数据目录，别污染真实 memories.json
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-dedupe-'))
  ;({ contradicts, similarity, createMemoryStore } = await import('../src/features/memory.js'))
})

function fakeStore() {
  return createMemoryStore({
    dsh: {}, getConfig: () => ({ ownerQQ: '10000001' }), hub: {}, log: console, personaText: () => '',
  })
}

test('猫/狗、喜欢/不喜欢 两组样本不被误并', () => {
  assert.ok(similarity('小雨养了一只猫叫团子', '小雨养了一只狗叫团子') >= 0.6, '确实高相似（前提成立）')
  assert.equal(contradicts('小雨养了一只猫叫团子', '小雨养了一只狗叫团子'), true, '反义词对命中 → 算矛盾，不合并')
  assert.equal(contradicts('阿强喜欢钓鱼', '阿强不喜欢钓鱼'), true, '否定词极性不同')
})

test('真正的重复（极性一致）不算矛盾', () => {
  assert.equal(contradicts('阿强喜欢钓鱼', '阿强喜欢钓鱼呀'), false, '同极性不算矛盾')
})

test('store.add：矛盾的新事实强制新增条目', () => {
  const mem = fakeStore()
  const r1 = mem.add({ text: '小雨养了一只猫叫团子', about: '20000001', source: 'tool' })
  const r2 = mem.add({ text: '小雨养了一只狗叫团子', about: '20000001', source: 'tool' })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.ok(!r2.updated, 'r2 应该是新插入（无 updated 字段），不能更新第一条')
  const items = mem.list('')
  assert.equal(items.filter((m) => /团子/.test(m.text)).length, 2, '库里 2 条，不是 1 条')
})

test('真重复仍走 updated 合并', () => {
  const mem = fakeStore()
  const r1 = mem.add({ text: '阿强喜欢钓鱼', about: '30000001', source: 'tool' })
  const r2 = mem.add({ text: '阿强喜欢钓鱼，每周都去', about: '30000001', source: 'tool' })
  assert.equal(r2.updated, r1.id, '同极性合并进旧条目')
  assert.equal(mem.list('').filter((m) => /钓鱼/.test(m.text)).length, 1)
})

test('scope/about 不同也不合并', () => {
  assert.equal(contradicts('x', 'x', '1000', '2000'), true, 'about 不同')
  assert.equal(contradicts('x', 'x', '', '', 'group:1', 'group:2'), true, 'scope 不同')
})
