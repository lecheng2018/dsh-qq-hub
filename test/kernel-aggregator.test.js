// 入口合流防抖中间件（RFC-0001 Phase 2 / US-008，G2 中断并合并）。
//
// 装配次序复刻 host.js 开启态真实拓扑：tracing → 边界 flush(含 dispatcher drain) →
// egress → **aggregator** → legacy 终端。aggregator 放在 legacyFallback 之前，
// 所以 followers 从未经旧入口（terminal 比它更内层，两级都不进），而外层 bubble
// 按 compose §2.2（US-008a）正常回溯收尾。
// 全程假时钟 + 假 sleep，零真睡、零网络、零真 hub。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compose } from '../src/kernel/compose.js'
import { createContext } from '../src/kernel/context.js'
import { createAggregatorMiddleware, AGGREGATION_KEY } from '../src/kernel/mw-aggregator.js'

// ---------- 假时钟 ----------
function fakeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms; return t } }
}

// ---------- 假 sleep：记录 (ms, signal)，settleAll 模拟到期，signal 中止则返回 cancelled ----------
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
  return {
    fn,
    calls,
    pending: () => calls.filter((c) => !c.fired),
    settleAll: () => calls.filter((c) => !c.fired).forEach((c) => c.finish('expired')),
  }
}

// ---------- 宿主 setTimeout 桩（dispose 零泄漏断言用）----------
function timerStub() {
  const state = { created: 0, cleared: 0, live: new Map(), seq: 0 }
  const origSet = global.setTimeout
  const origClear = global.clearTimeout
  global.setTimeout = (fn, ms, ...args) => {
    const id = ++state.seq
    const real = origSet(fn, ms, ...args)
    state.created++
    state.live.set(id, real)
    return { __stubId: id, real, unref: () => real.unref?.(), ref: () => real.ref?.() }
  }
  global.clearTimeout = (handle) => {
    if (handle && handle.__stubId) {
      if (state.live.delete(handle.__stubId)) {
        state.cleared++
        origClear(handle.real)
      }
      return
    }
    return origClear(handle)
  }
  state.restore = () => { global.setTimeout = origSet; global.clearTimeout = origClear }
  return state
}

// ---------- 事件 → ctx（信封形态同 legacyEventToEnvelope：冻结）----------
let seq = 0
function messageCtx(text, userId, groupId, opts = {}) {
  const segs = []
  if (text !== undefined) segs.push({ type: 'text', data: { text } })
  for (const img of opts.images || []) segs.push({ type: 'image', data: { file: img } })
  const mid = `m${++seq}`
  const ev = groupId
    ? { post_type: 'message', message_type: 'group', group_id: groupId, time: 1, sender: { user_id: userId, nickname: `u${userId}` }, message: segs, message_id: mid }
    : { post_type: 'message', message_type: 'private', time: 1, sender: { user_id: userId, nickname: `u${userId}` }, message: segs, message_id: mid }
  const segments = Object.freeze(ev.message.map((s) => Object.freeze({ type: s.type, data: Object.freeze({ ...s.data }) })))
  const inbound = Object.freeze({
    id: mid,
    protocol: 'onebot:v11',
    type: 'message',
    subType: ev.message_type,
    timestamp: ev.time * 1000,
    sender: Object.freeze({ userId: String(ev.sender.user_id), nickname: ev.sender.nickname }),
    messageId: mid,
    segments,
    rawText: segments.filter((s) => s.type === 'text').map((s) => s.data.text).join(''),
    groupId: ev.group_id != null ? String(ev.group_id) : undefined,
    rawPayload: ev,
  })
  return createContext(inbound, 'onebot')
}

function pokeCtx() {
  const ev = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', time: 1, sender: { user_id: 'p1' } }
  return createContext(Object.freeze({
    id: 'poke-1', protocol: 'onebot:v11', type: 'notice', subType: 'poke', timestamp: 1000,
    sender: undefined, messageId: undefined, segments: Object.freeze([]), rawText: '', groupId: undefined, rawPayload: ev,
  }), 'onebot')
}

