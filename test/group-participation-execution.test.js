// T2.2 真实链路测试：REACT 在模型会话前短路（sessionForChat / 装配 / runTurn / typing 零调用），
// must/engaged 仍走模型；合流升级反例（REACT 声明未决期间 must 先建回合 → REACT 零执行、模型恰好一次）。
// 全部走真实 createModularCore + 真实 modules（api.on 注册）+ 真实 turn-controller 合并窗口。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModularCore } from '../src/host/modular-core.js'
import { createModules } from '../src/core/modules.js'

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, child: () => noopLog }
const GID = '30001'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 真实模块内核：group/participate 行为可切换 ----------
const gpCalls = []
let gpBehavior = null
const gpModule = {
  id: 'gp-mod', name: '参与测试', version: '1.0.0', api: 1,
  setup(api) {
    api.on('group/participate', (decision, info) => {
      gpCalls.push({ decision, info })
      return gpBehavior ? gpBehavior(decision, info) : undefined
    })
    return {}
  },
}

let dataDir
let mods
let core

function mkDsh() {
  const listeners = new Set()
  const session = { id: 'sess-b2' }
  const contextsMap = new Map()
  const prompts = []
  let createCalls = 0
  let turnNo = 0
  const agent = {
    id: session.id,
    ctx: { get: (name) => (name === 'contexts' ? { set: (k, v) => contextsMap.set(k, v), get: (k) => contextsMap.get(k), values: () => contextsMap.values() } : null) },
    followup(msg) {
      const n = ++turnNo
      prompts.push((msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'))
      for (const fn of [...listeners]) fn(session, { type: 'assistant/message', data: { turn: n, message: { content: [{ type: 'text', text: '嗯' }] } } })
      for (const fn of [...listeners]) fn(session, { type: 'turn/end', data: { turn: n, reason: { kind: 'completed' } } })
      return Promise.resolve()
    },
  }
  const ctrl = {
    create: async () => { createCalls++; return { sessionId: session.id } },
    resolveAgent: async () => ({ agent }),
  }
  const ctx = {
    on(name, fn) { if (name !== 'session/event') return () => {}; listeners.add(fn); return () => listeners.delete(fn) },
    get(name) {
      if (name === 'sessionController') return ctrl
      if (name === 'workspaceRegistry') return { list: () => [{ id: 'ws-b2', path: 'ws-b2' }], create: async () => ({ id: 'ws-b2', path: 'ws-b2' }) }
      return null
    },
  }
  return { ctx, prompts, createCalls: () => createCalls }
}

function makeCore(dsh, onebotCalls) {
  const cfg = {
    enabled: true, dryRun: false, botQQ: '20002', ownerQQ: '10001', ownerName: '主人',
    allow: { private: ['10001'], groups: [GID] }, longTasks: false,
    merge: { waitSec: 0.02, maxSec: 0.1, groupWaitSec: 0.3, groupMaxSec: 0.8 },
    group: {
      interjectChance: 1, cooldownSec: 0, minRecentMessages: 1, activeWindowSec: 300,
      minRelevance: 0, interests: [], engagedMaxReplies: 3, engagedMaxMs: 600_000,
      burstMax: 100, burstWindowSec: 120, maxPerHour: 100, quietHours: [],
      fishGuard: { enabled: false },
    },
    security: { identityGuard: { enabled: false } },
    voice: { enabled: false, autoChance: 0 }, stickers: { enabled: false, faces: false, autoChance: 0 },
    reply: { groupMaxChars: 500, maxBubbles: 3 },
  }
  return createModularCore({
    dsh: dsh.ctx,
    onebot: { call: async (action, params) => { onebotCalls.push({ action, params }); return { message_id: 1 } } },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
    moduleHooks: { groupParticipate: (decision, info) => mods.claimResult('group/participate', decision, info) },
  })
}

let mid = 10000
const groupEv = (over = {}) => ({
  post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: Number(GID),
  self_id: 20002, user_id: 555, message_id: ++mid, time: Math.floor(Date.now() / 1000),
  sender: { user_id: 555, nickname: '甲' },
  message: [{ type: 'text', data: { text: '普通群消息' } }],
  ...over,
})
const atEv = (text = '你好呀') => groupEv({ message: [{ type: 'at', data: { qq: 20002 } }, { type: 'text', data: { text } }] })

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'b2-exec-'))
  process.env.AURABOT_DATA_DIR = dataDir
  const a = mkdtempSync(join(tmpdir(), 'b2-exec-mods-'))
  process.env.AURABOT_DATA_DIR = a
  const mk = () => ({
    ctx: { effect: () => () => {}, on: () => () => {}, webServer: { register: () => () => {} }, get: () => null, logger: noopLog },
    core: { hub: {}, onebot: {}, logger: noopLog },
  })
  const dep = mk()
  mods = createModules({ ...dep, getConfig: () => ({ modules: {} }), setConfig: () => {}, logger: noopLog, version: '1.0.0', builtins: [gpModule] })
  await mods.boot()
  process.env.AURABOT_DATA_DIR = dataDir
})

after(async () => {
  try { await core?.dispose() } catch {}
  mods?.dispose()
  delete process.env.AURABOT_DATA_DIR
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
})

