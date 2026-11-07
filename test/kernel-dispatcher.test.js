// 出站 Dispatcher 单元测试（RFC-0001 §2 Dispatcher & Sink / §4 Phase 1，US-005）。
//
// 全程假 clock/sleep/jitter + stub sender，零真睡、零 onebot。覆盖 AC 五组：
//   ①HIGH 插队 NORMAL；②同优先级按 createdAt FIFO；③注入假 clock/sleep 钉死间隔序列；
//   ④中途 abort 剩余丢弃且 dropped 计数正确、不抛错；⑤shadow 同 payload hash 稳定、
//   live 不走 hash 记录路径。对抗：sender 抛错隔离单条、空队列零调用、构造参数互斥守卫、
//   快照纪律（drain 期间外部 enqueue 不进本轮）、queue 消费语义、reportStage/日志出口炸不吃崩。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createContext } from '../src/kernel/context.js'
import { createDispatcher, hashReplyPayload } from '../src/kernel/dispatcher.js'

// ---- 桩件 ----

function envelope(over = {}) {
  return {
    id: 'evt-1',
    protocol: 'onebot:v11',
    type: 'message',
    timestamp: 1,
    selfId: 'bot-1',
    sender: { userId: 'u-1' },
    segments: [{ type: 'text', data: { text: 'hi' } }],
    rawText: 'hi',
    rawPayload: { post_type: 'message' },
    ...over,
  }
}

function newCtx() {
  return createContext(envelope(), 'onebot')
}

function textSegs(text) {
  return [{ type: 'text', data: { text } }]
}

/** 入队一条并返回其 id（context.enqueue 自动生成 id/createdAt）。 */
function push(ctx, text, over = {}) {
  ctx.reply.enqueue({
    targetType: 'private',
    targetId: 'u-1',
    segments: textSegs(text),
    priority: 'NORMAL',
    ...over,
  })
  return ctx.reply.queue[ctx.reply.queue.length - 1].id
}

/** 假时钟 + 假 sleep：sleep 只记账并拨钟，绝不同时序真睡。 */
function fakeTime(start = 10000) {
  let t = start
  const sleeps = []
  return {
    clock: () => t,
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms)
      t += ms
    },
  }
}

/** 记录型 sender 桩：返回收到的 payload 数组；可注入按次抛错/副作用钩子。 */
function spySender(hook = null) {
  const calls = []
  const sender = async (payload) => {
    calls.push(payload)
    if (hook) hook(payload, calls.length)
  }
  return { calls, sender }
}

function quietLog() {
  const lines = []
  return {
    lines,
    debug: (...a) => lines.push(['debug', ...a].join(' ')),
    warn: (...a) => lines.push(['warn', ...a].join(' ')),
    error: (...a) => lines.push(['error', ...a].join(' ')),
  }
}

/** Date.now 步进桩：每次调用前进 step，让同一毫秒内入队的条目拿到可区分的 createdAt。 */
function withSteppedNow(step, fn) {
  const orig = Date.now
  let t = 100000
  Date.now = () => {
    const v = t
    t += step
    return v
  }
  try {
    return fn()
  } finally {
    Date.now = orig
  }
}

const noJitter = () => 0 // 间隔系数固定 0.8，断言可精确到毫秒

// ---------- ① 优先级插队 ----------

test('①：HIGH 后发仍先出，NORMAL 保持相对序', async () => {
  const ctx = newCtx()
  const n1 = push(ctx, 'normal-1')
  const n2 = push(ctx, 'normal-2')
  const h1 = push(ctx, 'high-1', { priority: 'HIGH' })
  const low = push(ctx, 'low-1', { priority: 'LOW' })

  const ft = fakeTime()
  const { calls, sender } = spySender()
  const d = createDispatcher({ sender, clock: ft.clock, sleep: ft.sleep, jitter: noJitter })
  const summary = await d.drain(ctx)

  assert.deepEqual(calls.map((p) => p.id), [h1, n1, n2, low])
  assert.equal(summary.sent, 4)
  assert.deepEqual(summary.byPriority, { HIGH: 1, NORMAL: 2, LOW: 1 })
})

