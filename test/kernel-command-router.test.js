// 命令路由终端中间件（RFC-0001 §2.1 Command Router / §4 Phase 3 / US-011）：
// 命中短路 + 未命中透传 + handler 抛错回退 + 覆盖矩阵诚实回归 + 解析产物结构稳定 + reportStage 打点。
// parse/handlers 全走桩件注入面（唯一例外：⑤④ 借真 src/chat/commands.js parseCommand 钉解析产物口径）；
// 信封经 legacyEventToEnvelope 真装配，形态与 host 开启态逐字节一致（同 kernel-context-mw 口径）。
// 零真 fs、零网络、零真 hub。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compose } from '../src/kernel/compose.js'
import { createContext } from '../src/kernel/context.js'
import { legacyEventToEnvelope } from '../src/kernel/legacy-fallback.js'
import { createTracingMiddleware, getTrace } from '../src/kernel/mw-tracing.js'
import { getCurrentContext } from '../src/kernel/ctx-store.js'
import { createCommandRouterMiddleware, COMMAND_ROUTER_KEY } from '../src/kernel/mw-command-router.js'

// commands.js 顶层只 import core/store.js（按需触盘，本文件仅用纯函数 parseCommand，
// 不会调用 dataDir）；钉一次 AURABOT_DATA_DIR 与 commands.test.js 同款保险。
process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-router-'))
const { parseCommand } = await import('../src/chat/commands.js')

// ---------- 假时钟（manual） ----------
function fakeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms; return t } }
}

// ---------- 事件 → ctx（与 kernel-context-mw 同口径） ----------
let midSeq = 0
function messageCtx({ userId = '777', groupId, text = '早呀', messageId } = {}) {
  const mid = messageId ?? `m${++midSeq}`
  const ev = groupId
    ? { post_type: 'message', message_type: 'group', group_id: groupId, user_id: userId, time: 1, sender: { user_id: userId, nickname: `u${userId}` }, message: [{ type: 'text', data: { text } }], message_id: mid }
    : { post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: userId, time: 1, sender: { user_id: userId, nickname: `u${userId}` }, message: [{ type: 'text', data: { text } }], message_id: mid }
  return createContext(legacyEventToEnvelope(ev), 'onebot')
}

// ---------- 标准桩件：/ping 可外部处理命令 ----------
function pingHandler(seen) {
  return async (cmd, msg, ctx) => {
    seen.push({ cmd, msg, ctx, als: getCurrentContext() })
    ctx.reply.enqueue({
      targetType: msg.kind === 'group' ? 'group' : 'private',
      targetId: msg.chatId,
      segments: [{ type: 'text', data: { text: `pong:${cmd.arg}` } }],
      priority: 'HIGH',
      delayMs: 0,
    })
  }
}
function ownerPingParse(ctx) {
  // host 装配层 parse 桩件形态：斜杠开头 + 解析命中「ping」→ { cmd, msg }。
  // ping 不在内置 COMMANDS，用 ext 注册形态喂 parseCommand 取真解析产物，
  // 再按 host 对「可外部调用的内置命令」的登记语义剥掉 ext 键（产物 shape 同内置 { name, arg }）。
  const inbound = ctx?.inbound
  if (!inbound || inbound.type !== 'message') return null
  const text = String(inbound?.rawText || '')
  if (!/^\s*[/／]/.test(text)) return null
  const extPing = { name: 'ping', aliases: [], desc: 'stub', module: 'stub', run: async () => '' }
  const cmd = parseCommand(text, [extPing])
  if (!cmd || cmd.name !== 'ping') return null
  const groupId = inbound.groupId
  const userId = String(inbound.sender?.userId ?? '')
  const chat = groupId
    ? { chatId: `group:${groupId}`, kind: 'group', groupId: String(groupId), userId }
    : { chatId: `private:${userId}`, kind: 'private', userId }
  return { cmd: { name: cmd.name, arg: cmd.arg }, msg: { ...chat, text } }
}

