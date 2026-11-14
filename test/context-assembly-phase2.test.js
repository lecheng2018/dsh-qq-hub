// Context Assembly Phase 2 的两个连续性 provider（线索 + 时空标尺）的回归网。
//
// 为什么必须钉死：这两个 provider 决定「她记不记得上一轮说到哪、隔了多久」。它们此前
// **零测试覆盖**（按符号名全量 grep 确认），而代码里藏着几处「接错就静默失效」的陷阱：
//   · perChat 模式下若把 parseChatKey(...).chatKey 当成返回值，恒 undefined →
//     永久 fail-closed，接线看着在、实际什么都不注入（代码注释记着这个真实事故）；
//   · 无 scope / 非法 ChatKey 若不全库兜底，就会把别人聊天的线索塞进这个群；
//   · 账本返回别的 chatKey 的线索时若不拦，就是跨域串味。
// 所以本文件重点守：**fail-closed**、**跨域必须抛**、**perChat 的重组正确性**。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AFFECTIVE_PROVIDER_ID,
  THREAD_PROVIDER_ID,
  TIME_SCALE_PROVIDER_ID,
  createAffectiveProvider,
  createContextAssembly,
  createThreadProvider,
  createTimeScaleProvider,
} from '../src/chat/context-assembly.js'

const NOW = 1_800_000_000_000
const CHAT = 'private:10001'
const GROUP = 'group:20001'

/** 假账本：按 chatKey 返回预设的线索记录（形状对齐 thread-ledger 的单条 peek 语义）。 */
function fakeLedger(table = {}) {
  const calls = []
  return {
    calls,
    peek(chatKey, opts = {}) {
      calls.push({ chatKey, opts })
      return table[chatKey] ?? null
    },
  }
}

// ---------------------------------------------------------------------------
// createThreadProvider
// ---------------------------------------------------------------------------

test('线索 provider：缺 ledger 直接拒（不允许「以为接线了其实没账本」）', () => {
  assert.throws(() => createThreadProvider({}), TypeError)
  assert.throws(() => createThreadProvider({ ledger: {} }), TypeError)
  assert.throws(() => createThreadProvider({ ledger: { peek: 'x' } }), TypeError)
})

test('线索 provider：声明了非法 scope 立即报错（声明即校验）', () => {
  const ledger = fakeLedger()
  assert.throws(() => createThreadProvider({ ledger, scope: 'not-a-chatkey' }))
  assert.doesNotThrow(() => createThreadProvider({ ledger, scope: CHAT }))
})

test('线索 provider：perChat 用请求带来的 chatKey 并重组成规范形态', () => {
  const ledger = fakeLedger()
  const p = createThreadProvider({ ledger, perChat: true })
  // 关键：parseChatKey 返回 {kind,id} 没有 chatKey 字段，实现必须自己重组。
  // 若重组错了，这里会因为 resolved !== chatKey 而 fail-closed，什么都不注入。
  const out = p.provide({ chatKey: CHAT })
  assert.equal(typeof out, 'string', 'provide 必须返回字符串（装配契约）')
  assert.deepEqual(ledger.calls.map((c) => c.chatKey), [CHAT], '应以规范 chatKey 查账本')
})

test('线索 provider：perChat 下非法/空 chatKey 一律 fail-closed，不查账本', () => {
  const ledger = fakeLedger()
  const p = createThreadProvider({ ledger, perChat: true })
  for (const bad of ['', null, undefined, 'nonsense', 'private:', 'group:']) {
    assert.equal(p.provide({ chatKey: bad }), '', `${JSON.stringify(bad)} 不该注入`)
  }
  assert.equal(ledger.calls.length, 0, '非法 chatKey 不应触碰账本')
})

test('线索 provider：无 scope（非 perChat 也未绑 scope）一律不注入', () => {
  const ledger = fakeLedger({ [CHAT]: { chatKey: CHAT, type: 'promise', summary: '分享新歌' } })
  const p = createThreadProvider({ ledger })
  assert.equal(p.provide({ chatKey: CHAT }), '', '没有可信作用域就不注入（fail-closed）')
})

test('线索 provider：global scope 不注入（线索按聊天域，不跨全库）', () => {
  const ledger = fakeLedger({ global: { chatKey: 'global', type: 'promise', summary: 'x' } })
  const p = createThreadProvider({ ledger, scope: 'global', perChat: true })
  assert.equal(p.provide({ chatKey: 'global' }), '')
})