test('①对抗：未知 priority 归 NORMAL 桶，不获得插队权', async () => {
  const ctx = newCtx()
  const lowId = push(ctx, 'L', { priority: 'LOW' })
  const oddId = push(ctx, 'X', { priority: 'URGENT' })
  const highId = push(ctx, 'H', { priority: 'HIGH' })

  const ft = fakeTime()
  const { calls, sender } = spySender()
  const d = createDispatcher({ sender, clock: ft.clock, sleep: ft.sleep, jitter: noJitter })
  const summary = await d.drain(ctx)

  assert.deepEqual(calls.map((p) => p.id), [highId, oddId, lowId])
  assert.deepEqual(summary.byPriority, { HIGH: 1, NORMAL: 1, LOW: 1 })
})

// ---------- ② 同优先级 FIFO ----------

test('②：同优先级严格按 createdAt 升序（入队顺序）出队', async () => {
  const ctx = newCtx()
  const ids = []
  withSteppedNow(7, () => {
    ids.push(push(ctx, 'a'), push(ctx, 'b'), push(ctx, 'c'))
  })
  ids.push(push(ctx, 'd', { priority: 'LOW' }))

  const ft = fakeTime()
  const { calls, sender } = spySender()
  const d = createDispatcher({ sender, clock: ft.clock, sleep: ft.sleep, jitter: noJitter })
  await d.drain(ctx)

  assert.deepEqual(calls.map((p) => p.id), ids)
})

// ---------- ③ 限流间隔序列 ----------

test('③：间隔 = delayMs 覆写优先，否则 typing 估式；首条不等待、gap=0 不产生 sleep', async () => {
  const ctx = newCtx()
  push(ctx, 'x'.repeat(10)) // A：首条，不发 sleep
  push(ctx, 'y'.repeat(20)) // B：clamp(350+20*110=2550)*0.8 = 2040
  push(ctx, 'z'.repeat(5), { delayMs: 1234 }) // C：delayMs 覆写 → 1234
  push(ctx, 'w', { delayMs: 0 }) // D：0 → 跳过 sleep（连发）

  const ft = fakeTime(10000)
  const { sender } = spySender()
  const d = createDispatcher({ sender, clock: ft.clock, sleep: ft.sleep, jitter: noJitter })
  const summary = await d.drain(ctx)

  assert.deepEqual(ft.sleeps, [2040, 1234])
  assert.equal(summary.startedAt, 10000)
  assert.equal(summary.finishedAt, 10000 + 2040 + 1234)
  assert.equal(summary.latencyMs, 3274)
})

test('③对抗：估式先 clamp 后乘抖动系数（700 下限 / 4500 上限 / 满抖动 1.3），与 bubbleDelay 语义对齐', async () => {
  // 短文本：typing 460 → clamp 下限 700 → *0.8 = 560 → **再 clamp 回 [700,4500] = 700**
  // （review A4#7 修复：jitter 结果不得突破声明的 min/max 边界）
  const ctx1 = newCtx()
  push(ctx1, 'a')
  push(ctx1, 'b')
  const ft1 = fakeTime()
  const d1 = createDispatcher({ sender: spySender().sender, clock: ft1.clock, sleep: ft1.sleep, jitter: noJitter })
  await d1.drain(ctx1)
  assert.deepEqual(ft1.sleeps, [700])

  // 超长文本：typing 11350 → clamp 上限 4500 → *0.8 = 3600
  const ctx2 = newCtx()
  push(ctx2, 'x')
  push(ctx2, 'y'.repeat(100))
  const ft2 = fakeTime()
  const d2 = createDispatcher({ sender: spySender().sender, clock: ft2.clock, sleep: ft2.sleep, jitter: noJitter })
  await d2.drain(ctx2)
  assert.deepEqual(ft2.sleeps, [3600])

  // 满抖动 jitter=1 → 系数 1.3：2550*1.3 = 3315
  const ctx3 = newCtx()
  push(ctx3, 'x')
  push(ctx3, 'y'.repeat(20))
  const ft3 = fakeTime()
  const d3 = createDispatcher({ sender: spySender().sender, clock: ft3.clock, sleep: ft3.sleep, jitter: () => 1 })
  await d3.drain(ctx3)
  assert.deepEqual(ft3.sleeps, [3315])

  // shaping 可配：整体覆盖四个参数
  const ctx4 = newCtx()
  push(ctx4, 'x')
  push(ctx4, 'y'.repeat(20))
  const ft4 = fakeTime()
  const d4 = createDispatcher({
    sender: spySender().sender,
    clock: ft4.clock,
    sleep: ft4.sleep,
    jitter: noJitter,
    shaping: { baseMs: 100, perCharMs: 10, minGapMs: 50, maxGapMs: 200 },
  })
  await d4.drain(ctx4)
  assert.deepEqual(ft4.sleeps, [Math.round(Math.min(200, Math.max(50, 100 + 200)) * 0.8)]) // 300→clamp 200→160
})

