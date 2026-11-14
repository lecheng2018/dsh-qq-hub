// 双轨记忆 · 人设归属（Phase 0b / US-017）
// 覆盖：规范化、主客观判定、可见性、写入归一、读取过滤、纯函数不污染入参。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PERSONA_ID, SUBJECTIVE_KINDS,
  normalizePersonaId, isSubjectiveEntry, entryPersonaId, effectivePersonaId,
  isEntryVisibleToPersona, withPersonaId, withPersonaIdAll, filterEntriesByPersona,
} from '../src/features/memory-persona-track.js'

// ---------------- 规范化 ----------------
test('normalizePersonaId：合法 id 原样返回（含首尾空白修剪）', () => {
  assert.equal(normalizePersonaId('socrates'), 'socrates')
  assert.equal(normalizePersonaId('  dafeiyu  '), 'dafeiyu')
  assert.equal(normalizePersonaId('a-b_c1'), 'a-b_c1')
})

test('normalizePersonaId：非法输入一律返回空串（fail-closed）', () => {
  for (const bad of [null, undefined, 0, 1, true, {}, [], '']) {
    assert.equal(normalizePersonaId(bad), '', `输入 ${JSON.stringify(bad)} 应得空串`)
  }
  assert.equal(normalizePersonaId('a'.repeat(65)), '', '超长（>64）丢弃')
  assert.equal(normalizePersonaId('has space'), '', '含空格丢弃')
  assert.equal(normalizePersonaId('中文人设'), '', '非 ASCII 丢弃')
  assert.equal(normalizePersonaId('a/b'), '', '含斜杠丢弃')
})

test('normalizePersonaId：正好 64 字符是边界内', () => {
  assert.equal(normalizePersonaId('a'.repeat(64)), 'a'.repeat(64))
})

// ---------------- 主客观判定 ----------------
test('isSubjectiveEntry：三种主观 kind 都算主观', () => {
  for (const kind of SUBJECTIVE_KINDS) {
    assert.equal(isSubjectiveEntry({ kind }), true, `${kind} 应为主观`)
  }
})

test('isSubjectiveEntry：fact 永不算主观（客观事实轨不加 personaId）', () => {
  assert.equal(isSubjectiveEntry({ kind: 'fact' }), false)
  assert.equal(isSubjectiveEntry({ kind: 'fact', selfView: true }), false, 'fact 即便标 selfView 也不算')
})

test('isSubjectiveEntry：selfView / perspective=self 可判主观', () => {
  assert.equal(isSubjectiveEntry({ kind: 'note', selfView: true }), true)
  assert.equal(isSubjectiveEntry({ kind: 'note', selfView: 1 }), true)
  assert.equal(isSubjectiveEntry({ kind: 'note', perspective: 'self' }), true)
  assert.equal(isSubjectiveEntry({ kind: 'note', selfView: false }), false)
  assert.equal(isSubjectiveEntry({ kind: 'note', perspective: 'other' }), false)
})

test('isSubjectiveEntry：非对象与无 kind 一律不算主观', () => {
  for (const bad of [null, undefined, 1, 'x', [], true]) {
    assert.equal(isSubjectiveEntry(bad), false, `${JSON.stringify(bad)} 应为 false`)
  }
  assert.equal(isSubjectiveEntry({}), false)
  assert.equal(isSubjectiveEntry({ kind: '  ' }), false)
})

// ---------------- 生效 personaId ----------------
test('entryPersonaId：条目声明的非法值视为未标注', () => {
  assert.equal(entryPersonaId({ personaId: 'abc' }), 'abc')
  assert.equal(entryPersonaId({ personaId: 'bad id' }), '')
  assert.equal(entryPersonaId({}), '')
  assert.equal(entryPersonaId(null), '')
})

test('effectivePersonaId：客观事实轨恒为空（跨人设共享）', () => {
  assert.equal(effectivePersonaId({ kind: 'fact', personaId: 'x' }), '')
  assert.equal(effectivePersonaId({ kind: 'fact' }, 'socrates'), '')
})

test('effectivePersonaId：主观条目未标注时回落到默认人设（历史存量不丢弃）', () => {
  assert.equal(effectivePersonaId({ kind: 'insight' }), DEFAULT_PERSONA_ID)
  assert.equal(effectivePersonaId({ kind: 'insight' }, 'socrates'), 'socrates')
  assert.equal(effectivePersonaId({ kind: 'insight' }, 'bad id!!'), DEFAULT_PERSONA_ID, '非法默认值回落 dafeiyu')
})

test('effectivePersonaId：已标注优先于当前人设', () => {
  assert.equal(effectivePersonaId({ kind: 'style', personaId: 'old' }, 'new'), 'old')
})

// ---------------- 可见性 ----------------
test('isEntryVisibleToPersona：客观事实对任何人都可见', () => {
  assert.equal(isEntryVisibleToPersona({ kind: 'fact' }, 'socrates'), true)
  assert.equal(isEntryVisibleToPersona({ kind: 'fact' }, ''), true)
})

