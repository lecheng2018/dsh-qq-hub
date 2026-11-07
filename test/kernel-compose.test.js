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


// ===== 2026-11-07 gemini38《onion-real-issues》缺陷1 拒绝项回归锁（US-003）=====
//
// 指控：M0→M1→M2、M2 在飞挂起时外部 abort（boundary=2），M1 二次调 next() 会命中
// 检查点2（`context.signal?.aborted && abortBoundary !== null`）被**就地 resolve**，
// 于是不等在飞 M2 真实结束就提前 bubble（对方定级 P0「时序倒置」）。
// 对方补丁：检查点2 追加 `&& currentIndex > abortBoundary`，让边界内的重派「继续派发」。
//
// 裁决：**不成立**（workspace `reports/2026-11-07-gemini38-real-issues-复核裁决.md` §缺陷1）。
// 实测二次 next() 被每层 nextCalled 资格位（compose.js:137-144，P5 review A1#3 修复）熔断成
// **reject**，且管道完成仍必须等 M2 真实 settle；补丁在 A1/A2/A3 三时序下与现实现**逐位一致**
// ——`currentIndex <= abortBoundary` 的 dispatch 必先被检查点1全局游标（:93）或资格位（:139）
// 拦掉，新增子句永远轮不到改结论 ⇒ unreachable-equivalent（空改动）。
//
// ⚠️ 勿采纳该补丁：它不治病（病本来就没有），只是把检查点2从「abort 后一律不进入任何
// 中间件」的无条件承诺改成依赖 abortBoundary 与调用序的条件分支——§2.2 的硬承诺
// （compose.js:9-14 JSDoc「管道返回 = 已启动中间件真实结束」）随之失去可推理的单一形态。
//
// 下面三条锁钉的是「熔断链拆掉时立刻变红」，不是「区分补丁与现实现」（两者本不可区分）。

test('gemini38 缺陷1 拒绝项锁①（A3/A4b）：闭包泄漏重派 nextStep 一律 reject，在飞 M2 真实 settle 前管道不得完成', async () => {
  const controller = new AbortController()
  const ctx = { signal: controller.signal }
  const ev = []
  let m2Run = 0
  let hangRelease
  const hang = new Promise((r) => { hangRelease = r })
  // 把第 1 层的 nextStep 泄漏到「管道外」持有者（模拟被偷走的闭包 / 存进 globalThis 的回调）
  const leaked = { next: null }
  let pipelineDone = false

  const M0 = async (c, next) => { ev.push('M0:enter'); await next(); ev.push('M0:bubble') }
  const M1 = async (c, next) => {
    leaked.next = next                       // ← 闭包泄漏点
    ev.push('M1:enter')
    const first = next()                     // dispatch(2)：在飞 M2 挂起
    await new Promise((r) => setImmediate(r))
    controller.abort('external-stop')        // inFlight={0,1,2} ⇒ abortBoundary=2
    ev.push('ABORT')
    // A3 时序：abort 后同层二次 next()（对方断言这里「静默 resolve → 越飞层提前 bubble」）
    ev.push('inflight-2nd-next:' + await next().then(
      () => 'RESOLVED(指控成真!)',
      (e) => `REJECTED(${e.name}:idx=${e.index})`,
    ))
    await first                              // 仍要等在飞 M2 真实结束
    ev.push('M1:bubble')
  }
  const M2 = async () => {
    m2Run += 1
    ev.push(`M2:enter#${m2Run}`)
    await hang                               // 挂起：LLM/IO 在飞
    ev.push(`M2:settled#${m2Run}`)
  }

  const p = compose([M0, M1, M2])(ctx).then(
    () => { pipelineDone = true; ev.push('PIPELINE:resolved') },
    (e) => { pipelineDone = true; ev.push(`PIPELINE:rejected(${e.name})`) },
  )

  await new Promise((r) => setTimeout(r, 20))
  assert.equal(pipelineDone, false, 'M2 仍挂起时管道不得完成（§2.2 硬承诺）')
  assert.equal(m2Run, 1, '在飞层不得被重派第二次')

  // A4b 时序：从管道外拿泄漏闭包再调一次（对方补丁宣称能「放行 dispatch(2) 重进在飞 M2」的最强攻势）
  const outside = await leaked.next().then(
    () => 'RESOLVED(重派放行!)',
    (e) => `REJECTED(${e.name}:idx=${e.index})`,
  )
  assert.equal(outside, 'REJECTED(PipelineError:idx=1)', '泄漏闭包重派必须 reject，违规者 index 归调用方')
  assert.equal(m2Run, 1, '管道外重调同样不得让在飞 M2 第二次执行')
  assert.equal(pipelineDone, false, '重派被拒后管道依旧只在真实 settle 时完成')

  hangRelease()
  await p
  assert.equal(pipelineDone, true)
  assert.equal(m2Run, 1, 'm2Run 恒 1：全程无双重执行')
  assert.deepEqual(ev, [
    'M0:enter', 'M1:enter', 'M2:enter#1', 'ABORT',
    'inflight-2nd-next:REJECTED(PipelineError:idx=1)',
    'M2:settled#1', 'M1:bubble', 'M0:bubble', 'PIPELINE:resolved',
  ], `事件序：在飞 M2 settle 必须先于 bubble 回溯与管道完成（实际 ${ev.join(' | ')}）`)
})

