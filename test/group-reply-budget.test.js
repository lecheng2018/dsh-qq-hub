// 每小时发言额度（令牌桶）：插话和「接着聊」吃同一份预算。
//
// 回归 2026-11-17 的实测：
//   1. maxPerHour 只数 interjectTimes，而每次插话成功还白送 engagedMaxReplies 条连聊、
//      连聊又不吃任何上限 —— 名义设 6 的群实测每小时 22.5 条（6 × (1+3) 再打摩擦折扣）。
//   2. 额度是「先到先得」的：三段爆发的一小时里，前 20 分钟说了 64% 的量，
//      第三段爆发（40~48 分）一句都说不了。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_GROUP_POLICY, decideGroupReply, policyFor, replyBudget } from '../src/chat/group-policy.js'

const MIN = 60_000
const pol = (over = {}) => policyFor({ ...DEFAULT_GROUP_POLICY, quietHours: [99, 99], ...over }, {}, '1')

/** 造一条「她刚说过话」的时间序列：从 now 往前每隔 gapMs 一条，共 n 条。 */
const spoke = (now, n, gapMs) => Array.from({ length: n }, (_, i) => now - (n - i) * gapMs)

test('令牌桶：没有历史时桶是满的，容量 = ⌈maxPerHour/3⌉', () => {
  const now = 1_000_000
  assert.equal(replyBudget([], now, 20).cap, 7)
  assert.equal(replyBudget([], now, 6).cap, 2)
  assert.equal(replyBudget([], now, 3).cap, 1)
  assert.equal(replyBudget([], now, 20).level, 7)
  assert.equal(replyBudget([], now, 20).allowed, true)
})

test('令牌桶：刚把额度说光就不放行，回补一条的时间 = 3600/maxPerHour 秒', () => {
  const now = 1_000_000
  const said = spoke(now, 7, 1000) // 7 条 = 容量全用掉
  const after = replyBudget(said, now, 20)
  assert.equal(after.allowed, false)
  assert.ok(after.level < 0.1, `实际 ${after.level}`)
  // 20 条/小时 → 3 分钟回补一条
  assert.equal(replyBudget(said, now + 3 * MIN, 20).allowed, true)
  assert.equal(replyBudget(said, now + 2 * MIN, 20).allowed, false)
})

test('令牌桶：maxPerHour = 0 永不放行（等于关掉主动说话）', () => {
  const now = 1_000_000
  const b = replyBudget([], now, 0)
  assert.equal(b.allowed, false)
  assert.equal(b.cap, 0)
  assert.equal(replyBudget([], now, -5).allowed, false)
  assert.equal(replyBudget([], now, NaN).allowed, false)
})

test('令牌桶：容量有上限，攒再久也不会一次放出超过 cap 条', () => {
  const now = 100 * 3600_000
  // 上一次说话是 50 小时前：回补早就溢出了，但 level 仍被 cap 夹住
  const b = replyBudget([now - 50 * 3600_000], now, 20)
  assert.equal(b.level, b.cap)
})

test('令牌桶：按时间均匀发放，不会「前半程说光、后半程哑掉」', () => {
  // 一小时里分三段各说 7 条（= 容量），段间空 20 分钟。
  // 老逻辑（滚动一小数够 24 就拒）会在第二次爆发后彻底关门；令牌桶允许三段都有量。
  const keep = 24
  const said = [
    ...spoke(10 * MIN, 7, 1000),       // 第 0~10 分钟说了 7 条（容量用光）
    ...spoke(30 * MIN, 6, 3 * MIN),    // 第 12~30 分钟，每 3 分钟回补一条
  ]
  const at45 = replyBudget(said, 45 * MIN, keep)
  assert.ok(at45.allowed, `45 分钟时应该有额度，实际 ${at45.level}`)
  assert.ok(45 * MIN - Math.max(...said) > 0, '最后一次说话在 45 分钟之前')
})

test('决策链：连聊也吃额度 —— 额度用光后 engaged 也必须停', () => {
  const now = 10 * MIN
  // 容量 7 条全在一个很短的连聊里说完
  const said = spoke(now, 7, 5_000)
  const d = decideGroupReply({
    policy: pol({ maxPerHour: 20 }),
    text: '游戏真不错', now, hour: 12,
    mentioned: false, repliedToBot: false, fromOwner: false,
    recentTimes: [now - 1000, now - 2000, now - 3000],
    interjectTimes: [now - 60_000],
    botReplyTimes: said,
    engagedUntil: now + 60_000, engagedReplies: 0, engagedSince: now - 60_000,
    relevance: 0.5, rand: () => 0,
  })
  assert.equal(d.reply, false, '额度为 0 时连聊不该白送')
  assert.match(d.reason, /说够了/)
})

