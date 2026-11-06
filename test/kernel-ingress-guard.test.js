// 入口防御链（RFC-0001 §2.1 / §4 Phase 2，US-009）：ratelimit / acl / dedup 三守卫 +
// poke/notice 归窗修复（US-008 verifier 观察①）+ abort unwind 联动与装配次序回归。
// 全程假时钟 + 判定桩注入面，零真睡零网络零真 hub；装配次序复刻 host.js 开启态：
// tracing → ratelimit → acl → dedup →（flush/egress 略，由 kernel-egress-cutover 钉）→
// aggregator → legacy 终端。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compose } from '../src/kernel/compose.js'
import { createContext } from '../src/kernel/context.js'
import { legacyEventToEnvelope } from '../src/kernel/legacy-fallback.js'
import { createRatelimitMiddleware, ratelimitOptionsFromEnv } from '../src/kernel/mw-ratelimit.js'
import { createAclMiddleware, defaultAclDecision } from '../src/kernel/mw-acl.js'
import { createDedupMiddleware } from '../src/kernel/mw-dedup.js'
import { createTracingMiddleware, getTrace } from '../src/kernel/mw-tracing.js'
import { createAggregatorMiddleware, AGGREGATION_KEY } from '../src/kernel/mw-aggregator.js'

// ---------- 假时钟（manual：只有 advance 才走） ----------
function fakeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms; return t } }
}

// ---------- 假 sleep（同 kernel-aggregator.test.js 口径：settleAll 模拟到期） ----------
function fakeSleep() {
  const calls = []
  const fn = (ms, signal) => new Promise((resolve) => {
    const rec = { ms, signal, fired: false, finish: null }
    rec.finish = (why) => {
      if (rec.fired) return
      rec.fired = true
      resolve(why)
    }
    calls.push(rec)
    if (signal) signal.addEventListener('abort', () => rec.finish('cancelled'), { once: true })
  })
  return { fn, calls, settleAll: () => calls.filter((c) => !c.fired).forEach((c) => c.finish('expired')) }
}

// ---------- 事件 → ctx（信封走 legacyEventToEnvelope 真装配，形态与 host 开启态一致） ----------
let midSeq = 0
function messageCtx({ userId = '777', groupId, text = 'hi', messageId } = {}) {
  const mid = messageId ?? `m${++midSeq}`
  const ev = groupId
    ? { post_type: 'message', message_type: 'group', group_id: groupId, user_id: userId, time: 1, sender: { user_id: userId, nickname: `u${userId}` }, message: [{ type: 'text', data: { text } }], message_id: mid }
    : { post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: userId, time: 1, sender: { user_id: userId, nickname: `u${userId}` }, message: [{ type: 'text', data: { text } }], message_id: mid }
  return createContext(legacyEventToEnvelope(ev), 'onebot')
}
// 群 poke：带 sender.user_id + group_id——US-008 verifier 观察①的复现形态（旧代码会被归窗）
function groupPokeCtx({ userId = '777', groupId = '55' } = {}) {
  const ev = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: groupId, user_id: userId, time: 1, sender: { user_id: userId } }
  return createContext(legacyEventToEnvelope(ev), 'onebot')
}
function privatePokeCtx({ userId = '777' } = {}) {
  const ev = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: userId, sender_id: userId, time: 1, sender: { user_id: userId } }
  return createContext(legacyEventToEnvelope(ev), 'onebot')
}

// 微任务/宏任务排空：pipeline() 返回后，首层 await 之前的同步段之外还要让出若干
// microtask 才能观测到聚合窗开启（compose 的 await 链是微任务驱动的）
const tick = () => new Promise((resolve) => setImmediate(resolve))

