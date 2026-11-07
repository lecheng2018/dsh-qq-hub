// M2-A 契约测试：ChatKey 解析/格式化 + NormalizedInbound 工厂
// 任务书验收：不依赖 DSH、OneBot 或 host 即可运行全部用例。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createChatKey, parseChatKey, isChatKey, kindOf, idOf, isPrivate, isGroup, chatKeyFromEvent,
} from '../src/chat/chat-key.js'
import { createNormalizedInbound, textOf, segsOf, sourceOf, isBackfill } from '../src/chat/normalized-inbound.js'

const okInbound = (over = {}) => ({
  eventId: 'e1',
  messageId: 'm1',
  chatKey: 'private:10001',
  sender: { userId: '10001', nickname: '主人' },
  timestamp: 1_763_000_000_000,
  source: 'realtime',
  segments: [{ type: 'text', data: { text: '你好' } }],
  ...over,
})

// ---------- ChatKey ----------

test('ChatKey：私聊/群聊严格往返，数字与数字串等价', () => {
  assert.equal(createChatKey('private', 10001), 'private:10001')
  assert.equal(createChatKey('group', '20002'), 'group:20002')
  assert.deepEqual(parseChatKey('private:10001'), { kind: 'private', id: '10001' })
  assert.deepEqual(parseChatKey('group:20002'), { kind: 'group', id: '20002' })
  assert.equal(isPrivate('private:1'), true)
  assert.equal(isGroup('group:1'), true)
  assert.equal(idOf('group:20002'), '20002')
})

test('ChatKey：裸 QQ 号 / 未知域 / 前导零 / 空ID / 非数字 全部拒绝', () => {
  for (const bad of ['10001', 'private:', 'system:10001', 'group:abc', ' private:10001', 'private:007', 'group:-5', '']) {
    assert.equal(isChatKey(bad), false, `应拒绝：${JSON.stringify(bad)}`)
    assert.throws(() => parseChatKey(bad), TypeError)
  }
  assert.throws(() => createChatKey('channel', 1), TypeError)
})

test('chatKeyFromEvent：群事件按 group_id，私聊/poke 按 user_id，缺字段返回空串不猜键', () => {
  assert.equal(chatKeyFromEvent({ message_type: 'group', group_id: 777, user_id: 1 }), 'group:777')
  assert.equal(chatKeyFromEvent({ message_type: 'private', user_id: 555 }), 'private:555')
  assert.equal(chatKeyFromEvent({ notice_type: 'notify', sub_type: 'poke', user_id: 555 }), 'private:555')
  assert.equal(chatKeyFromEvent({ message_type: 'group' }), '') // 没带 group_id
  assert.equal(chatKeyFromEvent({}), '')
  assert.equal(chatKeyFromEvent(null), '')
})

// ---------- NormalizedInbound ----------

test('工厂：完整事件通过且深冻结（不可变边界），不改调用方原对象', () => {
  const input = okInbound()
  const snapshot = JSON.stringify(input)
  const inbound = createNormalizedInbound(input)
  assert.equal(inbound.eventId, 'e1')
  assert.equal(Object.isFrozen(inbound), true)
  assert.equal(Object.isFrozen(inbound.segments), true)
  assert.equal(Object.isFrozen(inbound.segments[0]), true)
  assert.equal(Object.isFrozen(inbound.segments[0].data), true)
  assert.equal(JSON.stringify(input), snapshot, '调用方对象零修改')
  assert.throws(() => { 'use strict'; inbound.chatKey = 'group:1' }, TypeError)
})

test('工厂：同 messageId 跨聊天是不同事件（派生 eventId 含 chatKey）', () => {
  const a = createNormalizedInbound(okInbound({ eventId: undefined, chatKey: 'group:777', messageId: 'm-9' }))
  const b = createNormalizedInbound(okInbound({ eventId: undefined, chatKey: 'private:555', messageId: 'm-9' }))
  assert.notEqual(a.eventId, b.eventId)
  assert.match(a.eventId, /^msg:group:777:m-9$/)
  assert.match(b.eventId, /^msg:private:555:m-9$/)
})