// ---------- 装配 ----------
function harness(agg, { holdTerminal = false, terminalReplies = 0 } = {}) {
  const seen = { layers: [], terminals: [], dispatched: [], dropped: [] }
  let releaseTerminal = () => {}
  const gate = new Promise((r) => { releaseTerminal = r })
  const tracing = async (ctx, next) => { seen.layers.push('T>'); await next(); seen.layers.push('<T') }
  // 边界 flush：整轮 next() 返回后才 drain（US-007 语义）；drain 复刻 dispatcher 的发送边界 abort 判定
  const flushBoundary = async (ctx, next) => {
    seen.layers.push('F>')
    await next()
    if (ctx?.reply) {
      const items = [...ctx.reply.queue]
      if (ctx.signal?.aborted) {
        if (items.length) seen.dropped.push(items.length)
        ctx.reply.clear()
      } else if (items.length) {
        for (const it of items) seen.dispatched.push({ ctx, item: it })
        ctx.reply.clear()
      }
    }
    seen.layers.push('<F')
  }
  const egress = async (ctx, next) => { seen.layers.push('E>'); await next(); seen.layers.push('<E') }
  // legacy 终端替身：记录到达的事件；可选卡住（模拟在飞回合）与产出回复（模拟 hooks.send 入队）
  const terminal = async (ctx, next) => {
    seen.terminals.push(ctx)
    if (holdTerminal) await gate
    for (let i = 0; i < terminalReplies; i++) {
      ctx.reply.enqueue({ targetType: ctx.inbound.groupId ? 'group' : 'private', targetId: String(ctx.inbound.sender?.userId ?? ''), segments: [{ type: 'text', data: { text: `回${ctx.inbound.messageId}#${i}` } }] })
    }
    await next()
  }
  const pipeline = compose([tracing, flushBoundary, egress, agg, terminal])
  return { seen, pipeline, releaseTerminal }
}

const drain = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r))
}

function cfgOf(over = {}) {
  const merge = { enabled: true, waitSec: 2.5, maxSec: 8, groupWaitSec: 5, groupMaxSec: 15, ...over }
  return { merge, get: () => ({ merge }) }
}

// ================= ① 连发 3 条合一 =================
test('①连发 3 条合一：lead 收到合并 segments，followers 全 abort 且各自 reply 未外发', async () => {
  const clk = fakeClock(1000)
  const sl = fakeSleep()
  const cfg = cfgOf()
  const agg = createAggregatorMiddleware({ getConfig: cfg.get, clock: clk.now, sleep: sl.fn })
  const { seen, pipeline } = harness(agg, { terminalReplies: 1 })

  // 群聊同一 chat（私聊按用户分 chat，连发合一的场景在群里最典型）
  const c1 = messageCtx('第一句', '111', '9001', { images: ['i1.jpg'] })
  const c2 = messageCtx('第二句', '222', '9001')
  const c3 = messageCtx('第三句', '111', '9001', { images: ['i2.jpg'] })
  const raw1 = c1.inbound.rawPayload
  const p1 = pipeline(c1)
  await drain(2)
  const p2 = pipeline(c2)
  await drain(2)
  const p3 = pipeline(c3)
  await drain(2)

  assert.equal(seen.terminals.length, 0, '挂起期内一条都不许进旧核心')
  assert.equal(sl.pending().length, 1, '同 chat 只保留一笔到期定时器（每条重排 wait）')

  assert.equal(sl.calls.at(-1).ms, 5000, '群窗取 groupWaitSec×1000')
  clk.advance(5000)
  sl.settleAll()
  await Promise.all([p1, p2, p3])

  // —— lead 合并语义：texts 拼接顺序 = 到达序、图片并入 ——
  assert.deepEqual(
    c1.inbound.segments.map((s) => [s.type, s.data.text ?? s.data.file]),
    [['text', '第一句\n第二句\n第三句'], ['image', 'i1.jpg'], ['image', 'i2.jpg']],
    'followers 的 segments 已并入 lead.inbound'
  )
  assert.equal(c1.inbound.rawText, '第一句\n第二句\n第三句')
  assert.equal(c1.inbound.rawPayload, raw1, 'rawPayload 保持 lead 原事件引用（旧核心仍吃原始报文）')
  const meta = c1.state.get(AGGREGATION_KEY)
  assert.equal(meta.count, 3)
  assert.equal(meta.followers, 2)
  assert.deepEqual(meta.senders, ['111', '222'], 'senders 并集按到达序')
  assert.equal(meta.mode, 'must')

  // —— followers：全部 abort，理由 superseded-merged ——
  assert.equal(c2.signal.aborted, true)
  assert.equal(c3.signal.aborted, true)
  assert.equal(String(c2.signal.reason), 'superseded-merged')
  assert.equal(String(c3.signal.reason), 'superseded-merged')

  // —— 外发面：只有 lead 进过旧核心，只有 lead 的回复被 drain ——
  assert.deepEqual(seen.terminals, [c1], 'followers 从未经旧入口（天然安全，不靠回落路径）')
  assert.equal(c2.reply.isEmpty(), true)
  assert.equal(c3.reply.isEmpty(), true)
  assert.equal(seen.dispatched.length, 1, '仅 lead 的回复外发')
  assert.equal(seen.dispatched[0].ctx, c1)
  assert.deepEqual(seen.dropped, [], 'followers 队列本就为空，无需丢弃')

  // —— §2.2 冒泡态：三条事件（含两条 follower）已派发各层的 bubble 全部收尾 ——
  // follower 在 aggregator 层被 abort，其外层 T/F/E 都已派发 → 三层 bubble 各跑一次；
  // 内层的 terminal/dispatcher 两级都不进（上面已断言）。
  const bubbleCounts = ['<T', '<F', '<E'].map((k) => seen.layers.filter((l) => l === k).length)
  assert.deepEqual(bubbleCounts, [3, 3, 3], '三条事件 × T/F/E 三层 bubble 全部收尾')
  assert.equal(seen.layers.filter((l) => l === 'T>').length, 3, '每条事件都进过 tracing')

  // 后续同 chat 事件不受污染：新窗口重新起
  const c4 = messageCtx('第四句', '111', '9001')
  const p4 = pipeline(c4)
  await drain(2)
  assert.equal(sl.pending().length, 1, 'lead 放行后重开新窗')
  clk.advance(5000)
  sl.settleAll()
  await p4
  assert.equal(c4.state.get(AGGREGATION_KEY).count, 1)
  agg.dispose()
})