// ---------- 终端探针 ----------
function terminal() {
  const hits = []
  const fn = async (ctx) => { hits.push(ctx) }
  fn.hits = hits
  return fn
}
// 包裹记录层：下行记 'X>'、本层 bubble 完成后记 '<X'（守卫拒绝时内层标记不出现 = 两级不进）
function probe(layers, name, mw) {
  return async (ctx, next) => {
    layers.push(`${name}>`)
    try {
      await mw(ctx, next)
    } finally {
      layers.push(`<${name}`)
    }
  }
}

// ================= 1. 重传（dedup） =================
test('重传：同 messageId 二连发——第一次全链，第二次 abort(duplicate) 且聚合/终端零调用', async () => {
  const dedup = createDedupMiddleware()
  let aggCalls = 0
  const t = terminal()
  const pipeline = compose([
    dedup,
    async (ctx, next) => { aggCalls++; await next() },
    t,
  ])
  const first = messageCtx({ messageId: 'dup-1', text: '第一次' })
  await pipeline(first)
  assert.equal(t.hits.length, 1)
  assert.equal(aggCalls, 1)
  assert.equal(first.signal.aborted, false)

  const second = messageCtx({ messageId: 'dup-1', text: '重传' })
  await pipeline(second)
  assert.equal(second.signal.aborted, true)
  assert.equal(second.signal.reason, 'duplicate')
  assert.equal(t.hits.length, 1, '终端绝不为重传第二次执行')
  assert.equal(aggCalls, 1, '聚合层同样不被重传触达')
  assert.ok(second.reply.isEmpty())
  assert.equal(dedup.stats().duplicates, 1)
})

test('dedup：无 messageId 的事件两次放行（幂等对通知类无语义）；LRU 满员逐出最旧；键桩抛错 fail-open', async () => {
  const t = terminal()
  const pipeline = compose([createDedupMiddleware({ capacity: 2 }), t])
  // 无 messageId：poke 通知
  await pipeline(groupPokeCtx())
  await pipeline(groupPokeCtx())
  assert.equal(t.hits.length, 2)

  // LRU：capacity 2 —— A B 在缓存；A 命中并 touch（顺序 B→A）；C 插入逐最旧 B；
  // B 再来按「新消息」放行——逐出只丢幂等记忆，不丢正常消息
  const A = messageCtx({ messageId: 'A' })
  const B = messageCtx({ messageId: 'B' })
  const A2 = messageCtx({ messageId: 'A' })
  const C = messageCtx({ messageId: 'C' })
  const B2 = messageCtx({ messageId: 'B' })
  for (const ctx of [A, B, A2, C, B2]) await pipeline(ctx)
  assert.equal(A2.signal.aborted, true, 'A 命中缓存判重传')
  assert.equal(A2.signal.reason, 'duplicate')
  assert.equal(B2.signal.aborted, false, 'B 被逐出后按新消息放行')
  assert.equal(t.hits.length, 2 + 4, 'poke×2 + A B C B2 通过；A2 被拦')

  // 键桩抛错 → fail-open 放行（拍板：资源防御不错拦）
  const boom = createDedupMiddleware({ keyFn: () => { throw new Error('boom') } })
  const p2 = compose([boom, terminal()])
  const e = messageCtx()
  await p2(e)
  assert.equal(e.signal.aborted, false)
  assert.equal(boom.stats().errors, 1)
})

test('dedup：跨聊天同 messageId 不算重传（聊天域复合键，对齐 seenIds 口径）', async () => {
  const dedup = createDedupMiddleware()
  const t = terminal()
  const pipeline = compose([dedup, t])
  const a = messageCtx({ userId: '111', messageId: 'X' })
  const b = messageCtx({ userId: '222', messageId: 'X' })
  await pipeline(a)
  await pipeline(b)
  assert.equal(a.signal.aborted, false)
  assert.equal(b.signal.aborted, false)
  assert.equal(t.hits.length, 2)
  assert.equal(dedup.stats().duplicates, 0)
})

