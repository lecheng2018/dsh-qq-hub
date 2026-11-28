// 群参与契约 T1.3：groupGate 按 turnId 保存／合并 participation；prune / release 全量清理；
// 在途预算（engaged／interject）沿用 noteTurnMode 同一套账，不因新接口重复加一。
// 用真实 createGroupState + createGroupGate + 真实群策略判定断言可观察行为。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createGroupGate } from '../src/host/core/group-gate.js'
import { createGroupState } from '../src/chat/group-state.js'

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, child: () => noopLog }

function mkGate({ engagedMaxReplies = 3, cooldownSec = 90, controllerTurns = new Map() } = {}) {
  const groups = createGroupState()
  const cfg = {
    ownerQQ: '10000001', /* pii-scan:ignore 占位假号 */
    botQQ: '20000002', /* pii-scan:ignore 占位假号 */
    group: {
      interjectChance: 1, // 摇号必中：隔离概率变量
      cooldownSec,
      minRecentMessages: 1,
      activeWindowSec: 300,
      minRelevance: 0,
      interests: [], // 无话题词表 → 相关度按基础 0.35
      engagedMaxReplies,
      engagedMaxMs: 600_000,
      burstMax: 100,
      burstWindowSec: 120,
      maxPerHour: 100,
      quietHours: [],
      fishGuard: { enabled: false },
    },
  }
  const gate = createGroupGate({
    getConfig: () => cfg,
    log: noopLog,
    debug: () => {},
    groups,
    memoryScore: () => 0,
    atmosphereGate: { enabled: false },
    getController: () => ({ getTurn: (tid) => (controllerTurns.get(tid) ? { state: 'running' } : null) }),
  })
  return { gate, groups }
}

const say = (groups, gid, text) => groups.appendMessage(gid, { t: Date.now(), uid: '555', nick: '甲', text, self: false })

test('noteTurnParticipation：连续 lead／follower 按入站顺序合并，符合 §3.4', () => {
  const { gate } = mkGate()
  const react = (messageId) => ({ level: 'react', sourceModuleId: 'mod-r', reaction: { messageId, emojiId: '66' } })
  const lite = (limits) => ({ level: 'text_lite', sourceModuleId: 'mod-l', limits })

  gate.noteTurnParticipation('777', 't1', 'interject', react('10001'), Date.now())
  assert.deepEqual(gate.turnParticipationOf('t1'), react('10001'), '首笔记账原样保存')

  // 多个 REACT：只保留最新锚点
  gate.noteTurnParticipation('777', 't1', 'interject', react('10002'), Date.now())
  assert.equal(gate.turnParticipationOf('t1').level, 'react')
  assert.deepEqual(gate.turnParticipationOf('t1').reaction, { messageId: '10002', emojiId: '66' })

  // TEXT_LITE 参与合并
  gate.noteTurnParticipation('777', 't1', 'interject', lite({ maxBubbles: 2, maxChars: 100 }), Date.now())
  assert.equal(gate.turnParticipationOf('t1').level, 'text_lite')
  // 再来一份更严的 TEXT_LITE：取最小值
  gate.noteTurnParticipation('777', 't1', 'interject', lite({ maxBubbles: 1, maxChars: 120 }), Date.now())
  assert.deepEqual(gate.turnParticipationOf('t1').limits, { maxBubbles: 1, maxChars: 100 })

  // 任一成员 FULL：整回合 FULL，无残留
  gate.noteTurnParticipation('777', 't1', 'interject', { level: 'full', sourceModuleId: 'mod-f' }, Date.now())
  const merged = gate.turnParticipationOf('t1')
  assert.equal(merged.level, 'full')
  assert.equal('reaction' in merged, false)
  assert.equal('limits' in merged, false)
})

