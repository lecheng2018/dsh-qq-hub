// PR-4 回归测试网：审批流/模块防刷屏与来源透传/turn-controller 状态修复/核心回合稳健性/私聊临时会话清理/台账裁剪与紧凑落盘

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModules } from '../src/core/modules.js'
import { createModuleSendBridge } from '../src/host/module-send-bridge.js'
import { createHubEgress } from '../src/host/hub-egress.js'
import { createTurnController } from '../src/chat/turn-controller.js'
import { createDshSessionAdapter } from '../src/chat/adapters/dsh-session.js'
import { createModularCore } from '../src/host/modular-core.js'
import { createOutbox } from '../src/chat/outbox.js'
import { createDeliveryLedger } from '../src/chat/delivery-ledger.js'

const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }

const makeInbound = (id, chatKey = 'private:10001', text = `消息-${id}`) => ({
  contractVersion: 1,
  eventId: id,
  messageId: id,
  chatKey,
  sender: { userId: '10001', nickname: '测试用户' },
  timestamp: Date.now(),
  source: 'realtime',
  segments: [{ type: 'text', data: { text } }],
})

// ---------------- 1. 模块来源透传 + onebot 拦截正则 + 防刷屏治理 ----------------

test('modules: api.sendText/sendImage/sendFile/sendVoiceFile/sendSegments 全部透传 sourceModuleId，onebot 拦截扩展动作', async () => {
  const hubCalls = []
  const rawCalls = []
  const directOnebot = []
  const core = {
    hub: {
      deliver: async (...a) => hubCalls.push(['deliver', ...a]),
      sendText: async (...a) => hubCalls.push(['sendText', ...a]),
      sendImage: async (...a) => hubCalls.push(['sendImage', ...a]),
      sendSegments: async (...a) => hubCalls.push(['sendSegments', ...a]),
      sendFile: async (...a) => hubCalls.push(['sendFile', ...a]),
      sendVoiceFile: async (...a) => hubCalls.push(['sendVoiceFile', ...a]),
      deliverRaw: async (req) => { rawCalls.push(req); return { ok: true } },
    },
    onebot: { call: async (action, params) => { directOnebot.push({ action, params }); return {} } },
  }
  let capturedApi = null
  const mods = createModules({
    ctx: { on: () => () => {} },
    core,
    getConfig: () => ({ ownerQQ: '10001', ext: {} }),
    setConfig: () => {},
    logger: noopLog,
    version: '1.0.0',
    builtins: [{
      id: 'rss-demo',
      name: 'RSS Demo',
      version: '1.0.0',
      setup(api) { capturedApi = api; return {} },
    }],
  })
  await mods.boot()
  assert.ok(capturedApi)

  await capturedApi.sendText('private:10001', '推送正文')
  await capturedApi.sendImage('private:10001', 'https://example.com/a.png')
  await capturedApi.sendFile('private:10001', '/tmp/a.txt', 'a.txt')
  await capturedApi.sendVoiceFile('private:10001', '/tmp/a.wav')
  await capturedApi.sendSegments('private:10001', [{ type: 'text', data: { text: '段' } }])

  assert.equal(hubCalls[0][0], 'sendText')
  assert.equal(hubCalls[0][3], 'rss-demo', 'sendText 必须透传模块 id 作为 sourceModuleId')
  assert.equal(hubCalls[1][5]?.sourceModuleId, 'rss-demo', 'sendImage 必须透传 sourceModuleId')
  assert.equal(hubCalls[2][4]?.sourceModuleId, 'rss-demo', 'sendFile 必须透传 sourceModuleId')
  assert.equal(hubCalls[3][4]?.sourceModuleId, 'rss-demo', 'sendVoiceFile 必须透传 sourceModuleId')
  assert.equal(hubCalls[4][4]?.sourceModuleId, 'rss-demo', 'sendSegments 必须透传 sourceModuleId')

  for (const action of [
    'group_poke',
    'friend_poke',
    'forward_friend_single_msg',
    'forward_group_single_msg',
    'set_msg_emoji_like',
  ]) {
    await capturedApi.onebot(action, { group_id: 777001, user_id: 10001, message_id: 123, emoji_id: 42 })
  }
  assert.deepEqual(rawCalls.map((c) => c.action), [
    'group_poke',
    'friend_poke',
    'forward_friend_single_msg',
    'forward_group_single_msg',
    'set_msg_emoji_like',
  ])
  assert.ok(rawCalls.every((c) => c.sourceModuleId === 'rss-demo'))

  // 非发信管理/查询动作仍然走直连
  await capturedApi.onebot('get_group_info', { group_id: 777001 })
  assert.equal(directOnebot.length, 1)
  assert.equal(directOnebot[0].action, 'get_group_info')

  // hub-egress 同样放行这五个动作并尊重 dryRun
  const gwCalls = []
  const outbox = createOutbox({
    send: async (action, params) => { gwCalls.push({ action, params }); return { raw: { ok: true } } },
    dryRun: () => false,
    enabled: () => true,
  })
  const egress = createHubEgress({ outbox, log: noopLog })
  for (const action of ['group_poke', 'friend_poke', 'forward_friend_single_msg', 'forward_group_single_msg', 'set_msg_emoji_like']) {
    const res = await egress.deliver({ action, params: { user_id: 10001 }, chatKey: 'private:10001', receipt: 'optional', sourceModuleId: 'rss-demo' })
    assert.deepEqual(res, { ok: true })
  }
  assert.equal(gwCalls.length, 5)
  outbox.dispose()
  mods.dispose()
})

