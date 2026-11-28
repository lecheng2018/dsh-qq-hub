// 回合失败回执回归（2026-11-27）：
//
// 背景：真机 11-27 14:29 / 14:30 两条「你不能帮我查保修吗」被上游网关
// （codearts_upstream / InferHub.ModelArts）以 403 判成「非编程话题」拒绝，
// **QQ 侧全程静默** —— 用户只看到她没反应，要翻后台日志才知道这轮没跑成。
//
// 过去只有 413（请求体过大）、超时、blocked 三条失败路径有回执，
// 其余（内容审核 / 限流 / 模型抖动）一律只写日志。本文件锁住补上的那部分：
//   ① 失败分类：403 内容审核 / 429 限流 / 超窗 / 其他，各自给用户不同的话；
//   ② 群聊不发回执（当众解释技术故障观感差），只发私聊；
//   ③ 同聊天 5 分钟内最多提示一次，避免模型持续挂掉时刷屏。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModularCore } from '../src/host/modular-core.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }

/** 最小核心：只为了拿 classifyTurnFailure / handleTurnFailure 两个测试出口。 */
function makeCore(t, { outboxRequest } = {}) {
  const prevDir = process.env.DSH_QQ_HUB_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'turn-fail-'))
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  const cfg = {
    enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人',
    allow: { private: ['10000001'], groups: ['777'] },
    merge: { waitSec: 0.01, maxSec: 0.04, groupWaitSec: 0.01, groupMaxSec: 0.04 },
    group: { interjectChance: 0, quota: { enabled: false } },
    security: { identityGuard: { enabled: false } },
    voice: { enabled: false, autoChance: 0 }, stickers: { enabled: false, faces: false, autoChance: 0 },
    reply: { groupMaxChars: 500, maxBubbles: 3, cadence: { enabled: false } },
    memory: { enabled: true, recallCount: 4 },
  }
  const sent = []
  const dsh = {
    on: () => () => {},
    get: () => null,
  }
  const core = createModularCore({
    dsh,
    onebot: { call: async () => ({ message_id: 1 }) },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
    // outbox 用真实实现时会尝试走 onebot；这里只需要观察「有没有请求投递」，
    // 所以用 sharedOutbox 的替身：request 被调用就记下来。
    sharedOutbox: {
      request: outboxRequest || ((d) => { sent.push(d); return Promise.resolve({ ok: true }) }),
      dispose: () => {},
      notePrivateSource: () => {},
    },
  })
  t.after(async () => {
    try { await core.dispose() } catch {}
    if (prevDir === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prevDir
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })
  return { core, sent }
}

