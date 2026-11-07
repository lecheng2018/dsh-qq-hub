// 上下文装配中间件（RFC-0001 §4 Phase 3 / US-010）：persona 预取 + memory 检索 +
// contextProviders takeover 接管 + abort unwind 联动 + G4 reportStage 打点。
// 人设源/记忆模块全部走注入面桩件；假时钟；零真 fs、零网络、零真 hub。
// 信封经 legacyEventToEnvelope 真装配，形态与 host 开启态逐字节一致（同 kernel-ingress-guard 口径）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compose } from '../src/kernel/compose.js'
import { createContext } from '../src/kernel/context.js'
import { legacyEventToEnvelope } from '../src/kernel/legacy-fallback.js'
import { createTracingMiddleware, getTrace } from '../src/kernel/mw-tracing.js'
import { ctxStore, runWithContext } from '../src/kernel/ctx-store.js'
import { createPersonaInjector, chatFromInbound, PERSONA_KEY } from '../src/kernel/mw-persona.js'
import {
  createMemoryRetriever, createContextProviderTakeover, isNewMemoryPipelineEnabled,
  MEMORY_KEY, STATE_DEGRADED,
} from '../src/kernel/mw-memory.js'

// ---------- 假时钟（manual） ----------
function fakeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms; return t } }
}

// ---------- 事件 → ctx（group_id 是字符串口径同 legacyEventToEnvelope） ----------
let midSeq = 0
function messageCtx({ userId = '777', groupId, text = 'hi', messageId } = {}) {
  const mid = messageId ?? `m${++midSeq}`
  const ev = groupId
    ? { post_type: 'message', message_type: 'group', group_id: groupId, user_id: userId, time: 1, sender: { user_id: userId, nickname: `u${userId}` }, message: [{ type: 'text', data: { text } }], message_id: mid }
    : { post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: userId, time: 1, sender: { user_id: userId, nickname: `u${userId}` }, message: [{ type: 'text', data: { text } }], message_id: mid }
  return createContext(legacyEventToEnvelope(ev), 'onebot')
}
function noticeCtx({ userId = '777' } = {}) {
  // 无 sender 结构的请求类事件：不可归聊（fail-closed 用例主体）
  const ev = { post_type: 'request', request_type: 'friend', time: 1 }
  return createContext(legacyEventToEnvelope(ev), 'onebot')
}

// =====================================================================
// ① persona：群/私聊解析到不同配置、热改 stub 源下一事件即生效（零重启）
// =====================================================================
test('persona：群/私聊按 ctx.inbound 归聊解析到不同人设配置', async () => {
  const src = {
    groups: { '55': 'cool-guy' },
    privates: { '777': 'owner-buddy' },
    current: 'dafeiyu',
  }
  const getPersona = (chat) => {
    const id = chat.kind === 'group'
      ? (src.groups[chat.groupId] || src.current)
      : (src.privates[chat.userId] || src.current)
    return { id, name: `N-${id}`, body: `BODY-${id}` }
  }
  const mw = createPersonaInjector({ getPersona })

  const g = messageCtx({ groupId: '55' })
  await mw(g, async () => {})
  const gr = g.state.get(PERSONA_KEY)
  assert.equal(gr.ok, true)
  assert.equal(gr.id, 'cool-guy')
  assert.equal(gr.kind, 'group')
  assert.equal(gr.chatId, 'group:55')
  assert.equal(gr.body, 'BODY-cool-guy')

  const p = messageCtx({ userId: '777' })
  await mw(p, async () => {})
  const pr = p.state.get(PERSONA_KEY)
  assert.equal(pr.ok, true)
  assert.equal(pr.id, 'owner-buddy')
  assert.equal(pr.kind, 'private')
  assert.equal(pr.chatId, 'private:777')

  assert.deepEqual(mw.stats(), { injected: 2, degraded: 0, errors: 0 })
})