test('REACT：零模型路径（session/assemble/runTurn/typing 全零），网关一次，回合正常落定', async () => {
  gpCalls.length = 0
  gpBehavior = (d, info) => ({ level: 'react', reaction: { messageId: String(info.msg.messageId), emojiId: '66' } })
  const dsh = mkDsh()
  const onebotCalls = []
  core = makeCore(dsh, onebotCalls)
  const ev = groupEv()
  const r = await core.dispatchLegacyEventSettled(ev)
  // 回合仍创建、进入 running、最终落定（waitForTurn 拿到成功 outcome）
  assert.equal(r.handled, 'offered')
  assert.ok(r.turnId)
  assert.equal(r.result.state, 'sent')
  assert.equal(r.result.via, 'group-reaction')
  assert.equal(r.result.deliveryId, `group-react:${r.turnId}`)
  assert.equal(dsh.createCalls(), 0, 'sessionForChat 零调用（REACT 不建会话）')
  assert.equal(dsh.prompts.length, 0, 'runTurn / 模型零调用')
  // 网关恰好一次：固定 set_msg_emoji_like
  const reactCalls = onebotCalls.filter((c) => c.action === 'set_msg_emoji_like')
  assert.equal(reactCalls.length, 1)
  assert.deepEqual(reactCalls[0].params, { message_id: String(ev.message_id), emoji_id: '66' })
  // 参与钩子恰好一次
  assert.equal(gpCalls.length, 1)
  // dispose 后零新增网关调用（REACT 不留定时器/异步尾巴）
  const beforeDispose = onebotCalls.length
  await core.dispose()
  await sleep(60)
  assert.equal(onebotCalls.length, beforeDispose)
  core = null
})

test('must / engaged 仍走模型路径（零 REACT 网关调用）', async () => {
  gpCalls.length = 0
  gpBehavior = (d, info) => ({ level: 'react', reaction: { messageId: String(info.msg.messageId), emojiId: '66' } })
  const dsh = mkDsh()
  const onebotCalls = []
  core = makeCore(dsh, onebotCalls)
  // 被 @ = must：参与钩子零调用，模型路径一次
  const r1 = await core.dispatchLegacyEventSettled(atEv('在吗'))
  assert.equal(r1.result.state, 'sent')
  assert.equal(r1.result.via, 'reply-delivery')
  assert.equal(gpCalls.length, 0, 'must 不问参与')
  assert.equal(dsh.prompts.length, 1)
  assert.equal(onebotCalls.filter((c) => c.action === 'set_msg_emoji_like').length, 0)
  // @ 回复后已入场（noteSpokeInGroup）→ 下一条普通消息走 engaged 续聊，仍是模型路径
  const r2 = await core.dispatchLegacyEventSettled(groupEv())
  assert.equal(r2.result.via, 'reply-delivery')
  assert.equal(gpCalls.length, 0, 'engaged 不问参与')
  assert.equal(dsh.prompts.length, 2, 'engaged 仍走模型')
  assert.equal(onebotCalls.filter((c) => c.action === 'set_msg_emoji_like').length, 0)
  await core.dispose()
  core = null
})

test('合流升级反例：interject 的 REACT 声明未决期间 must 先建回合 → REACT 零执行，模型恰好一次', async () => {
  gpCalls.length = 0
  let releaseReact = null
  gpBehavior = (d, info) => new Promise((resolve) => {
    releaseReact = () => resolve({ level: 'react', reaction: { messageId: String(info.msg.messageId), emojiId: '66' } })
  })
  const dsh = mkDsh()
  const onebotCalls = []
  core = makeCore(dsh, onebotCalls)
  // 消息 1：interject，参与声明未决（offer 尚未发生）
  const ev1 = groupEv()
  const p1 = core.dispatchLegacyEvent(ev1)
  assert.equal(onebotCalls.length, 0)
  // 消息 2：被 @（must），同步建回合 t1（进入 merging 窗口）
  const ev2 = atEv('来聊聊')
  const r2 = await core.dispatchLegacyEvent(ev2)
  assert.ok(r2.turnId)
  // 消息 1 的声明立刻 resolve → offer 在 merging 窗口内合流进同一回合
  releaseReact()
  const r1 = await p1
  assert.equal(r1.turnId, r2.turnId, '两条消息合流进同一回合')
  // 合流后参与被 must 压成 FULL：REACT 零执行，模型路径恰好一次（两条消息都在上下文里）
  const outcome = await core.controller.waitForTurn(r2.turnId)
  assert.equal(outcome.state, 'succeeded')
  assert.equal(outcome.value.via, 'reply-delivery', '走的是模型回复路径')
  assert.equal(dsh.prompts.length, 1, '模型恰好一次')
  assert.match(dsh.prompts[0], /普通群消息/, '消息 1（合入成员）在上下文里')
  assert.match(dsh.prompts[0], /来聊聊/, '消息 2（触发成员）在上下文里')
  assert.equal(onebotCalls.filter((c) => c.action === 'set_msg_emoji_like').length, 0, 'REACT 零执行')
  await core.dispose()
  core = null
})
