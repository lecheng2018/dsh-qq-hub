// S2 护栏：DSH 回合执行器（chat/dsh-turn-runner.js）。
//
// 拆分前「跑一个 DSH 回合、收集回复文本」有两套实现（聊天主链 execute / 后台 runPromptTurn），
// 机制重复、细节漂移。这组用例把两套语义的**关键差异点**逐条钉死，外加本轮唯一的行为改动
// （signal 取消生效）与失败分类的透传：
//   1. chat：同回合两条 user/message 隔开的分段 → 文本用 `|||` 拼接（steer 分段）；
//   2. chat：末步只剩控制标记时回退到上一带人话的步（真机 2026-11-23 15:01 形状）；
//   3. prompt：忽略 tool/call、只取最后一条正文、turn 不一致时返回空串；
//   4. 超时：抛 TurnExecutionError（timedOut / timedOutForMs），监听器已摘；
//   5. 取消：abort 后抛 name=AbortError 的 TurnExecutionError，监听器已摘；
//   6. 事件流缺失：抛错且文案含 session/event 流；
//   7. turn/end 非 completed：kind 原样透传、oversized / archived 分类交给分类器；
//   8. 集成：running 回合被 cancel → execute 因 signal 提前抛错，回合落 cancelled，迟到回复不投递。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createTurnRunner, TurnExecutionError } from '../src/chat/dsh-turn-runner.js'
import { classifyTurnFailure } from '../src/host/core/turn-failure.js'
import { createModularCore } from '../src/host/modular-core.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }

const MESSAGE = { id: 'm-1', role: 'user', content: [{ type: 'text', text: '在吗' }], source: { kind: 'qq-hub' } }
const SESSION = 'sess-runner'

/** 收集一次 runTurn 的结局：成功取值，失败取错误（不吞、不重抛）。 */
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }))

/**
 * 可编程最小 DSH：只实现执行器用到的两个面（sessionController.resolveAgent + session/event 流）。
 * @param {{stream?: boolean, timeoutMs?: number, followup?: (ctx: {message: object, emit: Function}) => Promise<*>}} o
 */
function scriptedDsh({ stream = true, timeoutMs = 5000, followup = null } = {}) {
  const listeners = new Set()
  const detached = []
  const emit = (ev) => { for (const fn of [...listeners]) fn({ id: SESSION }, ev) }
  const agent = {
    followup(message) {
      if (followup) return followup({ message, emit })
      return Promise.resolve()
    },
  }
  const dsh = {
    on(name, fn) {
      if (name !== 'session/event' || !stream) return undefined
      listeners.add(fn)
      return () => { detached.push(name); listeners.delete(fn) }
    },
    get(name) {
      if (name !== 'sessionController') return null
      return { resolveAgent: async () => ({ agent }) }
    },
  }
  const runner = createTurnRunner({
    dsh,
    ctxGet: (name) => dsh.get(name),
    getConfig: () => ({ turnTimeoutMs: timeoutMs }),
    classifyTurnFailure,
  })
  return { runner, agent, emit, listeners, detached }
}

/** 一轮固定脚本的 followup：把事件按顺序同步投放。 */
const playScript = (events) => ({ emit }) => {
  for (const ev of events) emit(ev)
  return Promise.resolve()
}

// ---------- 1. chat：steer 分段拼接 ----------

test('chat：同回合两条 user/message 隔开的分段用 ||| 拼起来（steer 分段）', async () => {
  const { runner } = scriptedDsh({
    followup: playScript([
      { type: 'user/message', data: { role: 'user', source: { kind: 'qq-hub' }, content: [] } },
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '行吧 那我精神上支持你' }] } } },
      { type: 'user/message', data: { role: 'user', source: { kind: 'qq-hub' }, content: [] } },
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '别傻眼了' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]),
  })
  const { value, error } = await settle(runner.runTurn({ sessionId: SESSION, message: MESSAGE, collect: { mode: 'chat' } }))
  assert.equal(error, undefined)
  assert.equal(value.text, '行吧 那我精神上支持你|||别傻眼了', '分段必须按顺序拼接，前一段不能被后一段吞掉')
  assert.equal(value.completion.completed, true)
  assert.equal(value.completion.kind, 'completed')
})