/** 可编程事件流的端到端核心：走真实 dispatchLegacyEvent → turn/end → outbox 链路。 */
function makeE2ECore(t, { script = [], onFollowup, resolveAgent, cfgOver = {}, onebotCall, modsOver = {} } = {}) {
  const prevDir = process.env.DSH_QQ_HUB_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'turn-fail-e2e-'))
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  const listeners = new Set()
  const sessionIds = []
  const workspaces = [{ id: 'ws', path: 'ws' }]
  const contextsMap = new Map()
  let turnNo = 0
  function makeAgent(id) {
    return {
      id,
      ctx: { get(name) { if (name === 'contexts') return { set: (k, v) => contextsMap.set(k, v), get: (k) => contextsMap.get(k) }; return null } },
      followup(msg) {
        const n = ++turnNo
        if (onFollowup) return onFollowup({ id, turn: n, msg, listeners, session: { id } })
        const session = { id }
        const events = script[n - 1]
        if (events === 'hang') return Promise.resolve() // 不发 turn/end，用于测 replyPromise 超时
        const list = events || [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }]
        for (const ev of list) for (const fn of [...listeners]) fn(session, { ...ev, data: { ...ev.data, turn: n } })
        return Promise.resolve()
      },
    }
  }
  const ctrl = {
    create: async () => { const id = `sess-${sessionIds.length + 1}`; sessionIds.push(id); return { sessionId: id } },
    resolveAgent: resolveAgent || (async (id) => ({ agent: makeAgent(id) })),
  }
  const dsh = {
    on(name, fn) { if (name !== 'session/event') return () => {}; listeners.add(fn); return () => listeners.delete(fn) },
    get(name) {
      if (name === 'sessionController') return ctrl
      if (name === 'workspaceRegistry') {
        return {
          list: () => workspaces,
          create: async () => workspaces[0],
          archiveSession: (id) => { workspaces.archived = [...(workspaces.archived || []), id] },
        }
      }
      return null
    },
  }
  const sentTexts = []
  const sentActions = []
  const cfg = {
    enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人', /* pii-scan:ignore */
    allow: { private: ['10000001'], groups: ['777'] }, longTasks: false, /* pii-scan:ignore */
    merge: { waitSec: 0.01, maxSec: 0.04, groupWaitSec: 0.01, groupMaxSec: 0.04 },
    group: { interjectChance: 0, quota: { enabled: false } },
    security: { identityGuard: { enabled: false } },
    voice: { enabled: false, autoChance: 0 }, stickers: { enabled: false, faces: false, autoChance: 0 },
    reply: { groupMaxChars: 500, maxBubbles: 3, cadence: { enabled: false } },
    ...cfgOver,
  }
  const core = createModularCore({
    dsh,
    onebot: {
      call: async (action, params) => {
        if (onebotCall) return onebotCall(action, params, { sentActions, sentTexts })
        if (action.startsWith('send_')) {
          sentActions.push(action)
          const segs = Array.isArray(params?.message) ? params.message : []
          const txt = segs.map((s) => s?.data?.text || '').join('') || (typeof params?.message === 'string' ? params.message : '')
          sentTexts.push(txt)
        }
        return { message_id: String(sentActions.length) }
      },
    },
    mods: { contextFor: async () => '', commands: () => [], use: () => null, ...modsOver },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
  })
  t.after(async () => {
    try { await core.dispose() } catch {}
    if (prevDir === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prevDir
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })
  return { core, sentTexts, sentActions, workspaces, sessionIds, listeners }
}

const privateEv = (over = {}) => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: 20000002, user_id: 10000001, message_id: Math.floor(Math.random() * 1e9), time: Math.floor(Date.now() / 1000), /* pii-scan:ignore */
  sender: { user_id: 10000001, nickname: '主人' }, /* pii-scan:ignore */
  message: [{ type: 'text', data: { text: '在吗' } }],
  ...over,
})

const groupAtEv = (over = {}) => ({
  post_type: 'message', message_type: 'group', sub_type: 'normal',
  self_id: 20000002, group_id: 777, user_id: 10000001, message_id: Math.floor(Math.random() * 1e9), time: Math.floor(Date.now() / 1000), /* pii-scan:ignore */
  sender: { user_id: 10000001, nickname: '主人' }, /* pii-scan:ignore */
  message: [{ type: 'at', data: { qq: '20000002' } }, { type: 'text', data: { text: ' 在吗' } }], /* pii-scan:ignore */
  ...over,
})

// ---------- ① 分类 ----------

test('分类：上游内容策略 403 → moderation，文案说明「不是我不理你」', (t) => {
  const { core } = makeCore(t)
  const raw = '403: {"code":"codearts_upstream","message":"上游返回（InferHub.ModelArts.81011.403）：抱歉，我无法提供关于您提问内容的建议。作为 AI 编程助手，我更擅长协助您处理代码编写…","type":"invalid_request_error"}'
  const r = core.classifyTurnFailure(new Error(raw))
  assert.equal(r.kind, 'moderation')
  assert.match(r.text, /审核|拦/)
  assert.match(r.text, /不是我不理你/)
})

test('分类：content_filter / 敏感内容 / 1026 也算内容审核', (t) => {
  const { core } = makeCore(t)
  for (const raw of [
    'finish_reason: content_filter',
    '内容审核未通过',
    '{"code":"1026"}',
    'input new sensitive',
  ]) {
    assert.equal(core.classifyTurnFailure(new Error(raw)).kind, 'moderation', raw)
  }
})