test('isEntryVisibleToPersona：主观条目只对同人设可见（隔离生效）', () => {
  assert.equal(isEntryVisibleToPersona({ kind: 'insight', personaId: 'socrates' }, 'socrates'), true)
  assert.equal(isEntryVisibleToPersona({ kind: 'insight', personaId: 'socrates' }, 'dafeiyu'), false, '不能串味')
})

test('isEntryVisibleToPersona：未标注按默认人设算，当前为空也按默认', () => {
  assert.equal(isEntryVisibleToPersona({ kind: 'insight' }, DEFAULT_PERSONA_ID), true)
  assert.equal(isEntryVisibleToPersona({ kind: 'insight' }, ''), true)
  assert.equal(isEntryVisibleToPersona({ kind: 'insight' }, 'socrates'), false)
})

// ---------------- 写入归一 ----------------
test('withPersonaId：主观条目补当前人设，且不改入参', () => {
  const src = { kind: 'insight', text: '喜欢下雨' }
  const out = withPersonaId(src, 'socrates')
  assert.equal(out.personaId, 'socrates')
  assert.equal(src.personaId, undefined, '入参不得被修改')
  assert.notEqual(out, src, '必须返回新对象')
})

test('withPersonaId：客观条目剥除 personaId', () => {
  const out = withPersonaId({ kind: 'fact', personaId: 'stale', text: 'x' }, 'socrates')
  assert.equal(Object.hasOwn(out, 'personaId'), false, '客观轨不得带 personaId')
  assert.equal(out.kind, 'fact')
})

test('withPersonaId：条目已有 personaId 优先，不被当前人设覆盖', () => {
  const out = withPersonaId({ kind: 'insight', personaId: 'old' }, 'new')
  assert.equal(out.personaId, 'old')
})

test('withPersonaId：当前人设非法时回落默认', () => {
  assert.equal(withPersonaId({ kind: 'insight' }, 'bad id').personaId, DEFAULT_PERSONA_ID)
  assert.equal(withPersonaId({ kind: 'insight' }, '').personaId, DEFAULT_PERSONA_ID)
})

test('withPersonaId：非对象入参抛 TypeError', () => {
  for (const bad of [null, undefined, 1, 'x', []]) {
    assert.throws(() => withPersonaId(bad, 'p'), TypeError, `${JSON.stringify(bad)} 应抛 TypeError`)
  }
})

test('withPersonaIdAll：批量归一，原数组与原条目不变', () => {
  const src = [{ kind: 'insight', text: 'a' }, { kind: 'fact', text: 'b', personaId: 'x' }]
  const out = withPersonaIdAll(src, 'socrates')
  assert.equal(out.length, 2)
  assert.equal(out[0].personaId, 'socrates')
  assert.equal(Object.hasOwn(out[1], 'personaId'), false)
  assert.equal(src[0].personaId, undefined, '原条目未被污染')
  assert.equal(src[1].personaId, 'x', '原条目未被污染')
})

test('withPersonaIdAll：非数组返回空数组（fail-closed）', () => {
  for (const bad of [null, undefined, {}, 'x', 1]) {
    assert.deepEqual(withPersonaIdAll(bad, 'p'), [])
  }
})

// ---------------- 读取过滤 ----------------
test('filterEntriesByPersona：客观全留、他人主观剔除', () => {
  const rows = [
    { kind: 'fact', text: '客观' },
    { kind: 'insight', personaId: 'socrates', text: '苏的' },
    { kind: 'style', personaId: 'dafeiyu', text: '鱼的' },
    { kind: 'profile', text: '未标注→默认' },
  ]
  const got = filterEntriesByPersona(rows, 'socrates')
  assert.equal(got.length, 2, '应只剩 客观 + 苏的')
  assert.deepEqual(got.map((x) => x.text), ['客观', '苏的'])
})

test('filterEntriesByPersona：返回值是浅拷贝，改它不污染存储', () => {
  const rows = [{ kind: 'insight', personaId: 'p', text: 't' }]
  const got = filterEntriesByPersona(rows, 'p')
  got[0].text = '被改了'
  assert.equal(rows[0].text, 't', '存储内部状态不得被污染')
  assert.notEqual(got[0], rows[0], '应为新对象')
})

test('filterEntriesByPersona：非数组返回空数组（fail-closed）', () => {
  for (const bad of [null, undefined, {}, 'x', 0]) {
    assert.deepEqual(filterEntriesByPersona(bad, 'p'), [])
  }
})

test('回归：换成苏格拉底人设后，看不到任何大肥鱼的主观条目', () => {
  const rows = withPersonaIdAll([
    { kind: 'insight', text: '鱼的自省' },
    { kind: 'style', text: '鱼的语感' },
    { kind: 'fact', text: '客观事实' },
  ], DEFAULT_PERSONA_ID)
  const forSocrates = filterEntriesByPersona(rows, 'socrates')
  assert.equal(forSocrates.length, 1, '只应看到客观事实')
  assert.equal(forSocrates[0].kind, 'fact')
  assert.ok(!forSocrates.some((e) => String(e.text).includes('鱼的')), '零大肥鱼主观内容串味')
})