test('chat：runtime-context 的 user/message 不算 steer，不重复拼接前一步', async () => {
  const { runner } = scriptedDsh({
    followup: playScript([
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '旧草稿' }] } } },
      { type: 'user/message', data: { role: 'user', source: { kind: 'runtime-context' }, content: [] } },
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '最终回复' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]),
  })
  const { value } = await settle(runner.runTurn({ sessionId: SESSION, message: MESSAGE, collect: { mode: 'chat' } }))
  assert.equal(value.text, '最终回复')
})

// ---------- 2. chat：末步只剩控制标记时回退 ----------

test('chat：末步只剩控制标记（纯表情）时回退到上一带人话的步', async () => {
  const { runner } = scriptedDsh({
    followup: playScript([
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '就写点后端 天天看日志' }] } } },
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '<sticker:无语>' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]),
  })
  const { value } = await settle(runner.runTurn({ sessionId: SESSION, message: MESSAGE, collect: { mode: 'chat' } }))
  assert.match(value.text, /就写点后端 天天看日志/, '末步只有 <sticker:…> 时不能吞掉上一步正文')
  assert.match(value.text, /<sticker:无语>/, '末步的控制标记仍要保留（表情照发）')
})

test('chat：末步有人话时只发末步，不被上一步旁白污染', async () => {
  const { runner } = scriptedDsh({
    followup: playScript([
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '我先翻一下日志' }] } } },
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '是权限没开' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]),
  })
  const { value } = await settle(runner.runTurn({ sessionId: SESSION, message: MESSAGE, collect: { mode: 'chat' } }))
  assert.equal(value.text, '是权限没开')
})

// ---------- 3. prompt：忽略工具调用、只取最后一条 ----------

test('prompt：忽略 tool/call、只取最后一条 assistant/message 正文', async () => {
  const { runner } = scriptedDsh({
    followup: playScript([
      { type: 'tool/call', data: { name: 'qq_send_sticker', input: {} } },
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '第一句' }] } } },
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '最后一句' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]),
  })
  const { value, error } = await settle(runner.runTurn({ sessionId: SESSION, message: MESSAGE, collect: { mode: 'prompt' } }))
  assert.equal(error, undefined)
  assert.equal(value.text, '最后一句', '主动回合只取最后一条正文')
})

test('prompt：turn/end 的 turn 与最后一条正文不一致时返回空串', async () => {
  const { runner } = scriptedDsh({
    followup: playScript([
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '上一轮的正文' }] } } },
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    ]),
  })
  const { value } = await settle(runner.runTurn({ sessionId: SESSION, message: MESSAGE, collect: { mode: 'prompt' } }))
  assert.equal(value.text, '', '不是本回合的文本不能当成回复返回（如实空串）')
  assert.equal(value.completion.completed, true)
})

// ---------- 4. 超时 ----------

test('超时：抛 TurnExecutionError（timedOut / timedOutForMs 正确），且监听器已摘', async () => {
  const { runner, listeners, detached } = scriptedDsh({ timeoutMs: 20, followup: () => new Promise(() => {}) })
  const { error } = await settle(runner.runTurn({ sessionId: SESSION, message: MESSAGE, collect: { mode: 'chat' } }))
  assert.ok(error instanceof TurnExecutionError, `应是 TurnExecutionError，实际：${error}`)
  assert.equal(error.kind, 'timedOut')
  assert.equal(error.timedOut, true, 'timedOut 字段供调用方决定是否 handleTurnTimeout')
  assert.equal(error.timedOutForMs, 20, '阈值如实带上去（提示文案要按真实配置算）')
  assert.match(error.message, /DSH 回合超过 1 秒未结束/)
  assert.equal(listeners.size, 0, '超时路径同样摘监听')
  assert.equal(detached.length, 1, 'dsh.on 返回的 off 被调用')
})

// ---------- 5. 取消 ----------