test('分类：429 / 限流 / 冷却 → rate-limit，提示等一会儿', (t) => {
  const { core } = makeCore(t)
  for (const raw of [
    '429: {"code":"routing_cooldown","message":"当前路由对象处于冷却期"}',
    'rate limit exceeded',
    '模型额度用完了',
    '所有启用中的账号都被限制器拦下',
  ]) {
    const r = core.classifyTurnFailure(new Error(raw))
    assert.equal(r.kind, 'rate-limit', raw)
    assert.match(r.text, /限流|等一会儿/)
  }
  // HTTP status 也认
  assert.equal(core.classifyTurnFailure({ failure: { status: 429, message: 'x' } }).kind, 'rate-limit')
})

test('分类：上下文窗口不够 → context-window，提示会重新开始', (t) => {
  const { core } = makeCore(t)
  const r = core.classifyTurnFailure(new Error('CONTEXT_WINDOW_EXCEEDED: maximum context length is 200000 tokens'))
  assert.equal(r.kind, 'context-window')
  assert.match(r.text, /重新开始/)
})

test('分类：其余错误 → error，给「再跟我说一次」而不是沉默', (t) => {
  const { core } = makeCore(t)
  for (const raw of ['fetch failed', 'ECONNRESET', 'turn/end kind=error', '']) {
    const r = core.classifyTurnFailure(new Error(raw))
    assert.equal(r.kind, 'error', JSON.stringify(raw))
    assert.ok(r.text.length > 0)
  }
})

test('分类：结构化 code / status 与正则边界精确判定（不误伤 503 / req-14290 / 认证 403）', (t) => {
  const { core } = makeCore(t)
  // 503「服务暂时无法提供」绝不能误判成 moderation
  assert.equal(core.classifyTurnFailure({ failure: { status: 503, message: '服务暂时无法提供' } }).kind, 'error')
  assert.equal(core.classifyTurnFailure(new Error('503 服务暂时无法提供，请稍后重试')).kind, 'error')
  // 含 429 子串的请求号绝不能误判成 rate-limit
  assert.equal(core.classifyTurnFailure(new Error('upstream timeout req-14290')).kind, 'error')
  // 纯认证/权限 403 不能误判成 moderation
  assert.equal(core.classifyTurnFailure({ failure: { status: 403, message: 'Invalid API key' } }).kind, 'error')
  assert.equal(core.classifyTurnFailure({ failure: { status: 403, message: 'unauthorized: forbidden token' } }).kind, 'error')
  // 非认证 403 与数字型 JSON code / 结构化 code 命中 moderation
  assert.equal(core.classifyTurnFailure({ failure: { status: 403, message: 'Request blocked by policy' } }).kind, 'moderation')
  assert.equal(core.classifyTurnFailure(new Error('{"code": 1026, "message": "blocked"}')).kind, 'moderation')
  assert.equal(core.classifyTurnFailure({ failure: { code: 'data_inspection_failed', message: 'rejected' } }).kind, 'moderation')
  assert.equal(core.classifyTurnFailure({ failure: { code: 'PROHIBITED_CONTENT', message: 'rejected' } }).kind, 'moderation')
  // 结构化 code: RATE_LIMITED / CONTEXT_WINDOW_EXCEEDED
  assert.equal(core.classifyTurnFailure({ failure: { code: 'RATE_LIMITED', message: 'try later' } }).kind, 'rate-limit')
  assert.equal(core.classifyTurnFailure({ failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'prompt is too long: 213462 tokens > 200000 maximum' } }).kind, 'context-window')
  assert.equal(core.classifyTurnFailure({ failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'exceeds context capacity' } }).kind, 'context-window')
  // 欠费 / 余额不足单列 billing，不误导「等一会儿就好」
  for (const err of [
    new Error('账户余额不足，请充值'),
    new Error('insufficient_balance'),
    new Error('insufficient_quota'),
    { failure: { status: 402, message: 'Payment Required' } },
  ]) {
    const r = core.classifyTurnFailure(err)
    assert.equal(r.kind, 'billing')
    assert.match(r.text, /余额|额度/)
    assert.doesNotMatch(r.text, /等一会儿/)
  }
})

test('分类：不抛（undefined / null / 怪形状都要能分类）', (t) => {
  const { core } = makeCore(t)
  for (const bad of [undefined, null, {}, { failure: null }, 0, '']) {
    assert.doesNotThrow(() => core.classifyTurnFailure(bad))
    assert.equal(typeof core.classifyTurnFailure(bad).kind, 'string')
  }
})

