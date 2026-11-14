// 「正聊得起劲」连聊预算的回归网（2026-11-14 真机刷屏事故）。
//
// 事故链条（日志实证）：1% 插话概率命中一次 → 入场 → engaged 通道排在
// 冷却/每小时上限/概率摇号**之前**，每回复一条又把话题窗口重置 +3 分钟 →
// 活跃群里「一旦入场永不离场」。面板上「一开百分之一话就很多刷屏」就是这么来的。
//
// 三道闸门分别由三个文件把守：
//   ① group-policy：连聊条数 / 入场时长预算，到顶强制离场（本文件纯函数部分）
//   ② group-state：engaged 续聊**不续期**窗口（本文件状态部分）
//   ③ reply-delivery：按本轮 mode 分派记账（本文件投递部分）
import test from 'node:test'
import assert from 'node:assert/strict'

import { decideGroupReply, policyFor } from '../src/chat/group-policy.js'
import { createGroupState, ENGAGE_MS } from '../src/chat/group-state.js'
import { createReplyDelivery } from '../src/chat/reply-delivery.js'

const NOW = 1_800_000_000_000
const base = (over = {}) => ({
  policy: policyFor({}, {}, 1),
  text: '正常消息',
  now: NOW,
  hour: 13,
  recentTimes: [NOW - 1000, NOW - 900, NOW - 800],
  interjectTimes: [],
  botReplyTimes: [],
  relevance: 0.5,
  rand: () => 0.99, // 缺省摇不中，专门隔离 engaged 通道
  ...over,
})

// ---------------------------------------------------------------------------
// ① 预算：条数与时长
// ---------------------------------------------------------------------------

test('入场后连着接话默认最多 3 条：第 4 条被预算拦下', () => {
  const until = NOW + ENGAGE_MS
  for (const used of [0, 1, 2]) {
    const d = decideGroupReply(base({ engagedUntil: until, engagedReplies: used, engagedSince: NOW - used * 30_000 }))
    assert.equal(d.mode, 'engaged', `已接 ${used} 条时应还能续`)
  }
  const d = decideGroupReply(base({ engagedUntil: until, engagedReplies: 3, engagedSince: NOW - 90_000 }))
  assert.equal(d.reply, false, '第 4 条必须被拦')
  assert.match(d.reason, /连着接了 3 条|重新摇号/)
})

test('入场满 6 分钟：就算条数没用完也散场', () => {
  const d = decideGroupReply(base({
    engagedUntil: NOW + ENGAGE_MS, engagedReplies: 1, engagedSince: NOW - 7 * 60_000,
  }))
  assert.equal(d.reply, false)
  assert.match(d.reason, /够久|退出/)
})

test('预算拦不住必回：@ 她 / 引用她照回', () => {
  const until = NOW + ENGAGE_MS
  const over = { engagedUntil: until, engagedReplies: 99, engagedSince: NOW - 10 * 60_000 }
  assert.equal(decideGroupReply(base({ ...over, mentioned: true })).reply, true, '被 @ 必须回')
  assert.equal(decideGroupReply(base({ ...over, repliedToBot: true })).reply, true, '引用她必须回')
})

test('预算可按群覆盖：面板可把某群放宽到 5 条', () => {
  const pol = policyFor({}, { 7: { engagedMaxReplies: 5 } }, 7)
  const d = decideGroupReply(base({ policy: pol, engagedUntil: NOW + ENGAGE_MS, engagedReplies: 4 }))
  assert.equal(d.mode, 'engaged', '4 < 5 应放行')
})

test('没传预算字段 = 预算为 0 用（旧调用零破坏：engaged 照常放行）', () => {
  const d = decideGroupReply({
    text: 'x', now: NOW, hour: 13, recentTimes: [NOW, NOW, NOW],
    engagedUntil: NOW + ENGAGE_MS, relevance: 0.5, rand: () => 0.99,
    policy: policyFor({}, {}, 1),
  })
  assert.equal(d.mode, 'engaged', '不传 engagedReplies 的旧调用不能被误杀')
})

// ---------------------------------------------------------------------------
// ② group-state：续聊不续期、条数累计、重新入场清零
// ---------------------------------------------------------------------------

test('engaged 续聊不刷新窗口、累计条数；must/interject 入场才重置', () => {
  const gs = createGroupState()
  gs.joinTopic(7, NOW)
  assert.equal(gs.engagedUntil(7), NOW + ENGAGE_MS)
  assert.equal(gs.engagedReplies(7), 0)

  // 续聊三次：窗口不动、since 不动、条数 +3
  for (let i = 1; i <= 3; i += 1) gs.noteEngagedReply(7, NOW + i * 10_000)
  assert.equal(gs.engagedUntil(7), NOW + ENGAGE_MS, '续聊绝不能续期（死循环的根因）')
  assert.equal(gs.engagedSince(7), NOW, '入场时刻不能被续聊推后')
  assert.equal(gs.engagedReplies(7), 3)

  // 被 @ 回了一句（noteSpokeInGroup = 重新入场）：窗口、时刻、条数全部重置
  const t2 = NOW + 100_000
  gs.noteSpokeInGroup(7, t2)
  assert.equal(gs.engagedUntil(7), t2 + ENGAGE_MS, '重新入场应续新窗口')
  assert.equal(gs.engagedSince(7), t2)
  assert.equal(gs.engagedReplies(7), 0)
})

