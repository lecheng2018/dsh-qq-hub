// Tracing & Metrics 中间件单元测试（RFC-0001 §2 Middleware 1 / §1.1 P8 / US-004）。
//
// 全程假时钟 + stub 日志出口，不碰真实 hub / 文件系统。覆盖：
//   - 正常链路：total / mw0（本层簿记）/ mw1（下游整段）分桶与单行 debug 输出；
//   - 抛错：err 计数 + 出错层级归段 + **原样 rethrow**（PipelineError cause 链不破）；
//   - abort：记 aborted 标记、不计错误，打点照常完整输出；
//   - 对抗①：嵌套中间件耗时分桶（外层 total ≥ 内层各段之和）；
//   - 对抗②：出错轮的 trace 行仍完整输出，且 unwrap 到根因与 host 日志文案一致；
//   - traceId/spanId 一律取 ctx.meta，不另造；裸 ctx 与日志出口炸都不影响管道；
//   - 复刻 US-003 装配位（透传占位 → 真 tracing）端到端形态。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compose, PipelineError } from '../src/kernel/compose.js'
import { createContext } from '../src/kernel/context.js'
import {
  createTracingMiddleware,
  formatTraceLine,
  getTrace,
  traceStage,
  TRACE_KEY,
} from '../src/kernel/mw-tracing.js'
import {
  createLegacyHubFallback,
  legacyEventToEnvelope,
  unwrapPipelineError,
  LEGACY_DRIVER_ID,
} from '../src/kernel/legacy-fallback.js'

// ---- 桩件 ----

function envelope(over = {}) {
  return {
    id: 'evt-1',
    protocol: 'onebot:v11',
    type: 'message',
    timestamp: Date.now(),
    selfId: 'bot-1',
    sender: { userId: 'u-1', nickname: '群友' },
    segments: [{ type: 'text', data: { text: '吃了么' } }],
    rawText: '吃了么',
    rawPayload: { post_type: 'message', message_id: 1 },
    ...over,
  }
}

/** 手动时钟：只有测试自己 advance 才走，用来钉死「下游段 = next() 内部真实跨度」。 */
function manualClock(start = 0) {
  let t = start
  return { now: () => t, advance: (d) => { t += d } }
}

/** 步进时钟：每取一次时间戳固定 +step，用来证明本层簿记开销也进了桶。 */
function steppingClock(step = 1) {
  let t = 0
  return { now: () => { t += step; return t } }
}

/** core/logger.js child 形态的桩：记录级别与文本，便于断言「只用 debug」。 */
function spyLog() {
  const lines = []
  const levels = []
  return {
    lines,
    levels,
    debug: (...args) => { levels.push('debug'); lines.push(args.join(' ')) },
    info: (...args) => { levels.push('info'); lines.push(args.join(' ')) },
    warn: (...args) => { levels.push('warn'); lines.push(args.join(' ')) },
    error: (...args) => { levels.push('error'); lines.push(args.join(' ')) },
  }
}

function ctxWithTrace(parentTraceId = 'a1b2c3d4-0000-0000-0000-00000000000e') {
  return createContext(envelope(), LEGACY_DRIVER_ID, parentTraceId)
}

// ---------- 正常链路 ----------

