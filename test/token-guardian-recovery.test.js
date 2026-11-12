import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { askModel } from '../src/core/llm.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

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

async function boot({ ask, cfgOver = {}, withIntervals = false, busy = false, logLines = null } = {}) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'tg-recovery-'))
  const mod = (await import(`../src/modules/token-guardian/index.js?recovery=${seq++}`)).default
  const routes = {}
  const handlers = {}
  const intervals = []
  const disposers = []
  const originalInterval = globalThis.setInterval
  if (withIntervals) {
    globalThis.setInterval = (fn) => {
      intervals.push(fn)
      return { unref() {} }
    }
  }
  const chatId = 'group:1'
  // 线上流水是 12k 字级别的；审核兜底有 1500 字下限，测试也得用差不多量级才能看出丢尾效果
  const defaultLogLines = logLines ?? Array.from({ length: 200 }, (_, i) => ({
    chatId, who: i % 3 === 0 ? 'bot' : 'user', text: `第 ${i} 句话说了一堆事情，用来把流水撑到线上体量。`,
  }))
  let busyChecks = 0
  let resetCalls = 0
  const api = {
    dataDir: (...parts) => join(process.env.AURABOT_DATA_DIR, ...parts),
    settings: () => ({ enabled: true, threshold: 1, idleSeconds: 0, cooldownMinutes: 120, summaryMaxChars: 1200, askTimeoutSeconds: 0.05, ...cfgOver }),
    log: { info() {}, warn() {}, debug() {}, error() {} },
    route: (path, fn) => { routes[path] = fn },
    on: (name, fn) => { (handlers[name] ||= []).push(fn) },
    context() {}, rule() {}, tool() {}, emit() {}, onDispose: (fn) => disposers.push(fn),
    defineTool: (value) => value,
    ask,
    core: {
      http: {},
      chatLog: {
        listDays: () => ['2026-11-10'],
        readDay: () => defaultLogLines,
        append() {},
      },
      hub: {
        resetChat: () => { resetCalls++; return true },
        isBusy: () => { busyChecks++; return busy },
      },
    },
  }
  let out
  try { out = mod.setup(api) } finally { if (withIntervals) globalThis.setInterval = originalInterval }
  return { out, routes, handlers, intervals, disposers, chatId, busyChecks: () => busyChecks, resetCalls: () => resetCalls }
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

test('内容审核拦截：砍掉最近流水重试，摘要头保留', async () => {
  const tried = []
  let n = 0
  const { out, chatId } = await boot({
    ask: async (opts) => {
      tried.push(opts.text)
      n++
      if (n === 1) throw new Error('模型报错：500 {"type":"error","error":{"type":"api_error","message":"input new_sensitive (1026)"}}')
      return '降级后的摘要'
    },
    cfgOver: { summaryMaxChars: 1200 },
  })
  const result = await out.compact(chatId, { chatId })
  assert.equal(result.ok, true, '第二次应该成功，而不是直接放弃')
  assert.equal(tried.length, 2, '被拦后要重试一次')
  assert.ok(tried[1].length < tried[0].length, '重试要用更短的流水（丢掉最近被拦的部分）')
  assert.ok(tried[1].length >= 800, '不能把整份流水砍光')
  assert.ok(tried[1].endsWith(tried[0].slice(tried[0].length - 40)),
    '保留的必须是「更早」那段，顺序不能乱')
  assert.equal(out.summaries()[chatId].text, '降级后的摘要')
})

test('审核拦截且丢尾也过不了：报 moderation，不伪装成「调用失败」', async () => {
  let n = 0
  const { out, chatId } = await boot({
    ask: async () => {
      n++
      throw new Error('模型报错：500 {"type":"error","error":{"type":"api_error","message":"input new_sensitive (1026)"}}')
    },
  })
  const result = await out.compact(chatId, { chatId })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'moderation', '要说清是内容审核，不是功能坏了')
  assert.ok(n >= 2 && n <= 4, `丢尾重试次数要有上限，实际 ${n} 次`)
  assert.match(result.message, /内容审核/, '面板提示要能看懂')
})

test('审核拦截有次数上限，不会无限重试', async () => {
  let n = 0
  const { out, chatId } = await boot({
    ask: async () => { n++; throw new Error('input new_sensitive (1026)') },
  })
  await out.compact(chatId, { chatId })
  assert.ok(n <= 4, `最多试 4 次（原始 + 3 次丢尾），实际 ${n}`)
})

test('限流不会被当成审核拦截：不浪费丢尾重试', async () => {
  let n = 0
  const { out, chatId } = await boot({
    ask: async () => { n++; throw new Error('429 rate limit exceeded') },
  })
  const result = await out.compact(chatId, { chatId })
  assert.equal(result.reason, 'rate-limited')
  assert.equal(n, 1, '限流要直接报，不该丢尾重试')
})

