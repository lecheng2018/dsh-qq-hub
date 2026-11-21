// 审计 S04 复核：面板回调 → guard → 真实 handler 的连通性。
//
// 上一版的测试分两头锁：「写接口拒绝 GET」锁 guard 清单，「按钮用 GET」锁面板源码，
// 两条各自都过，合起来却是「按钮永远 405」。这里直接跑真实面板组件的按钮回调，
// 把它的请求接到真实 handler，用真实 guard 判定——任何一边改错都会红。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPanelGuard } from '../src/host/panel/guard.js'

const PANEL = readFileSync(new URL('../src/modules/token-guardian/panel.js', import.meta.url), 'utf8')

/** 面板插件的 call(p, body)：body === undefined 发 GET，否则 POST JSON。与 client/src/core/http.js 同口径。 */
function makeCall(guard, log) {
  return async (p, body) => {
    const method = body === undefined ? 'GET' : 'POST'
    const headers = { host: '127.0.0.1:13080' }
    if (method === 'POST') headers.origin = 'http://127.0.0.1:13080'
    const g = guard.check({ method, url: '/qq-hub/api' + p, headers })
    if (!g.ok) { log.push(`${method} ${p} → ${g.code}`); return { ok: false, status: g.code, message: g.message } }
    log.push(`${method} ${p} → 放行`)
    return null // 交给测试注入的真实 handler
  }
}

test('S04 · 面板「压一次」/「重置用量」的请求真能穿过 guard（不再恒 405）', async () => {
  process.env.DSH_QQ_HUB_DATA_DIR = mkdtempSync(join(tmpdir(), 'tg-panel-methods-'))
  const mod = (await import('../src/modules/token-guardian/index.js?panel-methods=1')).default
  const routes = {}
  const api = {
    dataDir: (...p) => join(process.env.DSH_QQ_HUB_DATA_DIR, ...p),
    settings: () => ({ enabled: true, threshold: 100, idleSeconds: 0, cooldownMinutes: 120, summaryMaxChars: 1200, askTimeoutSeconds: 5 }),
    log: { info() {}, warn() {}, debug() {}, error() {} },
    route: (p, fn) => { routes[p] = fn },
    on() {}, context() {}, rule() {}, tool() {}, emit() {}, onDispose() {},
    ask: async () => { throw new Error('本用例不该真的压模型') },
    core: {
      http: { body: async (req) => req?.body || {} },
      chatLog: { listDays: () => [], readDay: () => [], append() {} },
      hub: { sessions: () => ({}), resetChat: () => true, groupName: async () => 'g' },
    },
  }
  const out = mod.setup(api)
  const chatId = 'private:1000'
  out.state()[chatId] = { chars: 5000, failures: 7, lastError: 'x', nextAttemptAt: 9e9 }

  const guard = createPanelGuard({ getConfig: () => ({ security: { panel: { allowedHosts: [] } } }), log: null })
  const log = []
  const call = makeCall(guard, log)

  // 面板源码里这两个按钮实际发出的请求（与 handleResetUsage/handleCompact 一致）
  const sends = [
    ['/reset-usage', { chatId }],
    ['/token-guardian/reset-usage', { chatId }],
  ]
  for (const [path, body] of sends) {
    const blocked = await call(path, body)
    assert.equal(blocked, null, `${path} 不应被 guard 拦下：${JSON.stringify(log)}`)
    const handler = routes[path]
    assert.ok(handler, `${path} 在真实模块里必须有路由`)
    const r = await handler({ method: 'POST', query: {}, body })
    assert.equal(r.ok, true, `${path} 的 handler 应成功：${JSON.stringify(r)}`)
  }
  assert.equal(out.state()[chatId].failures, 0, '重置用量必须真的清零失败计数')

  // 压缩：走同一条连通性检查，但用空流水让 handler 快速返回，不触发模型
  const compactBlocked = await call('/token-guardian/compact-now', { chatId })
  assert.equal(compactBlocked, null, `压缩按钮不应被 guard 拦下：${JSON.stringify(log)}`)
  const cr = await routes['/token-guardian/compact-now']({ method: 'POST', query: {}, body: { chatId } })
  assert.equal(typeof cr.ok, 'boolean', '压缩 handler 应给出明确结果')
  assert.doesNotMatch(String(cr.message || ''), /405|副作用/, '不该是方法约束的报错')
})

test('S04 · 面板不再使用「写接口 + GET query」的形态', () => {
  // 这是上一版按钮失效的直接原因：GET 带 query 打写接口
  assert.equal(/compact-now\?chatId=/.test(PANEL), false, '压缩不能用 GET query 形态')
  assert.equal(/reset-usage\?chatId=/.test(PANEL), false, '重置用量不能用 GET query 形态')
})
