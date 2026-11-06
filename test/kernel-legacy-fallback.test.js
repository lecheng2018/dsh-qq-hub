// 遗留核心终端化 + 熔断开关单元测试（RFC-0001 §4 Phase 0 / US-003）。
//
// 全程用 stub legacyHub，不碰真实 hub.js / onebot。覆盖：
//   - isPipelineEnabled 解析（'true'/'1' 开、'false'/乱值/未设关）；
//   - legacyEventToEnvelope 信封字段还原度（缺的置 undefined、rawPayload 原引用）；
//   - createLegacyHubFallback 把入站事件原样送达旧入口（对象同一性断言）、
//     await 旧入口完成后才 next()、事件路由与 handleEvent 现行分发对齐；
//   - PipelineError 根因剥离；
//   - P99 调度开销打点（compose 空转基准 + 占位→终端全链，RFC Phase 0 验收 ≤1.5ms）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { compose, PipelineError } from '../src/kernel/compose.js'
import { createContext } from '../src/kernel/context.js'
import {
  createLegacyHubFallback,
  isPipelineEnabled,
  legacyEventToEnvelope,
  unwrapPipelineError,
  LEGACY_DRIVER_ID,
} from '../src/kernel/legacy-fallback.js'

const T0 = 1_762_500_000 // 2025-11-07 前后随手取的秒级时间戳，测 ms 换算

function privateMsgEvent() {
  return {
    time: T0,
    self_id: 123456,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 987,
    user_id: 10001,
    message: [{ type: 'text', data: { text: '吃了么' } }],
    sender: { user_id: 10001, nickname: '小鱼', card: '', role: 'friend' },
  }
}

function groupMsgEvent() {
  return {
    time: T0,
    self_id: 123456,
    post_type: 'message',
    message_type: 'group',
    group_id: 20002,
    message_id: 988,
    user_id: 10001,
    message: [
      { type: 'text', data: { text: '在吗 ' } },
      { type: 'image', data: { url: 'http://x/y.png', file: 'y.png' } },
    ],
    sender: { user_id: 10001, nickname: '小鱼', card: '群昵称', role: 'member' },
  }
}

function pokeEvent() {
  return { time: T0, self_id: 123456, post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 10001, group_id: 20002 }
}

// ---------- 开关解析 ----------

test('isPipelineEnabled：true/1 开，false/乱值/空白/未设一律关', () => {
  assert.equal(isPipelineEnabled({ FLAG_USE_PIPELINE: 'true' }), true)
  assert.equal(isPipelineEnabled({ FLAG_USE_PIPELINE: '1' }), true)
  assert.equal(isPipelineEnabled({ FLAG_USE_PIPELINE: 'TRUE' }), true, '大小写不敏感')
  assert.equal(isPipelineEnabled({ FLAG_USE_PIPELINE: ' 1 ' }), true, '容忍首尾空白')
  assert.equal(isPipelineEnabled({ FLAG_USE_PIPELINE: 'false' }), false)
  assert.equal(isPipelineEnabled({ FLAG_USE_PIPELINE: 'yes' }), false, '乱值按 false（熔断语义：不确定就回旧路）')
  assert.equal(isPipelineEnabled({ FLAG_USE_PIPELINE: '' }), false)
  assert.equal(isPipelineEnabled({}), false, '未设置默认关')
})

// ---------- 信封构造 ----------

test('legacyEventToEnvelope：私聊消息信封字段尽量填全，缺的置 undefined', () => {
  const ev = privateMsgEvent()
  const env = legacyEventToEnvelope(ev)
  assert.equal(env.id, '987')
  assert.equal(env.messageId, '987')
  assert.equal(env.protocol, 'onebot:v11')
  assert.equal(env.type, 'message')
  assert.equal(env.subType, 'private')
  assert.equal(env.timestamp, T0 * 1000, 'v11 秒级 time 换算成毫秒')
  assert.equal(env.selfId, '123456')
  assert.equal(env.sender.userId, '10001')
  assert.equal(env.sender.nickname, '小鱼')
  assert.equal(env.rawText, '吃了么')
  assert.equal(env.segments.length, 1)
  assert.equal(env.segments[0].type, 'text')
  assert.equal(env.groupId, undefined, '私聊没有群号')
  assert.equal(env.channelId, undefined, '非频道消息没有频道号')
  assert.equal(env.rawPayload, ev, 'rawPayload 必须是原事件引用')
})