test('正常链路：total/mw0/mw1 分桶正确，单行 debug 输出，traceId/spanId 取 ctx.meta 不另造', async () => {
  const clock = manualClock(1000)
  const log = spyLog()
  const tracing = createTracingMiddleware({ log, now: clock.now })
  const ctx = ctxWithTrace()
  const inner = async (c, next) => {
    assert.equal(getTrace(c), traceOf(ctx), '下游中间件必须能从 ctx.state 取到同一份记录')
    clock.advance(10) // 模拟下游业务耗时 10ms
    await next()
  }
  const traceOf = (c) => c.state.get(TRACE_KEY)

  await compose([tracing, inner])(ctx)

  const trace = getTrace(ctx)
  assert.equal(trace.traceId, ctx.meta.traceId, 'traceId 唯一来源是 createContext 的 meta')
  assert.equal(trace.traceId, 'a1b2c3d4-0000-0000-0000-00000000000e', 'parentTraceId 透传：全链复用同一条 trace')
  assert.equal(trace.spanId, ctx.meta.spanId)
  assert.equal(trace.totalMs, 10)
  assert.equal(trace.downstreamMs, 10, 'mw1 = 下游整段跨度')
  assert.equal(trace.selfMs, 0, 'mw0 = 本层簿记开销，假时钟不推进则为 0')
  assert.equal(trace.errors, 0)
  assert.equal(trace.errorLayer, -1)
  assert.equal(trace.aborted, false)
  assert.deepEqual(trace.segments, [
    { index: 0, name: 'tracing', ms: 0 },
    { index: 1, name: 'downstream', ms: 10 },
  ], '分段按 (index, 名称) 记账')
  assert.equal(log.levels.filter((l) => l !== 'debug').length, 0, '只允许 debug 级')
  assert.deepEqual(log.lines, [`trace a1b2c3d4 total=10ms mw0=0ms mw1=10ms err=0`])
})

test('计时源：每取一次时间戳都进桶，步进时钟下 total = mw0 + mw1', async () => {
  const log = spyLog()
  const tracing = createTracingMiddleware({ log, now: steppingClock(1).now })
  const ctx = ctxWithTrace()
  await compose([tracing, async (c, next) => { await next() }])(ctx)
  const trace = getTrace(ctx)
  // 时钟共被取 4 次（进入/下游前/下游后/回溯），相邻差恒 1ms
  assert.equal(trace.downstreamMs, 1)
  assert.equal(trace.selfMs, 2)
  assert.equal(trace.totalMs, 3)
  assert.equal(trace.totalMs, trace.selfMs + trace.downstreamMs, '分桶必须无损耗地加起来等于 total')
  assert.match(log.lines[0], /total=3ms mw0=2ms mw1=1ms err=0/)
})

test('缺省计时源走 performance.now：不注入也能量出非负耗时', async () => {
  const log = spyLog()
  const tracing = createTracingMiddleware({ log }) // 不注入 now
  const ctx = ctxWithTrace()
  await compose([tracing, async (c, next) => { await new Promise((r) => setImmediate(r)); await next() }])(ctx)
  const trace = getTrace(ctx)
  assert.equal(typeof trace.totalMs, 'number')
  assert.ok(trace.totalMs >= 0 && Number.isFinite(trace.totalMs), `total=${trace.totalMs} 应为有限非负数`)
  assert.ok(trace.totalMs >= trace.downstreamMs)
})

// ---------- 抛错：计数后原样上抛 ----------

test('抛错：mw 原样 rethrow 同一个错误对象（不包装不吞），err 计数 +1 且打点仍完整输出', async () => {
  const clock = manualClock()
  const log = spyLog()
  const tracing = createTracingMiddleware({ log, now: clock.now })
  const ctx = ctxWithTrace()
  const boom = new Error('QQ 网关断了')

  const caught = await tracing(ctx, async () => {
    clock.advance(6)
    throw boom
  }).catch((e) => e)

  assert.equal(caught, boom, '回溯阶段必须把原错误对象继续上抛')
  const trace = getTrace(ctx)
  assert.equal(trace.errors, 1, '异常在回溯阶段计数')
  assert.equal(trace.errorLayer, -1, '非 PipelineError 无层级信息时不臆造 index')
  assert.match(trace.errorMessage, /QQ 网关断了/)
  assert.equal(trace.downstreamMs, 6, '出错轮的耗时照旧量出来')
  assert.deepEqual(log.lines, [`trace a1b2c3d4 total=6ms mw0=0ms mw1=6ms err=1 msg='QQ 网关断了'`],
    '错误也必须留下完整 breakdown，否则答不了「错在哪一步」')
})

