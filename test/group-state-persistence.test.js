// 回归（上游遗留缺陷③）：群刹车/话题状态持久化。
// said/interjects/engaged 是「她最近说过几次话、还能不能接着聊」的刹车依据；纯内存时
// 重启即清零 → 重启后刹车失效。修复：经 storage={read,write} 注入落盘 + 启动恢复，
// 只收有效期内条目；缺省 storage 仍纯内存（零破坏）。本模块依旧零 import、可纯内存单测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createGroupState, ENGAGE_MS } from '../src/chat/group-state.js'

test('持久化：启动恢复 said/interjects/engaged（有效期内）', () => {
  const now = Date.now()
  const saved = {
    said: { 777: [now - 1000, now - 2000] },
    interjects: { 777: [now - 500] },
    engaged: { 777: { until: now + ENGAGE_MS, since: now - 1000, replies: 2 } },
  }
  const g = createGroupState({ storage: { read: () => saved, write: () => {} } })
  assert.equal(g.speakTimes('777', now).length, 2, '说话时间序列恢复')
  assert.equal(g.interjectTimes('777', now).length, 1, '插话时间序列恢复')
  assert.ok(g.engagedUntil('777') > now, '话题窗口恢复')
  assert.equal(g.engagedReplies('777'), 2, '连聊条数恢复')
})

test('持久化：恢复时清掉过期条目（1 小时窗口 / engaged until）', () => {
  const now = Date.now()
  const saved = {
    said: { 777: [now - 2 * 3600_000], 888: [now - 1000] },
    interjects: { 777: [now - 2 * 3600_000] },
    engaged: { 777: { until: now - 1000, since: now - 5000, replies: 9 }, 888: { until: now + ENGAGE_MS, since: now, replies: 1 } },
  }
  const g = createGroupState({ storage: { read: () => saved, write: () => {} } })
  assert.equal(g.speakTimes('777', now).length, 0, '过期说话时间清掉')
  assert.equal(g.speakTimes('888', now).length, 1, '未过期保留')
  assert.equal(g.interjectTimes('777', now).length, 0, '过期插话清掉')
  assert.equal(g.engagedUntil('777'), 0, '过期话题清掉')
  assert.ok(g.engagedUntil('888') > now, '未过期话题保留')
})

test('持久化：变更落盘，dispose 清定时器并立即落盘快照', () => {
  let written = null
  const g = createGroupState({ storage: { read: () => ({}), write: (v) => { written = v } } })
  const now = Date.now()
  g.noteSpeak('777', now)
  g.noteInterject('777', now)
  g.joinTopic('777', now)
  g.dispose()
  assert.ok(written, 'dispose 应触发一次落盘')
  assert.deepEqual(written.said[777], [now])
  assert.deepEqual(written.interjects[777], [now])
  assert.equal(written.engaged[777].replies, 0)
  assert.ok(written.engaged[777].until > now)
})

test('持久化：leaveTopic/noteEngagedReply 也进快照', () => {
  let written = null
  const g = createGroupState({ storage: { read: () => ({}), write: (v) => { written = v } } })
  const now = Date.now()
  g.joinTopic('777', now)
  g.noteEngagedReply('777', now)
  g.dispose()
  assert.equal(written.engaged[777].replies, 1, '续聊条数落盘')
  g.leaveTopic('777')
  g.dispose()
  assert.equal(written.engaged[777], undefined, '离场后快照不含该群')
})

test('持久化：无 storage 时纯内存，dispose 空操作不抛（零破坏）', () => {
  const g = createGroupState()
  g.noteSpeak('777')
  g.dispose()
  assert.equal(g.speakTimes('777').length, 1)
})

test('持久化：读失败/坏档案按空状态启动，不抛', () => {
  const g = createGroupState({ storage: { read: () => { throw new Error('boom') }, write: () => {} } })
  assert.equal(g.speakTimes('777').length, 0)
  const g2 = createGroupState({ storage: { read: () => ({ said: 'not-an-object', engaged: 42 }), write: () => {} } })
  assert.equal(g2.speakTimes('777').length, 0)
  assert.equal(g2.engagedUntil('777'), 0)
})