// T1.1 回归：net.js 的 safeLookup 真实回调链路 / 保留段判定 / dispatcher 复用 / 重定向收口。
//
// 这里全部是行为测试：真实调用 safeLookup（走 node:dns），真实调用 fetchImage（打桩 fetch），
// 不靠读源码正则。改前 safeLookup 用 Promise 版 lookup + 第三参回调，回调永不执行；
// 本文件的第一个用例会在 500ms 内超时失败，精确复现「公网下载 100% 挂死」。

import test from 'node:test'
import assert from 'node:assert/strict'

import { isPrivateIp, safeLookup, getSafeDispatcher, fetchImage } from '../src/core/net.js'

/** 把 (addr, family) / 数组两种回调约定统一成可断言的结果。 */
function callLookup(hostname, opts) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) resolve({ timedOut: true })
    }, 500)
    const cb = (...args) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ args })
    }
    if (opts === undefined) safeLookup(hostname, cb)
    else safeLookup(hostname, opts, cb)
  })
}

test('T1.1 safeLookup(host, opts, cb)：localhost 在 500ms 内回调并拒内网', async () => {
  const res = await callLookup('localhost', { all: true })
  assert.equal(res.timedOut, undefined, 'safeLookup 必须在 500ms 内回调（Promise 版 lookup 会永不回调）')
  const [err] = res.args
  assert.ok(err instanceof Error, 'localhost 解析到回环地址，必须报错')
  assert.match(err.message, /内网/)
})

test('T1.1 safeLookup 两参兼容：私网字面量拒、公网字面量回 (address, family)', async () => {
  const priv = await callLookup('127.0.0.1')
  assert.equal(priv.timedOut, undefined)
  assert.match(priv.args[0]?.message || '', /内网/, '127.0.0.1 必须被拒')

  const pub = await callLookup('1.1.1.1')
  assert.equal(pub.timedOut, undefined)
  assert.equal(pub.args[0], null, '公网字面量不应报错')
  assert.equal(pub.args.length, 3, 'opts.all 缺省时回调必须是 (err, address, family)')
  assert.equal(pub.args[1], '1.1.1.1')
  assert.equal(pub.args[2], 4)
})

test('T1.1 safeLookup(host, { all: true }, cb)：opts.all 时回地址数组给 undici', async () => {
  const res = await callLookup('1.1.1.1', { all: true })
  assert.equal(res.timedOut, undefined)
  const [err, addresses] = res.args
  assert.equal(err, null)
  assert.ok(Array.isArray(addresses), 'all: true 必须回数组（undici connect.lookup 约定）')
  assert.equal(addresses.length, 1)
  assert.equal(addresses[0].address, '1.1.1.1')
  assert.equal(addresses[0].family, 4)

  const priv = await callLookup('127.0.0.1', { all: true })
  assert.match(priv.args[0]?.message || '', /内网/)
})

test('T1.1 isPrivateV6 补齐 IPv4-translated / fec0::/10 / Teredo', () => {
  assert.equal(isPrivateIp('::ffff:0:127.0.0.1'), true, 'RFC 2765 SIIT 内嵌回环必须拦')
  assert.equal(isPrivateIp('::ffff:0:10.0.0.7'), true, 'SIIT 内嵌私网必须拦') /* pii-scan:ignore */
  assert.equal(isPrivateIp('fec0::1'), true, '旧站本地 fec0::/10 必须拦')
  assert.equal(isPrivateIp('2001:0000:4136:e378::1'), true, 'Teredo 2001::/32 必须拦')
  // 公网 IPv6 不能误伤
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::1']) {
    assert.equal(isPrivateIp(ip), false, `${ip} 是公网`)
  }
})

test('T1.1 undici dispatcher 全模块复用一份（不再每跳 new Agent）', async () => {
  const first = await getSafeDispatcher()
  const second = await getSafeDispatcher()
  assert.equal(first, second, 'dispatcher 必须惰性单例复用')
  assert.equal(typeof first.dispatch, 'function', '返回的必须是可用 undici Agent')
})

test('T1.1 fetchImage：重定向丢弃响应体 cancel、5 跳后抛「重定向次数过多」', async () => {
  const dispatcher = await getSafeDispatcher()
  const originalFetch = globalThis.fetch
  let calls = 0
  let canceled = 0
  const seenDispatchers = []
  globalThis.fetch = async (url, options) => {
    calls += 1
    seenDispatchers.push(options?.dispatcher)
    return {
      status: 302,
      ok: false,
      headers: new Headers({ location: `/hop-${calls}` }),
      body: {
        cancel: async () => { canceled += 1 },
      },
    }
  }
  try {
    await assert.rejects(
      () => fetchImage('http://1.1.1.1/start'),
      /重定向次数过多/,
    )
    assert.equal(calls, 5, '最多跟 5 跳就必须停')
    assert.equal(canceled, 5, '每一跳被丢弃的响应体都要 cancel')
    assert.equal(seenDispatchers.length, 5)
    for (const d of seenDispatchers) assert.equal(d, dispatcher, '每跳都用同一个安全 dispatcher')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('T1.1 safeLookup 按 options.family 过滤（不回错协议族）', async () => {
  const v4 = await callLookup('1.1.1.1', { family: 4, all: true })
  assert.equal(v4.args[0], null)
  assert.deepEqual(v4.args[1].map((x) => x.family), [4], 'family=4 只回 v4')

  const single = await callLookup('1.1.1.1', { family: 4 })
  assert.equal(single.args[1], '1.1.1.1')
  assert.equal(single.args[2], 4)

  const v6 = await callLookup('1.1.1.1', { family: 6 })
  assert.match(v6.args[0]?.message || '', /IPv6/, '只要 v6 时不能把 v4 结果回过去')
})

test('T1.1 fetchImage：非 2xx 与超限响应都先 cancel 体再抛（不拖住单例连接池）', async () => {
  const originalFetch = globalThis.fetch
  let canceled = 0
  const resp = (status, headers = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    body: { cancel: async () => { canceled += 1 } },
  })
  try {
    globalThis.fetch = async () => resp(404)
    await assert.rejects(() => fetchImage('http://1.1.1.1/x'), /HTTP 404/)
    assert.equal(canceled, 1, '非 2xx 响应体必须 cancel')

    canceled = 0
    globalThis.fetch = async () => resp(200, { 'content-length': String(50 * 1024 * 1024) })
    await assert.rejects(() => fetchImage('http://1.1.1.1/x', { maxBytes: 1024 }), /太大了/)
    assert.equal(canceled, 1, '声明超限的响应体也必须 cancel')
  } finally {
    globalThis.fetch = originalFetch
  }
})