test('persona：热改 stub 源下一事件即生效（每次实时读取=天然热重载，零重启零新建实例）', async () => {
  let current = 'A'
  const getPersona = () => ({ id: current, body: `body-${current}` })
  const mw = createPersonaInjector({ getPersona }) // 同一实例，不重建

  const e1 = messageCtx({ userId: '111' })
  await mw(e1, async () => {})
  assert.equal(e1.state.get(PERSONA_KEY).id, 'A')

  current = 'B' // 面板改卡：桩件源直接换值
  const e2 = messageCtx({ userId: '111' })
  await mw(e2, async () => {})
  assert.equal(e2.state.get(PERSONA_KEY).id, 'B')
  assert.equal(e2.state.get(PERSONA_KEY).body, 'body-B')
})

test('persona：不可归聊事件写空装配（fail-closed），不炸管道', async () => {
  const calls = []
  const mw = createPersonaInjector({
    getPersona: (chat) => { calls.push(chat); return { id: 'x', body: '' } },
    clock: () => 123,
  })
  const n = noticeCtx()
  let reached = false
  await mw(n, async () => { reached = true })
  assert.equal(reached, true, '装配失败绝不能吞掉后续链')
  assert.deepEqual(calls, [], '不可归聊不该打人设源')
  const rec = n.state.get(PERSONA_KEY)
  assert.equal(rec.ok, false)
  assert.equal(rec.degraded, true)
  assert.equal(rec.reason, 'unresolved-chat')
  assert.equal(rec.at, 123)
  assert.equal(mw.stats().degraded, 1)
})

test('persona：人设源抛错→空装配+计数，管道继续', async () => {
  const dbg = []
  const mw = createPersonaInjector({
    getPersona: () => { throw new Error('卡文件坏了') },
    log: { debug: (m) => dbg.push(m) },
  })
  const c = messageCtx({ userId: '222' })
  let reached = false
  await mw(c, async () => { reached = true })
  assert.equal(reached, true)
  const rec = c.state.get(PERSONA_KEY)
  assert.equal(rec.degraded, true)
  assert.equal(rec.reason, 'persona-source-error')
  assert.equal(rec.body, '')
  assert.equal(mw.stats().errors, 1)
  assert.ok(dbg.some((m) => m.includes('fail-closed')))
})

// =====================================================================
// ② memory：contextFor 调用参数与 scope 断言、fail-closed、抛错不炸管道
// =====================================================================
function stubMemory(text = 'MEM-CTX') {
  const cfCalls = []
  const lfCalls = []
  return {
    cfCalls,
    lfCalls,
    api: {
      contextFor: (chat, sessionId) => { cfCalls.push({ chat, sessionId }); return text },
      listFor: (scopes, opts) => { lfCalls.push({ scopes, opts }); return [{ text: 'evt-1' }] },
    },
  }
}

test('memory：群聊 contextFor 参数=归聊 chat 对象、listFor scopes=group:<gid>、结果入 state', async () => {
  const s = stubMemory('GROUP-MEM')
  const clock = fakeClock(1000)
  const mw = createMemoryRetriever({ memory: s.api, now: clock.now })
  const c = messageCtx({ groupId: '55', userId: '777' })
  await mw(c, async () => {})

  assert.equal(s.cfCalls.length, 1)
  const { chat, sessionId } = s.cfCalls[0]
  assert.equal(chat.kind, 'group')
  assert.equal(chat.groupId, '55')
  assert.equal(chat.chatId, 'group:55')
  assert.equal(sessionId, undefined, '管道 ctx 不持 DSH 会话 id：显式 undefined（speakersOf 兜 []）')
  assert.deepEqual(s.lfCalls[0].scopes, ['group:55'])
  const rec = c.state.get(MEMORY_KEY)
  assert.equal(rec.ok, true)
  assert.equal(rec.text, 'GROUP-MEM')
  assert.deepEqual(rec.items, [{ text: 'evt-1' }])
  assert.deepEqual(rec.scopes, ['group:55'])
  assert.equal(rec.at, 1000)
  assert.equal(c.state.has(STATE_DEGRADED), false)
})