test('module-send-bridge: per-(module,chat) pacing、60s 突发上限合并暂存、静默/道别静默保护，且对 core 与 reply 零影响', async () => {
  let fakeNow = new Date('2026-11-27T14:00:00Z').getTime()
  const sleeps = []
  const sent = []
  const warnings = []
  let muted = false
  let farewellMuted = false

  const bridge = createModuleSendBridge({
    hub: { captureOnly: null, isBusy: () => false },
    outbox: {
      request: async (req) => {
        sent.push({ at: fakeNow, ...req })
        return { gatewayMessageId: `m-${sent.length}`, state: 'sent' }
      },
    },
    log: { debug() {}, info() {}, warn: (m) => warnings.push(m) },
    isMuted: () => muted,
    isProactivelyMuted: () => farewellMuted,
    now: () => fakeNow,
    sleep: async (ms) => { sleeps.push(ms); fakeNow += ms },
    pushPolicy: { pacingMs: 1500, burstWindowMs: 60_000, burstLimit: 4 },
  })

  try {
    // 同模块连发 4 条：第 1 条立刻发，第 2~4 条按 1500ms 间隔 pacing
    for (let i = 1; i <= 4; i++) {
      const r = await bridge.sendText('private:10001', `提醒 ${i}`, 'rss')
      assert.equal(r.state, 'sent')
    }
    assert.deepEqual(sleeps, [1500, 1500, 1500], '第 2~4 条必须触发 1500ms pacing')
    assert.equal(sent.length, 4)

    // 第 5 条超突发上限（4 条/60s）：不直接刷屏，暂存待汇总并打日志
    const r5 = await bridge.sendText('private:10001', '提醒 5（超突发）', 'rss')
    assert.equal(r5.state, 'digested')
    assert.equal(r5.reason, 'burst-limit')
    assert.equal(sent.length, 4)
    assert.ok(warnings.some((w) => w.includes('突发上限')), '超突发必须记录日志')
    assert.equal(bridge.pendingDigests().length, 1)

    // core 与显式 reply 零影响：不 pacing、不限流
    const sleepCountBefore = sleeps.length
    const rCore = await bridge.sendText('private:10001', '核心通知', 'core')
    const rReply = await bridge.reply({ chatId: 'private:10001', kind: 'private' }, '命令回复', 'rss')
    assert.equal(rCore.state, 'sent')
    assert.equal(rReply.state, 'sent')
    assert.equal(sleeps.length, sleepCountBefore, 'core 与 reply 不应触发 pacing')

    // 道别静默保护：非紧急推送暂存待汇总
    farewellMuted = true
    const rFarewell = await bridge.sendText('private:10001', '晚安后的推送', 'bilibili')
    assert.equal(rFarewell.state, 'digested')
    assert.equal(rFarewell.reason, 'proactive-muted')
    // 静音解除后可合并补发
    farewellMuted = false
    const flushed = await bridge.flushDigest({ sourceModuleId: 'bilibili' })
    assert.equal(flushed.length, 1)
    assert.equal(flushed[0].state, 'sent')
    assert.match(sent.at(-1).segments[0].data.text, /晚安后的推送/)

    // 显式静音保护：同样暂存
    muted = true
    const rMuted = await bridge.sendText('private:10001', '静音期间推送', 'news')
    assert.equal(rMuted.state, 'digested')
    assert.equal(rMuted.reason, 'muted')
  } finally {
    bridge.dispose()
  }
})