// ---------- ④ abort 丢弃 ----------

test('④：第一条发出后 abort，剩余三条 dropped 计数正确、队列清空、不抛错', async () => {
  const ctx = newCtx()
  for (let i = 0; i < 4; i += 1) push(ctx, `m${i}`)

  const ft = fakeTime()
  const log = quietLog()
  const { calls, sender } = spySender((payload, n) => {
    if (n === 1) ctx.abort('preempted-by-newer-turn')
  })
  const d = createDispatcher({ sender, clock: ft.clock, sleep: ft.sleep, jitter: noJitter, log })
  const summary = await d.drain(ctx) // 不抛错即为断言的一部分

  assert.equal(summary.total, 4)
  assert.equal(summary.sent, 1)
  assert.equal(summary.dropped, 3)
  assert.equal(calls.length, 1)
  assert.equal(ctx.reply.isEmpty(), true, 'abort 后必须 clear')
  assert.ok(log.lines.some((l) => l.includes('warn') && l.includes('dropped 3 of 4')))
})

test('④对抗：预 abort 的 ctx 一条都不发，dropped=total 且照常 clear', async () => {
  const ctx = newCtx()
  push(ctx, 'a')
  push(ctx, 'b')
  ctx.abort('already-gone')

  const ft = fakeTime()
  const { calls, sender } = spySender()
  const d = createDispatcher({ sender, clock: ft.clock, sleep: ft.sleep, jitter: noJitter })
  const summary = await d.drain(ctx)

  assert.equal(calls.length, 0)
  assert.deepEqual([summary.sent, summary.dropped, summary.total], [0, 2, 2])
  assert.equal(ctx.reply.isEmpty(), true)
  assert.deepEqual(ft.sleeps, [], 'abort 短路不得产生 sleep')
})

test('④对抗：sleep 期间 abort——醒来重查，当前条不发、计入 dropped', async () => {
  const ctx = newCtx()
  push(ctx, 'a')
  push(ctx, 'b')

  const ft = fakeTime()
  const { calls, sender } = spySender()
  const sleepAbort = async (ms) => {
    ft.sleeps.push(ms)
    ctx.abort('cut-in-sleep') // 模拟等待窗口内被抢占
  }
  const d = createDispatcher({ sender, clock: ft.clock, sleep: sleepAbort, jitter: noJitter })
  const summary = await d.drain(ctx)

  assert.equal(calls.length, 1, 'b 不能被发出')
  assert.deepEqual([summary.sent, summary.dropped], [1, 1])
  assert.equal(ctx.reply.isEmpty(), true)
})

// ---------- ⑤ shadow / dry-run ----------