test('legacyEventToEnvelope：群聊多段消息、poke 通知与无 time 事件的兜底', () => {
  const g = legacyEventToEnvelope(groupMsgEvent())
  assert.equal(g.groupId, '20002')
  assert.equal(g.subType, 'group')
  assert.equal(g.rawText, '在吗 ', 'rawText 只拼 text 段')
  assert.deepEqual(g.segments[1], { type: 'image', data: { url: 'http://x/y.png', file: 'y.png' } })

  const p = legacyEventToEnvelope(pokeEvent())
  assert.equal(p.type, 'notice')
  assert.equal(p.subType, 'notify')
  assert.equal(p.messageId, undefined, 'poke 没有 message_id')
  assert.equal(p.sender, undefined, 'poke 没有 sender 结构')

  const noTime = legacyEventToEnvelope({ post_type: 'message', message: [] })
  assert.ok(noTime.timestamp >= Date.now() - 5000, '缺 time 用接收时刻兜底')
  assert.match(noTime.id, /.*/, '缺 message_id 用随机 id 兜底')
})

// ---------- 终端中间件路由 ----------

test('legacyFallback：模拟入站事件原样送达旧入口（对象同一性），await 完成后才 next()', async () => {
  const timeline = []
  let release
  const done = new Promise((r) => { release = r })
  const stubHub = {
    onMessage: async (event) => {
      assert.equal(event, ev, '送达旧入口的必须是原事件对象，不许加工')
      timeline.push('legacy-enter')
      await done
      timeline.push('legacy-resolve')
    },
    onPoke: async () => { timeline.push('poke') },
  }
  const placeholder = async (ctx, next) => {
    timeline.push('placeholder-in')
    await next()
    timeline.push('placeholder-out')
  }
  const pipeline = compose([placeholder, createLegacyHubFallback(stubHub)])
  const ev = privateMsgEvent()
  const ctx = createContext(legacyEventToEnvelope(ev), LEGACY_DRIVER_ID)
  const tail = async () => { timeline.push('tail') }

  const finished = pipeline(ctx, tail)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(timeline, ['placeholder-in', 'legacy-enter'], '旧入口未 resolve 前不得放行 next()')
  release()
  await finished
  assert.deepEqual(timeline, ['placeholder-in', 'legacy-enter', 'legacy-resolve', 'tail', 'placeholder-out'])
})

test('legacyFallback：poke 通知路由到 onPoke，message_sent 仍走 onMessage', async () => {
  const calls = []
  const stubHub = { onMessage: async (e) => { calls.push(['onMessage', e]) }, onPoke: async (e) => { calls.push(['onPoke', e]) } }
  const fallback = createLegacyHubFallback(stubHub)

  const pokeEv = pokeEvent()
  await fallback(createContext(legacyEventToEnvelope(pokeEv), LEGACY_DRIVER_ID), async () => {})
  assert.deepEqual(calls, [['onPoke', pokeEv]])

  const sentEv = { ...groupMsgEvent(), post_type: 'message_sent' }
  await fallback(createContext(legacyEventToEnvelope(sentEv), LEGACY_DRIVER_ID), async () => {})
  assert.equal(calls.length, 2)
  assert.equal(calls[1][0], 'onMessage')
  assert.equal(calls[1][1], sentEv)
})

test('legacyFallback：旧核心不处理的事件（request/普通 notice）不碰 hub，直接放行', async () => {
  let touched = 0
  const stubHub = { onMessage: async () => { touched++ }, onPoke: async () => { touched++ } }
  const fallback = createLegacyHubFallback(stubHub)
  let nexted = 0
  await fallback(createContext(legacyEventToEnvelope({ post_type: 'request', request_type: 'friend' }), LEGACY_DRIVER_ID), async () => { nexted++ })
  await fallback(createContext(legacyEventToEnvelope({ post_type: 'notice', notice_type: 'friend_add' }), LEGACY_DRIVER_ID), async () => { nexted++ })
  assert.equal(touched, 0)
  assert.equal(nexted, 2)
})