// ================= ② 轮中补充（busy steer）=================
test('②轮中补充：新事件撞上在飞 lead → 在飞 lead abort + 未 flush 回复计 dropped、新事件作为下一回合 lead 立即开窗', async () => {
  const clk = fakeClock(0)
  const sl = fakeSleep()
  const cfg = cfgOf()
  const agg = createAggregatorMiddleware({ getConfig: cfg.get, clock: clk.now, sleep: sl.fn })
  const { seen, pipeline, releaseTerminal } = harness(agg, { holdTerminal: true })

  const lead = messageCtx('旧回合', 'aaa', undefined)
  const pLead = pipeline(lead)
  await drain(2)
  clk.advance(2500)
  sl.settleAll()
  await drain(3) // lead 放行后卡在旧核心里 = 在飞回合
  assert.deepEqual(seen.terminals, [lead])
  assert.equal(agg.stats().inFlight, 1, '在飞 lead 注册表已建立')
  // 模拟旧核心已经入队但还没 flush 的回复
  lead.reply.enqueue({ targetType: 'private', targetId: 'aaa', segments: [{ type: 'text', data: { text: '旧回合的半截回复' } }] })

  const next = messageCtx('补充：换话题', 'aaa', undefined)
  const pNext = pipeline(next)
  await drain(2)
  assert.equal(lead.signal.aborted, true, '在飞 lead 被中断（合并语义的「取消旧回合」）')
  assert.equal(String(lead.signal.reason), 'superseded')
  assert.equal(agg.stats().steered, 1)

  releaseTerminal() // 旧回合链路继续走完
  await pLead
  assert.deepEqual(seen.dropped, [1], '未 flush 的回复由 dispatcher 发送边界丢弃并计数')
  assert.equal(seen.dispatched.length, 0, '被丢弃的回复一条都不外发')

  // 新事件作为下一回合 lead：立即开窗（不挤进旧窗）
  assert.equal(agg.stats().windows, 1, '下一窗口已开')
  assert.equal(seen.terminals.length, 1, '新回合尚未下行')
  clk.advance(2500)
  sl.settleAll()
  await pNext
  assert.deepEqual(seen.terminals, [lead, next])
  assert.equal(agg.stats().steered, 1)
  agg.dispose()
})

test('②对抗：lead 尚未放行（仍挂窗）时新事件并入同一窗，不触发 steer', async () => {
  const clk = fakeClock(0)
  const sl = fakeSleep()
  const cfg = cfgOf()
  const agg = createAggregatorMiddleware({ getConfig: cfg.get, clock: clk.now, sleep: sl.fn })
  const { seen, pipeline } = harness(agg)
  const a = messageCtx('a', 'x', undefined)
  const pa = pipeline(a)
  await drain(2)
  assert.equal(agg.stats().inFlight, 0)
  const b = messageCtx('b', 'x', undefined)
  const pb = pipeline(b)
  await drain(2)
  assert.equal(agg.stats().steered, 0, '没有在飞回合就谈不上中断')
  assert.equal(seen.terminals.length, 0)
  clk.advance(2500)
  sl.settleAll()
  await Promise.all([pa, pb])
  assert.equal(a.state.get(AGGREGATION_KEY).count, 2)
  agg.dispose()
})

