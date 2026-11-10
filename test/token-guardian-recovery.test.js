import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { askModel } from '../src/core/llm.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn, timeout = 500) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (fn()) return
    await sleep(5)
  }
  throw new Error('等待条件超时')
}
let seq = 0

async function boot({ ask, cfgOver = {}, withIntervals = false } = {}) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'tg-recovery-'))
  const mod = (await import(`../src/modules/token-guardian/index.js?recovery=${seq++}`)).default
  const routes = {}
  const handlers = {}
  const intervals = []
  const originalInterval = globalThis.setInterval
  if (withIntervals) {
    globalThis.setInterval = (fn) => {
      intervals.push(fn)
      return { unref() {} }
    }
  }
  const chatId = 'group:1'
  const api = {
    dataDir: (...parts) => join(process.env.AURABOT_DATA_DIR, ...parts),
    settings: () => ({ enabled: true, threshold: 1, idleSeconds: 0, cooldownMinutes: 120, summaryMaxChars: 1200, askTimeoutSeconds: 0.05, ...cfgOver }),
    log: { info() {}, warn() {}, debug() {}, error() {} },
    route: (path, fn) => { routes[path] = fn },
    on: (name, fn) => { (handlers[name] ||= []).push(fn) },
    context() {}, rule() {}, tool() {}, emit() {}, onDispose() {},
    defineTool: (value) => value,
    ask,
    core: {
      http: {},
      hub: {
        chatLogDays: () => ['2026-11-10'],
        chatLogOf: () => [{ chatId, who: 'user', text: '需要压缩的聊天正文' }],
        resetChat: () => true,
        logChat() {},
        isBusy: () => false,
      },
    },
  }
  let out
  try { out = mod.setup(api) } finally { if (withIntervals) globalThis.setInterval = originalInterval }
  return { out, routes, handlers, intervals, chatId }
}

test('压缩请求超时：中止模型流、释放锁并留下可诊断状态', async () => {
  let calls = 0
  let firstSignal
  const { out, routes, chatId } = await boot({
    ask: async ({ signal }) => {
      calls++
      if (calls > 1) return '短摘要'
      firstSignal = signal
      return await new Promise(() => {})
    },
  })
  const first = await Promise.race([
    out.compact(chatId, { chatId }),
    sleep(500).then(() => { throw new Error('compact 没有在超时后落定') }),
  ])
  assert.equal(first.ok, false)
  assert.equal(first.reason, 'timeout')
  assert.equal(firstSignal?.aborted, true, '超时必须真正 abort 模型流')
  const status = await routes['/token-guardian/status']()
  assert.equal(status.items[0].busy, false, '超时后必须释放 compactBusy')
  assert.equal(status.items[0].failures, 1)
  assert.match(status.items[0].lastError, /超时|超过/)
  const second = await out.compact(chatId, { chatId })
  assert.equal(second.ok, true, '锁释放后下一次压缩可以成功')
})

test('自动压缩失败：指数退避，不再每 30 秒无效调用', async () => {
  let calls = 0
  const { out, routes, handlers, intervals, chatId } = await boot({
    withIntervals: true,
    ask: async () => { calls++; throw new Error('provider down') },
  })
  assert.equal(intervals.length, 2)
  for (const fn of handlers.activity || []) fn({ kind: 'in', chatId, text: '正文' })
  const failure = await out.compact(chatId, { chatId })
  assert.equal(failure.reason, 'ask-failed')
  assert.equal(calls, 1)
  const firstStatus = await routes['/token-guardian/status']()
  const first = firstStatus.items[0]
  assert.ok(first, JSON.stringify({ status: firstStatus, state: out.state() }))
  assert.equal(first.failures, 1, JSON.stringify(out.state()))
  assert.ok(first.nextAttemptAt > Date.now())
  await intervals[0]()
  assert.equal(calls, 1, '退避时间内不得重复请求')
  out.state()[chatId].nextAttemptAt = 0
  await intervals[0]()
  await until(() => calls === 2)
  await until(() => out.state()[chatId]?.failures === 2)
  const second = (await routes['/token-guardian/status']()).items[0]
  assert.equal(second.failures, 2)
  assert.ok(second.nextAttemptAt - second.lastAttemptAt >= 60_000, '第二次失败至少退避一分钟')
})

test('压缩成功后 chars 仍保存真实字符数，不预先乘 token 系数', async () => {
  const { out, chatId } = await boot({ ask: async () => '四字节吗' })
  const result = await out.compact(chatId, { chatId })
  assert.equal(result.ok, true)
  const st = out.state()[chatId]
  assert.equal(st.chars, '四字节吗'.length)
  assert.equal(out.estimate(st.chars), Math.round('四字节吗'.length * 1.4))
  assert.equal(st.failures, 0)
  assert.equal(st.lastError, '')
})

test('askModel 把调用方 signal 传给 DSH llm.stream', async () => {
  const controller = new AbortController()
  let received
  const dsh = {
    llm: {
      stream: async function * (params) {
        received = params.signal
        yield { type: 'text-delta', text: '完成' }
      },
    },
  }
  const result = await askModel(dsh, {
    provider: 'p', model: 'm', text: '测试', signal: controller.signal,
  })
  assert.equal(result, '完成')
  assert.equal(received, controller.signal)
})