// =====================================================================
// ① 命中 /ping：handler 收到解析产物、ctx.reply 恰 1 项、下游 persona/aggregator/legacy 计数全 0
// =====================================================================
test('router：命中可外部处理命令 → handler 收到 (cmd,msg,ctx) 与 ALS、reply 恰 1 项、短路后下游计数全 0', async () => {
  const seen = []
  const calls = { persona: 0, memory: 0, aggregator: 0, legacy: 0 }
  const router = createCommandRouterMiddleware({ parse: ownerPingParse, handlers: { ping: pingHandler(seen) } })
  const personaStub = async (ctx, next) => { calls.persona += 1; await next() }
  const memoryStub = async (ctx, next) => { calls.memory += 1; await next() }
  const aggregatorStub = async (ctx, next) => { calls.aggregator += 1; await next() }
  const legacyStub = async () => { calls.legacy += 1 }
  const pipeline = compose([router, personaStub, memoryStub, aggregatorStub, legacyStub])

  const ctx = messageCtx({ text: '/ping 你好' })
  await pipeline(ctx)

  assert.equal(seen.length, 1, 'handler 恰执行一次')
  assert.deepEqual(seen[0].cmd, { name: 'ping', arg: '你好' }, '收到 parseCommand 形状的解析产物')
  assert.equal(seen[0].msg.chatId, 'private:777')
  assert.equal(seen[0].ctx, ctx)
  assert.equal(seen[0].als, ctx, 'handler 必须跑在 runWithContext(ctx) 的 ALS 里（host 回复经旧发送面落 enqueue 的前提）')
  assert.equal(ctx.reply.queue.length, 1, 'ctx.reply 恰 1 项')
  assert.equal(ctx.reply.queue[0].targetId, 'private:777')
  assert.equal(ctx.reply.queue[0].segments[0].data.text, 'pong:你好')
  assert.deepEqual(calls, { persona: 0, memory: 0, aggregator: 0, legacy: 0 }, '终端短路：persona/memory/aggregator/legacy 两级都不进')
  assert.equal(router.stats().intercepted, 1)
  const rec = ctx.state.get(COMMAND_ROUTER_KEY)
  assert.equal(rec.outcome, 'intercepted')
  assert.equal(rec.command, 'ping')
  assert.equal(rec.arg, '你好')
})

test('router：命中后外层中间件 bubble 正常收尾（US-008a unwind 联动：短路=return 不是 abort）', async () => {
  const order = []
  const router = createCommandRouterMiddleware({
    parse: ownerPingParse,
    handlers: { ping: pingHandler([]) },
  })
  const outer = async (ctx, next) => { order.push('outer-entry'); await next(); order.push('outer-bubble') }
  const legacyStub = async () => { order.push('legacy') }
  await compose([outer, router, legacyStub])(messageCtx({ text: '/ping' }))
  assert.deepEqual(order, ['outer-entry', 'outer-bubble'], '外层 bubble 收尾、legacy 不进')
})

// =====================================================================
// ② 未命中普通聊天：透传、reply 零写入
// =====================================================================
test('router：未命中普通聊天 → 透传全链、reply 零写入', async () => {
  const calls = { persona: 0, memory: 0, aggregator: 0, legacy: 0 }
  const router = createCommandRouterMiddleware({ parse: ownerPingParse, handlers: { ping: pingHandler([]) } })
  const ctx = messageCtx({ text: '今天天气不错' })
  await compose([
    router,
    async (c, n) => { calls.persona += 1; await n() },
    async (c, n) => { calls.memory += 1; await n() },
    async (c, n) => { calls.aggregator += 1; await n() },
    async (c, n) => { calls.legacy += 1 },
  ])(ctx)
  assert.deepEqual(calls, { persona: 1, memory: 1, aggregator: 1, legacy: 1 }, '未命中必须原样透传（含 reply 由 legacy 走旧路径产生）')
  assert.equal(ctx.reply.queue.length, 0, 'router 本身对透传流量零写入')
  assert.equal(router.stats().passthrough, 1)
  assert.equal(ctx.state.get(COMMAND_ROUTER_KEY).outcome, 'no-command')
})

// =====================================================================
// ③ handler 抛错：不炸管道、回滚半途入队、透传 legacy、打点与计数有 err
// =====================================================================
test('router：handler 抛错 → 不炸管道、回滚半途入队、透传 legacy、计数与打点在案', async () => {
  const stages = []
  const warns = []
  const badHandler = async (cmd, msg, ctx) => {
    ctx.reply.enqueue({ targetType: 'private', targetId: msg.chatId, segments: [{ type: 'text', data: { text: '半途的回复' } }], priority: 'NORMAL', delayMs: 0 })
    throw new Error('配置炸了')
  }
  const router = createCommandRouterMiddleware({
    parse: ownerPingParse,
    handlers: { ping: badHandler },
    log: { warn: (m) => warns.push(m) },
    reportStage: (n, ms) => stages.push([n, ms]),
    clock: fakeClock(0).now,
  })
  let legacyRan = false
  const ctx = messageCtx({ text: '/ping x' })
  // compose 不 reject 即「没炸管道」；Promise resolve 正常返回就是验收本体
  await compose([router, async () => { legacyRan = true }])(ctx)
  assert.equal(legacyRan, true, '抛错后必须透传 legacy 兜底')
  assert.equal(ctx.reply.queue.length, 0, '半途入队已回滚（避免与 legacy 回复双发）')
  assert.equal(router.stats().handlerErrors, 1)
  assert.equal(router.stats().intercepted, 0)
  assert.match(warns.join('\n'), /配置炸了/)
  assert.ok(stages.some(([n]) => n === 'router'), '打点含 router 判定段')
  assert.ok(stages.some(([n]) => n === 'router-handler'), '打点含 router-handler 执行段（抛错也照报）')
  const rec = ctx.state.get(COMMAND_ROUTER_KEY)
  assert.equal(rec.outcome, 'handler-error')
  assert.equal(rec.reason, '配置炸了', 'reason 存 message 口径（同 mw 头注）')
})

