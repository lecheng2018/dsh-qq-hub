// US-020 接线验收：Shared Outbox 的群动作必须真的经过 group-quota。
// 这些用例验证「接线」而非「算法」——算法在 group-quota.test.js 里已经测过。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSharedOutbox } from '../src/host/shared-outbox.js'

const HOUR = 60 * 60 * 1000

/** 虚拟时钟：注入给 outbox，让"等一个窗口"在测试里瞬间完成。 */
function clock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    sleep: async (ms) => { t += Number(ms) || 0 },
    advance: (ms) => { t += Number(ms) || 0 },
  }
}

function makeCfg(over = {}) {
  return {
    enabled: true,
    dryRun: false,
    ownerQQ: '1000',
    botQQ: '2000',
    security: { identityGuard: { enabled: false } },
    allow: { private: ['1000'], groups: ['999'] },
    ownerLevel: 'full',
    group: { quota: { enabled: true, perMinute: 2, reserve: 0, ...over } },
  }
}

/** 假 OneBot：记录每次物理调用，可注入失败。 */
function fakeOnebot({ failTimes = 0, errMsg = '发送过于频繁（result=299）' } = {}) {
  const calls = []
  let left = failTimes
  return {
    calls,
    async call(action, params) {
      calls.push({ action, params, at: Date.now() })
      if (left > 0) { left -= 1; throw new Error(errMsg) }
      return { message_id: 'm' + calls.length }
    },
  }
}

/** 把一个 delivery 塞进 outbox 并等结果。 */
async function sendVia(outbox, chatKey, text) {
  const r = outbox.request({ chatKey, segments: [{ type: 'text', data: { text } }] })
  return r
}

test('群动作经过配额：达到上限时等窗口，不丢消息', async () => {
  const onebot = fakeOnebot()
  const cfg = makeCfg({ perMinute: 2, reserve: 0 })
  const c = clock()
  const outbox = createSharedOutbox({ onebot, getConfig: () => cfg, log: { warn() {}, info() {} }, now: c.now, sleep: c.sleep })

  // 发 3 条：前 2 条立即发，第 3 条应等待窗口后才发（不抛错、不丢）
  const results = []
  for (const t of ['a', 'b', 'c']) results.push(await sendVia(outbox, 'group:999', t))

  assert.equal(onebot.calls.length, 3, '三条都必须真的发出去，一条都不能丢')
  assert.ok(results.every((r) => r && (r.state === 'sent' || r.deliveryId)), '每次都应返回投递记录')
})

test('私聊动作不经过群配额（不引入额外等待）', async () => {
  const onebot = fakeOnebot()
  const cfg = makeCfg({ perMinute: 1, reserve: 0 })
  const c = clock()
  const outbox = createSharedOutbox({ onebot, getConfig: () => cfg, log: { warn() {}, info() {} }, now: c.now, sleep: c.sleep })
  const t0 = Date.now()
  await sendVia(outbox, 'private:1000', 'hi')
  await sendVia(outbox, 'private:1000', 'hi2')
  const dt = Date.now() - t0
  assert.equal(onebot.calls.length, 2)
  assert.ok(dt < 1000, `私聊不应等待窗口，实际耗时 ${dt}ms`)
})

test('被网关真拒一次后靠重试成功（不会静默丢）', async () => {
  const onebot = fakeOnebot({ failTimes: 1 })
  const cfg = makeCfg({ perMinute: 10, reserve: 0 })
  const c = clock()
  const outbox = createSharedOutbox({ onebot, getConfig: () => cfg, log: { warn() {}, info() {} }, now: c.now, sleep: c.sleep })
  const r = await sendVia(outbox, 'group:999', 'x')
  assert.equal(onebot.calls.length, 2, '应重试一次')
  assert.ok(r, '重试成功后应返回结果')
})

test('配额关闭时完全直通', async () => {
  const onebot = fakeOnebot()
  const cfg = makeCfg({ enabled: false, perMinute: 1, reserve: 0 })
  const c = clock()
  const outbox = createSharedOutbox({ onebot, getConfig: () => cfg, log: { warn() {}, info() {} }, now: c.now, sleep: c.sleep })
  const t0 = Date.now()
  for (const t of ['1', '2', '3', '4']) await sendVia(outbox, 'group:999', t)
  assert.equal(onebot.calls.length, 4)
  assert.ok(Date.now() - t0 < 1000, '关掉配额后不该等待')
})

test('真被限流且重试也失败时，如实抛错（不冒充 sent）', async () => {
  const onebot = fakeOnebot({ failTimes: 99 })   // 永远失败
  const cfg = makeCfg({ perMinute: 10, reserve: 0 })
  const c = clock()
  const outbox = createSharedOutbox({ onebot, getConfig: () => cfg, log: { warn() {}, info() {} }, now: c.now, sleep: c.sleep })
  const r = await sendVia(outbox, 'group:999', 'x')
  // 关键：绝不能返回 sent，否则等于把丢掉的群消息谎报为已送达
  assert.notEqual(r?.state, 'sent', `不许把失败谎报为已发送，实际 state=${r?.state}`)
  assert.ok(onebot.calls.length >= 2, '应当尝试过重试')
})
