// 群参与契约 T1.2：normalizeParticipation 白名单校验 + mergeParticipation 合流纯函数（任务书 §3.4）。
// 真实导入并调用被测函数断言可观察行为；非法值必须被拒，非法输入不得悄悄变成合法声明。
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeParticipation, mergeParticipation, ParticipationValidationError } from '../src/host/core/group-participation.js'

const MSG = { messageId: '10001' }
const invalid = (fn) => assert.throws(fn, (e) => e instanceof ParticipationValidationError && e.code === 'participation-invalid')

// ---------- normalizeParticipation ----------

test('normalize：未接管（undefined/null/false/空串/0）返回 null，不算接管', () => {
  for (const v of [undefined, null, false, '', 0]) {
    assert.equal(normalizeParticipation(v, { msg: MSG, sourceModuleId: 'mod-a' }), null)
  }
})

test('normalize：FULL 只留白名单字段，插件自报的 sourceModuleId 不采信', () => {
  const r = normalizeParticipation({ level: 'full', junk: 'x', sourceModuleId: 'fake', reaction: { messageId: '1', emojiId: '66' } }, { msg: MSG, sourceModuleId: 'mod-a' })
  assert.deepEqual(r, { level: 'full', sourceModuleId: 'mod-a' })
  assert.equal('limits' in r, false)
  assert.equal('reaction' in r, false)
})

test('normalize：TEXT_LITE 保留合法 limits，范围外/非有限整数全拒', () => {
  assert.deepEqual(
    normalizeParticipation({ level: 'text_lite', limits: { maxBubbles: 1, maxChars: 80 } }, { sourceModuleId: 'mod-a' }),
    { level: 'text_lite', sourceModuleId: 'mod-a', limits: { maxBubbles: 1, maxChars: 80 } },
  )
  // 缺 limits 允许（宿主按自己规则收紧）
  assert.deepEqual(
    normalizeParticipation({ level: 'text_lite' }, { sourceModuleId: 'mod-a' }),
    { level: 'text_lite', sourceModuleId: 'mod-a' },
  )
  // 越界：maxBubbles 0/13/小数/Infinity/-1/NaN；maxChars 9/501/Infinity/NaN
  for (const bad of [0, 13, 1.5, Infinity, -1, NaN, '2']) {
    invalid(() => normalizeParticipation({ level: 'text_lite', limits: { maxBubbles: bad } }, {}))
  }
  for (const bad of [9, 501, Infinity, -80, NaN, '80']) {
    invalid(() => normalizeParticipation({ level: 'text_lite', limits: { maxChars: bad } }, {}))
  }
  invalid(() => normalizeParticipation({ level: 'text_lite', limits: 'no' }, {}))
})

test('normalize：REACT 校验锚点与 emoji；跨消息 messageId / 非数字 emoji / 缺 reaction 全拒', () => {
  assert.deepEqual(
    normalizeParticipation({ level: 'react', reaction: { messageId: 10001, emojiId: 66 } }, { msg: MSG, sourceModuleId: 'mod-b' }),
    { level: 'react', sourceModuleId: 'mod-b', reaction: { messageId: '10001', emojiId: '66' } },
  )
  // 锚点必须是当前这条消息（跨消息拒绝）
  invalid(() => normalizeParticipation({ level: 'react', reaction: { messageId: '10002', emojiId: '66' } }, { msg: MSG }))
  // 非法 messageId / emojiId
  for (const bad of ['0', 'abc', '', '-5', '1e3', '12.3', undefined, NaN]) {
    invalid(() => normalizeParticipation({ level: 'react', reaction: { messageId: bad, emojiId: '66' } }, { msg: MSG }))
    invalid(() => normalizeParticipation({ level: 'react', reaction: { messageId: '10001', emojiId: bad } }, { msg: MSG }))
  }
  // emojiId 超长（>10 位）/ 前导零
  invalid(() => normalizeParticipation({ level: 'react', reaction: { messageId: '10001', emojiId: '12345678901' } }, { msg: MSG }))
  invalid(() => normalizeParticipation({ level: 'react', reaction: { messageId: '10001', emojiId: '066' } }, { msg: MSG }))
  // 缺 reaction / 未知 level
  invalid(() => normalizeParticipation({ level: 'react' }, { msg: MSG }))
  invalid(() => normalizeParticipation({ level: 'sticker' }, { msg: MSG }))
  // truthy 但不是对象：仍是接管（占 claim），必须抛校验错误让调用方回退 FULL
  for (const bad of ['react', 123, true]) {
    invalid(() => normalizeParticipation(bad, { msg: MSG }))
  }
  // FULL 不带 limits：多余的 limits 字段按白名单丢弃，不报错
  assert.deepEqual(
    normalizeParticipation({ level: 'full', limits: { maxBubbles: 1 } }, { sourceModuleId: 'mod-a' }),
    { level: 'full', sourceModuleId: 'mod-a' },
  )
})

