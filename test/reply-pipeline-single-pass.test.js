// 审计 Q01 / Q02 / Q06 的行为锁：
//   Q01 · 回复钩子每轮只执行一次（modular-core 与 reply-delivery 曾经各跑一遍）
//   Q02 · 报告兜底标记必须活到投递那一刻（曾在 turn/end 就被删掉，规则永远读不到）
//   Q06 · "没发出去"不得产生"已发"的副状态（活跃刷新 / activity / 配额）
//
// 这三条是同一个根因的三张脸：主链上有两处实现，状态没有跟着回合走。
// 修复方向是"只在一处执行 + 状态随回合传递"，所以测试也钉这三件事：
//   1. 计数扩展断言 reply / reply:items 每轮各 1 次；
//   2. 合成"net/end 先到、投递在后"的真实顺序，断言报告仍整段；
//   3. 全失败 / 零尝试两态，断言群活跃与 activity 只在真发出时更新。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createReplyDelivery } from '../src/chat/reply-delivery.js'

const log = { info() {}, warn() {}, debug() {} }

function makeConfig(over = {}) {
  return {
    ownerQQ: 'owner',
    voice: { enabled: false, autoChance: 0, autoMaxChars: 300 },
    stickers: { enabled: false, autoChance: 0 },
    reply: { maxBubbles: 3, groupMaxChars: 40, privateMaxChars: 120 },
    ...over,
  }
}

/** 最小投递装置：可编程的发送结果、可观测的副状态。 */
function fixture({ config = makeConfig(), overrides = {} } = {}) {
  const sent = []
  const activities = []
  const deliveredEvents = []
  const logged = []
  const groupCalls = []
  const hooks = { replyCalls: 0, itemCalls: 0 }
  const delivery = createReplyDelivery({
    getConfig: () => config,
    log,
    hooks: {
      reply: async (text) => { hooks.replyCalls += 1; return text },
      items: async (items) => { hooks.itemCalls += 1; return items },
    },
    reportTurns: new Map(),
    groups: {
      refs: () => ({}),
      leaveTopic() {},
      noteSpeak: (gid) => groupCalls.push(['noteSpeak', gid]),
      noteSpokeInGroup: (gid) => groupCalls.push(['noteSpokeInGroup', gid]),
      noteEngagedReply: (gid) => groupCalls.push(['noteEngagedReply', gid]),
      noteInterject: (gid) => groupCalls.push(['noteInterject', gid]),
    },
    stickers: { match: () => null, pickForReply: () => null },
    interaction: { queueAside() {} },
    sendText: async (chatId, text) => {
      sent.push({ chatId, kind: 'text', text })
      return overrides.textReceipt === undefined ? { message_id: sent.length } : overrides.textReceipt
    },
    sendVoice: async (chatId, text) => { sent.push({ chatId, kind: 'voice', text }); return { message_id: 2 } },
    sendSticker: async () => (overrides.stickerReceipt === undefined ? { message_id: 3 } : overrides.stickerReceipt),
    sendImage: async () => (overrides.imageReceipt === undefined ? { message_id: 4 } : overrides.imageReceipt),
    sendMixed: async () => (overrides.mixedReceipt === undefined ? { message_id: 5 } : overrides.mixedReceipt),
    pokeBack: async () => {},
    logChat: (...args) => logged.push(args),
    onActivity: (event) => activities.push(event),
    onDelivered: (event) => deliveredEvents.push(event),
    sleep: async () => {},
  })
  return { delivery, sent, activities, deliveredEvents, logged, groupCalls, hooks }
}

// ---------- Q01：钩子每轮只跑一次 ----------

test('Q01 · reply / reply:items 钩子每次投递各执行一次', async () => {
  const { delivery, hooks } = fixture()
  await delivery.deliverNow('private:9', '第一句|||第二句')
  assert.equal(hooks.replyCalls, 1, 'reply 钩子只能跑一次')
  assert.equal(hooks.itemCalls, 1, 'reply/items 钩子只能跑一次')
})

test('Q01 · 钩子改写后的条目就是实际发出的条目（线索与统计看到同一份）', async () => {
  const config = makeConfig()
  const sent = []
  const delivery = createReplyDelivery({
    getConfig: () => config,
    log,
    hooks: { reply: async (text) => `${text}|||钩子补的尾巴`, items: async (items) => items },
    reportTurns: new Map(),
    groups: { refs: () => ({}), leaveTopic() {}, noteSpeak() {}, noteSpokeInGroup() {}, noteEngagedReply() {} },
    stickers: { match: () => null, pickForReply: () => null },
    interaction: { queueAside() {} },
    sendText: async (chatId, text) => { sent.push(text); return { message_id: sent.length } },
    sendVoice: async () => ({ message_id: 2 }),
    sendSticker: async () => ({ message_id: 3 }),
    sendImage: async () => ({ message_id: 4 }),
    sendMixed: async () => ({ message_id: 5 }),
    pokeBack: async () => {},
    logChat: () => {},
    onActivity: () => {},
    onDelivered: () => {},
    sleep: async () => {},
  })
  const result = await delivery.deliverNow('private:9', '本体')
  assert.deepEqual(sent, ['本体', '钩子补的尾巴'], '钩子追加的气泡必须真的发出去')
  assert.ok(Array.isArray(result.items), '投递结果要带出实际条目，调用方不必自己再解析一遍')
  assert.equal(
    result.items.filter((i) => i.kind === 'text').map((i) => i.value).join('|'),
    '本体|钩子补的尾巴',
    'items 必须等于实际发出的内容',
  )
})

// ---------- Q02：报告标记必须活到投递 ----------

