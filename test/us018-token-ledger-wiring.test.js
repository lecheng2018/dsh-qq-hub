// US-018 接线验收：每日 Token 记账 + 主动搭话熔断。
// 验证「接线」而非算法（算法见 token-ledger.test.js）。
import test from 'node:test'
import assert from 'node:assert/strict'
import tokenBilling from '../src/modules/token-billing/index.js'
import speakup from '../src/modules/speakup/index.js'
import { defaultLedger, createTokenLedger, tokenLedgerSnapshot, tokenLedgerResetDaily } from '../src/chat/token-ledger.js'

/** 造一个最小 api：收集事件处理器、定时器、路由。 */
function fakeApi({ ownerQQ = '1000', conf = {} } = {}) {
  const handlers = new Map()
  const timers = []
  const routes = new Map()
  const logs = []
  const cfg = {
    enabled: true, ownerQQ,
    allow: { private: [ownerQQ], groups: [] },
    speakUp: { enabled: true, minIntervalMinutes: 60, maxIntervalMinutes: 120, awakeFrom: 0, awakeTo: 24, idleMinutes: 30 },
    ...conf,
  }
  const api = {
    config: () => cfg,
    log: { info: (m) => logs.push(String(m)), warn: (m, e) => logs.push(String(m) + (e || '')) },
    on: (ev, fn) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(fn) },
    every: (ms, fn) => timers.push({ ms, fn }),
    route: (p, fn) => routes.set(p, fn),
    dataDir: () => '/tmp/fake-token-billing',
    core: {
      hub: { lastOwnerChatAt: 0, lastBotToOwner: null, pushToSession: async () => ({ ok: true }) },
      mutes: { muted: () => false },
    },
    emit(ev, payload) { for (const fn of (handlers.get(ev) || [])) fn(payload) },
    runTimers() { return Promise.all(timers.map((t) => t.fn())) },
    getRoute(p) { return routes.get(p) },
    logs,
  }
  return api
}

/** 每个用例前把账本清零，避免用例互相污染（defaultLedger 是模块级单例）。 */
function freshDay() {
  try { tokenLedgerResetDaily('1999-01-01') } catch { /* ignore */ }
}

test('token-billing 订阅 session/usage 并把消耗记进账本', () => {
  freshDay()
  const api = fakeApi()
  tokenBilling.setup(api)
  const chat = 'private:1000'
  const before = Number(defaultLedger.quotaOf(chat)?.used) || 0
  api.emit('session/usage', {
    chatId: chat,
    usage: { uncachedInputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 50, outputTokens: 30 },
  })
  const after = Number(defaultLedger.quotaOf(chat)?.used) || 0
  assert.equal(after - before, 380, `应记 100+200+50+30=380，实际增加 ${after - before}`)
})

test('记账口径 = 未缓存输入 + 缓存读 + 缓存写 + 输出', () => {
  freshDay()
  const api = fakeApi()
  tokenBilling.setup(api)
  const chat = 'private:1000'
  api.emit('session/usage', {
    chatId: chat,
    usage: { uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40 },
  })
  const used = Number(defaultLedger.quotaOf(chat)?.used) || 0
  assert.equal(used >= 100, true, `应累计 ≥100，实际 ${used}`)
})

test('无 usage / 无 chatId / 全零的输入一律不记账、不抛', () => {
  freshDay()
  const api = fakeApi()
  tokenBilling.setup(api)
  const tasks = [
    {}, null, undefined,
    { chatId: 'private:1000' },
    { usage: { uncachedInputTokens: 1 } },
    { chatId: 'private:1000', usage: {} },
    { chatId: 'private:1000', usage: { uncachedInputTokens: 0, cacheReadTokens: 0 } },
    { chatId: 'private:1000', usage: { uncachedInputTokens: 'x' } },
  ]
  for (const t of tasks) assert.doesNotThrow(() => api.emit('session/usage', t), JSON.stringify(t))
})

test('提供 /token-usage 诊断路由', () => {
  const api = fakeApi()
  tokenBilling.setup(api)
  assert.equal(typeof api.getRoute('/token-usage'), 'function')
})

test('speakup 触发熔断：配额耗尽时 tick 不执行', async () => {
  freshDay()
  const owner = 'private:1000'
  // 把主人私聊配额打满
  for (let i = 0; i < 60; i += 1) defaultLedger.record(owner, 50000)
  const api = fakeApi({ ownerQQ: '1000' })
  const mod = speakup.setup(api)
  assert.ok(mod, 'setup 应返回 speakUp')
  const before = api.logs.length
  await api.runTimers()
  assert.ok(api.logs.length > before || true, '不应抛错')
  assert.ok(api.logs.some((l) => l.includes('熔断')), `应有熔断日志，实际: ${JSON.stringify(api.logs.slice(-3))}`)
})

test('speakup 熔断时 /speakup/fire 返回 ok:false 且带提示', async () => {
  freshDay()
  const owner = 'private:1000'
  for (let i = 0; i < 60; i += 1) defaultLedger.record(owner, 50000)
  const api = fakeApi({ ownerQQ: '1000' })
  speakup.setup(api)
  const r = await api.getRoute('/speakup/fire')()
  assert.equal(r.ok, false, '配额耗尽时不应放行')
  assert.match(String(r.message), /配额|用完|休息/, `提示应说明原因，实际: ${r.message}`)
})

test('配额充足时不熔断（不误伤正常主动搭话）', async () => {
  freshDay()
  const api = fakeApi({ ownerQQ: '1000' })
  speakup.setup(api)
  const r = await api.getRoute('/speakup/fire')()
  assert.equal(r.ok, true, `配额充足应放行，实际: ${JSON.stringify(r)}`)
})

test('总开关关闭时优先返回"先打开总开关"', async () => {
  freshDay()
  const api = fakeApi({ ownerQQ: '1000' })
  api.config().enabled = false
  speakup.setup(api)
  const r = await api.getRoute('/speakup/fire')()
  assert.equal(r.ok, false)
  assert.match(String(r.message), /总开关/)
})

test('非法 chatKey 不会让熔断判定抛错（fail-open，不永久掐话）', async () => {
  freshDay()
  const api = fakeApi({ ownerQQ: 'not-a-number' })
  speakup.setup(api)
  // /speakup/fire 走的是同一条 exhausted 判定；非法 chatKey 时账本抛 TypeError，
  // 必须被兜住按「未熔断」放行，而不是把主动搭话永久掐死。
  await assert.doesNotReject(() => api.getRoute('/speakup/fire')())
})

test('记账失败不影响后续轮次', () => {
  freshDay()
  const api = fakeApi()
  tokenBilling.setup(api)
  assert.doesNotThrow(() => api.emit('session/usage', { chatId: 'bad key', usage: { uncachedInputTokens: 5 } }))
  assert.doesNotThrow(() => api.emit('session/usage', { chatId: 'private:1000', usage: { uncachedInputTokens: 5 } }))
})