test('线索 provider：账本返回别的 chatKey 的线索 → 必须抛（跨域串味）', () => {
  // 群聊 scope 却拿到私聊线索：这是最严重的泄漏，绝不能静默吞掉
  const ledger = fakeLedger({ [GROUP]: { chatKey: CHAT, type: 'promise', summary: '私事的约定' } })
  const p = createThreadProvider({ ledger, perChat: true })
  assert.throws(() => p.provide({ chatKey: GROUP }), /ThreadScopeLeak|泄漏|scope/i)
})

test('线索 provider：账本无记录时返回空串，不崩', () => {
  const ledger = fakeLedger()
  const p = createThreadProvider({ ledger, perChat: true })
  assert.equal(p.provide({ chatKey: CHAT }), '')
})

test('线索 provider：声明形状完整（moduleId / priority / isolate / 不进稳定缓存）', () => {
  const p = createThreadProvider({ ledger: fakeLedger(), perChat: true })
  assert.equal(p.moduleId, THREAD_PROVIDER_ID)
  assert.equal(typeof p.priority, 'number')
  assert.equal(p.onError, 'isolate', 'provider 出错只跳自己，不拖垮整次装配')
  assert.equal(p.cacheStable, false, '线索随时会变，不能进稳定缓存段')
  assert.equal(typeof p.provide, 'function')
})

test('线索 provider：now 可注入（不读真实时钟，测试可复现）', () => {
  const ledger = fakeLedger()
  createThreadProvider({ ledger, perChat: true, now: () => NOW }).provide({ chatKey: CHAT })
  assert.equal(ledger.calls[0].opts.now, NOW, '应把注入的时间传给账本')
})

// ---------------------------------------------------------------------------
// createTimeScaleProvider
// ---------------------------------------------------------------------------

test('时空 provider：resolveLastAt 非函数时立即拒', () => {
  assert.throws(() => createTimeScaleProvider({ resolveLastAt: 'x' }), TypeError)
  assert.doesNotThrow(() => createTimeScaleProvider({}))
})

test('时空 provider：perChat 下按本会话上一轮时间注入相对时间感', () => {
  const p = createTimeScaleProvider({
    perChat: true,
    resolveLastAt: (key) => (key === CHAT ? NOW - 45 * 60_000 : undefined),
    now: () => NOW,
  })
  const out = p.provide({ chatKey: CHAT })
  assert.match(out, /时空标尺/, '应注入时空标尺')
  assert.match(out, /45/, `应体现约 45 分钟（实际 ${out}）`)
})

test('时空 provider：没有时间源就不编造（返回空串）', () => {
  const p = createTimeScaleProvider({ perChat: true, now: () => NOW })
  assert.equal(p.provide({ chatKey: CHAT }), '', '没有 resolveLastAt 时不许凭空写时间')
})

test('时空 provider：上一轮时间非法/缺失时不注入', () => {
  for (const bad of [undefined, null, NaN, Infinity, -1, 'x', {}]) {
    const p = createTimeScaleProvider({ perChat: true, resolveLastAt: () => bad, now: () => NOW })
    assert.equal(p.provide({ chatKey: CHAT }), '', `resolveLastAt=${JSON.stringify(bad)} 不该注入`)
  }
})

test('时空 provider：无 scope / 非法 chatKey 一律 fail-closed', () => {
  const p = createTimeScaleProvider({ resolveLastAt: () => NOW - 1000, now: () => NOW })
  assert.equal(p.provide({ chatKey: CHAT }), '', '未绑 scope 不注入')
  const q = createTimeScaleProvider({ perChat: true, resolveLastAt: () => NOW - 1000, now: () => NOW })
  for (const bad of ['', null, 'nonsense']) assert.equal(q.provide({ chatKey: bad }), '')
})

test('时空 provider：声明形状完整', () => {
  const p = createTimeScaleProvider({ perChat: true })
  assert.equal(p.moduleId, TIME_SCALE_PROVIDER_ID)
  assert.equal(p.onError, 'isolate')
  assert.equal(typeof p.priority, 'number')
})

// ---------------------------------------------------------------------------
// 与装配器联动：出错必须只跳自己
// ---------------------------------------------------------------------------

