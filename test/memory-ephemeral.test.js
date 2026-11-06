// 遗忘曲线 ephemeral 回归（1.3.52）：B站「想法」类条目（ephemeral）快速淡出并可直接遗忘。
import test from 'node:test'
import assert from 'node:assert/strict'
import { retention, clarityOf, shouldForget } from '../src/features/memory-core.js'

const mk = (days, { eph = true, importance = 0.3, hits = 0, hitDays = 0 } = {}) => ({
  at: Date.now() - days * 86400_000,
  lastHit: 0,
  importance,
  hitDays: hits ? 1 : hitDays,
  hits,
  ephemeral: eph ? 1 : '',
  source: 'event',
  about: '',
  ownerQQ: '10000001',
})

test('ephemeral τ 减半：6 天就掉出 vivid（普通条目 6 天还是 vivid）', () => {
  assert.ok(retention(mk(6)) < 0.5, 'ephemeral 6 天 retention=' + retention(mk(6)).toFixed(2))
  assert.ok(retention(mk(6, { eph: false })) > 0.55, '普通 6 天=' + retention(mk(6, { eph: false })).toFixed(2))
})

test('ephemeral trace 档直接可忘（普通条目要等 retention < 0.05）', () => {
  const eph14 = mk(14)
  assert.equal(clarityOf(eph14), 'fuzzy', '14 天已模糊（τ 减半生效）')
  const eph21 = mk(21)
  assert.equal(clarityOf(eph21), 'trace')
  assert.equal(shouldForget(eph21), true, 'ephemeral 21 天 → 直接忘')
  // 对照：普通条目 21 天才 clear（r=0.27），要 50+ 天才进 trace、retention<0.05 更久
  const normal21 = mk(21, { eph: false })
  assert.equal(clarityOf(normal21), 'clear', '普通 21 天还是 clear')
  assert.equal(shouldForget(normal21), false)
})

test('保护规则不被穿透：主人相关 / 重要 / pinned 的 ephemeral 也不会忘', () => {
  assert.equal(shouldForget({ ...mk(30), importance: 0.7 }), false, '重要条目不遗忘')
  assert.equal(shouldForget({ ...mk(30), pinned: 1 }), false, 'pinned 不遗忘')
  assert.equal(shouldForget({ ...mk(30), about: '10000001' }), false, '主人相关不遗忘')
})

test('被想起过的 ephemeral 寿命变长（hitDays 延 τ）——热过的梗不该秒忘', () => {
  const cold = retention(mk(10))
  const warm = retention(mk(10, { hits: 3, hitDays: 1 }))
  assert.ok(warm > cold * 1.5, 'warm=' + warm.toFixed(2) + ' cold=' + cold.toFixed(2))
})