test('取消：abort 后抛 name=AbortError 的 TurnExecutionError，且监听器已摘', async () => {
  const abort = new AbortController()
  const { runner, listeners, detached } = scriptedDsh({ followup: () => new Promise(() => {}) })
  const pending = runner.runTurn({ sessionId: SESSION, message: MESSAGE, collect: { mode: 'chat' }, signal: abort.signal })
  await sleep(10)
  abort.abort()
  const { error } = await settle(pending)
  assert.ok(error instanceof TurnExecutionError)
  assert.equal(error.name, 'AbortError', 'turn-controller 按 error.name === AbortError 认「执行器尊重了取消」')
  assert.equal(error.kind, 'cancelled')
  assert.equal(listeners.size, 0, '取消路径同样摘监听')
  assert.equal(detached.length, 1, 'dsh.on 返回的 off 被调用')
})

test('取消：signal 进入时已 aborted → 立刻抛，不碰事件流', async () => {
  const abort = new AbortController()
  abort.abort()
  const { runner, listeners } = scriptedDsh({ followup: () => new Promise(() => {}) })
  const { error } = await settle(runner.runTurn({ sessionId: SESSION, message: MESSAGE, collect: { mode: 'chat' }, signal: abort.signal }))
  assert.equal(error?.name, 'AbortError')
  assert.equal(error.kind, 'cancelled')
  assert.equal(listeners.size, 0)
})

// ---------- 6. 事件流缺失 ----------

test('事件流缺失：抛错且文案含 session/event 流', async () => {
  const { runner } = scriptedDsh({ stream: false })
  const { error } = await settle(runner.runTurn({ sessionId: SESSION, message: MESSAGE, collect: { mode: 'chat' } }))
  assert.ok(error instanceof TurnExecutionError, `应是 TurnExecutionError，实际：${error}`)
  assert.match(error.message, /session\/event 流/)
  assert.equal(error.kind, 'no-stream')
})

// ---------- 7. turn/end 非 completed：kind 透传 + 分类 ----------

test('turn/end 非 completed：kind 原样透传、oversized 由分类器判定、cause 带原始失败', async () => {
  const failure = { code: 'INVALID_REQUEST', status: 413, message: '413 plugin_request_too_large' }
  const { runner } = scriptedDsh({
    followup: playScript([
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '失败前的话' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: failure } } },
    ]),
  })
  const { error } = await settle(runner.runTurn({ sessionId: SESSION, message: MESSAGE, collect: { mode: 'chat' } }))
  assert.ok(error instanceof TurnExecutionError)
  assert.equal(error.kind, 'error')
  assert.equal(error.oversized, true, '413 必须按「请求体过大」分类（下一条消息换会话自愈）')
  assert.equal(error.archived, false)
  assert.equal(error.cause?.status, 413, 'cause 要带原始失败（自愈日志要用它的 message）')
  assert.match(error.message, /^回合未正常结束：error$/)
})

test('turn/end 非 completed：blocked（归档门）→ archived=true，且没有 oversized', async () => {
  const { runner } = scriptedDsh({
    followup: playScript([{ type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } }]),
  })
  const { error } = await settle(runner.runTurn({ sessionId: SESSION, message: MESSAGE, collect: { mode: 'chat' } }))
  assert.equal(error.kind, 'blocked')
  assert.equal(error.archived, true, 'blocked 只能认 kind，不能靠文案')
  assert.equal(error.oversized, false)
})

test('turn/end 非 completed：普通错误两类都不命中（如实失败，不误标自愈）', async () => {
  const { runner } = scriptedDsh({
    followup: playScript([{ type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'RATE_LIMIT' } } } }]),
  })
  const { error } = await settle(runner.runTurn({ sessionId: SESSION, message: MESSAGE, collect: { mode: 'chat' } }))
  assert.equal(error.kind, 'error')
  assert.equal(error.oversized, false)
  assert.equal(error.archived, false)
})

// ---------- 8. 集成：取消后迟到回复不投递 ----------