// ---------- ② 群聊不发、私聊才发 ----------

test('回执：群聊不发（当众解释技术故障观感差），只发私聊', (t) => {
  const { core, sent } = makeCore(t)
  const g = core.handleTurnFailure('group:777', new Error('fetch failed'))
  assert.equal(g.sent, false, '群聊不应发回执')
  assert.equal(sent.length, 0)

  const p = core.handleTurnFailure('private:10000001', new Error('fetch failed'))
  assert.equal(p.sent, true, '私聊应发回执')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chatKey, 'private:10000001')
  assert.match(sent[0].segments[0].data.text, /再跟我说一次/)
})

// ---------- ③ 限频 ----------

test('回执：同聊天同类型 5 分钟内只发一次，跨类型不互相静音', (t) => {
  const { core, sent } = makeCore(t)
  const key = 'private:10000001'
  assert.equal(core.handleTurnFailure(key, new Error('fetch failed')).sent, true)
  assert.equal(core.handleTurnFailure(key, new Error('fetch failed')).sent, false, '同类型窗口内第二次应被限频')
  assert.equal(core.handleTurnFailure(key, new Error('429 rate limit')).sent, true, '换错误类型（rate-limit）不应被 error 静音')
  assert.equal(core.handleTurnFailure(key, new Error('finish_reason: content_filter')).sent, true, '换错误类型（moderation）不应被静音')
  assert.equal(core.handleTurnFailure(key, new Error('429 rate limit')).sent, false, '同类型 rate-limit 再次触发仍限频')
  assert.equal(sent.length, 3, '三种不同类型各投递一次')
})

test('回执：outbox.request 抛错时不锁死 5 分钟窗口', async (t) => {
  let failOnce = true
  const delivered = []
  const { core } = makeCore(t, {
    outboxRequest: (d) => {
      if (failOnce) {
        failOnce = false
        return Promise.reject(new Error('outbox down'))
      }
      delivered.push(d)
      return Promise.resolve({ ok: true })
    },
  })
  const key = 'private:10000001' /* pii-scan:ignore */
  assert.equal(core.handleTurnFailure(key, new Error('fetch failed')).sent, true, '保持同步返回 sent: true 契约')
  await sleep(10) // 等异步 reject 触发回滚
  assert.equal(core.handleTurnFailure(key, new Error('fetch failed')).sent, true, '上次投递失败已回滚，窗口不被锁死')
  assert.equal(delivered.length, 1)
})

test('回执：不同聊天各自独立计数（A 的限频不影响 B）', (t) => {
  const { core, sent } = makeCore(t)
  assert.equal(core.handleTurnFailure('private:10000001', new Error('x')).sent, true)
  assert.equal(core.handleTurnFailure('private:10000002', new Error('x')).sent, true, '另一个聊天不受影响')
  assert.equal(sent.length, 2)
})

test('回执：notify=false 只记日志不发消息（测试/试探路径）', (t) => {
  const { core, sent } = makeCore(t)
  const r = core.handleTurnFailure('private:10000001', new Error('fetch failed'), { notify: false })
  assert.equal(r.sent, false)
  assert.equal(sent.length, 0)
  assert.equal(typeof r.kind, 'string', '仍然要给出分类便于日志')
})

test('回执：限频表超过 200 条触发 LRU 淘汰，热 key 命中刷新顺序不被误删', (t) => {
  const { core } = makeCore(t)
  assert.equal(core.handleTurnFailure('private:1', new Error('x')).sent, true)
  assert.equal(core.handleTurnFailure('private:2', new Error('x')).sent, true)
  for (let i = 3; i <= 200; i += 1) {
    assert.equal(core.handleTurnFailure(`private:${i}`, new Error('x')).sent, true)
  }
  // 命中 private:1（限频中），刷新其 LRU 顺序到队尾；此时最旧的是 private:2
  assert.equal(core.handleTurnFailure('private:1', new Error('x')).sent, false)
  // 第 201 个 key 入表，触发淘汰最旧的 private:2
  assert.equal(core.handleTurnFailure('private:201', new Error('x')).sent, true)
  assert.equal(core.handleTurnFailure('private:1', new Error('x')).sent, false, '热 key private:1 仍保留在限频表中')
  assert.equal(core.handleTurnFailure('private:2', new Error('x')).sent, true, '最久未访问的 private:2 已被淘汰')
})