// ---------- mergeParticipation（§3.4） ----------

const react = (messageId, src = 'mod-r') => ({ level: 'react', sourceModuleId: src, reaction: { messageId, emojiId: '66' } })
const lite = (limits, src = 'mod-l') => ({ level: 'text_lite', sourceModuleId: src, limits })
const full = (src = 'mod-f') => ({ level: 'full', sourceModuleId: src })

test('merge：REACT+FULL、FULL+REACT 均 FULL，且无 reaction / limits 残留', () => {
  for (const [a, b] of [[react('10001'), full()], [full(), react('10001')]]) {
    const m = mergeParticipation(a, b, 'interject', 'interject')
    assert.equal(m.level, 'full')
    assert.equal('reaction' in m, false)
    assert.equal('limits' in m, false)
  }
})

test('merge：TEXT_LITE+REACT（两个方向）均 TEXT_LITE', () => {
  const a = mergeParticipation(lite({ maxBubbles: 1 }), react('10001'), 'interject', 'interject')
  assert.equal(a.level, 'text_lite')
  assert.deepEqual(a.limits, { maxBubbles: 1 })
  assert.equal('reaction' in a, false)
  const b = mergeParticipation(react('10001'), lite({ maxBubbles: 1 }), 'interject', 'interject')
  assert.equal(b.level, 'text_lite')
  assert.deepEqual(b.limits, { maxBubbles: 1 })
})

test('merge：两个 TEXT_LITE 的 maxBubbles / maxChars 分别取最小值', () => {
  const m = mergeParticipation(
    lite({ maxBubbles: 2, maxChars: 100 }, 'mod-l1'),
    lite({ maxBubbles: 1, maxChars: 120 }, 'mod-l2'),
    'interject', 'interject',
  )
  assert.equal(m.level, 'text_lite')
  assert.deepEqual(m.limits, { maxBubbles: 1, maxChars: 100 }, '只能更严：取两边的最小值')
  // 单边定义时沿用定义的那份
  const one = mergeParticipation(lite({ maxChars: 200 }, 'mod-l1'), lite({ maxBubbles: 3 }, 'mod-l1'), 'interject', 'interject')
  assert.deepEqual(one.limits, { maxBubbles: 3, maxChars: 200 })
})

test('merge：两个 TEXT_LITE 来自不同模块 → sourceModuleId 置空；同模块 → 保留', () => {
  const diff = mergeParticipation(lite({ maxBubbles: 2 }, 'mod-l1'), lite({ maxBubbles: 1 }, 'mod-l2'), 'interject', 'interject')
  assert.equal(diff.sourceModuleId, '', '多模块共同贡献且无法唯一归因时置空')
  const same = mergeParticipation(lite({ maxBubbles: 2 }, 'mod-l1'), lite({ maxBubbles: 1 }, 'mod-l1'), 'interject', 'interject')
  assert.equal(same.sourceModuleId, 'mod-l1')
})

test('merge：两个 REACT 只保留最新入站成员的锚点，sourceModuleId 与之一致', () => {
  const m = mergeParticipation(react('10001', 'mod-r1'), react('10002', 'mod-r2'), 'interject', 'interject')
  assert.equal(m.level, 'react')
  assert.deepEqual(m.reaction, { messageId: '10002', emojiId: '66' }, '只保留后一个 messageId，不连发多个')
  assert.equal(m.sourceModuleId, 'mod-r2')
})

test('merge：interject REACT 后加入 must／engaged → 强制 FULL 且清空全部字段', () => {
  for (const mode of ['must', 'engaged']) {
    const m = mergeParticipation(react('10001'), full(), 'interject', mode)
    assert.equal(m.level, 'full', `${mode} 升级必须 FULL`)
    assert.deepEqual(m, { level: 'full', sourceModuleId: '' })
    const m2 = mergeParticipation(react('10001'), react('10002'), 'interject', mode)
    assert.deepEqual(m2, { level: 'full', sourceModuleId: '' })
  }
  // 反向：回合此前已有 must／engaged 成员，后来的 interject 声明也不能降级
  const rev = mergeParticipation(react('10001'), lite({ maxBubbles: 1 }), 'must', 'interject')
  assert.deepEqual(rev, { level: 'full', sourceModuleId: '' })
})

test('merge：首次记账（previous 为 null）原样接受 next；两侧都空回退 FULL', () => {
  assert.deepEqual(mergeParticipation(null, react('10001'), null, 'interject'), react('10001'))
  assert.deepEqual(mergeParticipation(react('10001'), null, 'interject', null), react('10001'))
  assert.deepEqual(mergeParticipation(null, null, null, null), { level: 'full', sourceModuleId: '' })
})
