// 回归：记忆的四档清晰度与遗忘（移植自 surfcore 记忆卡设计）。
//
// 背景：浏览经历（B站/小黑盒/画画）源源不断，原来的 shouldForget 对 source==='event'
// 直接 return false，记忆库只增不减（实测 61 条里 55 条是 event，永远清不掉）。
// 现在按清晰度分级：vivid → clear → fuzzy（正文截断）→ trace（只剩印象）→ 遗忘。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clarityOf, shouldForget, retention, CLARITY_STEPS } from '../src/features/memory.js'

const DAY = 86400_000
const OWNER = '10000001'
const at = (daysAgo, extra = {}) => ({
  text: '在B站看了《测试视频》',
  source: 'event',
  tags: ['B站'],
  importance: 0.45,
  at: Date.now() - daysAgo * DAY,
  ownerQQ: OWNER,
  ...extra,
})

test('清晰度四档顺序固定，vivid 在前', () => {
  assert.deepEqual(CLARITY_STEPS, ['vivid', 'clear', 'fuzzy', 'trace'])
})

test('普通经历随时间走完四档（慢慢模糊，不是突然消失）', () => {
  assert.equal(clarityOf(at(0)), 'vivid')
  assert.equal(clarityOf(at(14)), 'clear')
  assert.equal(clarityOf(at(30)), 'fuzzy')
  assert.equal(clarityOf(at(60)), 'trace')
})

test('trace 之后还要很久才真忘，不会刚变模糊就被删', () => {
  assert.equal(shouldForget(at(30)), false, 'fuzzy 阶段还在，不删')
  assert.equal(shouldForget(at(60)), true, 'trace 且衰减到门槛以下才忘')
})

test('主人相关的重要记忆永不遗忘，最差保持 clear', () => {
  const own = at(365, { about: OWNER, importance: 0.3 })
  assert.equal(clarityOf(own), 'clear', '主人的记忆最差 clear，不会掉到 fuzzy')
  assert.equal(shouldForget(own), false)
})

test('明确重要的记忆（importance ≥ 0.65）不遗忘', () => {
  const important = at(365, { importance: 0.7 })
  assert.equal(shouldForget(important), false)
})

test('pinned 永不模糊也永不遗忘', () => {
  const p = at(365, { pinned: true })
  assert.equal(clarityOf(p), 'vivid')
  assert.equal(shouldForget(p), false)
})

test('你亲手加的 / 面板加的 / 洞察永远不自动忘', () => {
  for (const source of ['panel', 'tool', 'diary']) {
    assert.equal(shouldForget(at(365, { source })), false, `${source} 不该被自动忘`)
  }
})

test('retention 随时间和重要度变化：越重要衰减越慢', () => {
  const now = Date.now()
  const low = { at: now - 30 * DAY, importance: 0.2 }
  const high = { at: now - 30 * DAY, importance: 0.9 }
  assert.ok(retention(high, now) > retention(low, now), '重要的记得更牢')
})

test('invalidAt 的过时记忆留半年再清', () => {
  const recent = at(0, { invalidAt: Date.now() - 10 * DAY })
  const old = at(0, { invalidAt: Date.now() - 200 * DAY })
  assert.equal(shouldForget(recent), false)
  assert.equal(shouldForget(old), true)
})
