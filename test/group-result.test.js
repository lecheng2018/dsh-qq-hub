// T2.5 真实链路测试：execute 作用域的 group/result —— 事件形状、每回合最多一次、
// 结构化早退映射（blocked/silent/skipped 绝不记 sent）、sent/partial/failed 与投递层一致、
// cancelled/unknown 映射、REACT deliveryId、监听者抛错隔离且 groupGate 必释放、重启不重放。
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

// ---------- 可切换行为 ----------
let gpBehavior = null        // group/participate 返回值
let replyBehavior = null     // api.on('reply') 返回值（null = 拦下）
let promptThrow = null       // prompt 钩子抛错注入
let modelReply = '嗯'        // 模型回复文本
let modelReject = null       // 模型轮次拒绝注入
let modelHang = false        // 模型轮次挂起（真实取消路径用）
const gpModule = {
  id: 'gp-mod', name: '参与测试', version: '1.0.0', api: 1,
  setup(api) {
    api.on('group/participate', (decision, info) => (gpBehavior ? gpBehavior(decision, info) : undefined))
    api.on('reply', (text, info) => (replyBehavior !== undefined ? replyBehavior(text, info) : undefined))
    return {}
  },
}
const recorderModule = {
  id: 'gp-result-recorder', name: '终态记录', version: '1.0.0', api: 1,
  setup(api) {
    api.on('group/result', (r) => { eventsFromModules.push(r) })
    return {}
  },
}
const throwerModule = {
  id: 'gp-result-thrower', name: '终态炸弹', version: '1.0.0', api: 1,
  setup(api) {
    api.on('group/result', () => { if (throwerArmed) throw new Error('监听者炸了') })
    return {}
  },
}
let throwerArmed = false
const events = []            // moduleHooks.groupResult 直收（host.js sharedHooks 同款表达式里转发的对象）
const eventsFromModules = [] // 经真实 mods.emit 到达模块监听器的事件

let dataDir
let mods

function mkDsh() {
  const listeners = new Set()
  const session = { id: 'sess-gr' }
  const contextsMap = new Map()
  const prompts = []
  let turnNo = 0
  const agent = {
    id: session.id,
    ctx: { get: (name) => (name === 'contexts' ? { set: (k, v) => contextsMap.set(k, v), get: (k) => contextsMap.get(k), values: () => contextsMap.values() } : null) },
    followup(msg) {
      const n = ++turnNo
      prompts.push((msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'))
      if (modelReject) return Promise.reject(modelReject())
      if (modelHang) return new Promise(() => {}) // 挂起：等待 io.signal abort（真实取消路径）
      for (const fn of [...listeners]) fn(session, { type: 'assistant/message', data: { turn: n, message: { content: [{ type: 'text', text: modelReply }] } } })
      for (const fn of [...listeners]) fn(session, { type: 'turn/end', data: { turn: n, reason: { kind: 'completed' } } })
      return Promise.resolve()
    },
  }
  const ctrl = {
    create: async () => ({ sessionId: session.id }),
    resolveAgent: async () => ({ agent }),
  }
  const ctx = {
    on(name, fn) { if (name !== 'session/event') return () => {}; listeners.add(fn); return () => listeners.delete(fn) },
    get(name) {
      if (name === 'sessionController') return ctrl
      if (name === 'workspaceRegistry') return { list: () => [{ id: 'ws-gr', path: 'ws-gr' }], create: async () => ({ id: 'ws-gr', path: 'ws-gr' }) }
      return null
    },
  }
  return { ctx, prompts }
}

function makeCore(dsh, onebotImpl, cfgOver = {}) {
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
    ...cfgOver,
  }
  let callNo = 0
  return createModularCore({
    dsh: dsh.ctx,
    onebot: { call: async (action, params) => { callNo++; return onebotImpl({ action, params, callNo }) } },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
    moduleHooks: {
      groupParticipate: (decision, info) => mods.claimResult('group/participate', decision, info),
      reply: (text, info) => mods.filter('reply', text, info),
      prompt: (content, info) => {
        if (promptThrow) throw promptThrow()
        return mods.filter('prompt', content, info)
      },
      // host.js sharedHooks.groupResult 同款表达式：真实 mods.emit('group/result', result)
      groupResult: (result) => { events.push(result); mods.emit('group/result', result) },
    },
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
const atEv = () => groupEv({ message: [{ type: 'at', data: { qq: 20002 } }, { type: 'text', data: { text: '你好呀' } }] })
const privateEv = () => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20002,
  user_id: 10001, message_id: ++mid, time: Math.floor(Date.now() / 1000),
  sender: { user_id: 10001, nickname: '主人' },
  message: [{ type: 'text', data: { text: '私聊消息' } }],
})

const clearAll = () => {
  events.length = 0
  eventsFromModules.length = 0
  gpBehavior = null
  replyBehavior = undefined
  promptThrow = null
  modelReply = '嗯'
  modelReject = null
  modelHang = false
  throwerArmed = false
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'b2-result-'))
  process.env.AURABOT_DATA_DIR = dataDir
  const mk = () => ({
    ctx: { effect: () => () => {}, on: () => () => {}, webServer: { register: () => () => {} }, get: () => null, logger: noopLog },
    core: { hub: {}, onebot: {}, logger: noopLog },
  })
  const dep = mk()
  mods = createModules({ ...dep, getConfig: () => ({ modules: {} }), setConfig: () => {}, logger: noopLog, version: '1.0.0', builtins: [gpModule, recorderModule, throwerModule] })
  await mods.boot()
})