test('审核拦截后冷却：冷却期内一次都不试，且不吃指数退避', () => {
  const SRC3 = readFileSync(join(ROOT, 'src/modules/token-guardian/index.js'), 'utf8')
  // 被拦之后要记住时间，并在 tickOnce 里跳过冷却期 —— 否则每个 tick 烧 4 次调用全失败
  assert.ok(SRC3.includes('lastModerationAt.set(String(sessionKey), Date.now())'), '被拦时要记时间')
  assert.ok(SRC3.includes('if (modAt && now - modAt < Number(cfg.moderationCooldownMinutes || 30) * 60_000) continue'),
    '冷却期内 tickOnce 要跳过')
  // 不能做成「来新消息就解锁」：活跃群每秒都在说话，那样等于没冷却
  // （2026-11-12 实测：解锁版本在 11:29 仍然每 30 秒烧 4 次）
  assert.ok(!SRC3.includes('lastModerationAt.delete(key)'), '新消息不该解锁冷却')
  // 审核是内容问题不是调用失败：不该再叠一层指数退避，否则要等 30 分钟退避 + 30 分钟冷却
  assert.ok(SRC3.includes('st2.nextAttemptAt = 0'), '审核拦截要清掉指数退避')
  assert.ok(SRC3.includes('moderationCooldownMinutes: 30,'), '要有可配置的冷却时长')
})

test('压缩摘要用最低思考档 low，且绝不能发 off', async () => {
  const seen = []
  const { out, chatId } = await boot({
    ask: async (opts) => { seen.push(opts); return '摘要正文' },
  })
  const result = await out.compact(chatId, { chatId })
  assert.equal(result.ok, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].reasoningEffort, 'low', '最低档：实测该档思考 token = 0，等于不思考')
  assert.notEqual(seen[0].reasoningEffort, 'off',
    'off 会被 forceAdaptiveThinking 模型翻成 thinking.type=disabled，服务端直接 400'
    + '（MiniMax-M3.1-Flash：requires adaptive thinking ... is not allowed，2026-11-12 实测）')
})

test('摘要 maxTokens 给思考留余量：思考算进 output 预算，不能只按正文长度算', async () => {
  const seen = []
  const { out, chatId } = await boot({
    ask: async (opts) => { seen.push(opts); return '摘要正文' },
    cfgOver: { summaryMaxChars: 1200 },
  })
  const result = await out.compact(chatId, { chatId })
  assert.equal(result.ok, true)
  // 正文上限 1200 字 ≈ 1680 token，再加思考余量
  assert.ok(seen[0].maxTokens >= 2000,
    `maxTokens 要给思考留余量，实际 ${seen[0].maxTokens}`)
})

test('摘要字数上限写进 system，而不是事后 slice 截断', async () => {
  const seen = []
  const { out, chatId } = await boot({
    ask: async (opts) => { seen.push(opts); return '摘要正文' },
    cfgOver: { summaryMaxChars: 800 },
  })
  const result = await out.compact(chatId, { chatId })
  assert.equal(result.ok, true)
  assert.match(seen[0].system, /800 字以内/,
    '模型实测会写 2400~3200 字，代码再 slice 就断在句中间：必须显式告诉它上限，让它自己收敛')
})

test('默认超时留足余量：实测 21~32 秒，卡 90 秒会被抖动掐断', () => {
  const SRC2 = readFileSync(join(ROOT, 'src/modules/token-guardian/index.js'), 'utf8')
  assert.match(SRC2, /askTimeoutSeconds: 150/, '默认值要留余量')
  assert.doesNotMatch(SRC2, /askTimeoutSeconds: 90,/, '90 秒实测会被 API 抖动掐断（2026-11-12）')
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

test('忙时不压缩：isBusy 真正被调用，模型请求不得发起', async () => {
  let calls = 0
  const { handlers, intervals, busyChecks, chatId } = await boot({
    withIntervals: true, busy: true,
    ask: async () => { calls++; return '不应生成' },
  })
  for (const fn of handlers.activity || []) fn({ kind: 'in', chatId, text: '正文' })
  intervals[0]()
  await sleep(30)
  assert.equal(busyChecks(), 1)
  assert.equal(calls, 0)
})

test('dispose：中止在途压缩，旧请求不得 reset 或写失败状态', async () => {
  let signal
  let calls = 0
  const { out, disposers, resetCalls, chatId } = await boot({
    ask: async (opts) => { calls++; signal = opts.signal; return await new Promise(() => {}) },
  })
  const pending = out.compact(chatId, { chatId })
  await until(() => calls === 1)
  assert.equal(disposers.length, 1)
  disposers[0]()
  const result = await Promise.race([
    pending,
    sleep(500).then(() => { throw new Error('dispose 后压缩仍未落定') }),
  ])
  assert.equal(result.reason, 'disposed')
  assert.equal(signal?.aborted, true)
  assert.equal(resetCalls(), 0)
  assert.equal(out.state()[chatId]?.failures || 0, 0)
  assert.equal(out.summaries()[chatId], undefined)
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