test('⑤：shadow 不调 sender、hash 稳定可查、成功排空不动队列；live 不走 hash 记录路径', async () => {
  const ctx = newCtx()
  const id1 = push(ctx, '同样的内容')
  const id2 = push(ctx, '同样的内容') // 同 target + 同 segments → 必须同 hash

  const ft = fakeTime()
  const sh = createDispatcher({ clock: ft.clock, sleep: ft.sleep, jitter: noJitter, mode: 'shadow' })
  const summary = await sh.drain(ctx)

  assert.equal(summary.sent, 0)
  assert.equal(summary.shadow, 2)
  const recs = sh.shadowRecords()
  assert.deepEqual(recs.map((r) => r.id), [id1, id2])
  assert.equal(recs[0].hash, recs[1].hash, '同 payload 两次 hash 必须一致')
  assert.match(recs[0].hash, /^[0-9a-f]{12}$/)
  assert.equal(recs[0].priority, 'NORMAL')
  assert.equal(ctx.reply.queue.length, 2, 'shadow 成功排空绝不消费旧通道的队列')

  // 换个 dispatcher 实例、重新入队同内容：hash 仍稳定（可跨进程比对）
  const ctx2 = newCtx()
  push(ctx2, '同样的内容')
  const sh2 = createDispatcher({ clock: ft.clock, sleep: ft.sleep, mode: 'shadow' })
  await sh2.drain(ctx2)
  assert.equal(sh2.shadowRecords()[0].hash, recs[0].hash)

  // live 模式：影子记录池恒空
  const ctx3 = newCtx()
  push(ctx3, '同样的内容')
  const lv = createDispatcher({ sender: spySender().sender, clock: ft.clock, sleep: ft.sleep, jitter: noJitter })
  const live = await lv.drain(ctx3)
  assert.equal(live.sent, 1)
  assert.equal(live.shadow, 0)
  assert.deepEqual(lv.shadowRecords(), [])
  assert.equal(ctx3.reply.isEmpty(), true, 'live 成功排空消费队列')
})

test('⑤：hashReplyPayload 只吃 target+segments——元数据、键序、段序无关性', async () => {
  const base = { targetType: 'group', targetId: '9', segments: [{ type: 'image', data: { url: 'u', file: 'f' } }] }
  const h = hashReplyPayload(base)
  // id/createdAt/priority/delayMs 不参与 hash
  assert.equal(hashReplyPayload({ ...base, id: 'x', createdAt: 1, priority: 'HIGH', delayMs: 9 }), h)
  // data 键书写顺序不参与（canonicalJSON 排序）
  const reordered = { targetType: 'group', targetId: '9', segments: [{ type: 'image', data: { file: 'f', url: 'u' } }] }
  assert.equal(hashReplyPayload(reordered), h)
  // 内容不同必须不同
  assert.notEqual(hashReplyPayload({ ...base, targetId: '10' }), h)
  assert.notEqual(hashReplyPayload({ ...base, segments: [{ type: 'text', data: { text: 'u' } }] }), h)
})

// ---------- ⑥ sender 抛错隔离 ----------

test('⑥：单条抛错计数入 summary.failures，后续条目照发，drain 不抛错', async () => {
  const ctx = newCtx()
  const ids = [push(ctx, 'a'), push(ctx, 'b'), push(ctx, 'c')]

  const ft = fakeTime()
  const log = quietLog()
  const calls = []
  const d = createDispatcher({
    sender: async (payload) => {
      calls.push(payload.id)
      if (payload.id === ids[1]) throw new Error('onebot 500')
    },
    clock: ft.clock,
    sleep: ft.sleep,
    jitter: noJitter,
    log,
  })
  const summary = await d.drain(ctx)

  assert.deepEqual(calls, ids, '失败不得中断后续发送')
  assert.deepEqual([summary.sent, summary.failed, summary.dropped], [2, 1, 0])
  assert.deepEqual(summary.failures, [{ id: ids[1], message: 'onebot 500' }])
  assert.ok(log.lines.some((l) => l.includes('error') && l.includes('onebot 500')))
})

// ---------- ⑦ 空队列 ----------

test('⑦：空队列 drain 零调用，summary 全零且形状稳定', async () => {
  const ctx = newCtx()
  const ft = fakeTime(500)
  const { calls, sender } = spySender()
  const stages = []
  const d = createDispatcher({
    sender,
    clock: ft.clock,
    sleep: ft.sleep,
    jitter: noJitter,
    reportStage: (name, ms) => stages.push([name, ms]),
  })
  const summary = await d.drain(ctx)

  assert.equal(calls.length, 0)
  assert.deepEqual(ft.sleeps, [])
  assert.equal(summary.total, 0)
  assert.deepEqual(summary.byPriority, { HIGH: 0, NORMAL: 0, LOW: 0 })
  assert.deepEqual([summary.sent, summary.failed, summary.dropped, summary.shadow], [0, 0, 0, 0])
  assert.equal(summary.latencyMs, 0)
  assert.deepEqual(stages, [['dispatcher', 0]])
})

