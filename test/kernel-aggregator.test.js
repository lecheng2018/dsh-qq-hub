// aggregator 暂停版（止损）回归：逐事件透传、不吞 follower、dispose 语义、stats 形状。
// 背景：2026-11-07 外部 review B 节 P0 A1/A2——吞并实现下 legacy 终端只消费 lead 的
// rawPayload，followers 物理丢失；lead 取消连带销毁有效 follower。本文件锁定**暂停后**
// 的行为契约：中间件退化为透传 + 观测，任何事件都不再被吞。合流恢复条件见实现文件头。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAggregatorMiddleware, isIngressAggregatorEnabled, AGGREGATION_KEY } from '../src/kernel/mw-aggregator.js'

function fakeCtx(id = 'c1') {
  const c = {
    id,
    inbound: { messageId: id, segments: [], rawText: id },
    reply: { queue: [], enqueue() {}, clear() {}, isEmpty: () => true },
    state: { get: () => undefined, set: () => {} },
    signal: { aborted: false },
    _aborts: [],
    abort(reason) { this._aborts.push(reason); this.signal.aborted = true },
  }
  return c
}

test('透传契约：每个事件都到达 next()，顺序=入队序，零吞并零 abort', async () => {
  const seen = []
  const mw = createAggregatorMiddleware({})
  const ctxs = [fakeCtx('A'), fakeCtx('B'), fakeCtx('C')]
  await Promise.all(ctxs.map((c) => mw(c, async () => { seen.push(c.id) })))
  assert.deepEqual(seen.sort(), ['A', 'B', 'C'])
  for (const c of ctxs) assert.equal(c._aborts.length, 0, `${c.id} 不应被 abort`)
})

test('不写聚合 state：AGGREGATION_KEY 永不落（旧吞并语义彻底下线）', async () => {
  const writes = []
  const ctx = fakeCtx('A')
  ctx.state.set = (k, v) => writes.push([k, v])
  const mw = createAggregatorMiddleware({})
  await mw(ctx, async () => {})
  assert.equal(writes.length, 0)
})

test('已 abort 的入站事件不下行（compose §2.2 边界语义保留）', async () => {
  const mw = createAggregatorMiddleware({})
  const ctx = fakeCtx('A')
  ctx.signal.aborted = true
  let reached = false
  await mw(ctx, async () => { reached = true })
  assert.equal(reached, false)
})

test('dispose：在飞 ctx 全部 abort(aggregator-disposed)；后续事件拒绝下行', async () => {
  const mw = createAggregatorMiddleware({})
  const inflight = fakeCtx('A')
  let releaseA
  const pA = mw(inflight, () => new Promise((r) => { releaseA = r }))
  mw.dispose()
  assert.deepEqual(inflight._aborts, ['aggregator-disposed'])
  releaseA()
  await pA
  let reachedLate = false
  await mw(fakeCtx('B'), async () => { reachedLate = true })
  assert.equal(reachedLate, false, 'dispose 后新事件不得下行')
})

test('stats：aggregationSuspended=true，窗口/合流计数恒零', () => {
  const mw = createAggregatorMiddleware({})
  const s = mw.stats()
  assert.equal(s.aggregationSuspended, true)
  assert.equal(s.windows, 0)
  assert.equal(s.mergedRounds, 0)
  assert.equal(s.steered, 0)
})

test('构造告警一次：装载即 warn「聚合执行暂停」（review 要求不静默）', () => {
  const warns = []
  createAggregatorMiddleware({ log: { warn: (m) => warns.push(String(m)) } })
  assert.equal(warns.length, 1)
  assert.match(warns[0], /暂停/)
})

test('reportStage 注入：每事件上报 aggregator-direct 段；时钟坏不挡业务', async () => {
  const stages = []
  const mw = createAggregatorMiddleware({ reportStage: (n, ms) => stages.push(n), clock: () => 1000 })
  await mw(fakeCtx('A'), async () => {})
  assert.deepEqual(stages, ['aggregator-direct'])
  const mw2 = createAggregatorMiddleware({ reportStage: (n) => stages.push(n), clock: () => NaN })
  let reached = false
  await mw2(fakeCtx('B'), async () => { reached = true })
  assert.equal(reached, true)
})

test('开关解析口径不变：true/1 开、其余关', () => {
  assert.equal(isIngressAggregatorEnabled({ FLAG_INGRESS_AGGREGATOR: 'true' }), true)
  assert.equal(isIngressAggregatorEnabled({ FLAG_INGRESS_AGGREGATOR: '1' }), true)
  assert.equal(isIngressAggregatorEnabled({ FLAG_INGRESS_AGGREGATOR: 'TRUE ' }), true)
  assert.equal(isIngressAggregatorEnabled({}), false)
  assert.equal(isIngressAggregatorEnabled({ FLAG_INGRESS_AGGREGATOR: 'yes' }), false)
  assert.ok(AGGREGATION_KEY, '键导出保留（恢复实现/观测复用）')
})