/** 只吐一条正文、然后就「卡住」的 DSH：回合只有取消才能落定。 */
function stalledDsh() {
  const listeners = new Set()
  const sessionId = 'sess-cancel'
  const followupTurns = []
  const emit = (ev) => { for (const fn of [...listeners]) fn({ id: sessionId }, ev) }
  const workspaces = [{ id: 'ws-cancel', path: 'ws-cancel' }]
  const agent = {
    id: sessionId,
    ctx: { get: () => null },
    followup() {
      followupTurns.push(1)
      emit({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '迟到的话' }] } } })
      return new Promise(() => {}) // 模型还在生成：没有 turn/end
    },
  }
  const ctrl = { create: async () => ({ sessionId }), resolveAgent: async () => ({ agent }) }
  const ctx = {
    on(name, fn) { if (name !== 'session/event') return () => {}; listeners.add(fn); return () => listeners.delete(fn) },
    get(name) {
      if (name === 'sessionController') return ctrl
      if (name === 'workspaceRegistry') return { list: () => workspaces, create: async () => workspaces[0] }
      return null
    },
  }
  return { ctx, emit, listeners, followupTurns }
}

function cancelCore(dshRaw) {
  const sent = []
  const cfg = {
    enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人', /* pii-scan:ignore */
    allow: { private: ['10000001'], groups: [] }, longTasks: false, /* pii-scan:ignore */
    merge: { waitSec: 0.02, maxSec: 0.1 },
  }
  const core = createModularCore({
    dsh: dshRaw.ctx,
    onebot: {
      call: async (action) => {
        if (String(action).startsWith('send_')) sent.push(action)
        return { message_id: String(sent.length) }
      },
    },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
  })
  return { core, sent }
}

let mid = 0
const privMsg = () => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: 20000002, user_id: 10000001, message_id: ++mid, time: Math.floor(Date.now() / 1000), /* pii-scan:ignore */
  sender: { user_id: 10000001, nickname: '主人' }, /* pii-scan:ignore */
  message: [{ type: 'text', data: { text: '在吗' } }],
})

test('集成：running 回合被 cancel → execute 因 signal 提前抛错，回合落 cancelled，迟到回复不投递', async () => {
  const dshRaw = stalledDsh()
  const { core, sent } = cancelCore(dshRaw)
  try {
    const offered = await core.dispatchLegacyEvent(privMsg())
    assert.equal(offered.handled, 'offered')
    const turnId = offered.turnId
    // 等合流窗口到期、回合真的进入 running（merging 态取消不会经过 execute，测不到 signal）
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && core.controller.getTurn(turnId)?.state !== 'running') await sleep(10)
    assert.equal(core.controller.getTurn(turnId)?.state, 'running', '回合应在跑')
    assert.equal(dshRaw.followupTurns.length, 1)

    const request = core.controller.cancel(turnId)
    assert.equal(request.honest, 'cancel-requested', 'running 态 cancel 只是请求，终态由 execute 落定')
    // 等回合终态：旧实现（execute 不读 signal）会一直挂着不落定 —— 这里用超时把它变成干净的断言失败。
    let guardId = null
    const guard = new Promise((resolve) => { guardId = setTimeout(() => resolve({ state: 'timeout' }), 3000) })
    guardId.unref?.()
    const settled = await Promise.race([core.controller.waitForTurn(turnId), guard])
    clearTimeout(guardId)
    assert.equal(settled.state, 'cancelled', 'execute 尊重 io.signal → 回合诚实落 cancelled（不谎报 succeeded，也不挂死）')
    assert.match(String(core.controller.getTurn(turnId)?.error || ''), /取消/)

    // 迟到的回复：再补一条 assistant/message + turn/end 也不许投递
    dshRaw.emit({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '迟到的正文' }] } } })
    dshRaw.emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await sleep(200)
    assert.deepEqual(sent, [], '取消后零投递（迟到回复不再补发）')
    assert.equal(core.outbox.ledger.stats().byState.sent ?? 0, 0, 'outbox 里没有该回合的投递记录')
    assert.equal(dshRaw.listeners.size, 0, '取消路径也摘监听（不留句柄）')
  } finally {
    await core.dispose()
  }
})