test('noteTurnParticipation：mode 不是 interject（must／engaged）时保存值强制 FULL', () => {
  const { gate } = mkGate()
  const react = { level: 'react', sourceModuleId: 'mod-r', reaction: { messageId: '10001', emojiId: '66' } }
  gate.noteTurnParticipation('777', 't2', 'must', react, Date.now())
  assert.deepEqual(gate.turnParticipationOf('t2'), { level: 'full', sourceModuleId: '' })
  // engaged 升级同样强制 FULL（此前 interject 有 REACT 声明也不能降级）
  gate.noteTurnParticipation('777', 't3', 'interject', react, Date.now())
  gate.noteTurnParticipation('777', 't3', 'engaged', { level: 'full', sourceModuleId: 'mod-f' }, Date.now())
  assert.deepEqual(gate.turnParticipationOf('t3'), { level: 'full', sourceModuleId: '' })
})

test('prune 与 release 后 turnModeOf / turnParticipationOf 均无残留', () => {
  const controllerTurns = new Map() // 空 = 回合都不在途
  const { gate } = mkGate({ controllerTurns })
  const react = { level: 'react', sourceModuleId: 'mod-r', reaction: { messageId: '10001', emojiId: '66' } }
  gate.noteTurnParticipation('777', 'p1', 'interject', react, Date.now())
  gate.noteTurnParticipation('777', 'p2', 'engaged', { level: 'full', sourceModuleId: '' }, Date.now())
  assert.ok(gate.turnModeOf('p1') && gate.turnParticipationOf('p1'))
  assert.ok(gate.turnModeOf('p2') && gate.turnParticipationOf('p2'))

  gate.pruneInFlightGroup('777')
  assert.equal(gate.turnModeOf('p1'), null, 'prune 后 interject 分支要清 participation')
  assert.equal(gate.turnParticipationOf('p1'), null)
  assert.equal(gate.turnModeOf('p2'), null, 'prune 后 engaged 分支要清 participation')
  assert.equal(gate.turnParticipationOf('p2'), null)

  // release 分支
  gate.noteTurnParticipation('777', 'p3', 'interject', react, Date.now())
  assert.ok(gate.turnParticipationOf('p3'))
  gate.releaseTurnMode('group:777', 'p3')
  assert.equal(gate.turnModeOf('p3'), null)
  assert.equal(gate.turnParticipationOf('p3'), null)
})

test('在途预算仍各记一次：engaged 连聊 3 条到顶（重复记账会提前拦）', () => {
  const controllerTurns = new Map([['e1', 1], ['e2', 1], ['e3', 1]]) // 三个回合都在途
  const { gate, groups } = mkGate({ engagedMaxReplies: 3, controllerTurns })
  say(groups, '777', '今天天气不错')
  groups.joinTopic('777', Date.now())

  gate.noteTurnParticipation('777', 'e1', 'engaged', { level: 'full', sourceModuleId: '' })
  let d = gate.decideGroupReplyFor({ chatKey: 'group:777', text: '接着聊', userId: '555', nick: '甲' })
  assert.equal(d.mode, 'engaged', `第 1 条在途后还能续（实际：${d.reason}）`)

  gate.noteTurnParticipation('777', 'e2', 'engaged', { level: 'full', sourceModuleId: '' })
  d = gate.decideGroupReplyFor({ chatKey: 'group:777', text: '再聊', userId: '555', nick: '甲' })
  assert.equal(d.mode, 'engaged', `2 条在途（预算恰好 2/3）还能续 —— 若新接口重复加一，这里就会提前拦（实际：${d.reason}）`)

  gate.noteTurnParticipation('777', 'e3', 'engaged', { level: 'full', sourceModuleId: '' })
  d = gate.decideGroupReplyFor({ chatKey: 'group:777', text: '还聊', userId: '555', nick: '甲' })
  assert.equal(d.reply, false, '3 条在途 = 预算到顶')
  assert.match(d.reason, /连着接了 3 条/)
})