// ---------- 构造守卫 / 快照纪律 / 打点注入 ----------

test('构造守卫：mode 互斥非法值抛 TypeError；live 缺 sender 抛 TypeError；shadow 免 sender', async () => {
  assert.throws(() => createDispatcher({ mode: 'both' }), TypeError)
  assert.throws(() => createDispatcher({ mode: 'live', sender: undefined }), TypeError)
  assert.throws(() => createDispatcher({ sender: 'not-a-fn' }), TypeError)
  const ok = createDispatcher({ mode: 'shadow' })
  assert.equal(ok.mode, 'shadow')
  const ctx = newCtx()
  push(ctx, 'a')
  const summary = await ok.drain(ctx)
  assert.equal(summary.shadow, 1)
})

test('快照纪律：drain 期间外部 enqueue 的新条目绝不进本轮（queue getter 是内部引用，先 slice）', async () => {
  const ctx = newCtx()
  push(ctx, 'a')
  push(ctx, 'b')

  const ft = fakeTime()
  const { calls, sender } = spySender((payload, n) => {
    if (n === 1) {
      ctx.reply.enqueue({
        targetType: 'private',
        targetId: 'u-1',
        segments: textSegs('late-arrival'),
        priority: 'HIGH',
      })
    }
  })
  const d = createDispatcher({ sender, clock: ft.clock, sleep: ft.sleep, jitter: noJitter })
  const summary = await d.drain(ctx)

  assert.equal(summary.total, 2, '本轮只吃快照')
  assert.equal(calls.length, 2)
})

test('reportStage 与日志出口抛错都不吃崩 drain（可观测性不是新故障面）', async () => {
  const ctx = newCtx()
  push(ctx, 'a')

  const ft = fakeTime()
  const { calls, sender } = spySender()
  const d = createDispatcher({
    sender,
    clock: ft.clock,
    sleep: ft.sleep,
    jitter: noJitter,
    stageName: 'egress-flush',
    reportStage: () => {
      throw new Error('metrics sink down')
    },
    log: { debug: () => { throw new Error('log down') }, warn: () => { throw new Error('log down') }, error: () => { throw new Error('log down') } },
  })
  const summary = await d.drain(ctx)

  assert.equal(calls.length, 1)
  assert.equal(summary.sent, 1)
})

test('payload 全程只读：dispatcher 拿原件引用、条目从入队到消费逐字段不变', async () => {
  const ctx = newCtx()
  push(ctx, 'a', { segments: [{ type: 'text', data: { text: 'a' } }, { type: 'image', data: { url: 'http://x' } }] })
  push(ctx, 'b', { priority: 'LOW' })

  const snapshot = JSON.parse(JSON.stringify([...ctx.reply.queue]))
  const originals = [...ctx.reply.queue]

  const ft = fakeTime()
  const seen = []
  const d = createDispatcher({
    sender: async (p) => { seen.push(p) },
    clock: ft.clock,
    sleep: ft.sleep,
    jitter: noJitter,
  })
  const summary = await d.drain(ctx)

  assert.equal(summary.sent, 2)
  assert.equal(seen[0], originals[0], '送达的是冻结原件引用，不是克隆')
  assert.ok(seen.every((p) => Object.isFrozen(p) && Object.isFrozen(p.segments)))
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), snapshot, '消费全程未篡改任何字段')
})


// ===== 2026-11-07 review A4 修复回归 =====

