// M1-A 面板安全边界验证与修复（modular 重构阶段任务书 M1-A）
//
// 防护位于插件层（src/host/panel/guard.js，接线于 src/host/http.js 与 host.js 模块前缀路由）；
// DSH 外层是否等效防护属部署形态（M5 fnOS 实测），插件层按「无则补齐」自证：
//   1. 未授权请求（伪造 Host / 跨站 Origin / cross-site fetch）不能产生副作用；
//   2. 合法面板流程（回环/局域网 IP 直访、同源写请求）不回归；
//   3. trusted proxy 结论：判定只依赖 Host/Origin/Sec-Fetch-Site，X-Forwarded-* 不参与决策
//      （伪造 XFF 无收益——guard 根本不读它）。
//
// 覆盖面：guard 单元边界 + 走真实 HTTP 栈的副作用路由（/save、/workspaces/delete 同型）矩阵。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'

const require = createRequire(import.meta.url)

import { createPanelGuard, hostNameOf } from '../src/host/panel/guard.js'
import { createHttpKit } from '../src/host/http.js'

// ---------- guard 单元边界 ----------

test('hostNameOf：剥端口、认 IPv6 括号形态', () => {
  assert.equal(hostNameOf('127.0.0.1:8080'), '127.0.0.1')
  assert.equal(hostNameOf('localhost:3000'), 'localhost')
  assert.equal(hostNameOf('192.168.1.5'), '192.168.1.5')
  assert.equal(hostNameOf('[::1]:8080'), '::1')
  assert.equal(hostNameOf('nas.example.com:5666'), 'nas.example.com')
  assert.equal(hostNameOf(''), '')
})

test('Host 白名单：回环/IP 字面量放行，域名默认拒绝，allowedHosts 显式放行（每请求现读）', () => {
  let allowedHosts = []
  const guard = createPanelGuard({ getConfig: () => ({ security: { panel: { allowedHosts } } }), log: null })
  const ok = (host) => assert.equal(guard.hostAllowed(host), true, host)
  const no = (host) => assert.equal(guard.hostAllowed(host), false, host)

  ok('localhost:5666')
  ok('127.0.0.1:5666')
  ok('192.168.1.66:5666')
  ok('[::1]:5666')
  no('evil.com:80')
  no('nas.example.com:5666') // 未登记的域名拒绝（rebinding 的 Host 就是攻击域名）
  no('')                     // 缺 Host：HTTP/1.1 必带，缺了就可疑

  allowedHosts = ['nas.example.com']
  ok('nas.example.com:5666') // 配置登记后放行（热生效）
  no('other.example.com:80')
})

test('CSRF：跨站 Origin/无证据的 cross-site 拒绝；同源与无浏览器证据放行；GET 不受限', () => {
  const guard = createPanelGuard({ getConfig: () => ({ security: { panel: { allowedHosts: [] } } }), log: null })
  const req = (method, headers) => ({ method, headers })

  // 同源写请求：Origin 与 Host 一致 → 放行
  assert.equal(guard.check(req('POST', { host: '127.0.0.1:5666', origin: 'http://127.0.0.1:5666' })).ok, true)
  // 跨站写请求：Origin 不同 → 拒
  assert.equal(guard.check(req('POST', { host: '127.0.0.1:5666', origin: 'http://evil.com' })).ok, false)
  // Origin:null（沙箱 iframe / file://）→ 拒
  assert.equal(guard.check(req('POST', { host: '127.0.0.1:5666', origin: 'null' })).ok, false)
  // 无 Origin 但声明 cross-site → 拒
  assert.equal(guard.check(req('POST', { host: '127.0.0.1:5666', 'sec-fetch-site': 'cross-site' })).ok, false)
  // 无 Origin、same-site/none → 放行
  assert.equal(guard.check(req('POST', { host: '127.0.0.1:5666', 'sec-fetch-site': 'same-site' })).ok, true)
  // 都没有（curl/脚本）→ 放行（CSRF 由浏览器发起，浏览器必留证据）
  assert.equal(guard.check(req('POST', { host: '127.0.0.1:5666' })).ok, true)
  // GET 没有 CSRF 语义（无副作用约定），只受 Host 白名单约束
  assert.equal(guard.check(req('GET', { host: 'evil.com' })).ok, false)
  assert.equal(guard.check(req('GET', { host: '127.0.0.1:5666' })).ok, true)
})

// ---------- 真实 HTTP 栈：副作用路由端到端 ----------

let server, baseUrl, workDir
let saveCount = 0
let kit

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'panel-guard-'))
  // fake ctx：收集 webServer 注册
  const registered = []
  const ctx = {
    effect: (fn) => fn(),
    webServer: { register: (def) => registered.push(def) },
  }
  let allowedHosts = []
  kit = createHttpKit({
    ctx,
    prefix: '/qq-hub/api',
    getConfig: () => ({ security: { panel: { allowedHosts } } }),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  })
  // 一条有副作用的写路由 + 一条只读路由（与 /save、/state 同型）
  kit.route('/save', async () => { saveCount++; return { ok: true, saved: true } })
  kit.route('/state', async () => ({ ok: true, state: 'read-only' }))
  assert.equal(registered.length, 2, '两条路由都登记了')
  const handler = (path) => registered.find((r) => r.path === '/qq-hub/api' + path)?.handler

  server = createServer((req, res) => {
    const h = handler(req.url) || handler('/state')
    if (h) return h(req, res)
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  kit._setAllowedHosts = (v) => { allowedHosts = v }
})