after(() => {
  mods?.dispose()
  delete process.env.AURABOT_DATA_DIR
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
})

test('REACT 事件：形状完整、deliveryId 真实、sourceModuleId 归因、每回合恰好一次、经 mods.emit 到达模块', async () => {
  clearAll()
  gpBehavior = (d, info) => ({ level: 'react', reaction: { messageId: String(info.msg.messageId), emojiId: '66' } })
  const dsh = mkDsh()
  const core = makeCore(dsh, () => ({}))
  const ev = groupEv()
  const r = await core.dispatchLegacyEventSettled(ev)
  assert.equal(r.result.state, 'sent')
  assert.equal(events.length, 1, '恰好一个 group/result')
  const e = events[0]
  assert.deepEqual(
    Object.keys(e).sort(),
    ['at', 'chatId', 'deliveryId', 'participation', 'reason', 'sourceModuleId', 'state', 'topicMode', 'triggerMessageIds', 'turnId'],
  )
  assert.equal(e.turnId, r.turnId)
  assert.equal(e.chatId, `group:${GID}`)
  assert.equal(e.topicMode, 'interject')
  assert.equal(e.participation, 'react')
  assert.deepEqual([...e.triggerMessageIds], [String(ev.message_id)])
  assert.equal(e.state, 'sent', 'Outbox 真实终态')
  assert.equal(e.sourceModuleId, 'gp-mod', '真实接管模块归因')
  assert.equal(e.deliveryId, `group-react:${r.turnId}`, 'REACT 填真实 deliveryId')
  assert.equal(e.reason, '')
  assert.ok(Number.isFinite(e.at))
  assert.equal(eventsFromModules.length, 1, '经真实 mods.emit 到达模块监听器')
  assert.equal(eventsFromModules[0], e)
  await core.dispose()
})

test('sent / 文本路径：deliveryId 空串（多气泡不伪造单一 id）、participation full、私聊不发事件', async () => {
  clearAll()
  const dsh = mkDsh()
  const core = makeCore(dsh, () => ({ message_id: 1 }))
  const ev = atEv()
  await core.dispatchLegacyEventSettled(ev)
  assert.equal(events.length, 1)
  const e = events[0]
  assert.equal(e.state, 'sent')
  assert.equal(e.topicMode, 'must')
  assert.equal(e.participation, 'full')
  assert.equal(e.deliveryId, '', '文本路径不伪造 deliveryId')
  assert.equal(e.reason, '')
  assert.equal(e.sourceModuleId, '')
  // 私聊回合不发 group/result
  const n = events.length
  await core.dispatchLegacyEventSettled(privateEv())
  assert.equal(events.length, n, '私聊回合零事件')
  await core.dispose()
})

test('结构化早退：blocked / silent / skipped 绝不记成 sent', async () => {
  clearAll()
  const dsh = mkDsh()
  const core = makeCore(dsh, () => ({ message_id: 1 }))
  // blocked：reply 钩子模块返回 null
  replyBehavior = () => null
  await core.dispatchLegacyEventSettled(atEv())
  assert.equal(events[0].state, 'skipped')
  assert.equal(events[0].reason, 'reply-blocked')
  replyBehavior = undefined
  // silent：模型回 [沉默]
  modelReply = '[沉默]'
  await core.dispatchLegacyEventSettled(atEv())
  assert.equal(events[1].state, 'skipped')
  assert.equal(events[1].reason, 'model-silent')
  // skipped：试运行下 Outbox 把全部发送判 cancelled → 有条目但零送达 = delivery-skipped
  modelReply = '嗯'
  const dsh2 = mkDsh()
  const core2 = makeCore(dsh2, () => ({ message_id: 1 }), { dryRun: true })
  await core2.dispatchLegacyEventSettled(atEv())
  assert.equal(events[2].state, 'skipped')
  assert.equal(events[2].reason, 'delivery-skipped')
  for (const e of events) assert.notEqual(e.state, 'sent', '早退绝不记 sent')
  await core.dispose()
  await core2.dispose()
})

test('partial / failed 与投递层真实终态一致（多气泡逐条回执）', async () => {
  clearAll()
  { // partial：两条气泡，第二条没拿到回执（按 send_group_msg 计数：首条回执、次条不回）
    modelReply = '一|||二'
    const dsh = mkDsh()
    let sends = 0
    const core = makeCore(dsh, ({ action }) => {
      if (action === 'send_group_msg') { sends += 1; return sends === 1 ? { message_id: 1 } : {} }
      return { message_id: 1 }
    })
    await core.dispatchLegacyEventSettled(atEv())
    assert.equal(events.length, 1)
    assert.equal(events[0].state, 'partial', `两条气泡拿到一条回执 = partial`)
    await core.dispose()
  }
  clearAll()
  { // failed：全部没拿到回执
    modelReply = '一|||二'
    const dsh = mkDsh()
    const core = makeCore(dsh, ({ action }) => (action === 'send_group_msg' ? {} : { message_id: 1 }))
    await core.dispatchLegacyEventSettled(atEv())
    assert.equal(events.length, 1)
    assert.equal(events[0].state, 'failed')
    await core.dispose()
  }
})

