import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import memoryModule from '../src/modules/memory/index.js'
import { createHttpKit } from '../src/host/http.js'

test('记忆模块 HTTP：外改→安全重载→召回；损坏可诊断且修复后恢复', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-module-reload-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const registered = []
  const config = () => ({ memory: { enabled: true, recallCount: 4 }, persona: { current: '' } })
  const log = { info() {}, warn() {}, error() {}, debug() {} }
  const kit = createHttpKit({ ctx: { effect: (fn) => fn(), webServer: { register: (def) => registered.push(def) } }, prefix: '/qq-hub/api', getConfig: config, log })
  const memory = memoryModule.setup({ core: { hub: {}, http: { query: kit.query, body: kit.readBody } }, dsh: {}, config, log, route: kit.route, context() {}, on() {}, every() {}, tool() {}, use: () => null })
  const server = createServer((req, res) => {
    const route = registered.find((def) => def.path === new URL(req.url, 'http://localhost').pathname)
    if (route) return route.handler(req, res)
    res.writeHead(404).end()
  })
  t.after(async () => {
    memory.dispose()
    await new Promise((resolve) => server.close(resolve))
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/qq-hub/api`
  const request = async (path, method = 'GET', body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, data: await res.json() }
  }
  assert.equal((await request('/memory/add', 'POST', { text: '初始档案正文' })).data.ok, true)
  const file = join(dir, 'memory/global/memory.md')
  const raw = readFileSync(file, 'utf8')
  writeFileSync(file, raw.replace('初始档案正文', '人工修改后的正文'))
  assert.equal((await request('/memory/reload')).status, 405)
  assert.equal((await request('/memory/reload', 'POST', {}, { origin: 'http://evil.example' })).status, 403)
  assert.equal(memory.list()[0].text, '初始档案正文')
  assert.equal((await request('/memory/reload', 'POST', {})).data.ok, true)
  assert.equal((await request('/memories')).data.items[0].text, '人工修改后的正文')
  assert.equal(memory.recall('人工修改', { scopes: ['global'] }).length, 1)
  writeFileSync(file, '---\n损坏档案')
  const broken = (await request('/memory/reload', 'POST', {})).data
  assert.equal(broken.ok, false)
  assert.equal(broken.health.brokenScopes.length, 1)
  assert.equal((await request('/memories')).data.health.ok, false)
  writeFileSync(file, raw)
  assert.equal((await request('/memory/reload', 'POST', {})).data.health.ok, true)
  assert.equal((await request('/memory/add', 'POST', { text: '恢复后新增' })).data.ok, true)
})