// ================= ③ 超时 flush：wait 与 max 两条路径 =================
test('③wait 路径：每条新消息重排 wait 窗，未到期不下行', async () => {
  const clk = fakeClock(0)
  const sl = fakeSleep()
  const cfg = cfgOf()
  const agg = createAggregatorMiddleware({ getConfig: cfg.get, clock: clk.now, sleep: sl.fn })
  const { seen, pipeline } = harness(agg)

  const c1 = messageCtx('a', 'u1', undefined)
  const p1 = pipeline(c1)
  await drain(2)
  assert.equal(sl.calls.at(-1).ms, 2500, '首窗 waitSec×1000')
  clk.advance(2000)
  const c2 = messageCtx('b', 'u1', undefined)
  const p2 = pipeline(c2)
  await drain(2)
  assert.equal(sl.pending().length, 1, '旧定时器已重排（滑窗而非固定窗）')
  assert.equal(sl.calls.at(-1).ms, 2500)
  assert.equal(seen.terminals.length, 0, 'wait 未到期不放行')

  clk.advance(2500)
  sl.settleAll()
  await Promise.all([p1, p2])
  assert.equal(seen.terminals.length, 1)
  assert.equal(c1.inbound.rawText, 'a\nb')
  agg.dispose()
})

test('③max 路径：wait 反复重置也被 maxSec 余量封顶（首条起算），到期即 flush', async () => {
  const clk = fakeClock(0)
  const sl = fakeSleep()
  const cfg = cfgOf()
  const agg = createAggregatorMiddleware({ getConfig: cfg.get, clock: clk.now, sleep: sl.fn })
  const { seen, pipeline } = harness(agg)

  const c1 = messageCtx('a', 'u1', undefined)
  const p1 = pipeline(c1)
  await drain(2)
  clk.advance(7000) // 距 maxSec=8 只剩 1000
  const c2 = messageCtx('b', 'u1', undefined)
  const p2 = pipeline(c2)
  await drain(2)
  assert.equal(sl.calls.at(-1).ms, 1000, '窗口取 min(wait, max 余量)')
  clk.advance(1000)
  sl.settleAll()
  await Promise.all([p1, p2])
  assert.equal(seen.terminals.length, 1)
  assert.equal(c1.inbound.rawText, 'a\nb')
  assert.equal(c1.state.get(AGGREGATION_KEY).count, 2)

  // 群聊参数口径 + 群 max 余量
  const g1 = messageCtx('g1', 'u1', '777')
  const pg = pipeline(g1)
  await drain(2)
  assert.equal(sl.calls.at(-1).ms, 5000, '群聊取 groupWaitSec×1000')
  clk.advance(12000) // 群 maxSec=15 → 余 3000
  const g2 = messageCtx('g2', 'u2', '777')
  const pg2 = pipeline(g2)
  await drain(2)
  assert.equal(sl.calls.at(-1).ms, 3000, '群聊 max 余量封顶（groupMaxSec 首条起算）')
  clk.advance(3000)
  sl.settleAll()
  await Promise.all([pg, pg2])
  assert.equal(g1.state.get(AGGREGATION_KEY).count, 2)
  agg.dispose()
})

test('③count 上限路径：达 maxCount 立即 flush，不等窗口', async () => {
  const clk = fakeClock(0)
  const sl = fakeSleep()
  const cfg = cfgOf()
  const agg = createAggregatorMiddleware({ getConfig: cfg.get, clock: clk.now, sleep: sl.fn, maxCount: 3 })
  const { seen, pipeline } = harness(agg)
  const p1 = pipeline(messageCtx('a', 'u1', undefined))
  await drain(2)
  const p2 = pipeline(messageCtx('b', 'u1', undefined))
  await drain(2)
  assert.equal(seen.terminals.length, 0)
  const c3 = messageCtx('c', 'u1', undefined)
  const p3 = pipeline(c3)
  await Promise.all([p1, p2, p3]) // 没有 settleAll：靠 count 触发
  assert.equal(seen.terminals.length, 1)
  assert.equal(c3.inbound ? seen.terminals[0].inbound.rawText : '', 'a\nb\nc')
  assert.equal(agg.stats().mergedRounds, 1)
  assert.equal(sl.pending().length, 0, 'count flush 取消了窗口定时器')
  agg.dispose()
})

