// 群参与契约 T1.4：group/participate 只在鱼群保护放行后的 interject 回合被问一次；
// 无监听器保持旧同步 offer 路径与形状；无效 truthy 声明回退 FULL 并告警；turnId 与参与绑定一致。
// 真实链路：createModules（真实 claimResult / api.on 注册）+ 真实 createGroupGate + 真实 createInboundRouter。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModules } from '../src/core/modules.js'
import { createGroupState } from '../src/chat/group-state.js'
import { createGroupGate } from '../src/host/core/group-gate.js'
import { createInboundRouter } from '../src/host/core/inbound-router.js'

const noop = () => {}
const mkLogger = (warnBox) => ({
  info: noop, error: noop, debug: noop,
  warn: (...args) => { if (warnBox) warnBox.push(args.map(String).join(' ')) },
  child: () => mkLogger(warnBox),
})

// ---------- 真实模块内核：group/participate 监听器按测试脚本切换行为 ----------
const gpCalls = []
let gpBehavior = null
const gpModule = {
  id: 'gp-mod', name: '参与测试模块', version: '1.0.0', api: 1,
  setup(api) {
    api.on('group/participate', (decision, info) => {
      gpCalls.push({ decision, info })
      return gpBehavior ? gpBehavior(decision, info) : undefined
    })
    return {}
  },
}

let dataDir
let modsBooted // 有监听器（真实 api.on 注册，claimResult 能带回真实模块 id）
let modsEmpty // 无监听器（不 boot、不 listen）
const warnBox = []

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gp-router-'))
  process.env.AURABOT_DATA_DIR = dataDir
  const mkDeps = () => ({
    ctx: { effect: () => () => {}, on: () => () => {}, webServer: { register: () => () => {} }, get: () => null, logger: mkLogger() },
    core: { hub: {}, onebot: {}, logger: mkLogger() },
  })
  const a = mkDeps()
  modsBooted = createModules({ ...a, getConfig: () => ({ modules: {} }), setConfig: noop, logger: mkLogger(), version: '1.0.0', builtins: [gpModule] })
  await modsBooted.boot()
  const b = mkDeps()
  modsEmpty = createModules({ ...b, getConfig: () => ({ modules: {} }), setConfig: noop, logger: mkLogger(), version: '1.0.0', builtins: [] })
})
after(() => {
  modsBooted?.dispose()
  delete process.env.AURABOT_DATA_DIR
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
})

// ---------- 路由装配（真实 gate + 真实群状态 + 真实模块中枢，controller/outbox 用替身） ----------
function mkRouter(mods, { withHook = true, fishGuard = { enabled: false }, warnBox: wb = warnBox } = {}) {
  const groups = createGroupState()
  const cfg = {
    enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', /* pii-scan:ignore 占位假号 */
    allow: { private: ['10000001'], groups: ['777'] }, /* pii-scan:ignore 占位假号 */
    group: {
      interjectChance: 1, cooldownSec: 0, minRecentMessages: 1, activeWindowSec: 300,
      minRelevance: 0, interests: [], engagedMaxReplies: 3, engagedMaxMs: 600_000,
      burstMax: 100, burstWindowSec: 120, maxPerHour: 100, quietHours: [],
      fishGuard,
    },
  }
  const turns = new Map()
  let seq = 0
  const offerCalls = []
  const mergeTargets = new Map() // messageId(字符串) → turnId：模拟真实 turn-controller 的 merging 窗口
  const controller = {
    offer(inbound) {
      const turnId = mergeTargets.get(String(inbound?.messageId || '')) || `t${++seq}`
      turns.set(turnId, { state: 'running' })
      offerCalls.push({ turnId, messageId: inbound?.messageId })
      return { turnId }
    },
    getTurn: (tid) => (turns.get(tid) ? { state: 'running' } : null),
    runningTurnOf: () => null,
    steer: async () => ({}),
  }
  const gate = createGroupGate({
    getConfig: () => cfg, log: mkLogger(wb), debug: noop,
    groups, memoryScore: () => 0, atmosphereGate: { enabled: false },
    getController: () => controller,
  })
  const router = createInboundRouter({
    getConfig: () => cfg, log: mkLogger(wb), debug: noop,
    gatedDebug: noop, mods,
    // 与 host.js sharedHooks.groupParticipate 同一表达式：真实 mods.claimResult('group/participate', ...)
    moduleHooks: withHook ? { groupParticipate: (decision, info) => mods.claimResult('group/participate', decision, info) } : {},
    runCommand: null,
    controller, outbox: { notePrivateSource: noop, clearPrivateSource: noop, request: async () => ({ state: 'sent' }) },
    groups, groupGate: gate,
    interaction: { rememberSpeaker: noop, rememberPoker: noop, claimPoke: () => true },
    presence: { noteIncoming: noop },
    stickerPicks: new WeakMap(), steeringChats: new Set(), backfillMeta: new WeakMap(),
    replyIdOf: () => null, quotedInfo: async () => null, quoteNote: () => '', rateAllowed: () => true,
    interceptInteraction: () => false, isMuted: () => false,
    noteMedia: noop, onStats: noop, logChat: noop, collectInboundStickers: () => 0,
  })
  return { router, gate, groups, offerCalls, mergeTargets }
}