// ================= 2. 限流（ratelimit） =================
test('限流边界：容量 N 恰好 N 过 N+1 拒；补充走假时钟；容量封顶不超发', async () => {
  const fc = fakeClock(0)
  const rl = createRatelimitMiddleware({ capacity: 3, refillPerSec: 2, clock: fc.now })
  const t = terminal()
  const pipeline = compose([rl, t])
  const mk = () => messageCtx({ userId: '777' })
  for (let i = 0; i < 3; i++) await pipeline(mk())
  assert.equal(t.hits.length, 3, '容量内 3 条全过')
  const blocked = mk()
  await pipeline(blocked)
  assert.equal(blocked.signal.aborted, true)
  assert.equal(blocked.signal.reason, 'ratelimited')
  assert.equal(t.hits.length, 3)
  assert.equal(rl.stats().limited, 1)

  // 0.5s × 2/s = 1 枚令牌
  fc.advance(500)
  const after = mk()
  await pipeline(after)
  assert.equal(after.signal.aborted, false)
  assert.equal(t.hits.length, 4)

  // 长时间补齐封顶在 capacity：10s 应发 20 枚，但只有 3 枚突发额度
  fc.advance(10_000)
  for (let i = 0; i < 3; i++) await pipeline(mk())
  const overCap = mk()
  await pipeline(overCap)
  assert.equal(overCap.signal.aborted, true, '补充不超容量')
})

test('限流：不同 chatId 互不影响；不可归聊事件放行；键桩抛错 fail-open', async () => {
  const fc = fakeClock(0)
  const rl = createRatelimitMiddleware({ capacity: 1, refillPerSec: 1, clock: fc.now })
  const t = terminal()
  const pipeline = compose([rl, t])
  await pipeline(messageCtx({ userId: '111' }))
  const sameBlocked = messageCtx({ userId: '111' })
  await pipeline(sameBlocked)
  assert.equal(sameBlocked.signal.aborted, true)
  const otherChat = messageCtx({ userId: '222' })
  await pipeline(otherChat)
  assert.equal(otherChat.signal.aborted, false, '另一个聊天桶完好')
  const groupA = messageCtx({ userId: '333', groupId: '55' })
  const groupA2 = messageCtx({ userId: '333', groupId: '55' })
  await pipeline(groupA)
  await pipeline(groupA2)
  assert.equal(groupA.signal.aborted, false)
  assert.equal(groupA2.signal.aborted, true, '群桶按 group:<gid> 共享')

  // 无 sender/group 的通知事件：不可归聊 → 放行且不建桶
  const anon = createContext(legacyEventToEnvelope({ post_type: 'notice', notice_type: 'friend_add', time: 1 }), 'onebot')
  await pipeline(anon)
  assert.equal(anon.signal.aborted, false)
  assert.equal(rl.stats().keyless, 1)

  const boom = createRatelimitMiddleware({ keyFn: () => { throw new Error('boom') }, clock: fc.now })
  const p2 = compose([boom, terminal()])
  const e = messageCtx({ userId: '999' })
  await p2(e)
  assert.equal(e.signal.aborted, false, 'fail-open 拍板：判定异常放行')
  assert.equal(boom.stats().errors, 1)
})

test('限流：reportStage 注入约定——每个到达本层的事件恰好自报一段（含被拒事件）', async () => {
  const fc = fakeClock(0)
  const stages = []
  const rl = createRatelimitMiddleware({
    capacity: 1, refillPerSec: 1, clock: fc.now,
    reportStage: (name, ms) => stages.push([name, ms]),
  })
  const pipeline = compose([rl, terminal()])
  await pipeline(messageCtx({ userId: '111' }))
  await pipeline(messageCtx({ userId: '111' })) // 被限流也要打点
  assert.deepEqual(stages.map((s) => s[0]), ['ratelimit', 'ratelimit'])
})