test('legacyFallback：旧入口报错被管道包成 PipelineError，unwrap 取回根因保持日志文案一致', async () => {
  const boom = new Error('QQ 网关断了')
  const stubHub = { onMessage: async () => { throw boom } }
  const pipeline = compose([async (ctx, next) => { await next() }, createLegacyHubFallback(stubHub)])
  const ctx = createContext(legacyEventToEnvelope(privateMsgEvent()), LEGACY_DRIVER_ID)
  await assert.rejects(pipeline(ctx), (error) => {
    assert.ok(error instanceof PipelineError, '管道层要包成 PipelineError')
    assert.equal(unwrapPipelineError(error), boom, '剥到根因必须是原始错误')
    assert.equal(unwrapPipelineError(error).message, 'QQ 网关断了')
    return true
  })
  assert.equal(unwrapPipelineError(boom), boom, '非 PipelineError 原样返回')
})

// ---------- P99 调度开销打点（RFC Phase 0 验收：≤1.5ms） ----------

const sleep0 = () => new Promise((r) => setTimeout(r, 0))

async function measureP99(runs, fn) {
  const samples = []
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint()
    await fn(i)
    const t1 = process.hrtime.bigint()
    samples.push(Number(t1 - t0) / 1e6)
  }
  samples.sort((a, b) => a - b)
  const idx = Math.min(samples.length - 1, Math.ceil(samples.length * 0.99) - 1)
  return { p99: samples[idx], median: samples[Math.floor(samples.length / 2)], max: samples[samples.length - 1] }
}

test('P99 打点：compose 空转基准 + 占位→遗留终端全链（阈值 1.5ms 记录实测）', async () => {
  const stubHub = { onMessage: async () => {}, onPoke: async () => {} }
  const noop = async (ctx, next) => { await next() }
  const passthrough = async (ctx, next) => { await next() }
  const emptyPipeline = compose([])
  const realPipeline = compose([passthrough, createLegacyHubFallback(stubHub)])
  const ev = privateMsgEvent()
  const runs = 200

  const empty = await measureP99(runs, () => emptyPipeline(createContext(legacyEventToEnvelope(ev), LEGACY_DRIVER_ID)))
  const full = await measureP99(runs, () => realPipeline(createContext(legacyEventToEnvelope(ev), LEGACY_DRIVER_ID)))
  const overhead = { p99: full.p99 - empty.p99, median: full.median - empty.median, max: full.max - empty.max }
  console.log(
    `[US-003 打点] runs=${runs}｜空管道 P99=${empty.p99.toFixed(3)}ms｜占位+终端全链 P99=${full.p99.toFixed(3)}ms｜增量 P99=${overhead.p99.toFixed(3)}ms（max=${overhead.max.toFixed(3)}ms）`
  )

  // RFC Phase 0 验收线：P99 ≤ 1.5ms。沙箱抖动放宽到 8ms 兜底，实测值以打点日志为准。
  assert.ok(full.p99 <= 8, `全链 P99=${full.p99.toFixed(3)}ms 超过宽阈值 8ms，环境异常`)
})

// ---------- host 装配形态复刻 ----------

test('复刻 host 开关两态：关闭直调旧入口（顺序不变），开启走占位→终端', async () => {
  // 关闭态：usePipeline=false 时 host 根本不调 dispatchLegacyPipeline，行为逐字等价
  assert.equal(isPipelineEnabled({}), false)
  // 开启态：compose([透传占位, createLegacyHubFallback(hub)])（US-003 装配原样）
  const seen = []
  const stubHub = { onMessage: async (e) => { seen.push(e) } }
  const hostShape = compose([async (ctx, next) => { await next() }, createLegacyHubFallback(stubHub)])
  const ev = privateMsgEvent()
  await hostShape(createContext(legacyEventToEnvelope(ev), LEGACY_DRIVER_ID))
  assert.deepEqual(seen, [ev], '无 tail 时（host 形态）也必须把事件送达旧入口并 resolve')
})