test('cancelled / unknown 映射；监听者抛错不影响 turn outcome 且 groupGate 必释放', async () => {
  clearAll()
  // cancelled：执行中经 io.signal 真实取消（controller.cancel → runTurn 以 AbortError 落定）
  const dsh = mkDsh()
  const core = makeCore(dsh, () => ({ message_id: 1 }))
  modelHang = true
  const r = await core.dispatchLegacyEvent(atEv())
  assert.ok(r.turnId)
  await sleep(350) // 越过合流窗口：回合已进入 running、followup 挂起
  core.controller.cancel(r.turnId)
  const outcome = await core.controller.waitForTurn(r.turnId)
  assert.equal(outcome.state, 'cancelled', '回合如实落 cancelled')
  assert.equal(events.length, 1, '取消也发一次 group/result（已进入 execute）')
  assert.equal(events[0].state, 'cancelled')
  assert.equal(events[0].reason, 'turn-cancelled')
  modelHang = false
  await core.dispose()

  // thrower + groupGate 释放可观察性：dryRun 下 REACT 零预算，
  // 若 releaseTurnMode 没跑，第二条 interject 会被在途冷却拦下（事件少一条）。
  clearAll()
  gpBehavior = (d, info) => ({ level: 'react', reaction: { messageId: String(info.msg.messageId), emojiId: '66' } })
  throwerArmed = true
  const dsh2 = mkDsh()
  const core2 = makeCore(dsh2, () => ({}), {
    dryRun: true,
    group: {
      interjectChance: 1, cooldownSec: 30, minRecentMessages: 1, activeWindowSec: 300,
      minRelevance: 0, interests: [], engagedMaxReplies: 3, engagedMaxMs: 600_000,
      burstMax: 100, burstWindowSec: 120, maxPerHour: 100, quietHours: [],
      fishGuard: { enabled: false },
    },
  })
  const r1 = await core2.dispatchLegacyEventSettled(groupEv())
  assert.equal(r1.result.state, 'cancelled', 'dryRun → Outbox cancelled')
  assert.equal(events.length, 1)
  assert.equal(events[0].state, 'cancelled')
  assert.equal(events[0].reason, 'dryRun', 'Outbox 真实 reason 透传')
  const r2 = await core2.dispatchLegacyEventSettled(groupEv())
  assert.equal(r2.result.state, 'cancelled')
  assert.equal(events.length, 2, '第二条 interject 没被在途冷却拦下 → groupGate 已释放')
  assert.equal(eventsFromModules.length, 2, '抛错监听器不影响其他监听器收到事件')
  await core2.dispose()
  throwerArmed = false

  // unknown：prompt 钩子抛 unknown 错误
  clearAll()
  const dsh3 = mkDsh()
  const core3 = makeCore(dsh3, () => ({ message_id: 1 }))
  promptThrow = () => Object.assign(new Error('网关副作用未知'), { unknown: true })
  await assert.rejects(() => core3.dispatchLegacyEventSettled(atEv()))
  assert.equal(events[0].state, 'unknown')
  assert.equal(events[0].reason, 'turn-unknown')
  promptThrow = null
  // failed：prompt 钩子普通异常
  promptThrow = () => new Error('装配炸了')
  await assert.rejects(() => core3.dispatchLegacyEventSettled(atEv()))
  assert.equal(events[1].state, 'failed')
  assert.equal(events[1].reason, 'turn-failed')
  // reason 是稳定短代码：不含异常消息正文
  for (const e of events) assert.doesNotMatch(e.reason, /装配炸了|网关副作用未知/)
  promptThrow = null
  await core3.dispose()
})

test('重启不重放：dispose 后新实例只发新事件，历史事件不复现', async () => {
  clearAll()
  const dsh = mkDsh()
  const core = makeCore(dsh, () => ({ message_id: 1 }))
  await core.dispatchLegacyEventSettled(atEv())
  const firstEvent = events[0]
  assert.equal(events.length, 1)
  await core.dispose()

  // 新实例只为自己执行的回合发事件；旧事件对象不会被再次投递（group/result 不落盘）
  const dsh2 = mkDsh()
  const core2 = makeCore(dsh2, () => ({ message_id: 1 }))
  await core2.dispatchLegacyEventSettled(atEv())
  assert.equal(events.length, 2, '只追加新回合的事件（不重放历史）')
  assert.equal(events[events.length - 1], events[1])
  assert.notEqual(events[1], firstEvent, '旧事件对象不会再次投递')
  await sleep(120)
  assert.equal(events.length, 2, '静置后也没有任何重放')
  await core2.dispose()
})
