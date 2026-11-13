import test from 'node:test'
import assert from 'node:assert/strict'
import { createTracingMiddleware, formatTraceLine, getTrace, traceStage } from '../src/kernel/mw-tracing.js'

function manualClock(start = 0) {
  let time = start
  return { now: () => time, advance: (ms) => { time += ms } }
}

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

function context(traceId = 'a1b2c3d4-0000') {
  const controller = new AbortController()
  return {
    meta: { traceId, spanId: 'span-1' },
    state: new Map(),
    signal: controller.signal,
    abort: () => controller.abort(),
  }
}

test('当前 tracing：耗时、阶段和会话标识进入单行 debug', async () => {
  const clock = manualClock(1000)
  const log = spyLog()
  const tracing = createTracingMiddleware({ log, now: clock.now })
  const ctx = context()
  await tracing(ctx, async () => {
    clock.advance(2)
    await traceStage(ctx, 'memory', async () => { clock.advance(3) })
  })
  const trace = getTrace(ctx)
  assert.equal(trace.traceId, ctx.meta.traceId)
  assert.equal(trace.spanId, 'span-1')
  assert.equal(trace.totalMs, 5)
  assert.equal(trace.downstreamMs, 5)
  assert.deepEqual(trace.stages, [{ name: 'memory', ms: 3 }])
  assert.match(log.lines[0], /^trace a1b2c3d4 total=5ms .*memory=3ms err=0$/)
  assert.deepEqual(log.levels, ['debug'])
})

test('当前 tracing：下游错误原样抛出，记录保留根因', async () => {
  const log = spyLog()
  const tracing = createTracingMiddleware({ log, now: manualClock().now })
  const ctx = context()
  const boom = new Error('记忆写入失败')
  const actual = await tracing(ctx, async () => { throw boom }).catch((error) => error)
  assert.equal(actual, boom)
  const trace = getTrace(ctx)
  assert.equal(trace.errors, 1)
  assert.equal(trace.errorMessage, '记忆写入失败')
  assert.match(log.lines[0], /err=1 msg='记忆写入失败'/)
})

test('当前 tracing：abort 是正常中断，不计错误', async () => {
  const log = spyLog()
  const tracing = createTracingMiddleware({ log, now: manualClock().now })
  const ctx = context()
  await tracing(ctx, async () => { ctx.abort() })
  const trace = getTrace(ctx)
  assert.equal(trace.aborted, true)
  assert.equal(trace.errors, 0)
  assert.match(log.lines[0], /aborted=1/)
})

test('未装 tracing 时 traceStage 退化为直执行', async () => {
  let runs = 0
  const result = await traceStage({ meta: {} }, 'ghost', async () => { runs++; return 'ok' })
  assert.equal(runs, 1)
  assert.equal(result, 'ok')
  assert.equal(getTrace({}), undefined)
})

test('裸 ctx 不臆造标识，日志出口失败也不影响业务', async () => {
  const lines = []
  const tracing = createTracingMiddleware({ log: { debug: (line) => lines.push(line) }, now: manualClock().now })
  const bare = { signal: new AbortController().signal }
  const boom = new Error('下游炸了')
  assert.equal(await tracing(bare, async () => { throw boom }).catch((error) => error), boom)
  assert.equal(getTrace(bare), undefined)
  assert.match(lines[0], /^trace - total=.*err=1/)

  const badLog = { debug: () => { throw new Error('日志失败') } }
  const resilient = createTracingMiddleware({ log: badLog, now: manualClock().now })
  await resilient(context(), async () => {})
  assert.equal(await resilient(context(), async () => { throw boom }).catch((error) => error), boom)
})

test('formatTraceLine：三位小数、阶段名收敛且结果稳定', async () => {
  const clock = manualClock()
  const log = spyLog()
  const tracing = createTracingMiddleware({ log, now: clock.now })
  const ctx = context()
  await tracing(ctx, async () => {
    clock.advance(0.1234)
    await traceStage(ctx, 'bad name\n[二]', async () => { clock.advance(1) })
  })
  const line = log.lines[0]
  assert.ok(!line.includes('\n'))
  assert.match(line, /total=1\.123ms/)
  assert.match(line, /bad_name__二_=1ms/)
  assert.equal(formatTraceLine(getTrace(ctx)), line)
})
