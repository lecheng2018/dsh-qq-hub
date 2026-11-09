// 网关韧性：启动前探测/等待（A）+ 发送失败重试（B）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

const { endpointHostPort, portOpen, gatewayHealthy, waitPortFree } = await import('../src/snowluma/manager.js')
const { createOneBotClient, OneBotError } = await import('../src/onebot/client.js')

const silent = { info () {}, warn () {}, debug () {}, error () {} }

// ---------- A. 启动前探测 ----------

test('endpointHostPort：从 URL 拆 host/port，坏地址返回 null', () => {
  assert.deepEqual(endpointHostPort('http://127.0.0.1:3000'), { host: '127.0.0.1', port: 3000 })
  assert.deepEqual(endpointHostPort('http://localhost:3001/onebot'), { host: 'localhost', port: 3001 })
  assert.deepEqual(endpointHostPort('http://127.0.0.1'), { host: '127.0.0.1', port: 80 }, '没写端口按 80')
  assert.equal(endpointHostPort(''), null)
  assert.equal(endpointHostPort('乱写'), null)
})

test('portOpen：有监听 true，关了变 false', async () => {
  const server = net.createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  assert.equal(await portOpen({ host: '127.0.0.1', port }), true)
  await new Promise((r) => server.close(r))
  assert.equal(await portOpen({ host: '127.0.0.1', port }), false)
})

test('waitPortFree：端口释放后返回 true', async () => {
  const server = net.createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  setTimeout(() => server.close(), 300)
  const freed = await waitPortFree({ host: '127.0.0.1', port }, { timeoutMs: 3000, intervalMs: 100 })
  assert.equal(freed, true)
})

test('waitPortFree：一直占着就返回 false（不会无限等）', async () => {
  const server = net.createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const t = Date.now()
  const freed = await waitPortFree({ host: '127.0.0.1', port }, { timeoutMs: 600, intervalMs: 100 })
  assert.equal(freed, false)
  assert.ok(Date.now() - t < 3000, '应该按时放弃')
  await new Promise((r) => server.close(r))
})

test('gatewayHealthy：真正的 OneBot 应答才算活着', async () => {
  const ep = { httpUrl: 'http://127.0.0.1:3000', httpToken: 'T' }
  const ok = async () => new Response(JSON.stringify({ status: 'ok', data: { user_id: 1 } }), { status: 200 })
  const retOk = async () => new Response(JSON.stringify({ retcode: 0, data: {} }), { status: 200 })
  const bad = async () => new Response(JSON.stringify({ status: 'failed', retcode: 1404 }), { status: 200 })
  const boom = async () => { throw new Error('fetch failed') }
  assert.equal(await gatewayHealthy(ep, { fetchImpl: ok }), true)
  assert.equal(await gatewayHealthy(ep, { fetchImpl: retOk }), true)
  assert.equal(await gatewayHealthy(ep, { fetchImpl: bad }), false, 'retcode 不通不算活着')
  assert.equal(await gatewayHealthy(ep, { fetchImpl: boom }), false)
  assert.equal(await gatewayHealthy({ httpUrl: '' }, { fetchImpl: ok }), false, '没配地址直接 false')

  // 带 token 时会加 Authorization 头
  let seen = null
  await gatewayHealthy(ep, { fetchImpl: async (url, init) => { seen = init.headers; return new Response('{"status":"ok"}', { status: 200 }) } })
  assert.equal(seen.authorization, 'Bearer T')
})

// ---------- B. 发送层重试 ----------

function client(fetchImpl, opts = {}) {
  const calls = []
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init) }
  const c = createOneBotClient({
    endpoint: () => ({ httpUrl: 'http://127.0.0.1:3000', httpToken: '', wsUrl: '', wsToken: '' }),
    onEvent: () => {},
    onState: () => {},
    log: silent,
    retryDelays: [10, 10],
    ...opts,
  })
  return { c, calls, restore: () => { globalThis.fetch = orig } }
}

test('网络层失败会重试，成功后正常返回', async () => {
  let n = 0
  const h = client(async () => {
    n++
    if (n < 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    return new Response(JSON.stringify({ status: 'ok', data: { message_id: 7 } }), { status: 200 })
  })
  try {
    const data = await h.c.call('send_private_msg', { user_id: 1, message: 'hi' })
    assert.equal(data.message_id, 7)
    assert.equal(h.calls.length, 3, '失败两次后第三次成功')
  } finally { h.restore() }
})

test('重试用完还失败：报错里写清楚连不上网关（不像原来只说 fetch failed）', async () => {
  const h = client(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) })
  try {
    await assert.rejects(() => h.c.call('send_private_msg', {}), (err) => {
      assert.ok(err instanceof OneBotError)
      assert.match(err.message, /连不上 QQ 网关/)
      assert.match(err.message, /ECONNREFUSED/)
      assert.equal(h.calls.length, 3, '一共试 3 次（初始 + 2 次重试）')
      return true
    })
  } finally { h.restore() }
})

