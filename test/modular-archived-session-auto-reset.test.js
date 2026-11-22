// 归档会话自愈（fix/archived-session-deadlock）：
// DSH 有一个常驻、关不掉的 `archived-session-gate`（dsh-api-session-controller）：
// 对已归档会话的**每一步**返回 { kind:'reject' }，agent-loop 随即把回合落成
// `turn/end reason.kind === 'blocked'` —— 一个模型调用都不会发生（会话里 turn/start 与
// turn/end 之间没有 step/start）。真机 2026-11-21：群 900000003 连续 5 轮 blocked。
//
// 本插件此前从不问「这个会话是不是已被归档」，而 blocked 既不命中超时自愈也不命中 413 自愈，
// 于是映射永远指着那个跑不了的会话 → 这个聊天永久卡死。
//
// 断言面（走真实入口 dispatchLegacyEvent / runPromptTurn，不测私有函数）：
//   1. 映射里的会话已在 archivedSessionIds 里 → 下一轮直接换新会话（不必先吃一次 blocked）；
//   2. turn/end 落成 blocked → 本轮不发；下一条消息进入时换新会话并正常回复；
//   3. 查询归档集合炸掉（宿主没有 workspaceRegistry）→ 不误换会话（fail-open，别把好会话换掉）。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createModularCore } from '../src/host/modular-core.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }

/**
 * 事件可编程的最小 DSH：每轮按脚本投放 assistant/message / turn/end，会话可数。
 * @param {{script?: Array, archived?: string[], breakArchiveProbe?: boolean}} o
 */
function scriptedFakeDsh({ script = [], archived = [], breakArchiveProbe = false } = {}) {
  const listeners = new Set()
  const sessionIds = []
  let turnNo = 0
  const workspaces = [{ id: 'ws', path: 'ws' }]
  const contextsMap = new Map()
  const archivedIds = [...archived]
  function makeAgent(id) {
    return {
      id,
      ctx: { get(name) { if (name === 'contexts') return { set: (k, v) => contextsMap.set(k, v), get: (k) => contextsMap.get(k) }; return null } },
      followup() {
        const n = ++turnNo
        const session = { id }
        // 默认脚本必须带 assistant/message：只给 turn/end completed 会是「空回复」，投递层不发，
        // 断言「正常回复」就会假失败（照抄 oversize 夹具的默认值会踩这个坑）。
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
          archiveSession: (id) => { archivedIds.push(id); return Promise.resolve() },
          get archivedSessionIds() {
            if (breakArchiveProbe) throw new Error('宿主探测炸了')
            return archivedIds
          },
        }
      }
      return null
    },
  }
  return { ctx, sessionIds, archivedIds }
}

function mkCore(dshRaw, cfgOver = {}) {
  const sent = []
  const cfg = {
    enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人',
    allow: { private: ['10000001'], groups: ['777'] }, longTasks: false,
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
  self_id: 20000002, user_id: 10000001, message_id: Math.floor(Math.random() * 1e9), time: Math.floor(Date.now() / 1000),
  sender: { user_id: 10000001, nickname: '主人' },
  message: [{ type: 'text', data: { text: '在吗' } }],
  ...over,
})

const replyEvents = (text) => [
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } },
  { type: 'turn/end', data: { reason: { kind: 'completed' } } },
]

test('归档自愈：映射里的会话已归档 → 下一轮直接换新会话，不再吃 blocked', async () => {
  const dshRaw = scriptedFakeDsh({ archived: ['sess-1'] })
  const { core, sent } = mkCore(dshRaw)
  try {
    // 先让映射指向 sess-1（此时它还没归档）
    dshRaw.archivedIds.length = 0
    await core.dispatchLegacyEvent(msgEv({ message_id: 1 }))
    await sleep(300)
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-1', '第一轮用 sess-1')
    assert.ok(sent.includes('send_private_msg'), '第一轮正常回复')

    // 宿主侧把 sess-1 归档（用户手动归档 / 第三方插件）
    dshRaw.archivedIds.push('sess-1')

    // 下一轮：必须发现「这个会话跑不了」并换新，而不是把 blocked 吃下来
    await core.dispatchLegacyEvent(msgEv({ message_id: 2 }))
    await sleep(300)
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-2', '已归档 → 换新会话')
    assert.equal(dshRaw.sessionIds.length, 2, '没有额外多建会话（只换一次）')
  } finally { await core.dispose() }
})

test('归档自愈：turn/end 落成 blocked → 本轮不发；下一条消息换新会话并正常回复', async () => {
  const dshRaw = scriptedFakeDsh({ script: [
    // 第 1 轮正常
    replyEvents('第一轮'),
    // 第 2 轮被归档门拦下：assistant 一条都没有，直接 blocked
    [{ type: 'turn/end', data: { reason: { kind: 'blocked' } } }],
    // 第 3 轮（换新会话后）正常
    replyEvents('新会话的回复'),
  ] })
  const { core, sent } = mkCore(dshRaw)
  try {
    await core.dispatchLegacyEvent(msgEv({ message_id: 1 }))
    await sleep(300)
    assert.ok(sent.includes('send_private_msg'), '第一轮正常回复')
    const before = sent.length

    // blocked 轮：不发任何回复，且映射保留（换会话留到下一条消息，与 413 同款时序）
    await core.dispatchLegacyEvent(msgEv({ message_id: 2 }))
    await sleep(300)
    assert.equal(sent.length, before, 'blocked 轮一条都不发（不做假成功）')
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-1', 'blocked 后映射保留到下一轮')

    // 下一条消息：自动换新会话并正常回复
    await core.dispatchLegacyEvent(msgEv({ message_id: 3 }))
    await sleep(300)
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-2', 'blocked 自愈 → 换新会话')
    assert.equal(sent.length, before + 1, '新会话正常回复')
    assert.ok(dshRaw.archivedIds.includes('sess-1'), '旧会话已归档（侧栏可找回）')
  } finally { await core.dispose() }
})

test('归档自愈：探测归档集合失败时不误换会话（fail-open）', async () => {
  const dshRaw = scriptedFakeDsh({ breakArchiveProbe: true })
  const { core, sent } = mkCore(dshRaw)
  try {
    await core.dispatchLegacyEvent(msgEv({ message_id: 1 }))
    await sleep(300)
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-1', '探测失败沿用原会话')
    assert.ok(sent.includes('send_private_msg'), '正常回复')

    await core.dispatchLegacyEvent(msgEv({ message_id: 2 }))
    await sleep(300)
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-1', '第二轮也不换（不误伤）')
  } finally { await core.dispose() }
})