test('gemini38 缺陷1 拒绝项锁②（A4b 变体）：管道真实完成后，泄漏的 nextStep 仍不可复活重派', async () => {
  const controller = new AbortController()
  const ctx = { signal: controller.signal }
  const ev = []
  let m2Run = 0
  const leaked = { next: null }
  const M0 = async (c, next) => { await next() }
  const M1 = async (c, next) => { leaked.next = next; await next(); ev.push('M1:bubble') }
  const M2 = async () => { m2Run += 1; ev.push(`M2:run#${m2Run}`); await new Promise((r) => setImmediate(r)) }

  await compose([M0, M1, M2])(ctx)
  ev.push('PIPELINE:done')
  controller.abort('post-completion')        // 管道已结束才 abort

  const after = await leaked.next().then(
    () => 'RESOLVED(结算后重派放行!)',
    (e) => `REJECTED(${e.name}:idx=${e.index})`,
  )
  assert.equal(after, 'REJECTED(PipelineError:idx=1)', '资格位终身有效：不存在「结束后再放一次」的复活路径')
  assert.equal(m2Run, 1, '终端副作用不放大')
  assert.deepEqual(ev, ['M2:run#1', 'M1:bubble', 'PIPELINE:done'])
})

test('gemini38 缺陷1 拒绝项锁③（A5）：预 abort 场景二次确认——连第 0 层都不进、不注册监听、同句柄重复执行仍全短路', async () => {
  let added = 0
  let removed = 0
  const preAbortedSignal = {
    aborted: true,
    addEventListener: () => { added += 1 },
    removeEventListener: () => { removed += 1 },
  }
  const ctx = { signal: preAbortedSignal }
  const ev = []
  const M0 = async (c, next) => { ev.push('M0:enter'); await next(); ev.push('M0:bubble') }
  const M1 = async (c, next) => { ev.push('M1:enter'); await next() }
  const pipeline = compose([M0, M1])

  // 第一次：预 abort（abortBoundary=-1）→ dispatch(0) 即命中检查点2就地 resolve
  await pipeline(ctx, async () => { ev.push('tail') })
  assert.deepEqual(ev, [], '预 abort：任何中间件与 tail 都不进')
  assert.deepEqual([added, removed], [0, 0], '预 abort 不注册监听（review A1#2 卫生约束）')

  // 二次确认：同一 executePipeline 句柄在同一已 abort 信号上重复执行，语义不变
  //（对方补丁在此场景 currentIndex(0) > abortBoundary(-1) 同样成立 ⇒ 两版逐位一致，
  //  本锁防的是未来把「预 abort 全短路」改成「先派发第 0 层再短路」的重构）
  await pipeline(ctx, async () => { ev.push('tail#2') })
  assert.deepEqual(ev, [], '重复执行仍全短路，无半进入状态')
  assert.deepEqual([added, removed], [0, 0], '二次执行同样不注册监听')
})
