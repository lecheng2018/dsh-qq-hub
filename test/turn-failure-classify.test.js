// S1 · 回合失败分类 + 待重置标记（pendingResets）。
//
// 覆盖三件事：
//   1. classifyTurnFailure 的四类判定（请求体过大 / 归档门 blocked / 超时 / 普通失败），
//      并且「请求体过大」的判定与既有 turnFailureLooksOversized **逐例等价**（不许放宽收紧）；
//   2. pendingResets 的优先级合并：archived > oversized > timedOut，后写入的低优先级不得覆盖；
//   3. takePendingReset 取出即清除（同一个标记只触发一次 resetChat），
//      以及同一 chatKey 连续两轮 413 时两轮各 reset 一次（不能只 reset 一次就丢标记）。
//
// 入口都是真实导出：单测走 turn-failure.js 的纯函数，集成用例走 createModularCore 的公开入口
// （dispatchLegacyEvent），不碰私有状态。

import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyTurnFailure, markPendingReset, takePendingReset, turnFailureLooksOversized } from '../src/host/core/turn-failure.js'
import { createModularCore } from '../src/host/modular-core.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }

// ---------- 1. classifyTurnFailure：四类判定 ----------

test('分类：413 结构化失败码 → oversized', () => {
  const c = classifyTurnFailure({ code: 'INVALID_REQUEST', status: 413, message: '本次对话上下文或图片过大' })
  assert.equal(c.kind, 'oversized')
  assert.equal(c.oversized, true)
  assert.equal(c.archived, false)
  assert.equal(c.timedOutForMs, 0)
})

test('分类：只有中文文案（无 status）也 → oversized', () => {
  const c = classifyTurnFailure({ code: 'INVALID_REQUEST', message: '413 {"code":"plugin_request_too_large","message":"本次对话上下文或图片过大：请求约 5.8 MiB，插件内存上限 64 MiB"}' })
  assert.equal(c.kind, 'oversized')
  assert.equal(c.oversized, true)
})

test('分类：pi-ai 误判成 CONTEXT_WINDOW_EXCEEDED 仍 → oversized（文案优先）', () => {
  const c = classifyTurnFailure({ code: 'CONTEXT_WINDOW_EXCEEDED', message: '413: {"code":"plugin_request_too_large","message":"请求约 5.3 MiB，插件内存上限 64 MiB"}' })
  assert.equal(c.kind, 'oversized')
})

test('分类：归档门 blocked → archived', () => {
  const c = classifyTurnFailure({ kind: 'blocked' })
  assert.equal(c.kind, 'archived')
  assert.equal(c.archived, true)
  assert.equal(c.oversized, false)
  assert.equal(c.timedOutForMs, 0)
})

test('分类：本地等待超时 → timedOut，并带出时长', () => {
  const c = classifyTurnFailure({ turnTimedOut: true, timedOutForMs: 600_000 })
  assert.equal(c.kind, 'timedOut')
  assert.equal(c.timedOutForMs, 600_000)
  assert.equal(c.oversized, false)
  assert.equal(c.archived, false)
})

test('分类：普通失败（429 / 空 / 字符串）→ other，不误触发自愈', () => {
  for (const failure of [{ code: 'RATE_LIMIT', status: 429, message: 'rate limit exceeded' }, { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'prompt is too long: 213462 tokens > 200000 maximum' }, null, undefined, '', 'error']) {
    const c = classifyTurnFailure(failure)
    assert.equal(c.kind, 'other', `${JSON.stringify(failure)} 应归 other`)
    assert.equal(c.oversized, false)
    assert.equal(c.archived, false)
    assert.equal(c.timedOutForMs, 0)
  }
})

test('分类：oversized 判定与既有 turnFailureLooksOversized 逐例等价（不放宽也不收紧）', () => {
  const matrix = [
    null,
    undefined,
    '',
    'blocked',
    {},
    { code: 'INVALID_REQUEST', status: 413 },
    { status: 413, message: '随便什么' },
    { status: '413', message: 'x' },
    { code: 'INVALID_REQUEST', message: 'plugin_request_too_large' },
    { code: 'INVALID_REQUEST', message: 'payload too large' },
    { code: 'OTHER', message: 'request body too large' },
    { message: 'HTTP 413：请求约 5.8 MiB，上下文或图片过大' },
    { message: '请求体过大' },
    { message: '413' },
    { message: '413 但只是随便提一句' },
    { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'prompt is too long: 213462 tokens > 200000 maximum' },
    { code: 'RATE_LIMIT', status: 429, message: 'rate limit exceeded' },
    { kind: 'blocked' },
    { turnTimedOut: true, timedOutForMs: 1 },
    { code: 'INVALID_REQUEST', status: 400, message: 'bad request' },
  ]
  for (const failure of matrix) {
    assert.equal(
      classifyTurnFailure(failure).oversized,
      turnFailureLooksOversized(failure),
      `413 判定必须与 turnFailureLooksOversized 等价：${JSON.stringify(failure)}`,
    )
  }
})

