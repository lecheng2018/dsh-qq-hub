// 顺承前情 → 挂起线索闭环（US-019 / inner-thread-link）
// 红线：用户换话题（没有标记）时，线索绝不能被自动 resolved。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTINUATION_MARKER, MAX_INNER_CHARS,
  normalizeThreadKeyword, parseThreadContinuation, parseInnerClosure,
  isNoCloseSignal, applyThreadContinuation, adaptThreadLedger,
} from '../src/chat/inner-thread-link.js'

const KEY = 'group:999'

/** 最小可注入账本：只实现 peek/resolve/advance */
function fakeLedger(threads, { throwOn = null, withAdvance = true } = {}) {
  const calls = { peek: [], resolve: [], advance: [] }
  const ledger = {
    peek(chatKey, opts) { calls.peek.push({ chatKey, opts }); return threads.slice() },
    resolve(chatKey, id, meta) {
      calls.resolve.push({ chatKey, id, meta })
      if (throwOn === 'resolve') throw new Error('boom')
      return { ok: true }
    },
  }
  if (withAdvance) {
    ledger.advance = (chatKey, id, next) => {
      calls.advance.push({ chatKey, id, next })
      if (throwOn === 'advance') throw new Error('boom')
      return { ok: true }
    }
  }
  return { ledger, calls }
}

// ---------------- 常量与归一 ----------------
test('标记常量与预算符合计划书口径', () => {
  assert.equal(CONTINUATION_MARKER, '【顺承前情】')
  assert.equal(MAX_INNER_CHARS, 500, 'inner 预算硬顶 500')
})

test('normalizeThreadKeyword：大小写/标点/空白不参与比较', () => {
  assert.equal(normalizeThreadKeyword('洗澡'), normalizeThreadKeyword(' 洗澡 '))
  assert.equal(normalizeThreadKeyword('Bath'), normalizeThreadKeyword('bath'))
  assert.equal(normalizeThreadKeyword('洗，澡'), normalizeThreadKeyword('洗澡'), '标点被剥除')
})

test('normalizeThreadKeyword：非法输入返回空串（fail-closed）', () => {
  for (const bad of [null, undefined, {}, [], true, Symbol('x')]) {
    assert.equal(normalizeThreadKeyword(bad), '')
  }
  assert.equal(normalizeThreadKeyword(123), '123', '数字可接受')
})

test('normalizeThreadKeyword：超长截断到 40', () => {
  assert.equal(normalizeThreadKeyword('a'.repeat(100)).length, 40)
})

// ---------------- 标记解析 ----------------
test('parseThreadContinuation：解析出标记后的关键词', () => {
  assert.deepEqual(parseThreadContinuation('【顺承前情】洗澡'), ['洗澡'])
  assert.deepEqual(parseThreadContinuation('【顺承前情】洗澡、吃饭'), ['洗澡', '吃饭'])
  assert.deepEqual(parseThreadContinuation('【顺承前情】洗澡 吃饭'), ['洗澡', '吃饭'])
})

test('parseThreadContinuation：无标记返回空数组', () => {
  assert.deepEqual(parseThreadContinuation('随便说点什么'), [])
  assert.deepEqual(parseThreadContinuation(''), [])
  assert.deepEqual(parseThreadContinuation(null), [])
  assert.deepEqual(parseThreadContinuation(123), [], '非字符串 fail-closed')
})

test('parseThreadContinuation：去重且保序', () => {
  assert.deepEqual(parseThreadContinuation('【顺承前情】洗澡 洗澡 吃饭'), ['洗澡', '吃饭'])
})

test('parseThreadContinuation：标记不跨越换行吞正文', () => {
  const r = parseThreadContinuation('【顺承前情】洗澡\n后面的正文不该被当关键词')
  assert.deepEqual(r, ['洗澡'])
})

test('parseThreadContinuation：超 500 字符整块丢弃（fail-closed）', () => {
  const ok = '【顺承前情】洗澡' + '灌水'.repeat(300)
  assert.ok(ok.length > MAX_INNER_CHARS, `构造长度 ${ok.length} 应超 ${MAX_INNER_CHARS}`)
  assert.deepEqual(parseThreadContinuation(ok), [], '超预算不放行')
})

// ---------------- 闭环信号 ----------------
test('parseInnerClosure：识别 close', () => {
  assert.equal(parseInnerClosure('closure: close'), 'close')
  assert.equal(parseInnerClosure('【闭环】close'), 'close')
})

