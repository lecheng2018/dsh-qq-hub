// force 的边界：只豁免总开关关闭，不豁免 dryRun 或身份泄露闸。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createOutbox } from '../src/chat/outbox.js'

const segs = (text = '你好') => [{ type: 'text', data: { text } }]

function countingGateway() {
  const calls = []
  return {
    calls,
    send: async (action, params) => { calls.push({ action, params }); return { messageId: `gw-${calls.length}` } },
  }
}

test('force 不豁免 dryRun：试运行开着时，命令回复也不真发', async () => {
  const gw = countingGateway()
  const outbox = createOutbox({ send: gw.send, dryRun: () => true, enabled: () => false })
  const r = await outbox.request({ chatKey: 'private:10001', segments: segs('/status 的回复'), force: true })
  assert.equal(r.state, 'cancelled', '试运行没关，force 也不能真发')
  assert.equal(r.reason, 'dryRun')
  assert.equal(gw.calls.length, 0, '物理发送必须为 0 次')
})

test('force 仍豁免总开关：这是 /on 的自救通道，不能一起收掉', async () => {
  const gw = countingGateway()
  const outbox = createOutbox({ send: gw.send, dryRun: () => false, enabled: () => false })
  const r = await outbox.request({ chatKey: 'private:10001', segments: segs('总开关：已打开'), force: true })
  assert.equal(r.state, 'sent', '总开关关着时 force 必须还能发，否则用户把自己锁在门外')
  assert.equal(gw.calls.length, 1)
})

test('非 force 的普通回复：总开关关着照样不发（收窄没有把闸拆掉）', async () => {
  const gw = countingGateway()
  const outbox = createOutbox({ send: gw.send, dryRun: () => false, enabled: () => false })
  const r = await outbox.request({ chatKey: 'private:10001', segments: segs('普通回复') })
  assert.equal(r.state, 'cancelled')
  assert.equal(r.reason, '总开关关闭')
  assert.equal(gw.calls.length, 0)
})

test('force 不豁免身份泄露闸：命令回复里带出别人的号照样拦下', async () => {
  const gw = countingGateway()
  let guardCalls = 0
  const outbox = createOutbox({
    send: gw.send,
    dryRun: () => false,
    enabled: () => true,
    guard: () => { guardCalls += 1; return { ok: false, message: '含主人 QQ' } },
  })
  const r = await outbox.request({ chatKey: 'group:20002', segments: segs('他的号是 10000001'), force: true })
  assert.equal(guardCalls, 1, '闸必须被调用')
  assert.equal(r.state, 'cancelled')
  assert.match(r.reason, /身份泄露闸/)
  assert.equal(gw.calls.length, 0)
})

test('闸放行时 force 走完正常链路：豁免收窄不等于把闸做成死路', async () => {
  const gw = countingGateway()
  const outbox = createOutbox({
    send: gw.send,
    dryRun: () => false,
    enabled: () => true,
    guard: () => ({ ok: true }),
  })
  const r = await outbox.request({ chatKey: 'private:10001', segments: segs('总开关：已打开'), force: true })
  assert.equal(r.state, 'sent')
  assert.equal(gw.calls.length, 1)
})