test('业务错误不重试（retcode 不为 0 直接抛）', async () => {
  const h = client(async () => new Response(JSON.stringify({ status: 'failed', retcode: 1404, message: '没权限' }), { status: 200 }))
  try {
    await assert.rejects(() => h.c.call('send_private_msg', {}), /没权限/)
    assert.equal(h.calls.length, 1, '业务错误只调一次')
  } finally { h.restore() }
})

test('超时不重试（可能已经发出去了，重试会重复）', async () => {
  const h = client(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) })
  try {
    await assert.rejects(() => h.c.call('send_private_msg', {}), /超时/)
    assert.equal(h.calls.length, 1, '超时只调一次')
  } finally { h.restore() }
})

// ---------- C. unknown 防护覆盖面（代码审查 P1：副作用白名单反转） ----------

test('SEND_ACTIONS 之外的副作用动作（forward/qzone/set_*/delete_*）：连接中途断开 = unknown，只发一次', async () => {
  // ECONNRESET 不在 PRE_SEND_CODES：请求可能已到达网关，副作用可能已发生
  for (const action of ['send_group_forward_msg', 'send_private_forward_msg', 'send_qzone_msg', 'set_group_ban', 'delete_qzone_msg', 'set_friend_add_request']) {
    const h = client(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) })
    try {
      await assert.rejects(() => h.c.call(action, {}, { retries: 2 }), (e) => {
        assert.equal(e.unknown, true, `${action} 必须标 unknown`)
        return true
      })
      assert.equal(h.calls.length, 1, `${action} 断线后不许补发第二遍`)
    } finally { h.restore() }
  }
})

test('HTTP 应答不是合法 OneBot 信封（502 HTML）：副作用动作 = unknown，不得冒充明确拒绝', async () => {
  // 旧行为：r.json().catch 合成 retcode:502，下游按 definite failure 重发（base64 回退等）——错
  const h = client(async () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
  try {
    await assert.rejects(() => h.c.call('send_group_msg', {}, { retries: 2 }), (e) => {
      assert.ok(e instanceof OneBotError)
      assert.equal(e.unknown, true, '非 JSON 应答对副作用只能是结果不明')
      assert.equal(e.transport, false, '连接其实通了，只是应答没法解读')
      return true
    })
    assert.equal(h.calls.length, 1, 'unknown 不许自动重发')
  } finally { h.restore() }
})

test('HTTP 应答不是合法信封：查询动作按传输失败处理，允许重试（幂等，安全）', async () => {
  const h = client(async () => new Response('<html>502</html>', { status: 502 }))
  try {
    await assert.rejects(() => h.c.call('get_group_info', {}, { retries: 2 }), (e) => e.transport === true && e.unknown === false)
    assert.equal(h.calls.length, 3, '查询类把重试预算用完')
  } finally { h.restore() }
})

test('查询动作：HTTP 网络错误可在同调用内 WS 回退；副作用动作禁止 WS 补发', async () => {
  const sentFrames = []
  class FakeWS {
    constructor() { this.readyState = 1; setTimeout(() => this.onopen?.(), 0) }
    send(raw) {
      const m = JSON.parse(raw)
      sentFrames.push(m.action)
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ status: 'ok', retcode: 0, data: { via: 'ws' }, echo: m.echo }) }), 0)
    }
    close() { this.readyState = 3 }
  }
  const origWS = globalThis.WebSocket
  globalThis.WebSocket = FakeWS
  const h = client(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) }, {
    endpoint: () => ({ httpUrl: 'http://127.0.0.1:3000', httpToken: '', wsUrl: 'ws://127.0.0.1:3000', wsToken: '' }),
  })
  try {
    h.c.start()
    await new Promise((r) => setTimeout(r, 10))
    // 查询：HTTP 断线 → 同一调用里走 WS 拿到结果
    const data = await h.c.call('get_group_info', { group_id: 1 }, { retries: 0 })
    assert.deepEqual(data, { via: 'ws' })
    assert.deepEqual(sentFrames, ['get_group_info'])
    // 副作用：HTTP 断线 → 禁止 WS 补发（HTTP 请求可能已被网关执行），标 unknown 上抛
    await assert.rejects(() => h.c.call('send_group_forward_msg', {}, { retries: 0 }), (e) => e.unknown === true)
    assert.equal(sentFrames.length, 1, '副作用动作一条 WS 帧都不许发')
    h.c.stop()
  } finally { try { h.c.stop() } catch {} h.restore(); globalThis.WebSocket = origWS }
})