// ---------- 限流 env 配置化（US-012 尾巴：QQHUB_RL_CAPACITY / QQHUB_RL_REFILL_PER_SEC） ----------
test('限流 env 覆盖：合法值经装配 spread 生效（容量 3 + 0.5s 补 1 枚，与旋钮语义一致）', async () => {
  const opts = ratelimitOptionsFromEnv({ QQHUB_RL_CAPACITY: '3', QQHUB_RL_REFILL_PER_SEC: '2' })
  assert.deepEqual(opts, { capacity: 3, refillPerSec: 2 })
  const fc = fakeClock(0)
  const rl = createRatelimitMiddleware({ ...opts, clock: fc.now })
  assert.equal(rl.stats().capacity, 3)
  assert.equal(rl.stats().refillPerSec, 2)
  const t = terminal()
  const pipeline = compose([rl, t])
  for (let i = 0; i < 3; i++) await pipeline(messageCtx({ userId: '777' }))
  const blocked = messageCtx({ userId: '777' })
  await pipeline(blocked)
  assert.equal(blocked.signal.aborted, true, 'env 容量 3 生效：第 4 条拒')
  fc.advance(500)
  const after = messageCtx({ userId: '777' })
  await pipeline(after)
  assert.equal(after.signal.aborted, false, 'env 速率 2/s 生效：0.5s 补 1 枚')
})

test('限流 env 非法值回缺省 30/5（熔断口径同管道开关：乱值/负数/0 容量/空串一律默认，改 env 需重启）', async () => {
  assert.deepEqual(ratelimitOptionsFromEnv({}), {}, '未设置 → 空对象（落构造缺省）')
  for (const bad of ['abc', '-2', '0', '', ' ', 'NaN', '3.5x']) {
    assert.deepEqual(ratelimitOptionsFromEnv({ QQHUB_RL_CAPACITY: bad }), {}, `capacity 乱值「${bad}」不生效`)
  }
  for (const bad of ['abc', '-1', '', '5x']) {
    assert.deepEqual(ratelimitOptionsFromEnv({ QQHUB_RL_REFILL_PER_SEC: bad }), {}, `refill 乱值「${bad}」不生效`)
  }
  // refill=0 是合法极端闸（突发用尽后全拒），不算非法值
  assert.deepEqual(ratelimitOptionsFromEnv({ QQHUB_RL_REFILL_PER_SEC: '0' }), { refillPerSec: 0 })
  // 口径说明：解析只认字符串 env 值（process.env 契约），非字符串形态按未设置回默认
  assert.deepEqual(ratelimitOptionsFromEnv({ QQHUB_RL_CAPACITY: 45 }), {}, '非字符串值不生效')
  // 行为验证：非法 env 装配出来的桶 = 缺省 30——30 条全过、第 31 条拒
  const fc = fakeClock(0)
  const rl = createRatelimitMiddleware({ ...ratelimitOptionsFromEnv({ QQHUB_RL_CAPACITY: 'oops', QQHUB_RL_REFILL_PER_SEC: '-7' }), clock: fc.now })
  assert.equal(rl.stats().capacity, 30)
  assert.equal(rl.stats().refillPerSec, 5)
  const t = terminal()
  const pipeline = compose([rl, t])
  for (let i = 0; i < 30; i++) await pipeline(messageCtx({ userId: '777' }))
  assert.equal(t.hits.length, 30)
  const over = messageCtx({ userId: '777' })
  await pipeline(over)
  assert.equal(over.signal.aborted, true)
})

// ================= 3. ACL =================
const ACL_CFG = { ownerQQ: '1001', allow: { private: ['2002'], groups: ['55'] } }