test('工厂：缺字段 / 非法类型 / 未知来源直接抛（缺字段 fail-closed）', () => {
  assert.throws(() => createNormalizedInbound(okInbound({ chatKey: '10001' })), TypeError) // 裸 QQ 号
  assert.throws(() => createNormalizedInbound(okInbound({ sender: { nickname: '没号' } })), TypeError)
  assert.throws(() => createNormalizedInbound(okInbound({ timestamp: '昨天' })), TypeError)
  assert.throws(() => createNormalizedInbound(okInbound({ source: 'replay' })), TypeError)
  assert.throws(() => createNormalizedInbound(okInbound({ segments: 'text' })), TypeError)
  assert.throws(() => createNormalizedInbound(null), TypeError)
  assert.throws(() => createNormalizedInbound([1, 2]), TypeError)
})

test('message_sent：作为 realtime 来源的自发事件建模（sender=自己，segments 原样）', () => {
  const selfSent = createNormalizedInbound(okInbound({
    chatKey: 'group:777',
    sender: { userId: '20000002' },
    segments: [{ type: 'text', data: { text: '她自己发的' } }],
  }))
  assert.equal(sourceOf(selfSent), 'realtime')
  assert.equal(selfSent.sender.userId, '20000002')
})

test('poke：无 messageId 的通知形态建模（segments 用 poke 类型，eventId 派生）', () => {
  const poke = createNormalizedInbound(okInbound({
    eventId: undefined,
    messageId: undefined,
    chatKey: 'group:777',
    sender: { userId: '555' },
    segments: [{ type: 'poke', data: { action: '戳了戳', targetId: '20000002' } }],
  }))
  assert.match(poke.eventId, /^evt:group:777:\d+$/)
  assert.equal(segsOf(poke, 'poke').length, 1)
  assert.equal(textOf(poke), '', 'poke 没有文本段')
})

test('引用 / @ / 媒体段：结构化承载，textOf 只拼 text', () => {
  const rich = createNormalizedInbound(okInbound({
    segments: [
      { type: 'reply', data: { id: '999' } },
      { type: 'at', data: { qq: '20000002' } },
      { type: 'text', data: { text: ' 看这张 ' } },
      { type: 'image', data: { url: 'https://x/y.png' } },
      { type: 'face', data: { id: '12' } },
    ],
  }))
  assert.equal(segsOf(rich, 'reply').length, 1)
  assert.equal(segsOf(rich, 'at')[0].data.qq, '20000002')
  assert.equal(segsOf(rich, 'image').length, 1)
  assert.equal(textOf(rich), ' 看这张 ')
})

test('backfill 来源：与 realtime 同构、仅 source 不同；isBackfill 视图正确', () => {
  const realtime = createNormalizedInbound(okInbound())
  const backfill = createNormalizedInbound(okInbound({ source: 'backfill' }))
  assert.equal(sourceOf(realtime), 'realtime')
  assert.equal(isBackfill(realtime), false)
  assert.equal(isBackfill(backfill), true)
  assert.deepEqual(
    { ...realtime, source: '' }, { ...backfill, source: '' },
    '除 source 外字段同构（适配层可共享转换逻辑）',
  )
})

test('契约外字段一律丢弃（raw 不准透传，适配层私搭桥没有入口）', () => {
  const inbound = createNormalizedInbound(okInbound({ rawEvent: { secret: 1 }, rawPayload: { x: 2 } }))
  assert.equal('rawEvent' in inbound, false)
  assert.equal('rawPayload' in inbound, false)
  assert.deepEqual(Object.keys(inbound).sort(), ['chatKey', 'contractVersion', 'eventId', 'messageId', 'segments', 'sender', 'source', 'timestamp'])
})
