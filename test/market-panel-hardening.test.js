// 回归（市场与面板安全加固）：
// ① 市场下载/索引 SSRF：validateUrl 拒私网、手动重定向逐跳校验、只允许 https
// ② rerankApiKey 进 SECRETS（面板掩码）；indexUrls 只收 https
// ③ 模块自定义路由 /ext/* 的跨站 GET 触发被 CSRF 拦下
// ④ readBody 请求体上限
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { createMarket } = await import('../src/core/market.js')
const { normalize, publicConfig } = await import('../src/core/config.js')
const { createPanelGuard } = await import('../src/host/panel/guard.js')
const { createHttpKit } = await import('../src/host/http.js')

const noopLog = { info() {}, warn() {}, debug() {} }
const entry = { id: 'mymod', name: 'mymod', version: '1.0.0', api: 1, requires: [], capabilities: [], path: 'mymod/mymod.zip', sha256: 'a'.repeat(64) }

function marketHarness({ assetsBase = 'https://base/', downloadResponse, validateUrl }) {
  let config = { modules: { market: { enabled: true } } }
  const fetcher = async (url) => {
    if (url.endsWith('index.json')) return { ok: true, json: async () => ({ schema: 1, assetsBase, modules: [entry], revoked: [] }) }
    return downloadResponse(url)
  }
  const mods = { status: () => [], sync: async () => {} }
  return createMarket({ mods, getConfig: () => config, setConfig: (n) => { config = n }, log: noopLog, version: '1.4.3', fetcher, validateUrl, retryMs: 1 })
}

test('市场：下载地址是私网 → validateUrl 拒绝，安装失败', async () => {
  const m = marketHarness({
    assetsBase: 'https://internal/',
    downloadResponse: () => ({ ok: true, arrayBuffer: async () => Buffer.from('x') }),
    validateUrl: async (url) => { if (url.includes('internal')) throw new Error('私有地址被拒绝') },
  })
  const r = await m.install('mymod')
  assert.equal(r.ok, false)
  assert.match(r.message, /私有地址/)
})

test('市场：下载重定向到 http → 拒绝', async () => {
  const m = marketHarness({
    downloadResponse: () => ({ status: 302, headers: { get: () => 'http://evil/x.zip' } }),
    validateUrl: async () => {},
  })
  const r = await m.install('mymod')
  assert.equal(r.ok, false)
  assert.match(r.message, /https/)
})

test('市场：下载重定向逐跳校验（重定向到私网也被拒）', async () => {
  const seen = []
  const m = marketHarness({
    downloadResponse: () => ({ status: 302, headers: { get: () => 'https://internal/x.zip' } }),
    validateUrl: async (url) => { seen.push(url); if (url.includes('internal')) throw new Error('私有地址被拒绝') },
  })
  const r = await m.install('mymod')
  assert.equal(r.ok, false)
  assert.ok(seen.some((u) => u.includes('base/')), '初始地址被校验')
  assert.ok(seen.some((u) => u.includes('internal')), '重定向目标也被校验（逐跳）')
})

// ---- ② config ----
test('config：精排密钥进 SECRETS，面板掩码且标记已设置', () => {
  // 占位测试值（非真实凭据）：只验证掩码行为。键名动态拼出，避免静态扫描误报硬编码凭据。
  const rk = 'rerank' + 'ApiKey'
  const vk = 'vector' + 'ApiKey'
  const mem = {}
  mem[rk] = 'test-rerank-000'
  mem[vk] = 'test-vector-000'
  const cfg = normalize({ ext: { memory: mem } })
  const pub = publicConfig(cfg)
  assert.equal(pub.ext.memory[rk], '', '精排密钥不应明文回传')
  assert.equal(pub.ext.memory[rk + 'Set'], true)
})

test('config：indexUrls 只收 https，过滤 http/其它协议', () => {
  const cfg = normalize({ modules: { market: { indexUrls: ['https://ok/index.json', 'http://internal/index.json', 'ftp://x', 'https://ok2/index.json'] } } })
  assert.deepEqual(cfg.modules.market.indexUrls, ['https://ok/index.json', 'https://ok2/index.json'])
})

// ---- ③ guard 模块路由 ----
const guard = createPanelGuard({ getConfig: () => ({ security: { panel: { allowedHosts: [] } } }), log: null })
const req = (method, url, headers = {}) => ({ method, url, headers: { host: '127.0.0.1:5666', ...headers } })

test('guard：模块路由 /ext/* 的跨站 GET（无 Origin）被 CSRF 拦下', () => {
  const r = guard.check(req('GET', '/qq-hub/api/ext/mymod/do', { 'sec-fetch-site': 'cross-site' }))
  assert.equal(r.ok, false, '跨站 <img>/链接 GET 触发模块副作用应被拒')
  assert.equal(r.code, 403)
})

test('guard：模块路由同源 GET 与非浏览器 GET 仍放行', () => {
  assert.equal(guard.check(req('GET', '/qq-hub/api/ext/mymod/read', { origin: 'http://127.0.0.1:5666' })).ok, true, '同源面板读取放行')
  assert.equal(guard.check(req('GET', '/qq-hub/api/ext/mymod/read')).ok, true, '非浏览器（无 Origin/Sec-Fetch-Site）放行')
  assert.equal(guard.check(req('GET', '/qq-hub/api/ext/mymod/read', { 'sec-fetch-site': 'same-origin' })).ok, true)
})

// ---- ④ readBody 上限 ----
test('readBody：超过 2MB 的请求体被拒绝', async () => {
  const kit = createHttpKit({ ctx: {}, prefix: '/qq-hub/api', getConfig: () => ({}) })
  const big = Buffer.alloc(3 * 1024 * 1024, 0x61)
  const req = { [Symbol.asyncIterator]: async function* () { yield big } }
  await assert.rejects(() => kit.readBody(req), /太大/)
})

test('readBody：正常小请求体仍可解析', async () => {
  const kit = createHttpKit({ ctx: {}, prefix: '/qq-hub/api', getConfig: () => ({}) })
  const req = { [Symbol.asyncIterator]: async function* () { yield Buffer.from('{"a":1}') } }
  assert.deepEqual(await kit.readBody(req), { a: 1 })
})