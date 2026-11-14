// US-019 接线验收：<inner> 里的【顺承前情】真正驱动线索闭环。
// 重点：用户换话题（无标记）绝不误闭环。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createReplyDelivery } from '../src/chat/reply-delivery.js'

/** 假账本：记录 resolve/advance 调用。 */
function fakeLedger(threads = []) {
  const calls = { peek: [], resolve: [], advance: [] }
  return {
    calls,
    ledger: {
      peek(chatKey, opts) { calls.peek.push({ chatKey, opts }); return threads.slice() },
      // 真账本契约：resolve(id, o) —— 只接 id 和选项，不接 chatKey
      resolve(id, o) { calls.resolve.push({ id, meta: o }); return { ok: true } },
      advance(chatKey, o) { calls.advance.push({ chatKey, ...o }); return { ok: true } },
      // 真账本有 get()：adaptThreadLedger 用它做幂等闸门（已是目标状态就不重复推格）。
      get(id) { return threads.find((t) => t.id === id) || null },
    },
  }
}

function harness({ ledger } = {}) {
  const sent = []
  const logs = []
  const cfg = { reply: { maxBubbles: 6, groupMaxChars: 40, privateMaxChars: 120 }, voice: { enabled: false } }
  const capture = (kind) => async (chatId, value) => { sent.push([{ kind, value }]); return { messageId: 'm' + sent.length } }
  const d = createReplyDelivery({
    getConfig: () => cfg,
    log: { info: (m) => logs.push(String(m)), warn: (m) => logs.push('WARN:' + String(m)) },
    groups: { leaveTopic: () => {}, refs: () => ({}), enter: () => {}, noteSpeak: () => {}, noteSpokeInGroup: () => {}, decide: () => true },
    sendText: capture('text'),
    sendVoice: capture('voice'),
    sendSticker: capture('sticker'),
    sendImage: capture('image'),
    sendMixed: async (chatId, items) => { sent.push(items); return { messageId: 'm' + sent.length } },
    pokeBack: async () => {},
    logChat: () => {}, onActivity: () => {}, onDelivered: () => {},
    sleep: async () => {},
    reportTurns: new Map(),
    interaction: { queueAside: () => {}, claimPoke: () => false, releasePoke: () => {} },
    stickers: { put: () => {} },
    isCaptured: () => false,
    outbox: () => null,
    ...(ledger ? { threadLedger: ledger } : {}),
  })
  return { d, sent, logs }
}

test('有【顺承前情】标记且命中线索 → 闭环该线索', async () => {
  const { ledger, calls } = fakeLedger([{ id: 't1', keyword: '洗澡', state: 'active' }])
  const { d, logs } = harness({ ledger })
  await d.deliver('private:1000', '<inner>【顺承前情】洗澡</inner>洗完啦', { userText: '我洗完澡了' })
  assert.equal(calls.peek.length >= 1, true, `peek 应被调用，实际 ${calls.peek.length}`)
  assert.equal(calls.resolve.length, 1, '应闭环一条线索')
  assert.equal(calls.resolve[0].id, 't1', '应闭环预期线索')
  assert.equal(calls.resolve[0].meta.by, '【顺承前情】', '闭环来源应标记为顺承前情')
})

test('无标记（用户换话题）→ 绝不 resolve，只推进拓扑', async () => {
  const { ledger, calls } = fakeLedger([{ id: 't1', keyword: '洗澡', state: 'active' }])
  const { d, logs } = harness({ ledger })
  await d.deliver('private:1000', '<inner>随便想想</inner>今天天气不错', { userText: '今天天气不错' })
  assert.equal(calls.resolve.length, 0, '没有标记绝不能闭环')
  assert.equal(calls.advance.length, 1, '应推进一格')
  // 适配层调的是真账本的整轮推进契约 advance(chatKey, { didContinue:false })，
  // 由账本自己把该会话所有活线索各推一格（不是逐条 advance）。
  assert.equal(calls.advance[0].didContinue, false, '应表达「本轮未顺承」')
})

test('closure: continue 时全场拦截，连拓扑都不动', async () => {
  const { ledger, calls } = fakeLedger([{ id: 't1', keyword: '洗澡', state: 'active' }])
  const { d, logs } = harness({ ledger })
  await d.deliver('private:1000', '<inner>【顺承前情】洗澡 closure: continue</inner>好的', { userText: '好的' })
  assert.equal(calls.resolve.length, 0, 'no-close 信号必须拦住 resolve')
  assert.equal(calls.advance.length, 0, 'blocked 时不得推进')
})

test('不传 threadLedger 时不崩（模块未启用场景）', async () => {
  const { d, sent } = harness()
  await assert.doesNotReject(() => d.deliver('private:1000', '<inner>x</inner>你好', { userText: '你好' }))
  assert.ok(sent.length >= 1, '仍应正常投递')
})

test('账本抛错不影响回复投递', async () => {
  const bad = {
    peek() { throw new Error('boom') },
    resolve() { throw new Error('boom') },
    advance() { throw new Error('boom') },
  }
  const { d, sent, logs } = harness({ ledger: bad })
  await assert.doesNotReject(() => d.deliver('private:1000', '<inner>【顺承前情】洗澡</inner>好', { userText: '好' }))
  assert.ok(sent.length >= 1, '账本炸了也必须把回复发出去')
})

test('超长 inner 触发 Fail-Safe：不闭环', async () => {
  const { ledger, calls } = fakeLedger([{ id: 't1', keyword: '洗澡', state: 'active' }])
  const { d, logs } = harness({ ledger })
  const huge = '<inner>【顺承前情】洗澡' + '灌水'.repeat(300) + '</inner>好'
  await d.deliver('private:1000', huge, { userText: '好' })
  assert.equal(calls.resolve.length, 0, '超预算不得闭环')
})
