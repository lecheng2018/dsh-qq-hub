// Batch 3 · T3.2：私聊 steer 异步水合与微任务双竞态回归（防幽灵回合与静默丢追问）
//
// 改前三个缺陷：
//   1. turn-controller 用 `Promise.resolve().then(() => steerHandler(inbound))` 把转向推迟到下一微任务，
//      于是 `activeSteers++` 晚于「本轮收尾判定」——turn/end 恰好落在两者之间时，收尾先跑（activeSteers 仍 0），
//      steer 再进来就成了幽灵回合；
//   2. 执行器不向调用方暴露「本轮是否已结束」，调用方也无从复查；
//   3. modular-core 在异步水合/看图结束后**无条件** `agent.steer(...)`，旧回合已 idle 时孤儿 steer 被静默吞掉。
// 这里用真实模块（turn-controller / dsh-turn-runner / modular-core）+ 注入的假 agent/dsh 复现并断言行为。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createTurnController } from '../src/chat/turn-controller.js'
import { createTurnRunner } from '../src/chat/dsh-turn-runner.js'
import { createModularCore } from '../src/host/modular-core.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }

const inbound = (id, chatKey = 'private:10001', text = `消息-${id}`) => ({
  contractVersion: 1,
  eventId: id,
  messageId: id,
  chatKey,
  sender: { userId: '10001', nickname: '测试用户' },
  timestamp: Date.now(),
  source: 'realtime',
  segments: [{ type: 'text', data: { text } }],
})

const privateEvent = (messageId, text) => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: 20002, user_id: 10001, message_id: messageId, time: Math.floor(Date.now() / 1000),
  sender: { user_id: 10001, nickname: '测试用户' },
  message: [{ type: 'text', data: { text } }],
})

test('T3.2 turn-controller：steer 必须同步进入 steerHandler（不许推迟到微任务）', async () => {
  let entered = 0
  let liveTurnId = null
  const controller = createTurnController({
    merge: { waitMs: 1, maxMs: 5 },
    execute: async (turn, io) => {
      liveTurnId = turn.turnId
      io.onSteer(() => { entered += 1; return new Promise(() => {}) })
      await new Promise(() => {}) // 本回合永不自行结束
    },
  })
  try {
    const offered = controller.offer(inbound('e1'))
    for (let i = 0; i < 200 && entered === 0 && !controller.runningTurnOf('private:10001'); i++) await sleep(5)
    const running = controller.runningTurnOf('private:10001')
    assert.ok(running, '回合应进入 running 态')
    assert.equal(running, liveTurnId)
    // 同步调用（不 await）：entered 必须在 steer() 返回前就 +1
    controller.steer(running, inbound('e2'))
    assert.equal(entered, 1, 'steerHandler 同步进入 —— activeSteers++ 才来得及挡收尾')
    assert.ok(offered.turnId)
  } finally {
    controller.dispose()
  }
})

