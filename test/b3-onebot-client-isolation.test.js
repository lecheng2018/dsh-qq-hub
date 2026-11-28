// Batch 3 · T3.3：OneBot 客户端旧 WS 回调隔离 + callWs preSend / 同步发送失败处理
//
// 改前：restart()/重连后旧 socket 的 onclose 仍然存活——它会把**新连接**的 pending 请求全拒掉、
// 把 state 打回 disconnected 并再排一次重连（幽灵 WS）；callWs 的「没连上」也不标 preSend，
// 副作用动作会被上层误判成 unknown；ws.send 同步抛错会留下永不回收的 pending（+ 定时器）。
// 这里用真实 createOneBotClient + 注入的假 WebSocket 复现并断言。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createOneBotClient } from '../src/onebot/client.js'

const noopLog = { info() {}, warn() {}, debug() {}, error() {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fakeWebSocketClass(instances, { sendThrows = false } = {}) {
  return class FakeWebSocket {
    constructor(url) {
      this.url = url
      this.readyState = 1 // OPEN
      this.sent = []
      instances.push(this)
    }
    send(raw) {
      if (sendThrows) throw new Error('socket 已损坏')
      this.sent.push(JSON.parse(raw))
    }
    close() { this.readyState = 3 }
  }
}

function withFakeWebSocket(klass, fn) {
  const prev = globalThis.WebSocket
  globalThis.WebSocket = klass
  try { return fn() } finally {
    if (prev === undefined) delete globalThis.WebSocket
    else globalThis.WebSocket = prev
  }
}

test('T3.3 旧 WS 的迟到 onclose 不得干扰新连接（状态、pending、重连次数）', async () => {
  const instances = []
  const states = []
  await withFakeWebSocket(fakeWebSocketClass(instances), async () => {
    const client = createOneBotClient({
      endpoint: () => ({ wsUrl: 'ws://example.com/onebot', httpUrl: '', wsToken: '', httpToken: '' }),
      onEvent: () => {},
      onState: (s) => states.push(s),
      log: noopLog,
      retryDelays: [0],
    })
    client.start()
    const ws1 = instances[0]
    assert.equal(instances.length, 1)
    ws1.onopen()
    assert.equal(client.state, 'connected')
    const staleOnClose = ws1.onclose // 旧连接的回调（restart 前捕获）

    client.restart()
    const ws2 = instances[1]
    assert.equal(instances.length, 2, 'restart 应新建一条连接')
    ws2.onopen()
    assert.equal(client.state, 'connected')

    // 新连接上挂一个 RPC（echo 只有在发送后才出现在 ws2.sent 里）
    const rpc = client.call('get_status', {}, { timeoutMs: 500, retries: 0 })
    await sleep(5)
    const echo = ws2.sent.at(-1)?.echo
    assert.ok(echo, '新连接的 RPC 应已写出')

    // 手动触发旧连接的 onclose（真实网络里这叫「旧 socket 迟到的关闭事件」）
    staleOnClose?.({ code: 1006 })

    assert.equal(client.state, 'connected', '旧 onclose 不许把新连接的状态打回 disconnected')
    assert.equal(client.pendingCount, 1, '新连接的挂起 RPC 不许被旧 onclose 拒掉')
    await sleep(50)
    assert.equal(instances.length, 2, '旧 onclose 不许触发第三次连接')

    // 新连接的回执仍能正常兑现
    ws2.onmessage({ data: JSON.stringify({ echo, status: 'ok', retcode: 0, data: { online: true } }) })
    assert.deepEqual(await rpc, { online: true })
    client.stop()
  })
})

test('T3.3 callWs：ws.send 同步抛错 → 立即 reject（preSend）、pending 清空、定时器不残留', async () => {
  const instances = []
  await withFakeWebSocket(fakeWebSocketClass(instances, { sendThrows: true }), async () => {
    const client = createOneBotClient({
      endpoint: () => ({ wsUrl: 'ws://example.com/onebot', httpUrl: '', wsToken: '', httpToken: '' }),
      onEvent: () => {},
      log: noopLog,
      retryDelays: [],
    })
    client.start()
    instances[0].onopen()

    await assert.rejects(
      () => client.call('send_private_msg', { user_id: 10001, message: 'x' }, { timeoutMs: 5000, retries: 0 }),
      (error) => {
        assert.equal(error.transport, true)
        assert.equal(error.preSend, true, '同步发送失败 = 请求确证没出门，必须标 preSend')
        assert.equal(error.unknown, false, '不许把「没出门」误报成 unknown')
        return true
      },
    )
    assert.equal(client.pendingCount, 0, '同步失败不许留下永不回收的 pending')
    client.stop()
  })
})

test('T3.3 callWs：未连接时拒绝必须标 preSend，副作用动作才不会被当成 unknown', async () => {
  await withFakeWebSocket(fakeWebSocketClass([]), async () => {
    const client = createOneBotClient({
      endpoint: () => ({ wsUrl: 'ws://example.com/onebot', httpUrl: '', wsToken: '', httpToken: '' }),
      onEvent: () => {},
      log: noopLog,
      retryDelays: [],
    })
    // 没有 start()：ws 为 null
    await assert.rejects(
      () => client.call('send_group_msg', { group_id: 20002, message: 'x' }, { timeoutMs: 100, retries: 0 }),
      (error) => {
        assert.equal(error.transport, true)
        assert.equal(error.preSend, true)
        assert.equal(error.unknown, false)
        return true
      },
    )
  })
})