test('parseInnerClosure：任何 no-close 信号优先级最高（硬红线）', () => {
  for (const sig of ['continue', 'hold', 'none', 'keep']) {
    assert.equal(parseInnerClosure(`closure: ${sig}`), sig)
  }
  // 关键回归：close 在前、continue 在后，仍必须判为 continue
  assert.equal(parseInnerClosure('【闭环】close closure: continue'), 'continue',
    'no-close 绝不能被书写顺序绕过')
})

test('parseInnerClosure：无信号返回 null', () => {
  assert.equal(parseInnerClosure('普通内心独白'), null)
  assert.equal(parseInnerClosure(''), null)
  assert.equal(parseInnerClosure(null), null)
})

test('parseInnerClosure：超长触发 Fail-Safe 强制 no-close', () => {
  const long = 'closure: close ' + 'x'.repeat(600)
  assert.ok(long.length > MAX_INNER_CHARS)
  assert.equal(parseInnerClosure(long), 'continue', '超预算时宁可不闭环')
})

test('isNoCloseSignal：大小写不敏感，非字符串 false', () => {
  assert.equal(isNoCloseSignal('CONTINUE'), true)
  assert.equal(isNoCloseSignal('close'), false)
  assert.equal(isNoCloseSignal(null), false)
  assert.equal(isNoCloseSignal(1), false)
})

// ---------------- 调度主逻辑 ----------------
test('命中标记 → 闭环该线索，且 resolve 带来源', () => {
  const { ledger, calls } = fakeLedger([{ id: 't1', keyword: '洗澡', state: 'active' }])
  const r = applyThreadContinuation(ledger, KEY, '【顺承前情】洗澡')
  assert.deepEqual(r.resolved, ['t1'])
  assert.equal(r.blocked, false)
  assert.equal(calls.resolve.length, 1)
  assert.equal(calls.resolve[0].id, 't1')
  assert.equal(calls.resolve[0].meta.source, CONTINUATION_MARKER)
})

test('无标记 → 绝不 resolve，只按拓扑推进一格（用户换话题不误闭环）', () => {
  const { ledger, calls } = fakeLedger([{ id: 't1', keyword: '洗澡', state: 'active' }])
  const r = applyThreadContinuation(ledger, KEY, '今天好累想早点睡')
  assert.deepEqual(r.resolved, [], '没有标记绝不能闭环')
  assert.equal(calls.resolve.length, 0, '不得调用 resolve')
  assert.equal(r.reason, 'no-marker')
  assert.equal(calls.advance.length, 1, '应推进一格')
  assert.equal(calls.advance[0].next, 'extended')
})

test('no-close 信号 → 全场拦截，连拓扑都不动', () => {
  const { ledger, calls } = fakeLedger([{ id: 't1', keyword: '洗澡', state: 'active' }])
  const r = applyThreadContinuation(ledger, KEY, '【顺承前情】洗澡 closure: continue')
  assert.equal(r.blocked, true)
  assert.equal(r.reason, 'closure-continue')
  assert.deepEqual(r.resolved, [])
  assert.equal(calls.resolve.length, 0)
  assert.equal(calls.advance.length, 0, 'blocked 时不得推进')
})

test('已闭环线索跳过，不重复 resolve', () => {
  const { ledger, calls } = fakeLedger([{ id: 't1', keyword: '洗澡', state: 'resolved' }])
  const r = applyThreadContinuation(ledger, KEY, '【顺承前情】洗澡')
  assert.deepEqual(r.resolved, [])
  assert.ok(r.skipped.some((s) => s.reason === 'already-closed'))
  assert.equal(calls.resolve.length, 0)
})

test('无活线索 → reason=no-thread', () => {
  const { ledger } = fakeLedger([])
  assert.equal(applyThreadContinuation(ledger, KEY, '【顺承前情】洗澡').reason, 'no-thread')
})

test('非法输入 fail-closed：不抛、不闭环', () => {
  const { ledger } = fakeLedger([{ id: 't1', keyword: '洗澡', state: 'active' }])
  for (const bad of [null, undefined, {}, 'notaledger']) {
    const r = applyThreadContinuation(bad, KEY, '【顺承前情】洗澡')
    assert.equal(r.reason, 'invalid-input')
    assert.deepEqual(r.resolved, [])
  }
  const r2 = applyThreadContinuation(ledger, '', '【顺承前情】洗澡')
  assert.equal(r2.reason, 'invalid-input', '空 chatKey 不闭环')
})

test('账本 resolve 抛错 → 当作没闭环（fail-closed）', () => {
  const { ledger, calls } = fakeLedger([{ id: 't1', keyword: '洗澡', state: 'active' }], { throwOn: 'resolve' })
  const r = applyThreadContinuation(ledger, KEY, '【顺承前情】洗澡')
  assert.deepEqual(r.resolved, [], '抛错不得算闭环成功')
  assert.ok(r.skipped.some((s) => s.reason === 'resolve-failed'))
  assert.equal(calls.resolve.length, 1, '确实尝试过')
})

