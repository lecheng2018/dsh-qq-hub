import test from 'node:test'
import assert from 'node:assert/strict'
import { createRatelimitMiddleware, ratelimitOptionsFromEnv } from '../src/kernel/mw-ratelimit.js'

function context(userId = '777', groupId = '') {
  return {
    inbound: { sender: { userId }, groupId, subType: groupId ? 'group' : 'private' },
    signal: { aborted: false, reason: '' },
    abort(reason) { this.signal.aborted = true; this.signal.reason = reason },
  }
}

test('当前限流：容量、补充与封顶语义保持不变', async () => {
  let now = 0
  let hits = 0
  const rl = createRatelimitMiddleware({ capacity: 3, refillPerSec: 2, clock: () => now })
  const run = (ctx = context()) => rl(ctx, async () => { hits++ })
  for (let i = 0; i < 3; i++) await run()
  const blocked = context()
  await run(blocked)
  assert.equal(blocked.signal.reason, 'ratelimited')
  assert.equal(hits, 3)
  now += 500
  await run()
  assert.equal(hits, 4)
  now += 10_000
  for (let i = 0; i < 3; i++) await run()
  const overCap = context()
  await run(overCap)
  assert.equal(overCap.signal.aborted, true)
  assert.equal(hits, 7)
})

test('当前限流：聊天隔离、不可归聊与判定异常 fail-open', async () => {
  const rl = createRatelimitMiddleware({ capacity: 1, refillPerSec: 0, clock: () => 0 })
  let hits = 0
  const run = (ctx) => rl(ctx, async () => { hits++ })
  const first = context('111')
  const same = context('111')
  const other = context('222')
  await run(first)
  await run(same)
  await run(other)
  assert.equal(first.signal.aborted, false)
  assert.equal(same.signal.reason, 'ratelimited')
  assert.equal(other.signal.aborted, false)
  const anonymous = { inbound: {}, signal: { aborted: false }, abort() { this.signal.aborted = true } }
  await run(anonymous)
  assert.equal(anonymous.signal.aborted, false)
  assert.equal(rl.stats().keyless, 1)

  const broken = createRatelimitMiddleware({ keyFn: () => { throw new Error('boom') } })
  const allowed = context('999')
  await broken(allowed, async () => {})
  assert.equal(allowed.signal.aborted, false)
  assert.equal(broken.stats().errors, 1)
})

test('当前限流：被拒事件也恰好上报一个阶段', async () => {
  const stages = []
  const rl = createRatelimitMiddleware({ capacity: 1, refillPerSec: 0, clock: () => 0, reportStage: (name, ms) => stages.push([name, ms]) })
  await rl(context(), async () => {})
  await rl(context(), async () => {})
  assert.deepEqual(stages.map(([name]) => name), ['ratelimit', 'ratelimit'])
})

test('当前限流：环境变量合法值生效，非法值回默认 30/5', () => {
  assert.deepEqual(ratelimitOptionsFromEnv({ QQHUB_RL_CAPACITY: '3', QQHUB_RL_REFILL_PER_SEC: '2' }), { capacity: 3, refillPerSec: 2 })
  assert.deepEqual(ratelimitOptionsFromEnv({ QQHUB_RL_CAPACITY: '0', QQHUB_RL_REFILL_PER_SEC: '-1' }), {})
  assert.deepEqual(ratelimitOptionsFromEnv({ QQHUB_RL_REFILL_PER_SEC: '0' }), { refillPerSec: 0 })
  const rl = createRatelimitMiddleware({ ...ratelimitOptionsFromEnv({ QQHUB_RL_CAPACITY: 'bad', QQHUB_RL_REFILL_PER_SEC: 'bad' }) })
  assert.equal(rl.stats().capacity, 30)
  assert.equal(rl.stats().refillPerSec, 5)
})

test('当前限流：时钟回拨不重复补令牌', async () => {
  const times = [10_000, 9_000, 10_000]
  const rl = createRatelimitMiddleware({ capacity: 1, refillPerSec: 1, clock: () => times.shift() ?? 10_000 })
  await rl(context(), async () => {})
  for (let i = 0; i < 2; i++) {
    const ctx = context()
    await rl(ctx, async () => {})
    assert.equal(ctx.signal.reason, 'ratelimited')
  }
})

test('当前限流：NaN 时钟 fail-open 且不毒化桶，非法容量拒绝构造', async () => {
  let calls = 0
  const rl = createRatelimitMiddleware({ capacity: 2, refillPerSec: 1, clock: () => ++calls === 1 ? NaN : 5000 })
  const first = context()
  await rl(first, async () => {})
  assert.equal(first.signal.aborted, false)
  assert.equal(rl.stats().errors, 1)
  const second = context()
  await rl(second, async () => {})
  assert.equal(second.signal.aborted, false)
  assert.throws(() => createRatelimitMiddleware({ capacity: 0.5 }), /至少为 1/)
})