test('③merge.enabled=false：直通旧入口，不开窗不聚合（AC 开关两态）', async () => {
  const clk = fakeClock(0)
  const sl = fakeSleep()
  const cfg = cfgOf({ enabled: false })
  const agg = createAggregatorMiddleware({ getConfig: cfg.get, clock: clk.now, sleep: sl.fn })
  const { seen, pipeline } = harness(agg)
  const c1 = messageCtx('a', 'u1', undefined)
  const c2 = messageCtx('b', 'u1', undefined)
  await Promise.all([pipeline(c1), pipeline(c2)])
  assert.deepEqual(seen.terminals, [c1, c2], '合流关闭时逐条下行')
  assert.equal(sl.calls.length, 0, 'enabled=false 不建定时器')
  assert.equal(agg.stats().windows, 0)
  assert.equal(c1.state.get(AGGREGATION_KEY), undefined)
  agg.dispose()
})

// ================= ④ mode RANK / 图片≤4 / senders 并集 =================
test('④mode RANK 取最高 + 图片上限 4 + senders 并集（对齐 hub enqueue 语义）', async () => {
  const clk = fakeClock(0)
  const sl = fakeSleep()
  const cfg = cfgOf()
  const modes = new Map()
  const agg = createAggregatorMiddleware({
    getConfig: cfg.get,
    clock: clk.now,
    sleep: sl.fn,
    resolveMode: (inbound) => modes.get(inbound.messageId) || 'must',
  })
  const { seen, pipeline } = harness(agg)
  // 群聊窗口才有「多 sender 并集」；群窗口参数取 groupWaitSec=5
  const d1 = messageCtx('d1', 'u1', '8001', { images: ['a.jpg', 'b.jpg', 'c.jpg'] })
  const d2 = messageCtx('d2', 'u2', '8001', { images: ['d.jpg', 'e.jpg'] })
  const d3 = messageCtx('d3', 'u1', '8001', { images: ['f.jpg'] })
  // lead 从最低档 engaged 起步，followers 逐级抬高
  modes.set(d1.inbound.messageId, 'engaged')
  modes.set(d2.inbound.messageId, 'interject')
  modes.set(d3.inbound.messageId, 'must')

  const p1 = pipeline(d1)
  await drain(2)
  const p2 = pipeline(d2)
  await drain(2)
  const p3 = pipeline(d3)
  await drain(2)
  assert.equal(seen.terminals.length, 0, '三条同窗')
  assert.equal(sl.calls.at(-1).ms, 5000, '群聊窗口用 groupWaitSec')

  clk.advance(5000)
  sl.settleAll()
  await Promise.all([p1, p2, p3])

  const meta = d1.state.get(AGGREGATION_KEY)
  assert.equal(meta.mode, 'must', 'RANK 取最高（engaged < interject < must）')
  assert.equal(meta.count, 3)
  assert.deepEqual(meta.senders, ['u1', 'u2'], 'senders 并集（去重、保到达序）')
  assert.deepEqual(
    d1.inbound.segments.map((s) => [s.type, s.data.text ?? s.data.file]),
    [
      ['text', 'd1\nd2\nd3'],
      ['image', 'a.jpg'],
      ['image', 'b.jpg'],
      ['image', 'c.jpg'],
      ['image', 'd.jpg'],
    ],
    '图片合并上限 4，超出丢弃（同 hub p.images.length < 4）'
  )
  agg.dispose()
})

test('④对抗：纯图片消息不产生 text 段、lead 无文本时按图片段放行', async () => {
  const clk = fakeClock(0)
  const sl = fakeSleep()
  const cfg = cfgOf()
  const agg = createAggregatorMiddleware({ getConfig: cfg.get, clock: clk.now, sleep: sl.fn })
  const { seen, pipeline } = harness(agg)
  const only = messageCtx(undefined, 'u1', undefined, { images: ['x.jpg'] })
  const p = pipeline(only)
  await drain(2)
  clk.advance(2500)
  sl.settleAll()
  await p
  assert.equal(seen.terminals[0], only)
  assert.deepEqual(only.inbound.segments.map((s) => s.type), ['image'])
  assert.equal(only.inbound.rawText, '')
  agg.dispose()
})