test('抛错：compose 包装链不破，外层捕获的是 PipelineError 且能 unwrap 到根因', async () => {
  const log = spyLog()
  const tracing = createTracingMiddleware({ log, now: manualClock().now })
  const ctx = ctxWithTrace()
  const boom = new Error('LLM 超时')
  const pipeline = compose([
    tracing,
    async (c, next) => { await next() },
    async () => { throw boom },
  ])

  const err = await pipeline(ctx).catch((e) => e)
  assert.ok(err instanceof PipelineError, 'host 侧拿到的是 PipelineError')
  assert.equal(err.index, 0, '最外层包装记在 tracing 这一层')
  assert.equal(unwrapPipelineError(err), boom, '沿 originalCause 剥到根因仍是原错误')
  const trace = getTrace(ctx)
  assert.equal(trace.errors, 1, '一轮只计一次，不被逐层包装重复计数')
  assert.match(log.lines[0], /err=1/)
})

test('出错层级归段：更深层抛错时报出最内层 index（at=mw2）', async () => {
  const log = spyLog()
  const tracing = createTracingMiddleware({ log, now: manualClock().now })
  const ctx = ctxWithTrace()
  const pipeline = compose([
    tracing,
    async (c, next) => { await next() },
    async () => { throw new Error('分条发送失败') },
  ])
  await pipeline(ctx).catch(() => {})
  const trace = getTrace(ctx)
  assert.equal(trace.errorLayer, 2, '归段到真正出错的层级，而不是回溯途中的层级')
  assert.match(log.lines[0], /err=1 at=mw2 msg='分条发送失败'/)
})

// ---------- abort：标记而非错误 ----------

test('abort：记 aborted 标记不计错误，下游短路但打点照常输出', async () => {
  const clock = manualClock()
  const log = spyLog()
  const tracing = createTracingMiddleware({ log, now: clock.now })
  const ctx = ctxWithTrace()
  let deepRan = 0
  const pipeline = compose([
    tracing,
    async (c) => { c.abort('用户补充消息，抢占上一轮'); clock.advance(3) },
    async () => { deepRan++ },
  ])

  await pipeline(ctx) // compose 短路后正常 resolve，不该有错误
  const trace = getTrace(ctx)
  assert.equal(deepRan, 0, 'abort 后下游不执行')
  assert.equal(trace.aborted, true)
  assert.equal(trace.errors, 0, '主动中断不是错误')
  assert.equal(trace.downstreamMs, 3)
  assert.match(log.lines[0], /total=3ms mw0=0ms mw1=3ms err=0 aborted=1$/)
  assert.equal(log.levels.every((l) => l === 'debug'), true)
})

test('abort：进入管道前就已被 abort —— compose 在 dispatch(0) 就短路，tracing 根本不执行（零打点、零错误）', async () => {
  // 这是 compose 的既有契约（US-001 已钉），不是打点漏记：预 abort 的请求压根没进管道。
  // 记在这里，免得后续 story 误以为「零输出 = tracing 有 bug」。
  const log = spyLog()
  const tracing = createTracingMiddleware({ log, now: manualClock().now })
  const ctx = ctxWithTrace()
  ctx.abort('预中断')
  let deepRan = 0
  await compose([tracing, async () => { deepRan++; throw new Error('不该执行') }])(ctx)
  assert.equal(deepRan, 0)
  assert.deepEqual(log.lines, [], '没进管道就没有打点')
  assert.equal(getTrace(ctx), undefined, '未执行的本层不该在 ctx.state 留半份记录')
})

// ---------- 对抗①：嵌套分桶 ----------