test('回执：空 chatKey 不发也不抛', (t) => {
  const { core, sent } = makeCore(t)
  for (const bad of ['', undefined, null]) {
    const r = core.handleTurnFailure(bad, new Error('x'))
    assert.equal(r.sent, false)
  }
  assert.equal(sent.length, 0)
})
// ---------- ④ 静态守卫：所有「回合失败出口」都必须有回执 ----------
//
// 这是为了防止本次踩过的坑重演：2026-11-27 首次实现时只补了 followupError 与
// execute 最外层 catch，**漏掉了「等待 replyPromise 时 turn/end 落 error」这个最常见出口**，
// 结果真机 16:10 的上游 403 依然完全静默，用户反馈「失败了还是静默」。
//
// S2 起事件机搬进了 src/chat/dsh-turn-runner.js（聊天主链与主动回合共用），失败抛点因此分成两处：
//   ① 装配根 modular-core.js 里的 throw（原有扫描，一字未放宽：同样的出口正则、同样的前 12 行窗口、
//      同样的三个通知器）；
//   ② 执行器 dsh-turn-runner.js —— **它是唯一允许「抛错但自己不发回执」的地方**（提示与归档重建
//      留在调用点，时序与拆分前一致）。所以改成要求它每个失败出口都带分类字段
//      （kind / timedOut / oversized / archived），并且只允许「分类过的 TurnExecutionError / 取消 /
//      rethrow / 装配期 TypeError」四类出口；
//   ③ 装配根里每一处 `turnRunner.runTurn(` 的 catch 都必须出现通知器（把 ② 的分类真正兑现成通知）。
//
// 唯一豁免：取消（AbortError / kind === 'cancelled'）。取消是用户或宿主的主动中止 —— 回合落
// cancelled、零投递，也不该发「失败回执」（test/dsh-turn-runner.test.js 的取消集成用例锁住零投递）。
// 豁免要求窗口里**真的写着**取消判定，不是靠注释文字放行。
test('静态守卫：所有回合失败出口都必须有回执（超时 / 413 / 分类回执任一）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/host/modular-core.js', import.meta.url), 'utf8')
  const lines = src.split('\n')

  const NOTIFIERS = /handleTurnFailure|handleTurnTimeout|handleOversizedTurn/
  const CANCEL_GUARD = /name === 'AbortError'|kind === 'cancelled'/

  // ① 装配根：原有的失败出口扫描（正则与窗口都没改）
  // 只找「回合执行」范围内的失败抛出点（turn.chatKey 存在 = 这一轮属于某个聊天）
  const throwIdx = []
  lines.forEach((line, i) => {
    if (/^\s*throw\s+(error|new Error\(`(DSH )?回合|new Error\(`主动回合)/.test(line)) throwIdx.push(i)
  })
  assert.ok(throwIdx.length >= 3, `至少应有 3 个失败出口，实际找到 ${throwIdx.length} 个（守卫本身要能工作）`)

  const missing = []
  for (const i of throwIdx) {
    // 往前看 12 行（覆盖整个 catch 块直到 throw），必须出现任一通知器
    const window = lines.slice(Math.max(0, i - 12), i + 1).join('\n')
    if (NOTIFIERS.test(window)) continue
    // 取消不是故障：窗口里真的写着取消判定才放行
    if (CANCEL_GUARD.test(window)) continue
    missing.push(`${i + 1}: ${lines[i].trim()}`)
  }
  assert.deepEqual(missing, [], `这些失败出口没有通知用户（会静默）：\n${missing.join('\n')}`)

  // ② 执行器：每个失败出口都带分类字段，调用点才有的可判
  const runnerSrc = readFileSync(new URL('../src/chat/dsh-turn-runner.js', import.meta.url), 'utf8')
  const runnerLines = runnerSrc.split('\n')
  const CLASSIFIED = /kind:|timedOut:|oversized:|archived:/

  const ctorIdx = []
  runnerLines.forEach((line, i) => { if (/new TurnExecutionError\(/.test(line)) ctorIdx.push(i) })
  assert.ok(ctorIdx.length >= 6, `执行器至少应有 6 个 TurnExecutionError 出口，实际 ${ctorIdx.length} 个（守卫本身要能工作）`)
  const unclassified = []
  for (const i of ctorIdx) {
    // 元信息可能折行（timeout / incomplete / followup 三处都是 `{` 换行），往后看 7 行足够覆盖
    const window = runnerLines.slice(i, i + 7).join('\n')
    if (!CLASSIFIED.test(window)) unclassified.push(`${i + 1}: ${runnerLines[i].trim()}`)
  }
  assert.deepEqual(unclassified, [], `这些执行器失败出口没有分类字段（调用点无法判断要不要通知）：\n${unclassified.join('\n')}`)

  // ②b 执行器只允许这四类出口：分类过的 TurnExecutionError / 取消 / rethrow / 装配期 TypeError。
  // 注意要认 `if (…) throw …` 这种前置条件写法（S2 的取消判定就是），所以取 throw/reject 之后
  // 那个**表达式**来判，而不是判行首。
  const RUNNER_EXIT_OK = /^(new TurnExecutionError\(|cancelledError\(\)|new TypeError\(|error\b|followupError\b)/
  const strayExits = []
  runnerLines.forEach((line, i) => {
    const code = line.trim()
    if (!code || code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return
    const hit = /\bthrow\s+(.*)$/.exec(code) || /\breject\((.*)$/.exec(code)
    if (!hit) return
    if (RUNNER_EXIT_OK.test(hit[1])) return
    strayExits.push(`${i + 1}: ${code}`)
  })
  assert.deepEqual(strayExits, [], `执行器里出现了没有分类的失败出口：\n${strayExits.join('\n')}`)

  // ③ 调用点：每一处 turnRunner.runTurn( 的 catch 都必须通知
  const callIdx = []
  lines.forEach((line, i) => { if (/turnRunner\.runTurn\(/.test(line)) callIdx.push(i) })
  assert.ok(callIdx.length >= 2, `两条链都应调用执行器（execute + runPromptTurn），实际 ${callIdx.length} 处`)
  const unnotified = []
  for (const i of callIdx) {
    const tail = lines.slice(i, i + 80)
    const catchAt = tail.findIndex((line) => /\}\s*catch\s*\(/.test(line))
    assert.notEqual(catchAt, -1, `${i + 1} 处的 runTurn 没有 catch —— 失败会静默`)
    const window = tail.slice(catchAt, catchAt + 20).join('\n')
    if (!NOTIFIERS.test(window)) unnotified.push(`${i + 1}: ${lines[i].trim()}`)
  }
  assert.deepEqual(unnotified, [], `这些 runTurn 调用点的 catch 没有通知用户（会静默）：\n${unnotified.join('\n')}`)
})

// ---------- ⑤ 端到端回归：真实事件流（dispatchLegacyEvent + turn/end） ----------

test('E2E：上游 403 moderation → 发出含「内容审核」的回执（而非「抖了一下」）', async (t) => {
  const { core, sentTexts } = makeE2ECore(t, {
    script: [
      [{
        type: 'turn/end',
        data: {
          reason: {
            kind: 'error',
            error: {
              status: 403,
              code: 'codearts_upstream',
              message: '上游返回：抱歉，我无法提供关于您提问内容的建议。',
            },
          },
        },
      }],
    ],
  })
  await core.dispatchLegacyEvent(privateEv({ message_id: 1 }))
  await sleep(250)
  assert.equal(sentTexts.length, 1)
  assert.match(sentTexts[0], /内容审核/)
  assert.doesNotMatch(sentTexts[0], /抖了一下/)
})

test('E2E：上游 429 rate-limit → 发出含「限流」的回执且不换会话', async (t) => {
  const { core, sentTexts } = makeE2ECore(t, {
    script: [
      [{
        type: 'turn/end',
        data: {
          reason: {
            kind: 'error',
            error: { status: 429, code: 'RATE_LIMITED', message: 'rate limit exceeded' },
          },
        },
      }],
      [
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '恢复正常了' }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ],
    ],
  })
  await core.dispatchLegacyEvent(privateEv({ message_id: 1 }))
  await sleep(250)
  assert.equal(sentTexts.length, 1)
  assert.match(sentTexts[0], /限流/)
  assert.doesNotMatch(sentTexts[0], /抖了一下/)
  await core.dispatchLegacyEvent(privateEv({ message_id: 2 }))
  await sleep(250)
  assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-1') /* pii-scan:ignore */
  assert.equal(sentTexts.length, 2)
  assert.match(sentTexts[1], /恢复正常了/)
})

test('E2E：上游 413 oversize → 只发出 1 条 413 回执（绝不双发「抖了一下」），下条消息换新会话', async (t) => {
  const { core, sentTexts, workspaces } = makeE2ECore(t, {
    script: [
      [{
        type: 'turn/end',
        data: {
          reason: {
            kind: 'error',
            error: { status: 413, code: 'INVALID_REQUEST', message: '413 plugin_request_too_large' },
          },
        },
      }],
      [
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新会话回复' }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ],
    ],
  })
  await core.dispatchLegacyEvent(privateEv({ message_id: 1 }))
  await sleep(250)
  assert.equal(sentTexts.length, 1, '413 绝不双发回执')
  assert.match(sentTexts[0], /64 MiB|上下文和图片太多/)
  assert.doesNotMatch(sentTexts[0], /抖了一下/)
  await core.dispatchLegacyEvent(privateEv({ message_id: 2 }))
  await sleep(250)
  assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-2') /* pii-scan:ignore */
  assert.ok((workspaces.archived || []).includes('sess-1'))
})

test('E2E：replyPromise 阶段超时 → 发出超时提示，且下一条消息换新会话', async (t) => {
  const { core, sentTexts, workspaces } = makeE2ECore(t, {
    cfgOver: { turnTimeoutMs: 60 },
    script: [
      'hang',
      [
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '超时后新会话回复' }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ],
    ],
  })
  await core.dispatchLegacyEvent(privateEv({ message_id: 1 }))
  await sleep(250)
  assert.equal(sentTexts.length, 1, 'replyPromise 超时只发 1 条超时提示')
  assert.match(sentTexts[0], /停止等待|重新开始/)
  assert.doesNotMatch(sentTexts[0], /抖了一下/)
  assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-1') /* pii-scan:ignore */
  await core.dispatchLegacyEvent(privateEv({ message_id: 2 }))
  await sleep(250)
  assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-2', '超时后下一条消息必须换新会话') /* pii-scan:ignore */
  assert.ok((workspaces.archived || []).includes('sess-1'))
  assert.equal(sentTexts.length, 2)
  assert.match(sentTexts[1], /超时后新会话回复/)
})

test('E2E：context-window 错误 → 发出超窗提示，且下一条消息确实换新会话（群聊同样自愈）', async (t) => {
  const { core, sentTexts, workspaces } = makeE2ECore(t, {
    script: [
      // 私聊第 1 轮：超窗
      [{
        type: 'turn/end',
        data: {
          reason: {
            kind: 'error',
            error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'prompt is too long: 213462 tokens > 200000 maximum' },
          },
        },
      }],
      // 私聊第 2 轮：应已换新会话
      [
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新会话继续聊' }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ],
      // 群聊第 1 轮：超窗（不发群提示，但仍登记换新会话）
      [{
        type: 'turn/end',
        data: {
          reason: {
            kind: 'error',
            error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'maximum context length exceeded' },
          },
        },
      }],
      // 群聊第 2 轮：应已换新会话
      [
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '群里新会话回复' }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ],
    ],
  })
  await core.dispatchLegacyEvent(privateEv({ message_id: 1 }))
  await sleep(250)
  assert.equal(sentTexts.length, 1)
  assert.match(sentTexts[0], /窗口装不下/)
  assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-1') /* pii-scan:ignore */
  await core.dispatchLegacyEvent(privateEv({ message_id: 2 }))
  await sleep(250)
  assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-2', '私聊超窗后下条消息换新会话') /* pii-scan:ignore */
  assert.ok((workspaces.archived || []).includes('sess-1'))
  assert.equal(sentTexts.length, 2)
  assert.match(sentTexts[1], /新会话继续聊/)

  // 群聊：不发故障回执，但下一条消息仍须换新会话
  await core.dispatchLegacyEvent(groupAtEv({ message_id: 3 }))
  await sleep(250)
  assert.equal(sentTexts.length, 2, '群聊超窗不发失败回执')
  const groupSess1 = core.registry.peek('group:777')?.sessionId
  assert.ok(groupSess1)
  await core.dispatchLegacyEvent(groupAtEv({ message_id: 4 }))
  await sleep(250)
  const groupSess2 = core.registry.peek('group:777')?.sessionId
  assert.notEqual(groupSess2, groupSess1, '群聊超窗后下条消息同样换新会话')
  assert.ok((workspaces.archived || []).includes(groupSess1))
})

test('E2E：execute 前置阶段异常（resolveAgent 抛错）也会发回执、不再静默', async (t) => {
  const { core, sentTexts } = makeE2ECore(t, {
    resolveAgent: async () => { throw new Error('agent boot failed') },
  })
  await core.dispatchLegacyEvent(privateEv({ message_id: 1 }))
  await sleep(250)
  assert.equal(sentTexts.length, 1, '前置异常不再静默，发出 1 条失败回执')
  assert.match(sentTexts[0], /这轮没跑成/)
})

test('E2E：deliver 已成功发出部分气泡后再抛错（delivered > 0）不补发「这轮没跑成」', async (t) => {
  const { core, sentTexts } = makeE2ECore(t, {
    script: [
      [
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一句' }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ],
    ],
    modsOver: {
      emit: (ev, payload) => {
        if (ev === 'activity' && payload?.kind === 'out') throw new Error('post-deliver hook boom')
      },
    },
  })
  await assert.rejects(
    () => core.dispatchLegacyEventSettled(privateEv({ message_id: 1 })),
    /post-deliver hook boom/,
    'deliver 确实抛出了异常',
  )
  await sleep(100)
  assert.equal(sentTexts.length, 1, '已送达气泡后抛错绝不补发「这轮没跑成」')
  assert.equal(sentTexts[0], '第一句')
})

test('E2E：runPromptTurn 补齐 blocked 归档自愈与 followup 413 自愈（均 notify=false）', async (t) => {
  let callIdx = 0
  const { core, sentTexts, workspaces } = makeE2ECore(t, {
    onFollowup: ({ id, turn, listeners }) => {
      callIdx += 1
      if (callIdx === 1) {
        // 第 1 次：turn/end kind=blocked
        for (const fn of [...listeners]) fn({ id }, { type: 'turn/end', data: { turn, reason: { kind: 'blocked' } } })
        return Promise.resolve()
      }
      if (callIdx === 2) {
        // 第 2 次（已换 sess-2）：followup 直接拒绝 413
        const err = new Error('413 plugin_request_too_large')
        err.failure = { status: 413, code: 'INVALID_REQUEST', message: '413 plugin_request_too_large' }
        return Promise.reject(err)
      }
      // 第 3 次（已换 sess-3）：成功返回
      for (const fn of [...listeners]) {
        fn({ id }, { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: '主动回合恢复' }] } } })
        fn({ id }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
      }
      return Promise.resolve()
    },
  })
  await assert.rejects(() => core.runPromptTurn('private:10000001', '提示1'), /blocked/) /* pii-scan:ignore */
  assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-1') /* pii-scan:ignore */
  await assert.rejects(() => core.runPromptTurn('private:10000001', '提示2'), /413/) /* pii-scan:ignore */
  assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-2', 'blocked 后下次主动回合已换新会话') /* pii-scan:ignore */
  const ok = await core.runPromptTurn('private:10000001', '提示3') /* pii-scan:ignore */
  assert.equal(ok, '主动回合恢复')
  assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-3', 'followup 413 后下次主动回合已换新会话') /* pii-scan:ignore */
  assert.ok((workspaces.archived || []).includes('sess-1'))
  assert.ok((workspaces.archived || []).includes('sess-2'))
  assert.deepEqual(sentTexts, [], '主动回合失败不往聊天里发提示')
})
