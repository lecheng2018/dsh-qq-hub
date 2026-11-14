// 「道别后静默期」的回归网（conversation-closure 的 CLOSED + muteLockMs）。
//
// 背景（审计报告问题「CLOSED 硬锁半边没接线」，已核实属实）：
// conversation-closure 的四态处方表里给了 `muteLockMs`，reply-delivery 也一直记着 `closedAt`，
// 但**从来没有任何消费者读它**。于是「她说了晚安，一小时内不该自己再找你」这个设计意图
// 在生产上根本没实现：speakup 和 purpose 都不知道刚道过别，照样按空闲阈值开口。
// 用户刚说完「睡了」，十分钟后又被戳一下 —— 这是最招人烦的一类打扰。
//
// 本文件守三件事：
//   ① 道别后确实锁住主动开口；
//   ② 锁**过期**后自动放开（不能一次「晚安」把会话永久锁死）；
//   ③ **只锁主动开口，不锁入站回复** —— 用户回来找她，必须照常回。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createReplyDelivery } from '../src/chat/reply-delivery.js'

const log = { info() {}, warn() {}, debug() {} }
const config = {
  ownerQQ: 'owner',
  voice: { enabled: false, autoChance: 0, autoMaxChars: 300 },
  stickers: { enabled: false, autoChance: 0 },
  reply: { maxBubbles: 3 },
}

function fixture() {
  const sent = []
  const delivery = createReplyDelivery({
    getConfig: () => config,
    log,
    hooks: {},
    reportTurns: new Map(),
    groups: { refs: () => ({}), leaveTopic() {}, noteSpeak() {}, noteSpokeInGroup() {} },
    stickers: { match: () => null, pickForReply: () => null },
    interaction: { queueAside() {} },
    sendText: async (chatId, text) => { sent.push(text); return { message_id: sent.length } },
    sendVoice: async () => ({ message_id: 1 }),
    sendSticker: async () => ({ message_id: 2 }),
    sendImage: async () => ({ message_id: 3 }),
    sendMixed: async () => ({ message_id: 4 }),
    pokeBack: async () => {},
    logChat() {},
    onActivity() {},
    sleep: async () => {},
  })
  return { delivery, sent }
}

test('没道别过：不锁（不能把正常会话误判成静默期）', async () => {
  const { delivery } = fixture()
  await delivery.deliverNow('private:1', '在呢', { userText: '在吗' })
  const st = delivery.proactiveMuteState('private:1')
  assert.equal(st.muted, false, `普通对话不该锁（实际 ${JSON.stringify(st)}）`)
  assert.equal(st.remainingMs, 0)
})

test('道别后进入静默期：muted=true 且剩余时间是正数', async () => {
  const { delivery } = fixture()
  await delivery.deliverNow('private:1', '睡吧 晚安', { userText: '睡了晚安' })
  const st = delivery.proactiveMuteState('private:1')
  assert.equal(st.muted, true, `道别后应进入静默期（实际 ${JSON.stringify(st)}）`)
  assert.ok(st.remainingMs > 0, '剩余时间应为正')
  assert.ok(st.until > Date.now(), 'until 应是未来的时间戳')
  assert.match(st.reason, /道别|CLOSED|静默/)
})

test('静默期会过期：锁到期后自动放开（一次「晚安」不能永久锁死）', async () => {
  const { delivery } = fixture()
  await delivery.deliverNow('private:1', '睡吧 晚安', { userText: '睡了晚安' })
  const now = Date.now()
  const st = delivery.proactiveMuteState('private:1', now)
  assert.equal(st.muted, true)
  // 把时间推到锁到期之后
  const after = delivery.proactiveMuteState('private:1', st.until + 1000)
  assert.equal(after.muted, false, '过期后必须放开，否则会话被永久锁死')
  assert.equal(after.remainingMs, 0)
})

test('只锁主动开口，不锁入站回复：静默期内用户来消息照常回', async () => {
  const { delivery, sent } = fixture()
  await delivery.deliverNow('private:1', '睡吧 晚安', { userText: '睡了晚安' })
  assert.equal(delivery.proactiveMuteState('private:1').muted, true, '前置：已进入静默期')

  sent.length = 0
  await delivery.deliverNow('private:1', '咋又醒了', { userText: '我睡不着' })
  assert.deepEqual(sent, ['咋又醒了'], '静默期绝不能拦入站回复（用户回来找她必须回）')
})

test('静默期按会话隔离：A 道别不影响 B', async () => {
  const { delivery } = fixture()
  await delivery.deliverNow('private:1', '睡吧 晚安', { userText: '睡了晚安' })
  assert.equal(delivery.proactiveMuteState('private:1').muted, true)
  assert.equal(delivery.proactiveMuteState('private:2').muted, false, '别的会话不受牵连')
  assert.equal(delivery.proactiveMuteState('group:9').muted, false)
})

test('isProactivelyMuted 是同一个判定的简写，两者必须一致', async () => {
  const { delivery } = fixture()
  await delivery.deliverNow('private:1', '睡吧 晚安', { userText: '睡了晚安' })
  const now = Date.now()
  assert.equal(delivery.isProactivelyMuted('private:1', now), delivery.proactiveMuteState('private:1', now).muted)
  assert.equal(delivery.isProactivelyMuted('private:404', now), false)
})

test('非法 chatId 一律不锁（fail-open：不能因为参数坏掉就永久掐话）', () => {
  const { delivery } = fixture()
  for (const bad of ['', null, undefined]) {
    const st = delivery.proactiveMuteState(bad)
    assert.equal(st.muted, false, `${JSON.stringify(bad)} 不该锁`)
  }
  assert.equal(delivery.isProactivelyMuted(''), false)
})

test('静默期内反复道别不会无限续期（closedAt 只在首次进入 CLOSED 时取）', async () => {
  const { delivery } = fixture()
  await delivery.deliverNow('private:1', '睡吧 晚安', { userText: '睡了晚安' })
  const first = delivery.proactiveMuteState('private:1')
  // 再道别一次
  await delivery.deliverNow('private:1', '嗯 晚安', { userText: '晚安' })
  const second = delivery.proactiveMuteState('private:1')
  assert.equal(second.until, first.until, '已在 CLOSED 时不应刷新 closedAt（否则用户每说一次晚安就多锁一小时）')
})