test('对抗：嵌套中间件耗时分桶正确（外层 total ≥ 内层各段之和）', async () => {
  const clock = manualClock()
  const log = spyLog()
  const tracing = createTracingMiddleware({ log, now: clock.now })
  const ctx = ctxWithTrace()
  const pipeline = compose([
    tracing,
    async (c, next) => {
      await traceStage(c, 'rate-limit', async () => { clock.advance(4) })
      await next()
    },
    async (c, next) => {
      await traceStage(c, 'legacy-hub', async () => { clock.advance(7) })
      await next()
    },
  ])

  await pipeline(ctx)
  const trace = getTrace(ctx)
  assert.deepEqual(trace.stages, [
    { name: 'rate-limit', ms: 4 },
    { name: 'legacy-hub', ms: 7 },
  ], '内层自报段按发生顺序入表')
  const innerSum = trace.stages.reduce((a, s) => a + s.ms, 0)
  assert.ok(trace.totalMs >= innerSum, `外层 ${trace.totalMs}ms 必须 ≥ 内层之和 ${innerSum}ms`)
  assert.equal(trace.downstreamMs, innerSum, '下游整段应等于嵌套层合计')
  assert.equal(trace.totalMs, trace.selfMs + innerSum)
  assert.match(log.lines[0], /rate-limit=4ms legacy-hub=7ms err=0/)
})

test('内层自报段出错：不计错误（计数归回溯层），但段耗时仍入账', async () => {
  const clock = manualClock()
  const log = spyLog()
  const tracing = createTracingMiddleware({ log, now: clock.now })
  const ctx = ctxWithTrace()
  const boom = new Error('记忆写入失败')
  await compose([
    tracing,
    async (c, next) => {
      await traceStage(c, 'memory', async () => { clock.advance(2); throw boom })
    },
  ])(ctx).catch((e) => assert.equal(unwrapPipelineError(e), boom, '错误链仍完整上抛'))
  const trace = getTrace(ctx)
  assert.deepEqual(trace.stages, [{ name: 'memory', ms: 2 }], 'finally 记账：失败阶段也要能看出耗时')
  assert.equal(trace.errors, 1, '由最外层回溯计数，只算一次')
  assert.equal(trace.errorLayer, 1, '出错层级是被自报段的那个中间件')
  assert.equal(trace.errorMessage, '记忆写入失败', 'msg 取根因文本，不是 compose 的包装文案')
  assert.match(log.lines[0], /memory=2ms err=1 at=mw1 msg='记忆写入失败'/)
})

test('未装 tracing 时 traceStage 退化为直执行，绝不因取不到记录而炸链', async () => {
  let ran = 0
  const out = await traceStage({ meta: {} }, 'ghost', async () => { ran++; return 'ok' })
  assert.equal(ran, 1)
  assert.equal(out, 'ok')
  assert.equal(getTrace({}), undefined)
})

// ---------- 健壮性：裸 ctx 与日志出口异常 ----------

test('裸 ctx（无 meta / 无 state）：id 走占位符不臆造，打点与错误传播都不受影响', async () => {
  const log = spyLog()
  const tracing = createTracingMiddleware({ log, now: manualClock().now })
  const bare = { signal: new AbortController().signal } // compose 认识的裸 ctx
  const boom = new Error('没上下文也要抛')
  const err = await tracing(bare, async () => { throw boom }).catch((e) => e)
  assert.equal(err, boom)
  assert.equal(getTrace(bare), undefined, '无 state 时不硬挂记录，也不因此报错')
  assert.match(log.lines[0], /^trace - total=/, '缺 meta 用占位符，绝不在中间件里另造 traceId')
  assert.match(log.lines[0], /err=1/)
})

test('日志出口自身抛错：就地吃掉，不影响管道成功与错误上抛', async () => {
  const bad = { debug: () => { throw new Error('日志盘只读') }, info: () => { throw new Error('不该被调') } }
  const tracing = createTracingMiddleware({ log: bad, now: manualClock().now })
  const ctx = ctxWithTrace()
  await tracing(ctx, async () => {}) // 不该抛
  const boom = new Error('下游炸了')
  const err = await tracing(ctx, async () => { throw boom }).catch((e) => e)
  assert.equal(err, boom, '打点失败不能顺手吞掉业务错误')
})