test('决策链：有额度时连聊照常生效', () => {
  const now = 10 * MIN
  const d = decideGroupReply({
    policy: pol({ maxPerHour: 20 }),
    text: '游戏真不错', now, hour: 12,
    mentioned: false, repliedToBot: false, fromOwner: false,
    recentTimes: [now - 1000, now - 2000, now - 3000],
    interjectTimes: [now - 60_000],
    botReplyTimes: [],
    engagedUntil: now + 60_000, engagedReplies: 0, engagedSince: now - 60_000,
    relevance: 0.5, rand: () => 0,
  })
  assert.equal(d.reply, true)
  assert.equal(d.mode, 'engaged')
})

test('engagedMaxReplies = 0 真的关掉连聊（不能被 || 兜回默认值）', () => {
  const now = 10 * MIN
  const d = decideGroupReply({
    policy: pol({ engagedMaxReplies: 0 }),
    text: '游戏真不错', now, hour: 12,
    mentioned: false, repliedToBot: false, fromOwner: false,
    recentTimes: [now - 1000, now - 2000, now - 3000],
    interjectTimes: [now - 60_000],
    botReplyTimes: [],
    engagedUntil: now + 60_000, engagedReplies: 0, engagedSince: now - 60_000,
    relevance: 0.5, rand: () => 0.99,
  })
  assert.notEqual(d.mode, 'engaged', '0 应该是「0 条预算」，不是「兜回 3」')
})

test('engagedMaxMs = 0 也真的关掉连聊', () => {
  const now = 10 * MIN
  const d = decideGroupReply({
    policy: pol({ engagedMaxMs: 0 }),
    text: '游戏真不错', now, hour: 12,
    mentioned: false, repliedToBot: false, fromOwner: false,
    recentTimes: [now - 1000, now - 2000, now - 3000],
    interjectTimes: [now - 60_000],
    botReplyTimes: [],
    engagedUntil: now + 60_000, engagedReplies: 0, engagedSince: now - 60_000,
    relevance: 0.5, rand: () => 0.99,
  })
  assert.notEqual(d.mode, 'engaged')
})

test('被 @ / 引用不受额度限制（必回优先）', () => {
  const now = 10 * MIN
  // 额度用光（7 条 = 容量），但摊在 7 分钟里，不触发 burst 刹车（8 次 / 120 秒）
  const said = spoke(now, 7, MIN)
  for (const p of [{ mentioned: true }, { repliedToBot: true }]) {
    const d = decideGroupReply({
      policy: pol({ maxPerHour: 20 }), text: '在吗', now, hour: 12,
      mentioned: false, repliedToBot: false, fromOwner: false, ...p,
      recentTimes: [], interjectTimes: [], botReplyTimes: said,
      relevance: 0, rand: () => 0.99,
    })
    assert.equal(d.reply, true, `${JSON.stringify(p)} 应该必回`)
    assert.equal(d.mode, 'must')
  }
})

test('burst 刹车仍排在必回之前：非主人的 @ 撞上刹车也会被压住（既有设计）', () => {
  const now = 10 * MIN
  const said = spoke(now, 20, 1000) // 20 条挤在 20 秒里，远超 burstMax
  const memberAt = decideGroupReply({
    policy: pol({ maxPerHour: 20 }), text: '在吗', now, hour: 12,
    mentioned: true, repliedToBot: false, fromOwner: false,
    recentTimes: [], interjectTimes: [], botReplyTimes: said,
    relevance: 0, rand: () => 0.99,
  })
  assert.equal(memberAt.reply, false)
  assert.match(memberAt.reason, /说了太多/)
  // 主人 @ 能穿过刹车
  const ownerAt = decideGroupReply({
    policy: pol({ maxPerHour: 20 }), text: '在吗', now, hour: 12,
    mentioned: true, repliedToBot: false, fromOwner: true,
    recentTimes: [], interjectTimes: [], botReplyTimes: said,
    relevance: 0, rand: () => 0.99,
  })
  assert.equal(ownerAt.reply, true)
  assert.equal(ownerAt.mode, 'must')
})

test('静默时段比额度更优先：额度够也不在该时段说话', () => {
  const now = 10 * MIN
  const d = decideGroupReply({
    policy: policyFor({ ...DEFAULT_GROUP_POLICY, quietHours: [1, 8] }, {}, '1'),
    text: '游戏真不错', now, hour: 3,
    mentioned: false, repliedToBot: false, fromOwner: false,
    recentTimes: [now - 1000, now - 2000, now - 3000],
    interjectTimes: [], botReplyTimes: [],
    relevance: 0.9, rand: () => 0,
  })
  assert.equal(d.reply, false)
  assert.match(d.reason, /静默时段/)
})