test('窗口自然过期后：noteEngagedReply 不再累计（不往坟头记账）', () => {
  const gs = createGroupState()
  gs.joinTopic(7, NOW)
  const d = decideGroupReply(base({ engagedUntil: gs.engagedUntil(7), engagedReplies: 3, engagedSince: NOW }))
  assert.equal(d.reply, false, '预算耗尽 → 拒绝')
  // 过期之后再记 engaged 回复，不应复活计数或窗口
  gs.noteEngagedReply(7, NOW + ENGAGE_MS + 1000)
  assert.equal(gs.engagedReplies(7), 0, '过期场次的续聊不该被计进任何场次')
})

test('死循环的真正断点：engaged 续聊路径不碰窗口（noteSpokeInGroup 只剩入场语义）', () => {
  const gs = createGroupState()
  gs.noteSpokeInGroup(7, NOW)
  const until = gs.engagedUntil(7)
  // 续聊三条：一条都不续期（旧代码每条都把 until 推后 3 分钟 → 永不离场）
  for (let i = 1; i <= 3; i += 1) gs.noteEngagedReply(7, NOW + i * 1000)
  assert.equal(gs.engagedUntil(7), until, 'engaged 续聊不得推后 until')
  // 被人直接搭话后的入场语义：窗口重置是正当的（对话对象在跟她说话）
  gs.noteSpokeInGroup(7, NOW + 2000)
  assert.ok(gs.engagedUntil(7) > until, '重新入场（must/interject）可以开窗')
})

// ---------------------------------------------------------------------------
// ③ reply-delivery：按 topicMode 分派记账
// ---------------------------------------------------------------------------

function deliveryProbe(groupsOver = {}) {
  const calls = []
  const groups = {
    refs: () => ({}),
    leaveTopic() {},
    noteSpeak: () => calls.push('noteSpeak'),
    noteSpokeInGroup: () => calls.push('noteSpokeInGroup'),
    noteEngagedReply: () => calls.push('noteEngagedReply'),
    ...groupsOver,
  }
  const config = { ownerQQ: 'o', voice: { enabled: false }, stickers: { enabled: false }, reply: { maxBubbles: 3 } }
  const delivery = createReplyDelivery({
    getConfig: () => config,
    log: { info() {}, warn() {}, debug() {} },
    hooks: {}, reportTurns: new Map(), groups,
    stickers: { match: () => null, pickForReply: () => null },
    interaction: { queueAside() {} },
    sendText: async () => ({ message_id: 1 }),
    sendVoice: async () => ({ message_id: 2 }), sendSticker: async () => ({ message_id: 3 }),
    sendImage: async () => ({ message_id: 4 }), sendMixed: async () => ({ message_id: 5 }),
    pokeBack: async () => {}, logChat() {}, onActivity() {}, sleep: async () => {},
  })
  return { delivery, calls }
}

test('topicMode=engaged 的投递：记预算条数，不入场不续期', async () => {
  const { delivery, calls } = deliveryProbe()
  await delivery.deliverNow('group:7', '接着说一句', { topicMode: 'engaged' })
  assert.deepEqual(calls, ['noteSpeak', 'noteEngagedReply'], `engaged 续聊只记账不续期（实际 ${calls.join(',')}）`)
})

test('topicMode=interject / must / 缺省的投递：照常入场（noteSpokeInGroup）', async () => {
  for (const mode of ['interject', 'must', undefined]) {
    const { delivery, calls } = deliveryProbe()
    await delivery.deliverNow('group:7', '说一句', mode ? { topicMode: mode } : {})
    assert.ok(calls.includes('noteSpokeInGroup'), `mode=${mode} 应走入场路径`)
    assert.ok(!calls.includes('noteEngagedReply'), `mode=${mode} 不该走续聊路径`)
  }
})

test('替身没有 noteEngagedReply（旧版 groups）也不崩', async () => {
  const { delivery } = deliveryProbe({ noteEngagedReply: undefined })
  const r = await delivery.deliverNow('group:7', '说一句', { topicMode: 'engaged' })
  assert.equal(r.failedCount, 0, '缺方法只是少记一笔，不能把投递搞挂')
})

// ---------------------------------------------------------------------------
// 全链路小气候：一次入场最多 4 条（1 摇号 + 3 续聊），然后闭嘴
// ---------------------------------------------------------------------------

test('模拟刷屏群：入场后续聊 3 条到顶，第 4 条起全被拦', () => {
  const gs = createGroupState()
  // 摇号命中 → 入场
  gs.joinTopic(9, NOW)
  let replies = 0
  for (let i = 1; i <= 6; i += 1) {
    const t = NOW + i * 5000 // 每 5 秒一条群消息（典型的刷屏群节奏）
    const d = decideGroupReply(base({
      now: t,
      engagedUntil: gs.engagedUntil(9),
      engagedReplies: gs.engagedReplies(9),
      engagedSince: gs.engagedSince(9),
      recentTimes: [t - 1000, t - 900, t - 800],
    }))
    if (d.mode === 'engaged') { gs.noteEngagedReply(9, t); replies += 1 }
  }
  assert.equal(replies, 3, '本场景最多连着接 3 条（旧代码是无限续）')
})
