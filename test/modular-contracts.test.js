import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONTRACT_VERSION,
  assertContextFragment,
  assertDelivery,
  assertNormalizedInbound,
  assertTurn,
  createChatKey,
  parseChatKey,
} from '../src/kernel/modular-contracts.js'

function inbound(overrides = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: 'event-1',
    messageId: 'message-1',
    chatKey: 'private:10001',
    sender: { userId: '10001', nickname: 'owner' },
    timestamp: 1_763_000_000_000,
    source: 'realtime',
    segments: [{ type: 'text', data: { text: 'hello' } }],
    ...overrides,
  }
}

function turn(overrides = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    turnId: 'turn-1',
    chatKey: 'group:20002',
    memberEventIds: ['event-1'],
    state: 'pending',
    createdAt: 1_763_000_000_000,
    ...overrides,
  }
}

function delivery(overrides = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    deliveryId: 'delivery-1',
    turnId: 'turn-1',
    chatKey: 'group:20002',
    sourceModuleId: 'core',
    state: 'unknown',
    attemptCount: 1,
    segments: [{ type: 'text', data: { text: 'hello' } }],
    ...overrides,
  }
}

function contextFragment(overrides = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    moduleId: 'memory',
    scope: 'private:10001',
    sessionId: 'session-1',
    priority: 100,
    cacheStable: false,
    onError: 'fail-closed',
    content: 'remembered fact',
    ...overrides,
  }
}

test('ChatKey 私聊和群聊可严格往返解析', () => {
  assert.equal(createChatKey('private', 10001), 'private:10001')
  assert.deepEqual(parseChatKey('group:20002'), { kind: 'group', id: '20002' })
})

test('ChatKey 拒绝裸 QQ 号、未知域、空 ID 和非数字 ID', () => {
  for (const value of ['10001', 'private:', 'system:10001', 'group:abc', ' private:10001']) {
    assert.throws(() => parseChatKey(value), TypeError)
  }
  assert.throws(() => createChatKey('channel', '10001'), TypeError)
})

test('NormalizedInbound 接受完整实时与 backfill 事件且不修改输入', () => {
  for (const source of ['realtime', 'backfill']) {
    const value = inbound({ source })
    const snapshot = structuredClone(value)
    assert.equal(assertNormalizedInbound(value), value)
    assert.deepEqual(value, snapshot)
  }
})

test('NormalizedInbound 拒绝错误版本、缺发送者、非法时间和非结构化消息段', () => {
  assert.throws(() => assertNormalizedInbound(inbound({ contractVersion: 2 })), /contractVersion/)
  assert.throws(() => assertNormalizedInbound(inbound({ sender: {} })), /sender\.userId/)
  assert.throws(() => assertNormalizedInbound(inbound({ timestamp: Number.NaN })), /timestamp/)
  assert.throws(() => assertNormalizedInbound(inbound({ segments: [{ type: 'text' }] })), /segments\[0\]\.data/)
  assert.throws(() => assertNormalizedInbound(inbound({ chatKey: '10001' })), /chatKey/)
})

test('NormalizedInbound 校验 sender 可选 nickname、card 和 role', () => {
  for (const role of ['owner', 'admin', 'member']) {
    const sender = { userId: '10001', nickname: 'owner', card: 'admin', role }
    assert.equal(assertNormalizedInbound(inbound({ sender })).sender, sender)
  }
  for (const [field, value] of [['nickname', 1], ['card', false], ['role', 'moderator']]) {
    assert.throws(
      () => assertNormalizedInbound(inbound({ sender: { userId: '10001', [field]: value } })),
      new RegExp(`sender\\.${field}`),
    )
  }
})

test('Turn 校验成员事件、状态和 ChatKey', () => {
  const value = turn()
  assert.equal(assertTurn(value), value)
  assert.throws(() => assertTurn(turn({ memberEventIds: [] })), /memberEventIds/)
  assert.throws(() => assertTurn(turn({ memberEventIds: ['event-1', 'event-1'] })), /重复/)
  assert.throws(() => assertTurn(turn({ state: 'finished' })), /state/)
  assert.doesNotThrow(() => assertTurn(turn({ chatKey: 'private:10001' })))
})

test('Delivery 显式接受 unknown，且拒绝缺失来源和非法尝试次数', () => {
  assert.equal(assertDelivery(delivery()).state, 'unknown')
  assert.throws(() => assertDelivery(delivery({ sourceModuleId: '' })), /sourceModuleId/)
  assert.throws(() => assertDelivery(delivery({ attemptCount: -1 })), /attemptCount/)
  assert.throws(() => assertDelivery(delivery({ state: 'retrying' })), /state/)
})

test('ContextFragment 支持聊天域和 global，但不接受裸作用域', () => {
  const value = contextFragment()
  assert.equal(assertContextFragment(value), value)
  assert.equal(assertContextFragment(contextFragment({ scope: 'global', sessionId: undefined })).scope, 'global')
  assert.throws(() => assertContextFragment(contextFragment({ scope: '10001' })), /scope/)
  assert.throws(() => assertContextFragment(contextFragment({ cacheStable: 'yes' })), /cacheStable/)
  assert.throws(() => assertContextFragment(contextFragment({ onError: 'ignore' })), /onError/)
})