test('生产环境同样只出 debug：全程不碰 info/warn/error（core/logger.js 的 debug 不进宿主控制台）', async () => {
  const log = spyLog()
  const tracing = createTracingMiddleware({ log, now: manualClock().now })
  const ok = ctxWithTrace('11111111-0000-0000-0000-000000000001')
  await compose([tracing, async (c, next) => { await next() }])(ok)
  const bad = ctxWithTrace('22222222-0000-0000-0000-000000000002')
  await compose([tracing, async () => { throw new Error('boom') }])(bad).catch(() => {})
  const ab = ctxWithTrace('33333333-0000-0000-0000-000000000003')
  await compose([tracing, async (c) => { c.abort('x') }])(ab)
  assert.deepEqual(log.levels, ['debug', 'debug', 'debug'])
  assert.equal(log.lines.length, 3, '三轮请求各留一行')
})

test('formatTraceLine：数字保留三位、异常字符不进日志行（面板与 grep 都吃这一行）', () => {
  const clock = manualClock()
  const log = spyLog()
  const tracing = createTracingMiddleware({ log, now: clock.now })
  const ctx = ctxWithTrace()
  return compose([
    tracing,
    async (c, next) => {
      clock.advance(0.1234)
      await traceStage(c, 'bad name\n[二]', async () => { clock.advance(1) })
      await next()
    },
  ])(ctx).then(() => {
    const line = log.lines[0]
    assert.ok(!line.includes('\n'), '打点必须单行')
    assert.match(line, /total=1\.123ms/)
    assert.match(line, /bad_name__二_=1ms/, '阶段名做字符收敛（中文保留、空白与方括号折下划线），不破坏 key=value')
    const again = formatTraceLine(getTrace(ctx))
    assert.equal(again, line, '同一记录渲染结果稳定')
  })
})

// ---------- US-003 装配位复刻 ----------

test('复刻装配位：compose([tracing, legacy 终端]) 事件照旧原样送达旧入口，并留下一行 trace', async () => {
  const clock = manualClock()
  const log = spyLog()
  const seen = []
  const stubHub = { onMessage: async (e) => { seen.push(e); clock.advance(5) }, onPoke: async () => {} }
  const pipeline = compose([
    createTracingMiddleware({ log, now: clock.now }), // 替换掉 US-003 的透传占位
    createLegacyHubFallback(stubHub),
  ])
  const ev = { post_type: 'message', message_id: 987, message: [{ type: 'text', data: { text: '在吗' } }] }
  const ctx = createContext(legacyEventToEnvelope(ev), LEGACY_DRIVER_ID)

  await pipeline(ctx)
  assert.deepEqual(seen, [ev], '终端仍把原事件引用送达旧入口')
  const trace = getTrace(ctx)
  assert.equal(trace.errors, 0)
  assert.equal(trace.downstreamMs, 5, 'mw1 即遗留终端耗时（Phase 0 只有这一层）')
  assert.equal(trace.traceId, ctx.meta.traceId)
  assert.match(log.lines[0], /^trace [0-9a-f-]{8} total=5ms mw0=0ms mw1=5ms err=0$/)
})

test('复刻装配位（真实时钟）：旧入口报错时 host sink 仍能 unwrap 出根因文案', async () => {
  const log = spyLog()
  const boom = new Error('处理消息出错')
  const stubHub = { onMessage: async () => { throw boom }, onPoke: async () => {} }
  const pipeline = compose([
    createTracingMiddleware({ log }), // 用缺省 performance.now
    createLegacyHubFallback(stubHub),
  ])
  const ctx = createContext(legacyEventToEnvelope({ post_type: 'message', message_id: 1, message: [] }), LEGACY_DRIVER_ID)
  const err = await pipeline(ctx).catch((e) => e)
  assert.ok(err instanceof PipelineError)
  assert.equal(unwrapPipelineError(err), boom, '开启态错误日志文案与旧路径逐字一致的前提')
  assert.match(log.lines[0], /err=1 at=mw1/)
})