test('memory：私聊 scope=private:<uid>；不同聊各自装配不串味', async () => {
  const s = stubMemory('P-MEM')
  const mw = createMemoryRetriever({ memory: s.api })
  const a = messageCtx({ userId: '777' })
  const b = messageCtx({ userId: '888' })
  await mw(a, async () => {})
  await mw(b, async () => {})
  assert.deepEqual(s.lfCalls.map((x) => x.scopes), [['private:777'], ['private:888']])
  assert.equal(a.state.get(MEMORY_KEY).scopes[0], 'private:777')
  assert.equal(b.state.get(MEMORY_KEY).scopes[0], 'private:888')
})

test('memory：fail-closed——无作用域事件返回空装配 + state degraded 标记，零次打搅记忆模块', async () => {
  const s = stubMemory()
  const mw = createMemoryRetriever({ memory: s.api })
  const n = noticeCtx()
  let reached = false
  await mw(n, async () => { reached = true })
  assert.equal(reached, true)
  assert.deepEqual(s.cfCalls, [])
  assert.deepEqual(s.lfCalls, [])
  const rec = n.state.get(MEMORY_KEY)
  assert.equal(rec.text, '')
  assert.equal(rec.degraded, true)
  assert.equal(rec.reason, 'unresolved-scope')
  assert.equal(n.state.get(STATE_DEGRADED), true)
})

test('memory：检索抛错→空装配不炸管道 + degraded（fail-closed 防线）', async () => {
  const dbg = []
  const boom = {
    contextFor: () => { throw new Error('sqlite 炸了') },
    listFor: () => [],
  }
  const mw = createMemoryRetriever({ memory: boom, log: { debug: (m) => dbg.push(m) } })
  const c = messageCtx({ userId: '333' })
  let reached = false
  await mw(c, async () => { reached = true })
  assert.equal(reached, true, '检索故障绝不能吃掉回复链')
  const rec = c.state.get(MEMORY_KEY)
  assert.equal(rec.degraded, true)
  assert.equal(rec.text, '')
  assert.equal(rec.reason, 'retrieval-error')
  assert.equal(c.state.get(STATE_DEGRADED), true)
  assert.equal(mw.stats().errors, 1)
  assert.ok(dbg.some((m) => m.includes('sqlite 炸了')))
})

test('memory：注入面缺失（模块没起）→空装配 degraded，不抛', async () => {
  const mw = createMemoryRetriever({ memory: null })
  const c = messageCtx({ userId: '444' })
  await mw(c, async () => {})
  assert.equal(c.state.get(MEMORY_KEY).reason, 'memory-unavailable')
  assert.equal(c.state.get(STATE_DEGRADED), true)
})

// =====================================================================
// ③ 包装接管：ALS 内 ctx+state+flag on → state 缓存且原 provider 零调用；
//    flag off → 原 provider 被调；无 ctx → 原路径
// =====================================================================
function takeoverCtx(text) {
  const c = messageCtx({ userId: '555' })
  c.state.set(MEMORY_KEY, { ok: true, degraded: false, text, scopes: ['private:555'] })
  return c
}

test('takeover：ALS 有 ctx + state 装配 + flag on → 返回 state 缓存，原 provider 零调用', async () => {
  let orig = 0
  const wrapper = createContextProviderTakeover({
    provider: () => { orig += 1; return 'LEGACY' },
    isNewPipeline: () => true,
  })
  const c = takeoverCtx('CACHED')
  const out = runWithContext(c, () => wrapper({ chat: { kind: 'private' }, sessionId: 'sid-1' }))
  assert.equal(out, 'CACHED')
  assert.equal(orig, 0)
})

test('takeover：flag off → 原 provider 被调（legacy 回退分支必须存在且默认关）', () => {
  let orig = 0
  const wrapper = createContextProviderTakeover({
    provider: () => { orig += 1; return 'LEGACY' },
    isNewPipeline: () => false,
  })
  const c = takeoverCtx('CACHED')
  const out = runWithContext(c, () => wrapper({ chat: {} }))
  assert.equal(out, 'LEGACY')
  assert.equal(orig, 1)
})

test('takeover：无 ALS ctx（旁路入口/backfill/flag-off 直调）→ 原路径', () => {
  let orig = 0
  const wrapper = createContextProviderTakeover({
    provider: () => { orig += 1; return 'LEGACY' },
    isNewPipeline: () => true,
  })
  assert.equal(wrapper({ chat: {} }), 'LEGACY')
  assert.equal(orig, 1)
})