test('ACL：白名单外私聊/黑名单群 abort(acl)；owner 直通；poke/notice 不设闸门', async () => {
  const acl = createAclMiddleware({ getConfig: () => ACL_CFG })
  const t = terminal()
  const pipeline = compose([acl, t])

  await pipeline(messageCtx({ userId: '2002' }))
  assert.equal(t.hits.length, 1, '白名单私聊通过')

  const bannedPrivate = messageCtx({ userId: '3003' })
  await pipeline(bannedPrivate)
  assert.equal(bannedPrivate.signal.aborted, true)
  assert.equal(bannedPrivate.signal.reason, 'acl')
  assert.equal(t.hits.length, 1, '被禁私聊者不进终端')

  const blackGroup = messageCtx({ userId: '777', groupId: '66' })
  await pipeline(blackGroup)
  assert.equal(blackGroup.signal.aborted, true)
  assert.equal(blackGroup.signal.reason, 'acl')

  const goodGroup = messageCtx({ userId: '777', groupId: '55' })
  await pipeline(goodGroup)
  assert.equal(goodGroup.signal.aborted, false, '白名单群通过')

  const owner = messageCtx({ userId: '1001' })
  await pipeline(owner)
  assert.equal(owner.signal.aborted, false, 'owner 直通（不在私聊白名单也过——复用 isOwner 判定）')
  assert.equal(t.hits.length, 3)

  const ownerGroup = messageCtx({ userId: '1001', groupId: '66' })
  await pipeline(ownerGroup)
  assert.equal(ownerGroup.signal.aborted, false, 'owner 群聊直通粗筛；核心仍按 checkAllowed 复检（诚实边界）')

  const poke = groupPokeCtx({ userId: '3003', groupId: '66' })
  await pipeline(poke)
  assert.equal(poke.signal.aborted, false, 'poke 在旧核心无白名单闸门，入口层不拦（避免行为变更）')

  assert.equal(acl.stats().rejected, 2)
  assert.equal(acl.stats().passed, 5)
})

test('ACL：判定桩 reject/缺字段 → abort(acl)；桩抛错 → fail-closed 拒绝（拍板：权限防御异常不放行）', async () => {
  const t = terminal()
  const rejectedByStub = createAclMiddleware({ decide: () => ({ allow: false, reason: '风控命中' }) })
  const c1 = messageCtx()
  await compose([rejectedByStub, t])(c1)
  assert.equal(c1.signal.reason, 'acl')
  assert.equal(t.hits.length, 0)

  const undefinedStub = createAclMiddleware({ decide: () => undefined })
  const c2 = messageCtx()
  await compose([undefinedStub, t])(c2)
  assert.equal(c2.signal.aborted, true, '判定缺 allow 视为拒绝（fail-closed）')

  const warns = []
  const boomStub = createAclMiddleware({ decide: () => { throw new Error('cfg坏') }, log: { warn: (m) => warns.push(m) } })
  const c3 = messageCtx()
  await compose([boomStub, t])(c3)
  assert.equal(c3.signal.aborted, true)
  assert.equal(c3.signal.reason, 'acl')
  assert.equal(boomStub.stats().decideErrors, 1)
  assert.equal(boomStub.stats().rejected, 1)
  assert.match(warns.join('\n'), /fail-closed/)
  assert.equal(t.hits.length, 0, '判定异常绝不能穿透到终端')

  // reportStage：拒绝路径也恰好一段
  const stages = []
  const timed = createAclMiddleware({ decide: () => { throw new Error('x') }, reportStage: (n, ms) => stages.push([n, ms]) })
  await compose([timed, terminal()])(messageCtx())
  assert.deepEqual(stages.map((s) => s[0]), ['acl'])
})

test('ACL：defaultAclDecision 独立可用——非 message 放行、无 sender 私聊判白名单外', () => {
  const ctx = createContext(legacyEventToEnvelope({ post_type: 'message', message_type: 'private', time: 1, message: [], message_id: 'n1' }), 'onebot')
  assert.equal(defaultAclDecision(ctx, ACL_CFG).allow, false, '无 sender 的消息按不可归用户处理——白名单外')
  const poke = groupPokeCtx()
  assert.equal(defaultAclDecision(poke, {}).allow, true)
})

