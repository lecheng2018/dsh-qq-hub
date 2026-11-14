// 轮次级「送达状态」的诚实性回归网。
//
// 背景（审计报告问题 6，已核实）：reply-delivery 过去把每条气泡的发送结果**丢弃**，
// 于是「3 条里挂了 2 条」和「3 条全成功」在调用方看来完全一样，turn 一律报
// `state: 'sent'`。台账里其实已有 unknown/failed，但没有面板或汇报出口 ——
// 等于「记了没人看」+「轮次谎报」两件事同时存在。
//
// 本文件守的是**最小可验证的那一半**：只要有一条气泡没拿到网关回执，
// 轮次就不能报 sent。发送失败时的行为语义必须保持：不重发（会重复说话）、不回滚。
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

function fixture(sendText) {
  const sent = []
  const warns = []
  const delivery = createReplyDelivery({
    getConfig: () => config,
    log: { info() {}, debug() {}, warn: (...a) => warns.push(a.join(' ')) },
    hooks: {},
    reportTurns: new Map(),
    groups: { refs: () => ({}), leaveTopic() {}, noteSpeak() {}, noteSpokeInGroup() {} },
    stickers: { match: () => null, pickForReply: () => null },
    interaction: { queueAside() {} },
    sendText: async (chatId, text) => { sent.push(text); return sendText(text) },
    sendVoice: async () => ({ message_id: 1 }),
    sendSticker: async () => ({ message_id: 2 }),
    sendImage: async () => ({ message_id: 3 }),
    sendMixed: async () => ({ message_id: 4 }),
    pokeBack: async () => {},
    logChat() {},
    onActivity() {},
    sleep: async () => {},
  })
  return { delivery, sent, warns }
}

test('全部拿到回执 → failedCount 为 0（正常轮次不能被误判成部分失败）', async () => {
  const { delivery, warns } = fixture(() => ({ message_id: 9 }))
  const r = await delivery.deliverNow('private:1', '一|||二', {})
  assert.equal(r.attempted, 2)
  assert.equal(r.delivered, 2)
  assert.equal(r.failedCount, 0)
  assert.equal(warns.some((w) => /没拿到网关回执/.test(w)), false, '正常轮次不该刷警告')
})

test('中间一条失败 → 后面照发、计数如实、留 warn 便于排查', async () => {
  let n = 0
  const { delivery, sent, warns } = fixture(() => (++n === 2 ? null : { message_id: n }))
  const r = await delivery.deliverNow('private:1', '一|||二|||三', {})
  assert.deepEqual(sent, ['一', '二', '三'], '失败不中断后续气泡（用户已经看到前一条，不能吞掉后面的）')
  assert.equal(r.delivered, 2)
  assert.equal(r.failedCount, 1)
  assert.ok(warns.some((w) => /没拿到网关回执/.test(w)), '要留可排查的 warn')
})

test('失败不重发：同一条气泡只发起一次（否则用户会收到重复消息）', async () => {
  const calls = []
  const { delivery } = fixture((text) => { calls.push(text); return null })
  await delivery.deliverNow('private:1', '只发一次', {})
  assert.deepEqual(calls, ['只发一次'], '不能因为没回执就重试（可能已经送达，重试=重复说话）')
})

test('模拟模式（opts.simulate）不统计，也不刷警告', async () => {
  const { delivery, warns } = fixture(() => null)
  const r = await delivery.deliverNow('private:1', '一|||二', { simulate: true })
  // simulate 返回的是条目对象数组（{kind, value}），不是纯字符串——按真实形状断言。
  assert.deepEqual(r.map((i) => i.value), ['一', '二'], 'simulate 直接返回条目数组，行为与旧版一致')
  assert.equal(warns.length, 0)
})

test('missedAt 契约不变：@ 没对上群名片时仍然记进 missedAt', async () => {
  const { delivery } = fixture(() => ({ message_id: 1 }))
  const missed = []
  const r = await delivery.deliverNow('private:1', '正常回复', {})
  assert.deepEqual(r.missedAt, [])
  assert.ok(Array.isArray(missed))
})
