/**
 * 潜伏素材熔炉（crucible）—— 纯函数单测。
 *
 * 覆盖：指纹稳定性、同指纹去重（只续期不增条）、TTL 裁剪、超上限淘汰、
 * match 打分排序 / 空兴趣 / 过期不参与 / scope 隔离、超长字段裁剪、
 * 非法 source / url / tags / 时间 fail-closed、确定性（连调三次全等）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CRUCIBLE_DEFAULT_TTL_MS,
  createCrucible,
  CRUCIBLE_MAX_ENTRIES,
  CRUCIBLE_SUMMARY_MAX,
  CRUCIBLE_TITLE_MAX,
  fingerprint,
  ingest,
  match,
  prune,
} from '../src/purpose/engine/crucible.js'

const NOW = 1_760_000_000_000
const DAY = 24 * 60 * 60 * 1000

function rss(overrides = {}) {
  return {
    source: 'rss',
    title: '固态硬盘价格回落',
    summary: 'Q3 存储价格环比下跌，DIY 装机成本降低',
    url: 'https://example.com/ssd-price',
    tags: ['存储', '装机'],
    capturedAt: NOW,
    ttlMs: 2 * DAY,
    ...overrides,
  }
}

function bili(overrides = {}) {
  return {
    source: 'bili',
    title: '三角洲 S11 烽火地带改枪',
    summary: 'UP 主整理了 14 把武器的改枪码',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    tags: ['游戏', '三角洲'],
    capturedAt: NOW,
    ...overrides,
  }
}

test('指纹只由 source/url/title/summary 决定，与时间无关', () => {
  const a = fingerprint(rss())
  const b = fingerprint(rss({ capturedAt: NOW - 5 * DAY, ttlMs: 60_000 }))
  assert.equal(a, b)
  assert.equal(a.length, 32)
  assert.notEqual(a, fingerprint(rss({ title: '另一条新闻' })))
  assert.notEqual(a, fingerprint(rss({ source: 'bili' })))
  assert.notEqual(a, fingerprint(rss({ url: 'https://example.com/other' })))
})

test('同 fingerprint 重复 ingest 只续期，不产生第二条', () => {
  const first = ingest([], rss(), { now: NOW })
  assert.equal(first.pool.length, 1)
  assert.deepEqual(first.added, [first.pool[0].fingerprint])
  assert.deepEqual(first.refreshed, [])
  const again = ingest(first.pool, rss({ capturedAt: NOW + DAY }), { now: NOW + DAY })
  assert.equal(again.pool.length, 1)
  assert.deepEqual(again.added, [])
  assert.deepEqual(again.refreshed, [first.pool[0].fingerprint])
  assert.equal(again.pool[0].capturedAt, NOW + DAY)
  assert.equal(again.pool[0].title, rss().title)
})

test('续期时 ttl 取较大者、tags 取并集', () => {
  const one = ingest([], rss({ ttlMs: DAY, tags: ['存储'] }), { now: NOW }).pool
  const two = ingest(one, rss({ ttlMs: 3 * DAY, tags: ['存储', 'SSD'] }), { now: NOW }).pool
  assert.equal(two.length, 1)
  assert.equal(two[0].ttlMs, 3 * DAY)
  assert.deepEqual(two[0].tags, ['存储', 'ssd'])
})

test('一批素材里同 fingerprint 也只留一条', () => {
  const { pool, added, refreshed } = ingest([], [bili(), bili()], { now: NOW })
  assert.equal(pool.length, 1)
  assert.equal(added.length, 1)
  assert.deepEqual(refreshed, added)
})

test('素材结构固定包含 source/title/summary/url/tags/capturedAt/ttlMs/fingerprint', () => {
  const { pool } = ingest([], bili({ capturedAt: undefined, ttlMs: undefined }), { now: NOW })
  const entry = pool[0]
  for (const key of ['source', 'title', 'summary', 'url', 'tags', 'capturedAt', 'ttlMs', 'fingerprint']) {
    assert.ok(key in entry, `缺字段 ${key}`)
  }
  assert.equal(entry.source, 'bili')
  assert.equal(entry.capturedAt, NOW)
  assert.equal(entry.ttlMs, CRUCIBLE_DEFAULT_TTL_MS)
})

test('prune 剔除过期条目，未过期保留', () => {
  const old = ingest([], rss({ title: '旧闻', capturedAt: NOW - 10 * DAY, ttlMs: DAY }), { now: NOW - 10 * DAY }).pool
  const fresh = ingest(old, bili({ capturedAt: NOW, ttlMs: 2 * DAY }), { now: NOW }).pool
  assert.equal(fresh.length, 2)
  const { pool, removed } = prune(fresh, { now: NOW })
  assert.equal(pool.length, 1)
  assert.equal(pool[0].source, 'bili')
  assert.equal(removed.length, 1)
  assert.equal(removed[0], old[0].fingerprint)
})

test('prune 超上限时淘汰最旧条目', () => {
  const pool = []
  for (let i = 0; i < 6; i += 1) {
    pool.push(rss({ title: `线索 ${i}`, capturedAt: NOW - (6 - i) * 1000, ttlMs: 30 * DAY }))
  }
  const ingested = ingest([], pool, { now: NOW }).pool
  assert.equal(ingested.length, 6)
  const { pool: kept, removed } = prune(ingested, { now: NOW, maxEntries: 3 })
  assert.equal(kept.length, 3)
  assert.equal(removed.length, 3)
  assert.deepEqual(kept.map((e) => e.title), ['线索 3', '线索 4', '线索 5'])
})

test('prune 上限被夹到合法区间，不会因 0/负数把池子清空', () => {
  const { pool } = ingest([], [rss(), bili()], { now: NOW })
  assert.equal(prune(pool, { now: NOW, maxEntries: 0 }).pool.length, 1)
  assert.equal(prune(pool, { now: NOW, maxEntries: Number.NaN }).pool.length, 2)
  assert.equal(prune(pool, { now: NOW, maxEntries: 10_000 }).pool.length, 2)
})

test('match 按兴趣打分排序，标题命中权重高于摘要', () => {
  const { pool } = ingest([], [
    rss({ title: '固态硬盘价格回落', summary: '存储降价', url: 'https://example.com/a' }),
    bili({ title: '三角洲改枪', summary: '固态硬盘不是游戏话题', url: 'https://example.com/b' }),
    { source: 'group', title: '群友聊装机', summary: '装机单求推荐', tags: ['装机'], url: '', capturedAt: NOW },
  ], { now: NOW })
  const top = match(pool, 'group:100', ['固态硬盘'], { now: NOW })
  assert.equal(top.length, 2)
  assert.ok(top[0].title.includes('固态硬盘'))
  assert.ok(top[0].score > top[1].score)
  assert.ok(top[0].hits.includes('固态硬盘'))
})

test('match 支持带权重的兴趣对象，权重高的排前面', () => {
  const { pool } = ingest([], [
    rss({ title: '装机单推荐', url: 'https://example.com/c' }),
    bili({ title: '三角洲剧情解析', url: 'https://example.com/d' }),
  ], { now: NOW })
  const plain = match(pool, 'group:1', ['装机单', '三角洲'], { now: NOW })
  const weighted = match(pool, 'group:1', [
    { word: '装机单', weight: 1 },
    { word: '三角洲', weight: 5 },
  ], { now: NOW })
  assert.equal(plain[0].source, 'rss')
  assert.equal(weighted[0].source, 'bili')
})

test('match 空兴趣 / 无命中返回空数组，不随机兜底', () => {
  const { pool } = ingest([], [rss(), bili()], { now: NOW })
  assert.deepEqual(match(pool, 'group:1', [], { now: NOW }), [])
  assert.deepEqual(match(pool, 'group:1', undefined, { now: NOW }), [])
  assert.deepEqual(match(pool, 'group:1', ['   ', ''], { now: NOW }), [])
  assert.deepEqual(match(pool, 'group:1', ['量子计算机'], { now: NOW }), [])
  assert.deepEqual(match([], 'group:1', ['存储'], { now: NOW }), [])
})

test('match 不吃过期素材，且 limit 生效', () => {
  const stale = ingest([], rss({ title: '过期存储新闻', capturedAt: NOW - 10 * DAY, ttlMs: DAY }), { now: NOW - 10 * DAY }).pool
  const fresh = ingest(stale, rss({ title: '新鲜存储新闻', url: 'https://example.com/e', capturedAt: NOW }), { now: NOW }).pool
  const hits = match(fresh, 'group:1', ['存储'], { now: NOW })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].title, '新鲜存储新闻')

  const many = []
  for (let i = 0; i < 8; i += 1) {
    many.push(rss({ title: `存储新闻 ${i}`, url: `https://example.com/${i}`, capturedAt: NOW + i }))
  }
  const big = ingest([], many, { now: NOW }).pool
  assert.equal(match(big, 'group:1', ['存储'], { now: NOW }).length, 5)
  assert.equal(match(big, 'group:1', ['存储'], { now: NOW, limit: 3 }).length, 3)
  assert.equal(match(big, 'group:1', ['存储'], { now: NOW, limit: 999 }).length, 8)
})

test('match 遵守 scope 隔离：私聊素材不落到群聊', () => {
  const { pool } = ingest([], [
    rss({ title: '私聊存储悄悄话', scope: 'private:42', url: 'https://example.com/p' }),
    rss({ title: '群聊存储公告', scope: 'group:100', url: 'https://example.com/g' }),
  ], { now: NOW })
  const inPrivate = match(pool, 'private:42', ['存储'], { now: NOW })
  assert.deepEqual(inPrivate.map((e) => e.title), ['私聊存储悄悄话'])
  const inGroup = match(pool, 'group:100', ['存储'], { now: NOW })
  assert.deepEqual(inGroup.map((e) => e.title), ['群聊存储公告'])
  assert.deepEqual(match(pool, 'group:200', ['存储'], { now: NOW }), [])
})

test('超长 title / summary / tags 被裁剪且截断后仍稳定', () => {
  const long = 'x'.repeat(5000)
  const { pool } = ingest([], rss({ title: long, summary: long, tags: [long, '  ', 12345] }), { now: NOW })
  const entry = pool[0]
  assert.ok(entry.title.length <= CRUCIBLE_TITLE_MAX + 1)
  assert.ok(entry.summary.length <= CRUCIBLE_SUMMARY_MAX + 1)
  assert.ok(entry.tags.length <= 12)
  assert.equal(typeof entry.fingerprint, 'string')
  assert.ok(entry.tags.every((tag) => typeof tag === 'string' && tag))
})

test('非法 source / url / tags / 时间一律抛 TypeError', () => {
  assert.throws(() => ingest([], rss({ source: 'weibo' }), { now: NOW }), TypeError)
  assert.throws(() => ingest([], rss({ source: undefined }), { now: NOW }), TypeError)
  assert.throws(() => ingest([], rss({ url: 'ftp://example.com/x' }), { now: NOW }), TypeError)
  assert.throws(() => ingest([], rss({ tags: '存储' }), { now: NOW }), TypeError)
  assert.throws(() => ingest([], rss({ ttlMs: 0 }), { now: NOW }), TypeError)
  assert.throws(() => ingest([], rss({ capturedAt: -1 }), { now: NOW }), TypeError)
  assert.throws(() => ingest([], rss({ title: '', summary: '' }), { now: NOW }), TypeError)
  assert.throws(() => ingest([], 'not-an-object', { now: NOW }), TypeError)
  assert.throws(() => ingest([], rss(), { now: 0 }), TypeError)
  assert.throws(() => ingest('not-a-pool', rss(), { now: NOW }), TypeError)
  assert.throws(() => prune('not-a-pool', { now: NOW }), TypeError)
  assert.throws(() => match([], 'group:1', ['存储'], { now: -5 }), TypeError)
  assert.throws(() => match([], 'group:1', ['存储'], { now: NOW, limit: 3 }) && match([], 123, ['存储'], { now: NOW }), TypeError)
  assert.throws(() => ingest([], rss({ scope: 'public:1' }), { now: NOW }), TypeError)
  assert.throws(() => match([], 'group:1', [{ word: '存储', weight: 0 }], { now: NOW }), TypeError)
})

test('确定性：同一批输入连调三次结果全等', () => {
  const inputs = [rss(), bili(), bili({ summary: '另一段摘要' })]
  const runs = [0, 1, 2].map(() => {
    const { pool } = ingest([], inputs, { now: NOW })
    const pruned = prune(pool, { now: NOW + DAY, maxEntries: 2 }).pool
    return { pool, pruned, matches: match(pruned, 'group:1', ['存储', '三角洲'], { now: NOW + DAY }) }
  })
  assert.deepEqual(runs[0], runs[1])
  assert.deepEqual(runs[1], runs[2])
  assert.equal(runs[0].pool.length, 3)
  assert.equal(new Set(runs[0].pool.map((e) => e.fingerprint)).size, 3)
  assert.equal(runs[0].pruned.length, 2)
})

test('同分时按 capturedAt 降序、fingerprint 升序稳定排序', () => {
  const older = rss({ title: '存储新闻 甲', url: 'https://example.com/o' })
  const newer = rss({ title: '存储新闻 乙', url: 'https://example.com/n', capturedAt: NOW + 1000 })
  const { pool } = ingest([], [older, newer], { now: NOW })
  const top = match(pool, 'group:1', ['存储'], { now: NOW + 2000 })
  assert.equal(top.length, 2)
  assert.equal(top[0].score, top[1].score)
  assert.equal(top[0].title, '存储新闻 乙')
  const reversed = match([...pool].reverse(), 'group:1', ['存储'], { now: NOW + 2000 })
  assert.deepEqual(reversed.map((e) => e.fingerprint), top.map((e) => e.fingerprint))
})

test('match 返回副本并带 score/hits，不污染池子', () => {
  const { pool } = ingest([], [rss()], { now: NOW })
  const snapshot = JSON.stringify(pool)
  const top = match(pool, 'group:1', ['存储'], { now: NOW })
  assert.ok(top[0].score > 0)
  assert.deepEqual(top[0].hits, ['存储'])
  top[0].title = '被改掉了'
  assert.equal(JSON.stringify(pool), snapshot)
})

test('最大条目数常量与默认池容量一致', () => {
  assert.equal(CRUCIBLE_MAX_ENTRIES, 500)
  assert.equal(prune([], { now: NOW }).pool.length, 0)
})

test('createCrucible：match(chatKey, interests) 直接按会话挑素材', () => {
  const pool = createCrucible()
  assert.equal(pool.match('group:1', ['存储']).length, 0)
  pool.ingest([rss(), bili()], { now: NOW })
  assert.equal(pool.entries().length, 2)
  const hits = pool.match('group:1', ['存储'], { now: NOW })
  assert.deepEqual(hits.map((entry) => entry.source), ['rss'])
  assert.deepEqual(pool.match('group:1', [], { now: NOW }), [])
})

test('createCrucible：内部池只能通过 ingest/prune 改动，entries() 返回副本', () => {
  const pool = createCrucible()
  pool.ingest(rss(), { now: NOW })
  const copy = pool.entries()
  copy[0].title = '外部改坏'
  copy.push({ source: 'rss', title: '外来条目' })
  assert.equal(pool.entries().length, 1)
  assert.equal(pool.entries()[0].title, rss().title)
  assert.equal(pool.prune({ now: NOW + 10 * DAY }).pool.length, 0)
  assert.equal(pool.entries().length, 0)
})

test('createCrucible：可带初始池，重复 ingest 同样只续期', () => {
  const pool = createCrucible(ingest([], rss(), { now: NOW }).pool)
  assert.equal(pool.entries().length, 1)
  const again = pool.ingest(rss({ ttlMs: 5 * DAY }), { now: NOW + 1000 })
  assert.equal(again.pool.length, 1)
  assert.equal(again.added.length, 0)
  assert.equal(pool.entries()[0].ttlMs, 5 * DAY)
})