// ================= 4. abort unwind 联动 + 装配次序 =================
test('装配次序回归：tracing→ratelimit→acl→dedup→aggregator→终端，下行/回溯逐层钉死', async () => {
  const layers = []
  const fc = fakeClock(1000)
  const t = terminal()
  const pipeline = compose([
    probe(layers, 'T', createTracingMiddleware({ log: { debug: () => {} }, now: fc.now })),
    probe(layers, 'R', createRatelimitMiddleware({ clock: fc.now })),
    probe(layers, 'A', createAclMiddleware({ getConfig: () => ACL_CFG })),
    probe(layers, 'D', createDedupMiddleware({})),
    probe(layers, 'G', createAggregatorMiddleware({ getConfig: () => ({ merge: { enabled: false } }), clock: fc.now })),
    async (ctx) => { layers.push('TERM'); t.hits.push(ctx) },
  ])
  await pipeline(messageCtx({ userId: '2002' }))
  assert.deepEqual(layers, ['T>', 'R>', 'A>', 'D>', 'G>', 'TERM', '<G', '<D', '<A', '<R', '<T'])
  // 被 acl 拒绝的事件：dedup/aggregator/终端两级都不进（下行与回溯标记都不出现）
  layers.length = 0
  await pipeline(messageCtx({ userId: '3003' }))
  assert.deepEqual(layers, ['T>', 'R>', 'A>', '<A', '<R', '<T'], 'acl 之后的层两级不进，之前的 bubble 正常收尾')
})

test('abort unwind 联动：守卫层 abort 后聚合窗无残留挂起 ctx、定时器计数零泄漏、tracing 收尾 aborted', async () => {
  const fc = fakeClock(1000)
  const sl = fakeSleep()
  const logs = []
  const tracing = createTracingMiddleware({ log: { debug: (l) => logs.push(l) }, now: fc.now })
  const dedup = createDedupMiddleware()
  const agg = createAggregatorMiddleware({
    getConfig: () => ({ merge: { enabled: true, waitSec: 1, maxSec: 5, groupWaitSec: 1, groupMaxSec: 5 } }),
    clock: fc.now, sleep: sl.fn,
  })
  const t = terminal()
  const pipeline = compose([tracing, createAclMiddleware({ getConfig: () => ACL_CFG }), dedup, agg, t])

  // lead 开窗挂起（flush 前聚合器 await 窗口，promise 不 resolve）
  const lead = messageCtx({ userId: '2002', messageId: 'lead-1', text: '在吗' })
  const leadP = pipeline(lead)
  await tick()
  assert.equal(agg.stats().windows, 1)
  assert.equal(t.hits.length, 0, '窗口未到期，终端还没吃事件')

  // 重传同 messageId：必须在 dedup 就被拦——绝不作为 follower 进窗（否则 reason 会是 superseded-merged）
  const dup = messageCtx({ userId: '2002', messageId: 'lead-1', text: '在吗？' })
  await pipeline(dup)
  assert.equal(dup.signal.reason, 'duplicate')
  assert.equal(agg.stats().windows, 1, '窗数不变：重传没进窗')

  // ACL 拒绝：同样不进窗
  const banned = messageCtx({ userId: '3003' })
  await pipeline(banned)
  assert.equal(banned.signal.reason, 'acl')
  assert.equal(agg.stats().windows, 1)

  // 到期 flush：lead 单条成窗（合并文本不含重传与拒绝者），窗口清空零残留
  sl.settleAll()
  await leadP
  assert.equal(t.hits.length, 1)
  assert.equal(t.hits[0].inbound.rawText, '在吗', '窗口里只有 lead 自己——守卫拦下的事件零参与')
  assert.equal(agg.stats().windows, 0)
  assert.equal(agg.stats().inFlight, 0)
  assert.equal(agg.stats().pendingTimers, 0, '定时器零泄漏')
  assert.equal(agg.stats().mergedRounds, 1)

  // tracing 收尾：abort 记 aborted 不计错误；守卫的 stage 都在
  const dupTrace = getTrace(dup)
  assert.equal(dupTrace.aborted, true)
  assert.equal(dupTrace.errors, 0)
  assert.deepEqual(dupTrace.stages.map((s) => s.name), ['acl', 'dedup'])
  const bannedTrace = getTrace(banned)
  assert.deepEqual(bannedTrace.stages.map((s) => s.name), ['acl'], 'acl 拒绝时 dedup 未执行，也就没有它的段')
  assert.ok(logs.some((l) => l.includes('aborted=1') && l.includes('err=0')))
  // 被拦事件的 reply 从未入过东西
  assert.ok(dup.reply.isEmpty() && banned.reply.isEmpty())
})

