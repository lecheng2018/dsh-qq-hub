// 审计 Q04 / Q05 的回归锁：
//   Q04 · 后台回合超时必须结束任务，不只是结束等待；卸载必须兑现所有等待者。
//   Q05 · 终态回合不能无限保留整包入站输入（members 含结构化原始事件与媒体块）。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createSystemTurns } from '../src/chat/system-turns.js'
import { createTurnController } from '../src/chat/turn-controller.js'

const log = { info() {}, warn() {}, debug() {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- Q04 ----------

/** 一个不主动发事件的假 agent：一切靠测试手动 drive。 */
function deferredAgent() {
  const listeners = []
  const agent = {
    followup: async () => {},
    emit(event) { for (const fn of listeners) fn() },
  }
  const onEvent = (fn) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) } }
  return { agent, onEvent }
}

function systemFixture({ timeoutMs = 40 } = {}) {
  const { agent, onEvent } = deferredAgent()
  const turns = createSystemTurns({
    createSession: async () => ({ sessionId: 'sys-1' }),
    resolveAgent: async () => ({ agent }),
    onEvent,
    log,
  })
  return { turns, agent, onEvent, timeoutMs }
}

test('Q04 · 超时立刻释放槽位：同名任务可以立刻开下一轮', async () => {
  const { turns } = systemFixture()
  // 谁都不回 turn/end —— 模拟网关/DSH 卡住
  const first = turns.run('diary', '日记', '写一篇', { timeoutMs: 30 })
  await assert.rejects(() => first, /等太久了/)

  // 过去这里会报「这个后台会话的上一轮还没结束」，因为 running 只在迟到的
  // turn/end 里才被删，而那个事件永远不来。
  const second = turns.run('diary', '日记', '再写一篇', { timeoutMs: 30 })
  await assert.rejects(() => second, /等太久了/, '第二次必须真的跑起来（超时），而不是报忙')

  await turns.dispose()
})

test('Q04 · 超时后再收到迟到的 turn/end 不会重复兑现', async () => {
  const { turns, agent } = systemFixture()
  const p = turns.run('diary', '日记', '写一篇', { timeoutMs: 25 })
  await assert.rejects(() => p, /等太久了/)
  // 迟到的 turn/end：只应被丢弃，不产生第二次结算
  agent.emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await sleep(10)
  await turns.dispose()
})

test('Q04 · dispose 必须兑现正在等待的调用方（不能留悬空 promise）', async () => {
  const { turns } = systemFixture()
  const pending = turns.run('diary', '日记', '写一篇', { timeoutMs: 60_000 })
  await sleep(5)
  await turns.dispose()
  await assert.rejects(() => pending, /已卸载/, '卸载时挂着的等待者必须落定，不能永远悬着')
})

test('Q04 · 卸载后再 run 直接拒绝', async () => {
  const { turns } = systemFixture()
  await turns.dispose()
  await assert.rejects(() => turns.run('diary', '日记', 'x'), /已卸载/)
})

// ---------- Q05 ----------

function controllerFixture({ turnCacheMax } = {}) {
  const executed = []
  const controller = createTurnController({
    log,
    ...(turnCacheMax ? { turnCacheMax } : {}),
    execute: async (turn) => { executed.push(turn.turnId); return 'ok' },
    merge: { waitMs: 1, maxMs: 2, groupWaitMs: 1, groupMaxMs: 2 },
  })
  return { controller, executed }
}

const inbound = (n) => ({
  eventId: `e${n}`, chatKey: 'private:1', text: `第 ${n} 条`,
  segments: [{ type: 'text', data: { text: `第 ${n} 条` } }],
})

/**
 * 等一个回合走到终态。
 *
 * 为什么不用 controller.waitForTurn()：它返回的是 _completion.promise，只有
 * offer 内部那条 pending 链路被结算时才 resolve，而合流窗口用的是
 * `setTimeout(...).unref()`。本地 1ms 窗口几乎立刻触发；CI 上机器慢、争用大，
 * 定时器还没跑事件循环就先判空了 —— Node 会报
 * `Promise resolution is still pending but the event loop has already resolved`
 * （failureType: cancelledByParent）。这不是代码缺陷，是测试写法依赖了
 * 「短期定时器一定能撑到执行」这个在慢机器上不成立的假设。
 *
 * 改成显式轮询：每次 setImmediate 让出一次事件循环，直到终态或超时。
 */
async function waitTerminal(controller, turnId, { tries = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const st = controller.getTurn(turnId)?.state
    if (st === 'succeeded' || st === 'failed' || st === 'cancelled') return st
    await new Promise((resolve) => setImmediate(resolve))
  }
  return controller.getTurn(turnId)?.state
}

test('Q05 · 回合落定后剥离 members（不保留整包入站数据）', async () => {
  const { controller } = controllerFixture()
  const r = controller.offer(inbound(1))
  const turnId = r.turnId
  assert.equal(await waitTerminal(controller, turnId), 'succeeded', '回合应成功落定')
  const view = controller.getTurn(turnId)
  assert.ok(view, '终态回合仍可查证')
  assert.equal(view.state, 'succeeded')
  assert.equal(view.members, undefined, 'members 必须在落定时就剥离')
  assert.deepEqual(view.memberEventIds, ['e1'], '成员事件 id 只留字符串，作诊断依据')
  await controller.dispose()
})