// ================= ⑤ dispose =================
test('⑤dispose：清定时器零泄漏 + 挂起 ctx 全部 abort(aggregator-disposed) + 后续事件直接 abort 不下行', async () => {
  const clk = fakeClock(0)
  const cfg = cfgOf()
  const t = timerStub() // 不注入 sleep → 走宿主 setTimeout 路径（真实句柄登记与回收）
  try {
    const agg = createAggregatorMiddleware({ getConfig: cfg.get, clock: clk.now })
    const { seen, pipeline } = harness(agg)
    const c1 = messageCtx('a', 'u1', undefined)
    const c2 = messageCtx('b', 'u1', undefined)
    const p1 = pipeline(c1)
    await drain(2)
    const p2 = pipeline(c2)
    await drain(2)
    assert.equal(t.created, 2, '两条消息各建一笔窗口定时器')
    assert.equal(t.cleared, 1, '第二条重排时清掉了第一条的定时器')
    assert.equal(t.live.size, 1, '同 chat 恒只有一笔存活窗口定时器')
    assert.equal(seen.terminals.length, 0)

    agg.dispose()
    assert.equal(t.live.size, 0, 'dispose 后无存活定时器')
    assert.equal(t.cleared, 2, '全部 clearTimeout')
    await Promise.all([p1, p2])
    assert.equal(c1.signal.aborted, true)
    assert.equal(c2.signal.aborted, true)
    assert.equal(String(c1.signal.reason), 'aggregator-disposed')
    assert.equal(String(c2.signal.reason), 'aggregator-disposed')
    assert.equal(seen.terminals.length, 0, 'dispose 时挂起 lead 不得下行')
    assert.equal(agg.stats().disposedAborts, 2)
    assert.equal(agg.stats().pendingTimers, 0)
    assert.equal(agg.stats().windows, 0)

    // dispose 之后进来的事件：就地 abort，绝不下行
    const c3 = messageCtx('c', 'u1', undefined)
    await pipeline(c3)
    assert.equal(String(c3.signal.reason), 'aggregator-disposed')
    assert.equal(seen.terminals.length, 0)
    // 重复 dispose 幂等：不再新增计数（3 = c1/c2 挂起窗 + c3 事后事件）
    agg.dispose()
    assert.equal(agg.stats().disposedAborts, 3)
  } finally {
    t.restore()
  }
})

test('⑤对抗：在飞回合不受 dispose 影响跑完（只中止挂起窗口），bubble 照常收尾', async () => {
  const clk = fakeClock(0)
  const sl = fakeSleep()
  const cfg = cfgOf()
  const agg = createAggregatorMiddleware({ getConfig: cfg.get, clock: clk.now, sleep: sl.fn })
  const { seen, pipeline, releaseTerminal } = harness(agg, { holdTerminal: true, terminalReplies: 1 })
  const lead = messageCtx('lead', 'u1', undefined)
  const pLead = pipeline(lead)
  await drain(2)
  clk.advance(2500)
  sl.settleAll()
  await drain(3)
  assert.equal(agg.stats().inFlight, 1)

  // 挂起窗口用**另一个** chat（同 chat 会触发 busy steer，那是 ② 的语义）
  const hanging = messageCtx('hang', 'zz', undefined)
  const pH = pipeline(hanging)
  await drain(2)
  assert.equal(agg.stats().windows, 1, 'zz 的新窗口挂起')

  agg.dispose()
  assert.equal(String(hanging.signal.reason), 'aggregator-disposed', '挂起 ctx 被中止')
  assert.equal(lead.signal.aborted, false, '在飞回合不被 dispose 打断')
  releaseTerminal()
  await pLead
  await pH
  assert.equal(seen.dispatched.length, 1, '在飞回合的回复照常外发')
  assert.equal(seen.terminals.length, 1)
})

// ================= 附加：非入站消息不归聊 =================
test('附加：poke/notice 等无群无 sender 的事件直通不聚合、不进注册表', async () => {
  const clk = fakeClock(0)
  const sl = fakeSleep()
  const cfg = cfgOf()
  const agg = createAggregatorMiddleware({ getConfig: cfg.get, clock: clk.now, sleep: sl.fn })
  const { seen, pipeline } = harness(agg)
  const pk = pokeCtx()
  await pipeline(pk)
  assert.ok(seen.terminals.includes(pk), 'poke 直接进旧核心')
  assert.equal(sl.calls.length, 0, '不归聊事件不建窗口定时器')
  assert.equal(agg.stats().windows, 0)
  assert.equal(agg.stats().inFlight, 0)
  agg.dispose()
})
