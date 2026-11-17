// 自动配表情的「别老发同一张」：刚用过的降权 + 相近分抽样。
// 回归的是 2026-11-17 的复盘：某个标签只有一张命中时，她会反复发同一张，
// 这是最容易被看出「这是机器人」的机械感来源。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchSticker, pickForReply, recentUseDecay } from '../src/features/stickers.js'

const NOW = 1_700_000_000_000
const MIN = 60_000

/** 固定序列的随机源，保证抽样结果可复现（xorshift32，首个值就已充分打散）。 */
function seeded(seed = 1) {
  let s = (seed * 2654435761) >>> 0
  if (!s) s = 0x9e3779b9
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

test('刚发过的表情会被让位给冷门的同标签表情', () => {
  const items = [
    { md5: 'a', name: '委屈巴巴', tags: ['委屈'], lastUsed: NOW },
    { md5: 'b', name: '可怜兮兮', tags: ['委屈'], lastUsed: 0 },
  ]
  // 刚发过 a → 这次应该挑 b，而不是无限重复 a
  assert.equal(pickForReply(items, '有点委屈', { now: NOW, rand: seeded(7) }).md5, 'b')
  // 反过来也一样：b 刚发过就该轮到 a
  const flipped = [
    { md5: 'a', name: '委屈巴巴', tags: ['委屈'], lastUsed: 0 },
    { md5: 'b', name: '可怜兮兮', tags: ['委屈'], lastUsed: NOW },
  ]
  assert.equal(pickForReply(flipped, '有点委屈', { now: NOW, rand: seeded(7) }).md5, 'a')
})

test('降权不清零：库里只有一张刚发过的，照样发得出去', () => {
  const items = [{ md5: 'a', name: '委屈巴巴', tags: ['委屈'], lastUsed: NOW }]
  assert.equal(pickForReply(items, '有点委屈', { now: NOW, rand: seeded(3) }).md5, 'a')
})

test('都没有「刚用过」时在相近分候选里抽样，而不是永远取第一张', () => {
  const items = [
    { md5: 'a', name: '委屈巴巴', tags: ['委屈'], lastUsed: 0 },
    { md5: 'b', name: '可怜兮兮', tags: ['委屈'], lastUsed: 0 },
  ]
  const picked = new Set()
  for (let seed = 1; seed <= 40; seed++) picked.add(pickForReply(items, '有点委屈', { now: NOW, rand: seeded(seed) }).md5)
  assert.deepEqual([...picked].sort(), ['a', 'b'], '两张都该有机会被挑中')
})

test('冷却过期后恢复正常权重', () => {
  const items = [
    { md5: 'a', name: '委屈巴巴', tags: ['委屈'], lastUsed: NOW - 31 * MIN },
    { md5: 'b', name: '可怜兮兮', tags: ['委屈'], lastUsed: NOW - 31 * MIN },
  ]
  assert.equal(recentUseDecay(items[0], NOW), 0)
  const picked = new Set()
  for (let seed = 1; seed <= 40; seed++) picked.add(pickForReply(items, '有点委屈', { now: NOW, rand: seeded(seed) }).md5)
  assert.deepEqual([...picked].sort(), ['a', 'b'])
})

test('recentUseDecay：没用过 / 刚用过 / 半程 / 过期', () => {
  assert.equal(recentUseDecay({ lastUsed: 0 }, NOW), 0, '没用过')
  assert.equal(recentUseDecay({ lastUsed: NOW }, NOW), 1, '刚发出去')
  assert.equal(recentUseDecay({ lastUsed: NOW - 15 * MIN }, NOW), 0.5, '半小时窗口过半')
  assert.equal(recentUseDecay({ lastUsed: NOW - 60 * MIN }, NOW), 0, '早就凉了')
  assert.equal(recentUseDecay({}, NOW), 0, '没有这个字段')
})

test('兜底随机也避开刚发过的（但库里全是刚发过的仍可发）', () => {
  // 两张都只有「动画表情」这种无信息名字 → 走兜底随机分支
  const bare = (md5, lastUsed) => ({ md5, name: '动画表情', tags: [], lastUsed })
  const items = [bare('a', NOW), bare('b', 0)]
  // a 刚发过 → 兜底基本只会挑 b
  const picked = new Set()
  for (let seed = 1; seed <= 40; seed++) picked.add(pickForReply(items, '随便说点什么', { now: NOW, rand: seeded(seed) }).md5)
  assert.ok(!picked.has('a'), '刚发过的那张不该再被兜底抽中')

  // 全都刚发过 → 仍要发得出去（不能返回 null）
  const allHot = [bare('a', NOW), bare('b', NOW)]
  assert.ok(pickForReply(allHot, '随便说点什么', { now: NOW, rand: seeded(5) }), '全是热的不等于无表情可发')
})

test('matchSticker 保持确定性：改名/删除靠它定位，不能随机', () => {
  const items = [
    { md5: 'a', name: '委屈巴巴的小猫', tags: ['委屈'], lastUsed: NOW },
    { md5: 'b', name: '得意叉腰', tags: ['开心'], lastUsed: NOW },
  ]
  // 唯一最高分：无论时钟和随机源怎么变，都必须是同一张
  for (let i = 0; i < 20; i++) assert.equal(matchSticker(items, '委屈').md5, 'a')
  assert.equal(matchSticker(items, '完全无关xyz'), null)
})

test('自动配表情：回复里没有任何标签词时走兜底，不会返回 null', () => {
  const items = [{ md5: 'a', name: '得意叉腰', tags: ['开心'], lastUsed: 0 }]
  assert.equal(pickForReply(items, '嗯'), items[0])
})