after(async () => {
  server?.close()
  try { rmSync(workDir, { recursive: true, force: true }) } catch {}
})

function raw({ method = 'GET', path = '/state', host, origin, secFetchSite, body } = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port
    const req = httpRequest({
      host: '127.0.0.1', port, method, path,
      headers: {
        ...(host !== undefined ? { host } : {}),
        ...(origin !== undefined ? { origin } : {}),
        ...(secFetchSite !== undefined ? { 'sec-fetch-site': secFetchSite } : {}),
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ code: res.statusCode, body: data }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

test('合法流程：回环 GET 只读、同源 POST 写路由、局域网 IP 直访写请求都正常', async () => {
  const port = server.address().port
  const loop = host(`127.0.0.1:${port}`)
  const read = await raw({ method: 'GET', path: '/state', host: loop })
  assert.equal(read.code, 200)
  assert.match(read.body, /read-only/)

  saveCount = 0
  const write = await raw({ method: 'POST', path: '/save', host: loop, origin: `http://127.0.0.1:${port}`, body: '{}' })
  assert.equal(write.code, 200)
  assert.equal(saveCount, 1, '同源写请求产生副作用（合法面板流程不回归）')

  // 局域网 IP 直访（Host 是 IP 字面量）+ 无浏览器头（脚本客户端）→ 放行
  const lan = await raw({ method: 'POST', path: '/save', host: `192.168.9.9:${port}`, body: '{}' })
  assert.equal(lan.code, 200)
  assert.equal(saveCount, 2, '局域网 IP 直访不受影响')
})

test('未授权请求矩阵：伪造 Host / 跨站 Origin / cross-site fetch 都拿不到副作用', async () => {
  const port = server.address().port
  saveCount = 0

  // 1. DNS rebinding：Host 是攻击域名 → 403，副作用为零
  const rebinding = await raw({ method: 'POST', path: '/save', host: 'evil.com', body: '{}' })
  assert.equal(rebinding.code, 403)
  assert.equal(saveCount, 0, '伪造 Host 的写请求零副作用')

  // 2. 跨站 CSRF：Origin 指向别处 → 403
  const csrf = await raw({ method: 'POST', path: '/save', host: `127.0.0.1:${port}`, origin: 'http://evil.com', body: '{}' })
  assert.equal(csrf.code, 403)
  assert.equal(saveCount, 0, '跨站 Origin 的写请求零副作用')

  // 3. 无 Origin 的 cross-site 浏览器 fetch（老浏览器表单路径）→ 403
  const cross = await raw({ method: 'POST', path: '/save', host: `127.0.0.1:${port}`, secFetchSite: 'cross-site', body: '{}' })
  assert.equal(cross.code, 403)
  assert.equal(saveCount, 0, 'cross-site 无 Origin 写请求零副作用')

  // 4. 缺 Host 头 → Node HTTP 解析层直接 400（比 guard 更靠前的协议级拒绝；HTTP/1.1 必带 Host）
  const noHost = await new Promise((resolve, reject) => {
    const net = require('node:net')
    const sock = net.connect(server.address().port, '127.0.0.1', () => {
      sock.write('POST /qq-hub/api/save HTTP/1.1\r\ncontent-length: 2\r\n\r\n{}')
    })
    let data = ''
    sock.on('data', (c) => { data += c; try { sock.end() } catch {} })
    sock.on('end', () => resolve({ code: Number((data.match(/^HTTP\/[\d.]+ (\d+)/) || [])[1]) }))
    sock.on('error', reject)
  })
  assert.ok(noHost.code >= 400, `缺 Host 的写请求必须被拒（实际 ${noHost.code}：解析层 400 或 guard 403）`)
  assert.equal(saveCount, 0)

  // 5. 只读路由同样受 Host 白名单约束（信息不外泄给 rebinding 页面）
  const readViaEvil = await raw({ method: 'GET', path: '/state', host: 'evil.com' })
  assert.equal(readViaEvil.code, 403)
})

test('allowedHosts 登记后：域名访问放行（配置热生效，无需重启）', async () => {
  const port = server.address().port
  kit._setAllowedHosts([])
  assert.equal((await raw({ method: 'POST', path: '/save', host: `nas.example.com:${port}`, body: '{}' })).code, 403)
  kit._setAllowedHosts(['nas.example.com'])
  const okRes = await raw({ method: 'POST', path: '/save', host: `nas.example.com:${port}`, body: '{}' })
  assert.equal(okRes.code, 200, '登记域名后放行')
  kit._setAllowedHosts([])
})

test('trusted proxy 结论：X-Forwarded-For 伪造不参与判定（guard 不读代理头）', async () => {
  const port = server.address().port
  saveCount = 0
  // 伪造 XFF 装成内网来源 + 伪造 Host：仍按 Host 白名单拒绝
  const spoofed = await new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port, method: 'POST', path: '/save',
      headers: { host: 'evil.com', 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' },
    }, (res) => { let d = ''; res.on('data', (c) => { d += c }); res.on('end', () => resolve({ code: res.statusCode, d })) })
    req.on('error', reject)
    req.end('{}')
  })
  assert.equal(spoofed.code, 403, '代理头伪装不改变判定')
  assert.equal(saveCount, 0)
})

function host(h) { return h } // 语义占位：保持断言文案可读