test('peek 抛错 → 当作无线索，不让整轮崩', () => {
  const bad = { peek() { throw new Error('boom') }, resolve() { return { ok: true } } }
  assert.doesNotThrow(() => applyThreadContinuation(bad, KEY, '【顺承前情】洗澡'))
})

test('拓扑推进：extended → dormant', () => {
  const { ledger, calls } = fakeLedger([{ id: 't1', keyword: '洗澡', state: 'extended' }])
  const r = applyThreadContinuation(ledger, KEY, '别的话题')
  assert.equal(r.reason, 'no-marker')
  assert.equal(calls.advance[0].next, 'dormant')
})

test('拓扑终结：dormant 不再推进', () => {
  const { ledger, calls } = fakeLedger([{ id: 't1', keyword: '洗澡', state: 'dormant' }])
  applyThreadContinuation(ledger, KEY, '别的话题')
  assert.equal(calls.advance.length, 0, 'dormant 已是终点')
})

test('账本无 advance → 记录 applied:false，不抛', () => {
  const { ledger } = fakeLedger([{ id: 't1', keyword: '洗澡', state: 'active' }], { withAdvance: false })
  const r = applyThreadContinuation(ledger, KEY, '别的话题')
  assert.ok(r.advanced.some((a) => a.applied === false && a.reason === 'no-advance'))
})

test('多线索：命中的闭环、未命中的推进，互不干扰', () => {
  const { ledger, calls } = fakeLedger([
    { id: 't1', keyword: '洗澡', state: 'active' },
    { id: 't2', keyword: '吃饭', state: 'active' },
  ])
  const r = applyThreadContinuation(ledger, KEY, '【顺承前情】洗澡')
  assert.deepEqual(r.resolved, ['t1'])
  assert.equal(calls.resolve.length, 1)
  assert.equal(calls.advance.length, 1)
  assert.equal(calls.advance[0].id, 't2', '未命中的那条才推进')
})

test('返回结构稳定：字段齐全', () => {
  const { ledger } = fakeLedger([])
  const r = applyThreadContinuation(ledger, KEY, 'x')
  for (const k of ['chatKey', 'closure', 'markers', 'resolved', 'advanced', 'skipped', 'blocked', 'reason']) {
    assert.ok(Object.hasOwn(r, k), `缺字段 ${k}`)
  }
  assert.equal(r.chatKey, KEY)
})

// ---------------- 适配层 ----------------
test('adaptThreadLedger：选型对象不合格返回 null（fail-closed）', () => {
  for (const bad of [null, undefined, {}, { peek: () => {} }]) {
    assert.equal(adaptThreadLedger(bad), null)
  }
})

test('adaptThreadLedger：peek 默认只认 active/extended，不含 dormant', () => {
  const rows = []
  const real = {
    peek: () => ({ id: 'p1', keyword: '洗澡', state: 'active' }),
    resolve: () => ({ ok: true }),
  }
  const a = adaptThreadLedger(real)
  const got = a.peek(KEY, {})
  assert.equal(got.length, 1)
  assert.equal(got[0].id, 'p1')
})

test('adaptThreadLedger：有 list 时用 list 并传状态过滤', () => {
  const seen = []
  const real = {
    peek: () => null,
    resolve: () => ({ ok: true }),
    list: (q) => { seen.push(q); return [{ id: 'a', state: 'active' }] },
  }
  const a = adaptThreadLedger(real)
  const got = a.peek(KEY, { includeDormant: false })
  assert.equal(got.length, 1)
  assert.deepEqual(seen[0].status, ['active', 'extended'], '默认不含 dormant')
})

test('adaptThreadLedger：includeDormant 时改用 unresolved', () => {
  const seen = []
  const real = {
    peek: () => null, resolve: () => ({ ok: true }),
    list: (q) => { seen.push(q); return [] },
  }
  adaptThreadLedger(real).peek(KEY, { includeDormant: true })
  assert.equal(seen[0].status, 'unresolved')
})

test('adaptThreadLedger：advance 幂等——已是目标状态则不重复推格', () => {
  const advanced = []
  const real = {
    peek: () => null, resolve: () => ({ ok: true }),
    get: (id) => ({ id, status: 'extended' }),
    advance: (chatKey, opts) => { advanced.push(opts); return { ok: true } },
  }
  const a = adaptThreadLedger(real)
  const r = a.advance(KEY, 't1', 'extended')
  assert.equal(r.already, true)
  assert.equal(advanced.length, 0, '同状态不得重复 advance')
})