test('装配器：线索 provider 抛错时被 isolate，其余上下文照常注入', async () => {
  const boom = {
    moduleId: 'boom-thread',
    priority: 800,
    scope: 'global',
    onError: 'isolate',
    provide: () => { throw new Error('账本炸了') },
  }
  const ok = {
    moduleId: 'ok-provider',
    priority: 700,
    scope: 'global',
    onError: 'isolate',
    provide: () => '正常上下文',
  }
  const asm = createContextAssembly({ providers: [boom, ok] })
  const res = await asm.assemble({ chatKey: CHAT })
  const joined = JSON.stringify(res)
  assert.match(joined, /正常上下文/, '坏 provider 不能拖垮好的')
  assert.ok(res.errors?.length >= 1, '坏 provider 的错误要被记进 errors（可审计），而不是静默吞掉')
})

test('装配器：无可信 chatKey 时 fail-closed 抛错（调用方先修 ChatKey）', async () => {
  const asm = createContextAssembly({ providers: [] })
  await assert.rejects(() => asm.assemble({ chatKey: 'nonsense' }), /ChatKey|chatKey/i)
})

// ---------------------------------------------------------------------------
// createAffectiveProvider（US-015 关系温度）
// ---------------------------------------------------------------------------

test('关系温度 provider：等级 0（陌生人）不注入任何内容', () => {
  const p = createAffectiveProvider({ resolveTone: () => ({ ok: true, level: 0, temperature: 'cool', jokeScale: 0.2 }), perChat: true })
  assert.equal(p.provide({ chatKey: CHAT }), '', '不认识的人不该被塞一句「你是陌生人」')
})

test('关系温度 provider：等级 ≥1 时注入温度与玩笑尺度', () => {
  const p = createAffectiveProvider({
    resolveTone: () => ({ ok: true, level: 1, label: '熟络好友', temperature: 'warm', jokeScale: 0.6 }),
    perChat: true,
  })
  const out = p.provide({ chatKey: CHAT })
  assert.ok(out, '应注入内容')
  assert.match(out, /熟络好友|暖/)
  assert.match(out, /0\.6/, '应带上玩笑尺度')
})

test('关系温度 provider：resolveTone 失败形状（ok:false）不装熟', () => {
  const p = createAffectiveProvider({ resolveTone: () => ({ ok: false }), perChat: true })
  assert.equal(p.provide({ chatKey: CHAT }), '')
})

test('关系温度 provider：resolveTone 抛错时由装配层 isolate（不是在这里吞掉）', async () => {
  // 设计契约（见 createAffectiveProvider 注释）：provide 内部**故意不 try/catch**，
  // 让错误冒到装配层记进 errors[]（可审计），再由 onError:'isolate' 保证不拖垮别的 provider。
  // 所以这里断言的是「它会抛」，以及「装配器仍然产出其余上下文」。
  const throwing = createAffectiveProvider({ resolveTone: () => { throw new Error('图谱读坏了') }, perChat: true })
  assert.throws(() => throwing.provide({ chatKey: CHAT }), /图谱读坏了/)

  const asm = createContextAssembly({
    providers: [
      { ...throwing, scope: 'global' },
      { moduleId: 'ok-aff', priority: 700, scope: 'global', onError: 'isolate', provide: () => '其它上下文' },
    ],
  })
  const res = await asm.assemble({ chatKey: CHAT })
  assert.match(JSON.stringify(res), /其它上下文/, '坏 provider 不能拖垮好的')
  assert.ok(res.errors?.length >= 1, '错误要进 errors（可审计），不能静默丢')
})

test('关系温度 provider：没给 resolveTone 时安静返回空串（模块关掉的正常场景）', () => {
  const missing = createAffectiveProvider({ perChat: true })
  assert.doesNotThrow(() => missing.provide({ chatKey: CHAT }))
  assert.equal(missing.provide({ chatKey: CHAT }), '')
})

test('关系温度 provider：无 scope / 非法 chatKey 一律 fail-closed', () => {
  const p = createAffectiveProvider({ resolveTone: () => ({ ok: true, level: 2, temperature: 'hot' }), perChat: true })
  for (const bad of ['', null, 'nonsense']) assert.equal(p.provide({ chatKey: bad }), '')
  const noScope = createAffectiveProvider({ resolveTone: () => ({ ok: true, level: 2 }) })
  assert.equal(noScope.provide({ chatKey: CHAT }), '')
})

test('关系温度 provider：声明形状完整', () => {
  const p = createAffectiveProvider({ resolveTone: () => ({ ok: true, level: 0 }) })
  assert.equal(p.moduleId, AFFECTIVE_PROVIDER_ID)
  assert.equal(p.onError, 'isolate')
})