test('router：抛错且无入队增量时不改 queue（无可回滚项），仍透传 legacy', async () => {
  const router = createCommandRouterMiddleware({
    parse: ownerPingParse,
    handlers: { ping: async () => { throw new Error('起手就炸') } },
  })
  let legacyRan = false
  const ctx = messageCtx({ text: '/ping' })
  await compose([router, async () => { legacyRan = true }])(ctx)
  assert.equal(legacyRan, true)
  assert.equal(ctx.reply.queue.length, 0)
  assert.equal(router.stats().handlerErrors, 1)
})

// =====================================================================
// ④ 覆盖矩阵回归：ext 模块命令（矩阵「透传 legacy」列的真命令）router 不接管
// =====================================================================
test('router：ext 模块命令（如 /天气）不接管——handlers 未登记即透传，矩阵诚实位', async () => {
  // 真 parseCommand + 真 extra 形状（host 装配传 mods.commands()；这里桩一个天气模块）
  const extWeather = { name: 'weather', aliases: ['天气'], desc: '查天气', module: 'weather', run: async () => '晴' }
  const parsed = parseCommand('/天气 曼谷', [extWeather])
  assert.ok(parsed && parsed.ext === extWeather, '前提：真解析产物带 ext')
  // host parse 规则：cmd.ext → null（不产出接管对）。这里直钉中间件侧行为：
  // 即便装配层把 ext 命令送进来，handlers 无 'weather' 键也必须 noHandler 透传。
  const router = createCommandRouterMiddleware({
    parse: () => ({ cmd: parsed, msg: { chatId: 'private:777', kind: 'private', userId: '777', text: '/天气 曼谷' } }),
    handlers: { ping: pingHandler([]) },
  })
  let legacyRan = false
  const ctx = messageCtx({ text: '/天气 曼谷' })
  await compose([router, async () => { legacyRan = true }])(ctx)
  assert.equal(legacyRan, true, 'ext 命令必须留给 legacy 执行')
  assert.equal(ctx.reply.queue.length, 0, 'router 不假接管、不代发')
  assert.equal(router.stats().intercepted, 0)
  assert.equal(router.stats().noHandler, 1)
  assert.equal(ctx.state.get(COMMAND_ROUTER_KEY).outcome, 'no-handler')
})

// =====================================================================
// ⑤ 带参命令解析产物结构稳定（引用编号/多参数），真 parseCommand 钉口径
// =====================================================================
test('router：带参命令解析产物结构稳定（/model 2 引用编号、/sing 多参数、全角与中文别名连写）', async () => {
  // 解析产物口径 = commands.js 契约：内置命令恰 { name, arg } 两键，arg 已 trim
  assert.deepStrictEqual(parseCommand('/model 2'), { name: 'model', arg: '2' })
  assert.deepStrictEqual(parseCommand('/sing 小幸运 田馥甄 +12'), { name: 'sing', arg: '小幸运 田馥甄 +12' })
  assert.deepStrictEqual(parseCommand('/remember 我不吃香菜'), { name: 'remember', arg: '我不吃香菜' })
  assert.deepStrictEqual(parseCommand('／闭嘴 30'), { name: 'silent', arg: '30' })
  assert.deepStrictEqual(parseCommand('/记住 明天拿快递'), { name: 'remember', arg: '明天拿快递' })

  const seen = []
  const router = createCommandRouterMiddleware({
    parse: (ctx) => {
      const cmd = parseCommand(String(ctx.inbound?.rawText || ''))
      if (!cmd) return null
      return { cmd, msg: { chatId: 'private:777', kind: 'private', userId: '777', text: ctx.inbound.rawText } }
    },
    handlers: { model: pingHandler(seen), sing: pingHandler(seen) },
  })
  await compose([router, async () => {}])(messageCtx({ text: '/model 2' }))
  await compose([router, async () => {}])(messageCtx({ text: '/sing 小幸运 田馥甄 +12' }))
  assert.deepEqual(seen.map((s) => s.cmd), [{ name: 'model', arg: '2' }, { name: 'sing', arg: '小幸运 田馥甄 +12' }])
  assert.equal(router.stats().intercepted, 2)
})

