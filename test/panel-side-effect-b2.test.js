// Batch 2 / T2.2：面板精确路由 opts.sideEffect 丢传 + 扩展/内置路由副作用默认保护。
// 全部用例都真实调用 createHttpKit.route / guard.check / 扩展的 setup()，不做源码正则匹配。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHttpKit } from '../src/host/http.js'
import { createPanelGuard } from '../src/host/panel/guard.js'
import tiebaReader from '../extensions/tieba-reader/index.mjs'
import distill from '../extensions/distill/index.mjs'

const HOST = '127.0.0.1:5666'
const log = { debug() {}, info() {}, warn() {}, error() {} }

function fakeRes () {
  return {
    statusCode: 200,
    headers: {},
    setHeader (k, v) { this.headers[k] = v },
    end (body) { this.body = body },
    write (body) { this.body = body },
  }
}

/** 建一个真实走 guardedAnswer → guard 的路由池，返回可直接调用的 handler。 */
function kitWithRoute (path, opts) {
  const registered = []
  const kit = createHttpKit({
    ctx: { effect: (fn) => fn(), webServer: { register: (def) => registered.push(def) } },
    prefix: '/qq-hub/api',
    getConfig: () => ({}),
    log,
  })
  kit.route(path, async () => ({ ok: true, hit: true }), opts)
  const handler = registered.find((r) => r.path === '/qq-hub/api' + path)?.handler
  assert.ok(handler, '路由已登记')
  return handler
}

async function call (handler, method, path, extraHeaders = {}) {
  const res = fakeRes()
  await handler({ method, url: path, headers: { host: HOST, ...extraHeaders } }, res)
  return res
}

test('T2.2：route(path, handler, { sideEffect: true }) 的 GET 真被 405 拦下（meta 不再丢）', async () => {
  const handler = kitWithRoute('/test-se', { sideEffect: true })
  const get = await call(handler, 'GET', '/qq-hub/api/test-se')
  assert.equal(get.statusCode, 405, `GET 应 405，实际 ${get.statusCode} / ${get.body}`)
  assert.doesNotMatch(String(get.body), /hit/, 'GET 不应进 handler')

  const post = await call(handler, 'POST', '/qq-hub/api/test-se')
  assert.equal(post.statusCode, 200)
  assert.match(String(post.body), /"hit":true/, 'POST 正常进 handler')
})

test('T2.2：sideEffect: false / 未声明的只读路由 GET 仍放行（防清单扩散误伤）', async () => {
  const readOnly = kitWithRoute('/test-read', { sideEffect: false })
  assert.equal((await call(readOnly, 'GET', '/qq-hub/api/test-read')).statusCode, 200)
  const plain = kitWithRoute('/test-plain', {})
  assert.equal((await call(plain, 'GET', '/qq-hub/api/test-plain')).statusCode, 200)
})

test('T2.2：/memory/import 与 /persona/rebuild-stale 进副作用表，GET 405 / POST 放行', () => {
  const guard = createPanelGuard({ getConfig: () => ({}), log, prefix: '/qq-hub/api' })
  for (const path of ['/qq-hub/api/memory/import', '/qq-hub/api/persona/rebuild-stale']) {
    const get = guard.check({ method: 'GET', url: path, headers: { host: HOST } })
    assert.equal(get.ok, false, `${path} 的 GET 应被拒`)
    assert.equal(get.code, 405, `${path} 的 GET 应 405`)
    const post = guard.check({ method: 'POST', url: path, headers: { host: HOST } })
    assert.equal(post.ok, true, `${path} 的 POST 应放行`)
  }
})

test('T2.2：Sec-Fetch-Site=same-site 与 cross-site 一样拒；same-origin / none 放行', () => {
  const guard = createPanelGuard({ getConfig: () => ({}), log, prefix: '/qq-hub/api' })
  const at = (site) => guard.check({ method: 'POST', url: '/qq-hub/api/save', headers: { host: HOST, 'sec-fetch-site': site } })
  assert.equal(at('cross-site').code, 403)
  assert.equal(at('same-site').code, 403, '多子域 same-site 的无 Origin 改写请求也要拒')
  assert.equal(at('same-origin').ok, true)
  assert.equal(at('none').ok, true)
})

/** 用最小 api 桩真实跑扩展 setup()，收集它登记的 (path, sideEffect)。 */
function extensionRoutes (mod, dataDir, core = {}) {
  const calls = []
  const noop = () => {}
  const api = new Proxy({
    dataDir: (f) => join(dataDir, f || ''),
    lib: () => new Proxy({}, { get: () => noop }),
    settings: () => ({ enabled: true }),
    setConfig: noop,
    config: () => ({}),
    log,
    every: () => noop,
    route: (path, _handler, opts = {}) => calls.push({ path, sideEffect: opts.sideEffect }),
    core: { http: { body: async () => ({}) }, ...core },
  }, { get: (target, key) => (key in target ? target[key] : noop) })
  mod.setup(api, {})
  return calls
}

test('T2.2：贴吧扩展写路由 sideEffect: true，只读路由 false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b2-tieba-'))
  try {
    const map = Object.fromEntries(extensionRoutes(tiebaReader, dir).map((r) => [r.path, r.sideEffect]))
    for (const path of ['/login', '/share', '/logout']) {
      assert.equal(map[path], true, `${path} 必须声明 sideEffect: true`)
    }
    for (const path of ['/state', '/account', '/preview']) {
      assert.equal(map[path], false, `${path} 应显式声明只读`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('T2.2：distill 扩展 10 条写/LLM 路由 sideEffect: true，只读路由 false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b2-distill-'))
  try {
    const map = Object.fromEntries(extensionRoutes(distill, dir, { chatLogDir: dir }).map((r) => [r.path, r.sideEffect]))
    for (const path of ['/status', '/rules']) {
      assert.equal(map[path], false, `${path} 应显式声明只读`)
    }
    const writes = ['/promote', '/prune-noise', '/consolidate', '/toggle-lock', '/delete-rule', '/add-manual', '/clear-all', '/trigger-now', '/distill-history', '/simulate']
    for (const path of writes) {
      assert.equal(map[path], true, `${path} 必须声明 sideEffect: true`)
    }
    assert.equal(writes.length, 10)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
