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
  // 下游错误会沿调用链逐层包装；review A1#4 修复后 originalCause.index 指向
  // **违规调用者（第 0 层）**而非被请求的下游——「谁重复调 next 就报谁」
  assert.equal(err.index, 0)
  assert.ok(err.originalCause instanceof PipelineError)
  assert.equal(err.originalCause.index, 0)
  assert.match(err.originalCause.message, /called next\(\) multiple times/)
  assert.match(err.stack, /Caused by:/)
  assert.equal(innerCalls.length, 1, '内层只应被执行一次')
})

test('abort 于第 0 层派发 next 时：第 1 层两级都不进，第 0 层 bubble 照常收尾', async () => {
  // §2.2 冒泡态语义：abort 后绝不「重进」或「新晋」任何中间件，只让在飞调用 unwind。
  // 第 1 层此前未被派发 → 两级都不进；本层 bubble 自然也无从谈起。
  const ran = []
  const pipeline = compose([
    async (ctx, next) => {
      ran.push('a>')
      ctx.abort('superseded')
      await next()
      ran.push('<a')
    },
    async (ctx, next) => {
      ran.push('b>')
      await next()
      ran.push('<b')
    },
  ])
  await pipeline(createContext(envelope(), 'onebot-driver'))
  assert.deepEqual(ran, ['a>', '<a'], 'a 的 bubble 必须执行；b 两级都不进')
})

test('abort 发生在第 1 层：已派发的第 0/1 层 bubble 必须执行，第 2 层两级都不进', async () => {
  const ran = []
  const layer = (name, hook) => async (ctx, next) => {
    ran.push(`${name}>`)
    if (hook) hook(ctx)
    await next()
    ran.push(`<${name}`)
  }
  const pipeline = compose([
    layer('L0'),
    layer('L1', (ctx) => ctx.abort('superseded')), // abort 于第 1 层，随后照常 next()
    layer('L2'),
    layer('L3'),
  ])
  await pipeline(createContext(envelope(), 'onebot-driver'))
  // L1 的 next()（= 派发 L2）在 abort 后就地 resolve：L2/L3 两级都不进；
  // L1、L0 是「已派发中间件」，bubble 必须回溯收尾；任何层都不得二次进入。
  assert.deepEqual(ran, ['L0>', 'L1>', '<L1', '<L0'], `实际执行序：${ran}`)
})

test('abort 发生在第 2 层：第 1 层（在飞派发者）bubble 必须执行，第 3 层两级都不进', async () => {
  const ran = []
  const layer = (name, hook) => async (ctx, next) => {
    ran.push(`${name}>`)
    if (hook) hook(ctx)
    await next()
    ran.push(`<${name}`)
  }
  const pipeline = compose([
    layer('L0'),
    layer('L1'),
    layer('L2', (ctx) => ctx.abort('superseded')),
    layer('L3'),
  ])
  await pipeline(createContext(envelope(), 'onebot-driver'))
  // L2 abort 后其 next()（= 派发 L3）就地 resolve：L3 两级都不进；
  // L2 的 bubble 立即收尾； unwind 到 L1——它 await 的那笔 dispatch(2) 也 resolve，
  // L1 bubble 执行；但 L1 **绝不重入**（不二次运行 entry 段，副作用不放大）。
  assert.deepEqual(ran, ['L0>', 'L1>', 'L2>', '<L2', '<L1', '<L0'], `实际执行序：${ran}`)
})

test('abort 时点在飞 tail：tail 调用是边界内的在飞派发，同样只 unwind 不重入', async () => {
  // compose(mws)(ctx, tail)：abort 发生在 middleware 内部后，tail 若在飞则就地 resolve。
  const ran = []
  const ctx = createContext(envelope(), 'onebot-driver')
  const pipeline = compose([
    async (c, next) => {
      ran.push('mw>')
      await next()
      ran.push('<mw')
    },
  ])
  const p = pipeline(ctx, async () => {
    ran.push('tail>')
    ctx.abort('superseded-mid-tail')
    await new Promise((r) => setImmediate(r))
    ran.push('<tail')
  })
  await p
  assert.deepEqual(ran, ['mw>', 'tail>', '<tail', '<mw'])
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


// ===== 2026-11-07 review 修复回归（A1#2/#3 + 契约钉死）=====

test('对抗：abort 短路后同层第二次 next() 仍被熔断（review A1#3：旧游标方案会放行）', async () => {
  const controller = new AbortController()
  const ctx = { signal: controller.signal }
  let innerCount = 0
  const bad = async (c, next) => {
    controller.abort()
    await next()
    await next() // 第二次调用必须 reject——abort 短路同样消耗资格
  }
  const inner = async () => { innerCount += 1 }
  const err = await compose([bad, inner])(ctx).then(() => null, (e) => e)
  assert.ok(err instanceof PipelineError, `期望 PipelineError，实际 ${err}`)
  assert.equal(innerCount, 0)
  let root = err
  while (root.originalCause instanceof PipelineError) root = root.originalCause
  assert.match(root.message, /called next\(\) multiple times/)
  assert.equal(root.index, 0)
})

test('监听器卫生：正常完成/异常完成后卸载 abort 监听；预 abort 不注册（review A1#2）', async () => {
  let added = 0
  let removed = 0
  const mkSignal = (aborted = false) => ({
    aborted,
    addEventListener: (ev, fn, opts) => { added += 1 },
    removeEventListener: (ev, fn) => { removed += 1 },
  })
  await compose([async (_, next) => next()])(fakeCtxWith(mkSignal()))
  assert.deepEqual([added, removed], [1, 1], '正常完成：注册一次卸载一次')
  added = removed = 0
  const err = await compose([async () => { throw new Error('boom') }])(fakeCtxWith(mkSignal())).then(() => null, (e) => e)
  assert.ok(err instanceof PipelineError)
  assert.deepEqual([added, removed], [1, 1], '异常完成同样卸载')
  added = removed = 0
  let reached = false
  await compose([async () => { reached = true }])(fakeCtxWith(mkSignal(true)))
  assert.equal(reached, false, '预 abort：第 0 层都不进')
  assert.deepEqual([added, removed], [0, 0], '预 abort：不注册监听')
})

function fakeCtxWith(signal) {
  return { signal }
}

test('契约钉死：abort 不强制作废在飞 next()——管道完成=已启动中间件真实结束（review A1#1 拍板）', async () => {
  const controller = new AbortController()
  const order = []
  const outer = async (c, next) => {
    await next()
    order.push('outer:bubble')
  }
  let hangRelease
  const inner = () => new Promise((r) => { hangRelease = r; order.push('inner:entry') })
  const p = compose([outer, inner])({ signal: controller.signal })
  await Promise.resolve()
  controller.abort()
  await Promise.resolve()
  order.push('after-abort')
  let done = false
  p.then(() => { done = true })
  await new Promise((r) => setImmediate(r))
  assert.equal(done, false, 'abort 后管道不得提前完成（在飞内层仍挂起）')
  hangRelease()
  await p
  assert.equal(done, true)
  assert.deepEqual(order, ['inner:entry', 'after-abort', 'outer:bubble'], '内层真实 settle 后外层 bubble 收尾（§2.2 unwind 实况）')
})