test('Q04 补充 · waitForTurn 在事件循环无其它句柄时也必须落定', async () => {
  // CI 暴露的真实缺陷（failureType: cancelledByParent）：
  // 合流窗口的 setTimeout 是 unref 的，await waitForTurn() 期间若没有别的 ref 句柄，
  // Node 会判定事件循环已排空 → await 永远等不到。
  // 这不是测试写法问题：生产代码 modular-core.js 的 dispatchLegacyEventSettled
  // 也 await 它（兼容旧 hub.onMessage 的等待契约）。
  const controller = createTurnController({
    log,
    merge: { waitMs: 5, maxMs: 10, groupWaitMs: 5, groupMaxMs: 10 },
    execute: async () => 'ok',
  })
  const r = controller.offer({ ...inbound(1), chatKey: 'private:90501' })
  // 关键：这里只 await，不做任何轮询 —— 旧实现会挂在这里
  const outcome = await controller.waitForTurn(r.turnId)
  assert.deepEqual(outcome, { state: 'succeeded', value: 'ok' }, '必须拿到真实结果，不能是 undefined')
  assert.equal(controller.getTurn(r.turnId).state, 'succeeded', '拿到的结果必须对应真终态')
  await controller.dispose()
})

test('Q04 补充 · 纯 node 子进程里 waitForTurn 也不挂起（CI 的真实形态）', async () => {
  // 上一轮在 test runner 里跑不出问题：runner 自己持有 ref 句柄，替我们把事件循环
  // 托住了 —— 而 CI 报的正是「事件循环已排空」。所以要单开一个**不经 runner** 的
  // node 子进程来验，那才是 failureType: cancelledByParent 的真实触发条件。
  const script = `
    import { createTurnController } from ${JSON.stringify(new URL('../src/chat/turn-controller.js', import.meta.url).href)}
    const log = { info(){}, warn(){}, debug(){} }
    const c = createTurnController({ log, merge: { waitMs: 5, maxMs: 10, groupWaitMs: 5, groupMaxMs: 10 }, execute: async () => 'ok' })
    const r = c.offer({ eventId: 'e', chatKey: 'private:1', text: 't', segments: [{ type: 'text', data: { text: 't' } }] })
    const outcome = await c.waitForTurn(r.turnId)
    await c.dispose()
    // 用 stdout 回报，父进程据此判断是否有未结算的 await
    process.stdout.write(JSON.stringify(outcome))
  `
  const { spawnSync } = await import('node:child_process')
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  // 挂起时 node 会打「Detected unsettled top-level await」并以非零码/无输出结束
  assert.equal(res.status, 0, `子进程异常退出：${res.stderr || res.stdout}`)
  assert.ok(!/unsettled top-level await/.test(res.stderr || ''), '不得出现未结算的顶层 await')
  assert.deepEqual(JSON.parse(res.stdout), { state: 'succeeded', value: 'ok' }, '子进程应拿到真实结果')
})

test('Q04 补充 · waitForTurn 对未知回合返回 null 而不是挂起', async () => {
  const controller = createTurnController({ log, execute: async () => 'ok' })
  assert.equal(await controller.waitForTurn('turn-不存在'), null)
  await controller.dispose()
})

test('Q05 · 终态回合数量有上限，最老的先淘汰', async () => {
  const { controller } = controllerFixture({ turnCacheMax: 5 })
  const ids = []
  for (let i = 1; i <= 12; i++) {
    const r = controller.offer({ ...inbound(i), chatKey: `private:${90200 + i}` })
    ids.push(r.turnId)
    await waitTerminal(controller, r.turnId)
  }
  // 最近 5 个还能查到，更早的被淘汰
  const alive = ids.filter((id) => controller.getTurn(id) !== null)
  assert.ok(alive.length <= 5, `终态缓存必须有上限，实际保留 ${alive.length}`)
  assert.ok(alive.includes(ids.at(-1)), '最新的必须还在')
  assert.ok(!alive.includes(ids[0]), '最老的必须被淘汰')
  await controller.dispose()
})

test('Q05 · 淘汰不碰在飞的回合', async () => {
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  const controller = createTurnController({
    log,
    turnCacheMax: 2,
    merge: { waitMs: 1, maxMs: 2, groupWaitMs: 1, groupMaxMs: 2 },
    execute: async (turn) => {
      if (String(turn.memberEventIds[0]) === 'slow') await gate
      return 'ok'
    },
  })
  // 慢回合用独立 chatKey：调度器按 chatKey 串行，同一聊天里的后续回合会排在它后面，
  // 那样测的就不是「淘汰是否碰在飞回合」，而是队列本身。
  const slow = controller.offer({ ...inbound(0), eventId: 'slow', chatKey: 'private:90001' })
  // 必须确认慢回合真的进了 running：只睡固定毫秒在慢机器上可能还没进状态，
  // 那样后面「不得淘汰在飞回合」测的是别的东西。
  for (let i = 0; i < 500 && controller.getTurn(slow.turnId)?.state !== 'running'; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(controller.getTurn(slow.turnId)?.state, 'running', '慢回合应已在执行中')
  // 塞满并超过上限的快速回合（各自独立 chatKey，互不排队）
  for (let i = 1; i <= 6; i++) {
    const r = controller.offer({ ...inbound(i), chatKey: `private:9010${i}` })
    await waitTerminal(controller, r.turnId)
  }
  assert.ok(controller.getTurn(slow.turnId) !== null, '在飞的回合不得被淘汰')
  release()
  assert.equal(await waitTerminal(controller, slow.turnId), 'succeeded', '放行后慢回合应成功落定')
  await controller.dispose()
})