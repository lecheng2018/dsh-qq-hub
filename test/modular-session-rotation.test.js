// 会话轮换（feat/session-rotation）：
// 服务端按**会话**累计上下文（真机 413 plugin_request_too_large：请求约 5.8 MiB、
// 插件内存上限 64 MiB），纯文字长谈也会慢慢顶到上限；DSH 的上下文压缩管的是 token 窗口，
// 管不到服务端那种按字节的会话额度。所以给每个聊天一个「用多久/聊多少轮就该换」的阈值，
// 到了就归档重开（旧会话在 DSH 侧栏还能找回）。
//
// 断言面（走真实入口 dispatchLegacyEvent / runPromptTurn）：
//   1. 回合数：maxTurns=2 → 第 3 轮换新会话，旧会话进归档；
//   2. 年龄：maxAgeHours 极小 → 下一轮换新会话（证明「光聊天少也会因为放太久而换」）；
//   3. 关掉开关：连跑多轮始终同一会话（面板能退）；
//   4. 主动回合也过同一处判定（否则后台任务会把老会话一直用下去）。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createModularCore } from '../src/host/modular-core.js'
import { normalize } from '../src/core/config.js'

const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fakeDsh() {
  const listeners = new Set()
  const sessions = []
  const workspaces = [{ id: 'ws', path: 'ws' }]
  workspaces.archived = []
  const turns = []
  function makeAgent(id) {
    return {
      id,
      ctx: { get: () => null },
      followup(msg) {
        turns.push({ sessionId: id })
        const session = { id }
        for (const fn of [...listeners]) {
          fn(session, { type: 'assistant/message', data: { turn: turns.length, message: { content: [{ type: 'text', text: '好' }] } } })
          fn(session, { type: 'turn/end', data: { turn: turns.length, reason: { kind: 'completed' } } })
        }
        return Promise.resolve()
      },
    }
  }
  const ctrl = {
    create: async () => { const id = `sess-${sessions.length + 1}`; sessions.push(id); return { sessionId: id } },
    resolveAgent: async (id) => ({ agent: makeAgent(id) }),
  }
  const ctx = {
    on(name, fn) { if (name !== 'session/event') return () => {}; listeners.add(fn); return () => listeners.delete(fn) },
    get(name) {
      if (name === 'sessionController') return ctrl
      if (name === 'workspaceRegistry') return { list: () => workspaces, create: async () => workspaces[0], archiveSession: (id) => workspaces.archived.push(id) }
      return null
    },
  }
  return { ctx, sessions, workspaces, turns }
}

function mkCore(dshRaw, cfgOver = {}) {
  const base = normalize({ botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人' })
  const cfg = {
    ...base,
    enabled: true, dryRun: false,
    allow: { private: ['10000001'], groups: ['777'] }, longTasks: false,
    merge: { waitSec: 0.02, maxSec: 0.1, groupWaitSec: 0.02, groupMaxSec: 0.1 },
    ...cfgOver,
  }
  if (cfgOver.sessionRotation) cfg.sessionRotation = { ...base.sessionRotation, ...cfgOver.sessionRotation }
  const core = createModularCore({
    dsh: dshRaw.ctx,
    onebot: { call: async () => ({ message_id: '1' }) },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
  })
  return { core, cfg }
}

let mid = 0
const msgEv = () => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: 20000002, user_id: 10000001, message_id: ++mid, time: Math.floor(Date.now() / 1000),
  sender: { user_id: 10000001, nickname: '主人' },
  message: [{ type: 'text', data: { text: '在吗' } }],
})

test('会话轮换：回合数到阈值就换新会话，旧会话进归档', async () => {
  const dshRaw = fakeDsh()
  const { core } = mkCore(dshRaw, { sessionRotation: { maxTurns: 2, maxAgeHours: 0 } })
  try {
    await core.dispatchLegacyEvent(msgEv()); await sleep(600)
    await core.dispatchLegacyEvent(msgEv()); await sleep(600)
    assert.equal(dshRaw.turns.length, 2)
    assert.ok(dshRaw.turns.every((t) => t.sessionId === 'sess-1'), '前 2 轮都在同一个会话')
    // 第 3 轮：2 轮已达上限 → 归档重开
    await core.dispatchLegacyEvent(msgEv()); await sleep(600)
    assert.equal(dshRaw.turns[2].sessionId, 'sess-2', '第 3 轮换到了新会话')
    assert.deepEqual(dshRaw.workspaces.archived, ['sess-1'], '旧会话已归档（侧栏可找回）')
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-2')
  } finally { await core.dispose() }
})