test('T3.2 dsh-turn-runner：turn/end 落定后 turnState.canSteer() 立刻为 false', async () => {
  const listeners = new Set()
  const dsh = {
    on(event, fn) {
      if (event !== 'session/event') return () => {}
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    get() { return null },
  }
  const runner = createTurnRunner({
    dsh, ctxGet: () => null, getConfig: () => ({}), log: noopLog, debug: () => {},
    classifyFailureKind: () => ({ oversized: false, archived: false }),
  })
  const agent = { followup: async () => '已跟进', status: 'running' }
  const turnState = { canSteer: () => true, isTurnEnded: () => false }
  const done = runner.runTurn({
    sessionId: 'session-b3-steer', message: { id: 'm1', role: 'user', content: [] },
    collect: { mode: 'chat' }, agent, turnState,
  })
  for (let i = 0; i < 100 && listeners.size === 0; i++) await sleep(5)
  assert.ok(listeners.size > 0, '执行器应挂上 session/event 监听')
  assert.equal(turnState.canSteer(), true, '回合未结束时可以 steer')
  await sleep(20) // 让 followup 先兑现（chat 模式收尾要求 followupDone）
  for (const fn of [...listeners]) fn({ id: 'session-b3-steer' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(turnState.canSteer(), false, '收到 turn/end 后必须拒绝 steer')
  assert.equal(turnState.isTurnEnded(), true)
  const result = await done
  assert.equal(result.completion.completed, true)
})

test('T3.2 modular-core：水合期间旧回合结束 → 不调 agent.steer，追问改为下一轮完整处理', async () => {
  const listeners = new Set()
  const steerCalls = []
  const followupCalls = []
  let steerHookReached = false
  const agent = {
    id: 'session-abcdef123456',
    status: 'running',
    ctx: { tools: { restrict: () => () => {}, register: () => () => {} } },
    followup: async () => {
      followupCalls.push(Date.now())
      // 第一轮 followup 立即兑现（真实 DSH 就是先兑现再发 turn/end），
      // 之后挂在原地，保证「追问回退出来的第二轮」仍在 running 态可观测。
      if (followupCalls.length === 1) return
      await new Promise(() => {})
    },
    steer: async (payload) => { steerCalls.push(payload) },
    cancel: async () => {},
  }
  const ctrl = {
    create: async () => ({ sessionId: 'session-abcdef123456' }),
    resolveAgent: async () => ({ agent }),
    list: async () => ({ items: [] }),
  }
  const dsh = {
    on(event, fn) {
      if (event !== 'session/event') return () => {}
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    get(name) { return name === 'sessionController' ? ctrl : null },
  }
  const core = createModularCore({
    dsh,
    onebot: { call: async () => ({ message_id: '1' }) },
    mods: {
      contextFor: async () => '',
      commands: () => [],
      use: () => null,
    },
    getConfig: () => ({
      enabled: true, dryRun: true, botQQ: '20002', ownerQQ: '10001', ownerName: '主人',
      allow: { private: ['10001'], groups: [] },
      workspaceDir: '/tmp/b3-steer-race-qq',
      merge: { waitSec: 0.01, maxSec: 0.05 },
    }),
    buildTools: () => [],
    logger: noopLog,
    // 真实的行为钩子（modular-core 的 moduleHooks，不是 mods）：steer 预处理慢 60ms
    moduleHooks: {
      prompt: async (content, opts) => {
        if (opts?.steer) {
          steerHookReached = true
          await sleep(60)
        }
        return content
      },
    },
    log: noopLog,
  })
  const dataDir = mkdtempSync(join(tmpdir(), 'b3-steer-race-'))
  const prevDataDir = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dataDir
  try {
    const first = await core.dispatchLegacyEvent(privateEvent(901, '第一句'))
    assert.equal(first.handled, 'offered')
    for (let i = 0; i < 200 && listeners.size === 0; i++) await sleep(5)
    assert.ok(listeners.size > 0)

    // 回合已 running 后插话：路由走 steer
    const second = await core.dispatchLegacyEvent(privateEvent(902, '追问一句'))
    assert.equal(second.handled, 'steered')
    for (let i = 0; i < 200 && !steerHookReached; i++) await sleep(5)
    assert.ok(steerHookReached, 'steer 预处理（水合）应已开始')

    // 水合进行中旧回合 turn/end 落定 —— 此刻不许再 agent.steer
    for (const fn of [...listeners]) fn({ id: 'session-abcdef123456' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await sleep(200)

    assert.equal(steerCalls.length, 0, '旧回合已结束，绝不许向 idle agent 发孤儿 steer')
    assert.ok(followupCalls.length >= 2, '追问必须回退成新回合被重新处理（followup 再次调用）')
  } finally {
    core.dispose?.()
    if (prevDataDir === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prevDataDir
    rmSync(dataDir, { recursive: true, force: true })
  }
})