// ---------- 2. pendingResets：优先级合并 ----------

test('pendingResets 优先级：timedOut → oversized 取 oversized，再加 archived 取 archived', () => {
  const pendingResets = new Map()
  markPendingReset(pendingResets, 'private:1', 'timedOut')
  assert.equal(pendingResets.get('private:1'), 'timedOut')
  // 更强的理由覆盖更弱的
  markPendingReset(pendingResets, 'private:1', 'oversized')
  assert.equal(pendingResets.get('private:1'), 'oversized', '先 timedOut 后 oversized → oversized')
  markPendingReset(pendingResets, 'private:1', 'archived')
  assert.equal(pendingResets.get('private:1'), 'archived', '再加 archived → archived')
  // 低优先级不得覆盖已存在的高优先级（重复标记不能把更强的自愈理由丢掉）
  assert.equal(markPendingReset(pendingResets, 'private:1', 'oversized'), 'archived', 'oversized 不得覆盖 archived')
  assert.equal(pendingResets.get('private:1'), 'archived')
  assert.equal(markPendingReset(pendingResets, 'private:1', 'timedOut'), 'archived', 'timedOut 不得覆盖 archived')
  assert.equal(pendingResets.get('private:1'), 'archived')
  // 同级重复写入无副作用
  markPendingReset(pendingResets, 'private:1', 'archived')
  assert.equal(pendingResets.get('private:1'), 'archived')
})

test('pendingResets 优先级：timedOut 不覆盖 oversized，oversized 不覆盖 archived', () => {
  const a = new Map()
  markPendingReset(a, 'private:2', 'oversized')
  markPendingReset(a, 'private:2', 'timedOut')
  assert.equal(a.get('private:2'), 'oversized', 'timedOut 比 oversized 弱，不得覆盖')

  const b = new Map()
  markPendingReset(b, 'private:3', 'archived')
  markPendingReset(b, 'private:3', 'oversized')
  assert.equal(b.get('private:3'), 'archived', 'oversized 比 archived 弱，不得覆盖')
})

test('pendingResets 按 chatKey 分开记，互不影响', () => {
  const pendingResets = new Map()
  markPendingReset(pendingResets, 'private:1', 'timedOut')
  markPendingReset(pendingResets, 'group:9', 'archived')
  assert.equal(pendingResets.get('private:1'), 'timedOut')
  assert.equal(pendingResets.get('group:9'), 'archived')
})

// ---------- 3. takePendingReset：取出即清除 ----------

test('takePendingReset 取出后 Map 里不再有该 key（不会重复 reset）', () => {
  const pendingResets = new Map()
  markPendingReset(pendingResets, 'private:1', 'oversized')
  assert.equal(takePendingReset(pendingResets, 'private:1'), 'oversized')
  assert.equal(pendingResets.has('private:1'), false, '取出后必须清除')
  assert.equal(takePendingReset(pendingResets, 'private:1'), null, '第二次取出没有标记')
  // 别的 chatKey 不受影响
  markPendingReset(pendingResets, 'group:9', 'timedOut')
  takePendingReset(pendingResets, 'private:1')
  assert.equal(pendingResets.get('group:9'), 'timedOut')
})

test('takePendingReset：没有标记时返回 null，不清空别人的标记', () => {
  const pendingResets = new Map()
  assert.equal(takePendingReset(pendingResets, 'private:404'), null)
  assert.equal(pendingResets.size, 0)
})

// ---------- 4. 集成：同一 chatKey 连续两轮 413，两轮各 reset 一次 ----------

