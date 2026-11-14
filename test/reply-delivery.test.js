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

function fixture(overrides = {}) {
  const sent = []
  const logged = []
  const activities = []
  const groups = { refs: () => ({}), leaveTopic() {}, noteSpeak() {}, noteSpokeInGroup() {} }
  const delivery = createReplyDelivery({
    getConfig: () => config,
    log,
    hooks: {},
    reportTurns: new Map(),
    groups,
    stickers: { match: () => null, pickForReply: () => null },
    interaction: { queueAside() {} },
    sendText: async (chatId, text, replyId, missedAt, userId) => { sent.push({ chatId, kind: 'text', text, replyId, userId }); return { message_id: 1 } },
    sendVoice: async (chatId, text) => { sent.push({ chatId, kind: 'voice', text }); return { message_id: 2 } },
    sendSticker: async () => ({ message_id: 3 }),
    sendImage: async () => ({ message_id: 4 }),
    sendMixed: async () => ({ message_id: 5 }),
    pokeBack: async () => {},
    logChat: (...args) => logged.push(args),
    onActivity: (event) => activities.push(event),
    sleep: async () => {},
    ...overrides,
  })
  return { delivery, sent, logged, activities }
}

test('回复编排可独立执行：保留群聊合并、引用和最终流水', async () => {
  const { delivery, sent, logged } = fixture()
  const result = await delivery.deliverNow('group:7', '一|||二|||<reply:2>三|||四', {
    refs: { 2: { mid: '22', uid: 'u2' } },
    autoReply: { mid: '22', uid: 'u2' },
  })
  assert.equal(sent.length, 3)
  assert.equal(sent.map((item) => item.text).join(' '), '一 二 三 四')
  const quoted = sent.find((item) => item.replyId === '22')
  assert.match(quoted.text, /三/)
  assert.equal(quoted.userId, 'u2')
  assert.deepEqual(logged[0].slice(0, 2), ['group:7', 'bot'])
  // 返回值契约在「轮次级谎报」修复后新增了气泡级回执统计：
  // attempted / delivered / failedCount。missedAt 仍在，语义不变。
  assert.equal(result.attempted, 3, '三条气泡都应计入尝试')
  assert.equal(result.delivered, 3, '网关都回了回执 → 全部算送达')
  assert.equal(result.failedCount, 0, '没有未确认的气泡')
  assert.deepEqual(result.missedAt, [])
})

test('气泡级回执：有气泡没拿到网关回执时 failedCount 如实计数，且不重发', async () => {
  // 第 2 条返回 null（网关没回执）——模拟「真丢了一条」
  let call = 0
  const { delivery, sent } = fixture({
    sendText: async (chatId, text) => { call += 1; sent.push({ text }); return call === 2 ? null : { message_id: call } },
  })
  const result = await delivery.deliverNow('private:1', '一|||二|||三', {})
  assert.equal(sent.length, 3, '三条都尝试发了（失败不该中断后面的气泡）')
  assert.equal(result.attempted, 3)
  assert.equal(result.delivered, 2)
  assert.equal(result.failedCount, 1, '必须如实报 1 条未确认，不能谎报全成功')
})

test('气泡级回执：全部失败时 delivered=0 且 failedCount=attempted（不静默）', async () => {
  const { delivery } = fixture({ sendText: async () => null, sendVoice: async () => null })
  const result = await delivery.deliverNow('private:1', '一|||二', {})
  assert.equal(result.attempted, 2)
  assert.equal(result.delivered, 0)
  assert.equal(result.failedCount, 2)
})

test('可选流水和活动回调缺省时仍完成投递', async () => {
  const { delivery, sent } = fixture({ logChat: undefined, onActivity: undefined })
  await delivery.deliverNow('private:1', '正常回复')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, '正常回复')
})

test('扩展 hooks 可拦截正文和条目，拦截后不产生发送或流水', async () => {
  const { delivery, sent, logged } = fixture({ hooks: { reply: async () => null } })
  await delivery.deliverNow('private:1', '不应发送')
  assert.equal(sent.length, 0)
  assert.equal(logged.length, 0)
})

test('同会话在媒体准备期间保留 Outbox 票，独立会话不排队', async () => {
  let releaseCount = 0
  const outbox = {
    reserve() {
      return { ticket: {}, release: () => { releaseCount++ } }
    },
  }
  let finish
  const gate = new Promise((resolve) => { finish = resolve })
  const { delivery, sent } = fixture({
    outbox: () => outbox,
    sendText: async (chatId, text) => {
      sent.push({ chatId, text })
      if (text === 'first') await gate
    },
  })
  const first = delivery.deliver('group:7', 'first')
  const second = delivery.deliver('group:7', 'second')
  await delivery.deliver('group:8', 'other')
  assert.deepEqual(sent.map((x) => x.text), ['first', 'other'])
  finish()
  await Promise.all([first, second])
  assert.deepEqual(sent.map((x) => x.text), ['first', 'other', 'second'])
  assert.equal(releaseCount, 3)
})

test('模拟回复不占 Outbox 队列票，失败回复也会释放队列', async () => {
  let reserves = 0
  let releases = 0
  const { delivery } = fixture({
    outbox: () => ({ reserve: () => { reserves++; return { ticket: {}, release: () => { releases++ } } } }),
    sendText: async (chatId, text) => { if (text === 'failure') throw new Error('expected') },
  })
  const items = await delivery.deliver('private:1', 'simulation', { simulate: true })
  assert.equal(items[0].value, 'simulation')
  await assert.rejects(() => delivery.deliver('private:1', 'failure'), /expected/)
  assert.equal(reserves, 1)
  assert.equal(releases, 1)
})