let mid = 10000
const groupEv = (over = {}) => ({
  post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: 777,
  self_id: 20000002, user_id: 555, message_id: ++mid, time: Math.floor(Date.now() / 1000), /* pii-scan:ignore 占位假号 */
  sender: { user_id: 555, nickname: '甲' },
  message: [{ type: 'text', data: { text: '普通群消息' } }],
  ...over,
})
const atEv = () => groupEv({ message: [{ type: 'at', data: { qq: 20000002 } }, { type: 'text', data: { text: '你好呀' } }] }) /* pii-scan:ignore 占位假号 */

test('fishGuard 拦截（真实缓冲）：participation 钩子零调用、offer 零调用', async () => {
  gpCalls.length = 0
  gpBehavior = null
  const { router, gate, groups, offerCalls } = mkRouter(modsBooted, { fishGuard: { enabled: true, nameContains: ['肥鱼'], maxFish: 2, windowMs: 60_000 } })
  // 真实 group-state 缓冲里放两条不同鱼，普通消息到达时密度达标
  groups.appendMessage('777', { t: Date.now(), uid: '111', nick: '大肥鱼一号', text: '鱼话一', self: false })
  groups.appendMessage('777', { t: Date.now(), uid: '112', nick: '大肥鱼二号', text: '鱼话二', self: false })
  const r = await router.dispatchLegacyEvent(groupEv())
  assert.equal(r.handled, 'group-pass', '鱼群保护确实拦了本轮')
  assert.match(String(r.reason || ''), /不同的鱼/, `拦截原因可读（实际：${r.reason}）`)
  assert.equal(gpCalls.length, 0, '拦截时绝不能问参与钩子')
  assert.equal(offerCalls.length, 0, '拦截时不建回合')
})

test('must／engaged：participation 钩子零调用，回合照常建（参与按 T1.4 第 6 条记 FULL）', async () => {
  gpCalls.length = 0
  gpBehavior = null
  const { router, gate, groups, offerCalls } = mkRouter(modsBooted)
  const r1 = await router.dispatchLegacyEvent(atEv()) // 被 @ = must
  assert.equal(r1.handled, 'offered')
  assert.equal(gpCalls.length, 0, 'must 不问参与')
  assert.equal(offerCalls.length, 1)
  assert.equal(gate.turnModeOf(r1.turnId), 'must')
  assert.deepEqual(gate.turnParticipationOf(r1.turnId), { level: 'full', sourceModuleId: '' },
    'must 同步分支按 T1.4 第 6 条经 noteTurnParticipation 记 FULL（绝不残留 REACT/TEXT_LITE）')
  // engaged：先入场，再发普通消息
  groups.joinTopic('777', Date.now())
  const r2 = await router.dispatchLegacyEvent(groupEv())
  assert.equal(r2.handled, 'offered')
  assert.equal(gpCalls.length, 0, 'engaged 不问参与')
  assert.equal(offerCalls.length, 2)
  assert.equal(gate.turnModeOf(r2.turnId), 'engaged')
  assert.deepEqual(gate.turnParticipationOf(r2.turnId), { level: 'full', sourceModuleId: '' })
})