// 用较小的 privateMaxChars 让「拆不拆」由规则决定，而不是由字数是否刚好超限决定。
const SPLIT_CFG = makeConfig({ reply: { maxBubbles: 3, groupMaxChars: 40, privateMaxChars: 50 } })

test('Q02 · 报告标记由调用方按回合传入，不依赖一个跨回合的 Map', async () => {
  const { delivery, sent } = fixture({ config: SPLIT_CFG })
  // 长回复：正常会被按句读拆成多条；forceReport 必须让它整段。
  const long = '她今天去了超市，买了牛奶和面包，还顺手带了一盒草莓回来。晚上煮了面，看了会儿剧就睡了，没干什么特别的事。早上出门的时候还遇见了隔壁的阿姨，聊了几句关于小区停车的事，回来又收拾了半天屋子，把冬天的衣服都翻出来晒了一遍，累得够呛。'
  const plain = await delivery.deliverNow('private:9', long, {})
  assert.ok(plain.items.length > 1, `没有标记时必须按句读拆开，实际 ${plain.items.length} 条`)

  const reported = await delivery.deliverNow('private:9', long, { forceReport: true })
  assert.equal(reported.items.length, 1, 'forceReport 必须整段一条')
  assert.equal(reported.items[0].value.replace(/\s+/g, ''), long.replace(/\s+/g, ''), '内容不能丢')
  assert.ok(sent.length >= 2)
})

test('Q02 · 上一轮的标记不会污染下一轮（回合作用域，不是聊天作用域）', async () => {
  const { delivery } = fixture({ config: SPLIT_CFG })
  const long = '她今天去了超市，买了牛奶和面包，还顺手带了一盒草莓回来。晚上煮了面，看了会儿剧就睡了，没干什么特别的事。早上出门的时候还遇见了隔壁的阿姨，聊了几句关于小区停车的事，回来又收拾了半天屋子，把冬天的衣服都翻出来晒了一遍，累得够呛。'
  await delivery.deliverNow('private:9', long, { forceReport: true })
  // 下一轮同聊天、没有标记：必须回到拆条行为，而不是继承上一轮的 forceReport。
  const after = await delivery.deliverNow('private:9', long, {})
  assert.ok(after.items.length > 1, 'forceReport 不能跨轮残留')
})

// ---------- Q06：没发出去不得产生已发的副状态 ----------

test('Q06 · 全失败：不刷新群活跃、不发 activity、不记送达', async () => {
  const { delivery, activities, deliveredEvents, logged, groupCalls } = fixture({
    overrides: { textReceipt: null },
  })
  const result = await delivery.deliverNow('group:7', '一条都发不出去的话')
  assert.equal(result.attempted, 1)
  assert.equal(result.delivered, 0)
  assert.equal(result.failedCount, 1)
  assert.equal(result.state, 'failed', '一条都没拿到回执 → failed')
  assert.deepEqual(groupCalls, [], '没发出去不能刷新群活跃窗口')
  assert.deepEqual(activities, [], '没发出去不能发 activity 出站事件')
  assert.deepEqual(deliveredEvents, [], '没发出去不能记「主人最近收到」')
  assert.deepEqual(logged, [], '没发出去不能写聊天流水')
})

test('Q06 · 部分成功：state=partial，副状态照常（剩下确实发了）', async () => {
  let n = 0
  const sent = []
  const activities = []
  const config = makeConfig()
  const delivery = createReplyDelivery({
    getConfig: () => config,
    log,
    hooks: {},
    reportTurns: new Map(),
    groups: { refs: () => ({}), leaveTopic() {}, noteSpeak() {}, noteSpokeInGroup() {}, noteEngagedReply() {} },
    stickers: { match: () => null, pickForReply: () => null },
    interaction: { queueAside() {} },
    sendText: async (chatId, text) => {
      n += 1
      if (n === 1) { sent.push(text); return { message_id: 1 } }
      return null
    },
    sendVoice: async () => null,
    sendSticker: async () => null,
    sendImage: async () => null,
    sendMixed: async () => null,
    pokeBack: async () => {},
    logChat: () => {},
    onActivity: (e) => activities.push(e),
    onDelivered: () => {},
    sleep: async () => {},
  })
  const result = await delivery.deliverNow('private:9', '发得出去的|||发不出去的')
  assert.equal(result.attempted, 2)
  assert.equal(result.delivered, 1)
  assert.equal(result.state, 'partial')
  assert.deepEqual(sent, ['发得出去的'])
  assert.equal(activities.length, 1, '有实发就该有 activity')
})

test('Q06 · 零尝试（整轮无可发条目）：不产生任何已发副作用', async () => {
  const { delivery, activities, deliveredEvents, logged, groupCalls } = fixture()
  // 空回复 = 她选择不说话（[沉默]），是可区分的回合终态，不是「已发」。
  const result = await delivery.deliverNow('group:7', '', {})
  assert.equal(result.attempted, 0, '空回复没有可发条目')
  assert.equal(result.state, 'silent', '静默要有独立终态，调用方才能和「编排挂了」区分')
  assert.deepEqual(groupCalls, [], '零尝试不能算进群发言配额')
  assert.deepEqual(activities, [])
  assert.deepEqual(deliveredEvents, [])
  assert.deepEqual(logged, [])
})

test('Q06 · 试运行不产生已发副作用', async () => {
  const { delivery, activities, deliveredEvents, groupCalls } = fixture()
  const result = await delivery.deliverNow('group:7', '试运行的话', { simulate: true })
  // simulate 仍然返回条目数组（既有契约），但它绝不能产生「已发」副状态。
  assert.ok(Array.isArray(result), 'simulate 的返回值契约不变')
  assert.equal(result.length, 1)
  assert.deepEqual(groupCalls, [])
  assert.deepEqual(activities, [])
  assert.deepEqual(deliveredEvents, [])
})