// ================= 5. poke/notice 归窗修复（US-008 verifier 观察①） =================
test('poke/notice 不进窗：带 sender 的群 poke 直通报终端，后续消息自己开窗、没被 poke 吞并', async () => {
  const fc = fakeClock(1000)
  const sl = fakeSleep()
  const agg = createAggregatorMiddleware({
    getConfig: () => ({ merge: { enabled: true, waitSec: 1, maxSec: 5, groupWaitSec: 1, groupMaxSec: 5 } }),
    clock: fc.now, sleep: sl.fn,
  })
  const t = terminal()
  const pipeline = compose([agg, t])

  // 观察①复现形态：群 poke 带 sender.user_id + group_id——旧口径会被 chatId 归进窗口
  const poke = groupPokeCtx({ userId: '777', groupId: '55' })
  await pipeline(poke)
  assert.equal(t.hits.length, 1, 'poke 直通报终端')
  assert.equal(t.hits[0].inbound.type, 'notice')
  assert.equal(agg.stats().windows, 0, 'poke 不开窗')
  assert.equal(agg.stats().mergedRounds, 0)

  // 随后同群消息：正常自任 lead 开自己的窗，没有被并进 poke、也没被 poke 当 follower 吞掉
  const msg = messageCtx({ userId: '777', groupId: '55', text: '在吗' })
  const msgP = pipeline(msg)
  await tick()
  assert.equal(agg.stats().windows, 1)

  // 在飞窗口未到期时再来 poke：直通，不打扰 lead（不 steer、不进窗）
  const poke2 = privatePokeCtx({ userId: '888' })
  await pipeline(poke2)
  assert.equal(t.hits.length, 2, '私聊 poke 同样直通')
  assert.equal(agg.stats().steered, 0, 'poke 不触发 busy steer')

  sl.settleAll()
  await msgP
  assert.equal(t.hits.length, 3)
  assert.equal(t.hits[2].inbound.rawText, '在吗', 'lead 只合并了自己')
  const meta = t.hits[2].state.get(AGGREGATION_KEY)
  assert.equal(meta.count, 1, '窗内条数只有消息自己——poke 从未入窗')
  assert.equal(agg.stats().windows, 0)
})

test('aggregator：merge 关闭与 disposed 路径不受类型闸影响（回归既有语义）', async () => {
  const fc = fakeClock(1000)
  const aggOff = createAggregatorMiddleware({ getConfig: () => ({ merge: { enabled: false } }), clock: fc.now })
  const t = terminal()
  await compose([aggOff, t])(messageCtx())
  await compose([aggOff, t])(groupPokeCtx())
  assert.equal(t.hits.length, 2, '合流关闭：消息与 poke 都直通')

  const agg = createAggregatorMiddleware({
    getConfig: () => ({ merge: { enabled: true, waitSec: 1, maxSec: 5 } }),
    clock: fc.now, sleep: fakeSleep().fn,
  })
  agg.dispose()
  const disposedPoke = groupPokeCtx()
  await compose([agg, terminal()])(disposedPoke)
  assert.equal(disposedPoke.signal.aborted, true, 'disposed 检查先于类型闸：poke 也按既有语义被中止')
  assert.equal(disposedPoke.signal.reason, 'aggregator-disposed')
})