test('interject：钩子恰好一次，turnId 与 participation 绑定一致（真实模块 id 归因）', async () => {
  gpCalls.length = 0
  gpBehavior = (decision, info) => ({ level: 'react', reaction: { messageId: String(info.msg.messageId), emojiId: '66' } })
  const { router, gate, offerCalls } = mkRouter(modsBooted)
  const ev = groupEv()
  const r = await router.dispatchLegacyEvent(ev)
  assert.equal(r.handled, 'offered')
  assert.ok(r.turnId)
  assert.equal(gpCalls.length, 1, 'interject 恰好问一次')
  assert.equal(offerCalls.length, 1)
  assert.equal(offerCalls[0].turnId, r.turnId)
  assert.equal(gate.turnModeOf(r.turnId), 'interject')
  assert.deepEqual(
    gate.turnParticipationOf(r.turnId),
    { level: 'react', sourceModuleId: 'gp-mod', reaction: { messageId: String(ev.message_id), emojiId: '66' } },
    '锚点是本条消息，sourceModuleId 来自真实注册记录',
  )
})

test('interject：监听器返回 undefined（未接管）按 FULL 记账，仍恰好 offer 一次', async () => {
  gpCalls.length = 0
  gpBehavior = null
  const { router, gate, offerCalls } = mkRouter(modsBooted)
  const r = await router.dispatchLegacyEvent(groupEv())
  assert.equal(r.handled, 'offered')
  assert.ok(r.turnId)
  assert.equal(gpCalls.length, 1, '监听器在，被问过')
  assert.equal(offerCalls.length, 1)
  assert.deepEqual(gate.turnParticipationOf(r.turnId), { level: 'full', sourceModuleId: '' })
})

test('interject：TEXT_LITE 声明原样入账（limits 保留）', async () => {
  gpCalls.length = 0
  gpBehavior = () => ({ level: 'text_lite', limits: { maxBubbles: 1, maxChars: 80 } })
  const { router, gate, offerCalls } = mkRouter(modsBooted)
  const r = await router.dispatchLegacyEvent(groupEv())
  assert.equal(r.handled, 'offered')
  assert.equal(offerCalls.length, 1)
  assert.deepEqual(
    gate.turnParticipationOf(r.turnId),
    { level: 'text_lite', sourceModuleId: 'gp-mod', limits: { maxBubbles: 1, maxChars: 80 } },
  )
})

test('无效 truthy 声明：回退 FULL 并记录警告（声明仍占用本次 claim）', async () => {
  gpCalls.length = 0
  gpBehavior = () => ({ level: 'bogus', junk: 1 })
  const wb = []
  const { router, gate, offerCalls } = mkRouter(modsBooted, { warnBox: wb })
  const r = await router.dispatchLegacyEvent(groupEv())
  assert.equal(r.handled, 'offered')
  assert.equal(offerCalls.length, 1, '无效声明不阻断回合')
  assert.deepEqual(gate.turnParticipationOf(r.turnId), { level: 'full', sourceModuleId: '' }, '无效 truthy 回退 FULL')
  assert.ok(wb.some((w) => w.includes('参与声明无效')), `要记警告（实际：${JSON.stringify(wb)}）`)
})

test('跨消息锚点（messageId 不是当前消息）：无效，回退 FULL', async () => {
  gpCalls.length = 0
  gpBehavior = () => ({ level: 'react', reaction: { messageId: '99999999', emojiId: '66' } })
  const wb = []
  const { router, gate, offerCalls } = mkRouter(modsBooted, { warnBox: wb })
  const r = await router.dispatchLegacyEvent(groupEv())
  assert.equal(r.handled, 'offered')
  assert.equal(offerCalls.length, 1)
  assert.deepEqual(gate.turnParticipationOf(r.turnId), { level: 'full', sourceModuleId: '' })
  assert.ok(wb.some((w) => w.includes('参与声明无效')))
})

test('无监听器（钩子在但事件无监听）：保持旧同步 offer 路径，decision / offer 次数与形状不变', () => {
  gpCalls.length = 0
  const { router, gate, offerCalls } = mkRouter(modsEmpty)
  const { inbound, view } = router.safeAdapt(groupEv())
  const r = router.routeInbound(inbound, view, 'realtime')
  assert.equal(r instanceof Promise, false, 'claimResult 无监听器同步返回 null → 整条链保持同步形状')
  assert.deepEqual(r, { handled: 'offered', turnId: 't1' })
  assert.equal(offerCalls.length, 1)
  assert.equal(gate.turnModeOf('t1'), 'interject')
  assert.deepEqual(gate.turnParticipationOf('t1'), { level: 'full', sourceModuleId: '' },
    '同步分支经 noteTurnParticipation 记显式 FULL（T1.4 第 6 条；此前断言 null 是旧实现的记录缺失）')
  assert.equal(gpCalls.length, 0)
})