// ---------------- 2. turn-controller.js 两个高危状态 Bug ----------------

test('turn-controller: registerSteer 补投精确绑定 resolve/reject，无 Promise 悬挂也无 unhandledRejection', async () => {
  let releaseTurn
  const turnGate = new Promise((r) => { releaseTurn = r })
  let registerNow
  const waitRegister = new Promise((r) => { registerNow = r })
  const received = []

  const ctl = createTurnController({
    merge: { waitMs: 10, maxMs: 30, groupWaitMs: 10, groupMaxMs: 30 },
    execute: async (turn, io) => {
      assert.equal(turn.kind, 'group', 'offer() 必须传 kind 给 createTurn')
      await waitRegister
      io.onSteer(async (inb) => {
        received.push(inb.eventId)
        if (inb.eventId === 'steer-fail') throw new Error('steer handler boom')
      })
      await turnGate
    },
  })

  try {
    const lead = ctl.offer(makeInbound('lead-1', 'group:888001', '开场'))
    // 等待回合进入 running（execute 停在 waitRegister，尚未调用 onSteer）
    for (let i = 0; i < 40 && !ctl.runningTurnOf('group:888001'); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(ctl.runningTurnOf('group:888001'), lead.turnId)

    // 在 registerSteer 之前发两条 steer：一条成功、一条抛错
    let okResolved = false
    const pOk = ctl.steer(lead.turnId, makeInbound('steer-ok', 'group:888001', '补一句')).then(() => { okResolved = true })
    const pFail = ctl.steer(lead.turnId, makeInbound('steer-fail', 'group:888001', '失败转向'))

    // 注册 handler：两条缓存的 steer 必须立刻结算（无需等整个回合结束！）
    registerNow()
    await pOk
    assert.equal(okResolved, true, '缓存 steer 补投成功后 Promise 必须立刻 resolve，不能悬挂到回合结束')
    await assert.rejects(() => pFail, /steer handler boom/, '缓存 steer 补投抛错必须精确 reject 到对应调用方')
    assert.deepEqual(received, ['steer-ok', 'steer-fail'])

    releaseTurn()
    const outcome = await ctl.waitForTurn(lead.turnId)
    assert.equal(outcome.state, 'succeeded')
  } finally {
    await ctl.dispose()
  }
})

test('turn-controller: scheduler.submit 因 queue full 拒绝时落终态 failed 并清理 live 与 members', async () => {
  let releaseFirst
  const firstGate = new Promise((r) => { releaseFirst = r })
  const ctl = createTurnController({
    merge: { waitMs: 5, maxMs: 15, groupWaitMs: 5, groupMaxMs: 15 },
    maxQueue: 1,
    execute: async (turn) => {
      if (turn.memberEventIds[0] === 'e1') await firstGate
    },
  })

  try {
    const t1 = ctl.offer(makeInbound('e1', 'group:888002'))
    for (let i = 0; i < 40 && !ctl.runningTurnOf('group:888002'); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    // 第 2 轮进入队列（占满 maxQueue=1）
    const t2 = ctl.offer(makeInbound('e2', 'group:888002'))
    await new Promise((r) => setTimeout(r, 40))
    // 第 3 轮触发 queue full
    const t3 = ctl.offer(makeInbound('e3', 'group:888002'))
    const o3 = await ctl.waitForTurn(t3.turnId)
    assert.equal(o3.state, 'failed', 'queue full 必须落终态 failed，不能永久停留在 pending')
    assert.match(String(o3.error?.message || ''), /queue full/)
    const snap3 = ctl.getTurn(t3.turnId)
    assert.equal(snap3.state, 'failed')
    assert.equal(snap3.members, undefined)

    releaseFirst()
    await ctl.waitForTurn(t1.turnId)
    await ctl.waitForTurn(t2.turnId)
  } finally {
    await ctl.dispose()
  }
})

// ---------------- 3. modular-core.js + dsh-session.js 稳健性 ----------------

test('dsh-session: onCreated 在 ctrl.create 返回后、renameSession（resolveAgent）之前调用', async () => {
  const order = []
  const dsh = {
    get(name) {
      if (name === 'sessionController') {
        return {
          create: async () => { order.push('create'); return { sessionId: 'sess-race-123456' } },
          resolveAgent: async () => { order.push('resolveAgent'); return { agent: { session: {} } } },
          rename: async () => { order.push('rename') },
        }
      }
      return null
    },
  }
  const adapter = createDshSessionAdapter({
    dsh,
    presetOf: () => ({ agentPreset: 'qq-hub-private' }),
    titleOf: () => '测试标题',
  })
  await adapter.createSession('private:10001', {
    onCreated: (sid) => order.push(`onCreated:${sid}`),
  })
  assert.deepEqual(order, ['create', 'onCreated:sess-race-123456', 'resolveAgent', 'rename'])
})

test('modular-core: 工具计数不混入 restrict disposer、chatKeyOfSession("session-") 不误匹配、sweepOrphanSessions 缺失 updatedAt 不误归档、io.signal 取消调 agent.cancel', async () => {
  const debugLogs = []
  const cancelCalls = []
  const listeners = new Set()
  const archivedIds = []
  const QQ_ROOT = '/tmp/pr4-test-qq'

  let holdTurnResolve
  const holdTurn = new Promise((r) => { holdTurnResolve = r })

  const agent = {
    id: 'session-abcdef123456',
    ctx: {
      tools: {
        restrict: () => () => {}, // 1 个 restrict disposer
        register: () => () => {}, // 每个工具 1 个 register disposer
      },
    },
    cancel: async (reason) => { cancelCalls.push(reason) },
    followup: async () => { await holdTurn },
  }
  const ctrl = {
    create: async () => ({ sessionId: 'session-abcdef123456' }),
    resolveAgent: async () => ({ agent }),
    list: async () => ({
      items: [
        { sessionId: 'sess-missing-updated', cwd: QQ_ROOT, running: false, blank: false }, // updatedAt 缺失
        { sessionId: 'sess-nan-updated', cwd: QQ_ROOT, updatedAt: 'not-a-date', running: false, blank: false },
        { sessionId: 'sess-zero-updated', cwd: QQ_ROOT, updatedAt: 0, running: false, blank: false },
        { sessionId: 'sess-real-orphan', cwd: QQ_ROOT, updatedAt: Date.now() - 24 * 3600_000, running: false, blank: false },
      ],
    }),
  }
  const workspaceRegistry = {
    list: () => [],
    get archivedSessionIds() { return archivedIds },
    get pinnedSessionIds() { return [] },
    archiveSession: async (id) => { archivedIds.push(id) },
  }
  const dsh = {
    on(event, fn) {
      if (event !== 'session/event') return () => {}
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    get(name) {
      if (name === 'sessionController') return ctrl
      if (name === 'workspaceRegistry') return workspaceRegistry
      return null
    },
  }

  const core = createModularCore({
    dsh,
    onebot: { call: async () => ({ message_id: '1' }) },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => ({
      enabled: true, dryRun: false, botQQ: '20002', ownerQQ: '10001', ownerName: '主人',
      allow: { private: ['10001'], groups: [] },
      workspaceDir: QQ_ROOT,
      merge: { waitSec: 0.01, maxSec: 0.05 },
      orphanSweep: { enabled: true, idleHours: 6, intervalHours: 6, maxPerPass: 20 },
    }),
    buildTools: () => [
      { name: 'tool_a', execute: async () => 'a' },
      { name: 'tool_b', execute: async () => 'b' },
      { name: 'tool_c', execute: async () => 'c' },
    ],
    logger: noopLog,
    log: {
      info() {}, warn() {}, error() {},
      debug: (m) => debugLogs.push(String(m)),
      child: () => noopLog,
    },
  })

  try {
    // 1) sweepOrphanSessions：缺失/NaN/0 updatedAt 必须跳过，绝不绕过闲置保护
    const sweep = await core.sweepOrphanSessions()
    assert.deepEqual(archivedIds, ['sess-real-orphan'], '只有合法且超期的孤儿会话才可归档')
    assert.equal(sweep.archived, 1)
    assert.equal(sweep.skipped, 3)

    // 2) 发起一轮消息：验证工具计数准确 + chatKeyOfSession('session-') 不误匹配 + io.signal 取消
    const routed = await core.dispatchLegacyEvent({
      post_type: 'message', message_type: 'private', sub_type: 'friend',
      self_id: 20002, user_id: 10001, message_id: 901, time: Math.floor(Date.now() / 1000),
      sender: { user_id: 10001, nickname: '主人' },
      message: [{ type: 'text', data: { text: '你好' } }],
    })
    assert.equal(routed.handled, 'offered')

    // 等待进入 running 且工具已挂载
    for (let i = 0; i < 60 && !debugLogs.some((l) => l.includes('模块工具')); i++) {
      await new Promise((r) => setTimeout(r, 15))
    }
    const toolLog = debugLogs.find((l) => l.includes('模块工具'))
    assert.ok(toolLog, '应打出工具挂载日志')
    assert.match(toolLog, /新挂 3、已存在 0、失败 0（清单 3 个）/, `tools.restrict disposer 不应计入新挂数：${toolLog}`)

    // chatKeyOfSession 边界校验
    assert.equal(core.chatKeyOfSession('session-'), '', '空 bare 不得恒命中首条会话')
    assert.equal(core.chatKeyOfSession('session-123'), '', '过短 bare 不得模糊命中')
    assert.equal(core.chatKeyOfSession('abcdef123456'), 'private:10001', '去前缀完整 id 应精确命中')
    assert.equal(core.chatKeyOfSession('xxabcdef123456'), '', '非完整匹配（仅后缀相同）不得误命中')

    // 取消正在等待的回合：应立即结束并调 agent.cancel({ kind: 'user' })，不泄漏监听器
    const cancelRes = core.controller.cancel(routed.turnId)
    assert.equal(cancelRes.honest, 'cancel-requested')
    const outcome = await core.controller.waitForTurn(routed.turnId)
    assert.equal(outcome.state, 'cancelled', 'io.signal abort 后回合必须立即落 cancelled')
    assert.deepEqual(cancelCalls, [{ kind: 'user' }], '取消时必须调用 agent.cancel({ kind: "user" })')
    assert.equal(listeners.size, 0, '取消后 session/event 监听器必须全部摘除')

    // resetChat 清理标记并给即将归档的 sid 短时免误报
    assert.equal(core.resetChat('private:10001'), true)
    assert.equal(core.isArchivingSession('session-abcdef123456'), true)
  } finally {
    holdTurnResolve?.()
    await core.dispose()
  }
})

// ---------------- 4. outbox.js privateSources 清理 + LRU 上限 ----------------

test('outbox: clearPrivateSource 清除旧临时会话来源群，且 privateSources 遵守 LRU 上限', async () => {
  const calls = []
  const outbox = createOutbox({
    send: async (action, params) => { calls.push({ action, params }); return { messageId: `m-${calls.length}` } },
    dryRun: () => false,
    enabled: () => true,
    maxPrivateSources: 3,
  })
  try {
    outbox.notePrivateSource('10001', '7001')
    outbox.notePrivateSource('10002', '7002')
    outbox.notePrivateSource('10003', '7003')
    // 命中 10001 刷新其 LRU 位置，随后插入 10004 应淘汰最旧的 10002
    await outbox.request({ chatKey: 'private:10001', segments: [{ type: 'text', data: { text: 'a' } }] })
    assert.equal(calls.at(-1).params.group_id, 7001)

    outbox.notePrivateSource('10004', '7004')
    await outbox.request({ chatKey: 'private:10002', segments: [{ type: 'text', data: { text: 'b' } }] })
    assert.equal(calls.at(-1).params.group_id, undefined, '超过 LRU 上限时最久未用的 10002 应被淘汰')
    await outbox.request({ chatKey: 'private:10001', segments: [{ type: 'text', data: { text: 'c' } }] })
    assert.equal(calls.at(-1).params.group_id, 7001, '刚命中的 10001 应保留在 LRU 中')

    // 普通好友私聊到达时清除旧临时会话来源群
    outbox.clearPrivateSource('10001')
    await outbox.request({ chatKey: 'private:10001', segments: [{ type: 'text', data: { text: 'd' } }] })
    assert.equal(calls.at(-1).params.group_id, undefined, 'clearPrivateSource 后不再携带旧 group_id')
  } finally {
    outbox.dispose()
  }
})

// ---------------- 5. delivery-ledger.js 紧凑 JSON + failed/unknown 超期与硬上限裁剪 ----------------

test('delivery-ledger: 落盘使用紧凑 JSON，且对超期（>14天）及超硬上限的 failed/unknown 兜底裁剪', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr4-ledger-'))
  const file = join(dir, 'deliveries.json')
  try {
    const now = Date.now()
    const expired = now - 15 * 86400_000
    const recent = now - 2 * 86400_000
    writeFileSync(file, JSON.stringify({
      version: 1,
      deliveries: [
        { deliveryId: 'expired-failed', chatKey: 'private:10001', state: 'failed', createdAt: expired, segments: [] },
        { deliveryId: 'expired-unknown', chatKey: 'private:10001', state: 'unknown', createdAt: expired, unknownAt: expired, segments: [] },
        { deliveryId: 'recent-failed-1', chatKey: 'private:10001', state: 'failed', createdAt: recent, segments: [] },
        { deliveryId: 'recent-unknown-1', chatKey: 'private:10001', state: 'unknown', createdAt: recent, unknownAt: recent, segments: [] },
      ],
    }))

    const book = createDeliveryLedger({ file, maxRecords: 2, hardMaxRecords: 4 })
    // 启动加载时即应裁掉 >14 天的 failed/unknown
    assert.equal(book.get('expired-failed'), null, '超过 14 天的 failed 应被裁剪')
    assert.equal(book.get('expired-unknown'), null, '超过 14 天的 unknown 应被裁剪')
    assert.ok(book.get('recent-failed-1'), '14 天内的 failed 保留')
    assert.ok(book.get('recent-unknown-1'), '14 天内的 unknown 保留')

    // 继续写入多条 failed，验证触发 hardMaxRecords=4 硬上限时按最老淘汰 failed/unknown
    for (let i = 1; i <= 4; i++) {
      const id = `new-fail-${i}`
      book.enqueue({ deliveryId: id, chatKey: 'private:10001', segments: [{ type: 'text', data: { text: id } }] })
      book.mark(id, 'failed', { reason: 'err' })
    }
    assert.ok(book.stats().total <= 4, `总记录数不得超过 hardMaxRecords=4（实际 ${book.stats().total}）`)
    assert.equal(book.get('recent-failed-1'), null, '超硬上限时最老的 failed 应被淘汰')

    // 验证落盘为紧凑 JSON（无多行缩进）
    const raw = readFileSync(file, 'utf8')
    assert.equal(raw.includes('\n'), false, '台账落盘应为紧凑 JSON，避免大文件缩进阻塞同步 I/O')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
