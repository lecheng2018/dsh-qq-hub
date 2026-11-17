// 回归（上游遗留缺陷②）：群缓冲 fed 标记时机——不静默丢消息。
//
// 旧版 groupPromptContent 一进来就 `for (const x of buf) x.fed = true`，两个丢消息口子：
//   ① 突发超过 20 条时，未选中的新消息也被标 fed → 永远进不了上下文；
//   ② 标在 followup 之前，回合若在模型消费前失败，这些消息已 fed → 下轮不再喂。
// 修复：只把选中的 fresh 作为 fedItems 返回，execute 在**拿到回复后**才标 fed；
//       失败路径不标，下一轮重新作为 fresh 喂入。
//
// 观测面：假 DSH 的 followup 收到什么 prompt（= 模型实际看到的群上下文）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createModularCore } from '../src/host/modular-core.js'

const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 可编程假 DSH：记录每轮 followup 的 prompt 文本，可注入第 N 轮拒绝。 */
function capturingDsh({ rejectTurn = null } = {}) {
  const listeners = new Set()
  const session = { id: 'sess-fed' }
  const contextsMap = new Map()
  const prompts = []
  let turnNo = 0
  const agent = {
    id: session.id,
    ctx: { get: (name) => (name === 'contexts' ? { set: (k, v) => contextsMap.set(k, v), get: (k) => contextsMap.get(k), values: () => contextsMap.values() } : null) },
    followup(msg) {
      const n = ++turnNo
      prompts.push((msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'))
      if (rejectTurn === n) return Promise.reject(new Error('brain boom'))
      for (const fn of [...listeners]) fn(session, { type: 'assistant/message', data: { turn: n, message: { content: [{ type: 'text', text: '嗯' }] } } })
      for (const fn of [...listeners]) fn(session, { type: 'turn/end', data: { turn: n, reason: { kind: 'completed' } } })
      return Promise.resolve()
    },
  }
  const ctrl = { create: async () => ({ sessionId: session.id }), resolveAgent: async () => ({ agent }) }
  const ctx = {
    on(name, fn) { if (name !== 'session/event') return () => {}; listeners.add(fn); return () => listeners.delete(fn) },
    get(name) {
      if (name === 'sessionController') return ctrl
      if (name === 'workspaceRegistry') return { list: () => [{ id: 'ws-fed', path: 'ws-fed' }], create: async () => ({ id: 'ws-fed', path: 'ws-fed' }) }
      return null
    },
  }
  return { ctx, prompts }
}

function makeCore(dsh) {
  const cfg = {
    enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人',
    allow: { private: ['10000001'], groups: ['777'] }, longTasks: false,
    merge: { waitSec: 0.02, maxSec: 0.1, groupWaitSec: 0.02, groupMaxSec: 0.1 },
    group: { interjectChance: 0, quota: { enabled: false } },
    security: { identityGuard: { enabled: false } },
    voice: { enabled: false, autoChance: 0 }, stickers: { enabled: false, faces: false, autoChance: 0 },
    reply: { groupMaxChars: 500, maxBubbles: 3 },
  }
  const core = createModularCore({
    dsh: dsh.ctx,
    onebot: { call: async () => ({ message_id: 1 }) },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
  })
  return core
}

let mid = 0
const groupMsg = (text, { at = false } = {}) => ({
  post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: 777,
  self_id: 20000002, user_id: 555, message_id: ++mid, time: Math.floor(Date.now() / 1000),
  sender: { user_id: 555, nickname: '甲' },
  message: at ? [{ type: 'at', data: { qq: 20000002 } }, { type: 'text', data: { text: ` ${text}` } }] : [{ type: 'text', data: { text } }], /* pii-scan:ignore */
})

test('群缓冲：回合在模型消费前失败，消息不标 fed，下一轮重新喂入（不丢）', async () => {
  const dsh = capturingDsh({ rejectTurn: 1 })
  const core = makeCore(dsh)
  try {
    // 3 条普通消息缓冲（不触发回合），第 4 条 @ 触发第 1 轮（注入拒绝）
    for (const t of ['失败前甲', '失败前乙', '失败前丙']) await core.dispatchLegacyEvent(groupMsg(t))
    await core.dispatchLegacyEvent(groupMsg('触发拒绝', { at: true }))
    await sleep(250)
    assert.equal(dsh.prompts.length, 1, '第 1 轮确实跑了（随后拒绝）')
    assert.match(dsh.prompts[0], /失败前甲/, '第 1 轮 prompt 含缓冲消息')

    // 第 5 条 @ 触发第 2 轮（成功）。失败那轮的消息必须仍在上下文里。
    await core.dispatchLegacyEvent(groupMsg('再试', { at: true }))
    await sleep(250)
    assert.equal(dsh.prompts.length, 2, '第 2 轮正常执行')
    assert.match(dsh.prompts[1], /失败前甲/, '失败轮的消息没被标 fed，第 2 轮重新喂入')
    assert.match(dsh.prompts[1], /失败前乙/)
    assert.match(dsh.prompts[1], /失败前丙/)
  } finally { await core.dispose() }
})

test('群缓冲：突发超过 20 条，未选中的新消息不被标 fed，下一轮仍可见（不丢）', async () => {
  const dsh = capturingDsh()
  const core = makeCore(dsh)
  try {
    // 25 条普通消息 + 1 条 @ = 26 条缓冲；fresh 只取最近 20 条（#7~#26）
    for (let i = 1; i <= 25; i++) await core.dispatchLegacyEvent(groupMsg(`群消息${i}`))
    await core.dispatchLegacyEvent(groupMsg('群消息26', { at: true }))
    await sleep(250)
    assert.equal(dsh.prompts.length, 1)
    assert.match(dsh.prompts[0], /群消息26/, '触发轮在上下文里')
    assert.match(dsh.prompts[0], /群消息7/, '最近 20 条的边界（#7）在上下文里')
    assert.ok(!dsh.prompts[0].includes('群消息1\n') && !/群消息1[^\d]/.test(dsh.prompts[0]), '超出 20 条的 #1 本轮不喂（只取最近 20）')

    // 再来一条 @ 触发第 2 轮：之前未选中的 #1~#6 必须仍 unfed，这一轮喂入。
    await core.dispatchLegacyEvent(groupMsg('群消息27', { at: true }))
    await sleep(250)
    assert.equal(dsh.prompts.length, 2)
    for (const i of [1, 2, 3, 4, 5, 6]) {
      assert.ok(new RegExp(`群消息${i}[^\\d]`).test(dsh.prompts[1]), `未选中的 #${i} 下一轮仍可见（旧版会静默丢）`)
    }
  } finally { await core.dispose() }
})