test('会话轮换：会话放太久也会换（光回合数管不到「隔几天再说一句」）', async () => {
  const dshRaw = fakeDsh()
  // 0.0001 小时 = 0.36 秒：等 600ms 后下一轮必然超龄
  const { core } = mkCore(dshRaw, { sessionRotation: { maxTurns: 0, maxAgeHours: 0.0001 } })
  try {
    await core.dispatchLegacyEvent(msgEv()); await sleep(600)
    assert.equal(dshRaw.turns[0].sessionId, 'sess-1')
    await core.dispatchLegacyEvent(msgEv()); await sleep(600)
    assert.equal(dshRaw.turns[1].sessionId, 'sess-2', '超龄 → 换新会话')
  } finally { await core.dispose() }
})

test('会话轮换：enabled=false 时一直用同一会话（面板能退）', async () => {
  const dshRaw = fakeDsh()
  const { core } = mkCore(dshRaw, { sessionRotation: { enabled: false, maxTurns: 1, maxAgeHours: 0.0001 } })
  try {
    for (let i = 0; i < 3; i++) { await core.dispatchLegacyEvent(msgEv()); await sleep(600) }
    assert.equal(dshRaw.turns.length, 3)
    assert.ok(dshRaw.turns.every((t) => t.sessionId === 'sess-1'), '开关关掉 = 永不轮换')
    assert.deepEqual(dshRaw.workspaces.archived, [], '没触发归档')
  } finally { await core.dispose() }
})

test('会话轮换：主动回合走同一处判定（否则后台任务会把老会话一直用下去）', async () => {
  const dshRaw = fakeDsh()
  const { core } = mkCore(dshRaw, { sessionRotation: { maxTurns: 1, maxAgeHours: 0 } })
  try {
    assert.equal(await core.runPromptTurn('private:10000001', '写日记'), '好')
    assert.equal(dshRaw.turns[0].sessionId, 'sess-1')
    assert.equal(await core.runPromptTurn('private:10000001', '再写一次'), '好')
    assert.equal(dshRaw.turns[1].sessionId, 'sess-2', '主动回合同样轮换')
  } finally { await core.dispose() }
})

test('会话轮换配置：默认值与上下界（关不掉也不会被填成负数）', () => {
  const d = normalize({})
  assert.equal(d.sessionRotation.enabled, true)
  // 2026-11-23：300 轮 / 168h 等于关掉了这个兜底（人设改动只能等手动重置），改成 60 轮 / 24h
  assert.equal(d.sessionRotation.maxTurns, 60)
  assert.equal(d.sessionRotation.maxAgeHours, 24)
  assert.equal(d.sessionRotation.migrated, true, '迁移标记要落下来，下次不再动主人的值')
  const clamped = normalize({ sessionRotation: { enabled: 'yes', maxTurns: -5, maxAgeHours: -1 } })
  assert.equal(clamped.sessionRotation.enabled, true, '非布尔值回退默认 true')
  assert.equal(clamped.sessionRotation.maxTurns, 0, '负数夹到 0 = 该项不启用')
  assert.equal(clamped.sessionRotation.maxAgeHours, 0)
})

test('一次性迁移：老默认 300/168 换成 60/24，主人自己调过的不动', () => {
  // 老配置原样没动过 → 换成新默认（否则这批用户永远等不到轮换）
  const legacy = normalize({ sessionRotation: { enabled: true, maxTurns: 300, maxAgeHours: 168 } })
  assert.equal(legacy.sessionRotation.maxTurns, 60)
  assert.equal(legacy.sessionRotation.maxAgeHours, 24)
  // 主人自己改过 → 一个字都不动
  const custom = normalize({ sessionRotation: { enabled: true, maxTurns: 200, maxAgeHours: 100 } })
  assert.equal(custom.sessionRotation.maxTurns, 200)
  assert.equal(custom.sessionRotation.maxAgeHours, 100)
  // 已经迁移过（带标记）→ 即使还是 300/168 也不再改（主人后来主动调回去的）
  const pinned = normalize({ sessionRotation: { enabled: true, maxTurns: 300, maxAgeHours: 168, migrated: true } })
  assert.equal(pinned.sessionRotation.maxTurns, 300)
  assert.equal(pinned.sessionRotation.maxAgeHours, 168)
})