test('router：handler 空回复（零入队增量）→ 复刻 legacy「继续当聊天」透传下游', async () => {
  const router = createCommandRouterMiddleware({
    parse: ownerPingParse,
    handlers: { ping: async () => { /* 处理了但没要发的话，legacy reply='' 形态 */ } },
  })
  let legacyRan = false
  const ctx = messageCtx({ text: '/ping' })
  await compose([router, async () => { legacyRan = true }])(ctx)
  assert.equal(legacyRan, true)
  assert.equal(router.stats().intercepted, 0)
  assert.equal(router.stats().fellThrough, 1)
})

// =====================================================================
// ⑥ reportStage('router') 上报 + 缺省 traceStage 退化 + parse fail-open
// =====================================================================
test('router：注入 reportStage 时每次判定都上报 router 段、命中加报 router-handler 段', async () => {
  const clk = fakeClock(100)
  const stages = []
  const router = createCommandRouterMiddleware({
    parse: ownerPingParse,
    handlers: { ping: pingHandler([]) },
    reportStage: (n, ms) => stages.push([n, ms]),
    clock: clk.now,
  })
  await compose([router, async () => {}])(messageCtx({ text: '/ping' }))
  await compose([router, async () => {}])(messageCtx({ text: '普通聊天' }))
  assert.deepEqual(stages, [['router', 0], ['router-handler', 0], ['router', 0]],
    '注入 clock 恒值 → ms=0；判定段每事件恰一次，执行段仅命中时')
})

test('router：缺省 reportStage 走 traceStage——真 tracing 链里 stages 含 router/router-handler', async () => {
  const router = createCommandRouterMiddleware({ parse: ownerPingParse, handlers: { ping: pingHandler([]) } })
  const ctx = messageCtx({ text: '/ping hi' })
  await compose([createTracingMiddleware({}), router, async () => {}])(ctx)
  const names = getTrace(ctx).stages.map((x) => x.name)
  assert.ok(names.includes('router') && names.includes('router-handler'), `trace stages 应在案，实际 ${names.join(',')}`)
})

test('router：parse 抛错 → fail-open 透传，不炸管道、计数在案', async () => {
  const router = createCommandRouterMiddleware({
    parse: () => { throw new Error('解析面炸了') },
    handlers: { ping: pingHandler([]) },
  })
  let legacyRan = false
  const ctx = messageCtx({ text: '/ping' })
  await compose([router, async () => { legacyRan = true }])(ctx)
  assert.equal(legacyRan, true)
  assert.equal(router.stats().parseErrors, 1)
  assert.equal(ctx.state.get(COMMAND_ROUTER_KEY).outcome, 'parse-error')
})

test('router：未接 parse / 裸 ctx（无 queue/state 槽）退化不炸链', async () => {
  const bare = createCommandRouterMiddleware({})
  let reached = false
  await bare({ reply: undefined, state: undefined, signal: undefined }, async () => { reached = true })
  assert.equal(reached, true, '缺省 parse 全透传')
  // 命中但 ctx.reply 无 queue getter：无法探测增量，按接管语义保守短路
  const weirdCtx = { reply: { enqueue() {} }, state: { set() {} } }
  const router = createCommandRouterMiddleware({
    parse: () => ({ cmd: { name: 'ping', arg: '' }, msg: {} }),
    handlers: { ping: async () => {} },
  })
  let legacyRan = false
  await compose([router, async () => { legacyRan = true }])(weirdCtx)
  assert.equal(legacyRan, false)
  assert.equal(router.stats().intercepted, 1)
})

test('router：群聊命中 → enqueue 目标形态跟 chat（group 目标），msg 带 groupId', async () => {
  const seen = []
  const router = createCommandRouterMiddleware({ parse: ownerPingParse, handlers: { ping: pingHandler(seen) } })
  const ctx = messageCtx({ groupId: '555', text: '/ping 群里' })
  await compose([router, async () => {}])(ctx)
  assert.equal(seen[0].msg.kind, 'group')
  assert.equal(seen[0].msg.groupId, '555')
  assert.equal(ctx.reply.queue[0].targetType, 'group')
  assert.equal(ctx.reply.queue[0].targetId, 'group:555')
})
