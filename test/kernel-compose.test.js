// 洋葱管道组合器：执行顺序、double-next 熔断、abort 短路、同步/异步异常包装。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compose, PipelineError } from '../src/kernel/compose.js'
import { createContext } from '../src/kernel/context.js'

function envelope(over = {}) {
  return {
    id: 'evt-1',
    protocol: 'onebot:v11',
    type: 'message',
    timestamp: Date.now(),
    selfId: 'bot-1',
    sender: { userId: 'u-1', nickname: '群友' },
    segments: [{ type: 'text', data: { text: 'hello' } }],
    rawText: 'hello',
    rawPayload: {},
    ...over,
  }
}

function fakeCtx(aborted = false) {
  const controller = new AbortController()
  if (aborted) controller.abort('pre-aborted')
  return { signal: controller.signal, abort: (r) => controller.abort(r) }
}

test('洋葱顺序：逐层进入、逆层回溯、底部衔接外部 tail', async () => {
  const log = []
  const layer = (name) => async (ctx, next) => {
    log.push(`${name}>`)
    await next()
    log.push(`<${name}`)
  }
  const pipeline = compose([layer('a'), layer('b')])
  await pipeline(fakeCtx(), async () => {
    log.push('tail')
  })
  assert.deepEqual(log, ['a>', 'b>', 'tail', '<b', '<a'])
})

test('拓扑冻结：compose 之后改原数组不影响已组装管道', async () => {
  const ran = []
  const list = [async (ctx, next) => { ran.push('first'); await next() }]
  const pipeline = compose(list)
  list.push(async (ctx, next) => { ran.push('sneaked'); await next() })
  await pipeline(fakeCtx())
  assert.deepEqual(ran, ['first'])
})

test('对抗：同一层重复调用 next() 触发 double-next 熔断', async () => {
  const innerCalls = []
  const bad = async (ctx, next) => {
    await next()
    await next() // 第二次重入必须被游标拦下
  }
  const inner = async (ctx, next) => {
    innerCalls.push(1)
    await next()
  }
  const err = await compose([bad, inner])(fakeCtx()).then(() => null, (e) => e)
  assert.ok(err instanceof PipelineError, `期望 PipelineError，实际 ${err}`)
  // 下游错误会沿调用链逐层包装：index 1 拦下重入，index 0 记录传播点
  assert.equal(err.index, 0)
  assert.ok(err.originalCause instanceof PipelineError)
  assert.equal(err.originalCause.index, 1)
  assert.match(err.originalCause.message, /called next\(\) multiple times/)
  assert.match(err.stack, /Caused by:/)
  assert.equal(innerCalls.length, 1, '内层只应被执行一次')
})

test('对抗：中途 abort 后下游中间件短路不执行', async () => {
  const ran = []
  const pipeline = compose([
    async (ctx, next) => {
      ran.push('a')
      ctx.abort('superseded')
      await next()
    },
    async (ctx, next) => {
      ran.push('b')
      await next()
    },
  ])
  await pipeline(createContext(envelope(), 'onebot-driver'))
  assert.deepEqual(ran, ['a'], 'b 不应执行')
})

test('abort 短路：进入管道前就已被 abort，全部中间件跳过且正常 resolve', async () => {
  const ctx = createContext(envelope(), 'onebot-driver')
  ctx.abort('stale-turn')
  let ran = false
  let tailRan = false
  await compose([async () => { ran = true }])(ctx, async () => { tailRan = true })
  assert.equal(ran, false)
  assert.equal(tailRan, false)
})

test('对抗：中间件同步 throw 包装为 PipelineError 并保留 originalCause 链', async () => {
  const boom = new Error('boom-sync')
  const err = await compose([() => { throw boom }])(fakeCtx()).then(() => null, (e) => e)
  assert.ok(err instanceof PipelineError)
  assert.equal(err.index, 0)
  assert.match(err.message, /Synchronous exception thrown by middleware at index 0/)
  assert.equal(err.originalCause, boom)
  assert.equal(err.cause, boom)
  assert.match(err.stack, /Caused by: [\s\S]*boom-sync/)
})

test('异步 reject 同样包装为 PipelineError', async () => {
  const boom = new Error('down-async')
  const err = await compose([async () => { throw boom }])(fakeCtx()).then(() => null, (e) => e)
  assert.ok(err instanceof PipelineError)
  assert.equal(err.index, 0)
  assert.match(err.message, /Unhandled exception during pipeline execution at index 0/)
  assert.equal(err.originalCause, boom)
})

test('空管道：直接 resolve；给了 tail 则恰好执行一次', async () => {
  await compose([])(fakeCtx()) // 不抛
  let tailCalls = 0
  await compose([])(fakeCtx(), async () => { tailCalls++ })
  assert.equal(tailCalls, 1)
})

test('PipelineError 冻结数组场景：compose(Object.freeze([...])) 可正常组装', async () => {
  const frozen = Object.freeze([async (ctx, next) => { await next() }])
  await compose(frozen)(fakeCtx())
})