test('连钩子都没有（moduleHooks.groupParticipate 不存在）：同一条旧同步路径', () => {
  const { router, gate, offerCalls } = mkRouter(modsBooted, { withHook: false })
  const { inbound, view } = router.safeAdapt(groupEv())
  const r = router.routeInbound(inbound, view, 'realtime')
  assert.equal(r instanceof Promise, false)
  assert.deepEqual(r, { handled: 'offered', turnId: 't1' })
  assert.equal(offerCalls.length, 1)
  assert.deepEqual(gate.turnParticipationOf('t1'), { level: 'full', sourceModuleId: '' })
  assert.equal(gpCalls.length, 0, '无钩子时不该有模块被调用')
})

test('有监听器：进入 Promise 分支（返回 thenable），全部不接管后仍恰好 offer 一次', async () => {
  gpCalls.length = 0
  gpBehavior = null
  const { router, gate, offerCalls } = mkRouter(modsBooted)
  const { inbound, view } = router.safeAdapt(groupEv())
  const r = router.routeInbound(inbound, view, 'realtime')
  assert.equal(r instanceof Promise, true, '有监听器时允许进入 Promise 分支')
  const settled = await r
  assert.deepEqual(settled, { handled: 'offered', turnId: 't1' })
  assert.equal(gpCalls.length, 1)
  assert.equal(offerCalls.length, 1)
  assert.deepEqual(gate.turnParticipationOf('t1'), { level: 'full', sourceModuleId: '' })
})

test('两个监听器：第一个 truthy 后第二个零调用，sourceModuleId 是第一个监听者的真实注册 id', async () => {
  // 在已 boot 的 modsBooted 上再挂一个插件核心级监听器（@core）排在 gp-mod 之后
  const secondCalls = []
  const off = modsBooted.listen('group/participate', () => { secondCalls.push(1); return { level: 'full' } })
  try {
    gpCalls.length = 0
    gpBehavior = (d, info) => ({ level: 'react', reaction: { messageId: String(info.msg.messageId), emojiId: '66' } })
    const { router, gate } = mkRouter(modsBooted)
    const ev = groupEv()
    const r = await router.dispatchLegacyEvent(ev)
    assert.equal(r.handled, 'offered')
    assert.equal(gpCalls.length, 1, '第一个监听器（gp-mod）被问')
    assert.equal(secondCalls.length, 0, '首个 truthy 后第二个监听器零调用')
    assert.deepEqual(
      gate.turnParticipationOf(r.turnId),
      { level: 'react', sourceModuleId: 'gp-mod', reaction: { messageId: String(ev.message_id), emojiId: '66' } },
    )
  } finally { off() }
})

test('端到端合流 1：interject REACT 建 t1，后到的 @（must）合流进同一 t1 → 参与 FULL 无残留', async () => {
  gpCalls.length = 0
  gpBehavior = (d, info) => ({ level: 'react', reaction: { messageId: String(info.msg.messageId), emojiId: '66' } })
  const ev1 = groupEv()
  const { router, gate, offerCalls, mergeTargets } = mkRouter(modsBooted)
  const r1 = await router.dispatchLegacyEvent(ev1)
  assert.equal(r1.handled, 'offered')
  assert.equal(offerCalls[0].turnId, 't1')
  assert.equal(gate.turnModeOf('t1'), 'interject')
  assert.equal(gate.turnParticipationOf('t1').level, 'react', '前置：REACT 已入账')
  assert.equal(gpCalls.length, 1)

  // 消息 2 被 @（must），合流进同一个 t1（真实 turn-controller merging 窗口）
  const ev2 = atEv()
  mergeTargets.set(String(ev2.message_id), 't1')
  const r2 = await router.dispatchLegacyEvent(ev2)
  assert.equal(r2.handled, 'offered')
  assert.equal(r2.turnId, 't1', 'must 消息确实合流进 t1')
  assert.equal(offerCalls.filter((c) => c.turnId === 't1').length, 2, '两条消息共用 t1')
  assert.equal(gate.turnModeOf('t1'), 'must')
  assert.deepEqual(
    gate.turnParticipationOf('t1'),
    { level: 'full', sourceModuleId: '' },
    'must 成员合入后整回合恢复 FULL，无 reaction 残留',
  )
})