test('A4#1 drain 期间新入队的条目不被吞：归下一批（旧结尾 clear 连锅端已修）', async () => {
  const ctx = newCtx()
  push(ctx, '第一条')
  const ft = fakeTime()
  let enqDuringDrain = false
  const origSleep = ft.sleep
  const sleep = async (ms) => {
    if (!enqDuringDrain) { enqDuringDrain = true; push(ctx, 'drain 期间新来的') }
    return origSleep(ms)
  }
  const { sender, calls } = spySender()
  const d = createDispatcher({ sender, clock: ft.clock, sleep, jitter: noJitter })
  // 两条：第二条发送前的 sleep 里 enqueue 第三条 → 本批只处理领取时的两条
  push(ctx, '第二条')
  const s1 = await d.drain(ctx)
  assert.equal(s1.sent, 2)
  assert.equal(s1.deferred, 0)
  const q = ctx.reply.queue
  assert.equal(q.length, 1, 'drain 期间入队的第三条必须还在队列里')
  const s2 = await d.drain(ctx)
  assert.equal(s2.sent, 1)
  assert.equal(calls.length, 3)
})

test('A4#3 sleep 拒绝：未尝试条目 restoreFront 回队列计 deferred，已发送绝不重放', async () => {
  const ctx = newCtx()
  push(ctx, '甲')
  push(ctx, '乙')
  push(ctx, '丙')
  const ft = fakeTime()
  let n = 0
  const sleep = async (ms) => {
    n += 1
    if (n === 2) { const e = new Error('scheduler down'); throw e }
    return ft.sleep(ms)
  }
  const { sender, calls } = spySender()
  const d = createDispatcher({ sender, clock: ft.clock, sleep, jitter: noJitter })
  const s = await d.drain(ctx)
  assert.equal(s.sent, 2, '甲乙已发（sleep #1 正常，#2 抛）')
  assert.equal(s.deferred, 1, '丙未尝试计 deferred')
  assert.equal(s.infrastructureError.phase, 'sleep')
  assert.equal(ctx.reply.queue.length, 1, '未尝试条目回到队首')
  const s2 = await d.drain(ctx)
  assert.equal(s2.sent, 1)
  assert.equal(calls.length, 3, '甲乙没有被重发')
})

test('A4#5 createdAt 倒序不打乱同优先级入队序（FIFO 契约，删 createdAt 次排序）', async () => {
  const taken = []
  const ctx = {
    reply: {
      queue: Object.freeze([
        { id: 'A', priority: 'NORMAL', createdAt: 200, segments: [{ type: 'text', data: { text: 'a' } }] },
        { id: 'B', priority: 'NORMAL', createdAt: 100, segments: [{ type: 'text', data: { text: 'b' } }] },
        { id: 'C', priority: 'HIGH', createdAt: 300, segments: [{ type: 'text', data: { text: 'c' } }] },
      ]),
      clear() { taken.push('clear') },
      restoreFront(items) { this.queue = items },
    },
    signal: { aborted: false },
  }
  const ft = fakeTime()
  const { sender, calls } = spySender()
  const d = createDispatcher({ sender, clock: ft.clock, sleep: ft.sleep, jitter: noJitter })
  await d.drain(ctx)
  assert.deepEqual(calls.map((p) => p.id), ['C', 'A', 'B'], 'HIGH 插队；NORMAL 按入队序，不按 createdAt')
})

test('A4#4 跨 drain pacing：上一条发出后的最小间隔对下一轮第一条同样生效', async () => {
  const ft = fakeTime()
  const { sender } = spySender()
  const d = createDispatcher({ sender, clock: ft.clock, sleep: ft.sleep, jitter: noJitter })
  const ctx1 = newCtx()
  push(ctx1, '轮一')
  await d.drain(ctx1)
  const ctx2 = newCtx()
  push(ctx2, '轮二')
  await d.drain(ctx2)
  assert.equal(ft.sleeps.length, 1, '轮二第一条必须等待跨轮最小间隔（旧实现 i>0 才等，轮轮首条免检）')
  assert.ok(ft.sleeps[0] >= 700)
})

test('shaping 参数构造校验：NaN/倒挂直接抛错（review A4#7 附带）', () => {
  assert.throws(() => createDispatcher({ sender: () => {}, shaping: { minGapMs: NaN } }), /有限数/)
  assert.throws(() => createDispatcher({ sender: () => {}, shaping: { minGapMs: 5000, maxGapMs: 1000 } }), /minGapMs 不得大于/)
})