test('在途预算仍各记一次：interject 在途进冷却，release/prune 后立刻恢复', () => {
  const controllerTurns = new Map([['i1', 1]])
  const { gate, groups } = mkGate({ cooldownSec: 60, controllerTurns })
  say(groups, '777', '在聊在聊')
  const react = { level: 'react', sourceModuleId: 'mod-r', reaction: { messageId: '10001', emojiId: '66' } }

  let d = gate.decideGroupReplyFor({ chatKey: 'group:777', text: '第一句', userId: '555', nick: '甲' })
  assert.equal(d.mode, 'interject', `基线能插话（实际：${d.reason}）`)

  gate.noteTurnParticipation('777', 'i1', 'interject', react)
  d = gate.decideGroupReplyFor({ chatKey: 'group:777', text: '第二句', userId: '555', nick: '甲' })
  assert.equal(d.reply, false, '在途 interject 要进插话冷却（预算记到了）')
  assert.match(d.reason, /插话冷却中/)

  // 回合结束释放：预算清掉，下一句立刻又能插话
  gate.releaseTurnMode('group:777', 'i1')
  d = gate.decideGroupReplyFor({ chatKey: 'group:777', text: '第三句', userId: '555', nick: '甲' })
  assert.equal(d.mode, 'interject', `释放后恢复（实际：${d.reason}）`)
})

test('反例 A：先 noteTurnMode(must/engaged) 后 noteTurnParticipation(interject REACT) —— 绝不降级', () => {
  const { gate } = mkGate()
  const react = { level: 'react', sourceModuleId: 'mod-r', reaction: { messageId: '10001', emojiId: '66' } }
  for (const mode of ['must', 'engaged']) {
    const tid = `m1-${mode}`
    gate.noteTurnMode('777', tid, mode)
    assert.equal(gate.turnModeOf(tid), mode)
    gate.noteTurnParticipation('777', tid, 'interject', react)
    assert.equal(gate.turnModeOf(tid), mode, `回合模式必须保持 ${mode}`)
    assert.deepEqual(
      gate.turnParticipationOf(tid),
      { level: 'full', sourceModuleId: '' },
      '先 must/engaged 后 interject REACT 合流必须强制 FULL，绝不降级为 react',
    )
  }
})

test('反例 B：先 noteTurnParticipation(interject REACT) 后 noteTurnMode(must/engaged) —— 立即恢复 FULL', () => {
  const { gate } = mkGate()
  const react = { level: 'react', sourceModuleId: 'mod-r', reaction: { messageId: '10001', emojiId: '66' } }
  for (const mode of ['must', 'engaged']) {
    const tid = `m2-${mode}`
    gate.noteTurnParticipation('777', tid, 'interject', react)
    assert.deepEqual(gate.turnParticipationOf(tid), react, '前置：REACT 已入账')
    gate.noteTurnMode('777', tid, mode)
    assert.equal(gate.turnModeOf(tid), mode)
    assert.deepEqual(
      gate.turnParticipationOf(tid),
      { level: 'full', sourceModuleId: '' },
      '外部直接 noteTurnMode 升级 must/engaged 时必须立即清掉 REACT/TEXT_LITE',
    )
    assert.equal('reaction' in gate.turnParticipationOf(tid), false, '无 reaction 残留')
  }
})

test('反例 B-2：engaged 同款，先 TEXT_LITE 后升级也清空（无 limits 残留）', () => {
  const { gate } = mkGate()
  const tid = 'm2-lite'
  gate.noteTurnParticipation('777', tid, 'interject', { level: 'text_lite', sourceModuleId: 'mod-l', limits: { maxBubbles: 1, maxChars: 80 } })
  gate.noteTurnMode('777', tid, 'engaged')
  assert.deepEqual(gate.turnParticipationOf(tid), { level: 'full', sourceModuleId: '' })
  assert.equal('limits' in gate.turnParticipationOf(tid), false)
})
