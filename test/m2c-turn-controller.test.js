// M2-C 契约测试：Turn Controller / Scheduler（旧 aggregator 五条恢复前置在新设计里全部成立）
// 任务书必测：lead 取消不销毁 follower；flush 与 in-flight 无空档；异常唤醒所有等待者；
// dispose 覆盖排队和执行任务；取消是否真实传播到 DSH 如实标记。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createTurnController } from '../src/chat/turn-controller.js'
import { createTurnScheduler } from '../src/chat/turn-scheduler.js'
import { createTurn, setTurnState, addMember } from '../src/chat/turn-state.js'

const inbound = (id, chatKey = 'private:10001', text = `消息${id}`) => ({
  contractVersion: 1,
  eventId: id,
  messageId: id,
  chatKey,
  sender: { userId: '10001' },
  timestamp: Date.now(),
  source: 'realtime',
  segments: [{ type: 'text', data: { text } }],
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('turn-state：合法迁移通过，非法迁移与重复成员拒绝', () => {
  const t = createTurn({ chatKey: 'private:1', memberEventId: 'e1' })
  assert.equal(t.state, 'merging')
  setTurnState(t, 'pending')
  setTurnState(t, 'running')
  setTurnState(t, 'succeeded')
  assert.throws(() => setTurnState(t, 'running'), /非法状态迁移/)
  const t2 = createTurn({ chatKey: 'group:2', memberEventId: 'e2' })
  assert.equal(addMember(t2, inbound('e1', 'group:2')), true)
  assert.equal(addMember(t2, inbound('e1', 'group:2')), false, '同一事件不重复收')
  setTurnState(t2, 'pending')
  assert.throws(() => addMember(t2, inbound('e4', 'group:2')), /merging 态才能收成员/)
})

test('scheduler：每聊天串行、跨聊天并行', async () => {
  const s = createTurnScheduler()
  const order = []
  const job = (name, chat, ms) => async () => {
    order.push(`${name}:start`)
    await sleep(ms)
    order.push(`${name}:end`)
    return name
  }
  const p1 = s.submit('private:1', job('a', 'private:1', 30))
  const p2 = s.submit('private:1', job('b', 'private:1', 5))
  const p3 = s.submit('private:2', job('c', 'private:2', 5))
  assert.equal(await p1, 'a')
  assert.equal(await p3, 'c', '跨聊天不被 a 阻塞')
  assert.equal(await p2, 'b')
  const aIdx = order.indexOf('a:end')
  const bStart = order.indexOf('b:start')
  assert.ok(bStart > aIdx, '同聊天严格串行')
  const cStart = order.indexOf('c:start')
  assert.ok(cStart < aIdx, '跨聊天并行（c 在 a 结束前就开跑）')
  await s.dispose()
})

test('scheduler：异常唤醒下一个（无空档），排队任务在 dispose 时全部唤醒', async () => {
  const s = createTurnScheduler()
  const p1 = s.submit('private:1', async () => { throw new Error('炸了') })
  const p2 = s.submit('private:1', async () => '后来者照常执行')
  await assert.rejects(() => p1, /炸了/)
  assert.equal(await p2, '后来者照常执行', '异常后队列继续（无空档）')
  const p3 = s.submit('private:1', () => sleep(50))
  const p4 = s.submit('private:1', () => '排队中')
  const disposeP = s.dispose()
  await assert.rejects(() => p4, /卸载/)
  await p3
  await disposeP
})

test('合流：lead 开窗，follower 加入同一回合；窗口到期整回合执行（成员齐全）', async () => {
  const executed = []
  const ctl = createTurnController({
    merge: { waitMs: 30, maxMs: 200 },
    execute: async (turn, io) => { executed.push({ id: turn.turnId, members: io.members.map((x) => x.eventId), signal: !io.signal.aborted }) },
  })
  const lead = ctl.offer(inbound('e1'))
  assert.equal(lead.role, 'lead')
  const fol = ctl.offer(inbound('e2'))
  assert.equal(fol.role, 'follower')
  assert.equal(fol.turnId, lead.turnId)
  const fol2 = ctl.offer(inbound('e3'))
  assert.equal(fol2.role, 'follower')
  await sleep(80) // 等窗口到期 + 执行
  assert.equal(executed.length, 1)
  assert.deepEqual(executed[0].members, ['e1', 'e2', 'e3'], '三条成员合入同一回合')
  assert.equal(executed[0].signal, true, '未取消时 signal 正常')
  await ctl.dispose()
})

test('续窗有上限：maxMs 到点必执行（旧 timer 作废——timer generation）', async () => {
  const executed = []
  const ctl = createTurnController({
    merge: { waitMs: 40, maxMs: 90 },
    execute: async (turn, io) => { executed.push(io.members.map((x) => x.eventId)) },
  })
  ctl.offer(inbound('e1'))
  // 每 25ms 来一条、连来 8 条（总时长 200ms > maxMs 90ms）
  for (let i = 2; i <= 9; i++) {
    await sleep(25)
    ctl.offer(inbound(`e${i}`))
  }
  await sleep(120)
  assert.ok(executed.length >= 1, 'maxMs 内必然 flush 过至少一次（不被无限续窗）')
  const all = executed.flat()
  assert.ok(all.includes('e1') && all.includes('e9'), '成员不丢（分批执行也行，但事件全都要落到回合里）')
  await ctl.dispose()
})

test('lead 取消不销毁 follower：merging 回合取消后，其余成员各自成为新 lead 重开回合', async () => {
  const executed = []
  const ctl = createTurnController({
    merge: { waitMs: 500, maxMs: 1000 }, // 长窗口：不会被时间到期干扰
    execute: async (turn, io) => { executed.push(io.members.map((x) => x.eventId)) },
  })
  const lead = ctl.offer(inbound('lead-1'))
  ctl.offer(inbound('fol-1'))
  ctl.offer(inbound('fol-2'))
  const r = ctl.cancel(lead.turnId)
  assert.equal(r.honest, 'cancelled-immediately', 'merging 态取消立即生效')
  assert.equal(ctl.getTurn(lead.turnId).state, 'cancelled')
  // follower 事件不丢：各自重开窗口（waitMs 30 内不会自己跑，这里验证窗口重建）
  await sleep(20)
  const t1 = ctl.mergingTurnOf('private:10001')
  assert.ok(t1 && t1 !== lead.turnId, 'follower 重开了新窗口')
  assert.notEqual(t1, null)
  // 等新窗口到期执行
  await sleep(600)
  const merged = executed.flat()
  assert.ok(merged.includes('fol-1') && merged.includes('fol-2'), '两个 follower 都被执行（未销毁）')
  assert.ok(!merged.includes('lead-1'), '被取消的 lead 不再执行')
  await ctl.dispose()
})

test('flush 与 in-flight 无空档：窗口结束时上一回合还在跑 → 排队，跑完立即接续', async () => {
  const events = []
  let releaseRunning
  const runningGate = new Promise((r) => { releaseRunning = r })
  const ctl = createTurnController({
    merge: { waitMs: 20, maxMs: 50 },
    execute: async (turn, io) => {
      events.push(`run:${io.members[0].eventId}`)
      if (io.members[0].eventId === 'e1') await runningGate // 第一回合挂住
    },
  })
  ctl.offer(inbound('e1'))
  await sleep(50) // e1 窗口到期 → running（挂住）
  assert.equal(ctl.runningTurnOf('private:10001') != null, true, 'e1 在跑')
  ctl.offer(inbound('e2'))
  await sleep(60) // e2 窗口到期 → 应排队而不是并发
  assert.equal(events.filter((x) => x.startsWith('run:e2')).length, 0, '上一回合未完，e2 绝不并发')
  releaseRunning()
  await sleep(60)
  assert.ok(events.includes('run:e2'), 'e1 落定后 e2 立即接续（无空档）')
  await ctl.dispose()
})

test('异常唤醒所有等待者：execute 抛错 → 回合 failed，挂起的 steer 请求同错误唤醒', async () => {
  let steerError = null
  const ctl = createTurnController({
    merge: { waitMs: 15, maxMs: 40 },
    execute: async (turn, io) => {
      if (turn.memberEventIds[0] === 'e1') {
        // 不注册 handler、不消费：steer 进入 pendingSteers 挂起
        await sleep(60)
        throw new Error('执行炸了')
      }
      return 'ok'
    },
  })
  const lead = ctl.offer(inbound('e1'))
  await sleep(40) // running（execute 还在睡）
  ctl.steer(lead.turnId, inbound('late-steer')).catch((e) => { steerError = e })
  await sleep(60) // execute 抛错 → 落定 failed → 挂起 steer 同错误唤醒
  assert.equal(ctl.getTurn(lead.turnId).state, 'failed')
  assert.ok(steerError, '挂起的 steer 被唤醒')
  assert.match(String(steerError?.message), /炸了|已结束|取消/)
  await ctl.dispose()
})

test('steer：running 回合收到转向输入（handler 消费 + 成员计入）；merging 态收到走普通合流', async () => {
  const steered = []
  const ctl = createTurnController({
    merge: { waitMs: 15, maxMs: 40 },
    execute: async (turn, io) => {
      if (turn.memberEventIds[0] === 'lead') {
        io.onSteer((inp) => { steered.push(inp.eventId) })
        await sleep(30) // 留时间给 steer 注入
      }
    },
  })
  const lead = ctl.offer(inbound('lead'))
  await sleep(40) // 进入 running
  assert.equal(ctl.runningTurnOf('private:10001'), lead.turnId)
  await ctl.steer(lead.turnId, inbound('steer-1'))
  assert.deepEqual(steered, ['steer-1'], 'handler 收到转向输入')
  assert.ok(ctl.getTurn(lead.turnId).memberEventIds.includes('steer-1'), '转向输入计入成员')
  await ctl.dispose()
})

test('steer 缓存：execute 还没注册 handler 时，转向输入缓存并在注册时补投', async () => {
  const steered = []
  const ctl = createTurnController({
    merge: { waitMs: 15, maxMs: 40 },
    execute: async (turn, io) => {
      if (turn.memberEventIds[0] === 'lead') {
        await sleep(20) // 先让 steer 到达（此时未注册）
        io.onSteer((inp) => { steered.push(inp.eventId) }) // 注册 → 缓存补投
        await sleep(20)
      }
    },
  })
  const lead = ctl.offer(inbound('lead'))
  await sleep(40) // running
  const p = ctl.steer(lead.turnId, inbound('early-steer'))
  await p
  await sleep(60)
  assert.deepEqual(steered, ['early-steer'], '注册后补投缓存输入')
  await ctl.dispose()
})

test('取消诚实标记：running 态 cancel 只是请求，execute 尊重 signal 才真的 cancelled', async () => {
  const results = []
  const ctl = createTurnController({
    merge: { waitMs: 15, maxMs: 40 },
    execute: async (turn, io) => {
      // 尊重取消的 execute：signal 中止就以 AbortError 结束
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve('跑完了'), 200)
        io.signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('被取消'), { name: 'AbortError' })) })
      })
      return '跑完了'
    },
  })
  const turn1 = ctl.offer(inbound('c1'))
  await sleep(40) // running
  const r = ctl.cancel(turn1.turnId)
  assert.equal(r.honest, 'cancel-requested', 'running 态只能「请求」取消')
  await sleep(60)
  assert.equal(ctl.getTurn(turn1.turnId).state, 'cancelled', 'execute 尊重 signal → 最终态诚实标为 cancelled')
  assert.ok(ctl.getTurn(turn1.turnId).cancelRequestedAt != null, '取消请求留痕')

  // 对照：execute 无视 signal → 状态只能等它自然落定，controller 不谎报
  const ctl2 = createTurnController({
    merge: { waitMs: 15, maxMs: 40 },
    execute: async (turn, io) => {
      await sleep(80) // 无视 signal
      results.push('无视取消跑完了')
      return 'ok'
    },
  })
  const turn2 = ctl2.offer(inbound('c2'))
  await sleep(40)
  ctl2.cancel(turn2.turnId)
  await sleep(20)
  assert.equal(ctl2.getTurn(turn2.turnId).state, 'running', 'execute 无视 signal 时绝不谎报已取消')
  await sleep(80)
  assert.equal(ctl2.getTurn(turn2.turnId).state, 'succeeded', '自然跑完按成功落定')
  void results
  await ctl2.dispose()
  await ctl.dispose()
})