/** 事件可编程的最小 DSH：每轮按脚本投放 assistant/message / turn/end，会话可数、归档可数。 */
function scriptedFakeDsh({ script = [] } = {}) {
  const listeners = new Set()
  const sessionIds = []
  let turnNo = 0
  const workspaces = [{ id: 'ws', path: 'ws' }]
  const contextsMap = new Map()
  function makeAgent(id) {
    return {
      id,
      ctx: { get(name) { if (name === 'contexts') return { set: (k, v) => contextsMap.set(k, v), get: (k) => contextsMap.get(k) }; return null } },
      followup() {
        const n = ++turnNo
        // 会话 id 必须用 agent 自己的 id：不换会话时按轮次取下标会拿到 undefined，监听器按
        // session.id 过滤就把事件全吞掉 —— 整个回合永不 settlement（夹具坑，别用下标）。
        const session = { id }
        const events = script[n - 1] || [
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好' }] } } },
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        ]
        for (const ev of events) for (const fn of [...listeners]) fn(session, { ...ev, data: { ...ev.data, turn: n } })
        return Promise.resolve()
      },
    }
  }
  const ctrl = {
    create: async () => { const id = `sess-${sessionIds.length + 1}`; sessionIds.push(id); return { sessionId: id } },
    resolveAgent: async (id) => ({ agent: makeAgent(id) }),
  }
  const ctx = {
    on(name, fn) { if (name !== 'session/event') return () => {}; listeners.add(fn); return () => listeners.delete(fn) },
    get(name) {
      if (name === 'sessionController') return ctrl
      if (name === 'workspaceRegistry') {
        return {
          list: () => workspaces,
          create: async () => workspaces[0],
          archiveSession: (id) => { workspaces.archived = [...(workspaces.archived || []), id]; return Promise.resolve() },
        }
      }
      return null
    },
  }
  return { ctx, sessionIds, workspaces }
}

function mkCore(dshRaw, cfgOver = {}) {
  const sent = []
  const cfg = {
    enabled: true, dryRun: false, botQQ: '2000', ownerQQ: '1000', ownerName: '主人',
    allow: { private: ['1000'], groups: ['77'] }, longTasks: false,
    merge: { waitSec: 0.02, maxSec: 0.1 },
    ...cfgOver,
  }
  const core = createModularCore({
    dsh: dshRaw.ctx,
    onebot: { call: async (action) => { if (action.startsWith('send_')) sent.push(action); return { message_id: String(sent.length) } } },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
  })
  return { core, sent }
}

const msgEv = (over = {}) => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: 2000, user_id: 1000, message_id: Math.floor(Math.random() * 1e6), time: Math.floor(Date.now() / 1000),
  sender: { user_id: 1000, nickname: '主人' },
  message: [{ type: 'text', data: { text: '在吗' } }],
  ...over,
})

const OVERSIZED_TURN = [
  { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'INVALID_REQUEST', status: 413, message: '本次对话上下文或图片过大：请求约 5.8 MiB，插件内存上限 64 MiB' } } } },
]
const OK_TURN = [
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已恢复' }] } } },
  { type: 'turn/end', data: { reason: { kind: 'completed' } } },
]

test('pendingResets 集成：同一 chatKey 连续两轮 413 → 两轮各 reset 一次（标记不会只消费一次就丢）', async () => {
  const dshRaw = scriptedFakeDsh({ script: [OVERSIZED_TURN, OVERSIZED_TURN, OK_TURN] })
  const { core, sent } = mkCore(dshRaw)
  try {
    // 第 1 轮 413：只记标记，映射保留旧会话
    await core.dispatchLegacyEvent(msgEv({ message_id: 1 }))
    await sleep(300)
    assert.equal(core.registry.peek('private:1000')?.sessionId, 'sess-1', '413 当轮不换会话（下一条消息才重建）')

    // 第 2 轮：消费标记 → resetChat（sess-1 归档）+ 新建 sess-2；这一轮又 413 → 再记标记
    await core.dispatchLegacyEvent(msgEv({ message_id: 2 }))
    await sleep(300)
    assert.equal(core.registry.peek('private:1000')?.sessionId, 'sess-2', '第二次进入该聊天 → 换新会话')
    assert.deepEqual(dshRaw.workspaces.archived || [], ['sess-1'], '第一轮失败已归档一次')

    // 第 3 轮：再消费一次标记 → sess-2 归档 + 新建 sess-3，正常回复
    await core.dispatchLegacyEvent(msgEv({ message_id: 3 }))
    await sleep(300)
    assert.equal(core.registry.peek('private:1000')?.sessionId, 'sess-3', '连续第二轮 413 同样会自愈')
    assert.deepEqual(dshRaw.workspaces.archived || [], ['sess-1', 'sess-2'], '两轮各 reset 一次（不是只 reset 一次就丢标记）')
    assert.ok(sent.includes('send_private_msg'), '第三轮正常回复')
  } finally { await core.dispose() }
})
