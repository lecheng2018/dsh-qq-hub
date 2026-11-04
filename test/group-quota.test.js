// 回归：群发送配额（QQ 群每分钟 10 条，超了网关直接拒、消息真丢）。
// 2026-11-04 实测：她一轮发 3 条，2 条被拒没发出去；而 chatlog 记的是「尝试发送的内容」，
// 所以从日志里完全看不出丢过 —— 这类静默丢失必须有测试盯着。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGroupQuota, isGroupRateLimited, normalizeGroupQuota } from '../src/chat/group-quota.js'

function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, sleep: async (ms) => { t += ms }, advance: (ms) => { t += ms } }
}

test('限流识别：QQ 的两种说法都认，别把网络错误当限流', () => {
  assert.equal(isGroupRateLimited('本群每分钟只能发10条消息'), true)
  assert.equal(isGroupRateLimited('send group message rejected: result=299'), true)
  assert.equal(isGroupRateLimited('发送过于频繁'), true)
  assert.equal(isGroupRateLimited('fetch failed'), false)
  assert.equal(isGroupRateLimited('参数不对'), false)
})

test('没到配额时直接发，不等待', async () => {
  const clock = fakeClock()
  const q = createGroupQuota({ getConfig: () => ({ group: { quota: { perMinute: 10 } } }), ...clock })
  const r = await q.send('g1', async () => ({ message_id: 'a' }))
  assert.equal(r.ok, true)
  assert.equal(r.waitedMs, 0)
})

test('连发超过配额时靠等待换窗口，一条都不丢', async () => {
  const clock = fakeClock()
  const q = createGroupQuota({ getConfig: () => ({ group: { quota: { perMinute: 10, reserve: 1 } } }), ...clock })
  let ok = 0
  for (let i = 0; i < 12; i += 1) {
    const r = await q.send('g1', async () => ({ message_id: 'm' + i }))
    if (r.ok) ok += 1
  }
  assert.equal(ok, 12, '12 条全都要发出去（靠等窗口）')
})

test('被网关真拒一次，等一个窗口重试成功', async () => {
  const clock = fakeClock()
  const q = createGroupQuota({ getConfig: () => ({ group: { quota: { perMinute: 10, maxRetries: 1 } } }), ...clock, log: { warn() {} } })
  let n = 0
  const r = await q.send('g1', async () => {
    n += 1
    if (n === 1) throw new Error('result=299 err=本群每分钟只能发10条消息')
    return { message_id: 'ok' }
  })
  assert.equal(r.ok, true)
  assert.equal(n, 2, '应该重试一次')
  assert.ok(r.waitedMs >= 60_000, '要等够一个窗口')
})

test('业务错误不重试，直接失败（别把参数错误也当限流）', async () => {
  const clock = fakeClock()
  const q = createGroupQuota({ getConfig: () => ({ group: { quota: { perMinute: 10 } } }), ...clock, log: { warn() {} } })
  let n = 0
  const r = await q.send('g1', async () => { n += 1; throw new Error('机器人不在这个群里') })
  assert.equal(r.ok, false)
  assert.equal(n, 1, '业务错误不该重试')
})

test('配额关掉就完全不管', async () => {
  const clock = fakeClock()
  const q = createGroupQuota({ getConfig: () => ({ group: { quota: { enabled: false } } }), ...clock })
  let calls = 0
  for (let i = 0; i < 15; i += 1) await q.send('g1', async () => { calls += 1; return { message_id: 'x' } })
  assert.equal(calls, 15)
})

test('usage 能报出当前窗口用量（面板/诊断用）', async () => {
  const clock = fakeClock()
  const q = createGroupQuota({ getConfig: () => ({ group: { quota: { perMinute: 10 } } }), ...clock })
  await q.send('g1', async () => ({}))
  await q.send('g1', async () => ({}))
  const u = q.usage('g1')
  assert.equal(u.sent, 2)
  assert.equal(u.perMinute, 10)
})

test('不同群的配额互不影响', async () => {
  const clock = fakeClock()
  const q = createGroupQuota({ getConfig: () => ({ group: { quota: { perMinute: 10, reserve: 1 } } }), ...clock })
  for (let i = 0; i < 9; i += 1) await q.send('g1', async () => ({}))
  const r = await q.send('g2', async () => ({}))
  assert.equal(r.waitedMs, 0, 'g2 没发过，不该等')
})

test('normalizeGroupQuota 夹住非法值', () => {
  const c = normalizeGroupQuota({ perMinute: 9999, reserve: -5, maxRetries: 99 })
  assert.ok(c.perMinute <= 200)
  assert.equal(c.reserve, 0)
  assert.ok(c.maxRetries <= 3)
})