test('takeover：有 ctx 但 state 无装配（中间件没跑到/更浅层 abort）→ 原路径', () => {
  let orig = 0
  const wrapper = createContextProviderTakeover({
    provider: () => { orig += 1; return 'LEGACY' },
    isNewPipeline: () => true,
  })
  const c = messageCtx({ userId: '556' })
  const out = runWithContext(c, () => wrapper({ chat: {} }))
  assert.equal(out, 'LEGACY')
  assert.equal(orig, 1)
})

test('takeover：degraded 空装配也接管（返回空串、原 provider 零调用）——fail-closed 语义钉死', () => {
  let orig = 0
  const wrapper = createContextProviderTakeover({
    provider: () => { orig += 1; return 'LEGACY' },
    isNewPipeline: () => true,
  })
  const c = messageCtx({ userId: '557' })
  c.state.set(MEMORY_KEY, { ok: false, degraded: true, text: '', scopes: [] })
  const out = runWithContext(c, () => wrapper({ chat: {} }))
  assert.equal(out, '')
  assert.equal(orig, 0)
})

test('NEW_MEMORY_PIPELINE 解析：仅 true/1 算开，非法值一律 false（对齐 FLAG_USE_PIPELINE 口径）', () => {
  assert.equal(isNewMemoryPipelineEnabled({ NEW_MEMORY_PIPELINE: 'true' }), true)
  assert.equal(isNewMemoryPipelineEnabled({ NEW_MEMORY_PIPELINE: '1' }), true)
  assert.equal(isNewMemoryPipelineEnabled({ NEW_MEMORY_PIPELINE: ' TRUE ' }), true)
  assert.equal(isNewMemoryPipelineEnabled({ NEW_MEMORY_PIPELINE: 'True' }), true)
  assert.equal(isNewMemoryPipelineEnabled({ NEW_MEMORY_PIPELINE: 'false' }), false)
  assert.equal(isNewMemoryPipelineEnabled({ NEW_MEMORY_PIPELINE: '0' }), false)
  assert.equal(isNewMemoryPipelineEnabled({ NEW_MEMORY_PIPELINE: 'yes' }), false)
  assert.equal(isNewMemoryPipelineEnabled({ NEW_MEMORY_PIPELINE: '' }), false)
  assert.equal(isNewMemoryPipelineEnabled({}), false)
  assert.equal(isNewMemoryPipelineEnabled({ NEW_MEMORY_PIPELINE: 1 }), false, '非字符串按 false')
  assert.equal(isNewMemoryPipelineEnabled(undefined), false)
})

// =====================================================================
// ④ abort unwind 联动：memory 层之后 abort，前面 bubble 正常收尾（US-008a §2.2）
// =====================================================================
test('abort unwind：装配层之后 abort——persona/memory bubble 照常回溯，更深两级不进', async () => {
  const trace = createTracingMiddleware({ now: () => 0, log: { debug: () => {} } })
  const persona = createPersonaInjector({ getPersona: () => ({ id: 'P', body: 'b' }) })
  const s = stubMemory('M')
  const memory = createMemoryRetriever({ memory: s.api })
  const marks = []
  const aborter = async (ctx) => { marks.push('aborter:enter'); ctx.abort('steer-like') } // 不调 next
  const deep = async (ctx, next) => { marks.push('deep:enter'); await next(); marks.push('deep:exit') }
  const terminal = async () => { marks.push('terminal') }

  // 浅层 recorder 记录自身 bubble（模拟 egress/flush 这类活在 bubble 里的层）
  const shallow = async (ctx, next) => { marks.push('shallow:enter'); await next(); marks.push('shallow:exit') }

  const pipeline = compose([trace, shallow, persona, memory, aborter, deep, terminal])
  const c = messageCtx({ userId: '666' })
  await pipeline(c)

  assert.deepEqual(marks, ['shallow:enter', 'aborter:enter', 'shallow:exit'],
    'abort 时刻：未派发层级两级不进；已派发浅层 bubble 正常回溯（§2.2/US-008a）')
  assert.equal(c.state.get(PERSONA_KEY).id, 'P', 'persona 装配已完成')
  assert.equal(c.state.get(MEMORY_KEY).text, 'M', 'memory 装配已完成')
  assert.equal(s.cfCalls.length, 1, 'memory 检索恰一次')
  const t = getTrace(c)
  assert.equal(t.aborted, true, 'tracing 的 bubble 收尾并记 aborted')
  assert.equal(t.errors, 0, 'abort 是正常中断不计错误')
  assert.ok(t.stages.some((x) => x.name === 'persona') && t.stages.some((x) => x.name === 'memory'),
    '两段在 abort 前已入 trace stages')
})