test('端到端合流 2：interject REACT 建 t1，engaged 消息合流进同一 t1 → 参与 FULL', async () => {
  gpCalls.length = 0
  gpBehavior = (d, info) => ({ level: 'react', reaction: { messageId: String(info.msg.messageId), emojiId: '66' } })
  const ev1 = groupEv()
  const { router, gate, groups, offerCalls, mergeTargets } = mkRouter(modsBooted)
  const r1 = await router.dispatchLegacyEvent(ev1)
  assert.equal(gate.turnParticipationOf('t1').level, 'react')

  // engaged 合流：先入场（engagedUntil 生效），再把第二条消息的 offer 指回 t1
  groups.joinTopic('777', Date.now())
  const ev2 = groupEv()
  mergeTargets.set(String(ev2.message_id), 't1')
  const r2 = await router.dispatchLegacyEvent(ev2)
  assert.equal(r2.handled, 'offered')
  assert.equal(r2.turnId, 't1', 'engaged 消息确实合流进 t1')
  assert.equal(offerCalls.filter((c) => c.turnId === 't1').length, 2, '两条消息共用 t1')
  assert.equal(gate.turnModeOf('t1'), 'engaged')
  assert.deepEqual(
    gate.turnParticipationOf('t1'),
    { level: 'full', sourceModuleId: '' },
    'engaged 成员合入后整回合恢复 FULL，无 reaction 残留',
  )
})

test('端到端异步竞态合流 3：interject 的参与声明未决期间 must 先建 t1，REACT 后到不得覆盖', async () => {
  gpCalls.length = 0
  let releaseReact = null
  gpBehavior = (d, info) => new Promise((resolve) => {
    releaseReact = () => resolve({ level: 'react', reaction: { messageId: String(info.msg.messageId), emojiId: '66' } })
  })
  const ev1 = groupEv()
  const { router, gate, offerCalls, mergeTargets } = mkRouter(modsBooted)
  const p1 = router.dispatchLegacyEvent(ev1) // 消息 1：钩子返回未决 Promise，offer 尚未发生
  assert.ok(p1 instanceof Promise)
  assert.equal(offerCalls.length, 0, '参与未决时不建回合')

  // 消息 2 被 @（must）同步 offer 建 t1
  const ev2 = atEv()
  const r2 = await router.dispatchLegacyEvent(ev2)
  assert.equal(r2.turnId, 't1')
  assert.equal(gate.turnModeOf('t1'), 'must')
  assert.deepEqual(gate.turnParticipationOf('t1'), { level: 'full', sourceModuleId: '' })

  // 消息 1 的声明 resolve 为 REACT，其 offer 合流进同一个 t1
  mergeTargets.set(String(ev1.message_id), 't1')
  releaseReact()
  const r1 = await p1
  assert.equal(r1.turnId, 't1', '消息 1 合流进 t1')
  assert.equal(gate.turnModeOf('t1'), 'must', 'must 不被后到的 interject 覆盖')
  assert.deepEqual(
    gate.turnParticipationOf('t1'),
    { level: 'full', sourceModuleId: '' },
    '后到的 REACT 绝不能覆盖已恢复的 FULL',
  )
  assert.equal('reaction' in gate.turnParticipationOf('t1'), false)
})

test('钩子内改写 decision.mode 不得污染宿主记录（decision 以浅拷贝交给钩子）', async () => {
  gpCalls.length = 0
  gpBehavior = (d, info) => {
    d.mode = 'must' // 恶意/意外改写：宿主必须不受影响
    return { level: 'react', reaction: { messageId: String(info.msg.messageId), emojiId: '66' } }
  }
  const { router, gate, offerCalls } = mkRouter(modsBooted)
  const r = await router.dispatchLegacyEvent(groupEv())
  assert.equal(r.handled, 'offered')
  assert.equal(offerCalls.length, 1)
  assert.equal(gate.turnModeOf(r.turnId), 'interject', '宿主记录的模式仍是 interject')
  assert.equal(gate.turnParticipationOf(r.turnId).level, 'react', '参与声明按 interject 语义原样入账')
})