test('dispose：清窗口定时器、在飞 execute 收到 abort、挂起的 steer 全部唤醒', async () => {
  const ctl = createTurnController({
    merge: { waitMs: 20, maxMs: 50 }, // 短窗口：让 d1 尽快进入 running
    execute: async (turn, io) => {
      // 不注册 steer handler：steer 请求进入 pendingSteers 挂起，dispose 时被唤醒
      void io
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve('ok'), 5000)
        io.signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('dispose 取消'), { name: 'AbortError' })) })
      })
    },
  })
  const turn = ctl.offer(inbound('d1'))
  await sleep(50) // running
  assert.equal(ctl.runningTurnOf('private:10001'), turn.turnId, 'd1 已在跑')
  const steerP = ctl.steer(turn.turnId, inbound('s1'))
  steerP.catch(() => {})
  await sleep(20)
  await ctl.dispose()
  assert.equal(ctl.getTurn(turn.turnId).state, 'cancelled', '在飞回合被 dispose abort 后诚实落定为 cancelled')
  await assert.rejects(() => steerP, /卸载|已结束|取消/, '挂起的 steer 唤醒')
})

test('跨聊天并行：两个聊天的回合同时执行互不阻塞', async () => {
  const runningAt = {}
  const ctl = createTurnController({
    // 群聊窗口是独立参数（groupWaitMs/groupMaxMs），这里一并收短
    merge: { waitMs: 10, maxMs: 30, groupWaitMs: 10, groupMaxMs: 30 },
    execute: async (turn, io) => {
      runningAt[turn.chatKey] = runningAt[turn.chatKey] || []
      runningAt[turn.chatKey].push(Date.now())
      await sleep(40)
    },
  })
  ctl.offer(inbound('x1', 'private:1'))
  ctl.offer(inbound('y1', 'group:2'))
  await sleep(150)
  assert.equal(runningAt['private:1'].length, 1)
  assert.equal(runningAt['group:2'].length, 1)
  const overlap = Math.abs(runningAt['private:1'][0] - runningAt['group:2'][0]) < 35
  assert.ok(overlap, '两个聊天几乎同时执行（并行）')
  await ctl.dispose()
})