// =====================================================================
// ⑤ reportStage('persona'/'memory') 上报 + 装配顺序
// =====================================================================
test('reportStage：注入位恰好各上报一次、段名与时序走注入 clock', async () => {
  const clock = fakeClock(10)
  const stages = []
  const persona = createPersonaInjector({
    getPersona: async () => { clock.advance(5); return { id: 'P' } },
    reportStage: (n, ms) => stages.push([n, ms]),
    clock: clock.now,
  })
  const memory = createMemoryRetriever({
    memory: { contextFor: () => { clock.advance(7); return 'M' }, listFor: () => [] },
    reportStage: (n, ms) => stages.push([n, ms]),
    now: clock.now,
  })
  const c = messageCtx({ userId: '999' })
  await persona(c, async () => {})
  await memory(c, async () => {})
  assert.deepEqual(stages, [['persona', 5], ['memory', 7]])
})

test('缺省走 traceStage：无 reportStage 注入时段名进本轮 trace（G4），无 tracing 自动退化不炸', async () => {
  const trace = createTracingMiddleware({ now: () => 0, log: { debug: () => {} } })
  const persona = createPersonaInjector({ getPersona: () => ({ id: 'P' }) })
  const memory = createMemoryRetriever({ memory: { contextFor: () => 'M', listFor: () => [] } })
  const c = messageCtx({ userId: '1000' })
  await compose([trace, persona, memory, async () => {}])(c)
  const names = getTrace(c).stages.map((x) => x.name)
  assert.ok(names.includes('persona') && names.includes('memory'))
  // 无 tracing：traceStage 退化为直执行，业务照常
  const c2 = messageCtx({ userId: '1001' })
  await persona(c2, async () => {})
  assert.equal(c2.state.get(PERSONA_KEY).id, 'P')
})

test('装配顺序：persona → memory → 终端（host 开启态数组的装配位）', async () => {
  const order = []
  const persona = createPersonaInjector({ getPersona: () => { order.push('persona'); return { id: 'P' } } })
  const memory = createMemoryRetriever({
    memory: { contextFor: () => { order.push('memory'); return 'M' }, listFor: () => [] },
  })
  const c = messageCtx({ groupId: '55' })
  await compose([persona, memory, async () => { order.push('terminal') }])(c)
  assert.deepEqual(order, ['persona', 'memory', 'terminal'])

  // takeover 在这条链的 ALS 里应命中（顺序=装配先于终端的闭环验证）
  const wrapper = createContextProviderTakeover({
    provider: () => 'LEGACY',
    isNewPipeline: () => true,
  })
  assert.equal(runWithContext(c, () => wrapper({ chat: {} })), 'M')
})

// ---------- 归聊形状小件（persona/memory 共用口径） ----------
test('chatFromInbound：群/私聊/poke 通知三类信封形状钉死', () => {
  assert.deepEqual(chatFromInbound({ groupId: '55', sender: { userId: '777' }, subType: 'group' }),
    { chatId: 'group:55', kind: 'group', groupId: '55', userId: '777' })
  assert.deepEqual(chatFromInbound({ sender: { userId: '777' }, subType: 'private' }),
    { chatId: 'private:777', kind: 'private', userId: '777' })
  assert.equal(chatFromInbound({ sender: undefined, subType: 'friend' }), undefined)
  assert.equal(chatFromInbound({ subType: 'group' }), undefined, '群事件缺 group_id 也缺 sender：不可归聊')
})
